"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.resolve(__dirname, "../assets/app.js"), "utf8");

function loadTrainPlanner(trains) {
  const context = { TR: { trains }, railName: (id) => id, RAIL_SEARCH_HOURS: 14 };
  const start = source.indexOf("function planTrainTrips(");
  vm.runInNewContext(source.slice(start, source.indexOf("/* ---------- okienko pociągu")), context);
  return (from, to, at) => context.planTrainTrips(from, to, at, trains);
}

function loadRailTargets(names, nearby = []) {
  const points = { "Rzeszów Główny": [50.043, 22.006], "Rzeszów Załęże": [50.059, 22.07] };
  const context = {
    HOME_STATION: "Rzeszów Główny",
    railStationNames: () => names,
    stopPoint: (name) => points[name] || null,
    stationsNear: () => nearby,
    hav: (a, b) => Math.round(Math.hypot(a[0] - b[0], a[1] - b[1]) * 100000),
  };
  vm.runInNewContext(`${source.slice(source.indexOf("function placeCity("), source.indexOf("function stopsAtStation("))}; this.railTargets = railTargets;`, context);
  return (place) => Array.from(context.railTargets({ points: [], ...place }), (station) => station.name);
}

const stations = ["Kraków Płaszów", "Kraków Główny", "Krakówek", "Tarnów", "Rzeszów Załęże", "Rzeszów Główny"];

test("a city leads to its stations, the main one first", () => {
  const targets = loadRailTargets(stations);
  assert.deepEqual(targets({ label: "Kraków", place: { label: "Kraków", locality: "Kraków" } }), ["Kraków Główny", "Kraków Płaszów"]);
});

test("a street leads to the stations of its city", () => {
  const targets = loadRailTargets(stations);
  assert.equal(targets({ label: "Floriańska 10, Kraków", place: { label: "Floriańska 10, Kraków", locality: "Kraków" } })[0], "Kraków Główny");
});

test("a typed station is used exactly", () => {
  assert.deepEqual(loadRailTargets(stations)({ label: "Kraków Płaszów", station: "Kraków Płaszów" }), ["Kraków Płaszów"]);
});

test("a place without its own station uses the nearest ones and the main Rzeszów station", () => {
  const targets = loadRailTargets(stations, [{ name: "Rzeszów Załęże" }]);
  assert.deepEqual(targets({ label: "Tyczyn", points: [[50.0, 22.0]], place: { label: "Tyczyn", locality: "Tyczyn" } }), ["Rzeszów Główny", "Rzeszów Załęże"]);
});

const stop = (id, predDep, predArr = predDep) => ({ id, predDep, predArr, cn: false });
const train = (key, stops, extra = {}) => ({ key, stops, cancelled: false, ...extra });

test("the train planner lists direct trains in departure order", () => {
  const plan = loadTrainPlanner([
    train("later", [stop("A", 2000), stop("B", 2600)]),
    train("sooner", [stop("A", 1500), stop("C", 1800), stop("B", 2100)]),
  ]);
  assert.deepEqual(Array.from(plan("A", "B", 1000), (result) => result.t.key), ["sooner", "later"]);
});

test("the train planner respects direction, departure time, and cancellations", () => {
  const plan = loadTrainPlanner([
    train("wrong-way", [stop("B", 1500), stop("A", 1800)]),
    train("gone", [stop("A", 100), stop("B", 400)]),
    train("too-far", [stop("A", 1000 + 15 * 3600), stop("B", 1000 + 16 * 3600)]),
    train("cancelled", [stop("A", 1500), stop("B", 1800)], { cancelled: true }),
    train("stop-cancelled", [{ ...stop("A", 1500), cn: true }, stop("B", 1800)]),
    train("ok", [stop("A", 1600), stop("B", 1900)]),
  ]);
  assert.deepEqual(Array.from(plan("A", "B", 1000), (result) => result.t.key), ["ok"]);
});

function loadPaging() {
  const context = {};
  vm.runInNewContext(source.slice(source.indexOf("function paginate("), source.indexOf("function pagerHtml(")), context);
  return context;
}

test("timetable pages split rows and stay in range", () => {
  const { paginate } = loadPaging();
  const rows = Array.from({ length: 45 }, (_, index) => index);
  const middle = paginate(rows, 2, 20);
  assert.deepEqual([middle.page, middle.pages, middle.total, middle.rows.length, middle.rows[0]], [2, 3, 45, 20, 20]);
  assert.equal(paginate(rows, 99, 20).page, 3);
  assert.equal(paginate(rows, 99, 20).rows.length, 5);
  assert.equal(paginate(rows, 0, 20).page, 1);
  assert.deepEqual([paginate([], 1, 20).pages, paginate([], 1, 20).rows.length], [1, 0]);
});

test("the timetable opens on the page with the next departure", () => {
  const { pageOfNow } = loadPaging();
  const times = Array.from({ length: 45 }, (_, index) => index * 10);
  const same = (value) => value;
  assert.equal(pageOfNow(times, 20, same, 0), 1);
  assert.equal(pageOfNow(times, 20, same, 185), 1);
  assert.equal(pageOfNow(times, 20, same, 195), 2);
  assert.equal(pageOfNow(times, 20, same, 9999), 3);
  assert.equal(pageOfNow([], 20, same, 0), 1);
});

function loadTripModes() {
  const context = {};
  const start = source.indexOf("const WALK_MAX_KM=");
  vm.runInNewContext(`${source.slice(start, source.indexOf("function fmtKm("))}; this.tripModes = tripModes; this.bestMode = bestMode; this.transitName = transitName;`, context);
  return context;
}

const none = { transit: false, rail: false, flights: false };

test("a short trip offers walking and a nearby bus", () => {
  const { tripModes, bestMode } = loadTripModes();
  const modes = tripModes(0.8, { ...none, transit: true });
  assert.deepEqual([...modes], ["walk", "transit"]);
  assert.equal(bestMode(0.8, modes, { walk: 900, transit: 600 }), "walk");
});

test("the fastest option is recommended when walking is not obvious", () => {
  const { tripModes, bestMode } = loadTripModes();
  const modes = tripModes(12, { ...none, transit: true, rail: true });
  assert.deepEqual([...modes], ["transit", "rail"]);
  assert.equal(bestMode(12, modes, { transit: 2000, rail: 1500 }), "rail");
});

test("a car is suggested only when nothing else is available", () => {
  const { tripModes } = loadTripModes();
  assert.deepEqual([...tripModes(90, none)], ["car"]);
  assert.deepEqual([...tripModes(2, none)], ["walk"]);
  assert.deepEqual([...tripModes(90, { ...none, rail: true })], ["rail"]);
  assert.deepEqual([...tripModes(null, none)], ["car"]);
});

test("a flight is the recommendation for a far destination, and no car appears while flights load", () => {
  const { tripModes, bestMode } = loadTripModes();
  const modes = tripModes(1800, { ...none, flights: true });
  assert.equal(bestMode(1800, modes, {}), "flight");
  assert.deepEqual([...tripModes(1800, { ...none, pending: true })], []);
  assert.deepEqual([...tripModes(1800, none)], ["car"]);
});

test("airports are grouped by country, Poland first, and only compatible ones count as served", () => {
  const context = { natSort: (a, b) => a.localeCompare(b) };
  vm.runInNewContext(`${source.slice(source.indexOf("function airportGroups("), source.indexOf("function airportSelect("))}; this.airportGroups = airportGroups;`, context);
  const airports = [
    { code: "BCN", label: "Barcelona (BCN)", country: "Hiszpania" },
    { code: "ALC", label: "Alicante (ALC)", country: "Hiszpania" },
    { code: "RZE", label: "Rzeszów (RZE)", country: "Polska" },
    { code: "KRK", label: "Kraków (KRK)", country: "Polska" },
  ];
  const stored = [{ from: "RZE", to: "ALC" }];
  const network = [{ from: "RZE", to: "ALC" }, { from: "KRK", to: "BCN" }, { from: "KRK", to: "ALC" }];
  const groups = context.airportGroups(airports, stored, network, "to", "KRK");
  assert.deepEqual([...groups].map((group) => group.country), ["Polska", "Hiszpania"]);
  assert.deepEqual([...groups[1].items].map((airport) => [airport.code, airport.stored, airport.served]), [["ALC", false, true], ["BCN", false, true]]);
  const fromRzeszow = context.airportGroups(airports, stored, network, "to", "RZE");
  assert.deepEqual([...fromRzeszow[1].items].map((airport) => [airport.code, airport.stored, airport.served]), [["ALC", true, true], ["BCN", false, false]]);
  const origins = context.airportGroups(airports, stored, network, "from", "");
  assert.deepEqual([...origins[0].items].map((airport) => [airport.code, airport.served]), [["RZE", true], ["KRK", true]]);
});

test("the earliest return counts the start day as a day at the destination", () => {
  const context = {};
  const start = source.indexOf("function earliestReturnDay(");
  vm.runInNewContext(`${source.slice(start, source.indexOf("function syncReturn("))}; this.earliestReturnDay = earliestReturnDay;`, context);
  assert.equal(context.earliestReturnDay("2026-12-01", 3), "2026-12-03");
  assert.equal(context.earliestReturnDay("2026-12-01", 1), "2026-12-01");
  assert.equal(context.earliestReturnDay("2026-12-30", 5), "2027-01-03");
});

test("a trip is named after what it uses", () => {
  const { transitName } = loadTripModes();
  assert.equal(transitName({ legs: [{ agency: "ztm" }] }), "Autobus");
  assert.equal(transitName({ legs: [{ agency: "pks" }] }), "PKS");
  assert.equal(transitName({ legs: [{ agency: "ztm" }, { agency: "pks" }] }), "Autobus + PKS");
});

test("each category has its own page and weather refreshes every 45 minutes", () => {
  assert.match(source, /ztm:\{path:'\/autobusy'/);
  assert.match(source, /pks:\{path:'\/pks'/);
  assert.match(source, /kolej:\{path:'\/pociagi'/);
  assert.match(source, /podroz:\{path:'\/podroz'/);
  assert.doesNotMatch(source, /koncowe/);
  assert.match(source, /weatherTick\(\); \}, 45\*60\*1000\)/);
});
