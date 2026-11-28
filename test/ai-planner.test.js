"use strict";

const assert = require("node:assert/strict");
const { once } = require("node:events");
const test = require("node:test");
const { createAiPlanner, normalizeStyle, cleanPlan, travelHistory } = require("../src/ai-planner");
const { createServer } = require("../src/server");

const BARCELONA = { lat: 41.3874, lon: 2.1686 };
const favorites = [
  { type: "trip", view: "podroz", id: "a", from: "Rzeszów", to: "Barcelona", name: "x", tid: "trip000001", status: "booked",
    trip: { out: { day: "2026-12-04", arr: "11:40" }, ret: { day: "2026-12-07" }, hotel: { name: "Hotel Arts" },
      local: [{ city: "Barcelona", items: [{ to: "Sagrada Família" }] }] } },
  { type: "trip", view: "podroz", id: "b", from: "Rzeszów", to: "Rzym", name: "y", tid: "trip000002", status: "booked",
    trip: { out: { day: "2025-05-01" }, local: [{ city: "Rzym", items: [{ to: "Koloseum" }, { to: "Panteon" }] }] } },
];

function answer(days) {
  return { days: days.map((day) => ({ day, theme: "Gotyk", weatherNote: "", stops: [
    { time: "10:00", name: "Barri Gòtic", category: "sight", lat: 41.3833, lon: 2.1777, minutes: 120, why: "Lubisz historię.", tip: "", priceNote: "" },
    { time: "13:00", name: "Mistake far away", category: "food", lat: 52.2, lon: 21.0, minutes: 60, why: "", tip: "", priceNote: "20 €" },
  ] })), summary: "Plan.", tips: ["Kup T-casual."] };
}

function setup({ refusal = false } = {}) {
  const calls = [], saved = [];
  let prefs = { exploreView: "map", travelStyle: { interests: ["history"], pace: "relaxed" } };
  const client = { beta: { messages: { create: async (params) => {
    calls.push(params);
    const context = JSON.parse(params.messages[0].content.split("\n").slice(1).join("\n"));
    if (refusal) return { stop_reason: "refusal", content: [] };
    return { stop_reason: "end_turn", model: params.model, content: [{ type: "text", text: JSON.stringify(answer(context.days)) }] };
  } } } };
  const planner = createAiPlanner({
    client,
    store: { read: async () => null, save: async (...args) => saved.push(args) },
    getFavorites: async () => favorites,
    getPreferences: async () => prefs,
    savePreferences: async (_, p) => { prefs = p; },
    forecast: async () => ({ days: [{ day: "2026-12-05", min: 8, max: 14, rainChance: 80, rainMm: 6, windKmh: 20 }] }),
  });
  return { planner, calls, saved, prefs: () => prefs };
}

test("preferences are kept to known values", () => {
  assert.deepEqual(normalizeStyle({ interests: ["food", "hacking", "food"], pace: "fast", budget: "low", notes: "  wege  " }),
    { interests: ["food"], pace: "balanced", budget: "low", walking: "some", notes: "wege" });
});

test("other trips give the places planned there, not the current trip", () => {
  assert.deepEqual(travelHistory(favorites, "trip000001"), [{ to: "Rzym", when: "2025-05-01", status: "booked", places: ["Koloseum", "Panteon"] }]);
});

test("a plan keeps only the trip's days and drops positions far from the city", () => {
  const plan = cleanPlan({ ...answer(["2026-12-04", "2027-01-01"]) }, { centre: BARCELONA, days: ["2026-12-04"] });
  assert.equal(plan.days.length, 1);
  assert.equal(plan.days[0].stops[0].lat, 41.3833);
  assert.equal(plan.days[0].stops[1].lat, null);
});

test("generating sends the database context to Claude and stores the plan", async () => {
  const { planner, calls, saved, prefs } = setup();
  const plan = await planner.generate("user-1", { tid: "trip000001", city: "Barcelona", centre: BARCELONA, day: "2026-12-04", back: "2026-12-07",
    note: "plaża", style: { interests: ["food", "views"], pace: "packed" } });
  assert.equal(calls.length, 1);
  const p = calls[0];
  assert.equal(p.model, "claude-opus-5-5");
  assert.equal(p.output_config.format.type, "json_schema");
  const context = JSON.parse(p.messages[0].content.split("\n").slice(1).join("\n"));
  assert.deepEqual(context.days, ["2026-12-04", "2026-12-05", "2026-12-06", "2026-12-07"]);
  assert.deepEqual(context.alreadyPlannedHere, ["Sagrada Família"]);
  assert.equal(context.otherTrips[0].to, "Rzym");
  assert.equal(context.arrival, "11:40");
  assert.equal(context.stayingAt.name, "Hotel Arts");
  assert.equal(context.weather[0].rainChance, 80);
  assert.deepEqual(context.preferences.interests, ["food", "views"]);
  assert.equal(context.extraWish, "plaża");
  // The new preferences are remembered next to the other settings.
  assert.equal(prefs().exploreView, "map");
  assert.equal(prefs().travelStyle.pace, "packed");
  assert.equal(plan.days.length, 4);
  assert.equal(saved[0][1], "trip000001");
});

test("a trip of someone else, a refusal and too many requests are reported plainly", async () => {
  await assert.rejects(setup().planner.generate("user-1", { tid: "notmine001", city: "X", centre: BARCELONA }), { status: 404 });
  await assert.rejects(setup({ refusal: true }).planner.generate("user-1", { tid: "trip000001", city: "Barcelona", centre: BARCELONA }), { status: 422 });
  const { planner } = setup();
  for (let i = 0; i < 8; i++) await planner.generate("user-1", { tid: "trip000001", city: "Barcelona", centre: BARCELONA });
  await assert.rejects(planner.generate("user-1", { tid: "trip000001", city: "Barcelona", centre: BARCELONA }), { status: 429 });
});

test("without an API key the feature says it is off", async () => {
  const planner = createAiPlanner({ client: null, store: {}, getFavorites: async () => favorites, getPreferences: async () => ({}) });
  assert.equal(planner.enabled(), false);
  await assert.rejects(planner.generate("user-1", { tid: "trip000001", city: "Barcelona", centre: BARCELONA }), { status: 503 });
});

test("the AI endpoints need a session and hide internal errors", async (t) => {
  const { planner } = setup();
  const broken = { ...planner, generate: async () => { throw Object.assign(new Error("invalid x-api-key"), { status: 401 }); } };
  const server = createServer({ database: {}, aiPlanner: broken, auth: { resolveSession: async (token) => (token === "ok" ? { id: "1" } : null) } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/ai/status`)).status, 401);
  const status = await fetch(`${base}/api/ai/status`, { headers: { Cookie: "rzbus_session=ok" } });
  assert.deepEqual(await status.json(), { enabled: true, ask: false });
  const r = await fetch(`${base}/api/ai/city-plan`, { method: "POST", headers: { Cookie: "rzbus_session=ok", "Content-Type": "application/json", Origin: base }, body: "{}" });
  assert.equal(r.status, 502);
  assert.doesNotMatch((await r.json()).error, /api-key/);
});

test("7c: with an OpenStreetMap catalogue the plan uses only catalogued places, with their own names and positions", async () => {
  const catalogue = Array.from({ length: 9 }, (_, i) => ({ id: `n${i}`, name: `Miejsce ${i}`, cat: i ? "sight" : "museum", lat: 41.38 + i / 1000, lon: 2.17, km: i / 10, ...(i ? {} : { openingHours: "Tu-Su 10:00-18:00" }) }));
  const calls = [];
  const client = { beta: { messages: { create: async (params) => {
    calls.push(params);
    const context = JSON.parse(params.messages[0].content.split("\n").slice(1).join("\n"));
    return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ summary: "Plan.", tips: [], days: [{ day: context.days[0], theme: "", weatherNote: "", stops: [
      { placeId: "n0", time: "10:00", name: "Renamed by the model", category: "food", lat: 1, lon: 1, minutes: 90, why: "", tip: "", priceNote: "" },
      { placeId: "", time: "12:00", name: "Invented Café", category: "cafe", lat: 41.38, lon: 2.17, minutes: 30, why: "", tip: "", priceNote: "" },
      { placeId: "n99", time: "13:00", name: "Unknown id", category: "sight", lat: 41.38, lon: 2.17, minutes: 30, why: "", tip: "", priceNote: "" },
    ] }] }) }] };
  } } } };
  let askedAt = null;
  const planner = createAiPlanner({
    client, store: { read: async () => null, save: async () => {} },
    getFavorites: async () => favorites, getPreferences: async () => ({}), savePreferences: async () => {},
    places: async (q) => { askedAt = q; return { places: catalogue }; },
  });
  const plan = await planner.generate("user-1", { tid: "trip000001", city: "Barcelona", centre: BARCELONA, home: { lat: 41.39, lon: 2.18 }, day: "2026-12-04" });
  assert.deepEqual([askedAt.lat, askedAt.lon, askedAt.radius], [41.39, 2.18, 3000]); // around the stay
  const context = JSON.parse(calls[0].messages[0].content.split("\n").slice(1).join("\n"));
  assert.equal(context.catalogue.length, 9);
  assert.deepEqual(context.catalogue[0], { id: "n0", name: "Miejsce 0", kind: "museum", km: 0, hours: "Tu-Su 10:00-18:00" });
  assert.equal(plan.source, "osm");
  assert.deepEqual(plan.days[0].stops.map((s) => [s.name, s.category, s.lat, s.osm, s.openingHours]), [["Miejsce 0", "museum", 41.38, "n0", "Tu-Su 10:00-18:00"]]);
});

test("7c: too small a catalogue (or none) leaves the plan as before", async () => {
  const planner = createAiPlanner({
    client: { beta: { messages: { create: async (params) => {
      const context = JSON.parse(params.messages[0].content.split("\n").slice(1).join("\n"));
      assert.equal(context.catalogue, undefined);
      return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(answer(context.days)) }] };
    } } } },
    store: { read: async () => null, save: async () => {} },
    getFavorites: async () => favorites, getPreferences: async () => ({}), savePreferences: async () => {},
    places: async () => ({ places: [{ id: "n1", name: "Jedno", cat: "sight", lat: 41.38, lon: 2.17, km: 0.1 }] }),
  });
  const plan = await planner.generate("user-1", { tid: "trip000001", city: "Barcelona", centre: BARCELONA, day: "2026-12-04" });
  assert.equal(plan.source, "model");
  assert.equal(plan.days[0].stops[0].name, "Barri Gòtic");
});
