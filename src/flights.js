"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { AIRPORTS, BY_CODE, addAirports, airportLabel, airportsNear } = require("./airports");

const WINDOW_DAYS = 14;
const STORE_DAYS = 90;
const NETWORK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RETURNS = 5;
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const ORIGIN_AIRPORT_KM = 350;
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
             f.flight_number AS flightNumber, f.price, f.currency, f.price_base AS pricePln, f.seats_left AS seatsLeft,
             f.source, f.collected_at AS collectedAt,
             CASE WHEN f.source = 'wizz.farechart' THEN 'list' ELSE 'exact' END AS priceType
      FROM fares f
      WHERE f.run_id = (SELECT MAX(x.run_id) FROM fares x
                        WHERE x.airline = f.airline AND x.from_airport = f.from_airport AND x.to_airport = f.to_airport AND x.day = f.day)
        AND f.base_currency = 'PLN'
        AND f.day BETWEEN ? AND ?
        AND NOT (f.source = 'wizz.farechart' AND EXISTS (
              SELECT 1 FROM fares s WHERE s.run_id = f.run_id AND s.source = 'wizz.search'
                AND s.from_airport = f.from_airport AND s.to_airport = f.to_airport AND s.day = f.day))
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

// The return counts the trip's days inclusively: leaving on the 1st for 3 days means the 3rd at the earliest.
function earliestReturn(day, stay) {
  return addDays(day, Math.max(stay, 1) - 1);
}

function pairReturns(outbound, fares, destAirports, originAirports, { stay, back }) {
  const dests = new Map(destAirports.map((airport) => [airport.code, airport]));
  const origins = new Map(originAirports.map((airport) => [airport.code, airport]));
  const candidates = fares.filter((fare) => dests.has(fare.from) && origins.has(fare.to));
  const trips = [];
  for (const out of outbound) {
    const first = [earliestReturn(out.day, stay), back].filter(Boolean).sort().pop();
    const returns = candidates
      .filter((fare) => fare.day >= first && !(fare.day === out.day && (!fare.departure || !out.arrival || fare.departure <= out.arrival)))
      .map((fare) => {
        const groundKm = Math.round((dests.get(fare.from).km + origins.get(fare.to).km) * ROAD_FACTOR);
        return { ...presentFare(fare), homeKm: Math.round(origins.get(fare.to).km * ROAD_FACTOR), totalPln: Math.round(fare.pricePln + groundKm * GROUND_PLN_PER_KM) };
      })
      .sort((a, b) => a.totalPln - b.totalPln || compareFares(a, b));
    if (returns.length) trips.push({ ...out, ret: returns[0], returns: returns.slice(0, MAX_RETURNS), totalPln: out.totalPln + returns[0].totalPln });
  }
  return trips.sort((a, b) => a.totalPln - b.totalPln || compareFares(a, b));
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
  const current = () => fares.filter((fare) => fare.day >= today());

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
    const found = all.filter((fare) => (!from || fare.from === from) && (!to || fare.to === to) && (!date || fare.day === date)).sort(compareFares);
    const stamps = all.map((fare) => fare.collectedAt.getTime());
    return {
      flights: found.slice(0, MAX_RESULTS).map(presentFare),
      total: found.length,
      collectedAt: stamps.length ? new Date(Math.max(...stamps)).toISOString() : null,
      ...summarize(all),
    };
  }

  function options({ origin, dest, date = "", stay = 0, back = "" }) {
    const originAirports = airportsNear(origin, ORIGIN_AIRPORT_KM);
    const destAirports = airportsNear(dest, DEST_AIRPORT_KM);
    const all = current();
    const outbound = rankFares(all.filter((fare) => !date || fare.day >= date), originAirports, destAirports);
    return {
      options: (stay ? pairReturns(outbound, all, destAirports, originAirports, { stay, back }) : outbound).slice(0, MAX_RESULTS),
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

  return { importRows, load, network: () => network, networkIsStale, options, pairsFor, refresh, saveNetwork, search, start, stop, sync };
}

module.exports = { WINDOW_DAYS, createFlightStore, earliestReturn, inWindow, lastChange, normalizeFare, rankFares, readFareFile };
