"use strict";

// Transitous (https://transitous.org) — a free, community-run journey planner built on open GTFS feeds, with live
// delays where operators publish them. Everything in the app that asks it goes through one client: an honest
// User-Agent, one request at a time with a gap between them, and callers keep the answers, so a city opened by many
// travellers is asked about once.

const BASE = "https://api.transitous.org/api/v1";
const USER_AGENT = "komunikacja-rzeszow/1.0 (trip planner; answers cached)";
const MIN_GAP_MS = 1100;

function createTransitous({ fetchSource = fetch, now = Date.now, minGapMs = MIN_GAP_MS } = {}) {
  let queue = Promise.resolve();
  let lastAsk = 0;
  function ask(path, params) {
    const run = queue.then(async () => {
      const wait = lastAsk + minGapMs - now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      lastAsk = now();
      const response = await fetchSource(`${BASE}${path}?${new URLSearchParams(params)}`, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw Object.assign(new Error(`Transitous zwrócił HTTP ${response.status}.`), { status: 502 });
      return response.json();
    });
    queue = run.catch(() => {});
    return run;
  }
  return { plan: (params) => ask("/plan", params), mapTrips: (params) => ask("/map/trips", params), geocode: (params) => ask("/geocode", params) };
}

// Offset (ms) of a time zone at an instant.
function zoneOffset(ms, zone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - ms;
}
function localToUtc(local, zone) {
  const [d, t] = local.split("T"), [y, m, day] = d.split("-").map(Number), [hh, mm] = t.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, day, hh, mm);
  const first = guess - zoneOffset(guess, zone);
  return guess - zoneOffset(first, zone);
}
function utcToLocal(ms, zone) {
  const local = new Date(ms + zoneOffset(ms, zone)).toISOString();
  return { day: local.slice(0, 10), clock: local.slice(11, 16) };
}
function validZone(zone) {
  if (typeof zone !== "string" || !/^[A-Za-z_]+(\/[A-Za-z_+-]+){0,2}$/.test(zone)) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); return true; } catch { return false; }
}

const MODE_KIND = { BUS: "bus", COACH: "bus", TROLLEYBUS: "bus", TRAM: "tram", CABLE_CAR: "tram", SUBWAY: "metro", METRO: "metro", FERRY: "ferry", AIRPLANE: "plane", ODM: "taxi", FLEX: "bus", WALK: "walk", BIKE: "walk", CAR: "taxi" };
const kindOf = (mode) => MODE_KIND[mode] || (/RAIL|TRAIN|FUNICULAR|AERIAL/.test(mode || "") ? "rail" : "bus");
const color = (hex) => (/^[0-9a-fA-F]{6}$/.test(hex || "") ? `#${hex}` : null);

// Google's encoded polyline, at the precision Transitous names (5 for the vehicle map, 7 for planned legs).
function decodePolyline(text, precision = 5) {
  const out = [], f = 10 ** precision;
  let i = 0, lat = 0, lon = 0;
  while (i < text.length) {
    for (const k of [0, 1]) {
      let result = 0, shift = 0, b;
      do { b = text.charCodeAt(i++) - 63; result |= (b & 31) << shift; shift += 5; } while (b >= 32 && i <= text.length);
      const v = result & 1 ? ~(result >> 1) : result >> 1;
      if (k) lon += v; else lat += v;
    }
    out.push([lat / f, lon / f]);
  }
  return out;
}
// Keep a line drawable without hundreds of points: every n-th point, ends kept, rounded to ~1 m.
function thin(points, max = 60) {
  const step = Math.max(1, Math.ceil(points.length / max));
  const out = points.filter((_, i) => i % step === 0 || i === points.length - 1);
  return out.map(([a, b]) => [Math.round(a * 1e5) / 1e5, Math.round(b * 1e5) / 1e5]);
}

// One planned itinerary as the app shows it: steps (walks and rides, in local clock) and the shape for the map.
function itinerary(it, zone) {
  const start = Date.parse(it.startTime), end = Date.parse(it.endTime);
  const legs = it.legs || [];
  const rides = legs.filter((l) => l.mode !== "WALK");
  const steps = legs.map((l) => {
    const kind = kindOf(l.mode);
    return {
      kind,
      line: kind === "walk" ? "" : (l.displayName || l.routeShortName || l.tripShortName || ""),
      agency: l.agencyName || "",
      color: color(l.routeColor), textColor: color(l.routeTextColor),
      headsign: l.headsign || "",
      from: l.from?.name || "", to: l.to?.name || "",
      fromAt: l.from && Number.isFinite(l.from.lat) ? [l.from.lat, l.from.lon] : null,
      dep: utcToLocal(Date.parse(l.startTime), zone).clock,
      arr: utcToLocal(Date.parse(l.endTime), zone).clock,
      minutes: Math.max(1, Math.round((Date.parse(l.endTime) - Date.parse(l.startTime)) / 60000)),
      stops: Array.isArray(l.intermediateStops) ? l.intermediateStops.length + 1 : null,
      live: !!l.realTime,
      delayMin: l.realTime && l.scheduledStartTime ? Math.round((Date.parse(l.startTime) - Date.parse(l.scheduledStartTime)) / 60000) : 0,
      ticketUrl: safeUrl(l.ticketUrls?.web) || safeUrl(l.agencyFareUrl) || null,
    };
  });
  const shape = legs.map((l) => {
    const g = l.legGeometry;
    return g?.points ? { kind: kindOf(l.mode), color: color(l.routeColor), points: thin(decodePolyline(g.points, g.precision || 7), l.mode === "WALK" ? 20 : 80) } : null;
  }).filter(Boolean);
  return {
    dep: utcToLocal(start, zone), arr: utcToLocal(end, zone), startMs: start,
    minutes: Math.round((end - start) / 60000), transfers: Math.max(0, rides.length - 1),
    walkMin: Math.round(legs.filter((l) => l.mode === "WALK").reduce((sum, l) => sum + (l.duration || 0), 0) / 60),
    steps, shape,
  };
}
function safeUrl(value) {
  try { const u = new URL(value); return u.protocol === "https:" || u.protocol === "http:" ? u.href : null; } catch { return null; }
}

module.exports = { createTransitous, localToUtc, utcToLocal, validZone, kindOf, decodePolyline, thin, itinerary, safeUrl, USER_AGENT };
