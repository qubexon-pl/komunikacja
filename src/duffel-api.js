"use strict";

// Fares of the traditional airlines (LOT, Lufthansa, Swiss, SAS, KLM, Air France, easyJet and others) through the
// Duffel flights API, for European cities that Ryanair and Wizz Air do not fly to (or fly to from far away).
// It needs an access token: DUFFEL_ACCESS_TOKEN (a test token, duffel_test_…, returns Duffel's sample airline only).
// Without a token the source is off and the planner works as before.
//  - one-way searches for the chosen day of each direction, at most MAX_PAIRS routes from the nearest airports;
//  - a route and day is asked again only after 3 hours;
//  - on 429 a pause of one hour, on 401/403 the source stays off until the server restarts with a new token.
// Ryanair and Wizz Air offers are left out: the app asks those airlines itself (ryanair-api.js, wizz-timetable.js).
// The answers are kept in memory only (flights.addLive), for six hours, like any other live answer.

const OFFERS_URL = "https://api.duffel.com/air/offer_requests";
const API_VERSION = "v2";
const SUPPLIER_TIMEOUT_MS = 15000;
const FRESH_MS = 3 * 60 * 60 * 1000;
const PAUSE_MS = 60 * 60 * 1000;
const MAX_PAIRS = 4;
const MAX_OFFERS = 40;
const PARALLEL = 4;
const OWN_SOURCES = new Set(["FR", "RK", "MAY", "W6", "W4", "W9"]);
const IATA = /^[A-Z]{3}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const stamp = (value) => String(value || "").slice(0, 16);
const searchKey = (from, to, day) => `duffel|${from}|${to}|${day}`;

// One offer request's answer as fare rows: the cheapest offer of each flight (airline, departure and flight number).
function offersToRows(body, { from, to, day, collectedAt }) {
  const best = new Map();
  for (const offer of body?.data?.offers || []) {
    const owner = String(offer?.owner?.iata_code || "").toUpperCase();
    const slice = offer?.slices?.[0];
    const segments = slice?.segments || [];
    const price = Number(offer?.total_amount);
    if (!owner || OWN_SOURCES.has(owner) || !segments.length || !(price > 0)) continue;
    const first = segments[0], last = segments[segments.length - 1];
    if (String(first.departing_at || "").slice(0, 10) !== day) continue;
    const carrier = first.marketing_carrier?.iata_code || owner;
    const row = {
      airline: owner,
      airlineName: offer.owner?.name || owner,
      from: first.origin?.iata_code || from,
      to: last.destination?.iata_code || to,
      day,
      departure: stamp(first.departing_at),
      arrival: stamp(last.arriving_at),
      flightNumber: first.marketing_carrier_flight_number ? `${carrier} ${first.marketing_carrier_flight_number}` : null,
      price,
      currency: String(offer.total_currency || "EUR").toUpperCase(),
      stops: segments.length - 1,
      via: segments.slice(0, -1).map((segment) => segment.destination?.iata_code).filter(Boolean),
      priceType: "exact",
      source: "duffel.offers",
      collectedAt,
      searchKey: searchKey(from, to, day),
    };
    // A search for a city's airport answers for that airport only; an offer from a neighbouring one is another route.
    if (row.from !== from || row.to !== to) continue;
    const key = `${row.airline}|${row.departure}|${row.flightNumber || ""}|${row.stops}`;
    if (!best.has(key) || best.get(key).price > price) best.set(key, row);
  }
  return [...best.values()].sort((a, b) => a.price - b.price).slice(0, MAX_OFFERS);
}

function createDuffelApi({ flights, toPln, token = process.env.DUFFEL_ACCESS_TOKEN || "", fetchSource = fetch, now = Date.now }) {
  let enabled = Boolean(token);
  let pausedUntil = 0;
  let running = 0;
  let planned = 0, done = 0;
  let last = { at: null, ok: null, error: null, stored: 0 };
  const asked = new Map();

  async function request(leg) {
    const url = `${OFFERS_URL}?${new URLSearchParams({ return_offers: "true", supplier_timeout: String(SUPPLIER_TIMEOUT_MS) })}`;
    const response = await fetchSource(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Duffel-Version": API_VERSION,
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ data: {
        slices: [{ origin: leg.from, destination: leg.to, departure_date: leg.day }],
        passengers: [{ type: "adult" }],
        cabin_class: "economy",
        max_connections: 1,
      } }),
      signal: AbortSignal.timeout(SUPPLIER_TIMEOUT_MS + 15000),
    });
    if (response.status === 401 || response.status === 403) {
      enabled = false;
      throw Object.assign(new Error(`Duffel odrzucił klucz (HTTP ${response.status}). Sprawdź DUFFEL_ACCESS_TOKEN.`), { status: response.status });
    }
    if (response.status === 429) {
      pausedUntil = now() + PAUSE_MS;
      throw Object.assign(new Error("Duffel poprosił o przerwę (HTTP 429); kolejne zapytanie za godzinę."), { status: 429 });
    }
    if (!response.ok) throw Object.assign(new Error(`Duffel zwrócił HTTP ${response.status}.`), { status: 502 });
    return response.json();
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
    try {
      const body = await request(leg);
      return await priced(offersToRows(body, { ...leg, collectedAt: new Date(now()).toISOString() }));
    } finally {
      done += 1;
    }
  }

  const isFresh = (leg) => now() - (asked.get(searchKey(leg.from, leg.to, leg.day)) || 0) < FRESH_MS;

  // The chosen day of each direction for the given routes (pairs of airports); the answers replace earlier ones.
  function searchRoutes(pairs, date, back = "") {
    if (!enabled || now() < pausedUntil || !DAY.test(date) || (back && !DAY.test(back))) return "unavailable";
    const legs = [];
    for (const pair of pairs.filter((p) => IATA.test(p.from) && IATA.test(p.to) && p.from !== p.to).slice(0, MAX_PAIRS)) {
      legs.push({ from: pair.from, to: pair.to, day: date });
      if (back) legs.push({ from: pair.to, to: pair.from, day: back });
    }
    const wanted = legs.filter((leg) => !isFresh(leg));
    if (!wanted.length) return legs.length ? "fresh" : "unavailable";
    for (const leg of wanted) asked.set(searchKey(leg.from, leg.to, leg.day), now());
    if (asked.size > 20000) asked.clear();
    if (running === 0 && done >= planned) { planned = 0; done = 0; }
    planned += wanted.length;
    running += 1;
    (async () => {
      let stored = 0, error = null;
      for (let i = 0; i < wanted.length; i += PARALLEL) {
        const batch = wanted.slice(i, i + PARALLEL);
        const results = await Promise.allSettled(batch.map(fetchLeg));
        const rows = [], searched = [];
        results.forEach((result, k) => {
          if (result.status === "fulfilled") { rows.push(...result.value); searched.push(searchKey(batch[k].from, batch[k].to, batch[k].day)); }
          else { error = result.reason; asked.delete(searchKey(batch[k].from, batch[k].to, batch[k].day)); }
        });
        flights.addLive(rows, searched);
        stored += rows.length;
        if (error && (error.status === 401 || error.status === 403 || error.status === 429)) {
          const skipped = wanted.slice(i + PARALLEL);
          for (const leg of skipped) asked.delete(searchKey(leg.from, leg.to, leg.day));
          done += skipped.length;
          break;
        }
      }
      last = { at: new Date(now()).toISOString(), ok: !error, error: error ? error.message : null, stored };
      if (error) console.error("Duffel:", error.message);
    })().finally(() => { running -= 1; });
    return "started";
  }

  function status() {
    return { available: enabled, running: running > 0, pausedUntil: pausedUntil > now() ? new Date(pausedUntil).toISOString() : null, ...last, progress: { done: Math.min(done, planned), total: Math.max(planned, done) } };
  }

  return { searchRoutes, status };
}

module.exports = { createDuffelApi, offersToRows };
