"use strict";

// From the airport to the city (and back) at each Ryanair / Wizz Air destination.
//
// Static part: data/airport-transfers.csv (pickup point, route to the centre, typical fare, walk from the terminal, open
// timetable coverage). The file is the reviewed source; on start it is copied into dbo.AirportTransfer whenever its
// content changes, and requests read the database copy.
//
// Live part, on demand: real connections from the pickup point to the traveller's destination after landing (or from the
// destination to the airport before the return flight), from Transitous — a free, community-run journey planner built
// on open GTFS feeds. Requests are polite: an honest User-Agent, one at a time with a gap, and every answer is kept
// (memory and dbo.DataSnapshot) so a trip opened by many people asks once.

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const DATA_FILE = path.join(__dirname, "..", "data", "airport-transfers.csv");
const HASH_SETTING = "airport-transfers-hash";
const PLAN_URL = "https://api.transitous.org/api/v1/plan";
const USER_AGENT = "komunikacja-rzeszow/1.0 (trip planner; answers cached)";
const KEEP_MS = 12 * 60 * 60 * 1000;
const MIN_GAP_MS = 1100;
const AFTER_LANDING_MIN = 30; // leaving the plane, passport control, small bag
const BEFORE_DEPARTURE_MIN = 120; // be at the airport two hours before the flight
const AT_AIRPORT_KM = 3; // a destination this close to the airport means "take me to the city"
const MAX_TRIP_MIN = 4 * 60;
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

function km(aLat, aLon, bLat, bLon) {
  const r = Math.PI / 180, dLat = (bLat - aLat) * r, dLon = (bLon - aLon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
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

const MODE_KIND = { BUS: "bus", COACH: "bus", TROLLEYBUS: "bus", TRAM: "tram", SUBWAY: "metro", METRO: "metro", FERRY: "ferry", AIRPLANE: "plane", ODM: "taxi", FLEX: "bus" };
const kindOf = (mode) => MODE_KIND[mode] || (/RAIL|TRAIN|FUNICULAR|CABLE/.test(mode || "") ? "rail" : "bus");

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

function createAirportTransfers({ database = null, snapshots = null, fetchSource = fetch, toPln = null, geocode = null, file = DATA_FILE, now = Date.now, minGapMs = MIN_GAP_MS } = {}) {
  let loading = null;
  let byCode = new Map();
  const trips = new Map();
  let queue = Promise.resolve();
  let lastAsk = 0;

  async function load() {
    const text = await fs.readFile(file, "utf8");
    const fromFile = recordsFromCsv(text);
    let records = fromFile;
    if (database) {
      try {
        const hash = crypto.createHash("sha256").update(text).digest("hex");
        const saved = await database.readSetting(HASH_SETTING);
        if (saved?.value !== hash) {
          await database.replace(fromFile);
          await database.saveSetting(HASH_SETTING, hash);
          console.log(`Airport transfers: ${fromFile.length} airports saved to the database.`);
        }
        const stored = await database.read();
        if (stored.length) records = stored;
      } catch (error) {
        console.warn("Airport transfers: database unavailable, using the CSV.", error.message);
      }
    }
    byCode = new Map(records.map((r) => [r.code, r]));
  }
  const ready = () => (loading ||= load().catch((error) => { loading = null; throw error; }));

  async function withPln(rec) {
    let farePln = null;
    if (rec.fareEur === 0) farePln = 0;
    else if (rec.fareEur > 0 && toPln) farePln = await toPln(rec.fareEur, "EUR").then((v) => (v == null ? null : Math.round(v))).catch(() => null);
    return { ...rec, farePln, zone: zoneOf(rec) };
  }
  const zoneOf = (rec) => AIRPORT_ZONES[rec.code] || COUNTRY_ZONES[rec.country] || "UTC";

  async function lookup(codes) {
    await ready();
    const wanted = [...new Set(codes.map((c) => String(c).trim().toUpperCase()).filter((c) => CODE.test(c)))].slice(0, 30);
    const found = wanted.map((c) => byCode.get(c)).filter(Boolean);
    return { transfers: await Promise.all(found.map(withPln)), missing: wanted.filter((c) => !byCode.has(c)) };
  }

  // One Transitous request at a time, at least minGapMs apart.
  function ask(url) {
    const run = queue.then(async () => {
      const wait = lastAsk + minGapMs - now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      lastAsk = now();
      const response = await fetchSource(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw Object.assign(new Error(`Transitous zwrócił HTTP ${response.status}.`), { status: 502 });
      return response.json();
    });
    queue = run.catch(() => {});
    return run;
  }

  async function cityCentre(rec) {
    if (!geocode) return null;
    const city = rec.city.replace(/\s*\(.*\)\s*$/, "").split("/")[0].trim();
    const found = await geocode(`${city}, ${rec.country}`, { world: true }).catch(() => null);
    const p = found?.places?.[0]?.points?.[0];
    return p ? { lat: p[0], lon: p[1], label: city, centre: true } : null;
  }

  // dir "from": landing at `code` at local `time` → destination. dir "to": destination → `code`, flight at local `time`.
  async function connections({ code, lat, lon, time, dir = "from", label = "" }) {
    await ready();
    const rec = byCode.get(String(code || "").toUpperCase());
    if (!rec) throw Object.assign(new Error("Nie znamy tego lotniska."), { status: 404 });
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw Object.assign(new Error("Nieprawidłowe miejsce."), { status: 400 });
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
    const key = `xfer:${new Date(now()).toISOString().slice(0, 10).replace(/-/g, "")}:${id}`;
    const fresh = (hit) => hit && now() - hit.fetchedAt < KEEP_MS;

    const mem = trips.get(id);
    if (fresh(mem)) return mem;
    if (snapshots) {
      const body = await snapshots.read(key).catch(() => null);
      const saved = body ? JSON.parse(Buffer.from(body).toString("utf8")) : null;
      if (fresh(saved)) { trips.set(id, saved); return saved; }
    }
    const params = new URLSearchParams({
      fromPlace: dir === "from" ? pickup : place,
      toPlace: dir === "from" ? place : pickup,
      time: new Date(at).toISOString(),
      numItineraries: "4",
    });
    if (dir === "to") params.set("arriveBy", "true");
    const body = await ask(`${PLAN_URL}?${params}`);
    let list = tripsFrom(body, zone);
    if (dir === "to") list = list.sort((a, b) => b.arr.clock.localeCompare(a.arr.clock) || a.minutes - b.minutes);
    const result = {
      code: rec.code, dir, target, zone, trips: list, fetchedAt: now(), source: "Transitous",
      wanted: utcToLocal(at, zone),
    };
    trips.set(id, result);
    if (trips.size > 2000) trips.delete(trips.keys().next().value);
    if (snapshots) {
      const buf = Buffer.from(JSON.stringify(result));
      snapshots.save(key, { body: buf, type: "application/json", etag: `"${id.slice(0, 32)}"` })
        .then(() => (Math.random() < 0.05 ? snapshots.prune("xfer:", new Date(now() - 86400000).toISOString().slice(0, 10).replace(/-/g, "")) : null))
        .catch((error) => console.warn("Airport transfers: could not store connections.", error.message));
    }
    return result;
  }

  return { ready, lookup, connections };
}

module.exports = { createAirportTransfers, recordsFromCsv, parseCsv, localToUtc, utcToLocal, DATA_FILE };
