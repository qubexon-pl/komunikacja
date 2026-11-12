"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { airportsNear } = require("../src/airports");
const { createDrivingRouter, createPathRouter, parsePoint } = require("../src/driving");
const { buildWatches, createFlightCollector, trackerDatabase, watchesForJobs, watchesForPairs, writeWatches } = require("../src/flight-collector");
const { mergeNetwork, parseWizzMap, readNetwork, ryanairAirports } = require("../src/flight-network");
const { createFlightStore, inWindow, lastChange, normalizeFare, rankFares, readFareFile, withDepartureTimes } = require("../src/flights");
const { normalizeFavorites } = require("../src/favorites");

const TODAY = "2026-11-05";
const fare = (over = {}) => ({
  airline: "RYANAIR", from: "RZE", to: "EDI", day: "2026-11-11", departure: "2026-11-11T06:20", arrival: "2026-11-11T08:05",
  flightNumber: "FR 2110", price: 189, currency: "PLN", pricePln: 189, seatsLeft: 4, source: "ryanair.availability.v4", collectedAt: "2026-11-05T07:40:00Z", ...over,
});

function memoryStore(options = {}) {
  const saved = { rows: [] };
  const database = { readFares: async () => saved.rows, replaceFares: async (rows) => { saved.rows = rows; } };
  return { saved, store: createFlightStore({ database, now: () => new Date(`${TODAY}T10:00:00Z`), ...options }) };
}

test("a fare needs a route, a day and a price in PLN", () => {
  assert.equal(normalizeFare(fare()).flightNumber, "FR 2110");
  assert.equal(normalizeFare(fare({ from: "Rzeszów" })), null);
  assert.equal(normalizeFare(fare({ day: "wtorek" })), null);
  assert.equal(normalizeFare(fare({ pricePln: null })), null);
  assert.equal(normalizeFare(fare({ price: 0 })), null);
  assert.equal(normalizeFare(null), null);
});

test("past days and days more than a year ahead are dropped", () => {
  const rows = inWindow([fare({ day: "2026-11-04" }), fare({ day: TODAY }), fare({ day: "2027-02-03" }), fare({ day: "2027-11-06" }), fare({ day: "2027-11-07" })], TODAY);
  assert.deepEqual(rows.map((row) => row.day), [TODAY, "2027-02-03", "2027-11-06"]);
});

test("each Wizz Air departure is its own flight; only a priced one has a price, and it replaces the unpriced row", () => {
  const rows = withDepartureTimes([
    normalizeFare(fare({ airline: "WIZZ", from: "KTW", to: "BCN", day: "2026-11-13", departure: "2026-11-13T19:35", pricePln: 209, priceType: "list", flightNumber: null })),
    normalizeFare(fare({ airline: "WIZZ", from: "KTW", to: "BCN", day: "2026-11-13", departure: "2026-11-13T05:30", pricePln: 209, priceType: "list", flightNumber: null })),
    normalizeFare(fare({ airline: "WIZZ", from: "KTW", to: "BCN", day: "2026-11-13", departure: "2026-11-13T15:25", pricePln: 209, priceType: "list", flightNumber: null })),
    normalizeFare(fare({ airline: "WIZZ", from: "KTW", to: "BCN", day: "2026-11-13", departure: "2026-11-13T05:30", pricePln: 209, flightNumber: null })),
    normalizeFare(fare({ airline: "RYANAIR", from: "KTW", to: "BCN", day: "2026-11-13", departure: "2026-11-13T07:00", pricePln: 150 })),
  ]);
  const wizz = rows.filter((row) => row.airline === "WIZZ").sort((a, b) => a.departure.localeCompare(b.departure));
  assert.deepEqual(wizz.map((row) => [row.departure.slice(11), row.priceType, !!row.priceUnknown]), [["05:30", "exact", false], ["15:25", "list", true], ["19:35", "list", true]]);
  assert.equal(rows.find((row) => row.airline === "RYANAIR").priceUnknown, undefined);
});

test("imported flights are stored and can be searched cheapest first", async () => {
  const { saved, store } = memoryStore();
  const result = await store.importRows([
    fare({ pricePln: 300, flightNumber: "FR 1" }),
    fare({ pricePln: 120, flightNumber: "FR 2" }),
    fare({ airline: "WIZZ", from: "KRK", to: "BCN", pricePln: 90, flightNumber: "W6 3" }),
    fare({ from: "Rzeszów" }),
  ]);
  assert.deepEqual(result, { received: 4, stored: 3 });
  assert.equal(saved.rows.length, 3);
  const found = store.search({ from: "RZE" });
  assert.deepEqual(found.flights.map((flight) => flight.flightNumber), ["FR 2", "FR 1"]);
  assert.deepEqual(found.airlines.map((airline) => [airline.airline, airline.flights, airline.cheapest]), [["WIZZ", 1, 90], ["RYANAIR", 2, 120]]);
  assert.deepEqual(found.routes.map((route) => [route.from, route.to, route.flights, route.firstDay, route.cheapest]), [["RZE", "EDI", 2, "2026-11-11", 120], ["KRK", "BCN", 1, "2026-11-11", 90]]);
  assert.ok(found.airports.some((airport) => airport.code === "STN" && airport.country === "Wielka Brytania"));
  assert.equal(found.flights[0].fromLabel, "Rzeszów (RZE)");
  assert.match(found.flights[0].bookingUrl, /originIata=RZE&destinationIata=EDI/);
});

test("an empty import keeps the flights already stored", async () => {
  const { saved, store } = memoryStore();
  await store.importRows([fare()]);
  assert.deepEqual(await store.importRows([]), { received: 0, stored: 0 });
  assert.equal(saved.rows.length, 1);
  assert.equal(store.search().total, 1);
});

test("flights survive a restart because they are read back from the database", async () => {
  const { saved, store } = memoryStore();
  await store.importRows([fare()]);
  const restarted = createFlightStore({ database: { readFares: async () => saved.rows, replaceFares: async () => {} }, now: () => new Date(`${TODAY}T10:00:00Z`) });
  assert.equal(restarted.search().total, 0);
  await restarted.load();
  assert.equal(restarted.search().total, 1);
});

test("a server with no source file picks up flights another machine wrote to the database", async () => {
  const rows = [];
  const store = createFlightStore({ file: "", database: { readFares: async () => rows, replaceFares: async () => {} }, now: () => new Date(`${TODAY}T10:00:00Z`) });
  await store.load();
  assert.equal(store.search().total, 0);
  rows.push(fare());
  await store.refresh();
  assert.equal(store.search().total, 1);
});

test("a flight that has already left is no longer offered", async () => {
  let now = new Date(`${TODAY}T10:00:00Z`);
  const store = createFlightStore({ database: { readFares: async () => [], replaceFares: async () => {} }, now: () => now });
  await store.importRows([fare({ day: "2026-11-06" })]);
  now = new Date("2026-11-07T10:00:00Z");
  assert.equal(store.search().total, 0);
});

test("the source file is read again only after it changes", async () => {
  let reads = 0;
  let mtimeMs = 1;
  const { store } = memoryStore({
    file: "flights.db",
    statFile: async () => ({ mtimeMs }),
    readFile: async () => { reads += 1; return [fare()]; },
  });
  await store.sync();
  assert.equal(await store.sync(), null);
  assert.equal(reads, 1);
  mtimeMs = 2;
  await store.sync();
  assert.equal(reads, 2);
});

test("a change that is still in the SQLite write-ahead file counts as a change", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wal-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "flights.db");
  await fs.writeFile(file, "");
  await fs.utimes(file, new Date(1000), new Date(1000));
  assert.equal((await lastChange(file)).mtimeMs, 1000);
  await fs.writeFile(`${file}-wal`, "");
  await fs.utimes(`${file}-wal`, new Date(2000), new Date(2000));
  assert.equal((await lastChange(file)).mtimeMs, 2000);
});

test("a dearer flight from a nearby airport beats a cheap one far away", () => {
  const rzeszow = { lat: 50.04, lon: 22.0 };
  const edinburgh = { lat: 55.95, lon: -3.19 };
  const origins = airportsNear(rzeszow, 350);
  const dests = airportsNear(edinburgh, 200);
  assert.equal(origins[0].code, "RZE");
  assert.equal(dests[0].code, "EDI");
  const ranked = rankFares([normalizeFare(fare({ pricePln: 210 })), normalizeFare(fare({ from: "WAW", pricePln: 150 }))], origins, dests);
  assert.deepEqual(ranked.map((flight) => flight.from), ["RZE", "WAW"]);
  assert.ok(ranked[0].totalPln > 210);
});

test("trip options list nearby airports even when there are no flights", async () => {
  const { store } = memoryStore();
  const result = store.options({ origin: { lat: 50.04, lon: 22.0 }, dest: { lat: 41.39, lon: 2.17 } });
  assert.deepEqual(result.options, []);
  assert.equal(result.originAirports[0].code, "RZE");
  assert.equal(result.destAirports[0].code, "BCN");
});

test("a JSON fare file is accepted and anything else is refused", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fares-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const good = path.join(dir, "fares.json");
  await fs.writeFile(good, JSON.stringify([fare()]));
  assert.equal((await readFareFile(good, TODAY)).length, 1);
  const bad = path.join(dir, "bad.json");
  await fs.writeFile(bad, "{}");
  await assert.rejects(readFareFile(bad, TODAY), /JSON array/);
});

test("only the newest run of a flight-tracker database is imported, and exact prices replace list prices", async (t) => {
  const { DatabaseSync } = require("node:sqlite");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tracker-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "flights.db");
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE fares (id INTEGER PRIMARY KEY, run_id INTEGER, airline TEXT, from_airport TEXT, to_airport TEXT, day TEXT, departure TEXT, arrival TEXT,
    flight_number TEXT, price REAL, currency TEXT, seats_left INTEGER, source TEXT, price_base REAL, base_currency TEXT, collected_at TEXT)`);
  const add = db.prepare("INSERT INTO fares (run_id, airline, from_airport, to_airport, day, flight_number, price, currency, source, price_base, base_currency, collected_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'PLN', ?, ?, 'PLN', '2026-11-05 07:40:00')");
  add.run(1, "RYANAIR", "RZE", "EDI", "2026-11-11", "OLD", 500, "ryanair.availability.v4", 500);
  add.run(2, "RYANAIR", "RZE", "EDI", "2026-11-11", "NEW", 189, "ryanair.availability.v4", 189);
  add.run(2, "WIZZ", "RZE", "TGD", "2026-11-12", null, 300, "wizz.farechart", 300);
  add.run(2, "WIZZ", "RZE", "TGD", "2026-11-12", "W6 1", 250, "wizz.search", 250);
  add.run(2, "WIZZ", "RZE", "TGD", "2026-11-13", null, 280, "wizz.farechart", 280);
  add.run(2, "WIZZ", "RZE", "TGD", "2026-11-13", null, 280, "wizz.farechart", 280);
  add.run(2, "RYANAIR", "RZE", "STN", "2027-06-01", "LATER", 99, "ryanair.availability.v4", 99);
  add.run(1, "RYANAIR", "RZE", "EDI", "2026-11-18", "OTHER DAY", 200, "ryanair.availability.v4", 200);
  add.run(2, "WIZZ", "RZE", "TGD", "2026-11-14", null, 260, "wizz.farechart", 260);
  const timed = db.prepare("INSERT INTO fares (run_id, airline, from_airport, to_airport, day, departure, price, currency, source, price_base, base_currency, collected_at) VALUES (2, 'WIZZ', 'RZE', 'TGD', '2026-11-14', ?, 260, 'PLN', 'wizz.timetable', 260, 'PLN', '2026-11-05 07:40:00')");
  timed.run("2026-11-14T06:00");
  timed.run("2026-11-14T18:00");
  add.run(2, "RYANAIR", "RZE", "STN", "2027-12-01", "TOO FAR", 99, "ryanair.availability.v4", 99);
  db.close();

  const rows = inWindow(await readFareFile(file, TODAY), TODAY);
  assert.deepEqual(rows.map((row) => [row.flightNumber, row.priceType, row.departure]).sort(), [["NEW", "exact", null], ["OTHER DAY", "exact", null], ["W6 1", "exact", null], ["LATER", "exact", null], [null, "list", null], [null, "list", "2026-11-14T06:00"], [null, "list", "2026-11-14T18:00"]].sort());
  assert.equal(rows[0].collectedAt.toISOString(), "2026-11-05T07:40:00.000Z");
});

test("driving distance comes from the router and is cached", async () => {
  let calls = 0;
  const drive = createDrivingRouter({ fetchSource: async () => { calls += 1; return new Response(JSON.stringify({ routes: [{ distance: 167230, duration: 6256 }] })); } });
  const from = parsePoint("50.04,22.00");
  const to = parsePoint("50.06,19.94");
  assert.deepEqual(await drive(from, to), { km: 167, minutes: 104 });
  await drive(from, to);
  assert.equal(calls, 1);
  assert.equal(parsePoint("abc"), null);
  assert.equal(parsePoint("95,10"), null);
});

test("a saved trip keeps its details and is limited in length", () => {
  const [trip] = normalizeFavorites([{ type: "trip", view: "ztm", id: "f:1", from: "Lwowska 12", to: "Edynburg", name: "Ryanair FR 2110", detail: "x".repeat(300), extra: 1 }]);
  assert.deepEqual(Object.keys(trip), ["type", "view", "id", "from", "to", "name", "detail"]);
  assert.equal(trip.view, "podroz");
  assert.equal(trip.detail.length, 200);
  assert.deepEqual(normalizeFavorites([{ type: "trip", view: "podroz", id: "x", from: "A" }]), []);
});

test("destinations carry what the trip planner needs", async () => {
  const { store } = memoryStore();
  await store.importRows([fare(), fare({ to: "XXX" })]);
  const [edinburgh, unknown] = store.search().destinations;
  assert.deepEqual([edinburgh.city, edinburgh.country, edinburgh.code], ["Edynburg", "Wielka Brytania", "EDI"]);
  assert.ok(edinburgh.lat > 55);
  assert.equal(unknown.lat, undefined);
});

test("a full run watches the route list for the chosen days and airlines", () => {
  const watches = buildWatches("RZE:STN,EDI; KRK:BCN", "2026-12-01", "2026-12-20", ["WIZZ"]);
  assert.deepEqual(watches.map((watch) => [watch.origin, watch.destinations, watch.start, watch.end, watch.airlines]), [
    ["RZE", "STN,EDI", "2026-12-01", "2026-12-20", "WIZZ"],
    ["KRK", "BCN", "2026-12-01", "2026-12-20", "WIZZ"],
  ]);
});

test("a full run collects, then imports, and only when asked", async () => {
  const steps = [];
  const prepared = [];
  const collector = createFlightCollector({
    dir: "tracker",
    routes: "RZE:STN",
    flights: { sync: async () => { steps.push("import"); } },
    prepare: async (dir, watches) => { steps.push("watches"); prepared.push(watches); },
    collect: async () => { steps.push("collect"); },
  });
  assert.equal(typeof collector.start, "undefined");
  assert.equal(await collector.run({ start: "2026-12-01", end: "2026-12-05", airlines: ["RYANAIR"] }), true);
  assert.deepEqual(steps, ["watches", "collect", "import"]);
  assert.deepEqual(prepared[0].map((watch) => [watch.origin, watch.start, watch.end, watch.airlines]), [["RZE", "2026-12-01", "2026-12-05", "RYANAIR"]]);
});

test("a route list run only refreshes the airlines' routes", async () => {
  const calls = [];
  const collector = createFlightCollector({
    dir: "tracker",
    flights: { sync: async () => { calls.push("import"); } },
    updateNetwork: async (options) => { calls.push(options); },
    prepare: async () => { calls.push("watches"); },
    collect: async () => { calls.push("collect"); },
  });
  await collector.run({ networkOnly: true, target: { scope: "network" } });
  assert.deepEqual(calls, [{ force: true }]);
  assert.deepEqual(collector.status().target, { scope: "network" });
});

test("a failed collection does not import, and the next run can try again", async () => {
  let imports = 0;
  let fail = true;
  const collector = createFlightCollector({
    dir: "tracker",
    flights: { sync: async () => { imports += 1; } },
    prepare: async () => {},
    collect: async () => { if (fail) throw new Error("exit 1"); },
  });
  await assert.rejects(collector.run({ start: "2026-12-01", end: "2026-12-02" }), /exit 1/);
  assert.equal(imports, 0);
  assert.equal(collector.status().error, "exit 1");
  fail = false;
  assert.equal(await collector.run({ start: "2026-12-01", end: "2026-12-02" }), true);
  assert.equal(imports, 1);
});

test("nothing runs when no tracker folder is configured", async () => {
  const collector = createFlightCollector({ dir: "", flights: {}, collect: async () => { throw new Error("should not run"); } });
  assert.equal(await collector.run(), false);
});

test("our watches are replaced on later runs and the user's own are left alone", async (t) => {
  const { DatabaseSync } = require("node:sqlite");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "watches-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await writeWatches(dir, buildWatches("RZE:STN", "2026-11-05", "2026-11-19"));
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, "watches.json"), "utf8"))[0].origin, "RZE");

  await fs.mkdir(path.join(dir, "data"));
  const db = new DatabaseSync(trackerDatabase(dir));
  db.exec("CREATE TABLE watches (id INTEGER PRIMARY KEY, name TEXT, origin TEXT, destinations TEXT, start_date TEXT, end_date TEXT, min_days INTEGER, max_days INTEGER, airlines TEXT)");
  db.exec("INSERT INTO watches (name, origin) VALUES ('Barcelona long weekend', 'KRK'), ('komunikacja: RZE', 'RZE')");
  db.close();
  await writeWatches(dir, buildWatches("RZE:EDI", "2026-11-06", "2026-11-20"));
  const check = new DatabaseSync(trackerDatabase(dir));
  const rows = check.prepare("SELECT name, destinations, start_date FROM watches ORDER BY name").all().map((row) => ({ ...row }));
  check.close();
  assert.deepEqual(rows, [
    { name: "Barcelona long weekend", destinations: null, start_date: null },
    { name: "komunikacja: RZE", destinations: "EDI", start_date: "2026-11-06" },
  ]);
});

test("a scan of chosen routes asks each airline only about what it flies", async () => {
  const prepared = [];
  const modes = [];
  const collector = createFlightCollector({
    dir: "tracker",
    flights: { sync: async () => {} },
    prepare: async (dir, watches) => { prepared.push(watches); },
    collect: async (dir, options) => { modes.push(options.wizzMode); },
  });
  const pairs = [{ from: "TIA", to: "CRL", airlines: ["RYANAIR", "WIZZ"] }, { from: "TIA", to: "BGY", airlines: ["WIZZ"] }];
  await collector.run({ pairs, start: "2026-12-01", end: "2026-12-10", target: { from: "TIA", to: "" } });
  assert.deepEqual(prepared[0].map((watch) => [watch.origin, watch.destinations, watch.airlines, watch.start, watch.end]), [
    ["TIA", "CRL", "RYANAIR", "2026-12-01", "2026-12-11"],
    ["TIA", "CRL,BGY", "WIZZ", "2026-12-01", "2026-12-11"],
  ]);
  assert.equal(prepared[0][0].min_days, 1);
  assert.deepEqual(collector.status().target, { from: "TIA", to: "" });
  assert.deepEqual(modes, ["detailed"]);
});

test("only one collection runs at a time, and the outcome can be read", async () => {
  let finish;
  const collector = createFlightCollector({
    dir: "tracker",
    flights: { sync: async () => {} },
    prepare: async () => {},
    collect: () => new Promise((resolve) => { finish = resolve; }),
  });
  assert.equal(collector.request({ start: "2026-12-01", end: "2026-12-02" }), "started");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(collector.request({}), "busy");
  assert.equal(collector.status().running, true);
  finish();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(collector.status().running, false);
  assert.equal(createFlightCollector({ dir: "", flights: {} }).request({}), "unavailable");
});

const wizzMap = { cities: [
  { iata: "TIA", shortName: "Tirana", countryName: "Albania", latitude: 41.4, longitude: 19.7, connections: [{ iata: "CRL", isDirectFlight: true }, { iata: "LON", isDirectFlight: true }, { iata: "BGY", isDirectFlight: false }] },
  { iata: "CRL", shortName: "Charleroi", countryName: "Belgia", latitude: 50.4, longitude: 4.4, connections: [{ iata: "TIA", isDirectFlight: true }] },
  { iata: "BGY", shortName: "Bergamo", countryName: "Włochy", latitude: 45.6, longitude: 9.7, connections: [] },
] };

test("the Wizz map keeps direct flights between real airports only", () => {
  const { airports, routes } = parseWizzMap(wizzMap);
  assert.equal(airports.length, 3);
  assert.deepEqual(routes, [{ from: "TIA", to: "CRL" }, { from: "CRL", to: "TIA" }]);
});

test("a route flown by both airlines appears once with both", () => {
  const ryanair = { airports: ryanairAirports([{ code: "TIA", name: "Tirana", country: { name: "Albania" }, coordinates: { latitude: 41, longitude: 19 } }]), routes: [{ from: "TIA", to: "CRL" }, { from: "TIA", to: "STN" }] };
  const network = mergeNetwork({ RYANAIR: ryanair, WIZZ: parseWizzMap(wizzMap) });
  assert.deepEqual(network.routes.find((route) => route.to === "CRL" && route.from === "TIA").airlines, ["RYANAIR", "WIZZ"]);
  assert.deepEqual(network.routes.find((route) => route.to === "STN").airlines, ["RYANAIR"]);
});

test("an airline whose list fails keeps its previous routes", async () => {
  const previous = { airports: [], routes: [{ from: "RZE", to: "LTN", airlines: ["WIZZ"] }, { from: "RZE", to: "STN", airlines: ["RYANAIR"] }] };
  const network = await readNetwork({ dir: "x", previous, ryanair: async () => ({ airports: [], routes: [{ from: "RZE", to: "DUB" }] }), wizz: async () => { throw new Error("blocked"); } });
  assert.deepEqual(network.routes.map((route) => [route.to, route.airlines]), [["DUB", ["RYANAIR"]], ["LTN", ["WIZZ"]]]);
});

test("before the route list is known a scan tries both airlines on the chosen route", () => {
  const { store } = memoryStore();
  assert.deepEqual(store.pairsFor({ from: "TIA", to: "CRL" }), [{ from: "TIA", to: "CRL", airlines: ["RYANAIR", "WIZZ"] }]);
});

test("a saved route list is used and becomes stale after a week", async () => {
  const saved = {};
  let now = new Date(`${TODAY}T10:00:00Z`);
  const store = createFlightStore({ database: { readFares: async () => [], replaceFares: async () => {}, saveNetwork: async (value) => { saved.value = value; }, readNetwork: async () => saved.value }, now: () => now });
  assert.equal(store.networkIsStale(), true);
  await store.saveNetwork({ airports: [{ code: "ZZZ", city: "Test", country: "Testland", lat: 1, lon: 2 }], routes: [{ from: "TIA", to: "CRL", airlines: ["RYANAIR", "WIZZ"] }, { from: "TIA", to: "BGY", airlines: ["WIZZ"] }], updatedAt: now.toISOString() });
  assert.equal(store.networkIsStale(), false);
  assert.deepEqual(store.pairsFor({ from: "TIA", airlines: ["WIZZ"] }).map((pair) => pair.to), ["CRL", "BGY"]);
  assert.deepEqual(store.pairsFor({ from: "TIA", to: "BGY", airlines: ["RYANAIR"] }), []);
  assert.deepEqual(store.pairsFor({ from: "RZE", to: "BCN" }), []);
  assert.ok(store.search().airports.some((airport) => airport.code === "ZZZ"));
  now = new Date("2026-11-13T10:00:00Z");
  assert.equal(store.networkIsStale(), true);
});

test("a round trip pairs flights on the chosen days; each strip shows its own one-way prices", async () => {
  const { store } = memoryStore();
  await store.importRows([
    fare({ day: "2026-11-11", pricePln: 100, flightNumber: "OUT" }),
    fare({ day: "2026-11-09", departure: "2026-11-09T06:20", arrival: "2026-11-09T08:05", pricePln: 70, flightNumber: "EARLIER" }),
    fare({ from: "EDI", to: "RZE", day: "2026-11-13", departure: "2026-11-13T09:00", arrival: "2026-11-13T12:00", pricePln: 120, flightNumber: "OK" }),
    fare({ from: "EDI", to: "RZE", day: "2026-11-13", departure: "2026-11-13T18:00", arrival: "2026-11-13T21:00", pricePln: 90, flightNumber: "CHEAPER" }),
    fare({ from: "EDI", to: "RZE", day: "2026-11-15", departure: "2026-11-15T09:00", arrival: "2026-11-15T12:00", pricePln: 10, flightNumber: "OTHER DAY" }),
    fare({ from: "EDI", to: "RZE", day: "2026-11-11", departure: "2026-11-11T09:00", arrival: "2026-11-11T12:00", pricePln: 40, flightNumber: "SAME DAY" }),
  ]);
  const near = { origin: { lat: 50.04, lon: 22.0 }, dest: { lat: 55.95, lon: -3.19 } };
  const result = store.options({ ...near, date: "2026-11-11", back: "2026-11-13" });
  assert.deepEqual(result.options.map((trip) => trip.flightNumber), ["OUT"]);
  assert.deepEqual(result.options[0].returns.map((flight) => flight.flightNumber), ["CHEAPER", "OK"]);
  assert.equal(result.options[0].totalPln > result.options[0].ret.totalPln, true);
  // the way out alone on each day
  assert.deepEqual(result.days, [{ day: "2026-11-09", cheapest: 70, airlines: { RYANAIR: 70 } }, { day: "2026-11-11", cheapest: 100, airlines: { RYANAIR: 100 } }]);
  // the way home alone, from the departure day itself (11th) on
  assert.deepEqual(result.backDays.map((d) => [d.day, d.cheapest]), [["2026-11-11", 40], ["2026-11-13", 90], ["2026-11-15", 10]]);
  assert.deepEqual(store.options({ ...near, date: "2026-11-12", back: "2026-11-13" }).options, []);
  const oneWay = store.options({ ...near, date: "2026-11-09" });
  assert.deepEqual(oneWay.options.map((flight) => flight.flightNumber), ["EARLIER"]);
  assert.deepEqual(oneWay.days, [{ day: "2026-11-09", cheapest: 70, airlines: { RYANAIR: 70 } }, { day: "2026-11-11", cheapest: 100, airlines: { RYANAIR: 100 } }]);
});

test("a one-day trip cannot return before it has landed", async () => {
  const { store } = memoryStore();
  await store.importRows([
    fare({ pricePln: 100 }),
    fare({ from: "EDI", to: "RZE", departure: "2026-11-11T07:00", arrival: "2026-11-11T10:00", pricePln: 50, flightNumber: "BEFORE" }),
    fare({ from: "EDI", to: "RZE", departure: "2026-11-11T18:00", arrival: "2026-11-11T21:00", pricePln: 60, flightNumber: "AFTER" }),
  ]);
  const [trip] = store.options({ origin: { lat: 50.04, lon: 22.0 }, dest: { lat: 55.95, lon: -3.19 }, date: "2026-11-11", back: "2026-11-11" }).options;
  assert.deepEqual(trip.returns.map((flight) => flight.flightNumber), ["AFTER"]);
});

test("a path follows the router's line, walking and driving use their own routers, and repeats are cached", async () => {
  const urls = [];
  const findPath = createPathRouter({
    fetchSource: async (url) => {
      urls.push(String(url));
      return { ok: true, json: async () => ({ routes: [{ geometry: { coordinates: [[22, 50], [22.1, 50.1]] } }] }) };
    },
  });
  const from = { lat: 50, lon: 22 };
  const to = { lat: 50.1, lon: 22.1 };
  assert.deepEqual(await findPath("walk", from, to), [[50, 22], [50.1, 22.1]]);
  await findPath("walk", from, to);
  await findPath("car", from, to);
  assert.equal(urls.length, 2);
  assert.match(urls[0], /routed-foot/);
  assert.match(urls[1], /project-osrm/);
});

test("a trip asks about the nearest airports that fly to the destination, and the way home where airlines fly it", async () => {
  const saved = {};
  const store = createFlightStore({ database: { readFares: async () => [], replaceFares: async () => {}, saveNetwork: async (value) => { saved.value = value; }, readNetwork: async () => saved.value }, now: () => new Date(`${TODAY}T10:00:00Z`) });
  await store.saveNetwork({ airports: [], updatedAt: new Date().toISOString(), routes: [
    { from: "KRK", to: "BGY", airlines: ["RYANAIR"] },
    { from: "KTW", to: "BGY", airlines: ["RYANAIR", "WIZZ"] },
    { from: "BGY", to: "KRK", airlines: ["RYANAIR"] },
    { from: "RZE", to: "STN", airlines: ["RYANAIR"] },
  ] });
  const rzeszow = { lat: 50.04, lon: 22.0 };
  const bergamo = { lat: 45.67, lon: 9.7 };
  const pairs = store.tripPairs({ origin: rzeszow, dest: bergamo });
  assert.deepEqual(pairs.map((p) => `${p.from}-${p.to}`), ["KRK-BGY", "KTW-BGY"]);
  assert.deepEqual(store.returnPairs(pairs), [{ from: "BGY", to: "KRK", airlines: ["RYANAIR"] }, { from: "BGY", to: "KTW", airlines: ["RYANAIR", "WIZZ"] }]);
  const { suggested } = store.options({ origin: rzeszow, dest: bergamo, date: "2026-11-16" });
  assert.deepEqual([suggested.from.code, suggested.to.code, suggested.airlines], ["KRK", "BGY", ["RYANAIR"]]);
});

test("a trip run asks about the way out and the way home on their own days", () => {
  const watches = watchesForJobs([
    { pairs: [{ from: "KRK", to: "BGY", airlines: ["RYANAIR"] }], start: "2026-11-16", end: "2026-11-16" },
    { pairs: [{ from: "BGY", to: "KRK", airlines: ["RYANAIR"] }], start: "2026-11-23", end: "2026-11-23" },
  ]);
  assert.deepEqual(watches.map((w) => [w.name, w.origin, w.destinations, w.start, w.end]), [
    ["komunikacja: KRK RYANAIR 2026-11-16", "KRK", "BGY", "2026-11-16", "2026-11-17"],
    ["komunikacja: BGY RYANAIR 2026-11-23", "BGY", "KRK", "2026-11-23", "2026-11-24"],
  ]);
});

test("a missing arrival comes from the route's known flights or from the distance, with the time difference", () => {
  const { withFlightTime, routeClockDiffs, hoursFromPoland } = require("../src/flights");
  const known = [{ from: "KRK", to: "STN", departure: "2026-11-17T06:00", arrival: "2026-11-17T07:40" }, { from: "KRK", to: "STN", departure: "2026-11-18T18:00", arrival: "2026-11-18T19:45" }];
  const diffs = routeClockDiffs(known);
  const viaRoute = withFlightTime({ from: "KRK", to: "STN", day: "2026-11-20", departure: "2026-11-20T10:00", arrival: null }, diffs);
  assert.deepEqual([viaRoute.arrival, viaRoute.arrivalEstimated, viaRoute.durationMin, viaRoute.durationFrom], ["2026-11-20T11:45", true, 165, "route"]); // 1 h 45 on the clock, 2 h 45 in the air
  const viaDistance = withFlightTime({ from: "KRK", to: "BCN", day: "2026-11-20", departure: "2026-11-20T05:30", arrival: null }, diffs);
  assert.equal(viaDistance.durationFrom, "distance");
  assert.ok(viaDistance.durationMin > 150 && viaDistance.durationMin < 190, String(viaDistance.durationMin));
  assert.equal(hoursFromPoland("TFS", "2026-11-20"), -1);
  assert.equal(hoursFromPoland("AYT", "2026-07-01") , hoursFromPoland("AYT", "2026-07-01"));
});

test("a tracker sync never replaces the Wizz Air prices the app asked for itself", async () => {
  let stored = [];
  const store = createFlightStore({ database: { readFares: async () => stored, replaceFares: async (rows) => { stored = rows; } }, now: () => new Date("2026-11-11T10:00:00Z") });
  const api = { airline: "WIZZ", from: "KRK", to: "BCN", day: "2026-11-15", departure: "2026-11-15T05:30", price: 319, currency: "PLN", pricePln: 319, priceType: "exact", source: "wizz.api.timetable", collectedAt: "2026-11-11T09:00:00Z" };
  await store.mergeRows([api]);
  await store.importRows([
    { ...api, price: 307, pricePln: 307, priceType: "list", source: "wizz.timetable", collectedAt: "2026-11-11T09:30:00Z" }, // an old Wizz row left in the tracker's file
    { airline: "RYANAIR", from: "KRK", to: "BCN", day: "2026-11-15", departure: "2026-11-15T07:00", price: 199, currency: "PLN", pricePln: 199, flightNumber: "FR 1", source: "ryanair", collectedAt: "2026-11-11T09:30:00Z" },
  ]);
  assert.deepEqual(stored.map((f) => [f.airline, f.pricePln, f.source]).sort(), [["RYANAIR", 199, "ryanair"], ["WIZZ", 319, "wizz.api.timetable"]]);
});

test("a saved trip keeps its flight (airports, days, price) and nothing else", () => {
  const [trip] = normalizeFavorites([{ type: "trip", view: "podroz", id: "f:WIZZ||KRK|BCN|2026-11-15", from: "Rzeszów", to: "Barcelona", name: "Pociąg · Wizz Air",
    flight: { from: "KRK", to: "BCN", day: "2026-11-15", back: "2026-11-22", airline: "WIZZ", price: 812.4, extra: "x" } }]);
  assert.deepEqual(trip.flight, { from: "KRK", to: "BCN", day: "2026-11-15", back: "2026-11-22", airline: "WIZZ", price: 812 });
  const [bad] = normalizeFavorites([{ type: "trip", view: "podroz", id: "x", from: "A", to: "B", name: "n", flight: { from: "krk", to: "BCN", day: "jutro" } }]);
  assert.equal(bad.flight, undefined);
});

test("a saved trip keeps the chosen flights and way to the airport, as short text", () => {
  const [trip] = normalizeFavorites([{ type: "trip", view: "podroz", id: "f:x", from: "A", to: "B", name: "n",
    plan: { out: "RYANAIR|FR 1|KRK|ARN|2026-11-15|2026-11-15T06:30", ret: "RYANAIR|FR 2|ARN|KRK|2026-11-22|2026-11-22T09:05", access: "rail-1", extra: "x".repeat(500) } }]);
  assert.deepEqual(trip.plan, { out: "RYANAIR|FR 1|KRK|ARN|2026-11-15|2026-11-15T06:30", ret: "RYANAIR|FR 2|ARN|KRK|2026-11-22|2026-11-22T09:05", access: "rail-1", xfer: "" });
  assert.equal(normalizeFavorites([{ type: "trip", view: "podroz", id: "f:x", from: "A", to: "B", name: "n", plan: { ret: "x" } }])[0].plan, undefined);
});

test("a trip saved as my own keeps its status, its page id and what it looked like, as plain small data", () => {
  const [trip] = normalizeFavorites([{ type: "trip", view: "podroz", id: "f:x", from: "A", to: "B", name: "n", status: "booked", tid: "abc123xyz",
    trip: { out: { from: "KRK", dep: "06:30", price: 400 }, xfer: { name: "Arlanda Express", minutes: 18, pln: 132, steps: [{ kind: "rail" }] }, "bad key": 1, fn: () => 1, deep: { a: { b: { c: { d: { e: 1 } } } } } } }]);
  assert.equal(trip.status, "booked");
  assert.equal(trip.tid, "abc123xyz");
  assert.deepEqual(trip.trip.xfer, { name: "Arlanda Express", minutes: 18, pln: 132, steps: [{ kind: "rail" }] });
  assert.equal(trip.trip["bad key"], undefined);
  assert.equal(trip.trip.fn, null);
  assert.equal(trip.trip.deep.a.b.c.d, null); // no deeper than five levels
  const [odd] = normalizeFavorites([{ type: "trip", view: "podroz", id: "f:y", from: "A", to: "B", name: "n", status: "admin", tid: "<script>", trip: { note: "x".repeat(20000).split("").map(() => "y") } }]);
  assert.equal(odd.status, undefined);
  assert.equal(odd.tid, undefined);
  const [huge] = normalizeFavorites([{ type: "trip", view: "podroz", id: "f:z", from: "A", to: "B", name: "n", trip: { a: Array(20).fill("x".repeat(300)), b: Array(20).fill("y".repeat(300)), c: Array(20).fill("z".repeat(300)), d: Array(20).fill("w".repeat(300)), e: Array(20).fill("v".repeat(300)) } }]);
  assert.equal(huge.trip, undefined); // over 24 kB: dropped, the trip itself stays
});

test("today only flights still on sale are offered: leaving at least two hours from now, with a known time", async () => {
  let stored = [];
  const at = new Date("2026-11-12T10:00:00Z"); // 11:00 in Poland
  const store = createFlightStore({ database: { readFares: async () => stored, replaceFares: async (rows) => { stored = rows; } }, now: () => at });
  const fare = (day, departure, price) => ({ airline: "WIZZ", from: "KTW", to: "LTN", day, departure, price, currency: "PLN", pricePln: price, priceType: "exact", source: "wizz.api.timetable", collectedAt: "2026-11-12T08:00:00Z" });
  await store.mergeRows([fare("2026-11-12", "2026-11-12T06:10", 99), fare("2026-11-12", "2026-11-12T12:30", 109), fare("2026-11-12", "2026-11-12T19:45", 119), fare("2026-11-13", "2026-11-13T06:10", 129)]);
  await store.mergeRows([{ ...fare("2026-11-12", null, 89), airline: "RYANAIR", source: "ryanair" }]);
  const shown = store.search({ from: "KTW", to: "LTN" }).flights.map((f) => `${f.airline} ${f.day} ${f.departure || "-"}`).sort();
  assert.deepEqual(shown, ["WIZZ 2026-11-12 2026-11-12T19:45", "WIZZ 2026-11-13 2026-11-13T06:10"]); // 06:10 left, 12:30 no longer sold, no time: not offered
});

test("days Wizz Air answered without any flight lose the prices stored for them", async () => {
  let stored = [];
  const store = createFlightStore({ database: { readFares: async () => stored, replaceFares: async (rows) => { stored = rows; } }, now: () => new Date("2026-11-11T10:00:00Z") });
  const fare = (day, price) => ({ airline: "WIZZ", from: "KTW", to: "LTN", day, departure: `${day}T19:45`, price, currency: "PLN", pricePln: price, priceType: "exact", source: "wizz.api.timetable", collectedAt: "2026-11-10T08:00:00Z" });
  await store.mergeRows([fare("2026-11-12", 109), fare("2026-11-13", 119), { ...fare("2026-11-12", 99), airline: "RYANAIR", source: "ryanair" }]);
  await store.mergeRows([fare("2026-11-13", 125)], { clear: [{ airline: "WIZZ", from: "KTW", to: "LTN", day: "2026-11-12" }] });
  assert.deepEqual(stored.map((f) => `${f.airline} ${f.day} ${f.pricePln}`).sort(), ["RYANAIR 2026-11-12 99", "WIZZ 2026-11-13 125"]);
  await store.mergeRows([], { clear: [{ airline: "WIZZ", from: "KTW", to: "LTN", day: "2026-11-13" }] }); // an answer with no flights at all still clears
  assert.deepEqual(stored.map((f) => `${f.airline} ${f.day}`), ["RYANAIR 2026-11-12"]);
});

test("dropping one departure removes only that flight's stored price", async () => {
  let stored = [];
  const store = createFlightStore({ database: { readFares: async () => stored, replaceFares: async (rows) => { stored = rows; } }, now: () => new Date("2026-11-12T10:00:00Z") });
  const fare = (departure, price) => ({ airline: "RYANAIR", from: "KRK", to: "BCN", day: "2026-11-20", departure, price, currency: "PLN", pricePln: price, priceType: "exact", source: "ryanair.availability.v4", collectedAt: "2026-11-11T18:00:00Z" });
  await store.mergeRows([fare("2026-11-20T09:05", 1737), fare("2026-11-20T17:10", 611)]);
  const result = await store.mergeRows([], { drop: [{ airline: "RYANAIR", from: "KRK", to: "BCN", day: "2026-11-20", departure: "2026-11-20T09:05" }] });
  assert.equal(result.removed, 1);
  assert.deepEqual(stored.map((f) => f.departure), ["2026-11-20T17:10"]);
});
