"use strict";

// Wizz Air timetable (be.wizzair.com …/Api/search/timetableV2), for the owner's personal, non-commercial testing.
// Kept deliberately polite: the app's own User-Agent (no copied browser headers, no tokens), one request at a
// time with a gap, each route and date range asked again only after some hours, and a pause of an hour after
// HTTP 429 or 403 without retrying. If Wizz Air refuses, the error is reported and nothing tries to get around it.

const { parseWizzResponses } = require("./wizz-import");

const DEFAULT_VERSION = "29.24.0";
const GAP_MS = 4000;
const PAUSE_MS = 60 * 60 * 1000;
const FRESH_MS = 3 * 60 * 60 * 1000;
const TIME_FRESH_MS = 30 * 60 * 1000;
const RANGE_DAYS = 14;
const MAX_ROUTES = 3;
const USER_AGENT = "komunikacja-rzeszow/1.0 (personal trip planner test)";
const IATA = /^[A-Z]{3}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const addDays = (day, days) => new Date(Date.parse(`${day}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const pad = (n) => String(n).padStart(2, "0");
// "2026-11-15T15:25" moved by minutes, written the way the timetable wants it: "2026-11-15 15:20:00".
function shiftTime(stamp, minutes) {
  const date = new Date(`${stamp}:00Z`);
  date.setUTCMinutes(date.getUTCMinutes() + minutes);
  return `${date.toISOString().slice(0, 10)} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:00`;
}

function timetableBody(legs) {
  return {
    flightList: legs.map((leg) => ({ departureStation: leg.from, arrivalStation: leg.to, from: leg.start, to: leg.end })),
    priceType: "regular",
    adultCount: 1,
    childCount: 0,
    infantCount: 0,
  };
}

function createWizzTimetable({ flights, toPln, fetchSource = fetch, version = process.env.WIZZ_API_VERSION || DEFAULT_VERSION, enabled = process.env.WIZZ_API !== "off", now = Date.now, gapMs = GAP_MS }) {
  const url = `https://be.wizzair.com/${version}/Api/search/timetableV2`;
  const asked = new Map();
  let queue = Promise.resolve();
  let lastCall = 0;
  let pausedUntil = 0;
  let running = 0;
  let last = { at: null, ok: null, error: null, stored: 0 };

  async function post(legs) {
    if (now() < pausedUntil) throw Object.assign(new Error("Wizz Air poprosił o przerwę; kolejne zapytanie za godzinę."), { status: 429 });
    const wait = lastCall + gapMs - now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastCall = now();
    const response = await fetchSource(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify(timetableBody(legs)),
      signal: AbortSignal.timeout(30000),
    });
    if (response.status === 429 || response.status === 403) {
      pausedUntil = now() + PAUSE_MS;
      throw Object.assign(new Error(`Wizz Air odmówił (HTTP ${response.status}). Przerwa na godzinę, bez ponawiania.`), { status: response.status });
    }
    if (response.status === 404) throw Object.assign(new Error(`Wizz Air nie zna wersji API ${version} (HTTP 404). Ustaw WIZZ_API_VERSION.`), { status: 502 });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
      throw Object.assign(new Error(`Wizz Air zwrócił HTTP ${response.status}.`), { status: 502, detail });
    }
    return response.json();
  }

  // One request at a time; each answer is priced in PLN and stored (fares and the price history).
  function run(legs, merge) {
    const job = queue.then(async () => {
      running += 1;
      try {
        const data = await post(legs);
        const rows = parseWizzResponses([{ kind: "timetable", data }]).map((row) => ({ ...row, source: "wizz.api.timetable" }));
        const collectedAt = new Date(now()).toISOString();
        const priced = [];
        for (const row of rows) {
          const pricePln = await toPln(row.price, row.currency);
          if (pricePln) priced.push({ ...row, pricePln, collectedAt });
        }
        const result = await merge(priced);
        last = { at: collectedAt, ok: true, error: null, stored: result.stored };
        return { stored: result.stored, found: rows.length };
      } catch (error) {
        last = { at: new Date(now()).toISOString(), ok: false, error: error.message, detail: error.detail || null, stored: 0 };
        throw error;
      } finally {
        running -= 1;
      }
    });
    queue = job.catch(() => {});
    return job;
  }

  const fresh = (key, ms) => {
    const at = asked.get(key);
    if (at && now() - at < ms) return true;
    asked.set(key, now());
    return false;
  };

  // Cheapest price and every departure time for each day, two weeks either side of the chosen days.
  function searchRoutes(pairs, date, back = "") {
    if (!enabled) return "unavailable";
    const legs = [];
    for (const pair of pairs.filter((p) => IATA.test(p.from) && IATA.test(p.to)).slice(0, MAX_ROUTES)) {
      // Wizz Air refuses a range that starts in the past ("InvalidFromDate"), so a range begins today at the earliest.
      const today = new Date(now()).toISOString().slice(0, 10), from = (d) => (d < today ? today : d);
      const out = { from: pair.from, to: pair.to, start: from(addDays(date, -RANGE_DAYS)), end: addDays(date, RANGE_DAYS) };
      const home = back ? { from: pair.to, to: pair.from, start: from(addDays(back, -RANGE_DAYS)), end: addDays(back, RANGE_DAYS) } : null;
      if (!fresh(`${out.from}|${out.to}|${out.start}|${home ? home.start : ""}`, FRESH_MS)) legs.push([out, home].filter(Boolean));
    }
    if (!legs.length) return "fresh";
    for (const pairLegs of legs) run(pairLegs, (rows) => flights.mergeRows(rows)).catch((error) => console.error("Wizz timetable:", error.message));
    return "started";
  }

  // The price of one departure: a narrow time window around it, as the website does for a chosen flight.
  async function priceForTime({ from, to, time }) {
    if (!enabled) throw Object.assign(new Error("Zapytania do Wizz Air są wyłączone (WIZZ_API=off)."), { status: 503 });
    if (!IATA.test(from) || !IATA.test(to) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(time) || !DAY.test(time.slice(0, 10))) throw Object.assign(new Error("Nieprawidłowy lot."), { status: 400 });
    if (fresh(`${from}|${to}|${time}`, TIME_FRESH_MS)) return { stored: 0, found: 0, fresh: true };
    return run([{ from, to, start: shiftTime(time, -5), end: shiftTime(time, 35) }], (rows) => flights.mergeRows(rows.filter((row) => row.departure === time), { departures: true }));
  }

  function status() {
    return { available: enabled, running: running > 0, pausedUntil: pausedUntil > now() ? new Date(pausedUntil).toISOString() : null, ...last };
  }

  return { priceForTime, searchRoutes, status };
}

module.exports = { createWizzTimetable, shiftTime, timetableBody };
