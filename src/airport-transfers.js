"use strict";

// From the airport to the city (and back) at each Ryanair / Wizz Air destination.
//
// Static part: data/airport-transfers.csv (pickup point, route to the centre, typical fare, walk from the terminal, open
// timetable coverage) and data/airport-fares.csv (a reviewed price for each way into town at the busiest airports). The
// files are the reviewed source; on start they are copied into the database whenever their content changes, and
// requests read the database copy.
//
// Live part, on demand: real connections from Transitous (see transitous.js) — after landing, before the return flight,
// and every way into town with its next departures. Each answer is kept (memory and dbo.DataSnapshot), so a trip
// opened by many people asks once.

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createTransitous, localToUtc, utcToLocal, kindOf, itinerary, safeUrl } = require("./transitous");

const DATA_FILE = path.join(__dirname, "..", "data", "airport-transfers.csv");
const FARES_FILE = path.join(__dirname, "..", "data", "airport-fares.csv");
const HASH_SETTING = "airport-transfers-hash";
const FARES_HASH_SETTING = "airport-fares-hash";
const KEEP_MS = 12 * 60 * 60 * 1000;
const MIN_GAP_MS = 1100;
const AFTER_LANDING_MIN = 30; // leaving the plane, passport control, small bag
const BEFORE_DEPARTURE_MIN = 120; // be at the airport two hours before the flight
const AT_AIRPORT_KM = 3; // a destination this close to the airport means "take me to the city"
const MAX_TRIP_MIN = 4 * 60;
const MAX_OPTIONS = 10;
const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const CODE = /^[A-Z]{3}$/;

// Clock of each destination, so a flight's local arrival time can be asked about in UTC.
const COUNTRY_ZONES = {
  Albania: "Europe/Tirane", Armenia: "Asia/Yerevan", Austria: "Europe/Vienna", Azerbaijan: "Asia/Baku", Belgium: "Europe/Brussels",
  "Bosnia & Herz.": "Europe/Sarajevo", Bulgaria: "Europe/Sofia", Croatia: "Europe/Zagreb", Cyprus: "Asia/Nicosia", Czechia: "Europe/Prague",
  Denmark: "Europe/Copenhagen", Egypt: "Africa/Cairo", Estonia: "Europe/Tallinn", Finland: "Europe/Helsinki", France: "Europe/Paris",
  Georgia: "Asia/Tbilisi", Germany: "Europe/Berlin", Greece: "Europe/Athens", Hungary: "Europe/Budapest", Iceland: "Atlantic/Reykjavik",
  Ireland: "Europe/Dublin", Israel: "Asia/Jerusalem", Italy: "Europe/Rome", Jordan: "Asia/Amman", Kosovo: "Europe/Belgrade",
  Latvia: "Europe/Riga", Lithuania: "Europe/Vilnius", Luxembourg: "Europe/Luxembourg", Malta: "Europe/Malta", Moldova: "Europe/Chisinau",
  Montenegro: "Europe/Podgorica", Morocco: "Africa/Casablanca", Netherlands: "Europe/Amsterdam", "North Macedonia": "Europe/Skopje",
  Norway: "Europe/Oslo", Poland: "Europe/Warsaw", Portugal: "Europe/Lisbon", Romania: "Europe/Bucharest", "Saudi Arabia": "Asia/Riyadh",
  Serbia: "Europe/Belgrade", Slovakia: "Europe/Bratislava", Slovenia: "Europe/Ljubljana", Spain: "Europe/Madrid", Sweden: "Europe/Stockholm",
  "Türkiye": "Europe/Istanbul", UAE: "Asia/Dubai", "United Kingdom": "Europe/London", "Western Sahara": "Africa/El_Aaiun",
};
const AIRPORT_ZONES = { LPA: "Atlantic/Canary", ACE: "Atlantic/Canary", FUE: "Atlantic/Canary", TFN: "Atlantic/Canary", TFS: "Atlantic/Canary", FNC: "Atlantic/Madeira" };

function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((v) => v !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((v) => v !== "")) rows.push(row);
  return rows;
}

function recordsFromCsv(text) {
  const [head, ...rows] = parseCsv(text.replace(/^﻿/, ""));
  const at = (name) => head.indexOf(name);
  const col = Object.fromEntries(["IATA", "City", "Country", "Airport", "Ryanair", "Wizz Air", "Pickup point", "Latitude", "Longitude", "Precision", "Mode",
    "Route to centre", "Fare", "Fare EUR approx", "Walk from terminal", "GTFS coverage", "Airport lat", "Airport lon"].map((n) => [n, at(n)]));
  if (Object.values(col).some((i) => i < 0)) throw new Error("airport-transfers.csv: missing column.");
  const out = [];
  for (const r of rows) {
    const v = (name) => (r[col[name]] ?? "").trim();
    const num = (name) => (v(name) === "" ? NaN : Number(v(name)));
    const code = v("IATA").toUpperCase();
    const rec = {
      code, city: v("City"), country: v("Country"), airport: v("Airport"), ryanair: v("Ryanair") === "yes", wizz: v("Wizz Air") === "yes",
      pickup: { name: v("Pickup point"), lat: num("Latitude"), lon: num("Longitude"), precision: v("Precision") || "airport" },
      mode: ["rail", "bus", "taxi"].includes(v("Mode")) ? v("Mode") : "bus",
      route: v("Route to centre"), fare: v("Fare"), fareEur: Number.isFinite(num("Fare EUR approx")) ? num("Fare EUR approx") : null,
      walk: v("Walk from terminal"), gtfs: v("GTFS coverage") || "none", airportLat: num("Airport lat"), airportLon: num("Airport lon"),
    };
    if (!CODE.test(code) || ![rec.pickup.lat, rec.pickup.lon, rec.airportLat, rec.airportLon].every(Number.isFinite)) continue;
    out.push(rec);
  }
  return out;
}

// Reviewed prices per way into town (data/airport-fares.csv). Match is a regular expression tried on the line name and
// the operator of the first ride Transitous finds; "^taxi$" is the taxi.
function faresFromCsv(text) {
  const [head, ...rows] = parseCsv(text.replace(/^﻿/, ""));
  const at = (name) => head.indexOf(name);
  if (["IATA", "Option", "Match", "Mode", "Fare", "Fare EUR", "Note", "Checked", "Source"].some((n) => at(n) < 0)) throw new Error("airport-fares.csv: missing column.");
  const out = [];
  for (const r of rows) {
    const v = (name) => (r[at(name)] ?? "").trim();
    const code = v("IATA").toUpperCase(), eur = v("Fare EUR") === "" ? NaN : Number(v("Fare EUR"));
    if (!CODE.test(code) || !v("Option") || !v("Match")) continue;
    try { new RegExp(v("Match"), "i"); } catch { continue; }
    out.push({
      code, option: v("Option"), match: v("Match"), mode: v("Mode") || "bus", fare: v("Fare"), fareEur: Number.isFinite(eur) ? eur : null,
      note: v("Note"), checked: v("Checked"), source: safeUrl(v("Source")) || "",
    });
  }
  return out;
}

function km(aLat, aLon, bLat, bLon) {
  const r = Math.PI / 180, dLat = (bLat - aLat) * r, dLon = (bLon - aLon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

function tripsFrom(body, zone) {
  return (body.itineraries || [])
    .map((it) => {
      const start = Date.parse(it.startTime), end = Date.parse(it.endTime);
      const legs = (it.legs || []).filter((l) => l.mode !== "WALK").map((l) => ({
        kind: kindOf(l.mode),
        line: l.displayName || l.routeShortName || l.tripShortName || "",
        agency: l.agencyName || "",
        headsign: l.headsign || "",
        from: l.from?.name || "",
        to: l.to?.name || "",
        dep: utcToLocal(Date.parse(l.startTime), zone).clock,
        arr: utcToLocal(Date.parse(l.endTime), zone).clock,
      }));
      const walkMin = Math.round((it.legs || []).filter((l) => l.mode === "WALK").reduce((sum, l) => sum + (l.duration || 0), 0) / 60);
      return { dep: utcToLocal(start, zone), arr: utcToLocal(end, zone), minutes: Math.round((end - start) / 60000), transfers: Math.max(0, legs.length - 1), walkMin, legs };
    })
    .filter((t) => Number.isFinite(t.minutes) && t.minutes <= MAX_TRIP_MIN && (t.legs.length || t.minutes <= 40))
    .slice(0, 4);
}

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function createAirportTransfers({ database = null, snapshots = null, fetchSource = fetch, transitous = null, toPln = null, geocode = null, drive = null, file = DATA_FILE, faresFile = FARES_FILE, now = Date.now, minGapMs = MIN_GAP_MS } = {}) {
  let loading = null;
  let byCode = new Map();
  let faresByCode = new Map();
  const answers = new Map();
  const client = transitous || createTransitous({ fetchSource, now, minGapMs });

  // Copies a reviewed file into the database when it changed, then reads the database copy (the file if that fails).
  async function seeded(text, parse, setting, replace, read, what) {
    const fromFile = parse(text);
    if (!database || !replace || !read) return fromFile;
    try {
      const hash = crypto.createHash("sha256").update(text).digest("hex");
      const saved = await database.readSetting(setting);
      if (saved?.value !== hash) {
        await replace(fromFile);
        await database.saveSetting(setting, hash);
        console.log(`${what}: ${fromFile.length} rows saved to the database.`);
      }
      const stored = await read();
      return stored.length ? stored : fromFile;
    } catch (error) {
      console.warn(`${what}: database unavailable, using the CSV.`, error.message);
      return fromFile;
    }
  }

  async function load() {
    const records = await seeded(await fs.readFile(file, "utf8"), recordsFromCsv, HASH_SETTING, database?.replace, database?.read, "Airport transfers");
    byCode = new Map(records.map((r) => [r.code, r]));
    const faresText = await fs.readFile(faresFile, "utf8").catch(() => null);
    const fares = faresText == null ? [] : await seeded(faresText, faresFromCsv, FARES_HASH_SETTING, database?.replaceFares, database?.readFares, "Airport fares");
    faresByCode = new Map();
    for (const f of fares) (faresByCode.get(f.code) || faresByCode.set(f.code, []).get(f.code)).push(f);
  }
  const ready = () => (loading ||= load().catch((error) => { loading = null; throw error; }));

  const zoneOf = (rec) => AIRPORT_ZONES[rec.code] || COUNTRY_ZONES[rec.country] || "UTC";
  async function pln(eur) {
    if (eur === 0) return 0;
    if (!(eur > 0) || !toPln) return null;
    return toPln(eur, "EUR").then((v) => (v == null ? null : Math.round(v))).catch(() => null);
  }

  async function lookup(codes) {
    await ready();
    const wanted = [...new Set(codes.map((c) => String(c).trim().toUpperCase()).filter((c) => CODE.test(c)))].slice(0, 30);
    const found = wanted.map((c) => byCode.get(c)).filter(Boolean);
    return {
      transfers: await Promise.all(found.map(async (rec) => ({ ...rec, farePln: await pln(rec.fareEur), zone: zoneOf(rec) }))),
      missing: wanted.filter((c) => !byCode.has(c)),
    };
  }

  async function cityCentre(rec) {
    if (!geocode) return null;
    const city = rec.city.replace(/\s*\(.*\)\s*$/, "").split("/")[0].trim();
    const found = await geocode(`${city}, ${rec.country}`, { world: true }).catch(() => null);
    const p = found?.places?.[0]?.points?.[0];
    return p ? { lat: p[0], lon: p[1], label: city, centre: true } : null;
  }

  // Kept in memory and in dbo.DataSnapshot for KEEP_MS; the prefix names the kind of answer.
  async function remembered(prefix, id, build) {
    const key = `${prefix}:${new Date(now()).toISOString().slice(0, 10).replace(/-/g, "")}:${id}`;
    const fresh = (hit) => hit && now() - hit.fetchedAt < KEEP_MS;
    const mem = answers.get(prefix + id);
    if (fresh(mem)) return mem;
    if (snapshots) {
      const body = await snapshots.read(key).catch(() => null);
      const saved = body ? JSON.parse(Buffer.from(body).toString("utf8")) : null;
      if (fresh(saved)) { answers.set(prefix + id, saved); return saved; }
    }
    const result = await build();
    answers.set(prefix + id, result);
    if (answers.size > 2000) answers.delete(answers.keys().next().value);
    if (snapshots) {
      snapshots.save(key, { body: Buffer.from(JSON.stringify(result)), type: "application/json", etag: `"${id.slice(0, 32)}"` })
        .then(() => (Math.random() < 0.05 ? snapshots.prune(`${prefix}:`, new Date(now() - 86400000).toISOString().slice(0, 10).replace(/-/g, "")) : null))
        .catch((error) => console.warn("Airport transfers: could not store an answer.", error.message));
    }
    return result;
  }

  const placeOk = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

  // dir "from": landing at `code` at local `time` → destination. dir "to": destination → `code`, flight at local `time`.
  async function connections({ code, lat, lon, time, dir = "from", label = "" }) {
    await ready();
    const rec = byCode.get(String(code || "").toUpperCase());
    if (!rec) throw Object.assign(new Error("Nie znamy tego lotniska."), { status: 404 });
    if (!placeOk(lat, lon)) throw Object.assign(new Error("Nieprawidłowe miejsce."), { status: 400 });
    if (!LOCAL_TIME.test(time || "") || !["from", "to"].includes(dir)) throw Object.assign(new Error("Nieprawidłowa godzina."), { status: 400 });
    const zone = zoneOf(rec);
    let target = { lat, lon, label: String(label).slice(0, 120), centre: false };
    if (km(lat, lon, rec.airportLat, rec.airportLon) < AT_AIRPORT_KM) {
      target = await cityCentre(rec);
      if (!target) return { code: rec.code, dir, target: null, trips: [], note: "centre-unknown" };
    }
    const flightAt = localToUtc(time, zone);
    const step = 15 * 60000;
    const at = dir === "from" ? Math.floor((flightAt + AFTER_LANDING_MIN * 60000) / step) * step : Math.floor((flightAt - BEFORE_DEPARTURE_MIN * 60000) / step) * step;
    const pickup = `${rec.pickup.lat.toFixed(5)},${rec.pickup.lon.toFixed(5)}`, place = `${target.lat.toFixed(3)},${target.lon.toFixed(3)}`;
    const id = crypto.createHash("sha1").update(`${rec.code}|${dir}|${place}|${at}`).digest("hex").slice(0, 24);
    return remembered("xfer", id, async () => {
      const params = { fromPlace: dir === "from" ? pickup : place, toPlace: dir === "from" ? place : pickup, time: new Date(at).toISOString(), numItineraries: "4" };
      if (dir === "to") params.arriveBy = "true";
      let list = tripsFrom(await client.plan(params), zone);
      if (dir === "to") list = list.sort((a, b) => b.arr.clock.localeCompare(a.arr.clock) || a.minutes - b.minutes);
      return { code: rec.code, dir, target, zone, trips: list, fetchedAt: now(), source: "Transitous", wanted: utcToLocal(at, zone) };
    });
  }

  function fareFor(rec, line, agency) {
    const hit = (faresByCode.get(rec.code) || []).find((f) => { const re = new RegExp(f.match, "i"); return re.test(line) || re.test(agency) || re.test(`${agency} ${line}`); });
    if (hit) return { text: hit.fare, eur: hit.fareEur, option: hit.option, note: hit.note, checked: hit.checked, source: hit.source, curated: true };
    if (line === "taxi") return null;
    // The airport list names the main way into town; when this line is mentioned there, its fare applies.
    const words = [line, agency.replace(/\s*\(.*\)/, "")].filter((w) => w && w.length >= 2).map(escapeRe);
    if (words.length && new RegExp(`\\b(${words.join("|")})\\b`, "i").test(rec.route)) return { text: rec.fare, eur: rec.fareEur, option: "", note: "", checked: "", source: "", curated: false };
    return null;
  }

  // Every way from the airport to the destination (the city centre when the destination is the airport itself) after a
  // landing at local `time`: rail and metro, buses and coaches, and a taxi — each with where to board, the next
  // departures, how long it takes and the fare when we know it. Three questions to Transitous (any mode, rail only, bus
  // only), because the first answer keeps only the fastest few and would hide the cheap bus.
  async function options({ code, lat, lon, time, label = "" }) {
    await ready();
    const rec = byCode.get(String(code || "").toUpperCase());
    if (!rec) throw Object.assign(new Error("Nie znamy tego lotniska."), { status: 404 });
    if (!LOCAL_TIME.test(time || "")) throw Object.assign(new Error("Nieprawidłowa godzina."), { status: 400 });
    const zone = zoneOf(rec);
    let target = placeOk(lat, lon) ? { lat, lon, label: String(label).slice(0, 120), centre: false } : null;
    if (!target || km(target.lat, target.lon, rec.airportLat, rec.airportLon) < AT_AIRPORT_KM) target = await cityCentre(rec);
    if (!target) return { code: rec.code, target: null, options: [], note: "centre-unknown" };
    const step = 30 * 60000;
    const at = Math.floor((localToUtc(time, zone) + AFTER_LANDING_MIN * 60000) / step) * step;
    const place = `${target.lat.toFixed(3)},${target.lon.toFixed(3)}`;
    const id = crypto.createHash("sha1").update(`${rec.code}|${place}|${at}`).digest("hex").slice(0, 24);
    return remembered("xopt", id, async () => {
      // From the terminal's pickup point (the middle of an airport can be a long walk from any stop).
      const base = { fromPlace: `${rec.pickup.lat.toFixed(5)},${rec.pickup.lon.toFixed(5)}`, toPlace: place, time: new Date(at).toISOString(), numItineraries: "5", maxPreTransitTime: "1800" };
      const found = [];
      for (const modes of [null, "RAIL", "BUS,COACH"]) {
        const body = await client.plan(modes ? { ...base, transitModes: modes } : base).catch((error) => { console.warn("Airport options:", error.message); return null; });
        for (const it of body?.itineraries || []) found.push(itinerary(it, zone));
      }
      const groups = new Map();
      for (const it of found) {
        const first = it.steps.find((x) => x.kind !== "walk");
        if (!first || !(it.minutes <= MAX_TRIP_MIN)) continue;
        const key = `${first.agency}|${first.line}`;
        (groups.get(key) || groups.set(key, []).get(key)).push(it);
      }
      const list = [];
      for (const [key, its] of groups) {
        // The simplest ride wins unless it is much slower: fewer changes are worth up to 15 minutes.
        const best = [...its].sort((a, b) => (a.minutes + a.transfers * 15) - (b.minutes + b.transfers * 15) || a.minutes - b.minutes)[0];
        const rides = best.steps.filter((x) => x.kind !== "walk"), first = rides[0];
        const fare = fareFor(rec, first.line, first.agency);
        list.push({
          id: crypto.createHash("sha1").update(key).digest("hex").slice(0, 10),
          kind: first.kind, line: first.line, agency: first.agency, color: first.color, textColor: first.textColor,
          name: fare?.curated ? fare.option : "",
          board: { name: first.from, at: first.fromAt, walkMin: best.steps[0]?.kind === "walk" ? best.steps[0].minutes : 0 },
          alight: rides.at(-1).to,
          lines: rides.map((x) => ({ kind: x.kind, line: x.line, color: x.color, textColor: x.textColor })),
          minutes: best.minutes, transfers: best.transfers, walkMin: best.walkMin,
          departures: [...new Set(its.map((x) => x.steps.find((s) => s.kind !== "walk").dep))].sort().slice(0, 4),
          fare: fare ? { ...fare, pln: await pln(fare.eur) } : null,
          ticketUrl: first.ticketUrl || fare?.source || null,
          steps: best.steps.map(({ fromAt, ...x }) => x), shape: best.shape,
        });
      }
      const result = list.sort((a, b) => a.minutes - b.minutes).slice(0, MAX_OPTIONS);
      const taxiFare = fareFor(rec, "taxi", "");
      const road = drive ? await drive({ lat: rec.pickup.lat, lon: rec.pickup.lon }, target).catch(() => null) : null;
      if (road || taxiFare) {
        result.push({
          id: "taxi", kind: "taxi", line: "Taxi", agency: "", name: taxiFare?.option || "Taxi", color: null, textColor: null,
          board: { name: "", at: null, walkMin: 0 }, alight: target.label, lines: [],
          minutes: road ? road.minutes + 5 : null, km: road?.km ?? null, transfers: 0, walkMin: 0, departures: [],
          fare: taxiFare ? { ...taxiFare, pln: await pln(taxiFare.eur) } : null, ticketUrl: null, steps: [], shape: [],
        });
      }
      return {
        code: rec.code, city: rec.city, zone, target, airport: { lat: rec.airportLat, lon: rec.airportLon, name: rec.airport },
        hint: { pickup: rec.pickup.name, walk: rec.walk, route: rec.route, gtfs: rec.gtfs },
        wanted: utcToLocal(at, zone), options: result, fetchedAt: now(), source: "Transitous",
      };
    });
  }

  const zoneFor = (code) => { const rec = byCode.get(String(code || "").toUpperCase()); return rec ? zoneOf(rec) : null; };
  return { ready, lookup, connections, options, zoneFor };
}

module.exports = { createAirportTransfers, recordsFromCsv, faresFromCsv, parseCsv, localToUtc, utcToLocal, DATA_FILE, FARES_FILE };
