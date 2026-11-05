"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { airportsNear } = require("../src/airports");
const { createDrivingRouter, parsePoint } = require("../src/driving");
const { buildWatches, createFlightCollector, trackerDatabase, watchesForPairs, writeWatches } = require("../src/flight-collector");
const { mergeNetwork, parseWizzMap, readNetwork, ryanairAirports } = require("../src/flight-network");
const { createFlightStore, earliestReturn, inWindow, lastChange, normalizeFare, rankFares, readFareFile } = require("../src/flights");
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

test("past days and days too far ahead are dropped", () => {
  const rows = inWindow([fare({ day: "2026-11-04" }), fare({ day: TODAY }), fare({ day: "2027-02-03" }), fare({ day: "2027-02-04" })], TODAY);
  assert.deepEqual(rows.map((row) => row.day), [TODAY, "2027-02-03"]);
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
  add.run(2, "RYANAIR", "RZE", "STN", "2027-06-01", "LATER", 99, "ryanair.availability.v4", 99);
  add.run(1, "RYANAIR", "RZE", "EDI", "2026-11-18", "OTHER DAY", 200, "ryanair.availability.v4", 200);
  db.close();

  const rows = inWindow(await readFareFile(file, TODAY), TODAY);
  assert.deepEqual(rows.map((row) => [row.flightNumber, row.priceType]).sort(), [["NEW", "exact"], ["OTHER DAY", "exact"], ["W6 1", "exact"], [null, "list"]].sort());
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

test("watches follow a rolling two-week window", () => {
  const watches = buildWatches("RZE:STN,EDI; KRK:BCN", new Date("2026-11-05T10:00:00Z"));
  assert.deepEqual(watches.map((watch) => [watch.origin, watch.destinations, watch.start, watch.end]), [
    ["RZE", "STN,EDI", "2026-11-05", "2026-11-19"],
    ["KRK", "BCN", "2026-11-05", "2026-11-19"],
  ]);
});

test("a run collects, then imports, and is skipped until the next one is due", async () => {
  const steps = [];
  let mtimeMs = null;
  const collector = createFlightCollector({
    dir: "tracker",
    flights: { sync: async () => { steps.push("import"); } },
    intervalMs: 3600000,
    prepare: async () => { steps.push("watches"); },
    collect: async () => { steps.push("collect"); },
    markFullRun: async () => { mtimeMs = Date.parse("2026-11-05T10:00:00Z"); },
    statFile: async () => { if (mtimeMs == null) throw new Error("missing"); return { mtimeMs }; },
    now: () => new Date("2026-11-05T10:30:00Z"),
  });
  assert.equal(await collector.tick(), true);
  assert.deepEqual(steps, ["watches", "collect", "import"]);
  assert.equal(await collector.tick(), false);
  assert.equal(steps.length, 3);
});

test("a failed collection does not import, and the next tick can try again", async () => {
  let imports = 0;
  let fail = true;
  const collector = createFlightCollector({
    dir: "tracker",
    flights: { sync: async () => { imports += 1; } },
    prepare: async () => {},
    collect: async () => { if (fail) throw new Error("exit 1"); },
    markFullRun: async () => {},
    statFile: async () => { throw new Error("missing"); },
  });
  await assert.rejects(collector.tick(), /exit 1/);
  assert.equal(imports, 0);
  fail = false;
  assert.equal(await collector.tick(), true);
  assert.equal(imports, 1);
});

test("nothing runs when no tracker folder is configured", async () => {
  const collector = createFlightCollector({ dir: "", flights: {}, collect: async () => { throw new Error("should not run"); } });
  assert.equal(await collector.tick(), false);
});

test("our watches are replaced on later runs and the user's own are left alone", async (t) => {
  const { DatabaseSync } = require("node:sqlite");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "watches-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await writeWatches(dir, buildWatches("RZE:STN", new Date("2026-11-05T10:00:00Z")));
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, "watches.json"), "utf8"))[0].origin, "RZE");

  await fs.mkdir(path.join(dir, "data"));
  const db = new DatabaseSync(trackerDatabase(dir));
  db.exec("CREATE TABLE watches (id INTEGER PRIMARY KEY, name TEXT, origin TEXT, destinations TEXT, start_date TEXT, end_date TEXT, min_days INTEGER, max_days INTEGER, airlines TEXT)");
  db.exec("INSERT INTO watches (name, origin) VALUES ('Barcelona long weekend', 'KRK'), ('komunikacja: RZE', 'RZE')");
  db.close();
  await writeWatches(dir, buildWatches("RZE:EDI", new Date("2026-11-06T10:00:00Z")));
  const check = new DatabaseSync(trackerDatabase(dir));
  const rows = check.prepare("SELECT name, destinations, start_date FROM watches ORDER BY name").all().map((row) => ({ ...row }));
  check.close();
  assert.deepEqual(rows, [
    { name: "Barcelona long weekend", destinations: null, start_date: null },
    { name: "komunikacja: RZE", destinations: "EDI", start_date: "2026-11-06" },
  ]);
});

test("a scan of chosen routes asks each airline only about what it flies and does not postpone the daily run", async () => {
  const prepared = [];
  let marks = 0;
  const collector = createFlightCollector({
    dir: "tracker",
    flights: { sync: async () => {} },
    prepare: async (dir, watches) => { prepared.push(watches); },
    collect: async () => {},
    markFullRun: async () => { marks += 1; },
  });
  const pairs = [{ from: "TIA", to: "CRL", airlines: ["RYANAIR", "WIZZ"] }, { from: "TIA", to: "BGY", airlines: ["WIZZ"] }];
  await collector.run({ pairs, start: "2026-12-01", end: "2026-12-10", target: { from: "TIA", to: "" } });
  assert.deepEqual(prepared[0].map((watch) => [watch.origin, watch.destinations, watch.airlines, watch.start, watch.end]), [
    ["TIA", "CRL", "RYANAIR", "2026-12-01", "2026-12-10"],
    ["TIA", "CRL,BGY", "WIZZ", "2026-12-01", "2026-12-10"],
  ]);
  assert.equal(marks, 0);
  assert.deepEqual(collector.status().target, { from: "TIA", to: "" });
  await collector.run();
  assert.equal(marks, 1);
});

test("only one collection runs at a time, and the outcome can be read", async () => {
  let finish;
  const collector = createFlightCollector({
    dir: "tracker",
    flights: { sync: async () => {} },
    prepare: async () => {},
    collect: () => new Promise((resolve) => { finish = resolve; }),
    markFullRun: async () => {},
  });
  assert.equal(collector.request({}), "started");
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

test("the return day counts the stay inclusively", () => {
  assert.equal(earliestReturn("2026-12-01", 3), "2026-12-03");
  assert.equal(earliestReturn("2026-12-01", 1), "2026-12-01");
  assert.equal(earliestReturn("2026-12-30", 5), "2027-01-03");
});

test("a round trip pairs each outbound with returns that respect the stay", async () => {
  const { store } = memoryStore();
  await store.importRows([
    fare({ day: "2026-11-11", pricePln: 100, flightNumber: "OUT" }),
    fare({ from: "EDI", to: "RZE", day: "2026-11-12", departure: "2026-11-12T09:00", arrival: "2026-11-12T12:00", pricePln: 50, flightNumber: "TOO SOON" }),
    fare({ from: "EDI", to: "RZE", day: "2026-11-13", departure: "2026-11-13T09:00", arrival: "2026-11-13T12:00", pricePln: 120, flightNumber: "OK" }),
    fare({ from: "EDI", to: "RZE", day: "2026-11-15", departure: "2026-11-15T09:00", arrival: "2026-11-15T12:00", pricePln: 90, flightNumber: "CHEAPER" }),
  ]);
  const near = { origin: { lat: 50.04, lon: 22.0 }, dest: { lat: 55.95, lon: -3.19 } };
  const [trip] = store.options({ ...near, stay: 3 }).options;
  assert.equal(trip.flightNumber, "OUT");
  assert.equal(trip.ret.flightNumber, "CHEAPER");
  assert.deepEqual(trip.returns.map((flight) => flight.flightNumber), ["CHEAPER", "OK"]);
  assert.equal(trip.totalPln > trip.ret.totalPln, true);
  assert.deepEqual(store.options({ ...near, stay: 3, back: "2026-11-14" }).options[0].returns.map((flight) => flight.flightNumber), ["CHEAPER"]);
  assert.deepEqual(store.options({ ...near, stay: 8 }).options, []);
});

test("a one-day trip cannot return before it has landed", async () => {
  const { store } = memoryStore();
  await store.importRows([
    fare({ pricePln: 100 }),
    fare({ from: "EDI", to: "RZE", departure: "2026-11-11T07:00", arrival: "2026-11-11T10:00", pricePln: 50, flightNumber: "BEFORE" }),
    fare({ from: "EDI", to: "RZE", departure: "2026-11-11T18:00", arrival: "2026-11-11T21:00", pricePln: 60, flightNumber: "AFTER" }),
  ]);
  const [trip] = store.options({ origin: { lat: 50.04, lon: 22.0 }, dest: { lat: 55.95, lon: -3.19 }, stay: 1 }).options;
  assert.deepEqual(trip.returns.map((flight) => flight.flightNumber), ["AFTER"]);
});
