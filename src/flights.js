"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { AIRPORTS, BY_CODE, addAirports, airportLabel, airportsNear } = require("./airports");

const WINDOW_DAYS = 14;
// Airlines sell about a year ahead, and the planner plans that far.
const STORE_DAYS = 366;
const NETWORK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RETURNS = 5;
const STRIP_DAYS = 56; // the date strips reach 8 weeks either way; days without stored prices are asked for when scrolled to
const LIVE_TTL_MS = 6 * 60 * 60 * 1000;
// Airlines stop selling a flight shortly before it leaves; a flight of today is offered only when it leaves later than this.
const SALE_CLOSES_MIN = 120;
// Local clock of the departure airports (Polish airports, and near enough for most of Europe within the margin above).
const localNow = (date, plusMin = 0) => new Date(date.getTime() + plusMin * 60000).toLocaleString("sv-SE", { timeZone: "Europe/Warsaw" }).slice(0, 16).replace(" ", "T");
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
// Far enough to reach Warsaw, Wrocław or Budapest when nothing nearer flies there; the cost of getting there is counted.
const ORIGIN_AIRPORT_KM = 600;
// "Any distance" in the planner: every airport the app knows, nearest first.
const ANY_RADIUS_KM = 5000;
const TRIP_ORIGINS = 3;
const TRIP_MAX_PAIRS = 6;
const DEST_AIRPORT_KM = 200;
const ROAD_FACTOR = 1.25;
const GROUND_PLN_PER_KM = 0.6;
const MAX_RESULTS = 200;
const IATA = /^[A-Z]{3}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

const isoDay = (date) => date.toISOString().slice(0, 10);
const addDays = (day, days) => isoDay(new Date(Date.parse(`${day}T12:00:00Z`) + days * 86400000));
const localTime = (value) => (typeof value === "string" && LOCAL_TIME.test(value) ? value.slice(0, 16) : null);

function normalizeFare(row) {
  const fare = {
    airline: String(row?.airline || "").trim().toUpperCase().slice(0, 16),
    from: String(row?.from || "").trim().toUpperCase(),
    to: String(row?.to || "").trim().toUpperCase(),
    day: String(row?.day || "").slice(0, 10),
    departure: localTime(row?.departure),
    arrival: localTime(row?.arrival),
    flightNumber: row?.flightNumber ? String(row.flightNumber).trim().slice(0, 16) : null,
    price: Number(row?.price),
    currency: row?.currency ? String(row.currency).trim().toUpperCase().slice(0, 3) : null,
    pricePln: Number(row?.pricePln),
    seatsLeft: Number.isInteger(row?.seatsLeft) ? row.seatsLeft : null,
    priceType: row?.priceType === "list" ? "list" : "exact",
    source: String(row?.source || "import").slice(0, 40),
    collectedAt: row?.collectedAt ? new Date(row.collectedAt) : new Date(),
  };
  // Flights with changes from the official APIs; the stored tracker fares have none of these.
  if (Number.isInteger(row?.stops) && row.stops > 0) fare.stops = row.stops;
  if (Array.isArray(row?.via)) fare.via = row.via.filter((code) => IATA.test(code)).slice(0, 3);
  if (row?.airlineName) fare.airlineName = String(row.airlineName).slice(0, 60);
  if (row?.searchKey) fare.searchKey = String(row.searchKey);
  const valid = fare.airline && IATA.test(fare.from) && IATA.test(fare.to) && DAY.test(fare.day)
    && fare.price > 0 && fare.pricePln > 0 && !Number.isNaN(fare.collectedAt.getTime());
  return valid ? fare : null;
}

function inWindow(rows, today, days = STORE_DAYS) {
  const last = addDays(today, days);
  return rows.map(normalizeFare).filter((fare) => fare && fare.day >= today && fare.day <= last);
}

// A scan may cover only part of the calendar, so each day of a route keeps the prices of the newest run that saw it.
function readTrackerDatabase(file, today, days = STORE_DAYS) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(`
      SELECT f.airline, f.from_airport AS "from", f.to_airport AS "to", f.day, f.departure, f.arrival,
             f.flight_number AS flightNumber, MIN(f.price) AS price, f.currency, MIN(f.price_base) AS pricePln, MIN(f.seats_left) AS seatsLeft,
             f.source, f.collected_at AS collectedAt,
             CASE WHEN f.source IN ('wizz.farechart', 'wizz.timetable') THEN 'list' ELSE 'exact' END AS priceType
      FROM fares f
      WHERE f.run_id = (SELECT MAX(x.run_id) FROM fares x
                        WHERE x.airline = f.airline AND x.from_airport = f.from_airport AND x.to_airport = f.to_airport AND x.day = f.day)
        AND f.base_currency = 'PLN'
        AND f.day BETWEEN ? AND ?
        AND NOT (f.source IN ('wizz.farechart', 'wizz.timetable') AND EXISTS (
              SELECT 1 FROM fares s WHERE s.run_id = f.run_id AND s.source = 'wizz.search'
                AND s.from_airport = f.from_airport AND s.to_airport = f.to_airport AND s.day = f.day))
        AND NOT (f.source = 'wizz.farechart' AND EXISTS (
              SELECT 1 FROM fares s WHERE s.run_id = f.run_id AND s.source = 'wizz.timetable'
                AND s.from_airport = f.from_airport AND s.to_airport = f.to_airport AND s.day = f.day))
      GROUP BY f.airline, f.from_airport, f.to_airport, f.day, COALESCE(f.flight_number, ''), COALESCE(f.departure, '')
    `).all(today, addDays(today, days)).map((row) => ({ ...row, collectedAt: `${String(row.collectedAt).replace(" ", "T")}Z` }));
  } finally {
    db.close();
  }
}

async function readFareFile(file, today) {
  if (path.extname(file).toLowerCase() !== ".json") return readTrackerDatabase(file, today);
  const rows = JSON.parse(await fs.readFile(file, "utf8"));
  if (!Array.isArray(rows)) throw new Error("A fare file must contain a JSON array.");
  return rows;
}

// SQLite keeps recent writes in a -wal file, so the database file alone can look unchanged after a run.
async function lastChange(file) {
  const [main, wal] = await Promise.all([fs.stat(file), fs.stat(`${file}-wal`).catch(() => null)]);
  return { mtimeMs: Math.max(main.mtimeMs, wal?.mtimeMs || 0) };
}

// A Wizz Air timetable lists every departure of a day but prices only the cheapest one. Each departure is its own
// flight; the others are marked priceUnknown (their stored price is only the day's lowest) until a query for
// their own time prices them. A priced departure replaces the unpriced row of the same time.
function withDepartureTimes(fares) {
  const keyOf = (fare) => `${fare.airline}|${fare.from}|${fare.to}|${fare.departure}`;
  const priced = new Set(fares.filter((fare) => fare.priceType !== "list" && fare.departure).map(keyOf));
  return fares
    .filter((fare) => fare.priceType !== "list" || !fare.departure || !priced.has(keyOf(fare)))
    .map((fare) => (fare.priceType === "list" && fare.departure ? { ...fare, priceUnknown: true } : fare));
}

/* ---------- Missing flight time and arrival ---------- */
// The way flight route sites estimate it: taxi, climb and descent plus cruise. A real flight time from another
// flight on the same route is preferred, because it already includes the time difference.
const CRUISE_KMH = 800;
const FIXED_MIN = 35;
// Hours to add to Polish time at the destination: [winter, summer]. Countries not listed share Polish time.
const TZ_FROM_POLAND = {
  "Wielka Brytania": [-1, -1], Irlandia: [-1, -1], Portugalia: [-1, -1], Islandia: [-1, -2], Maroko: [0, -1],
  Grecja: [1, 1], Cypr: [1, 1], "Bułgaria": [1, 1], Rumunia: [1, 1], Finlandia: [1, 1], Estonia: [1, 1], "Łotwa": [1, 1], Litwa: [1, 1],
  "Mołdawia": [1, 1], Ukraina: [1, 1], Izrael: [1, 1], Egipt: [1, 1], Jordania: [2, 1], Turcja: [2, 1], "Arabia Saudyjska": [2, 1],
  Gruzja: [3, 2], Armenia: [3, 2], "Azerbejdżan": [3, 2], "Zjednoczone Emiraty Arabskie": [3, 2],
};
const CANARY = new Set(["TFS", "TFN", "LPA", "ACE", "FUE", "SPC"]);
const AZORES = new Set(["PDL", "TER"]);
function hoursFromPoland(code, day) {
  if (CANARY.has(code)) return -1;
  if (AZORES.has(code)) return -2;
  const pair = TZ_FROM_POLAND[BY_CODE.get(code)?.country];
  if (!pair) return 0;
  const month = Number(String(day).slice(5, 7));
  return month >= 4 && month <= 10 ? pair[1] : pair[0];
}
const minutesBetween = (a, b) => (Date.parse(`${b}:00Z`) - Date.parse(`${a}:00Z`)) / 60000;
const addMinutes = (stamp, minutes) => new Date(Date.parse(`${stamp}:00Z`) + minutes * 60000).toISOString().slice(0, 16);
function kmBetween(from, to) {
  const a = BY_CODE.get(from), b = BY_CODE.get(to);
  if (!a || !b || a.lat == null || b.lat == null) return null;
  const rad = (x) => (x * Math.PI) / 180, dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}
// Local clock difference (arrival minus departure) of flights with both times, per route: the middle value.
function routeClockDiffs(fares) {
  const lists = new Map();
  for (const fare of fares) {
    if (!fare.departure || !fare.arrival) continue;
    const diff = minutesBetween(fare.departure, fare.arrival);
    if (!(diff > -300 && diff < 24 * 60)) continue;
    const key = `${fare.from}|${fare.to}`;
    if (!lists.has(key)) lists.set(key, []);
    lists.get(key).push(diff);
  }
  const middle = new Map();
  for (const [key, list] of lists) { list.sort((a, b) => a - b); middle.set(key, list[Math.floor(list.length / 2)]); }
  return middle;
}
function withFlightTime(fare, diffs) {
  if (!fare || !fare.departure) return fare;
  const tz = hoursFromPoland(fare.to, fare.day) - hoursFromPoland(fare.from, fare.day);
  if (fare.arrival) return { ...fare, durationMin: Math.round(minutesBetween(fare.departure, fare.arrival) - tz * 60) };
  const known = diffs.get(`${fare.from}|${fare.to}`);
  const km = kmBetween(fare.from, fare.to);
  const clock = known ?? (km == null ? null : Math.round(FIXED_MIN + (km / CRUISE_KMH) * 60 + tz * 60));
  if (clock == null) return fare;
  return { ...fare, arrival: addMinutes(fare.departure, clock), arrivalEstimated: true, durationMin: Math.round(clock - tz * 60), durationFrom: known != null ? "route" : "distance" };
}

const compareFares = (a, b) => a.pricePln - b.pricePln || (a.departure || a.day).localeCompare(b.departure || b.day);

function bookingUrl(fare) {
  if (fare.airline === "RYANAIR") {
    return `https://www.ryanair.com/pl/pl/trip/flights/select?adults=1&dateOut=${fare.day}&originIata=${fare.from}&destinationIata=${fare.to}&isReturn=false`;
  }
  if (fare.airline === "WIZZ") return `https://www.wizzair.com/pl-pl/booking/select-flight/${fare.from}/${fare.to}/${fare.day}/null/1/0/0/null`;
  return null;
}

function presentFare(fare) {
  return { ...fare, fromLabel: airportLabel(fare.from), toLabel: airportLabel(fare.to), bookingUrl: bookingUrl(fare) };
}

function summarize(fares) {
  const airlines = new Map();
  for (const fare of fares) {
    const entry = airlines.get(fare.airline) || { airline: fare.airline, flights: 0, cheapest: fare.pricePln };
    entry.flights += 1;
    entry.cheapest = Math.min(entry.cheapest, fare.pricePln);
    airlines.set(fare.airline, entry);
  }
  const routes = new Map();
  for (const fare of fares) {
    const key = `${fare.from}|${fare.to}`;
    const route = routes.get(key) || { from: fare.from, to: fare.to, flights: 0, firstDay: fare.day, cheapest: fare.pricePln, airlines: [] };
    route.flights += 1;
    if (fare.day < route.firstDay) route.firstDay = fare.day;
    route.cheapest = Math.min(route.cheapest, fare.pricePln);
    if (!route.airlines.includes(fare.airline)) route.airlines.push(fare.airline);
    routes.set(key, route);
  }
  const place = (code) => ({ ...BY_CODE.get(code), code, label: airportLabel(code) });
  const codes = new Set([...AIRPORTS.map((airport) => airport.code), ...fares.flatMap((fare) => [fare.from, fare.to])]);
  return {
    airlines: [...airlines.values()].sort((a, b) => a.cheapest - b.cheapest),
    routes: [...routes.values()],
    airports: [...codes].map(place),
    destinations: [...new Set(fares.map((fare) => fare.to))].sort().map(place),
  };
}

// Ranks by what the whole journey costs, so a cheap flight from a distant airport does not beat a slightly dearer one nearby.
function rankFares(fares, originAirports, destAirports) {
  const origins = new Map(originAirports.map((airport) => [airport.code, airport]));
  const dests = new Map(destAirports.map((airport) => [airport.code, airport]));
  return fares.filter((fare) => origins.has(fare.from) && dests.has(fare.to)).map((fare) => {
    const groundKm = Math.round((origins.get(fare.from).km + dests.get(fare.to).km) * ROAD_FACTOR);
    return {
      ...presentFare(fare),
      airport: { lat: origins.get(fare.from).lat, lon: origins.get(fare.from).lon },
      toAirportKm: Math.round(origins.get(fare.from).km * ROAD_FACTOR),
      fromAirportKm: Math.round(dests.get(fare.to).km * ROAD_FACTOR),
      groundPln: Math.round(groundKm * GROUND_PLN_PER_KM),
      totalPln: Math.round(fare.pricePln + groundKm * GROUND_PLN_PER_KM),
    };
  }).sort((a, b) => a.totalPln - b.totalPln || (a.priceUnknown ? 1 : 0) - (b.priceUnknown ? 1 : 0) || compareFares(a, b));
}

const daysBetween = (from, to) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000);

function returnFares(fares, destAirports, originAirports) {
  const dests = new Map(destAirports.map((airport) => [airport.code, airport]));
  const origins = new Map(originAirports.map((airport) => [airport.code, airport]));
  return fares
    .filter((fare) => dests.has(fare.from) && origins.has(fare.to))
    .map((fare) => {
      const groundKm = Math.round((dests.get(fare.from).km + origins.get(fare.to).km) * ROAD_FACTOR);
      return { ...presentFare(fare), homeKm: Math.round(origins.get(fare.to).km * ROAD_FACTOR), totalPln: Math.round(fare.pricePln + groundKm * GROUND_PLN_PER_KM) };
    })
    .sort((a, b) => a.totalPln - b.totalPln || compareFares(a, b));
}

// A return on the same day must leave after the outbound has landed.
const leavesAfter = (out, ret) => ret.day !== out.day || Boolean(ret.departure && out.arrival && ret.departure > out.arrival);

// Each outbound on the chosen day gets the returns flying back on the chosen return day.
function pairReturns(outbound, returns, back) {
  const trips = [];
  for (const out of outbound) {
    const list = returns.filter((ret) => ret.day === back && leavesAfter(out, ret));
    if (list.length) trips.push({ ...out, ret: list[0], returns: list.slice(0, MAX_RETURNS), totalPln: out.totalPln + list[0].totalPln });
  }
  return trips.sort((a, b) => a.totalPln - b.totalPln || compareFares(a, b));
}

// Return days from the departure day itself up to two weeks after the chosen return: the cheapest way home that day.
function backDayPrices(outbound, returns, date, back) {
  if (!back) return [];
  const byDay = new Map();
  for (const fare of returns) byDay.set(fare.day, Math.min(byDay.get(fare.day) ?? Infinity, fare.pricePln));
  const days = [];
  for (let day = date, last = addDays(back, STRIP_DAYS); day <= last; day = addDays(day, 1)) {
    if (byDay.has(day)) days.push({ day, cheapest: Math.round(byDay.get(day)) });
  }
  return days;
}

// The same day prices for each airline separately (flying with it both ways), for the two rows of the date strip.
function perAirline(outbound, returns, prices) {
  const all = prices(outbound, returns);
  for (const airline of ["RYANAIR", "WIZZ"]) {
    for (const entry of prices(outbound.filter((fare) => fare.airline === airline), returns.filter((fare) => fare.airline === airline))) {
      if (entry.outKnown === false) continue;
      const target = all.find((item) => item.day === entry.day);
      if (target) (target.airlines ||= {})[airline] = entry.cheapest;
    }
  }
  return all;
}

// Cheapest way out for each departure day two weeks either side (the return has its own strip and prices).
function dayPrices(outbound, returns, date) {
  const out = new Map();
  for (const fare of outbound) out.set(fare.day, Math.min(out.get(fare.day) ?? Infinity, fare.pricePln));
  const days = [];
  for (let offset = -STRIP_DAYS; offset <= STRIP_DAYS; offset += 1) {
    const day = addDays(date, offset);
    if (out.has(day)) days.push({ day, cheapest: Math.round(out.get(day)) });
  }
  return days;
}

function createFlightStore({ database, file = process.env.FLIGHT_FARES_FILE || "", readFile = readFareFile, statFile = lastChange, now = () => new Date(), checkIntervalMs = CHECK_INTERVAL_MS }) {
  let fares = [];
  let lastModified = 0;
  let timer = null;
  let network = { airports: [], routes: [], updatedAt: null };

  const today = () => isoDay(now());
  function useNetwork(value) {
    network = value;
    addAirports(value.airports);
  }
  // Only observations not seen before go to the history: the tracker file is read again whole after each run.
  const seen = new Set();
  const observation = (fare) => `${fare.airline}|${fare.from}|${fare.to}|${fare.day}|${fare.departure || ""}|${fare.flightNumber || ""}|${fare.pricePln}|${fare.collectedAt.getTime()}`;
  function recordHistory(list) {
    const fresh = list.filter((fare) => fare && !seen.has(observation(fare)));
    if (!fresh.length || !database.appendHistory) return;
    for (const fare of fresh) seen.add(observation(fare));
    if (seen.size > 200000) seen.clear();
    database.appendHistory(fresh).catch((error) => console.error("Price history:", error.message));
  }

  let live = [];
  const current = () => {
    const fresh = now().getTime() - LIVE_TTL_MS;
    live = live.filter((fare) => fare.collectedAt.getTime() >= fresh);
    // Today only flights that can still be bought: leaving at least SALE_CLOSES_MIN from now. A price of today without a
    // departure time cannot be checked, so it is not offered either.
    const day = localNow(now()).slice(0, 10), closes = localNow(now(), SALE_CLOSES_MIN);
    const onSale = (fare) => fare.day > day || (fare.day === day && !!fare.departure && fare.departure >= closes);
    return withDepartureTimes([...fares, ...live].filter((fare) => fare.day >= today() && onSale(fare)));
  };
  // Answers of the official APIs for one trip search: each search replaces what it found before.
  function addLive(rows, searched = []) {
    const done = new Set(searched);
    const added = rows.map(normalizeFare).filter(Boolean);
    recordHistory(added);
    live = [...live.filter((fare) => !done.has(fare.searchKey)), ...added];
    return live.length;
  }

  // New fares replace what is stored for the same airline, route and day; everything else stays.
  // departures: replace only the same departures of a day (the price of one chosen flight), not the whole day.
  // clear: days the airline answered for and had no flight on ({airline, from, to, day}); what is stored for them goes.
  // drop: single departures the airline no longer sells ({airline, from, to, day, departure}); their stored price goes.
  async function mergeRows(rows, { departures = false, clear = [], drop = [] } = {}) {
    const incoming = inWindow(rows, today());
    const gone = new Set(clear.map((c) => `${c.airline}|${c.from}|${c.to}|${c.day}`));
    const unsold = new Set(drop.map((d) => `${d.airline}|${d.from}|${d.to}|${d.day}|${d.departure}`));
    const removed = (fare) => gone.has(groupOf(fare)) || unsold.has(`${groupOf(fare)}|${fare.departure || ""}`);
    if (!incoming.length && !fares.some(removed)) return { received: rows.length, stored: 0, removed: 0 };
    const keyOf = departures ? (fare) => `${groupOf(fare)}|${fare.departure || ""}` : groupOf;
    const groups = new Set(incoming.map(keyOf));
    const unpriced = new Set(incoming.filter((fare) => fare.priceType === "list" && fare.departure).map((fare) => `${groupOf(fare)}|${fare.departure}`));
    const keep = (fare) => !removed(fare) && (!groups.has(keyOf(fare)) || (fare.priceType !== "list" && !!fare.departure && unpriced.has(`${groupOf(fare)}|${fare.departure}`)));
    const dropped = fares.filter(removed).length;
    const next = [...fares.filter(keep), ...incoming];
    await database.replaceFares(next);
    recordHistory(incoming);
    fares = next;
    return { received: rows.length, stored: incoming.length, removed: dropped };
  }

  async function load() {
    const saved = await database.readNetwork?.();
    if (saved) useNetwork(saved);
    fares = (await database.readFares(today())).map(normalizeFare).filter(Boolean);
    for (const fare of fares) seen.add(observation(fare)); // already recorded when they arrived
    return fares.length;
  }

  async function saveNetwork(value) {
    await database.saveNetwork(value);
    useNetwork(value);
  }

  function networkIsStale() {
    return !network.updatedAt || now().getTime() - Date.parse(network.updatedAt) >= NETWORK_MAX_AGE_MS;
  }

  // Which routes a scan should cover. Without a route list yet, both airlines are simply tried.
  // Cheapest known ticket on a route and day, for price alerts and saved trips.
  function cheapest({ from, to, day, airline = "" }) {
    const list = current().filter((fare) => fare.from === from && fare.to === to && fare.day === day && (!airline || fare.airline === airline));
    if (!list.length) return null;
    const best = list.reduce((a, b) => (b.pricePln < a.pricePln ? b : a));
    return { pricePln: best.pricePln, airline: best.airline, departure: best.departure, priceType: best.priceType, collectedAt: best.collectedAt };
  }

  function pairsFor({ from = "", to = "", airlines = [] }) {
    if (!network.routes.length) return from && to ? [{ from, to, airlines: airlines.length ? airlines : ["RYANAIR", "WIZZ"] }] : [];
    return network.routes
      .filter((route) => (!from || route.from === from) && (!to || route.to === to))
      .map((route) => ({ ...route, airlines: route.airlines.filter((airline) => !airlines.length || airlines.includes(airline)) }))
      .filter((route) => route.airlines.length);
  }

  const groupOf = (fare) => `${fare.airline}|${fare.from}|${fare.to}|${fare.day}`;
  // A tracker sync replaces the tracker's own fares only. Prices the app asked Wizz Air for itself (wizz.api.*) are
  // never replaced by it: the tracker no longer collects Wizz Air, and its file still holds Wizz rows of old runs.
  // Fares imported from the user's own browser stay until the tracker brings something newer for the same day.
  function keepImported(accepted) {
    const newest = new Map();
    for (const fare of accepted) newest.set(groupOf(fare), Math.max(newest.get(groupOf(fare)) || 0, fare.collectedAt.getTime()));
    const own = (fare) => fare.source.startsWith("wizz.api.") || fare.source.startsWith("ryanair.api.");
    const kept = fares.filter((fare) => fare.day >= today() && (own(fare) || (fare.source.startsWith("har.") && !(newest.get(groupOf(fare)) >= fare.collectedAt.getTime()))));
    const keptGroups = new Set(kept.map(groupOf));
    return [...accepted.filter((fare) => !keptGroups.has(groupOf(fare))), ...kept];
  }

  async function importRows(rows) {
    const fromSource = inWindow(rows, today());
    if (!fromSource.length) return { received: rows.length, stored: 0 }; // an empty run must not wipe the flights we already have
    const accepted = keepImported(fromSource);
    await database.replaceFares(accepted);
    recordHistory(fromSource);
    fares = accepted;
    return { received: rows.length, stored: accepted.length };
  }

  // The source file is written by another program, so it is only read again after it has changed.
  async function sync() {
    if (!file) return null;
    const { mtimeMs } = await statFile(file);
    if (mtimeMs === lastModified) return null;
    const result = await importRows(await readFile(file, today()));
    lastModified = mtimeMs;
    return result;
  }

  function search({ from = "", to = "", date = "" } = {}) {
    const all = current();
    const onRoute = all.filter((fare) => (!from || fare.from === from) && (!to || fare.to === to));
    const found = onRoute.filter((fare) => !date || fare.day === date).sort(compareFares);
    const days = new Map();
    for (const fare of onRoute) days.set(fare.day, Math.min(days.get(fare.day) ?? Infinity, fare.pricePln));
    const stamps = all.map((fare) => fare.collectedAt.getTime());
    return {
      flights: found.slice(0, MAX_RESULTS).map(presentFare),
      total: found.length,
      days: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([day, cheapest]) => ({ day, cheapest })),
      collectedAt: stamps.length ? new Date(Math.max(...stamps)).toISOString() : null,
      ...summarize(all),
    };
  }

  // Flights leaving on the chosen day (and coming back on the chosen return day), plus the cheapest price of nearby days.
  // radius: how far from the start the traveller is willing to go to an airport (km), at most ORIGIN_AIRPORT_KM.
  function options({ origin, dest, date = "", back = "", radius = ORIGIN_AIRPORT_KM, prefer = "" }) {
    const originAirports = airportsNear(origin, Math.min(Math.max(Number(radius) || ORIGIN_AIRPORT_KM, 30), ANY_RADIUS_KM));
    const destAirports = airportsNear(dest, DEST_AIRPORT_KM);
    const all = current();
    const day = date || today();
    const outbound = rankFares(all, originAirports, destAirports);
    const returns = back ? returnFares(all, destAirports, originAirports) : [];
    const onDay = outbound.filter((fare) => fare.day === day);
    // The nearest airport outside the chosen radius that flies there that day, so the planner can suggest a wider radius.
    let outside = null;
    if (originAirports.length < airportsNear(origin, ORIGIN_AIRPORT_KM).length) {
      const inside = new Set(originAirports.map((airport) => airport.code));
      const wider = airportsNear(origin, ORIGIN_AIRPORT_KM).filter((airport) => !inside.has(airport.code));
      const flying = new Set(rankFares(all, wider, destAirports).filter((fare) => fare.day === day).map((fare) => fare.from));
      const near = wider.find((airport) => flying.has(airport.code));
      if (near) outside = { code: near.code, city: near.city, km: near.km };
    }
    // Without fares the planner still sketches the journey through the nearest airport that flies there.
    const pair = tripPairs({ origin, dest })[0];
    const suggested = pair && { from: originAirports.find((a) => a.code === pair.from), to: destAirports.find((a) => a.code === pair.to), airlines: pair.airlines };
    const diffs = routeClockDiffs(all);
    const timed = (fare) => withFlightTime(fare, diffs);
    const timedTrip = (trip) => ({ ...timed(trip), ret: trip.ret ? timed(trip.ret) : trip.ret, returns: (trip.returns || []).map(timed) });
    // The first flight from the preferred airport (or the nearest one that flies there) to the destination.
    const destCodes = new Set(destAirports.map((airport) => airport.code));
    const toDest = all.filter((fare) => destCodes.has(fare.to)).sort((a, b) => a.day.localeCompare(b.day) || (a.departure || "").localeCompare(b.departure || "") || a.pricePln - b.pricePln);
    const firstFromCode = prefer && IATA.test(prefer) ? prefer : airportsNear(origin, ANY_RADIUS_KM).find((airport) => toDest.some((fare) => fare.from === airport.code))?.code;
    const firstFare = firstFromCode ? toDest.find((fare) => fare.from === firstFromCode) : null;
    const first = firstFromCode ? { from: firstFromCode, fromLabel: airportLabel(firstFromCode), preferred: firstFromCode === prefer, fare: firstFare ? presentFare(timed(firstFare)) : null } : null;
    // The next flight after the chosen day from any airport within the radius, for "nothing that day, try …".
    const originCodes = new Set(originAirports.map((airport) => airport.code));
    const nextFare = toDest.find((fare) => originCodes.has(fare.from) && fare.day > (date || "") && !fare.priceUnknown);
    return {
      suggested: suggested?.from && suggested?.to ? suggested : null,
      options: (back ? pairReturns(onDay, returns, back) : onDay).slice(0, MAX_RESULTS).map(timedTrip),
      // Every flight on the chosen days, so the traveller can pick the way out and the way home separately.
      outbound: onDay.slice(0, MAX_RESULTS).map(timed),
      outside,
      first,
      next: nextFare ? presentFare(timed(nextFare)) : null,
      inbound: back ? returns.filter((fare) => fare.day === back).slice(0, MAX_RESULTS).map(timed) : [],
      days: perAirline(outbound, returns, (o, r) => dayPrices(o, r, day, back)),
      backDays: perAirline(outbound, returns, (o, r) => backDayPrices(o, r, day, back)),
      originAirports: originAirports.slice(0, 12),
      destAirports: destAirports.slice(0, 3),
    };
  }

  // Without a source file another machine does the collecting, so new flights arrive through the database.
  function refresh() {
    return (file ? sync() : load()).catch((error) => console.error("Flight refresh failed:", error.message));
  }

  function start() {
    load().catch((error) => console.error("Flights could not be loaded:", error.message)).then(() => (file ? refresh() : null));
    timer = setInterval(refresh, checkIntervalMs);
    timer.unref?.();
  }

  function stop() {
    clearInterval(timer);
  }

  // Routes worth asking the airlines about for one trip: from the nearest airports that fly to the destination at all.
  function tripPairs({ origin, dest, prefer = "", radius = ORIGIN_AIRPORT_KM }) {
    const origins = airportsNear(origin, Math.min(Math.max(Number(radius) || ORIGIN_AIRPORT_KM, 30), ORIGIN_AIRPORT_KM));
    const dests = new Set(airportsNear(dest, DEST_AIRPORT_KM).slice(0, 3).map((airport) => airport.code));
    if (!network.routes.length) {
      return origins.slice(0, 2).flatMap((airport) => [...dests].slice(0, 2).map((to) => ({ from: airport.code, to, airlines: ["RYANAIR", "WIZZ"] })));
    }
    // A preferred airport of the traveller is always asked about, ahead of the nearest ones.
    const ordered = prefer ? [...origins.filter((airport) => airport.code === prefer), ...origins.filter((airport) => airport.code !== prefer)] : origins;
    const served = ordered.filter((airport) => network.routes.some((route) => route.from === airport.code && dests.has(route.to))).slice(0, TRIP_ORIGINS);
    return served
      .flatMap((airport) => network.routes.filter((route) => route.from === airport.code && dests.has(route.to)))
      .slice(0, TRIP_MAX_PAIRS)
      .map((route) => ({ from: route.from, to: route.to, airlines: [...route.airlines] }));
  }

  // The same routes flown home; an airline flies back only where the route list says so.
  function returnPairs(pairs) {
    return pairs.map((pair) => {
      const back = network.routes.find((route) => route.from === pair.to && route.to === pair.from);
      return { from: pair.to, to: pair.from, airlines: back ? [...back.airlines] : [...pair.airlines] };
    }).filter((pair) => pair.airlines.length);
  }

  // Whether anything is stored for an airline's route on a day (also an unpriced departure).
  const known = (airline, from, to, day) => fares.some((fare) => fare.airline === airline && fare.from === from && fare.to === to && fare.day === day);
  return { addLive, cheapest, importRows, known, load, mergeRows, network: () => network, networkIsStale, options, pairsFor, refresh, returnPairs, saveNetwork, search, start, stop, sync, tripPairs };
}

module.exports = { WINDOW_DAYS, createFlightStore, withDepartureTimes, withFlightTime, routeClockDiffs, hoursFromPoland, inWindow, lastChange, normalizeFare, rankFares, readFareFile };
