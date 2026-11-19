"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createDuffelApi, offersToRows } = require("../src/duffel-api");
const { createFlightStore } = require("../src/flights");

const TODAY = "2026-11-05";
const RZESZOW = { lat: 50.04, lon: 22.0 };
const ZURICH = { lat: 47.377, lon: 8.54 };

const segment = (from, to, dep, arr, carrier = "LO", number = "3901") => ({
  origin: { iata_code: from }, destination: { iata_code: to }, departing_at: dep, arriving_at: arr,
  marketing_carrier: { iata_code: carrier }, marketing_carrier_flight_number: number,
});
const offer = (over = {}) => ({
  total_amount: "120.00", total_currency: "EUR", owner: { iata_code: "LO", name: "LOT Polish Airlines" },
  slices: [{ segments: [segment("RZE", "WAW", "2026-11-12T06:05:00", "2026-11-12T07:00:00", "LO", "3802"), segment("WAW", "ZRH", "2026-11-12T08:10:00", "2026-11-12T10:15:00", "LO", "411")] }],
  ...over,
});

function memoryStore() {
  const database = { readFares: async () => [], replaceFares: async () => {}, saveNetwork: async () => {} };
  return createFlightStore({ database, now: () => new Date(`${TODAY}T10:00:00Z`) });
}

test("Duffel offers become fares with the airline, changes and the cheapest offer of each flight", () => {
  const body = { data: { offers: [
    offer(),
    offer({ total_amount: "150.00" }), // the same flight, dearer
    offer({ owner: { iata_code: "FR", name: "Ryanair" } }), // asked of Ryanair itself
    offer({ owner: { iata_code: "LX", name: "Swiss" }, total_amount: "99.50", slices: [{ segments: [segment("RZE", "ZRH", "2026-11-12T12:00:00", "2026-11-12T14:05:00", "LX", "1371")] }] }),
    offer({ slices: [{ segments: [segment("RZE", "BSL", "2026-11-12T12:00:00", "2026-11-12T14:05:00")] }] }), // another airport
    offer({ slices: [{ segments: [segment("RZE", "ZRH", "2026-11-13T12:00:00", "2026-11-13T14:05:00")] }] }), // another day
  ] } };
  const rows = offersToRows(body, { from: "RZE", to: "ZRH", day: "2026-11-12", collectedAt: "2026-11-05T10:00:00Z" });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => [r.airline, r.price, r.stops, r.via, r.flightNumber, r.departure, r.arrival]), [
    ["LX", 99.5, 0, [], "LX 1371", "2026-11-12T12:00", "2026-11-12T14:05"],
    ["LO", 120, 1, ["WAW"], "LO 3802", "2026-11-12T06:05", "2026-11-12T10:15"],
  ]);
  assert.equal(rows[1].airlineName, "LOT Polish Airlines");
  assert.equal(rows[1].searchKey, "duffel|RZE|ZRH|2026-11-12");
});

test("a trip to a city without Ryanair or Wizz Air flights gets other airlines' fares through Duffel", async () => {
  const flights = memoryStore();
  // The route list knows Ryanair and Wizz Air only; neither flies to Zurich.
  await flights.saveNetwork({ airports: [], routes: [{ from: "RZE", to: "STN", airlines: ["RYANAIR"] }], updatedAt: `${TODAY}T00:00:00Z` });
  assert.deepEqual(flights.tripPairs({ origin: RZESZOW, dest: ZURICH }), []);
  const pairs = flights.apiPairs({ origin: RZESZOW, dest: ZURICH });
  assert.ok(pairs.some((p) => p.from === "RZE" && p.to === "ZRH"));
  assert.ok(pairs.length <= 4);

  const calls = [];
  const fetchSource = async (url, init) => {
    const leg = JSON.parse(init.body).data.slices[0];
    calls.push({ url, auth: init.headers.Authorization, version: init.headers["Duffel-Version"], leg });
    const out = leg.origin === "RZE" && leg.destination === "ZRH";
    const home = leg.origin === "ZRH" && leg.destination === "RZE";
    const offers = out ? [offer()] : home ? [offer({ slices: [{ segments: [segment("ZRH", "WAW", "2026-11-19T11:00:00", "2026-11-19T13:00:00", "LO", "412"), segment("WAW", "RZE", "2026-11-19T15:00:00", "2026-11-19T16:00:00", "LO", "3803")] }] })] : [];
    return { ok: true, status: 201, json: async () => ({ data: { offers } }) };
  };
  const duffel = createDuffelApi({ flights, token: "duffel_test_x", fetchSource, toPln: async (value) => value * 4.25, now: () => Date.parse(`${TODAY}T10:00:00Z`) });
  assert.equal(duffel.searchRoutes(pairs, "2026-11-12", "2026-11-19"), "started");
  for (let i = 0; i < 50 && duffel.status().running; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls.length, pairs.length * 2);
  assert.equal(calls[0].auth, "Bearer duffel_test_x");
  assert.equal(calls[0].version, "v2");
  assert.equal(duffel.status().ok, true);

  const found = flights.options({ origin: RZESZOW, dest: ZURICH, date: "2026-11-12", back: "2026-11-19" });
  assert.equal(found.outbound[0].airline, "LO");
  assert.equal(found.outbound[0].pricePln, 510);
  assert.equal(found.outbound[0].stops, 1);
  assert.match(found.outbound[0].bookingUrl, /^https:\/\/www\.google\.com\/travel\/flights\?/);
  assert.equal(found.options.length, 1);
  assert.equal(found.options[0].ret.to, "RZE");
  // The same days are not asked again for three hours.
  assert.equal(duffel.searchRoutes(pairs, "2026-11-12", "2026-11-19"), "fresh");
});

test("Duffel is off without a token, and a rejected token turns it off", async () => {
  const flights = memoryStore();
  assert.equal(createDuffelApi({ flights, token: "", toPln: async () => 1 }).searchRoutes([{ from: "RZE", to: "ZRH" }], "2026-11-12"), "unavailable");
  const duffel = createDuffelApi({ flights, token: "bad", toPln: async () => 1, fetchSource: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
  assert.equal(duffel.searchRoutes([{ from: "RZE", to: "ZRH" }], "2026-11-12"), "started");
  for (let i = 0; i < 50 && duffel.status().running; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(duffel.status().available, false);
  assert.match(duffel.status().error, /DUFFEL_ACCESS_TOKEN/);
  assert.equal(duffel.searchRoutes([{ from: "RZE", to: "ZRH" }], "2026-11-13"), "unavailable");
});
