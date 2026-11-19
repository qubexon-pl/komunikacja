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
const NO_MARKET_MS = 24 * 60 * 60 * 1000; // a route Wizz Air does not fly ("InvalidMarket") is not asked again for a day
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

// The API version is part of the address and changes when Wizz Air releases its website. The working one is
// remembered (readVersion/saveVersion, the database in production); when it answers 404, the next likely
// versions are tried, a few requests at most.
function nextVersions(version) {
  const [major, minor, patch] = String(version).split(".").map(Number);
  if (![major, minor, patch].every(Number.isInteger)) return [];
  return [`${major}.${minor}.${patch + 1}`, `${major}.${minor + 1}.0`, `${major}.${minor + 1}.1`, `${major}.${minor + 2}.0`, `${major}.${minor + 3}.0`, `${major + 1}.0.0`, `${major + 1}.1.0`, `${major}.${minor + 4}.0`];
}

function createWizzTimetable({ flights, toPln, fetchSource = fetch, version: initialVersion = process.env.WIZZ_API_VERSION || DEFAULT_VERSION, readVersion = async () => null, saveVersion = async () => {}, enabled = process.env.WIZZ_API !== "off", now = Date.now, gapMs = GAP_MS }) {
  let version = initialVersion;
  const urlOf = (v) => `https://be.wizzair.com/${v}/Api/search/timetableV2`;
  const asked = new Map();
  let queue = Promise.resolve();
  let lastCall = 0;
  let pausedUntil = 0;
  let running = 0;
  let last = { at: null, ok: null, error: null, stored: 0 };

  // Progress of the current checks: requests planned and done (shown as a progress bar while prices load).
  let planned = 0, done = 0;
  const plan = (n) => { if (running === 0 && done >= planned) { planned = 0; done = 0; } planned += n; };
  async function send(v, legs) {
    const wait = lastCall + gapMs - now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastCall = now();
    return fetchSource(urlOf(v), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify(timetableBody(legs)),
      signal: AbortSignal.timeout(30000),
    }).finally(() => { done += 1; });
  }

  // The remembered version is read once; searching for a working one happens only at start or after a 404.
  let loaded = null;
  const loadVersion = () => (loaded ||= readVersion().then((saved) => { if (saved) version = saved; }).catch(() => {}));
  let discovering = null;
  function discover(sample, failed = false) {
    if (!discovering) {
      discovering = (async () => {
        await loadVersion();
        const probe = sample || [{ from: "KRK", to: "BCN", start: new Date(now() + 86400000).toISOString().slice(0, 10), end: new Date(now() + 2 * 86400000).toISOString().slice(0, 10) }];
        for (const candidate of failed ? nextVersions(version) : [version, ...nextVersions(version)]) {
          const response = await send(candidate, probe);
          if (response.status === 429 || response.status === 403) { pausedUntil = now() + PAUSE_MS; break; }
          if (response.status !== 404) {
            if (candidate !== version) console.log(`Wizz Air API version: ${candidate}`);
            version = candidate;
            await saveVersion(candidate).catch(() => {});
            return version;
          }
        }
        throw Object.assign(new Error(`Nie udało się ustalić wersji API Wizz Air (ostatnia znana: ${version}).`), { status: 502 });
      })().finally(() => { discovering = null; });
    }
    return discovering;
  }

  async function post(legs) {
    if (now() < pausedUntil) throw Object.assign(new Error("Wizz Air poprosił o przerwę; kolejne zapytanie za godzinę."), { status: 429 });
    await loadVersion();
    let response = await send(version, legs);
    // A new release moves the API: find the new version once and repeat this request.
    if (response.status === 404) {
      const before = version;
      await discover(legs, true).catch(() => {});
      if (version !== before) response = await send(version, legs);
    }
    if (response.status === 429 || response.status === 403) {
      pausedUntil = now() + PAUSE_MS;
      throw Object.assign(new Error(`Wizz Air odmówił (HTTP ${response.status}). Przerwa na godzinę, bez ponawiania.`), { status: response.status });
    }
    if (response.status === 404) throw Object.assign(new Error(`Wizz Air nie zna wersji API ${version} (HTTP 404).`), { status: 502 });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
      throw Object.assign(new Error(`Wizz Air zwrócił HTTP ${response.status}.`), { status: 502, detail });
    }
    return response.json();
  }

  // One request at a time; each answer is priced in PLN and stored (fares and the price history).
  function run(legs, merge, source = "wizz.api.timetable") {
    plan(1);
    const job = queue.then(async () => {
      running += 1;
      try {
        const data = await post(legs);
        const rows = parseWizzResponses([{ kind: "timetable", data }]).map((row) => ({ ...row, source }));
        const collectedAt = new Date(now()).toISOString();
        const priced = [];
        for (const row of rows) {
          const pricePln = await toPln(row.price, row.currency);
          if (pricePln) priced.push({ ...row, pricePln, collectedAt });
        }
        const result = await merge(priced, rows);
        last = { at: collectedAt, ok: true, error: null, stored: result.stored };
        return { ...result, stored: result.stored, found: rows.length };
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

  // Each answer covers two weeks of days. A chosen day is asked again only when the last answer that covered it
  // is more than 3 hours old, so picking another day nearby uses what is known and an old day is refreshed.
  const covered = new Map();
  const noMarket = new Map();
  const flown = (from, to) => now() - (noMarket.get(`${from}|${to}`) || -Infinity) >= NO_MARKET_MS;
  const dayKey = (from, to, day) => `${from}|${to}|${day}`;
  const isFresh = (from, to, day) => now() - (covered.get(dayKey(from, to, day)) || 0) < FRESH_MS;
  function cover(leg) {
    for (let day = leg.start; day <= leg.end; day = addDays(day, 1)) covered.set(dayKey(leg.from, leg.to, day), now());
    if (covered.size > 50000) covered.clear();
  }

  // Cheapest price and every departure time for each day, two weeks either side of the chosen days.
  function searchRoutes(pairs, date, back = "") {
    if (!enabled) return "unavailable";
    const legs = [];
    for (const pair of pairs.filter((p) => IATA.test(p.from) && IATA.test(p.to) && flown(p.from, p.to)).slice(0, MAX_ROUTES)) {
      // Wizz Air refuses a range that starts in the past ("InvalidFromDate"), so a range begins today at the earliest.
      const today = new Date(now()).toISOString().slice(0, 10), from = (d) => (d < today ? today : d);
      const out = { from: pair.from, to: pair.to, start: from(addDays(date, -RANGE_DAYS)), end: addDays(date, RANGE_DAYS) };
      const home = back ? { from: pair.to, to: pair.from, start: from(addDays(back, -RANGE_DAYS)), end: addDays(back, RANGE_DAYS) } : null;
      const wanted = [isFresh(out.from, out.to, date) ? null : out, home && !isFresh(home.from, home.to, back) ? home : null].filter(Boolean);
      if (!wanted.length) continue;
      wanted.forEach(cover);
      legs.push(wanted);
    }
    if (!legs.length) return "fresh";
    for (const pairLegs of legs) {
      // Days of the asked range without any flight in the answer have none (or none on sale): stored prices for them go.
      const clear = (rows) => pairLegs.flatMap((leg) => {
        const out = [];
        for (let day = leg.start; day <= leg.end; day = addDays(day, 1)) if (!rows.some((r) => r.from === leg.from && r.to === leg.to && r.day === day)) out.push({ airline: "WIZZ", from: leg.from, to: leg.to, day });
        return out;
      });
      run(pairLegs, (priced, rows) => flights.mergeRows(priced, { clear: clear(rows) })).catch((error) => {
        const route = pairLegs.map((leg) => `${leg.from}-${leg.to}`).join(", ");
        if (/InvalidMarket/.test(error.detail || "")) { for (const leg of pairLegs) noMarket.set(`${leg.from}|${leg.to}`, now()); console.warn(`Wizz timetable: Wizz Air nie lata na trasie ${route}; nie pytamy o nią przez dobę.`); return; }
        console.error("Wizz timetable:", route, error.message, error.detail || "");
      });
    }
    return "started";
  }

  // Days of a scrolled date strip that have no stored price: one timetable request per route covers them.
  function fillRange(legs, hasDay = () => false) {
    if (!enabled) return "unavailable";
    const today = new Date(now()).toISOString().slice(0, 10);
    let started = false;
    for (const leg of legs.filter((l) => IATA.test(l.from) && IATA.test(l.to) && flown(l.from, l.to)).slice(0, MAX_ROUTES * 2)) {
      const missing = [];
      for (let day = leg.start < today ? today : leg.start; day <= leg.end; day = addDays(day, 1)) if (!isFresh(leg.from, leg.to, day) && !hasDay("WIZZ", leg.from, leg.to, day)) missing.push(day);
      if (!missing.length) continue;
      const one = { from: leg.from, to: leg.to, start: missing[0], end: missing.at(-1) };
      cover(one);
      started = true;
      const clear = (rows) => {
        const out = [];
        for (let day = one.start; day <= one.end; day = addDays(day, 1)) if (!rows.some((r) => r.from === one.from && r.to === one.to && r.day === day)) out.push({ airline: "WIZZ", from: one.from, to: one.to, day });
        return out;
      };
      run([one], (priced, rows) => flights.mergeRows(priced, { clear: clear(rows) })).catch((error) => {
        if (/InvalidMarket/.test(error.detail || "")) { noMarket.set(`${one.from}|${one.to}`, now()); return; }
        console.error("Wizz timetable:", `${one.from}-${one.to}`, error.message, error.detail || "");
      });
    }
    return started ? "started" : "fresh";
  }

  // The price of one departure: a narrow time window around it, as the website does for a chosen flight.
  async function priceForTime({ from, to, time }) {
    if (!enabled) throw Object.assign(new Error("Zapytania do Wizz Air są wyłączone (WIZZ_API=off)."), { status: 503 });
    if (!IATA.test(from) || !IATA.test(to) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(time) || !DAY.test(time.slice(0, 10))) throw Object.assign(new Error("Nieprawidłowy lot."), { status: 400 });
    if (fresh(`${from}|${to}|${time}`, TIME_FRESH_MS)) return { stored: 0, found: 0, fresh: true };
    return run([{ from, to, start: shiftTime(time, -5), end: shiftTime(time, 35) }], (rows) => {
      const sameDay = rows.filter((row) => row.from === from && row.to === to && row.departure && row.day === time.slice(0, 10));
      const hit = sameDay.find((row) => row.departure === time);
      const own = hit && (hit.priceType === "exact" || sameDay.length === 1);
      // The departure is gone from the answer: not on sale any more, so its stored price goes.
      if (!hit) return flights.mergeRows([], { drop: [{ airline: "WIZZ", from, to, day: time.slice(0, 10), departure: time }] }).then((r) => ({ ...r, unsold: true }));
      return flights.mergeRows(own ? [{ ...hit, priceType: "exact" }] : [], { departures: true });
    }, "wizz.api.time");
  }

  // The first flight on each route after a day, up to a year ahead: the timetable in 30-day steps (one request each),
  // stopping at the first step with a flight. Every step's answer is stored like a normal search. Once a day per route.
  const scannedFirst = new Map();
  let scanning = 0;
  function findFirst(pairs, after) {
    if (!enabled || now() < pausedUntil) return "unavailable";
    const today = new Date(now()).toISOString().slice(0, 10);
    const list = pairs.filter((p) => IATA.test(p.from) && IATA.test(p.to) && flown(p.from, p.to)).slice(0, MAX_ROUTES)
      .filter((p) => now() - (scannedFirst.get(`${p.from}|${p.to}|${after}`) || 0) >= 24 * 60 * 60 * 1000);
    if (!list.length) return "fresh";
    for (const p of list) scannedFirst.set(`${p.from}|${p.to}|${after}`, now());
    if (scannedFirst.size > 5000) scannedFirst.clear();
    scanning += 1;
    (async () => {
      try {
        for (const pair of list) {
          let start = after < today ? today : after;
          for (let i = 0; i < 13; i += 1) {
            const one = { from: pair.from, to: pair.to, start, end: addDays(start, 29) };
            cover(one);
            const clear = (rows) => {
              const out = [];
              for (let day = one.start; day <= one.end; day = addDays(day, 1)) if (!rows.some((r) => r.from === one.from && r.to === one.to && r.day === day)) out.push({ airline: "WIZZ", from: one.from, to: one.to, day });
              return out;
            };
            const result = await run([one], (priced, rows) => flights.mergeRows(priced, { clear: clear(rows) }), "wizz.api.first");
            if (result.found > 0) break;
            start = addDays(one.end, 1);
          }
        }
      } catch (error) {
        if (/InvalidMarket/.test(error.detail || "")) return;
        console.error("Wizz timetable (first flight):", error.message, error.detail || "");
      } finally {
        scanning -= 1;
      }
    })();
    return "started";
  }

  function status() {
    return { version, available: enabled, running: running > 0 || scanning > 0, pausedUntil: pausedUntil > now() ? new Date(pausedUntil).toISOString() : null, ...last, progress: { done: Math.min(done, planned), total: Math.max(planned, done) } };
  }

  // Called at server start, so the first trip search already knows the version.
  function start() { if (enabled) discover().catch((error) => console.error("Wizz Air:", error.message)); }

  // Every Wizz Air airport with its direct connections (the route list): one GET on the same API, with the same
  // User-Agent, gap and pause rules. Asked only when the stored route list is a week old.
  async function readMap() {
    if (!enabled) throw new Error("Wizz Air API is turned off (WIZZ_API=off).");
    if (pausedUntil > now()) throw new Error("Wizz Air API is paused after a refusal.");
    await loadVersion();
    const wait = lastCall + gapMs - now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastCall = now();
    const response = await fetchSource(`https://be.wizzair.com/${version}/Api/asset/map?languageCode=pl-pl`, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(30000),
    });
    if (response.status === 429 || response.status === 403) { pausedUntil = now() + PAUSE_MS; throw new Error(`Wizz Air refused the route map (HTTP ${response.status}); paused for an hour.`); }
    if (response.status === 404) { discover(null, true).catch(() => {}); throw new Error("Wizz Air API version changed; the route map is asked again next time."); }
    if (!response.ok) throw new Error(`Wizz Air route map: HTTP ${response.status}.`);
    return response.json();
  }

  return { fillRange, findFirst, priceForTime, readMap, searchRoutes, start, status };
}

module.exports = { createWizzTimetable, nextVersions, shiftTime, timetableBody };
