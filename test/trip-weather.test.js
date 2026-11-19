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

test("each day carries its local hours, so a night landing is not shown with the day's maximum", async () => {
  let url = "";
  const days = range("2026-11-16", 2);
  const fetchSource = async (u) => {
    url = String(u);
    return new Response(JSON.stringify({
      daily: { time: days, weather_code: [3, 61], temperature_2m_max: [19.6, 17], temperature_2m_min: [11.2, 10], precipitation_probability_max: [20, 70], precipitation_sum: [0, 3], wind_speed_10m_max: [10, 20] },
      hourly: { time: ["2026-11-17T00:00", "2026-11-17T01:00", "2026-11-17T14:00"], temperature_2m: [12.1, 11.8, 16.9], precipitation_probability: [65, 70, null], weather_code: [61, 61, 3] },
    }));
  };
  const weather = createTripWeather({ fetchSource, now: () => 0 });
  const result = await weather.forecast({ lat: 41.8, lon: 12.25, from: "2026-11-17", to: "2026-11-17" });
  assert.match(url, /hourly=temperature_2m%2Cprecipitation_probability%2Cweather_code/);
  assert.deepEqual(result.days[0].hours, [[0, 12.1, 65, 61], [1, 11.8, 70, 61], [14, 16.9, null, 3]]);
  assert.equal(result.days[0].max, 17);
});

test("the weather where the person is comes rounded to about 1 km, names the town and is kept for 20 minutes", async () => {
  const asked = [];
  let clock = 0;
  const fetchSource = async (u) => {
    const url = String(u);
    asked.push(url);
    if (url.includes("nominatim")) return new Response(JSON.stringify({ address: { city: "Kraków", county: "Kraków" } }));
    return new Response(JSON.stringify({ timezone: "Europe/Warsaw", current: { temperature_2m: 4.2, weather_code: 3 }, hourly: { time: ["2026-11-19T16:00"], temperature_2m: [3.9] } }));
  };
  const weather = createTripWeather({ fetchSource, now: () => clock });
  const here = await weather.current({ lat: 50.061234, lon: 19.937812 });
  assert.equal(here.place, "Kraków");
  assert.equal(here.current.temperature_2m, 4.2);
  assert.deepEqual(here.hourly.temperature_2m, [3.9]);
  const meteo = asked.find((u) => u.includes("open-meteo"));
  assert.match(meteo, /latitude=50\.06&longitude=19\.94/);
  assert.match(meteo, /current=temperature_2m/);
  assert.match(asked.find((u) => u.includes("nominatim")), /lat=50\.06&lon=19\.94/);
  clock = 10 * 60 * 1000;
  await weather.current({ lat: 50.0611, lon: 19.9379 });
  assert.equal(asked.length, 2); // the same square, within 20 minutes
  await assert.rejects(weather.current({ lat: Number.NaN, lon: 19 }), /Podaj/);
});

test("the weather where the person is still comes when the town name cannot be found", async () => {
  const fetchSource = async (u) => String(u).includes("nominatim")
    ? new Response("busy", { status: 503 })
    : new Response(JSON.stringify({ current: { temperature_2m: 20, weather_code: 0 } }));
  const here = await createTripWeather({ fetchSource, now: () => 5000 }).current({ lat: 41.39, lon: 2.17 });
  assert.equal(here.place, null);
  assert.equal(here.current.temperature_2m, 20);
});
