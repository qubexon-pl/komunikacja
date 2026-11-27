"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { createServer } = require("../src/server");
const { listCities, findCity, listProviders, cityCapabilities, journeyFromTransitous, CAPABILITIES } = require("../src/transport");
const { CITIES } = require("../src/pl-cities");

test("every city is listed once, Rzeszów first, with its providers and joined capabilities", () => {
  const cities = listCities();
  assert.equal(cities.length, CITIES.length + 1);
  assert.equal(new Set(cities.map((c) => c.id)).size, cities.length);
  const rze = cities[0];
  assert.equal(rze.id, "rzeszow");
  assert.deepEqual(rze.providers.map((p) => p.id), ["rzeszow-gtfs", "pkp-plk"]);
  assert.equal(rze.capabilities.vehicles, "live");
  assert.equal(rze.capabilities.fares, true);
  for (const c of cities) {
    assert.deepEqual(Object.keys(c.capabilities).sort(), [...CAPABILITIES].sort());
    assert.equal(c.zone, "Europe/Warsaw");
    assert.ok(Array.isArray(c.centre) && c.centre.length === 2);
  }
});

test("Transitous cities are live only where the operator publishes real-time data, and never show fares", () => {
  const live = CITIES.find((c) => c.live), scheduled = CITIES.find((c) => !c.live);
  const a = findCity(live.id), b = findCity(scheduled.id);
  assert.equal(a.capabilities.realtime, true);
  assert.equal(a.capabilities.vehicles, "live");
  assert.equal(b.capabilities.realtime, false);
  assert.equal(b.capabilities.vehicles, "scheduled");
  assert.equal(a.capabilities.fares, false);
  assert.equal(findCity("atlantis"), null);
});

test("capabilities join: any provider enables a feature, live vehicles beat scheduled ones", () => {
  const p = (capabilities) => ({ capabilities });
  const out = cityCapabilities([p({ plan: true, vehicles: "scheduled" }), p({ departures: true, vehicles: "live" })]);
  assert.equal(out.plan, true);
  assert.equal(out.departures, true);
  assert.equal(out.vehicles, "live");
  assert.equal(out.fares, false);
  assert.equal(cityCapabilities([]).vehicles, false);
});

test("provider descriptions are copies, so a caller cannot change them for everyone", () => {
  listProviders()[0].capabilities.plan = "changed";
  assert.equal(listProviders()[0].capabilities.plan, true);
});

test("a Transitous itinerary becomes a journey: walks have no real-time state, delays only for live legs, no fares", () => {
  const it = {
    dep: { clock: "2026-12-01T08:00" }, arr: { clock: "2026-12-01T08:40" }, minutes: 40, transfers: 1, walkMin: 6,
    steps: [
      { kind: "walk", line: "", from: "Home", to: "Stop A", dep: "08:00", arr: "08:04", minutes: 4, live: false, delayMin: 0 },
      { kind: "tram", line: "4", agency: "MPK", from: "Stop A", to: "Stop B", dep: "08:05", arr: "08:20", minutes: 15, live: true, delayMin: 2, color: "#e00000", stops: 7 },
      { kind: "subway", line: "M1", from: "Stop B", to: "Stop C", dep: "08:25", arr: "08:38", minutes: 13, live: false, delayMin: 5 },
    ],
  };
  const j = journeyFromTransitous(it, { fetchedAt: 1 });
  assert.equal(j.provider, "transitous");
  assert.equal(j.fare, null);
  assert.deepEqual(j.legs.map((l) => l.mode), ["walk", "tram", "metro"]);
  assert.deepEqual(j.legs.map((l) => l.realtime), [null, "live", "scheduled"]);
  assert.deepEqual(j.legs.map((l) => l.delayMin), [0, 2, 0]); // a scheduled leg never shows a delay
  assert.ok(j.legs.every((l) => l.fare === null));
});

test("GET /api/transport/cities, /cities/:id and /providers", async (t) => {
  const server = createServer({ database: {}, auth: { resolveSession: async () => null } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/transport`;
  const list = await (await fetch(`${base}/cities`)).json();
  assert.equal(list.cities[0].id, "rzeszow");
  const one = await fetch(`${base}/cities/krakow`);
  assert.equal(one.status, 200);
  assert.equal((await one.json()).city.name, "Kraków");
  const none = await fetch(`${base}/cities/nowhere`);
  assert.equal(none.status, 404);
  const providers = await (await fetch(`${base}/providers`)).json();
  assert.deepEqual(providers.providers.map((p) => p.id).sort(), ["airport-transfers", "pkp-plk", "rzeszow-gtfs", "transitous"]);
});
