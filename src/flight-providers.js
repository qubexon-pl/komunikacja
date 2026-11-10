"use strict";

// Flight data from official APIs, next to the flight-tracker:
//  - Duffel (DUFFEL_ACCESS_TOKEN): airlines selling through Duffel, also with changes.
//  - API.SH (APISH_KEY): Wizz Air's lowest fare of each day, a paid third-party API.
// Each search asks about one direction on one day. Results stay in memory for a few hours.

const { airportsNear } = require("./airports");

const DUFFEL_URL = "https://api.duffel.com/air/offer_requests?return_offers=true&supplier_timeout=20000";
const APISH_URL = "https://api.api.sh/wizzair/v1/fares";
const NBP_URL = "https://api.nbp.pl/api/exchangerates/tables/A/?format=json";
const RATES_TTL_MS = 12 * 60 * 60 * 1000;
const SEARCH_FRESH_MS = 6 * 60 * 60 * 1000;
const ORIGIN_KM = 600;
const DEST_KM = 200;
const ORIGINS = 3;
const DESTS = 2;
const MAX_STOPS = 2;
const CONCURRENCY = 3;

const clock = (value) => (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) ? value.slice(0, 16) : null);

// Prices come in the seller's currency; the app compares them in PLN using the NBP average rates.
function createRates({ fetchSource = fetch, now = Date.now } = {}) {
  let table = null;
  let loadedAt = 0;
  return async function toPln(amount, currency) {
    const value = Number(amount);
    if (!(value > 0) || !currency) return null;
    if (currency === "PLN") return value;
    if (!table || now() - loadedAt > RATES_TTL_MS) {
      const response = await fetchSource(NBP_URL, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(`NBP rates returned HTTP ${response.status}.`);
      const [body] = await response.json();
      table = new Map(body.rates.map((rate) => [rate.code, rate.mid]));
      loadedAt = now();
    }
    const rate = table.get(currency);
    return rate ? Math.round(value * rate * 100) / 100 : null;
  };
}

// One Duffel offer for one direction becomes one fare; its segments give the changes.
function duffelFares(offers, toPln) {
  return Promise.all(offers.map(async (offer) => {
    const segments = offer.slices?.[0]?.segments || [];
    if (!segments.length || segments.length - 1 > MAX_STOPS) return null;
    const first = segments[0];
    const last = segments[segments.length - 1];
    const carrier = (segment) => segment.marketing_carrier || segment.operating_carrier || {};
    const owner = offer.owner || carrier(first);
    return {
      airline: owner.iata_code || carrier(first).iata_code || "",
      airlineName: owner.name || carrier(first).name || "",
      from: first.origin?.iata_code,
      to: last.destination?.iata_code,
      day: String(first.departing_at || "").slice(0, 10),
      departure: clock(first.departing_at),
      arrival: clock(last.arriving_at),
      flightNumber: segments.map((s) => `${carrier(s).iata_code || ""}${s.marketing_carrier_flight_number || ""}`).join(" + "),
      stops: segments.length - 1,
      via: segments.slice(1).map((s) => s.origin?.iata_code).filter(Boolean),
      price: Number(offer.total_amount),
      currency: offer.total_currency,
      pricePln: await toPln(offer.total_amount, offer.total_currency),
      priceType: "exact",
      source: "duffel",
    };
  }));
}

function createDuffel({ token, fetchSource = fetch, toPln }) {
  return {
    name: "duffel",
    async search({ from, to, day }) {
      const response = await fetchSource(DUFFEL_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json", "Duffel-Version": "v2" },
        body: JSON.stringify({ data: { slices: [{ origin: from, destination: to, departure_date: day }], passengers: [{ type: "adult" }], cabin_class: "economy", max_connections: MAX_STOPS } }),
        signal: AbortSignal.timeout(45000),
      });
      if (!response.ok) throw new Error(`Duffel returned HTTP ${response.status}.`);
      const body = await response.json();
      return duffelFares(body.data?.offers || [], toPln);
    },
  };
}

// API.SH gives the lowest Wizz Air fare of each day with that day's departure times: a hint, not every seat.
function apishFares(body, from, to, toPln) {
  return Promise.all((body.days || []).flatMap((day) => {
    const amount = day.price?.amount;
    const currency = day.price?.currency;
    const times = day.departures?.length ? day.departures : [null];
    return times.map(async (time) => ({
      airline: "WIZZ",
      airlineName: "Wizz Air",
      from,
      to,
      day: day.date,
      departure: time ? clock(String(time).includes("T") ? String(time) : `${day.date}T${time}`) : null,
      arrival: null,
      flightNumber: null,
      stops: 0,
      price: Number(amount),
      currency,
      pricePln: await toPln(amount, currency),
      priceType: "list",
      source: "apish.wizz",
    }));
  }));
}

function createApishWizz({ key, fetchSource = fetch, toPln }) {
  return {
    name: "apish.wizz",
    async search({ from, to, day }) {
      const url = new URL(APISH_URL);
      url.search = new URLSearchParams({ from, to, date_from: day, date_to: day, adults: "1", children: "0", infants: "0", return: "0" });
      const response = await fetchSource(url, { headers: { "x-api-key": key }, signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error(`API.SH returned HTTP ${response.status}.`);
      return apishFares(await response.json(), from, to, toPln);
    },
  };
}

function providersFromEnv({ env = process.env, fetchSource = fetch } = {}) {
  const toPln = createRates({ fetchSource });
  const list = [];
  if (env.DUFFEL_ACCESS_TOKEN) list.push(createDuffel({ token: env.DUFFEL_ACCESS_TOKEN, fetchSource, toPln }));
  if (env.APISH_KEY) list.push(createApishWizz({ key: env.APISH_KEY, fetchSource, toPln }));
  return list;
}

async function inBatches(tasks, size) {
  const results = [];
  for (let i = 0; i < tasks.length; i += size) results.push(...(await Promise.allSettled(tasks.slice(i, i + size).map((task) => task()))));
  return results;
}

// A trip search asks each provider about the nearest airports on the way out and home, in the background.
function createLiveFlightSearch({ providers = [], flights, now = Date.now }) {
  let running = false;
  let last = { target: null, startedAt: null, finishedAt: null, error: null };
  const asked = new Map();

  function searches({ origin, dest, date, back }) {
    const origins = airportsNear(origin, ORIGIN_KM).slice(0, ORIGINS).map((a) => a.code);
    const dests = airportsNear(dest, DEST_KM).slice(0, DESTS).map((a) => a.code);
    const list = [];
    for (const provider of providers) {
      for (const from of origins) {
        for (const to of dests) {
          list.push({ provider, from, to, day: date });
          if (back) list.push({ provider, from: to, to: from, day: back });
        }
      }
    }
    const time = now();
    for (const [key, at] of asked) if (time - at >= SEARCH_FRESH_MS) asked.delete(key);
    return list.filter((s) => !asked.has(`${s.provider.name}|${s.from}|${s.to}|${s.day}`));
  }

  async function run(list, target) {
    running = true;
    last = { target, startedAt: new Date(now()).toISOString(), finishedAt: null, error: null };
    try {
      const outcomes = await inBatches(list.map((s) => () => s.provider.search(s)), CONCURRENCY);
      const found = [];
      const failed = [];
      outcomes.forEach((outcome, i) => {
        const s = list[i];
        if (outcome.status === "fulfilled") {
          asked.set(`${s.provider.name}|${s.from}|${s.to}|${s.day}`, now());
          found.push(...outcome.value.filter(Boolean).map((fare) => ({ ...fare, searchKey: `${s.provider.name}|${s.from}|${s.to}|${s.day}` })));
        } else failed.push(`${s.provider.name} ${s.from}-${s.to}: ${outcome.reason?.message}`);
      });
      flights.addLive(found, list.filter((s, i) => outcomes[i].status === "fulfilled").map((s) => `${s.provider.name}|${s.from}|${s.to}|${s.day}`));
      if (failed.length) console.error("Flight providers:", failed.slice(0, 5).join(" | "));
      if (failed.length === list.length) last.error = "Żaden dostawca lotów nie odpowiedział.";
    } catch (error) {
      last.error = error.message;
    } finally {
      last.finishedAt = new Date(now()).toISOString();
      running = false;
    }
  }

  function request(trip, target) {
    if (!providers.length) return "unavailable";
    if (running) return "busy";
    const list = searches(trip);
    if (!list.length) return "fresh";
    run(list, target);
    return "started";
  }

  function status() {
    return { available: providers.length > 0, running, ...last };
  }

  return { request, status, searches };
}

module.exports = { apishFares, createApishWizz, createDuffel, createLiveFlightSearch, createRates, duffelFares, providersFromEnv };
