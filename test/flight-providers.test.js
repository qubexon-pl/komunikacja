"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { apishFares, createDuffel, createLiveFlightSearch, createRates, duffelFares } = require("../src/flight-providers");
const { createFlightStore } = require("../src/flights");
const { createServer } = require("../src/server");

const toPln = async (amount, currency) => (currency === "EUR" ? Number(amount) * 4.25 : Number(amount));
const segment = (from, to, dep, arr, code, number) => ({ origin: { iata_code: from }, destination: { iata_code: to }, departing_at: dep, arriving_at: arr, marketing_carrier: { iata_code: code, name: code === "LO" ? "LOT" : code }, marketing_carrier_flight_number: number });

test("a Duffel offer becomes one fare with its changes, priced in PLN", async () => {
  const offers = [
    { total_amount: "120.00", total_currency: "EUR", owner: { iata_code: "LO", name: "LOT" }, slices: [{ segments: [segment("RZE", "WAW", "2026-11-16T06:00:00", "2026-11-16T07:00:00", "LO", "3802"), segment("WAW", "MXP", "2026-11-16T08:30:00", "2026-11-16T10:40:00", "LO", "319")] }] },
    { total_amount: "999", total_currency: "PLN", slices: [{ segments: [segment("RZE", "A", "x", "x", "LO", "1"), segment("A", "B", "x", "x", "LO", "2"), segment("B", "C", "x", "x", "LO", "3"), segment("C", "MXP", "x", "x", "LO", "4")] }] },
  ];
  const [fare, tooMany] = await duffelFares(offers, toPln);
  assert.equal(tooMany, null);
  assert.deepEqual(fare, { airline: "LO", airlineName: "LOT", from: "RZE", to: "MXP", day: "2026-11-16", departure: "2026-11-16T06:00", arrival: "2026-11-16T10:40", flightNumber: "LO3802 + LO319", stops: 1, via: ["WAW"], price: 120, currency: "EUR", pricePln: 510, priceType: "exact", source: "duffel" });
});

test("the Duffel request asks for one adult in economy on one day with at most two changes", async () => {
  let sent;
  const duffel = createDuffel({ token: "duffel_test_x", toPln, fetchSource: async (url, init) => { sent = { url: String(url), init }; return new Response(JSON.stringify({ data: { offers: [] } })); } });
  assert.deepEqual(await duffel.search({ from: "RZE", to: "BGY", day: "2026-11-16" }), []);
  assert.match(sent.url, /\/air\/offer_requests\?return_offers=true/);
  assert.equal(sent.init.headers.Authorization, "Bearer duffel_test_x");
  assert.equal(sent.init.headers["Duffel-Version"], "v2");
  assert.deepEqual(JSON.parse(sent.init.body).data, { slices: [{ origin: "RZE", destination: "BGY", departure_date: "2026-11-16" }], passengers: [{ type: "adult" }], cabin_class: "economy", max_connections: 2 });
});

test("an API.SH day gives one Wizz Air list price per departure time", async () => {
  const fares = await apishFares({ days: [{ date: "2026-11-16", price: { amount: 189, currency: "PLN" }, departures: ["06:20", "2026-11-16T18:05:00"] }] }, "KTW", "BGY", toPln);
  assert.deepEqual(fares.map((f) => [f.airline, f.departure, f.pricePln, f.priceType]), [["WIZZ", "2026-11-16T06:20", 189, "list"], ["WIZZ", "2026-11-16T18:05", 189, "list"]]);
});

test("prices are converted with the NBP rate table, loaded once", async () => {
  let calls = 0;
  const rates = createRates({ fetchSource: async () => { calls += 1; return new Response(JSON.stringify([{ rates: [{ code: "EUR", mid: 4.2 }, { code: "GBP", mid: 5 }] }])); } });
  assert.equal(await rates(100, "EUR"), 420);
  assert.equal(await rates(10, "GBP"), 50);
  assert.equal(await rates(10, "PLN"), 10);
  assert.equal(await rates(10, "XXX"), null);
  assert.equal(calls, 1);
});

test("a trip search asks every provider about nearby airports both ways, keeps the answers and does not ask twice", async () => {
  const asked = [];
  const provider = { name: "fake", search: async (s) => { asked.push(`${s.from}-${s.to} ${s.day}`); return s.from === "RZE" ? [{ airline: "LO", airlineName: "LOT", from: s.from, to: s.to, day: s.day, departure: `${s.day}T06:00`, price: 400, currency: "PLN", pricePln: 400, stops: 1, via: ["WAW"], source: "fake" }] : []; } };
  const store = createFlightStore({ database: { readFares: async () => [], replaceFares: async () => {} }, now: () => new Date("2026-11-05T10:00:00Z") });
  const live = createLiveFlightSearch({ providers: [provider], flights: store });
  const trip = { origin: { lat: 50.04, lon: 22.0 }, dest: { lat: 45.67, lon: 9.7 }, date: "2026-11-16", back: "2026-11-23" };
  assert.equal(live.request(trip, { scope: "trip" }), "started");
  assert.equal(live.request(trip, { scope: "trip" }), "busy");
  while (live.status().running) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(asked.length, 12); // 3 origins x 2 destinations, out and back
  assert.ok(asked.includes("RZE-BGY 2026-11-16") && asked.includes("BGY-RZE 2026-11-23"));
  const { options } = store.options({ ...trip, back: "" });
  assert.equal(options[0].airlineName, "LOT");
  assert.deepEqual([options[0].stops, options[0].via], [1, ["WAW"]]);
  assert.equal(live.request(trip, { scope: "trip" }), "fresh");
});

test("without the tracker a trip search still starts the official APIs", async (t) => {
  const started = [];
  const liveSearch = { request: (trip) => { started.push(trip); return "started"; }, status: () => ({ available: true, running: true }) };
  const server = createServer({
    database: {},
    auth: { resolveSession: async (token) => (token === "rider" ? { id: "3", email: "rider@example.invalid" } : null) },
    flights: { tripPairs: () => [] },
    liveSearch,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const response = await fetch(`${base}/api/flights/trip`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base, Cookie: "rzbus_session=rider" }, body: JSON.stringify({ origin: "50.04,22.00", dest: "45.67,9.70", date: day(7), back: "" }) });
  assert.equal(response.status, 202);
  assert.equal(started.length, 1);
  const status = await (await fetch(`${base}/api/flights/status`)).json();
  assert.deepEqual([status.available, status.running, status.apis.running, status.tracker.available], [true, true, true, false]);
});
