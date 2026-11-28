"use strict";

// Ryanair fares through its public fare finder and timetable, for personal non-commercial testing, in the same polite
// form as the Wizz Air timetable (wizz-timetable.js), so it runs anywhere — also on Azure — without the desktop tracker:
//  - the app's own User-Agent, no copied browser headers, cookies or tokens;
//  - one request at a time with a gap between them;
//  - a route and day is asked again after 30 minutes (each search and each scrolled date strip asks the API; only a
//    repeat within that time is answered from what the last request stored);
//  - on 403/409/429 a pause of one hour and no retry.
// Only endpoints that answer such an honest request are used: the fare finder (the cheapest price of each day, with
// that flight's time, and the price of one chosen departure) and the monthly timetable (every departure of a day).
// The booking availability API declines honest requests (HTTP 409) and is not used.
// To be replaced by an official fare API when one is integrated; RYANAIR_API=off turns it off.

const FARES_URL = "https://services-api.ryanair.com/farfnd/v4/oneWayFares";
const TIMETABLE_URL = "https://www.ryanair.com/api/timtbl/3/schedules";
const USER_AGENT = "komunikacja-rzeszow/1.0 (personal trip planner test)";
const GAP_MS = 4000;
const PAUSE_MS = 60 * 60 * 1000;
const FRESH_MS = 30 * 60 * 1000;
const TIME_FRESH_MS = 30 * 60 * 1000;
const RANGE_DAYS = 14;
const MAX_ROUTES = 3;
const IATA = /^[A-Z]{3}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

const addDays = (day, days) => new Date(Date.parse(`${day}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const shiftClock = (stamp, minutes) => new Date(Date.parse(`${stamp}:00Z`) + minutes * 60000).toISOString().slice(0, 16);
const monthsOf = (start, end) => {
  const out = [];
  for (let m = start.slice(0, 7); m <= end.slice(0, 7); m = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 1)).toISOString().slice(0, 7)) out.push(m);
  return out;
};

// One leg's rows: the cheapest flight of each day with its own price; the other departures of that day from the
// timetable as unpriced rows (shown with a "get price" button). Days without any priced flight are returned in `empty`.
function rowsOfLeg(leg, faresByDay, timetableByDay, collectedAt) {
  const rows = [], empty = [];
  for (let day = leg.start; day <= leg.end; day = addDays(day, 1)) {
    const fare = faresByDay.get(day), flights = timetableByDay?.get(day) || [];
    const price = fare && !fare.soldOut && !fare.unavailable && fare.price?.value > 0 ? fare.price : null;
    if (!price) { if (timetableByDay || fare) empty.push(day); continue; }
    const departure = String(fare.departureDate || "").slice(0, 16);
    const base = { airline: "RYANAIR", from: leg.from, to: leg.to, day, price: price.value, currency: price.currencyCode || "PLN", collectedAt };
    const match = flights.find((f) => `${day}T${f.departureTime}` === departure);
    rows.push({ ...base, departure, arrival: String(fare.arrivalDate || "").slice(0, 16) || null, flightNumber: match ? `FR ${match.number}` : null, priceType: "exact", source: "ryanair.api.fares" });
    for (const f of flights) {
      const dep = `${day}T${f.departureTime}`;
      if (dep === departure) continue;
      const arr = f.arrivalTime < f.departureTime ? `${addDays(day, 1)}T${f.arrivalTime}` : `${day}T${f.arrivalTime}`;
      rows.push({ ...base, departure: dep, arrival: arr, flightNumber: `FR ${f.number}`, priceType: "list", source: "ryanair.api.timetable" });
    }
  }
  return { rows, empty };
}

function createRyanairApi({ flights, toPln, fetchSource = fetch, enabled = process.env.RYANAIR_API !== "off", now = Date.now, gapMs = GAP_MS }) {
  let queue = Promise.resolve();
  let lastCall = 0;
  let pausedUntil = 0;
  let running = 0;
  let last = { at: null, ok: null, error: null, stored: 0 };
  const covered = new Map();
  const askedTimes = new Map();
  // Progress of the current checks: requests planned and done (shown as a progress bar while prices load).
  let planned = 0, done = 0;
  const plan = (n) => { if (running === 0 && done >= planned) { planned = 0; done = 0; } planned += n; };

  async function get(url) {
    if (now() < pausedUntil) throw Object.assign(new Error("Ryanair poprosił o przerwę; kolejne zapytanie za godzinę."), { status: 429 });
    const wait = lastCall + gapMs - now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastCall = now();
    const response = await fetchSource(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, signal: AbortSignal.timeout(20000) }).finally(() => { done += 1; });
    if ([403, 409, 429].includes(response.status)) {
      pausedUntil = now() + PAUSE_MS;
      throw Object.assign(new Error(`Ryanair odmówił (HTTP ${response.status}). Przerwa na godzinę, bez ponawiania.`), { status: response.status });
    }
    if (response.status === 404) return null; // no flights on this route that month
    if (!response.ok) throw Object.assign(new Error(`Ryanair zwrócił HTTP ${response.status}.`), { status: 502 });
    return response.json();
  }

  // One job at a time; its rows are priced in PLN and stored (fares and the price history).
  function run(job) {
    const done = queue.then(async () => {
      running += 1;
      try {
        const result = await job();
        last = { at: new Date(now()).toISOString(), ok: true, error: null, stored: result.stored };
        return result;
      } catch (error) {
        last = { at: new Date(now()).toISOString(), ok: false, error: error.message, stored: 0 };
        throw error;
      } finally {
        running -= 1;
      }
    });
    queue = done.catch(() => {});
    return done;
  }

  async function priced(rows) {
    const out = [];
    for (const row of rows) {
      const pricePln = row.currency === "PLN" ? row.price : await toPln(row.price, row.currency).catch(() => null);
      if (pricePln) out.push({ ...row, pricePln: Math.round(pricePln * 100) / 100 });
    }
    return out;
  }

  async function fetchLeg(leg) {
    const collectedAt = new Date(now()).toISOString();
    const faresByDay = new Map();
    let timetableByDay = new Map();
    for (const month of monthsOf(leg.start, leg.end)) {
      const fares = await get(`${FARES_URL}/${leg.from}/${leg.to}/cheapestPerDay?${new URLSearchParams({ outboundMonthOfDate: `${month}-01`, currency: "PLN" })}`);
      for (const fare of fares?.outbound?.fares || []) if (fare?.day) faresByDay.set(fare.day, fare);
      try {
        const table = await get(`${TIMETABLE_URL}/${leg.from}/${leg.to}/years/${month.slice(0, 4)}/months/${+month.slice(5, 7)}`);
        for (const d of table?.days || []) timetableByDay?.set(`${month}-${String(d.day).padStart(2, "0")}`, (d.flights || []).filter((f) => /^\d{2}:\d{2}$/.test(f.departureTime || "") && /^\d{2}:\d{2}$/.test(f.arrivalTime || "")));
      } catch (error) {
        if (error.status === 429 || error.status === 403 || error.status === 409) throw error;
        timetableByDay = null; // without the timetable only the cheapest flight of each day is known, and no day is cleared
      }
    }
    return rowsOfLeg(leg, faresByDay, timetableByDay, collectedAt);
  }

  const dayKey = (from, to, day) => `${from}|${to}|${day}`;
  const isFresh = (from, to, day) => now() - (covered.get(dayKey(from, to, day)) || 0) < FRESH_MS;
  function cover(leg) {
    for (let day = leg.start; day <= leg.end; day = addDays(day, 1)) covered.set(dayKey(leg.from, leg.to, day), now());
    if (covered.size > 50000) covered.clear();
  }
  // A leg whose request failed was not answered: its days must be asked again next time, not count as checked.
  function uncover(leg) {
    for (let day = leg.start; day <= leg.end; day = addDays(day, 1)) covered.delete(dayKey(leg.from, leg.to, day));
  }

  // Every day two weeks either side of the chosen days, for each route Ryanair flies (at most MAX_ROUTES).
  function searchRoutes(pairs, date, back = "") {
    if (!enabled) return "unavailable";
    if (now() < pausedUntil) return "unavailable";
    const today = new Date(now()).toISOString().slice(0, 10), from = (d) => (d < today ? today : d);
    const legs = [];
    for (const pair of pairs.filter((p) => IATA.test(p.from) && IATA.test(p.to)).slice(0, MAX_ROUTES)) {
      const out = { from: pair.from, to: pair.to, start: from(addDays(date, -RANGE_DAYS)), end: addDays(date, RANGE_DAYS) };
      const home = back ? { from: pair.to, to: pair.from, start: from(addDays(back, -RANGE_DAYS)), end: addDays(back, RANGE_DAYS) } : null;
      // A leg is asked again unless every one of its days was answered lately (not only the chosen day).
      const stale = (leg) => { for (let day = leg.start; day <= leg.end; day = addDays(day, 1)) if (!isFresh(leg.from, leg.to, day)) return true; return false; };
      if (stale(out)) legs.push(out);
      if (home && stale(home)) legs.push(home);
    }
    if (!legs.length) return "fresh";
    return fetchLegs(legs);
  }
  function fetchLegs(legs) {
    legs.forEach(cover);
    plan(legs.reduce((sum, leg) => sum + monthsOf(leg.start, leg.end).length * 2, 0));
    let answered = 0;
    run(async () => {
      let stored = 0;
      for (const leg of legs) {
        const { rows, empty } = await fetchLeg(leg);
        const result = await flights.mergeRows(await priced(rows), { clear: empty.map((day) => ({ airline: "RYANAIR", from: leg.from, to: leg.to, day })) });
        stored += result.stored;
        answered += 1;
      }
      return { stored };
    }).catch((error) => {
      legs.slice(answered).forEach(uncover);
      console.error("Ryanair:", error.message);
    });
    return "started";
  }

  // Days of a scrolled date strip: every day not answered in the last 30 minutes is asked for again, also a day with a
  // stored price (that price may be hours old); hasDay can narrow it to days with nothing stored.
  function fillRange(legs, hasDay = () => false) {
    if (!enabled || now() < pausedUntil) return "unavailable";
    const today = new Date(now()).toISOString().slice(0, 10);
    const wanted = [];
    for (const leg of legs.filter((l) => IATA.test(l.from) && IATA.test(l.to)).slice(0, MAX_ROUTES * 2)) {
      const missing = [];
      for (let day = leg.start < today ? today : leg.start; day <= leg.end; day = addDays(day, 1)) if (!isFresh(leg.from, leg.to, day) && !hasDay("RYANAIR", leg.from, leg.to, day)) missing.push(day);
      if (missing.length) wanted.push({ from: leg.from, to: leg.to, start: missing[0], end: missing.at(-1) });
    }
    return wanted.length ? fetchLegs(wanted) : "fresh";
  }

  // The price of one departure: the fare finder narrowed to a few minutes around it.
  async function priceForTime({ from, to, time }) {
    if (!enabled) throw Object.assign(new Error("Zapytania do Ryanair są wyłączone (RYANAIR_API=off)."), { status: 503 });
    if (!IATA.test(from) || !IATA.test(to) || !TIME.test(time)) throw Object.assign(new Error("Nieprawidłowy lot."), { status: 400 });
    const key = `${from}|${to}|${time}`;
    if (now() - (askedTimes.get(key) || 0) < TIME_FRESH_MS) return { stored: 0, found: 0, fresh: true };
    askedTimes.set(key, now());
    if (askedTimes.size > 20000) askedTimes.clear();
    plan(1);
    return run(async () => {
      const day = time.slice(0, 10), clock = (m) => shiftClock(time, m).slice(11, 16);
      const body = await get(`${FARES_URL}?${new URLSearchParams({ departureAirportIataCode: from, arrivalAirportIataCode: to, outboundDepartureDateFrom: day, outboundDepartureDateTo: day, outboundDepartureTimeFrom: clock(-5), outboundDepartureTimeTo: clock(5), currency: "PLN", market: "pl-pl" })}`);
      const hit = (body?.fares || []).map((f) => f.outbound).find((o) => String(o?.departureDate || "").slice(0, 16) === time && o.price?.value > 0);
      // Not offered any more (sold out, or sales closed): the old stored price must not stay on screen.
      if (!hit) { const r = await flights.mergeRows([], { drop: [{ airline: "RYANAIR", from, to, day, departure: time }] }); return { stored: 0, found: 0, unsold: true, removed: r.removed || 0 }; }
      const rows = await priced([{ airline: "RYANAIR", from, to, day, departure: time, arrival: String(hit.arrivalDate || "").slice(0, 16) || null,
        flightNumber: hit.flightNumber ? hit.flightNumber.replace(/^FR\s*/, "FR ") : null, price: hit.price.value, currency: hit.price.currencyCode || "PLN",
        priceType: "exact", source: "ryanair.api.time", collectedAt: new Date(now()).toISOString() }]);
      const result = await flights.mergeRows(rows, { departures: true });
      return { stored: result.stored, found: 1 };
    });
  }

  // The first flight on each route after a day, up to a year ahead, when the chosen days have none: month by month
  // through the fare calendar (one request a month), stopping at the first month with a flight. That month is then
  // stored like any search (fares and timetable), so the planner can offer the day. Each route is scanned once a day.
  const scanned = new Map();
  function findFirst(pairs, after) {
    if (!enabled || now() < pausedUntil) return "unavailable";
    const list = pairs.filter((p) => IATA.test(p.from) && IATA.test(p.to)).slice(0, MAX_ROUTES)
      .filter((p) => now() - (scanned.get(`${p.from}|${p.to}|${after}`) || 0) >= 24 * 60 * 60 * 1000);
    if (!list.length) return "fresh";
    for (const p of list) scanned.set(`${p.from}|${p.to}|${after}`, now());
    if (scanned.size > 5000) scanned.clear();
    plan(list.length);
    run(async () => {
      let stored = 0;
      for (const pair of list) {
        let month = after.slice(0, 7);
        for (let i = 0; i < 13; i += 1, month = addDays(`${month}-28`, 7).slice(0, 7)) {
          if (i) plan(1);
          const fares = await get(`${FARES_URL}/${pair.from}/${pair.to}/cheapestPerDay?${new URLSearchParams({ outboundMonthOfDate: `${month}-01`, currency: "PLN" })}`);
          const first = (fares?.outbound?.fares || []).filter((f) => f?.day >= after && !f.soldOut && !f.unavailable && f.price?.value > 0).map((f) => f.day).sort()[0];
          if (!first) continue;
          const monthEnd = addDays(`${addDays(`${month}-28`, 7).slice(0, 7)}-01`, -1);
          const leg = { from: pair.from, to: pair.to, start: first, end: addDays(first, 13) < monthEnd ? addDays(first, 13) : monthEnd };
          plan(2);
          cover(leg);
          const { rows, empty } = await fetchLeg(leg);
          stored += (await flights.mergeRows(await priced(rows), { clear: empty.map((day) => ({ airline: "RYANAIR", from: leg.from, to: leg.to, day })) })).stored;
          break;
        }
      }
      return { stored };
    }).catch((error) => console.error("Ryanair (first flight):", error.message));
    return "started";
  }

  function status() {
    return { available: enabled, running: running > 0, pausedUntil: pausedUntil > now() ? new Date(pausedUntil).toISOString() : null, ...last, progress: { done: Math.min(done, planned), total: Math.max(planned, done) } };
  }

  return { searchRoutes, fillRange, findFirst, priceForTime, status };
}

module.exports = { createRyanairApi, rowsOfLeg, monthsOf };
