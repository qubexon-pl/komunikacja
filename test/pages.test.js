"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.resolve(__dirname, "../assets/app.js"), "utf8");
const html = fs.readFileSync(path.resolve(__dirname, "../index.html"), "utf8");

// The page switcher, run with stand-ins for everything it calls; any name it uses that is not listed here fails the test.
function loadSubpage() {
  const page = { title: "", lead: "", banner: "", url: "" };
  const el = (id) => ({ set textContent(v) { if (id === "heroLead") page.lead = v; }, innerHTML: "" });
  const VIEWS = {
    podroz: { title: "Zaplanuj podróż", lead: "planer" }, ztm: { title: "Autobusy", lead: "ztm" },
    pks: { title: "Komunikacja podmiejska", lead: "pks" }, kolej: { title: "Pociągi w Polsce", lead: "kolej" },
  };
  const context = {
    S: { agency: "podroz", sub: "kierunki" }, VIEWS, FAVF: { kind: "all" }, TRIPV: { id: "" }, MYT: { tab: "upcoming" }, APP_NAME: "podavo.voyage",
    FAV_TITLES: { all: "Ulubione" }, EXPLORE: { summary: "" },
    document: { getElementById: el, body: { classList: { toggle() {} } }, title: "" },
    location: { pathname: "/destinations", search: "", hash: "" }, history: { replaceState: (a, b, url) => { page.url = url; } },
    setHeroTitle: (t) => { page.title = t; }, updateBanner: () => { page.banner = context.S.sub; },
    pageUrl: (view, sub) => `${view}/${sub}`, findTrip: () => null, tripLead: () => "",
    syncNav() {}, renumberSections() {}, renderBoard() {}, renderTimetable() {}, renderFavorites() {}, renderMyTrips() {},
    renderTripPage() {}, stopVehicles() {}, setTimeout() {}, renderEditBadge() {},
  };
  const start = source.indexOf("function setSubpage(");
  vm.runInNewContext(source.slice(start, source.indexOf("\n}\n", start) + 3), context);
  return (view, sub) => { context.S.agency = view; context.setSubpage(sub); return { ...page, sub: context.S.sub }; };
}

test("leaving the destinations page updates the title, banner and address on every page", () => {
  const go = loadSubpage();
  assert.equal(go("podroz", "kierunki").title, "Sprawdź kierunki");
  for (const [view, sub, title] of [["podroz", "", "Zaplanuj podróż"], ["ztm", "", "Autobusy miejskie"], ["pks", "", "Autobusy podmiejskie"],
    ["kolej", "", "Pociągi w Polsce"], ["ztm", "rozklad", "Rozkład jazdy"], ["podroz", "ulubione", "Ulubione"], ["podroz", "moje", "Moje podróże"]]) {
    const page = go(view, sub);
    assert.equal(page.title, title, `${view}/${sub}`);
    assert.equal(page.sub, sub);
    assert.equal(page.url, `${view}/${sub}`);
  }
});

function loadTrainPlanner(trains) {
  const context = { TR: { trains }, railName: (id) => id, RAIL_SEARCH_HOURS: 14 };
  const start = source.indexOf("function planTrainTrips(");
  vm.runInNewContext(source.slice(start, source.indexOf("/* ---------- okienko pociągu")), context);
  return (from, to, at, by) => context.planTrainTrips(from, to, at, trains, by);
}

function loadRailTargets(names, nearby = [], counts = new Map()) {
  const points = { "Rzeszów Główny": [50.043, 22.006], "Rzeszów Załęże": [50.059, 22.07] };
  const context = {
    HOME_STATION: "Rzeszów Główny",
    railStopCounts: () => counts,
    railStationNames: () => names,
    stopPoint: (name) => points[name] || null,
    stationsNear: () => nearby,
    hav: (a, b) => Math.round(Math.hypot(a[0] - b[0], a[1] - b[1]) * 100000),
  };
  vm.runInNewContext(`${source.slice(source.indexOf("function placeCity("), source.indexOf("function stopsAtStation("))}; this.railTargets = railTargets;`, context);
  return (place) => Array.from(context.railTargets({ points: [], ...place }), (station) => station.name);
}

function loadStopFamily(names) {
  const context = { GT: { groups: new Map(names.map((name, i) => [name, { name, lat: 50 + i, lon: 22 }])) }, groupInView: () => true, stopPoint: (name) => [50 + names.indexOf(name), 22] };
  vm.runInNewContext(`${source.slice(source.indexOf("function stopFamily("), source.indexOf("function placeTitle("))}; this.stopFamily = stopFamily;`, context);
  return context.stopFamily;
}

test("a stop name without a number means all of its platforms", () => {
  const family = loadStopFamily(["Rzeszów D.A. 5", "Rzeszów D.A. 10", "Rzeszów D.A. dworzec 1", "Rzeszów Główny"])("rzeszów d.a.");
  assert.equal(family.label, "Rzeszów D.A.");
  assert.deepEqual(Array.from(family.names), ["Rzeszów D.A. 5", "Rzeszów D.A. 10"]);
  assert.deepEqual(Array.from(family.points[0]), [50.5, 22]);
});

test("a name that only starts the same is not a platform", () => {
  assert.equal(loadStopFamily(["Rzeszów D.A. dworzec 1"])("rzeszów"), null);
});

function loadTransitBy(lastStart) {
  const asked = [];
  const trip = { arr: 11000, walkTo: 0 };
  const context = { planTrips: (origin, dest, at) => { asked.push(at); return at <= lastStart ? [trip] : []; } };
  vm.runInNewContext(`${source.slice(source.indexOf("function transitBy("), source.indexOf("function planTransit("))}; this.transitBy = transitBy;`, context);
  return { asked, transitBy: context.transitBy };
}

test("a deadline search steps back gently, so the latest connection is not skipped", () => {
  const { asked, transitBy } = loadTransitBy(12000 - 2 * 3600);
  assert.equal(transitBy({}, {}, 12000, 0).length, 1);
  assert.deepEqual(asked.map((at) => (12000 - at) / 3600), [0.5, 1, 1.5, 2]);
});

test("a deadline search never starts before the journey can begin", () => {
  const { asked, transitBy } = loadTransitBy(-1);
  assert.equal(transitBy({}, {}, 12000, 10000).length, 0);
  assert.equal(asked.at(-1), 10000);
  assert.ok(asked.every((at) => at >= 10000));
});

function loadLiveFor(now) {
  const context = { nowSec: () => now, S: { byTrip: new Map([["trip", { stopSeq: 9, delay: 300 }]]), tripUpdates: new Map() } };
  vm.runInNewContext(`${source.slice(source.indexOf("const LIVE_WINDOW_SEC="), source.indexOf("function liveChip("))}; this.liveFor = liveFor;`, context);
  return context.liveFor;
}

test("a bus running a trip today says nothing about the same trip on another day", () => {
  const stops = [{ dep: 3600, seq: 1 }];
  const today = 1000000;
  const liveFor = loadLiveFor(today + 3600);
  assert.equal(liveFor("trip", stops, 0, today).state, "passed");
  const monday = liveFor("trip", stops, 0, today + 3 * 86400);
  assert.equal(monday.state, "sched");
  assert.equal(monday.pred, today + 3 * 86400 + 3600);
});

function loadTrainViews() {
  const names = { 1: "Rzeszów Główny", 2: "Kraków Główny", 3: "Łódź Fabryczna" };
  const context = { TR: { carriers: new Map([["IC", "PKP Intercity"]]) }, railName: (id) => names[id] };
  vm.runInNewContext(`${source.slice(source.indexOf("const TRAIN_GONE_SEC="), source.indexOf("function trainPosition("))}${source.slice(source.indexOf("const foldText="), source.indexOf("function boardRows("))}; this.trainEnded = trainEnded; this.boardMatches = boardMatches;`, context);
  return context;
}

test("a train counts as ended a few minutes after its last arrival, however late it runs", () => {
  const { trainEnded } = loadTrainViews();
  const stops = (last) => ({ stops: [{ pDep: 100 }, last] });
  assert.equal(trainEnded(stops({ pArr: 1000, predArr: 1000 }), 1200), false);
  assert.equal(trainEnded(stops({ pArr: 1000, predArr: 1000 }), 1400), true);
  assert.equal(trainEnded(stops({ pArr: 1000, predArr: 2000 }), 1400), false);
  assert.equal(trainEnded(stops({ pArr: 1000, predArr: 2000, aArr: 1100 }), 1500), true);
  assert.equal(trainEnded(stops({}), 1400), false);
});

test("the timetable search finds number, name, carrier and stations on the way, with or without Polish letters", () => {
  const { boardMatches } = loadTrainViews();
  const row = { t: { cat: "IC", num: "3810", label: "IC 3810", name: "KOSSAK", from: "Rzeszów Główny", to: "Łódź Fabryczna", carrier: "IC", stops: [{ id: 1 }, { id: 2 }, { id: 3 }] } };
  for (const query of ["3810", "kossak", "krakow", "KRAKÓW", "lodz", "intercity", ""]) assert.equal(boardMatches(row, query), true, query);
  assert.equal(boardMatches(row, "gdańsk"), false);
});

function loadTrainRowStop() {
  const names = { 1: "Tarnów", 2: "Rzeszów Główny", 3: "Rzeszów Załęże", 4: "Kraków Główny" };
  const context = { RAIL_ST: { 2: [], 3: [] }, railName: (id) => names[id], todayMidnight: () => 0 };
  context.foldedStation = (id) => names[id].toLowerCase().replace(/ł/g, "l").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  vm.runInNewContext(`${source.slice(source.indexOf("const foldText="), source.indexOf("// Szukamy też po stacjach"))}${source.slice(source.indexOf("function trainRowStop("), source.indexOf("function allStationRows("))}; this.trainRowStop = trainRowStop;`, context);
  return (train, kind, now, query) => context.trainRowStop(train, kind, now, query)?.x.id ?? null;
}

const stopAt = (id, time) => ({ id, pArr: time, pDep: time, predArr: time, predDep: time });
const line = { stops: [stopAt(1, 1000), stopAt(2, 2000), stopAt(3, 3000), stopAt(4, 4000)] };

test("with all stations, a train appears at its next stop around Rzeszów", () => {
  const rowStop = loadTrainRowStop();
  assert.equal(rowStop(line, "dep", 500), 2);
  assert.equal(rowStop(line, "dep", 2500), 3);
  assert.equal(rowStop({ stops: [stopAt(1, 1000), stopAt(4, 4000)] }, "dep", 500), 1);
  assert.equal(rowStop(line, "dep", 3500), null);
});

test("searching a station shows the train at that stop, wherever it is on the route", () => {
  const rowStop = loadTrainRowStop();
  assert.equal(rowStop(line, "arr", 500, "krakow"), 4);
  assert.equal(rowStop(line, "dep", 500, "tarnow"), 1);
  assert.equal(rowStop(line, "dep", 1500, "tarnow"), null);
});

test("a search that is not a station keeps the train at its next stop", () => {
  assert.equal(loadTrainRowStop()(line, "dep", 500, "3810"), 2);
});

test("a train cannot depart from its last stop or arrive at its first", () => {
  const rowStop = loadTrainRowStop();
  assert.equal(rowStop(line, "dep", 500, "krakow"), null);
  assert.equal(rowStop(line, "arr", 500, "tarnow"), null);
});

function loadRailSearch() {
  const context = { };
  vm.runInNewContext(`${source.slice(source.indexOf("const RAIL_TRANSFER_SEC="), source.indexOf("function planTrainTrips("))}; this.railJourney = railJourney; this.railJourneys = railJourneys;`, context);
  return context;
}

const call = (id, arrive, depart = arrive) => ({ id, predArr: arrive, predDep: depart });
const trainOf = (key, ...stops) => ({ key, stops });
const route = (parts) => parts && Array.from(parts, (part) => `${part.t.key}:${part.a.id}-${part.b.id}`);

test("a journey with one change is found when no train goes all the way", () => {
  const { railJourney } = loadRailSearch();
  const trains = [trainOf("first", call(1, 1000), call(2, 2000)), trainOf("second", call(2, 3000), call(3, 4000))];
  assert.deepEqual(route(railJourney(trains, new Map([[1, 900]]), new Set([3]), 99999)), ["first:1-2", "second:2-3"]);
});

test("a change needs enough time between trains", () => {
  const { railJourney } = loadRailSearch();
  const trains = [trainOf("first", call(1, 1000), call(2, 2000)), trainOf("tight", call(2, 2200), call(3, 3000)), trainOf("fine", call(2, 2600), call(3, 3500))];
  assert.deepEqual(route(railJourney(trains, new Map([[1, 900]]), new Set([3]), 99999)), ["first:1-2", "fine:2-3"]);
});

test("a direct train wins unless a change saves real time", () => {
  const { railJourney } = loadRailSearch();
  const direct = trainOf("direct", call(1, 1000), call(3, 9000));
  const pair = (end) => [trainOf("first", call(1, 1000), call(2, 2000)), trainOf("second", call(2, 3000), call(3, end))];
  assert.deepEqual(route(railJourney([direct, ...pair(8800)], new Map([[1, 900]]), new Set([3]), 99999)), ["direct:1-3"]);
  assert.deepEqual(route(railJourney([direct, ...pair(7000)], new Map([[1, 900]]), new Set([3]), 99999)), ["first:1-2", "second:2-3"]);
});

test("up to two changes are allowed, not three", () => {
  const { railJourney } = loadRailSearch();
  const leg = (from, time) => trainOf(`t${from}`, call(from, time), call(from + 1, time + 500));
  const trains = [leg(1, 1000), leg(2, 3000), leg(3, 5000), leg(4, 7000)];
  assert.equal(railJourney(trains, new Map([[1, 900]]), new Set([4]), 99999).length, 3);
  assert.equal(railJourney(trains, new Map([[1, 900]]), new Set([5]), 99999), null);
});

test("cancelled trains and stops are not used", () => {
  const { railJourney } = loadRailSearch();
  const gone = { ...trainOf("gone", call(1, 1000), call(3, 2000)), cancelled: true };
  const skipped = trainOf("skipped", call(1, 1000), { ...call(3, 2000), cn: true });
  assert.equal(railJourney([gone, skipped], new Map([[1, 900]]), new Set([3]), 99999), null);
});

test("a trip with fewer changes stays next to a later one arriving at the same time", () => {
  const { railJourneys } = loadRailSearch();
  const trains = [
    trainOf("carpatia", call(1, 1000), call(2, 3000)),
    trainOf("ursa", call(1, 2000), call(2, 4000)),
    trainOf("lokietek", call(2, 4600), call(5, 5000)),
    trainOf("ustronie", call(2, 4300), call(5, 5800), call(3, 9000)),
  ];
  assert.deepEqual(Array.from(railJourneys(trains, new Map([[1, 900]]), new Set([3]), 99999), route), [["carpatia:1-2", "ustronie:2-3"], ["ursa:1-2", "lokietek:2-5", "ustronie:5-3"]]);
});

test("nobody is sent to wait for hours at a change", () => {
  const { railJourney } = loadRailSearch();
  const trains = [trainOf("first", call(1, 1000), call(2, 2000)), trainOf("next day", call(2, 2000 + 4 * 3600), call(3, 2000 + 5 * 3600))];
  assert.equal(railJourney(trains, new Map([[1, 900]]), new Set([3]), 99999), null);
});

test("a trip that comes back through the start is not offered", () => {
  const { railJourneys } = loadRailSearch();
  const trains = [trainOf("away", call(1, 1000), call(2, 1500)), trainOf("through", call(2, 2100), call(1, 2600), call(3, 4000))];
  assert.deepEqual(Array.from(railJourneys(trains, new Map([[1, 900]]), new Set([3]), 99999), route), [["through:1-3"]]);
});

test("nobody is sent ahead to wait for a train that has just left the start", () => {
  const { railJourneys } = loadRailSearch();
  const trains = [trainOf("ahead", call(1, 1000), call(2, 1500)), trainOf("same line", call(1, 4000), call(2, 5000), call(3, 6000))];
  assert.equal(railJourneys(trains, new Map([[1, 900]]), new Set([3]), 2000).length, 0);
});

test("more changes are offered when they get you there sooner or let you leave later", () => {
  const { railJourneys } = loadRailSearch();
  const trains = [
    trainOf("direct", call(1, 1000), call(3, 9000)),
    trainOf("first", call(1, 2000), call(2, 3000)),
    trainOf("second", call(2, 4000), call(4, 5000)),
    trainOf("third", call(4, 6000), call(3, 8900)),
  ];
  assert.deepEqual(Array.from(railJourneys(trains, new Map([[1, 900]]), new Set([3]), 99999), (parts) => parts.length), [1, 3]);
});

test("options come sorted by departure", () => {
  const { railJourneys } = loadRailSearch();
  const trains = [trainOf("late", call(1, 5000), call(3, 6000)), trainOf("early", call(1, 2000), call(3, 3000))];
  assert.deepEqual(Array.from(railJourneys(trains, new Map([[1, 900]]), new Set([3]), 99999), (parts) => parts[0].t.key), ["early", "late"]);
});

test("several options are offered, without ones that leave earlier and arrive later", () => {
  const { railJourneys } = loadRailSearch();
  const trains = [trainOf("slow", call(1, 1000), call(3, 9000)), trainOf("fast", call(1, 2000), call(3, 3000)), trainOf("next", call(1, 4000), call(3, 5000))];
  assert.deepEqual(Array.from(railJourneys(trains, new Map([[1, 900]]), new Set([3]), 99999), route).map((parts) => parts[0]), ["fast:1-3", "next:1-3"]);
});

test("a time window limits the departure, not the train after a change", () => {
  const { railJourney } = loadRailSearch();
  const trains = [trainOf("first", call(1, 1000), call(2, 2000)), trainOf("second", call(2, 5000), call(3, 6000))];
  assert.deepEqual(route(railJourney(trains, new Map([[1, 900]]), new Set([3]), 1500)), ["first:1-2", "second:2-3"]);
  assert.equal(railJourney(trains, new Map([[1, 900]]), new Set([3]), 900), null);
});

function loadRoutePlaces() {
  const context = { RAIL_SEARCH_HOURS: 14 };
  vm.runInNewContext(`${source.slice(source.indexOf("const foldText="), source.indexOf("// Szukamy też po stacjach"))}${source.slice(source.indexOf("function findRailCities("), source.indexOf("function railCities("))}${source.slice(source.indexOf("function railPlaceNames("), source.indexOf("function connectionRoute("))}; this.findRailCities = findRailCities; this.railPlaceNames = railPlaceNames; this.routeWindow = routeWindow;`, context);
  return context;
}

const railNames = ["Kraków Główny", "Kraków Płaszów", "Kraków Bieżanów", "Kraków Bieżanów Drogowa", "Krakówek", "Nowy Sącz", "Nowy Sącz Miasto", "Nowy Targ", "Nowy Dwór", "Tarnów", "Warszawa Centralna", "Warszawa Wschodnia", "Łódź Fabryczna"];

test("a city needs several stations and a main one, so a shared first word is not a city", () => {
  assert.deepEqual(Array.from(loadRoutePlaces().findRailCities(railNames)).sort(), ["Kraków", "Nowy Sącz", "Warszawa"]);
});

test("a city search prefers its main station, and uses the others only when there is none", () => {
  const context = {};
  vm.runInNewContext(`${source.slice(source.indexOf("const isCityMain="), source.indexOf("function routeWindow("))}; this.routeStations = routeStations;`, context);
  assert.deepEqual(Array.from(context.routeStations(["Kraków Płaszów", "Kraków Główny"])), ["Kraków Główny"]);
  assert.deepEqual(Array.from(context.routeStations(["Warszawa Wschodnia", "Warszawa Centralna"])), ["Warszawa Centralna"]);
  assert.deepEqual(Array.from(context.routeStations(["Tarnów", "Tarnów Filia"])), ["Tarnów", "Tarnów Filia"]);
});

test("a typed city means all its stations, and a typed station means exactly that one", () => {
  const { findRailCities, railPlaceNames } = loadRoutePlaces();
  const places = (text) => Array.from(railPlaceNames(text, railNames, findRailCities(railNames)));
  assert.deepEqual(places("krakow"), ["Kraków Główny", "Kraków Płaszów", "Kraków Bieżanów", "Kraków Bieżanów Drogowa"]);
  assert.deepEqual(places("Kraków Płaszów"), ["Kraków Płaszów"]);
  assert.deepEqual(places("lodz"), ["Łódź Fabryczna"]);
  assert.deepEqual(places("xyz"), []);
});

test("a time period is used as typed, and blank fields mean now or the whole day", () => {
  const { routeWindow } = loadRoutePlaces();
  const window = (...args) => { const { start, end } = routeWindow(...args); return [start, end]; };
  const hour = 3600;
  assert.deepEqual(window("", "08:00", "12:00", "2026-11-06", 0, 5 * hour), [8 * hour, 12 * hour]);
  assert.deepEqual(window("", "", "", "2026-11-06", 0, 5 * hour), [5 * hour, 19 * hour]);
  assert.deepEqual(window("2026-11-07", "", "", "2026-11-06", 1000, 5 * hour), [1000, 1000 + 24 * hour]);
  assert.deepEqual(window("2026-11-07", "09:00", "", "2026-11-06", 0, 5 * hour), [9 * hour, 23 * hour]);
  assert.deepEqual(window("", "22:00", "01:00", "2026-11-06", 0, 5 * hour), [22 * hour, 25 * hour]);
});

function loadServices({ cal = [], dates = {}, trips = [] }) {
  const GT = { cal: new Map(cal), calDates: new Map(Object.entries(dates).map(([sid, list]) => [sid, new Map(Object.entries(list))])), samples: new Map(), trips: new Map(trips.map((service, index) => [String(index), { service }])) };
  const context = { GT };
  vm.runInNewContext(`${source.slice(source.indexOf("const svcCache="), source.indexOf("// Rozkład scala kilka wersji"))}; this.serviceOn = serviceOn; this.sampleDay = sampleDay; this.estimatedAgencies = estimatedAgencies; this.estimateNote = estimateNote;`, context);
  return context;
}

// 2026-12-14 is a Monday; 2026-12-25 a Friday holiday with few buses.
const friday = { ymd: "20270108", wd: 4 };
const monday = { ymd: "20270104", wd: 0 };
const publishedDays = {
  normal: { 20261204: 1, 20261211: 1, 20261214: 1, 20261218: 1 },
  holiday: { 20261225: 1 },
};
const busTrips = ["normal", "normal", "normal", "holiday"];

test("past the last published day, a normal day of the same weekday is used", () => {
  const { serviceOn, sampleDay } = loadServices({ dates: publishedDays, trips: busTrips });
  assert.equal(sampleDay("ztm", friday).ymd, "20261204");
  assert.equal(serviceOn("normal", friday), true);
  assert.equal(serviceOn("holiday", friday), false);
  assert.equal(serviceOn("normal", monday), true);
});

test("published days stay exact and carry no warning", () => {
  const { estimatedAgencies, serviceOn } = loadServices({ dates: publishedDays, trips: busTrips });
  const christmas = { ymd: "20261225", wd: 4 };
  assert.equal(serviceOn("normal", christmas), false);
  assert.equal(serviceOn("holiday", christmas), true);
  assert.equal(estimatedAgencies(christmas).length, 0);
  assert.deepEqual(Array.from(estimatedAgencies(friday)), ["ztm"]);
});

test("each provider has its own last published day", () => {
  const { estimatedAgencies } = loadServices({ dates: { ...publishedDays, "pks:all": { 20270201: 1 } }, trips: [...busTrips, "pks:all"] });
  assert.deepEqual(Array.from(estimatedAgencies(friday)), ["ztm"]);
});

test("weekly calendars are understood as well as single dates", () => {
  const days = [true, true, true, true, true, false, false];
  const { serviceOn } = loadServices({ cal: [["week", { days, start: "20261101", end: "20261220" }]], trips: ["week"] });
  assert.equal(serviceOn("week", friday), true);
  assert.equal(serviceOn("week", { ymd: "20270109", wd: 5 }), false);
});

test("the warning names the provider, the date and the weekday", () => {
  const { estimateNote } = loadServices({ dates: publishedDays, trips: busTrips });
  const note = estimateNote(["ztm", "pks"], friday);
  assert.match(note, /ZTM i Komunikacja podmiejska/);
  assert.match(note, /08\.01/);
  assert.match(note, /piątek/);
  assert.match(note, /niedokładny/);
});

function loadConnections() {
  const context = {};
  vm.runInNewContext(`${source.slice(source.indexOf("const RAIL_TRANSFER_SEC="), source.indexOf("function railJourneys("))}${source.slice(source.indexOf("const ROUTE_SLOW_FACTOR="), source.indexOf("function planTrainTrips("))}; this.railConnections = railConnections;`, context);
  return (trains, starts, targets, limit, preferred) => Array.from(context.railConnections(trains, new Map(starts), new Set(targets), limit, new Set(preferred)), route);
}

test("every departure gets a row, even when a later train reaches the same arrival", () => {
  const connections = loadConnections();
  const trains = [trainOf("przemyslanin", call(1, 1000), call(2, 2000)), trainOf("rj", call(1, 1500), call(2, 2400)), trainOf("karpaty", call(2, 3000), call(3, 5000))];
  assert.deepEqual(connections(trains, [[1, 900]], [3], 99999), [["przemyslanin:1-2", "karpaty:2-3"], ["rj:1-2", "karpaty:2-3"]]);
});

test("a train leaving another station of the city is included, and one calling at the main station starts there", () => {
  const connections = loadConnections();
  const trains = [trainOf("bieszczady", call(7, 1000), call(3, 2000)), trainOf("both", call(7, 1500), call(1, 1600), call(3, 2600))];
  assert.deepEqual(connections(trains, [[1, 900], [7, 900]], [3], 99999, [1]), [["bieszczady:7-3"], ["both:1-3"]]);
});

test("a departure may show a quick trip and a simpler slower one", () => {
  const connections = loadConnections();
  const trains = [trainOf("first", call(1, 1000), call(2, 2000), call(3, 9000)), trainOf("fast", call(2, 3000), call(3, 4000))];
  assert.deepEqual(connections(trains, [[1, 900]], [3], 99999), [["first:1-2", "fast:2-3"]]);
});

test("the period limits the first train only, and a far slower trip is left out", () => {
  const connections = loadConnections();
  const trains = [trainOf("in", call(1, 1000), call(2, 2000)), trainOf("after", call(2, 3000), call(3, 4000)), trainOf("outside", call(1, 5000), call(3, 6000)), trainOf("crawl", call(1, 1200), call(3, 20000))];
  assert.deepEqual(connections(trains, [[1, 900]], [3], 1500), [["in:1-2", "after:2-3"]]);
});

function loadTrackBetween() {
  const context = {};
  vm.runInNewContext(`${source.slice(source.indexOf("function trackBetween("), source.indexOf("function trainSegment("))}; this.trackBetween = trackBetween;`, context);
  return (tracks, ids) => { const line = context.trackBetween(tracks, ids); return line && Array.from(line, (point) => Array.from(point)); };
}

test("a train follows the track holding most of its stations, cut at the stations it uses", () => {
  const trackBetween = loadTrackBetween();
  const other = { at: { 1: 0, 3: 1 }, points: [[1, 1], [3, 3]] };
  const line = { at: { 1: 0, 2: 2, 3: 3, 4: 4 }, points: [[1, 1], [1.5, 1.5], [2, 2], [3, 3], [4, 4]] };
  assert.deepEqual(trackBetween([other, line], [1, 2, 3]), [[1, 1], [1.5, 1.5], [2, 2], [3, 3]]);
});

test("a train can use a track laid out in the opposite direction", () => {
  const line = { at: { 1: 0, 2: 1 }, points: [[1, 1], [2, 2]] };
  assert.deepEqual(loadTrackBetween()([line], [2, 1]), [[2, 2], [1, 1]]);
});

test("a train with no matching track has no line of its own", () => {
  assert.equal(loadTrackBetween()([{ at: { 1: 0 }, points: [[1, 1]] }], [1, 2]), null);
});

const stations = ["Kraków Płaszów", "Kraków Główny", "Krakówek", "Tarnów", "Rzeszów Załęże", "Rzeszów Główny"];

test("a city leads to its stations, the main one first", () => {
  const targets = loadRailTargets(stations);
  assert.deepEqual(targets({ label: "Kraków", place: { label: "Kraków", locality: "Kraków" } }), ["Kraków Główny", "Kraków Płaszów"]);
});

test("a street leads to the stations of its city", () => {
  const targets = loadRailTargets(stations);
  assert.equal(targets({ label: "Floriańska 10, Kraków", place: { label: "Floriańska 10, Kraków", locality: "Kraków" } })[0], "Kraków Główny");
});

test("a big city uses every station with trains, busiest first, not the first ones alphabetically", () => {
  const warsaw = ["Warszawa Aleje Jerozolimskie", "Warszawa Anin", "Warszawa Babice", "Warszawa Centralna", "Warszawa Główna", "Warszawa Wschodnia", "Warszawa Zachodnia", "Warszawa Żerań"];
  const counts = new Map([["Warszawa Centralna", 400], ["Warszawa Wschodnia", 900], ["Warszawa Zachodnia", 1100], ["Warszawa Główna", 5], ["Warszawa Anin", 80]]);
  const targets = loadRailTargets(warsaw, [], counts)({ label: "Warszawa", place: { label: "Warszawa", locality: "Warszawa" } });
  assert.deepEqual(targets, ["Warszawa Zachodnia", "Warszawa Wschodnia", "Warszawa Centralna", "Warszawa Anin", "Warszawa Główna"]);
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

test("a train search with a deadline keeps the latest trains that still arrive on time", () => {
  const plan = loadTrainPlanner(Array.from({ length: 10 }, (_, i) => train(`t${i}`, [stop("A", 1000 + i * 100), stop("B", 1500 + i * 100)])));
  assert.deepEqual(Array.from(plan("A", "B", 900, 1900), (result) => result.t.key), ["t0", "t1", "t2", "t3", "t4"]);
  assert.deepEqual(Array.from(plan("A", "B", 900, 2400), (result) => result.t.key), ["t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9"].slice(-7));
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
  const context = { RAIL_CHANGE_SEC: 300 };
  const start = source.indexOf("const WALK_MAX_KM=");
  vm.runInNewContext(`${source.slice(start, source.indexOf("function fmtKm("))}; this.tripModes = tripModes; this.bestMode = bestMode; this.returnStart = returnStart; this.transitName = transitName;`, context);
  return context;
}

const none = { transit: false, rail: false, flights: false };

test("the car appears only when it is ticked, and a short walk does not need it", () => {
  const { tripModes } = loadTripModes();
  assert.deepEqual([...tripModes(90, { ...none, transit: true })], ["transit", "car"]);
  assert.deepEqual([...tripModes(90, none, new Set(["bus"]))], []);
  assert.deepEqual([...tripModes(2, { ...none, transit: true })], ["walk", "transit"]);
});

test("a return starts after arriving, and a later day keeps its morning start", () => {
  const { returnStart } = loadTripModes();
  assert.equal(returnStart({ at: 8000 }, 13000), 13300);
  assert.equal(returnStart({ at: 90000 }, 13000), 90000);
});

test("a short trip offers walking and a nearby bus", () => {
  const { tripModes, bestMode } = loadTripModes();
  const modes = tripModes(0.8, { ...none, transit: true });
  assert.deepEqual([...modes], ["walk", "transit"]);
  assert.equal(bestMode(0.8, modes, { walk: 900, transit: 600 }), "walk");
});

test("the fastest option is recommended when walking is not obvious", () => {
  const { tripModes, bestMode } = loadTripModes();
  const modes = tripModes(12, { ...none, transit: true, rail: true });
  assert.deepEqual([...modes], ["transit", "rail", "car"]);
  assert.equal(bestMode(12, modes, { transit: 2000, rail: 1500 }), "rail");
});

test("a car is suggested only when nothing else is available", () => {
  const { tripModes } = loadTripModes();
  assert.deepEqual([...tripModes(90, none)], ["car"]);
  assert.deepEqual([...tripModes(2, none)], ["walk"]);
  assert.deepEqual([...tripModes(90, { ...none, rail: true }, new Set(["train"]))], ["rail"]);
  assert.deepEqual([...tripModes(null, none)], ["car"]);
});

test("a flight is the recommendation for a far destination, and no car appears while flights load", () => {
  const { tripModes, bestMode } = loadTripModes();
  const modes = tripModes(1800, { ...none, flights: true });
  assert.equal(bestMode(1800, modes, {}), "flight");
  assert.deepEqual([...tripModes(1800, none)], ["car"]);
});

test("a trip is named after what it uses", () => {
  const { transitName } = loadTripModes();
  assert.equal(transitName({ legs: [{ agency: "ztm" }] }), "Autobus");
  assert.equal(transitName({ legs: [{ agency: "pks" }] }), "Autobus podmiejski");
  assert.equal(transitName({ legs: [{ agency: "ztm" }, { agency: "pks" }] }), "Autobus miejski + podmiejski");
});

test("the trip planner is the first tab and the default page", () => {
  assert.match(source, /function viewFromPath\(\)\{ return Object\.keys\(VIEWS\)\.find\(k=>VIEWS\[k\]\.path===location\.pathname\)\|\|'podroz'; \}/);
  const tabs = [...html.matchAll(/data-view="(\w+)"/g)].map((m) => m[1]);
  // buses, suburban buses and trains sit under one "Komunikacja" item, with their own tabs on the page
  assert.deepEqual(tabs, ["podroz", "kierunki", "transit"]);
  assert.match(source, /const TRANSIT=\['ztm','pks','kolej'\];/);
  assert.doesNotMatch(html, /id="flightForm"|id="plStay"|Wpisz przystanek, aby zobaczyć/);
  assert.doesNotMatch(source, /Wpisz przystanek, aby zobaczyć|placeSummary/);
});

test("PKS destinations come from the towns in line names, without Rzeszów", () => {
  const context = { natSort: (a, b) => a.localeCompare(b, "pl", { numeric: true }) };
  vm.runInNewContext(`${source.slice(source.indexOf("function pksDestinations("), source.indexOf("function renderPksDestinations("))}; this.pksDestinations = pksDestinations;`, context);
  const routes = [
    { id: "p108", agency: "pks", short: "108", long: "Rzeszów D.A. - Boguchwała - Niebylec - Gwoźnica Górna" },
    { id: "p253", agency: "pks", short: "253", long: "Rzeszów, Staroniwska - Racławówka - Boguchwała D.A." },
    { id: "z1", agency: "ztm", short: "1", long: "Baranówka - Kielnarowa" },
  ];
  const towns = JSON.parse(JSON.stringify(context.pksDestinations(routes))).map((d) => [d.name, d.routes.map((r) => r.short)]);
  assert.deepEqual(towns, [["Boguchwała", ["108", "253"]], ["Gwoźnica Górna", ["108"]], ["Niebylec", ["108"]], ["Racławówka", ["253"]]]);
});

test("the day strip covers eight weeks either side, marks the cheapest day and days without a price", () => {
  const context = { ymdOf: () => "2026-11-09", lastPlanDay: () => "2027-02-07", esc: (s) => s, document: { documentElement: { lang: "pl" } } };
  const part = (from, to) => source.slice(source.indexOf(from), source.indexOf(to));
  vm.runInNewContext(`${part("function addDays(", "// Grupy filtrów")}${part("const STRIP_DAYS=", "function centerStrip(")}function fmtDay(day){ return day.slice(8,10)+'.'+day.slice(5,7); }; this.dateStrip = dateStrip;`, context);
  const strip = context.dateStrip("plan", "2026-11-20", new Map([["2026-11-15", 452], ["2026-11-20", 722]]));
  const days = [...strip.matchAll(/data-day="([\d-]+)"/g)].map((m) => m[1]);
  assert.equal(days[0], "2026-11-09"); // nothing before today
  assert.equal(days.at(-1), "2027-01-15"); // 8 weeks after
  assert.equal(days.length, 68);
  assert.match(strip, /class="ds-day  cheap" data-day="2026-11-15" data-priced="1"><em>Najtaniej<\/em>/);
  assert.match(strip, /class="ds-day on " data-day="2026-11-20" data-priced="1">/);
  assert.match(strip, /data-day="2026-11-16" data-priced="0"/); // asked for when scrolled to
});

test("each category has its own page and weather refreshes every 45 minutes", () => {
  assert.match(source, /ztm:\{path:'\/buses'/);
  assert.match(source, /pks:\{path:'\/suburban'/);
  assert.match(source, /kolej:\{path:'\/trains'/);
  assert.match(source, /podroz:\{path:'\/plan'/);
  assert.doesNotMatch(source, /koncowe/);
  assert.match(source, /weatherTick\(\); \}, 45\*60\*1000\)/);
});

test("nothing calls the removed train map or late list", () => {
  for (const name of ["renderTrainsOnMap", "renderLateTrains", "trainMatches", "trainsVisible"]) assert.equal(source.includes(name), false, name);
});

test("result filters count each choice and an empty choice lets everything through", () => {
  const context = {};
  const part = (from, to) => source.slice(source.indexOf(from), source.indexOf(to));
  vm.runInNewContext(`${part("const DAY_PARTS=", "function filterPanel(")}${part("function countText(", "// Pasek kolejnych dni")}; this.tools = { dayPart, filterGroups, passesFilters, countText };`, context);
  const { dayPart, filterGroups, passesFilters, countText } = context.tools;
  assert.deepEqual(["00:10", "05:59", "06:00", "13:30", "18:00", "23:59"].map(dayPart), ["night", "night", "morning", "afternoon", "evening", "evening"]);
  const defs = [{ key: "changes", title: "Przesiadki", of: (f) => [String(Math.min(f.changes, 2))], order: ["0", "1", "2"], label: (v) => v }];
  const facts = [{ changes: 0 }, { changes: 1 }, { changes: 3 }, { changes: 0 }];
  assert.deepEqual(JSON.parse(JSON.stringify(filterGroups(facts, defs)[0].options)), [{ value: "0", label: "0", count: 2 }, { value: "1", label: "1", count: 1 }, { value: "2", label: "2", count: 1 }]);
  assert.equal(facts.filter((f) => passesFilters(f, defs, {})).length, 4);
  assert.equal(facts.filter((f) => passesFilters(f, defs, { changes: new Set(["0", "2"]) })).length, 3);
  assert.deepEqual([1, 2, 5, 12, 22, 25].map(countText), ["1 wynik", "2 wyniki", "5 wyników", "12 wyników", "22 wyniki", "25 wyników"]);
});

test("a bus and a short walk beats two buses that reach a closer stop later", () => {
  const context = {};
  vm.runInNewContext(`${source.slice(source.indexOf("const WALK_MPS="), source.indexOf("function walkText("))}; this.withoutWorse = withoutWorse; this.walkSec = walkSec;`, context);
  const trip = (name, dep, arr, legs, walkFromM, walkToM) => ({ name, dep, arr, legs: Array(legs).fill({}), walkFrom: context.walkSec(walkFromM), walkTo: context.walkSec(walkToM) });
  const walkFromStop = trip("one bus, 400 m walk", 1000, 1600, 1, 300, 400);
  const twoBuses = trip("two buses to the door", 1000, 3400, 2, 300, 50);
  const earlierStart = trip("leaves earlier, later at the door", 700, 3500, 1, 300, 0);
  const kept = context.withoutWorse([walkFromStop, twoBuses, earlierStart]).map((o) => o.name);
  assert.deepEqual(kept, ["one bus, 400 m walk"]);
  const laterButSlower = trip("leaves later, arrives later", 1200, 3600, 1, 300, 0);
  assert.deepEqual(context.withoutWorse([walkFromStop, laterButSlower]).map((o) => o.name), ["one bus, 400 m walk", "leaves later, arrives later"]);
  assert.equal(context.walkSec(934), 747);
});

test("a train trip that a bus beats from door to door is not offered", () => {
  const context = { railParts: (r) => r.parts };
  vm.runInNewContext(`${source.slice(source.indexOf("function railWorthIt("), source.indexOf("function walkText("))}; this.railWorthIt = railWorthIt;`, context);
  const bus = { dep: 1000, walkFrom: 100, arr: 3000, walkTo: 60 };
  const slowTrain = { name: "slow", leave: 800, doorArr: 6000, parts: [{}], access: { legs: [{}, {}] } };
  const fastTrain = { name: "fast", leave: 900, doorArr: 2500, parts: [{}] };
  const worseTrain = { name: "worse", leave: 850, doorArr: 2600, parts: [{}, {}] };
  assert.deepEqual(Array.from(context.railWorthIt([slowTrain, fastTrain, worseTrain], [bus]), (r) => r.name), ["fast"]);
  assert.deepEqual(Array.from(context.railWorthIt([slowTrain], []), (r) => r.name), ["slow"]);
});

test("a bus that passes several nearby stops is boarded where you can leave home latest", () => {
  const context = {};
  vm.runInNewContext(`${source.slice(source.indexOf("function bestBoardings("), source.indexOf("// Spacer: odległości"))}; this.bestBoardings = bestBoardings;`, context);
  const walk = { far: 960, near: 780, other: 300 };
  const walkFrom = (d) => walk[d.stop];
  const deps = [
    { tid: "58", stop: "far", L: { pred: 45000 } },
    { tid: "8", stop: "other", L: { pred: 45060 } },
    { tid: "58", stop: "near", L: { pred: 45120 } },
  ];
  assert.deepEqual(Array.from(context.bestBoardings(deps, walkFrom), (d) => `${d.tid}@${d.stop}`), ["8@other", "58@near"]);
});

test("a weather card takes the forecast for its own hour, rounding to the nearest full hour", () => {
  const start = source.indexOf("function hourAt(");
  const context = {};
  vm.runInNewContext(source.slice(start, source.indexOf("\n}\n", start) + 3), context);
  const hours = [[0, 12.1, 65, 61], [1, 11.8, 70, 61], [14, 16.9, null, 3], [23, 13, 10, 2]];
  assert.deepEqual(context.hourAt(hours, "~00:49"), [1, 11.8, 70, 61]);
  assert.deepEqual(context.hourAt(hours, "00:10"), [0, 12.1, 65, 61]);
  assert.deepEqual(context.hourAt(hours, "13:40"), [14, 16.9, null, 3]);
  assert.deepEqual(context.hourAt(hours, "23:50"), [23, 13, 10, 2]);
  assert.equal(context.hourAt(hours, ""), null);
  assert.equal(context.hourAt(undefined, "10:00"), null);
});

test("a participant's place on the trip route: distance done, distance left and how far off the route", () => {
  const start = source.indexOf("function routeProgress(");
  const context = {};
  vm.runInNewContext(`${source.slice(source.indexOf("function hav("), source.indexOf("function bearingOf("))}
    ${source.slice(start, source.indexOf("\n}\n", start) + 3)}; this.routeProgress = routeProgress;`, context);
  const rze = [50.04, 22.0], krk = [50.06, 19.94], bcn = [41.39, 2.17];
  const route = [rze, krk, bcn];
  const atKrk = context.routeProgress(route, krk);
  assert.ok(Math.abs(atKrk.along - 147) < 5, `along ${atKrk.along}`); // Rzeszów–Kraków is about 147 km
  assert.ok(atKrk.off < 0.5);
  assert.ok(Math.abs(atKrk.total - atKrk.along - atKrk.left) < 0.01);
  const halfway = context.routeProgress(route, [50.05, 20.97]); // between Rzeszów and Kraków, on the road
  assert.ok(halfway.along > 60 && halfway.along < 90 && halfway.off < 5);
  const ahead = context.routeProgress(route, [45.7, 11.0]); // somewhere along the flight to Barcelona
  assert.ok(ahead.along > atKrk.along); // further on the route: "ahead of" someone in Kraków
  assert.equal(context.routeProgress([rze], krk), null);
});

test("a trip without a plane is picked, saved with its own name and dated on the timeline", () => {
  const grab = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
  const code = grab("function groundWizard(", "function saveTrip(") + grab("function groundDates(", "function tripTimeline(");
  const day = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);
  const context = {
    S: { groundOpts: [], editing: null }, FAV: { items: [] },
    wantsFlights: (P) => !!P.flight, esc: (x) => String(x), L2: (pl) => pl, step: (icon, text, sub = "") => ({ icon, text, sub }),
    withMap: (s) => s, fmtKm: (k) => `${k} km`, fmtDuration: (m) => `${m} min`, fuelCost: (km) => Math.round(km * 0.4), walkMinutes: (km) => km * 15,
    plainStart: () => 1798794000, dayOfTs: day, fmtDay: (d) => d.slice(8, 10) + "." + d.slice(5, 7), fmtClock: () => "08:00", ymdOf: () => "2027-01-01",
    ROAD_FACTOR: 1.25, CAR_KMH: 70, WALK_FACTOR: 1.3, CAR_SEATS: 5,
  };
  vm.createContext(context);
  vm.runInContext(code + ";this.api={groundWizard,groundPicked,groundPickBtn,groundSnap,groundDates,tripTitleField};", context);
  const { api } = context;
  const P = { single: true, from: "Rzeszów", to: "Kraków", km: 150, origin: { label: "Rzeszów", points: [[50, 22]] }, dest: { label: "Kraków", points: [[50.06, 19.94]] }, driving: { km: 170, minutes: 120 } };
  assert.equal(api.groundWizard(P), true);
  assert.equal(api.groundWizard({ ...P, flight: true }), true, "a train or the car can be picked next to flights");
  assert.equal(api.groundWizard({ ...P, single: false }), true, "every stage of a trip with several places can be picked");
  assert.equal(api.groundWizard({ ...P, by: 1800000000 }), true, "an 'arrive by' search is picked too and saved only at the end");
  assert.match(api.groundPickBtn(P, "car", null, "car", "out"), /data-ground-pick="0"/);
  const car = api.groundSnap(P, context.S.groundOpts[0]);
  assert.equal(car.kind, "car");
  assert.equal(car.title, "Samochód");
  assert.equal(car.minutes, 120);
  assert.equal(car.km, 170);
  assert.equal(car.cost, 68);
  assert.equal(car.day, day(1798794000));
  P.groundPick = car;
  assert.equal(api.groundPicked(P, "car", "out"), true);
  assert.deepEqual({ ...api.groundDates({ trip: { ground: { out: { day: "2027-01-02" }, back: { day: "2027-01-05" } } } }) }, { day: "2027-01-02", back: "2027-01-05", ground: true });
  assert.equal(api.groundDates({ trip: { out: {} } }), null);
  // the name field remembers what was typed and, when editing, starts from the saved name
  P.tripTitle = "Majówka";
  assert.match(api.tripTitleField(P), /value="Majówka"/);
  delete P.tripTitle;
  context.S.editing = { tid: "t1" }; context.FAV.items = [{ type: "trip", tid: "t1", title: "Do babci" }];
  assert.match(api.tripTitleField(P), /value="Do babci"/);
});

test("a trip with several places is saved as one trip: every leg, the places in between and the last day", () => {
  const grab = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
  const context = {};
  vm.createContext(context);
  vm.runInContext(grab("function groundDates(", "function tripTimeline(") + grab("const routeText=", "\n") + ";this.api={groundDates,routeText};", context);
  const f = { from: "Rzeszów", to: "Wrocław", stops: ["Szczecin", "Gdańsk"],
    trip: { ground: { out: { day: "2027-05-01" }, legs: [{ day: "2027-05-01" }, { day: "2027-05-03" }, { day: "2027-05-06" }], back: null } } };
  assert.equal(context.api.routeText(f), "Rzeszów → Szczecin → Gdańsk → Wrocław");
  assert.deepEqual({ ...context.api.groundDates(f) }, { day: "2027-05-01", back: "2027-05-06", ground: true });
  assert.match(source, /if\(modes\.includes\('car'\)\) sections\.push\(tripSection\(flightsNeeded\?'Samochód \(dla porównania\)'/, "the car estimate stays next to flights");
});

test("a trip planned leg by leg: each leg keeps its own transport, the trip spans first to last day", () => {
  const grab = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
  const context = { dayOfTs: (ts) => new Date(ts * 1000).toISOString().slice(0, 10), CAR_SEATS: 5,
    flightChoice: () => null, pickedAccess: () => null, airportOptions: () => null, tripSnapshot: () => ({}), fareKey: () => "" };
  vm.createContext(context);
  vm.runInContext(grab("function multiLegOf(", "// Na końcu kroku:") + grab("function groundDates(", "function tripTimeline(") + ";this.api={multiLegOf,groundDates};", context);
  const P = { from: "Szczecin", to: "Gdańsk", people: 2, groundPick: { key: "car", kind: "car", day: "2027-05-03", leave: 1809331200, arrive: 1809345600, title: "Samochód", icon: "car", cost: 120, a: [53.4, 14.5], b: [54.35, 18.65], steps: [] } };
  const leg = context.api.multiLegOf(P, "ground");
  assert.equal(leg.kind, "ground");
  assert.equal(leg.cost, 120, "fuel is paid per car, not per person");
  assert.equal(leg.key, "g:car@2027-05-03");
  assert.equal(context.api.multiLegOf({ ...P, groundPick: null }, "ground"), null);
  assert.equal(context.api.multiLegOf(P, "flight"), null, "a flight leg is ready only after the whole flight wizard");
  const f = { trip: { multi: true, legs: [{ day: "2027-05-01", arrDay: "2027-05-01" }, leg, { day: "2027-05-06", arrDay: "2027-05-07" }] } };
  assert.deepEqual({ ...context.api.groundDates(f) }, { day: "2027-05-01", back: "2027-05-07", ground: true });
  assert.match(source, /if\(raw\.length\)\{[\s\S]{0,200}startMulti\(/, "places in between start the leg-by-leg trip");
});

test("the transit menu is one item called City Transit, with a city picker built from the railway stations", () => {
  assert.match(html, /data-view="transit"[^>]*>.*Komunikacja miejska<\/a>/);
  assert.match(source, /function cityList\(\)\{\n  const names=railStationNames\(\), cities=railCities\(\);/, "cities follow the train search's rule: several stations and a main one");
  assert.match(source, /const LOCAL_TRANSIT=new Set\(\['Rzeszów'\]\);/, "city and suburban buses only where the app has them");
  assert.equal((source.match(/^function railCities\(/gm) || []).length, 1, "one definition of a city");
});

test("the transit tabs never reuse the page's timetable class, which would restyle the whole page", () => {
  const css = fs.readFileSync(path.resolve(__dirname, "../assets/app.css"), "utf8");
  // body.tt-mode switches the page to the timetable; a button styled as .tt-mode once turned the whole page into a row
  assert.doesNotMatch(source, /class="tt-mode|class="tt-modes|class="tt-sub/);
  assert.doesNotMatch(css.replace(/body\.tt-mode|:not\(\.tt-mode\)/g, ""), /\.tt-mode\b/);
  assert.match(css, /body\.tt-mode main\.shell > :not\(\.tt-part\)[^{]*:not\(#transitTabs\)/, "the transit tabs stay visible on the timetable");
});

test("abroad, the way to the airport uses the same airport lines as the way into town, in reverse", async () => {
  const start = source.indexOf("const XFER_TO_ICON="), end = source.indexOf("async function buildAccess(");
  const asked = [];
  const context = {
    URLSearchParams, console,
    fetch: async (url) => { asked.push(String(url)); return { ok: true, json: async () => ({ options: [
      { id: "r2", kind: "rail", name: "R2 Nord", minutes: 25, alight: "Passeig de Gràcia", fare: { text: "€5.15", pln: 22.4 } },
      { id: "taxi", kind: "taxi", name: "Taxi", minutes: 30, fare: { text: "€39", pln: 170 } },
    ] }) }; },
    L2: (pl) => pl, fmtDuration: (m) => `${m} min`, step: (icon, text, sub = "") => ({ icon, text, sub }), seqIcon: (i) => i,
    MODE_COLOR: { train: "#7C3AED", car: "#EA580C", other: "#64748B" },
  };
  vm.runInNewContext(`${source.slice(start, end)}; this.xferToAirport = xferToAirport;`, context);
  const P = { origin: { points: [[41.387, 2.17]] }, from: "Barcelona", allowed: new Set(["train", "bus", "plane"]) };
  const f = { from: "BCN", fromLabel: "Barcelona (BCN)", day: "2026-12-01", departure: "2026-12-01T14:30", airport: { lat: 41.297, lon: 2.083 } };
  const list = await context.xferToAirport(P, f, 100000);
  assert.match(asked[0], /airport-transfers\/options\?code=BCN&time=2026-12-01T14%3A30/);
  assert.deepEqual(JSON.parse(JSON.stringify(list.map((o) => [o.title, o.cost, o.minutes, o.atAirport, o.leave]))), [["R2 Nord", 22, 40, 100000, 100000 - 40 * 60]]); // no taxi: car not ticked
  assert.match(list[0].steps[0].sub, /Passeig de Gràcia/);
  P.allowed.add("car");
  P.xferTo.clear();
  assert.deepEqual(JSON.parse(JSON.stringify((await context.xferToAirport(P, f, 100000)).map((o) => o.title))), ["R2 Nord", "Taxi"]);
});

test("every element the app tour points at exists on the page", () => {
  const tour = fs.readFileSync(path.resolve(__dirname, "../assets/app.tour.js"), "utf8");
  const ids = new Set([...tour.matchAll(/target:'([^']+)'/g)].flatMap((m) => [...m[1].matchAll(/#([A-Za-z][\w-]*)/g)].map((x) => x[1])));
  assert.ok(ids.size > 5);
  for (const id of ids) assert.match(html, new RegExp(`id="${id}"`), `#${id}`);
  for (const id of ["tourHelp", "tourBtn"]) assert.match(html, new RegExp(`id="${id}"`));
  assert.ok(html.indexOf("app.tour.js") < html.indexOf("/assets/app.js"), "the tour loads before app.js to read ?tour=1");
});
