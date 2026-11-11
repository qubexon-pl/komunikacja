"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createAirportTransfers, faresFromCsv, FARES_FILE } = require("../src/airport-transfers");
const { createCityTransit, clip } = require("../src/city-transit");
const { decodePolyline } = require("../src/transitous");

const leg = (mode, line, agency, from, to, start, end, extra = {}) => ({ mode, displayName: line, agencyName: agency, from: { name: from, lat: 41.3, lon: 2.07 }, to: { name: to }, startTime: start, endTime: end, ...extra });
const walk = (start, end) => ({ mode: "WALK", duration: (Date.parse(end) - Date.parse(start)) / 1000, startTime: start, endTime: end, from: { name: "" }, to: { name: "" } });
const it = (legs) => ({ startTime: legs[0].startTime, endTime: legs.at(-1).endTime, legs });

test("the reviewed fares file parses, with a taxi price for every airport it covers", () => {
  const fares = faresFromCsv(fs.readFileSync(FARES_FILE, "utf8"));
  assert.ok(fares.length >= 30);
  const codes = new Set(fares.map((f) => f.code));
  for (const code of codes) assert.ok(fares.some((f) => f.code === code && f.match === "^taxi$"), `${code} has a taxi row`);
  assert.equal(fares.find((f) => f.code === "BCN" && /Aerob/.test(f.option)).fareEur, 7.25);
});

test("every way into town is listed once, from the terminal, with its departures, fare in PLN and a taxi", async () => {
  const asked = [];
  const answers = {
    any: [it([walk("2026-11-20T11:00:00Z", "2026-11-20T11:02:00Z"), leg("BUS", "A2", "Monbus (Aerobús)", "Aeroport T2B", "Pl. Catalunya", "2026-11-20T11:05:00Z", "2026-11-20T11:40:00Z")]),
      it([leg("BUS", "A2", "Monbus (Aerobús)", "Aeroport T2B", "Pl. Catalunya", "2026-11-20T11:15:00Z", "2026-11-20T11:50:00Z")])],
    RAIL: [it([walk("2026-11-20T10:58:00Z", "2026-11-20T11:06:00Z"), leg("REGIONAL_RAIL", "R2N", "Renfe Cercanias", "El Prat Aeroport", "Passeig de Gràcia", "2026-11-20T11:08:00Z", "2026-11-20T11:35:00Z")])],
    "BUS,COACH": [it([leg("BUS", "46", "TMB", "Aeroport T2", "Pl. Espanya", "2026-11-20T11:03:00Z", "2026-11-20T11:45:00Z")])],
  };
  const transitous = { plan: async (p) => { asked.push(p); return { itineraries: answers[p.transitModes || "any"] }; } };
  const geocode = async () => ({ places: [{ points: [[41.3826, 2.1771]] }] });
  const drive = async () => ({ km: 16, minutes: 22 });
  const t = createAirportTransfers({ transitous, geocode, drive, toPln: async (eur) => eur * 4.25 });
  const r = await t.options({ code: "BCN", time: "2026-11-20T11:55" });
  assert.equal(asked.length, 3);
  assert.equal(asked[0].fromPlace, "41.30331,2.07690"); // the terminal pickup point, not the middle of the airport
  assert.equal(asked[0].time, "2026-11-20T11:00:00.000Z"); // 11:55 local + 30 min, down to the half hour, in UTC
  assert.equal(r.target.centre, true);
  const by = Object.fromEntries(r.options.map((o) => [o.line, o]));
  assert.deepEqual(Object.keys(by).sort(), ["46", "A2", "R2N", "Taxi"]);
  assert.deepEqual(by.A2.departures, ["12:05", "12:15"]);
  assert.equal(by.A2.name, "Aerobús A1 / A2");
  assert.equal(by.A2.fare.pln, 31);
  assert.equal(by.R2N.board.name, "El Prat Aeroport");
  assert.equal(by.R2N.board.walkMin, 8);
  assert.equal(by["46"].fare.eur, 2.65);
  assert.equal(by.Taxi.minutes, 27);
  assert.equal(by.Taxi.fare.eur, 38);
  await t.options({ code: "BCN", time: "2026-11-20T11:58" }); // same half hour: the kept answer
  assert.equal(asked.length, 3);
});

test("a city journey is planned at the local time of the destination and kept for a while", async () => {
  const asked = [];
  const transitous = { plan: async (p) => { asked.push(p); return { itineraries: [it([leg("SUBWAY", "L3", "TMB", "Catalunya", "Lesseps", "2026-11-20T11:04:00Z", "2026-11-20T11:16:00Z", { legGeometry: { points: "_p~iF~ps|U_ulLnnqC", precision: 5 } })])], direct: [] }; } };
  const city = createCityTransit({ transitous });
  const q = { from: "41.387,2.170", to: "41.414,2.152", time: "2026-11-20T12:00", zone: "Europe/Madrid" };
  const r = await city.plan(q);
  assert.equal(asked[0].time, "2026-11-20T11:00:00.000Z");
  assert.equal(r.trips[0].dep.clock, "12:04");
  assert.equal(r.trips[0].steps[0].line, "L3");
  assert.equal(r.trips[0].shape[0].points.length, 2);
  await city.plan(q);
  assert.equal(asked.length, 1);
  await assert.rejects(city.plan({ ...q, zone: "Mars/Base" }), { status: 400 });
  await assert.rejects(city.plan({ ...q, from: "x" }), { status: 400 });
});

test("vehicles are asked for a snapped area once a minute and sent as timed positions; wide views are refused", async () => {
  let asked = 0;
  const t0 = Date.parse("2026-11-20T11:00:00Z");
  const transitous = { mapTrips: async () => { asked++; return [{ trips: [{ tripId: "t1", routeShortName: "46" }], mode: "BUS", routeColor: "", from: { name: "A" }, to: { name: "B" },
    departure: "2026-11-20T11:00:00Z", arrival: "2026-11-20T11:02:00Z", scheduledDeparture: "2026-11-20T10:59:00Z", realTime: true, polyline: "_p~iF~ps|U_ulLnnqC" }]; } };
  const city = createCityTransit({ transitous, now: () => t0 + 5000 });
  const r = await city.vehicles({ min: "41.37,2.14", max: "41.40,2.19", zoom: "14" });
  assert.equal(asked, 1);
  assert.equal(r.vehicles.length, 1);
  assert.equal(r.vehicles[0].line, "46");
  assert.equal(r.vehicles[0].delayMin, 1);
  assert.equal(r.vehicles[0].t1, t0 + 120000);
  await city.vehicles({ min: "41.371,2.141", max: "41.399,2.189", zoom: "14" }); // a slightly moved view shares the answer
  assert.equal(asked, 1);
  assert.deepEqual(await city.vehicles({ min: "41.0,1.8", max: "41.6,2.5", zoom: "14" }), { vehicles: [], tooWide: true });
  assert.deepEqual(await city.vehicles({ min: "41.37,2.14", max: "41.40,2.19", zoom: "10" }), { vehicles: [], tooWide: true });
  assert.equal(asked, 1);
});

test("a ride is cut to the asked minutes along its line", () => {
  const line = decodePolyline("_p~iF~ps|U_ulLnnqC", 5);
  assert.deepEqual(line, [[38.5, -120.2], [40.7, -120.95]]);
  const part = clip([[0, 0], [0, 1]], 0, 100000, 50000, 200000);
  assert.equal(part.t0, 50000);
  assert.equal(part.t1, 100000);
  assert.deepEqual(part.path[0], [0, 0.5]);
  assert.deepEqual(part.path.at(-1), [0, 1]);
});
