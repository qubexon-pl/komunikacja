"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { AIRPORTS, BY_CODE, addAirports, airportLabel, airportsNear } = require("./airports");

const WINDOW_DAYS = 14;
// Airlines sell about a year ahead, and the planner plans that far.
const STORE_DAYS = 366;
const NETWORK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RETURNS = 5;
const STRIP_DAYS = 14;
const LIVE_TTL_MS = 6 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
// Far enough to reach Warsaw, Wrocław or Budapest when nothing nearer flies there; the cost of getting there is counted.
const ORIGIN_AIRPORT_KM = 600;
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

// A Wizz Air timetable knows every departure of a day but only the day's cheapest price, so a day becomes one
// fare at that price with all its departure times; the exact price of a chosen time comes from "update price".
function withDepartureTimes(fares) {
  const days = new Map();
  const out = [];
  for (const fare of fares) {
    if (fare.priceType !== "list") { out.push(fare); continue; }
    const key = `${fare.airline}|${fare.from}|${fare.to}|${fare.day}`;
    const day = days.get(key);
    if (!day) {
      const first = { ...fare, times: fare.departure ? [fare.departure] : [] };
      days.set(key, first);
      out.push(first);
      continue;
    }
    if (fare.departure && !day.times.includes(fare.departure)) day.times.push(fare.departure);
    if (fare.pricePln < day.pricePln) Object.assign(day, { price: fare.price, pricePln: fare.pricePln, currency: fare.currency });
  }
  for (const day of days.values()) {
    day.times.sort();
    day.departure = day.times[0] || null;
    if (!day.times.length) delete day.times;
  }
  return out;
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
  }).sort((a, b) => a.totalPln - b.totalPln || compareFares(a, b));
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

// Cheapest ticket for each departure day two weeks either side; a round trip keeps the same number of days away.
function dayPrices(outbound, returns, date, back) {
  const cheapest = (list) => {
    const byDay = new Map();
    for (const fare of list) byDay.set(fare.day, Math.min(byDay.get(fare.day) ?? Infinity, fare.pricePln));
    return byDay;
  };
  const out = cheapest(outbound);
  const ret = back ? cheapest(returns) : null;
  const away = back ? daysBetween(date, back) : 0;
  const days = [];
  for (let offset = -STRIP_DAYS; offset <= STRIP_DAYS; offset += 1) {
    const day = addDays(date, offset);
    const price = out.get(day);
    if (price == null) continue;
    const home = ret ? ret.get(addDays(day, away)) : 0;
    if (home != null) days.push({ day, cheapest: Math.round(price + home) });
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
  let live = [];
  const current = () => {
    const fresh = now().getTime() - LIVE_TTL_MS;
    live = live.filter((fare) => fare.collectedAt.getTime() >= fresh);
    return withDepartureTimes([...fares, ...live].filter((fare) => fare.day >= today()));
  };
  // Answers of the official APIs for one trip search: each search replaces what it found before.
  function addLive(rows, searched = []) {
    const done = new Set(searched);
    live = [...live.filter((fare) => !done.has(fare.searchKey)), ...rows.map(normalizeFare).filter(Boolean)];
    return live.length;
  }

  async function load() {
    const saved = await database.readNetwork?.();
    if (saved) useNetwork(saved);
    fares = (await database.readFares(today())).map(normalizeFare).filter(Boolean);
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

  async function importRows(rows) {
    const accepted = inWindow(rows, today());
    if (!accepted.length) return { received: rows.length, stored: 0 }; // an empty run must not wipe the flights we already have
    await database.replaceFares(accepted);
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
  function options({ origin, dest, date = "", back = "" }) {
    const originAirports = airportsNear(origin, ORIGIN_AIRPORT_KM);
    const destAirports = airportsNear(dest, DEST_AIRPORT_KM);
    const all = current();
    const day = date || today();
    const outbound = rankFares(all, originAirports, destAirports);
    const returns = back ? returnFares(all, destAirports, originAirports) : [];
    const onDay = outbound.filter((fare) => fare.day === day);
    // Without fares the planner still sketches the journey through the nearest airport that flies there.
    const pair = tripPairs({ origin, dest })[0];
    const suggested = pair && { from: originAirports.find((a) => a.code === pair.from), to: destAirports.find((a) => a.code === pair.to), airlines: pair.airlines };
    return {
      suggested: suggested?.from && suggested?.to ? suggested : null,
      options: (back ? pairReturns(onDay, returns, back) : onDay).slice(0, MAX_RESULTS),
      days: dayPrices(outbound, returns, day, back),
      originAirports: originAirports.slice(0, 3),
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
  function tripPairs({ origin, dest }) {
    const origins = airportsNear(origin, ORIGIN_AIRPORT_KM);
    const dests = new Set(airportsNear(dest, DEST_AIRPORT_KM).slice(0, 3).map((airport) => airport.code));
    if (!network.routes.length) {
      return origins.slice(0, 2).flatMap((airport) => [...dests].slice(0, 2).map((to) => ({ from: airport.code, to, airlines: ["RYANAIR", "WIZZ"] })));
    }
    const served = origins.filter((airport) => network.routes.some((route) => route.from === airport.code && dests.has(route.to))).slice(0, TRIP_ORIGINS);
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

  return { addLive, cheapest, importRows, load, network: () => network, networkIsStale, options, pairsFor, refresh, returnPairs, saveNetwork, search, start, stop, sync, tripPairs };
}

module.exports = { WINDOW_DAYS, createFlightStore, withDepartureTimes, inWindow, lastChange, normalizeFare, rankFares, readFareFile };
