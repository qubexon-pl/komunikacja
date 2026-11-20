"use strict";

// Getting around a destination city, from Transitous (open GTFS timetables of metro, trams, buses and trains, with live
// delays where operators publish them):
//  - plan: journeys between two points at a local time,
//  - vehicles: where trains, metro, trams and buses are right now in the map view.
// Answers are shared: a journey is kept for 10 minutes, the vehicles of one map area for one minute (the area is
// snapped to a grid so neighbouring views share it), so many travellers looking at the same city ask once.

const crypto = require("node:crypto");
const { createTransitous, localToUtc, utcToLocal, validZone, kindOf, decodePolyline, itinerary } = require("./transitous");
const { CITIES, cityById } = require("./pl-cities");

const PLAN_KEEP_MS = 10 * 60 * 1000;
const VEHICLES_KEEP_MS = 60 * 1000;
const WINDOW_MS = 3 * 60 * 1000; // vehicles are sent with where they will be for the next three minutes
const GRID = 0.04; // degrees; a map view is widened to this grid
const MAX_SPAN = 0.24; // degrees; wider views would mean thousands of buses
const MIN_ZOOM = 12;
const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const STOPS_KEEP_MS = 60 * 60 * 1000;
const DEPARTURES_KEEP_MS = 30 * 1000;
const LINES_KEEP_MS = 5 * 60 * 1000; // a city's lines are swept again when opened after this
const LINES_RUNNING_MS = 45 * 60 * 1000; // vehicle counts of a sweep are shown this long
const LINES_FORGET_MS = 21 * 86400000; // a line not seen for three weeks is dropped
const LINES_REACH_KM = 18;
const TILE_LAT = 0.16, TILE_LON = 0.24; // degrees; one box Transitous answers at zoom 14 (no bigger than the vehicle map asks)
const PL_ZONE = "Europe/Warsaw";

const bad = (message) => Object.assign(new Error(message), { status: 400 });
const point = (text) => {
  const [lat, lon] = String(text || "").split(",").map(Number);
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
};

const km = (a, b) => {
  const r = Math.PI / 180, dLat = (b[0] - a[0]) * r, dLon = (b[1] - a[1]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};
const fold = (text) => String(text || "").toLocaleLowerCase("pl").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ł/g, "l").replace(/\s+/g, " ").trim();
const hex = (value) => (/^[0-9a-fA-F]{6}$/.test(value || "") ? `#${value}` : null);
const remember = (map, key, value, max = 500) => { map.set(key, value); if (map.size > max) map.delete(map.keys().next().value); return value; };

// Part of a stop-to-stop ride between two moments, assuming even speed along the line.
function clip(points, dep, arr, from, to) {
  if (points.length < 2 || !(arr > dep)) return null;
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    const [a, b] = points[i - 1], [c, d] = points[i];
    const dy = c - a, dx = (d - b) * Math.cos((a * Math.PI) / 180);
    cum.push(cum[i - 1] + Math.hypot(dx, dy));
  }
  const total = cum.at(-1);
  if (!(total > 0)) return null;
  const at = (ms) => Math.min(1, Math.max(0, (ms - dep) / (arr - dep))) * total;
  const pos = (dist) => {
    let i = 1;
    while (i < cum.length - 1 && cum[i] < dist) i++;
    const span = cum[i] - cum[i - 1] || 1, f = (dist - cum[i - 1]) / span;
    return [points[i - 1][0] + (points[i][0] - points[i - 1][0]) * f, points[i - 1][1] + (points[i][1] - points[i - 1][1]) * f];
  };
  const t0 = Math.max(dep, from), t1 = Math.min(arr, to);
  if (!(t1 > t0)) return null;
  const d0 = at(t0), d1 = at(t1);
  // Sample positions every 10 s; the browser moves the dot between them.
  const out = [];
  const stepMs = 10000;
  for (let t = t0; t < t1; t += stepMs) out.push(pos(at(t)));
  out.push(pos(d1));
  return { t0, t1, stepMs, path: out.map(([a, b]) => [Math.round(a * 1e5) / 1e5, Math.round(b * 1e5) / 1e5]), moving: d1 - d0 > 0 };
}

function createCityTransit({ transitous = null, fetchSource = fetch, now = Date.now, minGapMs, store = null, log = console } = {}) {
  const client = transitous || createTransitous({ fetchSource, now, ...(minGapMs == null ? {} : { minGapMs }) });
  const plans = new Map();
  const views = new Map();
  const stopLists = new Map();
  const boards = new Map();

  // Stops of one Polish city whose names match what the traveller typed, nearest the centre first among equals.
  async function stops({ city, q }) {
    const c = cityById(city);
    if (!c) throw bad("Nieznane miasto.");
    const text = String(q || "").trim().slice(0, 60);
    if (fold(text).length < 2) return { stops: [] };
    const id = `${c.id}|${fold(text)}`;
    const hit = stopLists.get(id);
    if (hit && now() - hit.fetchedAt < STOPS_KEEP_MS) return hit.result;
    const body = await client.geocode({ text, type: "STOP", place: `${c.centre[0]},${c.centre[1]}`, placeBias: "5", numResults: "20" });
    const seen = new Set();
    const list = [];
    for (const m of Array.isArray(body) ? body : []) {
      if (m.type && m.type !== "STOP") continue;
      if (!Number.isFinite(m.lat) || !Number.isFinite(m.lon) || !m.id) continue;
      const dist = km(c.centre, [m.lat, m.lon]);
      if (dist > c.km) continue;
      const key = `${fold(m.name)}|${m.lat.toFixed(3)},${m.lon.toFixed(3)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({ id: String(m.id), name: m.name || "", at: [Math.round(m.lat * 1e5) / 1e5, Math.round(m.lon * 1e5) / 1e5], km: Math.round(dist * 10) / 10 });
    }
    const result = { stops: list.slice(0, 12), city: c.id };
    remember(stopLists, id, { result, fetchedAt: now() });
    return result;
  }

  // Lines of a Polish city. Transitous has no list of routes, so lines are collected from the vehicles on their way: the
  // city is asked in tiles small enough for Transitous to answer (one box over a big city such as Kraków is refused with
  // HTTP 422), and every line ever seen is kept in the database with the day it was last seen. A background sweep goes
  // through every city a few times a day, so a traveller gets the stored list at once, with the vehicles of the last
  // sweep; the list of one city is refreshed when it is opened and its last sweep is older than five minutes.
  const sweeps = new Map(); // city → running sweep
  const catalogues = new Map(); // city → { lines: {key: {line, kind, color, seen}}, sweptAt, running }
  const catalogueKey = (id) => `city-lines:${id}`;
  async function readCatalogue(c) {
    if (catalogues.has(c.id)) return catalogues.get(c.id);
    let saved = null;
    if (store?.read) {
      const body = await store.read(catalogueKey(c.id)).catch(() => null);
      if (body) try { saved = JSON.parse(Buffer.from(body).toString("utf8")); } catch { saved = null; }
    }
    const entry = saved && saved.lines && typeof saved.lines === "object" ? saved : { lines: {}, sweptAt: 0, running: [] };
    catalogues.set(c.id, entry);
    return entry;
  }
  function tiles(c) {
    const reach = Math.min(c.km, LINES_REACH_KM), dLat = reach / 111, dLon = reach / (111 * Math.cos((c.centre[0] * Math.PI) / 180));
    const s = c.centre[0] - dLat, w = c.centre[1] - dLon, rows = Math.ceil((2 * dLat) / TILE_LAT), cols = Math.ceil((2 * dLon) / TILE_LON);
    const out = [];
    for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
      out.push({ s: s + (i * 2 * dLat) / rows, n: s + ((i + 1) * 2 * dLat) / rows, w: w + (j * 2 * dLon) / cols, e: w + ((j + 1) * 2 * dLon) / cols });
    }
    return out;
  }
  async function sweep(c, windowMin) {
    const start = Math.floor(now() / 60000) * 60000;
    const r4 = (v) => v.toFixed(4);
    const by = new Map();
    let answered = 0, failed = 0, lastError = null;
    const ask = async (box, depth) => {
      try {
        const segments = await client.mapTrips({ min: `${r4(box.s)},${r4(box.w)}`, max: `${r4(box.n)},${r4(box.e)}`, zoom: "14", startTime: new Date(start).toISOString(), endTime: new Date(start + windowMin * 60000).toISOString() });
        answered++;
        for (const seg of Array.isArray(segments) ? segments : []) {
          const trip = seg.trips?.[0] || {};
          const line = String(trip.displayName || trip.routeShortName || "").trim();
          if (!line) continue;
          const kind = kindOf(seg.mode), key = `${kind}|${line}`;
          let g = by.get(key);
          if (!g) { g = { line, kind, color: hex(seg.routeColor), trips: new Set(), late: new Set() }; by.set(key, g); }
          const id = trip.tripId || `${seg.from?.name}-${seg.departure}`;
          g.trips.add(id);
          if (seg.realTime && seg.scheduledDeparture && Date.parse(seg.departure) - Date.parse(seg.scheduledDeparture) >= 3 * 60000) g.late.add(id);
        }
      } catch (error) {
        // Too much in one box: ask about its four quarters instead.
        if (error.upstream === 422 && depth < 2) {
          const mLat = (box.s + box.n) / 2, mLon = (box.w + box.e) / 2;
          for (const q of [{ s: box.s, n: mLat, w: box.w, e: mLon }, { s: box.s, n: mLat, w: mLon, e: box.e }, { s: mLat, n: box.n, w: box.w, e: mLon }, { s: mLat, n: box.n, w: mLon, e: box.e }]) await ask(q, depth + 1);
          return;
        }
        failed++; lastError = error;
      }
    };
    for (const box of tiles(c)) await ask(box, 0);
    if (!answered) throw lastError || Object.assign(new Error("Lista linii jest chwilowo niedostępna."), { status: 502 });
    const running = [...by.values()].map((g) => ({ line: g.line, kind: g.kind, color: g.color, vehicles: g.trips.size, late: g.late.size }));
    const cat = await readCatalogue(c);
    const day = new Date(start).toISOString().slice(0, 10);
    for (const l of running) {
      const key = `${l.kind}|${l.line}`;
      cat.lines[key] = { line: l.line, kind: l.kind, color: l.color || cat.lines[key]?.color || null, seen: day };
    }
    const oldest = new Date(start - LINES_FORGET_MS).toISOString().slice(0, 10);
    for (const [key, l] of Object.entries(cat.lines)) if (!l.seen || l.seen < oldest) delete cat.lines[key];
    cat.sweptAt = now(); cat.running = running; cat.partial = failed > 0;
    if (store?.save) {
      const body = Buffer.from(JSON.stringify(cat));
      await store.save(catalogueKey(c.id), { body, type: "application/json", etag: `"${crypto.createHash("sha256").update(body).digest("hex").slice(0, 32)}"` })
        .catch((error) => log.warn(`City lines (${c.id}): could not save.`, error.message));
    }
    return cat;
  }
  function sweepOnce(c, windowMin = 30) {
    if (sweeps.has(c.id)) return sweeps.get(c.id);
    const run = sweep(c, windowMin).finally(() => sweeps.delete(c.id));
    sweeps.set(c.id, run);
    return run;
  }
  function answer(c, cat) {
    const fresh = now() - (cat.sweptAt || 0) < LINES_RUNNING_MS;
    const running = new Map((fresh ? cat.running || [] : []).map((l) => [`${l.kind}|${l.line}`, l]));
    const all = new Map(Object.entries(cat.lines).map(([key, l]) => [key, { line: l.line, kind: l.kind, color: l.color || null, vehicles: 0, late: 0 }]));
    for (const [key, l] of running) all.set(key, { ...all.get(key), ...l });
    const lines = [...all.values()].sort((a, b) => a.line.localeCompare(b.line, "pl", { numeric: true, sensitivity: "base" }));
    return { city: c.id, lines, running: fresh, sweptAt: cat.sweptAt || null, fetchedAt: now(), source: "Transitous" };
  }
  async function lines({ city }) {
    const c = cityById(city);
    if (!c) throw bad("Nieznane miasto.");
    const cat = await readCatalogue(c);
    if (Object.keys(cat.lines).length) {
      if (now() - (cat.sweptAt || 0) >= LINES_KEEP_MS) sweepOnce(c).catch((error) => log.warn(`City lines (${c.id}):`, error.message));
      return answer(c, cat);
    }
    return answer(c, await sweepOnce(c));
  }
  // Every city in turn, with a pause between them so travellers' own questions to Transitous are not held up.
  async function refreshAllLines({ pauseMs = 15000, cities = CITIES } = {}) {
    let done = 0;
    for (const c of cities) {
      try { await sweepOnce(c, 60); done++; } catch (error) { log.warn(`City lines (${c.id}):`, error.message); }
      if (pauseMs) await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
    return done;
  }

  // Next departures from one stop (and its platforms), with live delays where the operator publishes them.
  async function departures({ stop, time = "" }) {
    const stopId = String(stop || "").trim();
    if (!stopId || stopId.length > 160 || /[\u0000-\u001f]/.test(stopId)) throw bad("Wybierz przystanek.");
    if (time && !LOCAL_TIME.test(time)) throw bad("Nieprawidłowa godzina.");
    const at = time ? localToUtc(time, PL_ZONE) : Math.floor(now() / 60000) * 60000;
    const id = `${stopId}|${Math.floor(at / 60000)}`;
    const hit = boards.get(id);
    if (hit && now() - hit.fetchedAt < DEPARTURES_KEEP_MS) return hit;
    const body = await client.stopTimes({ stopId, n: "30", time: new Date(at).toISOString() });
    const list = (body?.stopTimes || []).map((s) => {
      const p = s.place || {};
      const dep = Date.parse(p.departure || p.arrival), sched = Date.parse(p.scheduledDeparture || p.scheduledArrival);
      if (!Number.isFinite(dep)) return null;
      return {
        line: s.displayName || s.routeShortName || s.tripShortName || "",
        kind: kindOf(s.mode),
        color: hex(s.routeColor), textColor: hex(s.routeTextColor),
        headsign: s.headsign || s.tripTo?.name || "",
        at: dep,
        clock: utcToLocal(dep, PL_ZONE).clock,
        planned: Number.isFinite(sched) ? utcToLocal(sched, PL_ZONE).clock : null,
        delayMin: s.realTime && Number.isFinite(sched) ? Math.round((dep - sched) / 60000) : 0,
        live: !!s.realTime,
        cancelled: !!(s.cancelled || p.cancelled),
        platform: p.track || p.scheduledTrack || "",
      };
    }).filter(Boolean).sort((a, b) => a.at - b.at);
    const result = { stop: { id: stopId, name: body?.place?.name || "" }, departures: list, zone: PL_ZONE, fetchedAt: now(), source: "Transitous" };
    return remember(boards, id, result, 300);
  }

  async function plan({ from, to, time = "", zone, arriveBy = false }) {
    const a = point(from), b = point(to);
    if (!a || !b) throw bad("Wybierz skąd i dokąd.");
    if (!validZone(zone)) throw bad("Nieznana strefa czasowa.");
    if (time && !LOCAL_TIME.test(time)) throw bad("Nieprawidłowa godzina.");
    const at = time ? localToUtc(time, zone) : Math.floor(now() / 60000) * 60000;
    const place = (p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;
    const id = crypto.createHash("sha1").update(`${place(a)}|${place(b)}|${Math.floor(at / 300000)}|${arriveBy ? 1 : 0}|${zone}`).digest("hex");
    const hit = plans.get(id);
    if (hit && now() - hit.fetchedAt < PLAN_KEEP_MS) return hit;
    const params = { fromPlace: place(a), toPlace: place(b), time: new Date(at).toISOString(), numItineraries: "5" };
    if (arriveBy) params.arriveBy = "true";
    const body = await client.plan(params);
    const trips = (body.itineraries || []).map((it) => itinerary(it, zone)).filter((t) => Number.isFinite(t.minutes)).slice(0, 6);
    const direct = (body.direct || []).map((it) => itinerary(it, zone)).find((t) => t.steps.every((s) => s.kind === "walk"));
    const result = { trips, walk: direct ? { minutes: direct.minutes, shape: direct.shape } : null, wanted: utcToLocal(at, zone), zone, fetchedAt: now(), source: "Transitous" };
    plans.set(id, result);
    if (plans.size > 1000) plans.delete(plans.keys().next().value);
    return result;
  }

  async function vehicles({ min, max, zoom }) {
    const a = point(min), b = point(max), z = Math.round(Number(zoom));
    if (!a || !b || !Number.isFinite(z)) throw bad("Nieprawidłowy obszar mapy.");
    if (z < MIN_ZOOM) return { vehicles: [], tooWide: true };
    const snap = (v, up) => Math.round((up ? Math.ceil(v / GRID) : Math.floor(v / GRID)) * GRID * 1000) / 1000;
    const box = { s: snap(Math.min(a.lat, b.lat), false), w: snap(Math.min(a.lon, b.lon), false), n: snap(Math.max(a.lat, b.lat), true), e: snap(Math.max(a.lon, b.lon), true) };
    if (box.n - box.s > MAX_SPAN || box.e - box.w > MAX_SPAN) return { vehicles: [], tooWide: true };
    const zz = Math.min(16, z);
    const start = Math.floor(now() / 60000) * 60000;
    const id = `${box.s},${box.w},${box.n},${box.e}|${zz}|${start}`;
    const hit = views.get(id);
    if (hit) return hit.result;
    const pending = (async () => {
      const segments = await client.mapTrips({ min: `${box.s},${box.w}`, max: `${box.n},${box.e}`, zoom: String(zz), startTime: new Date(start).toISOString(), endTime: new Date(start + WINDOW_MS).toISOString() });
      const list = [];
      for (const s of Array.isArray(segments) ? segments : []) {
        if (!s.polyline) continue;
        const dep = Date.parse(s.departure), arr = Date.parse(s.arrival);
        const part = clip(decodePolyline(s.polyline, 5), dep, arr, start, start + WINDOW_MS);
        if (!part) continue;
        const trip = s.trips?.[0] || {};
        list.push({
          id: String(trip.tripId || "").slice(-40) || `${s.from?.name}-${dep}`,
          line: trip.routeShortName || "", kind: kindOf(s.mode), color: /^[0-9a-fA-F]{6}$/.test(s.routeColor || "") ? `#${s.routeColor}` : null,
          from: s.from?.name || "", to: s.to?.name || "",
          live: !!s.realTime, delayMin: s.realTime && s.scheduledDeparture ? Math.round((dep - Date.parse(s.scheduledDeparture)) / 60000) : 0,
          ...part,
        });
      }
      return { vehicles: list.slice(0, 1500), box, from: start, until: start + WINDOW_MS, fetchedAt: now(), source: "Transitous" };
    })();
    views.set(id, { result: pending });
    pending.catch(() => views.delete(id));
    for (const [key] of views) if (!key.endsWith(`|${start}`) && views.size > 50) views.delete(key);
    setTimeout(() => views.delete(id), VEHICLES_KEEP_MS).unref?.();
    return pending;
  }

  return { plan, vehicles, stops, departures, lines, refreshAllLines };
}

module.exports = { createCityTransit, clip };
