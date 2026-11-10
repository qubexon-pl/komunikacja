"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { importWizzResponses, parseWizzResponses } = require("../src/wizz-import");
const { createFlightStore } = require("../src/flights");

const timetable = { outboundFlights: [
  { departureStation: "KTW", arrivalStation: "BCN", departureDate: "2026-11-13T00:00:00", price: { amount: 209, currencyCode: "PLN" }, priceType: "price",
    departureDates: ["2026-11-13T05:30:00", "2026-11-13T15:25:00", "2026-11-13T19:35:00"], hasMacFlight: true },
  { departureStation: "KTW", arrivalStation: "BCN", departureDate: "2026-11-14T00:00:00", price: { amount: 0, currencyCode: "PLN" }, priceType: "checkPrice", departureDates: ["2026-11-14T06:00:00"] },
], returnFlights: [
  { departureStation: "BCN", arrivalStation: "KTW", departureDate: "2026-11-20T00:00:00", price: { amount: 40, currencyCode: "EUR" }, priceType: "price", departureDates: ["2026-11-20T09:10:00"] },
] };
const search = { currencyCode: "PLN", outboundFlights: [{
  departureStation: "KTW", arrivalStation: "BCN", departureDateTime: "2026-11-13T15:25:00", arrivalDateTime: "2026-11-13T18:20:00", carrierCode: "W6", flightNumber: " 1234",
  fares: [{ bundle: "basic", isWdc: false, discountedPrice: { amount: 249, currencyCode: "PLN" } }, { bundle: "basic", isWdc: true, discountedPrice: { amount: 199, currencyCode: "PLN" } }],
}] };

test("a saved Wizz timetable gives every departure time of a day at the day's cheapest price", () => {
  const rows = parseWizzResponses([{ kind: "timetable", data: timetable }]);
  assert.deepEqual(rows.map((r) => [r.from, r.day, r.departure, r.price, r.priceType]), [
    ["KTW", "2026-11-13", "2026-11-13T05:30", 209, "list"], ["KTW", "2026-11-13", "2026-11-13T15:25", 209, "list"], ["KTW", "2026-11-13", "2026-11-13T19:35", 209, "list"],
    ["BCN", "2026-11-20", "2026-11-20T09:10", 40, "list"],
  ]);
});

test("exact flights from a saved search replace that day's calendar price", () => {
  const rows = parseWizzResponses([{ kind: "timetable", data: timetable }, { kind: "search", data: search }]);
  const day = rows.filter((r) => r.from === "KTW" && r.day === "2026-11-13");
  assert.deepEqual(day.map((r) => [r.flightNumber, r.price, r.arrival, r.priceType]), [["W6 1234", 249, "2026-11-13T18:20", "exact"]]);
  assert.throws(() => parseWizzResponses([]), /Wizz Air/);
});

test("imported fares are priced in PLN and stay until the tracker brings newer ones for the same day", async () => {
  let stored = [];
  const store = createFlightStore({ database: { readFares: async () => stored, replaceFares: async (rows) => { stored = rows; } }, now: () => new Date("2026-11-10T10:00:00Z") });
  const result = await importWizzResponses([{ kind: "timetable", data: timetable }], { flights: store, toPln: async (a, c) => (c === "EUR" ? a * 4.25 : a), now: () => new Date("2026-11-10T10:00:00Z") });
  assert.deepEqual([result.stored, result.times, result.days], [4, 4, 2]);
  assert.equal(stored.find((f) => f.from === "BCN").pricePln, 170);
  // An older tracker run without that day keeps the import; the import survives the tracker's replacement.
  await store.importRows([{ airline: "RYANAIR", from: "KRK", to: "BCN", day: "2026-11-13", price: 99, currency: "PLN", pricePln: 99, flightNumber: "FR 1", collectedAt: "2026-11-10T09:00:00Z" }]);
  assert.equal(stored.filter((f) => f.airline === "WIZZ").length, 4);
  const { options } = store.options({ origin: { lat: 50.26, lon: 19.02 }, dest: { lat: 41.39, lon: 2.17 }, date: "2026-11-13" });
  const wizz = options.find((f) => f.airline === "WIZZ");
  assert.deepEqual(wizz.times, ["2026-11-13T05:30", "2026-11-13T15:25", "2026-11-13T19:35"]);
});

test("every new price is also written to the price history, once", async () => {
  const history = [];
  let stored = [];
  const store = createFlightStore({ database: { readFares: async () => stored, replaceFares: async (rows) => { stored = rows; }, appendHistory: async (rows) => { history.push(...rows); } }, now: () => new Date("2026-11-10T10:00:00Z") });
  const row = { airline: "RYANAIR", from: "KRK", to: "BGY", day: "2026-11-17", departure: "2026-11-17T06:20", price: 66, currency: "PLN", pricePln: 66, flightNumber: "FR 3505", collectedAt: "2026-11-10T09:00:00Z" };
  await store.importRows([row]);
  await store.importRows([row]); // the tracker file read again: nothing new
  await store.importRows([{ ...row, price: 59, pricePln: 59, collectedAt: "2026-11-10T11:00:00Z" }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(history.map((f) => f.pricePln), [66, 59]);
});

test("isCheapestOfTheDay puts the day's price on its departure, and a query for another time gives that one its own price", () => {
  const day = { outboundFlights: [{ departureStation: "KRK", arrivalStation: "BCN", departureDate: "2026-11-15T05:30:00", price: { amount: 319, currencyCode: "PLN" }, priceType: "price",
    departureDates: [{ date: "2026-11-15T05:30:00", isCheapestOfTheDay: true }, { date: "2026-11-15T15:25:00", isCheapestOfTheDay: false }] }] };
  const later = { outboundFlights: [{ departureStation: "KRK", arrivalStation: "BCN", departureDate: "2026-11-15T15:25:00", price: { amount: 419, currencyCode: "PLN" }, priceType: "price",
    departureDates: [{ date: "2026-11-15T15:25:00", isCheapestOfTheDay: true }] }] };
  const alone = parseWizzResponses([{ kind: "timetable", data: day }]);
  assert.deepEqual(alone.map((r) => [r.departure, r.price, r.priceType]), [["2026-11-15T05:30", 319, "exact"], ["2026-11-15T15:25", 319, "list"]]);
  const both = parseWizzResponses([{ kind: "timetable", data: day }, { kind: "timetable", data: later }]);
  assert.deepEqual(both.map((r) => [r.departure, r.price, r.priceType]).sort(), [["2026-11-15T05:30", 319, "exact"], ["2026-11-15T15:25", 419, "exact"]]);
});
