"use strict";

const { packSnapshot, ageOf } = require("./snapshots");

const PLK_API = "https://pdp-api.plk-sa.pl/api/v1/";
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const BLOCK_MS = 10 * 60 * 1000;
// The Basic plan allows 100 requests an hour and 1000 a day, so some stay in reserve.
const HOURLY_BUDGET = 90;
const DAILY_BUDGET = 950;
const REFRESH_MINUTES = 20;
const SCHEDULE_MS = 24 * HOUR_MS;
const DAYS_AHEAD = 90;
// Spread over several runs, so three months of timetables never use up the hour and block the delays.
const SCHEDULES_PER_RUN = 25;
const PAGE_SIZE = 5000;
const FRESH_SHARE = 0.9;
const OPERATIONS_KEY = "plk:operations";
const SCHEDULE_PREFIX = "plk:schedule:";
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// The stations shown on the station list; also used to check that a key works.
const SERVED_STATIONS = ["82669", "280247", "82602", "280246", "82677", "82735", "261251", "280254", "280257", "241561", "280258", "280256", "82644", "280420"];

const warsawDay = (ms) => new Date(ms).toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" });
const scheduleKey = (date) => (DATE.test(date || "") ? `${SCHEDULE_PREFIX}${date}` : null);

function seconds(time, dayOffset = 0) {
  if (!time) return null;
  const [hours, minutes, secs] = time.split(":").map(Number);
  return dayOffset * 86400 + hours * 3600 + minutes * 60 + (secs || 0);
}

// Every Polish station: id → [name, lat, lon], read once from the list the map also uses.
let NATIONAL = null;
function nationalStations() {
  if (!NATIONAL) {
    NATIONAL = new Map();
    try {
      for (const [id, name, lat, lon] of require("../assets/app.rail-stations.json")) NATIONAL.set(id, [name, lat ?? null, lon ?? null]);
    } catch (error) {
      console.warn("Rail station list unavailable", error.message);
    }
  }
  return NATIONAL;
}

// The whole country in about 1 MB compressed, so a browser can search it without asking again.
function compactSchedule({ rt = [], dc = {} }) {
  const trains = rt.map((route) => [route.sid, route.oid, route.ccs || "", route.nn || "", route.nm || "", route.cc || "", route.st.map((stop) => [
    stop.id,
    seconds(stop.atm, stop.ady),
    seconds(stop.dtm, stop.ddy),
    stop.dpl || stop.apl || "",
    stop.dtr || stop.atr || "",
  ])]);
  const stations = Object.values(dc.st || {}).filter((station) => station?.id != null && station.nm)
    .map((station) => [station.id, station.nm, station.lat ?? null, station.lon ?? null]);
  // PKP PLK sometimes sends the timetable without its station dictionary; names then come from the national station list.
  const known = new Set(stations.map((station) => station[0]));
  const national = nationalStations();
  for (const route of trains) {
    for (const [id] of route[6]) {
      if (known.has(id)) continue;
      known.add(id);
      const station = national.get(id);
      if (station) stations.push([id, station[0], station[1], station[2]]);
    }
  }
  return { stations, carriers: Object.entries(dc.cr || {}), trains };
}

// Only what differs from the timetable: stops with nothing to report are left out.
function compactOperation(train) {
  const stops = (train.st || [])
    .filter((stop) => stop.aa || stop.ad || stop.adm != null || stop.ddm != null || stop.cf || stop.cn)
    .map((stop) => [stop.id, stop.adm ?? null, stop.ddm ?? null, stop.aa || null, stop.ad || null, stop.cf ? 1 : 0, stop.cn ? 1 : 0]);
  return [train.sid, train.oid, train.od, train.s, stops];
}

// Calls PKP on a fixed schedule and writes the results to the database. Nothing here runs because of a visitor.
function createPlkCollector({ readKey, saveKey, snapshots, fetchSource = fetch, now = Date.now, refreshMinutes = Number(process.env.PKP_REFRESH_MINUTES) || REFRESH_MINUTES }) {
  const refreshMs = refreshMinutes * 60 * 1000;
  let calls = [];
  let blockedUntil = 0;
  let timer = null;
  let running = null;

  function spend() {
    calls = calls.filter((at) => now() - at < DAY_MS);
    if (calls.length >= DAILY_BUDGET || calls.filter((at) => now() - at < HOUR_MS).length >= HOURLY_BUDGET) return false;
    calls.push(now());
    return true;
  }

  const call = (path, query, key) => fetchSource(new URL(`${PLK_API}${path}?${query}`), {
    headers: { "X-API-Key": key, Accept: "application/json" },
    signal: AbortSignal.timeout(60000),
  });

  async function request(path, query, key) {
    if (now() < blockedUntil || !spend()) return null;
    const upstream = await call(path, query, key);
    if (upstream.status === 429) blockedUntil = now() + BLOCK_MS;
    if (!upstream.ok) throw new Error(`Rail API returned HTTP ${upstream.status}.`);
    return upstream.json();
  }

  // Saved only when every page arrived, so a failed refresh leaves the last complete copy.
  async function loadOperations(key) {
    const trains = [];
    const oldest = warsawDay(now() - DAY_MS);
    for (let page = 1; ; page += 1) {
      const data = await request("operations/shortened", new URLSearchParams({ pageSize: String(PAGE_SIZE), withPlanned: "true", page: String(page) }), key);
      if (!data) return;
      for (const train of data.tr || []) if (train.s !== "C" && train.od >= oldest) trains.push(compactOperation(train));
      if (!data.pg?.hn) break;
    }
    await snapshots.save(OPERATIONS_KEY, await packSnapshot(trains));
  }

  async function loadSchedule(date, key) {
    const data = await request("schedules/shortened", new URLSearchParams({ dateFrom: date, dateTo: date, fullRoute: "true", dictionaries: "true" }), key);
    if (data) await snapshots.save(scheduleKey(date), await packSnapshot(compactSchedule(data)));
  }

  async function isFresh(snapshotKey, maxAgeMs) {
    const info = await snapshots.info(snapshotKey);
    return Boolean(info) && ageOf(info, now()) < maxAgeMs * FRESH_SHARE;
  }

  async function work(force) {
    const key = (await readKey())?.value;
    if (!key) return;
    if (force || !await isFresh(OPERATIONS_KEY, refreshMs)) await loadOperations(key);
    let loaded = 0;
    for (const days of [0, -1, ...Array.from({ length: DAYS_AHEAD }, (_, index) => index + 1)]) {
      const date = warsawDay(now() + days * DAY_MS);
      if (loaded >= SCHEDULES_PER_RUN) break;
      if (await isFresh(scheduleKey(date), SCHEDULE_MS)) continue;
      await loadSchedule(date, key);
      loaded += 1;
    }
    await snapshots.prune(SCHEDULE_PREFIX, warsawDay(now() - DAY_MS));
  }

  function refresh(force = false) {
    running ??= work(force).catch((error) => console.error("Rail refresh failed:", error.message)).finally(() => { running = null; });
    return running;
  }

  function start() {
    refresh();
    timer = setInterval(refresh, refreshMs);
    timer.unref?.();
  }

  function stop() {
    clearInterval(timer);
    timer = null;
  }

  async function status() {
    const saved = await readKey();
    return { configured: Boolean(saved?.value), updatedAt: saved?.updatedAt || null };
  }

  // A mistyped key would silently turn off real trains for everyone, so PKP confirms it first.
  async function setKey(value) {
    const upstream = await call("operations", new URLSearchParams({ stations: SERVED_STATIONS[0], pageSize: "1" }), value);
    if (upstream.status === 401 || upstream.status === 403) return false;
    if (!upstream.ok && upstream.status !== 429) throw new Error(`Rail API returned HTTP ${upstream.status}.`);
    await saveKey(value);
    blockedUntil = 0;
    if (timer) refresh(true);
    return true;
  }

  return { refresh, setKey, start, status, stop };
}

module.exports = { OPERATIONS_KEY, SERVED_STATIONS, compactOperation, compactSchedule, createPlkCollector, scheduleKey };
