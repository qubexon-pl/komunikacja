"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { once } = require("node:events");
const { createFlightStore } = require("../src/flights");
const { createDiscover, summarise } = require("../src/discover");
const { createServer } = require("../src/server");

const TODAY = "2026-11-05";
const RZESZOW = { lat: 50.04, lon: 22.0 };
const fare = (from, to, day, pricePln, over = {}) => ({ airline: "RYANAIR", from, to, day, departure: `${day}T10:00`, price: pricePln, currency: "PLN", pricePln, collectedAt: `${TODAY}T08:00:00Z`, ...over });

async function store(rows) {
  const database = { readFares: async () => rows, replaceFares: async () => {}, saveNetwork: async () => {} };
  const flights = createFlightStore({ database, now: () => new Date(`${TODAY}T10:00:00Z`) });
  await flights.load();
  return flights;
}

test("discover: the cheapest stored fare per destination city, within the window and radius", async () => {
  const flights = await store([
    fare("RZE", "STN", "2026-11-10", 120), fare("RZE", "LTN", "2026-11-12", 90), // two London airports: one city
    fare("KRK", "BCN", "2026-11-20", 150), fare("RZE", "BCN", "2026-11-21", 160),
    fare("RZE", "FCO", "2027-01-30", 50), // outside the window
    fare("WAW", "OSL", "2026-11-11", 40), // Warsaw is outside a 200 km radius
    fare("RZE", "DUB", "2026-11-11", 70, { priceType: "list" }), // only the day's lowest for one departure
  ]);
  const out = flights.discover({ origin: RZESZOW, radius: 200, from: "2026-11-06", to: "2026-11-30" });
  assert.deepEqual(out.destinations.map((d) => d.code), ["LTN", "BCN"]);
  const byCity = Object.fromEntries(out.destinations.map((d) => [d.code, d]));
  assert.deepEqual(byCity.LTN.alsoAirports, ["STN"], "London once, at its cheapest airport");
  assert.equal(byCity.BCN.outbound.from, "RZE"); // 150 zł from Kraków plus the drive there costs more than 160 zł from home
  assert.equal(byCity.LTN.flightPln, 90);
  assert.equal(byCity.LTN.days, 2); // a fare on two days, across both airports
  assert.ok(!byCity.FCO && !byCity.OSL && !byCity.DUB);
  assert.ok(byCity.LTN.groundPln > 0 && byCity.LTN.totalPln === byCity.LTN.flightPln + byCity.LTN.groundPln);
  assert.ok(out.destinations.every((d, i, a) => !i || a[i - 1].totalPln <= d.totalPln));
});

test("discover with nights: only destinations with a stored flight home on the right day", async () => {
  const flights = await store([
    fare("RZE", "STN", "2026-11-10", 120), fare("LTN", "RZE", "2026-11-13", 100), // home from the other London airport
    fare("RZE", "BCN", "2026-11-10", 60), fare("BCN", "RZE", "2026-11-14", 60), // home a day too late
  ]);
  const out = flights.discover({ origin: RZESZOW, from: "2026-11-06", to: "2026-11-30", nights: 3 });
  assert.deepEqual(out.destinations.map((d) => d.code), ["STN"]);
  assert.equal(out.destinations[0].ret.from, "LTN");
  assert.equal(out.destinations[0].flightPln, 220);
  assert.equal(out.destinations[0].ret.day, "2026-11-13");
});

test("discover adds the forecast only where one exists, and only the destination's coordinates", async () => {
  const asked = [];
  const weather = { forecast: async (q) => { asked.push(q); return q.from === "2026-11-10" ? { days: [{ day: "2026-11-10", min: 4.4, max: 9.6, rainChance: 40, code: 3 }] } : { days: [], availableFrom: "2026-12-14" }; } };
  const flights = { discover: () => ({ destinations: [
    { code: "STN", lat: 51.88, lon: 0.235, outbound: { day: "2026-11-10" }, ret: null },
    { code: "BCN", lat: 41.3, lon: 2.08, outbound: { day: "2026-12-29" }, ret: null },
  ] }) };
  const out = await createDiscover({ flights, weather }).discover({ origin: RZESZOW });
  assert.deepEqual(out.destinations[0].weather, { min: 4, max: 10, rainChance: 40, code: 3, days: 1 });
  assert.equal(out.destinations[1].weather, null);
  assert.equal(out.destinations[1].weatherFrom, "2026-12-14");
  assert.deepEqual(asked.map((q) => [q.lat, q.lon]), [[51.88, 0.235], [41.3, 2.08]]);
  assert.equal(summarise([]), null);
});

test("GET /api/discover validates its input and answers from the store", async () => {
  const flights = await store([fare("RZE", "STN", "2026-11-10", 120)]);
  const server = createServer({ database: {}, auth: { resolveSession: async () => null }, flights, tripWeather: { forecast: async () => ({ days: [] }) } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}/api/discover`;
  try {
    assert.equal((await fetch(base)).status, 400);
    assert.equal((await fetch(`${base}?origin=50.04,22&nights=99`)).status, 400);
    assert.equal((await fetch(`${base}?origin=50.04,22&from=bad`)).status, 400);
    const ok = await fetch(`${base}?origin=50.04,22&from=2026-11-06&to=2026-11-30`);
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.deepEqual(body.destinations.map((d) => d.code), ["STN"]);
    assert.equal(body.destinations[0].outbound.bookingUrl.startsWith("https://www.ryanair.com/"), true);
  } finally {
    server.close();
  }
});
