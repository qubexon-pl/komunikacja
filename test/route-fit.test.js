"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { fitDay, bestOrder, walkMinutes } = require("../src/route-fit");
const { createAiPlanner } = require("../src/ai-planner");

// Four places on a line west → east, planned in a zig-zag order.
const P = (name, lon, extra = {}) => ({ name, lat: 41.9, lon, minutes: 60, ...extra });
const A = P("A", 12.47), B = P("B", 12.48), C = P("C", 12.49), D = P("D", 12.50);
const HOTEL = { lat: 41.9, lon: 12.465 };

test("the best order walks the line instead of zig-zagging", () => {
  assert.deepEqual(bestOrder(HOTEL, [C, A, D, B]), [1, 3, 0, 2]); // A, B, C, D
  assert.deepEqual(bestOrder(null, [A]), [0]);
});

test("a fitted day keeps its first time, adds stays and walks, and says how much less it walks", () => {
  const day = fitDay([{ ...C, time: "10:00" }, { ...A, time: "11:30" }, { ...D, time: "13:00" }, { ...B, time: "15:00" }], { start: HOTEL });
  assert.deepEqual(day.stops.map((s) => s.name), ["A", "B", "C", "D"]);
  assert.equal(day.stops[0].time.slice(0, 2), "10"); // starts at the day's earliest planned time plus the walk from the hotel
  const w = walkMinutes(A, B);
  assert.equal(day.stops[1].walkMin, w);
  const [h0, m0] = day.stops[0].time.split(":").map(Number), [h1, m1] = day.stops[1].time.split(":").map(Number);
  assert.equal((h1 * 60 + m1) - (h0 * 60 + m0), 60 + w);
  assert.ok(day.savedKm > 0);
  assert.ok(day.walkKm > 0);
});

test("a stop without a position stays after the stop it followed", () => {
  const day = fitDay([{ ...C, time: "10:00" }, { name: "Lunch somewhere", minutes: 60 }, { ...A }, { ...B }], { start: HOTEL });
  const names = day.stops.map((s) => s.name);
  assert.equal(names.indexOf("Lunch somewhere"), names.indexOf("C") + 1);
  assert.equal(names.length, 4);
});

test("fit() reorders one saved day of the owner's plan and stores it", async () => {
  const favorites = [{ type: "trip", tid: "trip000001", from: "Rzeszów", to: "Rzym", trip: {} }];
  let stored = { city: "Rzym", summary: "x", days: [{ day: "2026-12-04", theme: "", weatherNote: "", stops: [{ ...C, time: "10:00" }, { ...A, time: "12:00" }, { ...B, time: "14:00" }] }], createdAt: "2026-11-27T10:00:00Z" };
  const planner = createAiPlanner({
    client: null, getFavorites: async () => favorites, getPreferences: async () => ({}), savePreferences: async () => {},
    store: { read: async () => stored, save: async (u, tid, city, plan) => { stored = { ...plan, createdAt: stored.createdAt }; } },
  });
  const r = await planner.fit("user-1", { tid: "trip000001", city: "Rzym", day: "2026-12-04", start: HOTEL });
  assert.deepEqual(r.plan.days[0].stops.map((s) => s.name), ["A", "B", "C"]);
  assert.equal(r.plan.days[0].fitted, true);
  assert.deepEqual(stored.days[0].stops.map((s) => s.name), ["A", "B", "C"]);
  await assert.rejects(planner.fit("user-1", { tid: "notmine001", city: "Rzym", day: "2026-12-04" }), { status: 404 });
  await assert.rejects(planner.fit("user-1", { tid: "trip000001", city: "Rzym", day: "2026-12-09" }), { status: 404 });
});
