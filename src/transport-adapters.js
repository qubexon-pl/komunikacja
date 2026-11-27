"use strict";

// Phase 4b (docs/PODAVO_REFACTOR.md): Rzeszów's imported timetable and PKP PLK behind adapters that answer with the
// normalised Departure model of src/transport.js. Both read only what the background jobs already keep in the database
// (the snapshots "schedule:ztm", "schedule:pks", "plk:schedule:<day>" and "plk:operations"); a visitor never makes the
// server call ZTM, PKS or PKP.
//
// Real time:
//  - PKP PLK: a departure is "live" when PKP's operations feed has that train; its delay is the station's own delay, or
//    the last delay reported before it while the train is running (the rule the train board already uses).
//  - Rzeszów: GTFS-RT delays are decoded in the browser today, so the server adapter answers "scheduled" for every
//    departure. It never pretends a timetable time is live.

const zlib = require("node:zlib");
const { localToUtc, utcToLocal } = require("./transitous");
const { OPERATIONS_KEY, scheduleKey } = require("./plk");

const ZONE = "Europe/Warsaw";
const DAY = 86400;
const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const AGENCIES = ["ztm", "pks"];
const GTFS_MODE = { 0: "tram", 1: "metro", 2: "rail", 3: "bus", 4: "ferry", 11: "trolleybus" };

const bad = (message) => Object.assign(new Error(message), { status: 400 });
const local = (ms) => { const l = utcToLocal(ms, ZONE); return `${l.day}T${l.clock}`; };
const midnight = (day) => localToUtc(`${day}T00:00`, ZONE);
const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY * 1000).toISOString().slice(0, 10);
const hex = (v) => (/^[0-9a-fA-F]{6}$/.test(v || "") ? `#${v}` : null);

function unpack(body) {
  if (!body) return null;
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return JSON.parse((buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf).toString("utf8"));
}

/* ---------- Rzeszów (ZTM, PKS): imported GTFS ---------- */

const ymd = (v) => String(v instanceof Date ? v.toISOString() : v || "").slice(0, 10);
// Which services run on a day: the weekly calendar between its dates, then the exceptions (1 added, 2 removed).
function servicesOn(schedule, day) {
  const weekday = (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7; // Monday 0
  const on = new Set();
  for (const c of schedule.calendar || []) if (c.days?.[weekday] && ymd(c.start) <= day && day <= ymd(c.end)) on.add(c.service_id);
  for (const x of schedule.calendarDates || []) {
    if (ymd(x.date) !== day) continue;
    if (Number(x.exception_type) === 1) on.add(x.service_id); else on.delete(x.service_id);
  }
  return on;
}

// Index kept per snapshot: stop → [trip id, departure seconds] sorted by time, plus the lookups a departure needs.
function indexSchedule(schedule, agency) {
  const routes = new Map((schedule.routes || []).map((r) => [r.id, r]));
  const trips = new Map((schedule.trips || []).map((t) => [t.id, t]));
  const stops = new Map((schedule.stops || []).map((s) => [String(s.id), s]));
  const last = new Map();
  for (const st of schedule.stopTimes || []) { const l = last.get(st.trip_id); if (!l || st.sequence > l.sequence) last.set(st.trip_id, st); }
  const byStop = new Map();
  for (const st of schedule.stopTimes || []) {
    const dep = st.departure_seconds ?? st.arrival_seconds;
    if (dep == null || last.get(st.trip_id) === st) continue; // nobody boards at the last stop
    const id = String(st.stop_id);
    if (!byStop.has(id)) byStop.set(id, []);
    byStop.get(id).push([st.trip_id, dep]);
  }
  for (const list of byStop.values()) list.sort((a, b) => a[1] - b[1]);
  return { agency, schedule, routes, trips, stops, byStop };
}

function rzeszowDepartures(index, { stop, at, limit = 20 }) {
  const stopId = String(stop), info = index.stops.get(stopId);
  if (!info) return null;
  const list = index.byStop.get(stopId) || [];
  const today = utcToLocal(at, ZONE).day, out = [];
  // yesterday's services cover trips that run past midnight (GTFS times over 24:00)
  for (const day of [addDays(today, -1), today, addDays(today, 1)]) {
    const base = midnight(day), on = servicesOn(index.schedule, day);
    for (const [tripId, sec] of list) {
      const ms = base + sec * 1000;
      if (ms < at) continue;
      const trip = index.trips.get(tripId);
      if (!trip || !on.has(trip.service)) continue;
      const route = index.routes.get(trip.route) || {};
      out.push({
        provider: "rzeszow-gtfs", agency: index.agency, stopId: `${index.agency}:${stopId}`, stopName: info.name || "",
        line: route.short || "", headsign: trip.headsign || "", mode: GTFS_MODE[route.type] || "bus",
        scheduled: local(ms), expected: local(ms), at: ms, delayMin: 0, realtime: "scheduled",
        platform: "", cancelled: false, color: hex(route.color), textColor: hex(route.text),
      });
    }
  }
  return out.sort((a, b) => a.at - b.at).slice(0, limit);
}

/* ---------- PKP PLK: national timetable + operations ---------- */

// Delay at one station of one train: its own report, else (while the train runs) the last report before it.
function plkDelays(stops, live, running) {
  let last = null;
  return stops.map(([id, arr, dep]) => {
    const q = live.get(String(id));
    let own = q ? (q[2] ?? q[1]) : null;
    if (own == null && q && (q[5] || q[3] || q[4])) own = 0; // confirmed at the station without a delay figure
    if (own != null) last = own;
    return own != null ? own : running ? (last ?? 0) : null;
  });
}

function plkDepartures({ days, ops = [], station, at, limit = 20 }) {
  const id = String(station), opsBy = new Map(ops.map((o) => [`${o[0]}/${o[1]}|${o[2]}`, o])), out = [];
  let stationName = "";
  for (const { date, data } of days) {
    if (!data) continue;
    const names = new Map((data.stations || []).map(([sid, name]) => [String(sid), name]));
    const carriers = new Map(data.carriers || []);
    if (!stationName) stationName = names.get(id) || "";
    const base = midnight(date);
    for (const [sid, oid, cat, num, name, carrier, stops] of data.trains || []) {
      const i = stops.findIndex((s) => String(s[0]) === id);
      if (i < 0 || i === stops.length - 1 || stops[i][2] == null) continue; // not here, or ends here
      const sched = base + stops[i][2] * 1000;
      const o = opsBy.get(`${sid}/${oid}|${date}`), live = new Map((o ? o[4] : []).map((x) => [String(x[0]), x]));
      const running = o ? o[3] === "P" || o[3] === "C" : false;
      const delay = o ? plkDelays(stops, live, running)[i] : null;
      const q = live.get(id), cancelled = (o && o[3] === "X") || !!(q && q[6]);
      const expectedMs = sched + (delay || 0) * 60000;
      if (expectedMs < at) continue;
      out.push({
        provider: "pkp-plk", stopId: id, stopName: names.get(id) || stationName,
        line: [cat, num].filter(Boolean).join(" ") || "Pociąg", name: name || "", carrier: carriers.get(carrier) || carrier || "",
        headsign: names.get(String(stops[stops.length - 1][0])) || "", mode: "rail",
        scheduled: local(sched), expected: local(expectedMs), at: expectedMs,
        delayMin: delay != null ? delay : 0, realtime: delay != null ? "live" : "scheduled",
        platform: stops[i][3] || "", track: stops[i][4] || "", cancelled, color: null, textColor: null,
      });
    }
  }
  return { stationName, departures: out.sort((a, b) => a.at - b.at).slice(0, limit) };
}

/* ---------- Transitous (the other 48 cities) ---------- */

// One departure of src/city-transit.js#departures: "live" only when the operator sent a prediction (x.live).
function transitousDeparture(x, stop) {
  const live = !!x.live, delay = live ? Math.round(x.delayMin || 0) : 0;
  return {
    provider: "transitous", stopId: stop.id, stopName: stop.name || "",
    line: x.line || "", headsign: x.headsign || "", mode: GTFS_KIND[x.kind] || x.kind || "bus",
    scheduled: local(x.at - delay * 60000), expected: local(x.at), at: x.at,
    delayMin: delay, realtime: live ? "live" : "scheduled",
    platform: x.platform || "", cancelled: !!x.cancelled, color: x.color || null, textColor: x.textColor || null,
  };
}
const GTFS_KIND = { subway: "metro", train: "rail" };

/* ---------- the shared service ---------- */

function createTransportDepartures({ snapshots, city = null, now = Date.now }) {
  const cache = new Map(); // snapshot key → { etag, value }
  async function load(key, build = (x) => x) {
    const info = await snapshots?.info(key).catch(() => null);
    if (!info) return null;
    const hit = cache.get(key);
    if (hit && hit.etag === info.etag) return hit.value;
    const value = build(unpack(await snapshots.read(key)));
    cache.set(key, { etag: info.etag, value, fetchedAt: info.fetchedAt });
    return value;
  }
  const fetchedAt = (key) => cache.get(key)?.fetchedAt || null;

  async function departures({ provider, stop, time = "", limit = 20 }) {
    if (time && !LOCAL_TIME.test(time)) throw bad("Nieprawidłowa godzina.");
    const n = Math.min(50, Math.max(1, Math.round(Number(limit) || 20)));
    const at = time ? localToUtc(time, ZONE) : Math.floor(now() / 60000) * 60000;
    if (provider === "rzeszow-gtfs") {
      const [agency, id] = String(stop || "").split(":");
      if (!AGENCIES.includes(agency) || !id || id.length > 40) throw bad("Wybierz przystanek (np. ztm:123).");
      const key = `schedule:${agency}`, index = await load(key, (s) => (s ? indexSchedule(s, agency) : null));
      if (!index) return { unavailable: true, departures: [] };
      const list = rzeszowDepartures(index, { stop: id, at, limit: n });
      if (!list) throw Object.assign(new Error("Nie znamy tego przystanku."), { status: 404 });
      return { provider, stop: { id: `${agency}:${id}`, name: index.stops.get(id)?.name || "" }, departures: list, zone: ZONE, fetchedAt: fetchedAt(key), source: agency === "ztm" ? "GTFS ZTM Rzeszów" : "GTFS PKS Rzeszów", realtime: "scheduled" };
    }
    if (provider === "pkp-plk") {
      if (!/^\d{1,9}$/.test(String(stop || ""))) throw bad("Wybierz stację.");
      const today = utcToLocal(at, ZONE).day;
      const [yesterday, current, ops] = await Promise.all([
        load(scheduleKey(addDays(today, -1))), load(scheduleKey(today)), load(OPERATIONS_KEY),
      ]);
      if (!current) return { unavailable: true, departures: [] };
      const { stationName, departures: list } = plkDepartures({ days: [{ date: addDays(today, -1), data: yesterday }, { date: today, data: current }], ops: ops || [], station: stop, at, limit: n });
      return { provider, stop: { id: String(stop), name: stationName }, departures: list, zone: ZONE, fetchedAt: fetchedAt(OPERATIONS_KEY) || fetchedAt(scheduleKey(today)), source: "PKP PLK" };
    }
    if (provider === "transitous") {
      if (!city) return { unavailable: true, departures: [] };
      const d = await city.departures({ stop, time });
      const list = (d.departures || []).map((x) => transitousDeparture(x, d.stop)).filter((x) => x.at >= at - 60000).slice(0, n);
      return { provider, stop: d.stop, departures: list, zone: d.zone || ZONE, fetchedAt: d.fetchedAt || null, source: d.source || "Transitous" };
    }
    throw bad("Nieznany przewoźnik.");
  }
  return { departures };
}

module.exports = { createTransportDepartures, transitousDeparture, rzeszowDepartures, indexSchedule, servicesOn, plkDepartures, plkDelays, unpack };
