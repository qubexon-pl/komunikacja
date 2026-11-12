"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createRyanairApi, rowsOfLeg, monthsOf } = require("../src/ryanair-api");

const fare = (day, time, value) => ({ day, departureDate: `${day}T${time}:00`, arrivalDate: `${day}T23:59:00`, price: value == null ? null : { value, currencyCode: "PLN" }, soldOut: false, unavailable: value == null });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test("the cheapest flight of a day is priced, the day's other departures wait for their own price, empty days are cleared", () => {
  const leg = { from: "KRK", to: "STN", start: "2026-12-01", end: "2026-12-03" };
  const fares = new Map([["2026-12-01", fare("2026-12-01", "09:45", 218.13)], ["2026-12-02", fare("2026-12-02", "19:25", 237.28)], ["2026-12-03", fare("2026-12-03", "00:00", null)]]);
  const table = new Map([
    ["2026-12-01", [{ number: "2433", departureTime: "09:45", arrivalTime: "11:15" }, { number: "2363", departureTime: "23:40", arrivalTime: "01:10" }]],
    ["2026-12-02", [{ number: "2363", departureTime: "19:25", arrivalTime: "20:55" }]],
  ]);
  const { rows, empty } = rowsOfLeg(leg, fares, table, "2026-11-12T10:00:00Z");
  assert.deepEqual(rows.map((r) => [r.day, r.departure, r.flightNumber, r.priceType, r.price]), [
    ["2026-12-01", "2026-12-01T09:45", "FR 2433", "exact", 218.13],
    ["2026-12-01", "2026-12-01T23:40", "FR 2363", "list", 218.13],
    ["2026-12-02", "2026-12-02T19:25", "FR 2363", "exact", 237.28],
  ]);
  assert.equal(rows[1].arrival, "2026-12-02T01:10"); // lands after midnight
  assert.deepEqual(empty, ["2026-12-03"]);
  assert.deepEqual(monthsOf("2026-11-20", "2027-01-05"), ["2026-11", "2026-12", "2027-01"]);
});

test("Ryanair is asked politely: own User-Agent, no cookies, one at a time, and a refusal pauses it for an hour without retrying", async () => {
  let clock = Date.parse("2026-11-12T10:00:00Z");
  const asked = [];
  const merged = [];
  const fetchSource = async (url, options) => {
    asked.push({ url: String(url), headers: options.headers });
    if (String(url).includes("cheapestPerDay")) return json({ outbound: { fares: [fare("2026-11-20", "10:00", 199)] } });
    if (String(url).includes("timtbl")) return json({ days: [{ day: 20, flights: [{ number: "1", departureTime: "10:00", arrivalTime: "11:30" }] }] });
    return json({ message: "Availability declined" }, 409);
  };
  const r = createRyanairApi({ flights: { mergeRows: async (rows, opts) => { merged.push({ rows, opts }); return { stored: rows.length }; } }, toPln: async (v) => v, fetchSource, now: () => clock, gapMs: 0, enabled: true });
  assert.equal(r.searchRoutes([{ from: "KRK", to: "STN" }], "2026-11-20"), "started");
  while (!merged.length) await new Promise((s) => setTimeout(s, 5));
  assert.ok(asked.every((a) => /komunikacja/.test(a.headers["User-Agent"]) && !a.headers.Cookie && Object.keys(a.headers).length === 2));
  assert.ok(asked.every((a) => !a.url.includes("/booking/"))); // the booking API is never used
  assert.equal(merged[0].rows[0].pricePln, 199);
  assert.equal(r.searchRoutes([{ from: "KRK", to: "STN" }], "2026-11-20"), "fresh"); // the same days within 3 hours
  const before = asked.length;
  await assert.rejects(r.priceForTime({ from: "KRK", to: "STN", time: "2026-11-21T10:00" }), { status: 409 });
  assert.equal(asked.length, before + 1);
  await assert.rejects(r.priceForTime({ from: "KRK", to: "STN", time: "2026-11-22T10:00" }), { status: 429 }); // paused: not asked at all
  assert.equal(asked.length, before + 1);
  assert.equal(r.searchRoutes([{ from: "KRK", to: "BGY" }], "2026-11-25"), "unavailable");
  clock += 61 * 60 * 1000;
  assert.ok(r.status().pausedUntil === null);
});

test("a departure Ryanair no longer sells loses its stored price when its own price is checked", async () => {
  const merged = [];
  const fetchSource = async () => new Response(JSON.stringify({ fares: [], size: 0 }), { status: 200 });
  const r = createRyanairApi({ flights: { mergeRows: async (rows, opts) => { merged.push({ rows, opts }); return { stored: rows.length, removed: 1 }; } }, toPln: async (v) => v, fetchSource, now: () => Date.parse("2026-11-12T10:00:00Z"), gapMs: 0, enabled: true });
  const answer = await r.priceForTime({ from: "KRK", to: "BCN", time: "2026-11-20T09:05" });
  assert.equal(answer.unsold, true);
  assert.deepEqual(merged[0].opts.drop, [{ airline: "RYANAIR", from: "KRK", to: "BCN", day: "2026-11-20", departure: "2026-11-20T09:05" }]);
});

test("the status tells how many of the planned Ryanair requests are done", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let calls = 0;
  const fetchSource = async (url) => { calls++; if (calls === 2) await gate; return String(url).includes("timtbl") ? new Response(JSON.stringify({ days: [] }), { status: 200 }) : new Response(JSON.stringify({ outbound: { fares: [] } }), { status: 200 }); };
  const r = createRyanairApi({ flights: { mergeRows: async (rows) => ({ stored: rows.length }) }, toPln: async (v) => v, fetchSource, now: () => Date.parse("2026-11-12T10:00:00Z"), gapMs: 0, enabled: true });
  r.searchRoutes([{ from: "KRK", to: "STN" }], "2026-12-15"); // 1 month either side: Dec only → 2 requests
  await new Promise((s) => setTimeout(s, 20));
  assert.deepEqual(r.status().progress, { done: 1, total: 2 });
  release();
  while (r.status().running) await new Promise((s) => setTimeout(s, 5));
  assert.deepEqual(r.status().progress, { done: 2, total: 2 });
});

test("scrolling to days without stored prices asks only for those days, and not again soon", async () => {
  const asked = [];
  const fetchSource = async (url) => { asked.push(String(url)); return String(url).includes("timtbl") ? new Response(JSON.stringify({ days: [] }), { status: 200 }) : new Response(JSON.stringify({ outbound: { fares: [] } }), { status: 200 }); };
  const r = createRyanairApi({ flights: { mergeRows: async (rows) => ({ stored: rows.length }) }, toPln: async (v) => v, fetchSource, now: () => Date.parse("2026-11-12T10:00:00Z"), gapMs: 0, enabled: true });
  const stored = new Set(["2026-12-01", "2026-12-02", "2026-12-03"]);
  const hasDay = (airline, from, to, day) => stored.has(day);
  assert.equal(r.fillRange([{ from: "RZE", to: "EDI", start: "2026-12-01", end: "2026-12-03" }], hasDay), "fresh"); // all stored: nothing asked
  assert.equal(asked.length, 0);
  assert.equal(r.fillRange([{ from: "RZE", to: "EDI", start: "2026-12-01", end: "2026-12-10" }], hasDay), "started");
  while (r.status().running || asked.length < 2) await new Promise((s) => setTimeout(s, 5));
  assert.equal(asked.length, 2); // December fares + timetable, once
  assert.equal(r.fillRange([{ from: "RZE", to: "EDI", start: "2026-12-04", end: "2026-12-10" }], hasDay), "fresh"); // just asked
});
