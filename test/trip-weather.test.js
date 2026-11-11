"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createTripWeather } = require("../src/trip-weather");

const answer = (days) => new Response(JSON.stringify({ daily: {
  time: days, weather_code: days.map(() => 2), temperature_2m_max: days.map(() => 18.4), temperature_2m_min: days.map(() => 9.1),
  precipitation_probability_max: days.map(() => 30), precipitation_sum: days.map(() => 0.4), wind_speed_10m_max: days.map(() => 12),
} }));
const range = (from, n) => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${from}T12:00:00Z`) + i * 86400000).toISOString().slice(0, 10));

test("the destination forecast covers the stay, says when later days get one, and is asked once per place and hour", async () => {
  let calls = 0, url = "";
  const weather = createTripWeather({ fetchSource: async (u) => { calls += 1; url = String(u); return answer(range("2026-11-11", 16)); }, now: () => 0 });
  const stay = await weather.forecast({ lat: 41.39, lon: 2.17, from: "2026-11-15", to: "2026-11-22" });
  assert.deepEqual(stay.days.map((d) => d.day), range("2026-11-15", 8));
  assert.deepEqual(stay.days[0], { day: "2026-11-15", code: 2, max: 18.4, min: 9.1, rainChance: 30, rainMm: 0.4, windKmh: 12 });
  assert.equal(stay.availableFrom, null);
  assert.match(url, /api\.open-meteo\.com\/v1\/forecast\?latitude=41\.39&longitude=2\.17/);
  const later = await weather.forecast({ lat: 41.41, lon: 2.18, from: "2026-11-24", to: "2026-11-30" });
  assert.deepEqual(later.days.map((d) => d.day), ["2026-11-24", "2026-11-25", "2026-11-26"]);
  assert.equal(later.availableFrom, "2026-11-12"); // 27.11 gets a forecast 16 days before
  assert.equal(calls, 1); // the same place, within the hour
  await assert.rejects(weather.forecast({ lat: 99, lon: 2, from: "2026-11-15", to: "2026-11-16" }), /Podaj/);
});
