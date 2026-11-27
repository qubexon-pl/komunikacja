"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const { once } = require("node:events");
const { createServer } = require("../src/server");
const { createTransportDepartures, indexSchedule, rzeszowDepartures, servicesOn, plkDepartures } = require("../src/transport-adapters");
const { localToUtc } = require("../src/transitous");

const at = (local) => localToUtc(local, "Europe/Warsaw");
// Tuesday 1 Dec 2026; weekday services run Mon-Fri, a holiday exception removes them on 2 Dec.
const SCHEDULE = {
  routes: [{ id: "r0A", short: "0A", color: "E30613", text: "FFFFFF", type: 3 }],
  trips: [
    { id: "t1", route: "r0A", service: "WD", headsign: "Port Lotniczy" },
    { id: "t2", route: "r0A", service: "WD", headsign: "Port Lotniczy" },
    { id: "night", route: "r0A", service: "WD", headsign: "Dworzec" },
    { id: "we", route: "r0A", service: "WE", headsign: "Port Lotniczy" },
  ],
  stops: [{ id: 101, name: "Rejtana" }, { id: 102, name: "Port Lotniczy" }],
  stopTimes: [
    { trip_id: "t1", sequence: 1, stop_id: 101, departure_seconds: 8 * 3600 },
    { trip_id: "t1", sequence: 2, stop_id: 102, departure_seconds: 8 * 3600 + 1800 },
    { trip_id: "t2", sequence: 1, stop_id: 101, departure_seconds: 9 * 3600 },
    { trip_id: "t2", sequence: 2, stop_id: 102, departure_seconds: 9 * 3600 + 1800 },
    { trip_id: "night", sequence: 1, stop_id: 101, departure_seconds: 24 * 3600 + 600 }, // 00:10 next day
    { trip_id: "night", sequence: 2, stop_id: 102, departure_seconds: 24 * 3600 + 1800 },
    { trip_id: "we", sequence: 1, stop_id: 101, departure_seconds: 8 * 3600 + 900 },
    { trip_id: "we", sequence: 2, stop_id: 102, departure_seconds: 9 * 3600 },
  ],
  calendar: [
    { service_id: "WD", days: [1, 1, 1, 1, 1, 0, 0], start: "2026-11-01T00:00:00.000Z", end: "2027-01-31T00:00:00.000Z" },
    { service_id: "WE", days: [0, 0, 0, 0, 0, 1, 1], start: "2026-11-01T00:00:00.000Z", end: "2027-01-31T00:00:00.000Z" },
  ],
  calendarDates: [{ service_id: "WD", date: "2026-12-02T00:00:00.000Z", exception_type: 2 }],
};

test("Rzeszów: services follow the weekly calendar and its exceptions", () => {
  assert.deepEqual([...servicesOn(SCHEDULE, "2026-12-01")], ["WD"]);
  assert.deepEqual([...servicesOn(SCHEDULE, "2026-12-02")], []); // holiday: weekday service removed
  assert.deepEqual([...servicesOn(SCHEDULE, "2026-12-05")], ["WE"]);
});

test("Rzeszów: departures from a stop are scheduled, in order, never from the last stop, and include trips past midnight", () => {
  const index = indexSchedule(SCHEDULE, "ztm");
  const list = rzeszowDepartures(index, { stop: "101", at: at("2026-12-01T08:30"), limit: 10 });
  assert.deepEqual(list.map((d) => d.scheduled), ["2026-12-01T09:00", "2026-12-02T00:10"]);
  assert.ok(list.every((d) => d.realtime === "scheduled" && d.delayMin === 0 && d.provider === "rzeszow-gtfs"));
  assert.equal(list[0].line, "0A");
  assert.equal(list[0].color, "#E30613");
  assert.equal(list[0].stopId, "ztm:101");
  assert.deepEqual(rzeszowDepartures(index, { stop: "102", at: at("2026-12-01T07:00") }), []); // terminus: nobody boards
  assert.equal(rzeszowDepartures(index, { stop: "999", at: at("2026-12-01T07:00") }), null);
});

// PLK: one train from Rzeszów Główny (100) via Tyczyn (200) to Przemyśl (300).
const PLK_DAY = {
  stations: [[100, "Rzeszów Główny"], [200, "Tyczyn"], [300, "Przemyśl Główny"]],
  carriers: [["PR", "Polregio"]],
  trains: [
    [1, 1, "R", "33100", "", "PR", [[100, null, 10 * 3600, "2", "4"], [200, 10 * 3600 + 900, 10 * 3600 + 960, "1", ""], [300, 11 * 3600, null, "1", ""]]],
    [2, 1, "IC", "3510", "Galicja", "PR", [[100, null, 12 * 3600, "1", "1"], [300, 13 * 3600, null, "", ""]]],
  ],
};

test("PKP PLK: a train PKP reports is live with its delay; one it does not report stays scheduled", () => {
  const ops = [[1, 1, "2026-12-01", "P", [[100, null, 7, null, "2026-12-01T10:07:00", 1, 0]]]];
  const { stationName, departures } = plkDepartures({ days: [{ date: "2026-12-01", data: PLK_DAY }], ops, station: "100", at: at("2026-12-01T09:00") });
  assert.equal(stationName, "Rzeszów Główny");
  assert.equal(departures.length, 2);
  const [r, ic] = departures;
  assert.deepEqual([r.line, r.realtime, r.delayMin, r.scheduled, r.expected, r.headsign, r.platform, r.carrier], ["R 33100", "live", 7, "2026-12-01T10:00", "2026-12-01T10:07", "Przemyśl Główny", "2", "Polregio"]);
  assert.deepEqual([ic.realtime, ic.delayMin], ["scheduled", 0]);
});

test("PKP PLK: a running train carries its last delay to the next station; a cancelled train is marked", () => {
  const ops = [[1, 1, "2026-12-01", "P", [[100, null, 5, null, null, 1, 0]]], [2, 1, "2026-12-01", "X", []]];
  const tyczyn = plkDepartures({ days: [{ date: "2026-12-01", data: PLK_DAY }], ops, station: "200", at: at("2026-12-01T09:00") }).departures;
  assert.deepEqual([tyczyn[0].realtime, tyczyn[0].delayMin], ["live", 5]);
  const main = plkDepartures({ days: [{ date: "2026-12-01", data: PLK_DAY }], ops, station: "100", at: at("2026-12-01T09:00") }).departures;
  assert.equal(main.find((d) => d.line === "IC 3510").cancelled, true);
  // the terminus has no departures
  assert.equal(plkDepartures({ days: [{ date: "2026-12-01", data: PLK_DAY }], ops, station: "300", at: at("2026-12-01T09:00") }).departures.length, 0);
});

function fakeSnapshots(map) {
  return {
    info: async (key) => (map[key] ? { etag: `"${key}"`, fetchedAt: "2026-12-01T08:00:00Z", type: "application/json" } : null),
    read: async (key) => zlib.gzipSync(JSON.stringify(map[key])),
  };
}

test("the service reads the snapshots, validates the stop and says when data is missing", async () => {
  const svc = createTransportDepartures({ snapshots: fakeSnapshots({ "schedule:ztm": SCHEDULE, "plk:schedule:2026-12-01": PLK_DAY, "plk:operations": [] }), now: () => at("2026-12-01T08:30") });
  const r = await svc.departures({ provider: "rzeszow-gtfs", stop: "ztm:101" });
  assert.equal(r.stop.name, "Rejtana");
  assert.equal(r.departures[0].scheduled, "2026-12-01T09:00");
  assert.equal((await svc.departures({ provider: "rzeszow-gtfs", stop: "pks:101" })).unavailable, true);
  await assert.rejects(svc.departures({ provider: "rzeszow-gtfs", stop: "101" }), { status: 400 });
  await assert.rejects(svc.departures({ provider: "rzeszow-gtfs", stop: "ztm:999" }), { status: 404 });
  await assert.rejects(svc.departures({ provider: "nope", stop: "1" }), { status: 400 });
  await assert.rejects(svc.departures({ provider: "pkp-plk", stop: "100", time: "tomorrow" }), { status: 400 });
  const p = await svc.departures({ provider: "pkp-plk", stop: "100", time: "2026-12-01T11:00" });
  assert.deepEqual(p.departures.map((d) => d.line), ["IC 3510"]);
});

test("GET /api/transport/departures answers 503 when the timetable is not ready", async (t) => {
  const server = createServer({ database: {}, auth: { resolveSession: async () => null }, snapshots: fakeSnapshots({}) });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/transport/departures`;
  assert.equal((await fetch(`${base}?provider=pkp-plk&stop=100`)).status, 503);
  assert.equal((await fetch(`${base}?provider=pkp-plk&stop=abc`)).status, 400);
});
