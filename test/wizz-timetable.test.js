"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createWizzTimetable, shiftTime } = require("../src/wizz-timetable");
const { createFlightStore } = require("../src/flights");

const NOW = Date.parse("2026-11-10T10:00:00Z");
const day = (n) => new Date(NOW + n * 86400000).toISOString().slice(0, 10);
const answer = (flights) => new Response(JSON.stringify({ outboundFlights: flights, returnFlights: [] }));
const memoryStore = () => {
  let stored = [];
  const store = createFlightStore({ database: { readFares: async () => stored, replaceFares: async (rows) => { stored = rows; } }, now: () => new Date(NOW) });
  return { store, stored: () => stored };
};

test("a window around one departure is written the way the timetable expects", () => {
  assert.equal(shiftTime("2026-11-15T15:25", -5), "2026-11-15 15:20:00");
  assert.equal(shiftTime("2026-11-15T23:50", 35), "2026-11-16 00:25:00");
});

test("the timetable is asked politely and its answer stored: the day's price on the cheapest departure", async () => {
  const sent = [];
  const { store, stored } = memoryStore();
  const wizz = createWizzTimetable({ flights: store, toPln: async (a) => a, now: () => NOW, gapMs: 0, fetchSource: async (url, init) => {
    sent.push({ url: String(url), init });
    return answer([{ departureStation: "KRK", arrivalStation: "BCN", departureDate: `${day(5)}T05:30:00`, price: { amount: 319, currencyCode: "PLN" }, priceType: "price",
      departureDates: [{ date: `${day(5)}T05:30:00`, isCheapestOfTheDay: true }, { date: `${day(5)}T15:25:00`, isCheapestOfTheDay: false }] }]);
  } });
  assert.equal(wizz.searchRoutes([{ from: "KRK", to: "BCN", airlines: ["WIZZ"] }], day(5)), "started");
  while (wizz.status().running || !sent.length) await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 5));
  assert.match(sent[0].url, /be\.wizzair\.com\/[\d.]+\/Api\/search\/timetableV2$/);
  assert.equal(sent[0].init.headers["User-Agent"].startsWith("komunikacja-rzeszow"), true); // the app says who it is
  assert.equal(sent[0].init.headers.Origin, undefined);
  assert.equal(sent[0].init.headers.Referer, undefined);
  const body = JSON.parse(sent[0].init.body);
  assert.deepEqual(body.flightList, [{ departureStation: "KRK", arrivalStation: "BCN", from: day(0), to: day(19) }]); // never before today
  assert.deepEqual(stored().map((f) => [f.departure, f.pricePln, f.priceType, f.source]), [[`${day(5)}T05:30`, 319, "exact", "wizz.api.timetable"], [`${day(5)}T15:25`, 319, "list", "wizz.api.timetable"]]);
  assert.equal(wizz.searchRoutes([{ from: "KRK", to: "BCN", airlines: ["WIZZ"] }], day(5)), "fresh"); // not asked again within hours
});

test("the price of one departure replaces only that departure, and a refusal pauses Wizz requests without retrying", async () => {
  const { store, stored } = memoryStore();
  await store.mergeRows([
    { airline: "WIZZ", from: "KRK", to: "BCN", day: day(5), departure: `${day(5)}T05:30`, price: 319, currency: "PLN", pricePln: 319, priceType: "exact", source: "x", collectedAt: new Date(NOW).toISOString() },
    { airline: "WIZZ", from: "KRK", to: "BCN", day: day(5), departure: `${day(5)}T15:25`, price: 319, currency: "PLN", pricePln: 319, priceType: "list", source: "x", collectedAt: new Date(NOW).toISOString() },
  ]);
  let calls = 0, status = 200, sentBody = null;
  const wizz = createWizzTimetable({ flights: store, toPln: async (a) => a, now: () => NOW, gapMs: 0, fetchSource: async (url, init) => {
    calls += 1; sentBody = JSON.parse(init.body);
    if (status !== 200) return new Response("", { status });
    return answer([{ departureStation: "KRK", arrivalStation: "BCN", departureDate: `${day(5)}T15:25:00`, price: { amount: 419, currencyCode: "PLN" }, priceType: "price", departureDates: [{ date: `${day(5)}T15:25:00`, isCheapestOfTheDay: true }] }]);
  } });
  const result = await wizz.priceForTime({ from: "KRK", to: "BCN", time: `${day(5)}T15:25` });
  assert.equal(result.stored, 1);
  assert.deepEqual(sentBody.flightList, [{ departureStation: "KRK", arrivalStation: "BCN", from: `${day(5)} 15:20:00`, to: `${day(5)} 16:00:00` }]);
  assert.deepEqual(stored().map((f) => [f.departure, f.pricePln, f.priceType]).sort(), [[`${day(5)}T05:30`, 319, "exact"], [`${day(5)}T15:25`, 419, "exact"]]);
  status = 429;
  await assert.rejects(wizz.priceForTime({ from: "KRK", to: "BCN", time: `${day(6)}T09:00` }), /HTTP 429/);
  await assert.rejects(wizz.priceForTime({ from: "KRK", to: "BCN", time: `${day(7)}T09:00` }), /przerwę/);
  assert.equal(calls, 2); // the second request after the refusal was never sent
  assert.ok(wizz.status().pausedUntil);
});

test("a moved Wizz API version is found by trying the next likely ones, and remembered", async () => {
  const { nextVersions } = require("../src/wizz-timetable");
  assert.deepEqual(nextVersions("29.24.0").slice(0, 3), ["29.24.1", "29.25.0", "29.25.1"]);
  const tried = [];
  let saved = null;
  const { store } = memoryStore();
  const wizz = createWizzTimetable({ flights: store, toPln: async (a) => a, now: () => NOW, gapMs: 0, version: "29.24.0", saveVersion: async (v) => { saved = v; },
    fetchSource: async (url) => { const v = /be\.wizzair\.com\/([\d.]+)\//.exec(String(url))[1]; tried.push(v); return v === "29.25.0" ? answer([]) : new Response("", { status: 404 }); } });
  await wizz.priceForTime({ from: "KRK", to: "BCN", time: `${day(5)}T15:25` });
  assert.equal(wizz.status().version, "29.25.0");
  assert.equal(saved, "29.25.0");
  assert.deepEqual(tried.slice(0, 3), ["29.24.0", "29.24.1", "29.25.0"]);
});

test("picking another day asks Wizz Air again only when that day's last check is more than 3 hours old", async () => {
  let clock = NOW, calls = 0;
  const { store } = memoryStore();
  const wizz = createWizzTimetable({ flights: store, toPln: async (a) => a, now: () => clock, gapMs: 0, fetchSource: async () => { calls += 1; return answer([]); } });
  const pair = [{ from: "KRK", to: "BCN", airlines: ["WIZZ"] }];
  assert.equal(wizz.searchRoutes(pair, day(10)), "started");
  assert.equal(wizz.searchRoutes(pair, day(12)), "fresh"); // within the two weeks just asked about
  assert.equal(wizz.searchRoutes(pair, day(30)), "started"); // outside it
  clock += 3 * 60 * 60 * 1000 + 1;
  assert.equal(wizz.searchRoutes(pair, day(12)), "started"); // older than 3 hours
  while (wizz.status().running) await new Promise((r) => setTimeout(r, 5));
});
