"use strict";
// Phase 10d: one check per acceptance criterion of the brief (section 18). Each criterion names the tests that prove
// it; the first test below fails if one of those tests is renamed or removed, so the list cannot go stale. Criteria
// that no test covered yet get their own test here. The layout criteria are also checked in a browser by
// scripts/check-layout.mjs (see docs/PODAVO_REFACTOR.md, 10d).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { createAiPlanner } = require("../src/ai-planner");

const read = (file) => fs.readFileSync(path.resolve(__dirname, "..", file), "utf8");
const app = read("assets/app.js");

const CRITERIA = [
  ["No unintended horizontal scrolling on supported devices", [
    ["app-shell.test.js", "the phone bottom bar keeps a gutter so the last item does not touch the screen edge"],
    ["acceptance.test.js", "no page may scroll sideways: the layout check covers every size in both themes"]]],
  ["All supported cities use the same transport UI components", [
    ["transport-ui.test.js", "the city stop board reads the shared departures endpoint and draws the shared board"],
    ["transport-ui.test.js", "the Rzeszów stop board draws the shared board from the browser timetable"],
    ["transport-ui.test.js", "app.js renders step-by-step lists and city results through the shared transport module"]]],
  ["Existing integrations continue to work", [
    ["transport-adapters.test.js", "Transitous departures become the shared model: delays only when live"],
    ["city-transit.test.js", "departures from a stop are in Polish local time, with live delays and cancellations"],
    ["duffel-api.test.js", "a trip to a city without Ryanair or Wizz Air flights gets other airlines' fares through Duffel"],
    ["push.test.js", "trip reminders: booked trips leaving or returning tomorrow, nothing for plans or other days"]]],
  ["Journey details are accessible without overwhelming the main screen", [
    ["app-ui.test.js", "the planner's journey line keeps details out of the page and opens them in a sheet"],
    ["app-ui.test.js", "cost breakdowns, price assumptions, baggage and the route step by step open in a sheet"],
    ["app-ui.test.js", "a sheet is a labelled modal dialog with a close button and a focus trap marker"]]],
  ["Users can save trips without adding accommodation", [
    ["app-ui.test.js", "step 4 has one primary action, saving says it is not a booking, and purchase links name the site"],
    ["pages.test.js", "a trip without a plane is picked, saved with its own name and dated on the timeline"]]],
  ["Destination recommendations use real available data", [
    ["discover.test.js", "discover: the cheapest stored fare per destination city, within the window and radius"],
    ["discover.test.js", "discover adds the forecast only where one exists, and only the destination's coordinates"],
    ["discover-ui.test.js", "weather only from a forecast; otherwise the day the forecast will exist, never a guess"]]],
  ["Shared attraction information is reused across users", [
    ["stored.test.js", "a lookup reads the database first and asks the outside service only when nothing fresh is stored"],
    ["acceptance.test.js", "place information is kept in the shared catalogue, not per user"]]],
  ["Users can see when destination information was refreshed", [
    ["transport-ui.test.js", "the freshness line names the source and the time the data was fetched"],
    ["acceptance.test.js", "About and Nearby say when the catalogue fetched them"]]],
  ["Multiple exploration plans can be saved within one trip", [
    ["pages.test.js", "a trip with several places is saved as one trip: every leg, the places in between and the last day"],
    ["acceptance.test.js", "each city of a trip keeps its own sightseeing plan"]]],
  ["Exploration plans respect available time and existing trip commitments", [
    ["ai-planner.test.js", "a plan keeps only the trip's days and drops positions far from the city"],
    ["route-fit.test.js", "8b: a day's conflicts: overlaps, closed days and visits outside the hours, nothing for unknown hours"],
    ["route-fit.test.js", "a fitted day keeps its first time, adds stays and walks, and says how much less it walks"]]],
  ["Public transport is used wherever supported", [
    ["city-transit.test.js", "a city journey is planned at the local time of the destination and kept for a while"],
    ["airport-transfers.test.js", "connections ask Transitous once per trip, from the pickup point after landing, and keep the answer"]]],
  ["Users can modify generated plans manually", [
    ["route-fit.test.js", "fit() reorders one saved day of the owner's plan and stores it"],
    ["acceptance.test.js", "a plan's stops can be moved, removed and added by hand"]]],
  ["Saved plans are not silently changed by catalogue refreshes", [
    ["acceptance.test.js", "a saved plan is read back as saved after the catalogue changes"]]],
  ["Both Polish and English interfaces are supported", [
    ["app-ui.test.js", "unknown sizes fall back to the standard sheet, and English labels follow the page language"],
    ["discover-ui.test.js", "5c: a typed wish becomes checked filters, in Polish and English"]]],
  ["Mobile and desktop layouts are tested independently", [
    ["app-shell.test.js", "the sidebar starts at the desktop breakpoint and the phone bar below the tablet one"],
    ["acceptance.test.js", "no page may scroll sideways: the layout check covers every size in both themes"]]],
];

test("every acceptance criterion names tests that exist", () => {
  const names = new Map();
  for (const file of fs.readdirSync(__dirname).filter((f) => f.endsWith(".test.js"))) {
    names.set(file, new Set([...read(`test/${file}`).matchAll(/^test\("((?:[^"\\]|\\.)*)"/gm)].map((m) => m[1].replace(/\\"/g, '"'))));
  }
  assert.equal(CRITERIA.length, 15);
  for (const [criterion, refs] of CRITERIA) {
    assert.ok(refs.length > 0, criterion);
    for (const [file, name] of refs) assert.ok(names.get(file)?.has(name), `${criterion}: missing test "${name}" in ${file}`);
  }
});

test("no page may scroll sideways: the layout check covers every size in both themes", () => {
  // Overflow is not hidden globally (that would hide the bug); the browser check measures every page instead.
  const check = read("scripts/check-layout.mjs");
  for (const width of [320, 390, 768, 1024, 1440]) assert.match(check, new RegExp(`\\b${width}\\b`));
  assert.match(check, /scrollWidth/);
  assert.match(check, /dark/);
});

test("place information is kept in the shared catalogue, not per user", () => {
  const server = read("src/server.js");
  // The cache keys of About (Wikipedia/Wikidata) and Nearby (OpenStreetMap) are the place and language only.
  const about = server.match(/keep\.wrap\("know",[^\n]*/)[0], near = server.match(/keep\.wrap\("osm",[^\n]*/)[0];
  for (const line of [about, near]) assert.doesNotMatch(line, /user|session|tid/i);
  assert.match(about, /q\.name/);
  assert.match(near, /q\.lat\.toFixed\(3\), q\.lon\.toFixed\(3\), q\.radius/);
});

test("About and Nearby say when the catalogue fetched them", () => {
  const context = {};
  vm.runInNewContext(read("assets/app.discover.js"), context);
  const PL = (pl) => pl, EN = (pl, en) => en;
  const about = context.PVD.aboutHtml({ found: true, title: "Rzym", url: "https://pl.wikipedia.org/wiki/Rzym", sources: [{ name: "Wikipedia", url: "https://pl.wikipedia.org", license: "CC BY-SA 4.0" }], fetchedAt: "2026-11-02T09:00:00Z" }, { t: PL });
  assert.match(about, /CC BY-SA 4\.0\) · stan na 2 lis 2026/);
  const near = context.PVD.nearList({ places: [{ id: "n1", name: "Koloseum", cat: "sight", lat: 41.89, lon: 12.49, km: 0.4 }], license: "ODbL", fetchedAt: "2026-11-20T09:00:00Z" }, { t: EN });
  assert.match(near, /\(ODbL\) · as of 20 Nov 2026/);
  assert.doesNotMatch(context.PVD.nearList({ places: [{ id: "n1", name: "K", cat: "sight", km: 1 }] }, { t: PL }), /stan na/); // no date, no claim
});

// A planner with a stored plan per (trip, city), as dbo.TripAiPlan keeps it, and a catalogue the test can change.
function plannerWith(catalogue) {
  const rows = new Map(), trip = { type: "trip", tid: "trip000001", from: "Rzeszów", to: "Rzym", status: "booked", trip: { out: { day: "2026-12-04" }, ret: { day: "2026-12-05" } } };
  const client = { beta: { messages: { create: async (params) => {
    const ctx = JSON.parse(params.messages[0].content.split("\n").slice(1).join("\n"));
    return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ summary: "", tips: [], days: ctx.days.map((day) => ({ day, theme: "", weatherNote: "", stops: ctx.catalogue.slice(0, 2).map((p, i) => ({ placeId: p.id, time: `1${i}:00`, name: "", category: "sight", lat: 0, lon: 0, minutes: 60, why: "", tip: "", priceNote: "" })) })) }) }] };
  } } } };
  const planner = createAiPlanner({
    client,
    store: { read: async (u, t, c) => rows.get(`${u}|${t}|${c}`) || null, save: async (u, t, c, plan) => { rows.set(`${u}|${t}|${c}`, structuredClone(plan)); } },
    getFavorites: async () => [trip], getPreferences: async () => ({}), savePreferences: async () => {},
    places: async () => ({ places: catalogue.list }),
  });
  return { planner, rows };
}
const placesNamed = (prefix) => Array.from({ length: 8 }, (_, i) => ({ id: `n${i}`, name: `${prefix} ${i}`, cat: "sight", lat: 41.89 + i / 1000, lon: 12.49, km: i / 10, openingHours: "Mo-Su 09:00-18:00" }));

test("a saved plan is read back as saved after the catalogue changes", async () => {
  const catalogue = { list: placesNamed("Miejsce") }, { planner } = plannerWith(catalogue);
  const made = await planner.generate("u1", { tid: "trip000001", city: "Rzym", centre: { lat: 41.89, lon: 12.49 }, day: "2026-12-04", back: "2026-12-05" });
  assert.deepEqual(made.days[0].stops.map((s) => s.name), ["Miejsce 0", "Miejsce 1"]);
  // The catalogue is refreshed: places renamed, hours changed, one removed.
  catalogue.list = placesNamed("Nowa nazwa").map((p) => ({ ...p, openingHours: "Mo 10:00-11:00" })).slice(1);
  const again = await planner.saved("u1", { tid: "trip000001", city: "Rzym" });
  assert.deepEqual(again.days[0].stops.map((s) => [s.name, s.openingHours]), [["Miejsce 0", "Mo-Su 09:00-18:00"], ["Miejsce 1", "Mo-Su 09:00-18:00"]]);
});

test("each city of a trip keeps its own sightseeing plan", async () => {
  const { planner, rows } = plannerWith({ list: placesNamed("Miejsce") });
  await planner.generate("u1", { tid: "trip000001", city: "Rzym", centre: { lat: 41.89, lon: 12.49 }, day: "2026-12-04" });
  await planner.generate("u1", { tid: "trip000001", city: "Tivoli", centre: { lat: 41.96, lon: 12.8 }, day: "2026-12-05" });
  assert.deepEqual([...rows.keys()].sort(), ["u1|trip000001|Rzym", "u1|trip000001|Tivoli"]);
  assert.equal((await planner.saved("u1", { tid: "trip000001", city: "Tivoli" })).days[0].day, "2026-12-05");
  assert.equal((await planner.saved("u1", { tid: "trip000001", city: "Rzym" })).days[0].day, "2026-12-04");
});

test("a plan's stops can be moved, removed and added by hand", () => {
  // The trip's own city plan: up/down and delete on each stop, for the owner; new stops come from "Dodaj do planu".
  assert.match(app, /data-lp-move="\$\{esc\(x\.id\)\}" data-dir="-1"/);
  assert.match(app, /data-lp-remove="\$\{esc\(x\.id\)\}"/);
  assert.match(app, /const lr=e\.target\.closest\('\[data-lp-remove\]'\); if\(lr\)\{ removeLocalTrip\(f, lr\.dataset\.lpRemove\)/);
  assert.match(app, /const lm=e\.target\.closest\('\[data-lp-move\]'\); if\(lm\)\{ moveLocalTrip\(f, lm\.dataset\.lpMove, \+lm\.dataset\.dir\)/);
  assert.match(app, /Dodaj do planu/);
  // The AI plan: the day's order can be fitted again and the plan regenerated with other preferences.
  assert.match(app, /data-ai-fit="\$\{di\}"/);
  assert.match(app, /data-ai-style/);
});

test("Rzeszów's \"Szukaj połączenia\" is the same city planner page as Warszawa's", () => {
  const app = read("assets/app.js");
  // Transitous carries ZTM Rzeszów and PKS Rzeszów, so the search tab uses the shared city page for Rzeszów too.
  assert.match(app, /const searchTxCity=\(\)=>txCity\(\)\|\|\(LOCAL_TRANSIT\.has\(TCITY\.name\)\?RZ_TX:null\)/);
  assert.match(app, /S\.agency==='ztm' && S\.sub==='' \? searchTxCity\(\)/);
  // no separate Rzeszów header or Miejskie/Podmiejskie switch on the search tab
  assert.match(app, /const kinds=local&&bus&&!searchTab\?/);
  assert.match(app, /const head=local&&bus&&!searchTab\?/);
});
