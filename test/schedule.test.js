"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const zlib = require("node:zlib");
const JSZip = require("jszip");
const { sourceHash, validateSchedulePayload } = require("../src/database");
const { parseFeed } = require("../src/gtfs-import");
const { createScheduleStore } = require("../src/schedule");

async function sampleZip() {
  const zip = new JSZip();
  zip.file("routes.txt", "route_id,route_short_name,route_long_name,route_type,route_color\n1_18,18,,3,DD3300\n");
  zip.file("stops.txt", "﻿stop_id,stop_name,stop_lat,stop_lon\n1,\"Dworzec, Główny\",50.04,22.00\n2,Lwowska,50.03,22.02\n");
  zip.file("trips.txt", "trip_id,route_id,service_id,trip_headsign,direction_id,shape_id\nt1,1_18,s1,Pienińska,1,sh1\nt2,gone,s1,Nie,0,sh1\n");
  zip.file("stop_times.txt", "trip_id,stop_sequence,stop_id,arrival_time,departure_time\nt1,1,1,20:05:00,20:05:30\nt1,2,2,25:10:00,\nt2,1,1,08:00:00,08:00:00\n");
  zip.file("shapes.txt", "shape_id,shape_pt_sequence,shape_pt_lat,shape_pt_lon\nsh1,2,50.03,22.02\nsh1,1,50.04,22.00\n");
  zip.file("calendar_dates.txt", "service_id,date,exception_type\ns1,20261105,1\n");
  return zip.generateAsync({ type: "nodebuffer" });
}

test("a feed becomes a schedule the database accepts", async () => {
  const payload = await parseFeed(await sampleZip(), "ztm", "gtfs:test");
  assert.doesNotThrow(() => validateSchedulePayload("ztm", payload));
  assert.equal(payload.routes[0].color, "#DD3300");
  assert.equal(payload.stops[0].name, "Dworzec, Główny");
  assert.deepEqual(payload.trips.map((trip) => trip.id), ["t1"]);
  assert.deepEqual(payload.stopTimes.map((row) => [row.sequence, row.arrival_seconds, row.departure_seconds]), [[1, 72300, 72330], [2, 90600, 90600]]);
  assert.deepEqual(payload.shapes[0].points, [[50.04, 22.0], [50.03, 22.02]]);
  assert.deepEqual(payload.calendarDates, [{ service_id: "s1", date: "20261105", exception_type: 1 }]);
});

test("PKS IDs are prefixed so they cannot clash with ZTM", async () => {
  const payload = await parseFeed(await sampleZip(), "pks", "gtfs:test");
  assert.equal(payload.routes[0].id, "pks:1_18");
  assert.equal(payload.trips[0].service, "pks:s1");
  assert.equal(payload.stopTimes[0].stop_id, "pks:1");
  assert.doesNotThrow(() => validateSchedulePayload("pks", payload));
});

function fakes({ stored = null, etag = '"v1"' } = {}) {
  const calls = { replace: 0, read: 0, parse: 0 };
  let hash = stored;
  return {
    calls,
    store: createScheduleStore({
      agencies: ["ztm"],
      timetables: { get: async () => ({ buffer: Buffer.from("zip"), etag }) },
      parse: async (buffer, agency, sourceKey) => { calls.parse += 1; return { sourceKey, stopTimes: [] }; },
      database: {
        importedHash: async () => hash,
        replace: async (agency, payload) => { calls.replace += 1; hash = sourceHash(payload.sourceKey); },
        read: async () => { calls.read += 1; return { routes: [{ id: "1" }] }; },
      },
    }),
  };
}

test("a new feed is imported once and then served compressed", async () => {
  const { store, calls } = fakes();
  assert.equal(store.get("ztm"), null);
  await store.sync();
  await store.sync();
  assert.deepEqual(calls, { replace: 1, read: 1, parse: 1 });
  const copy = store.get("ztm");
  assert.deepEqual(JSON.parse(zlib.gunzipSync(copy.body)), { routes: [{ id: "1" }] });
  assert.match(copy.etag, /^"[a-f0-9]{32}"$/);
});

test("after a restart an unchanged feed is read back without importing again", async () => {
  const { store, calls } = fakes({ stored: sourceHash('gtfs:"v1"') });
  await store.sync();
  assert.deepEqual(calls, { replace: 0, read: 1, parse: 0 });
  assert.ok(store.get("ztm"));
});

test("a failed import leaves the app running without a database copy", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const store = createScheduleStore({
    agencies: ["ztm"],
    timetables: { get: async () => ({ buffer: Buffer.from("zip"), etag: '"v1"' }) },
    parse: async () => ({ stopTimes: [] }),
    database: { importedHash: async () => null, replace: async () => { throw new Error("database busy"); }, read: async () => ({}) },
  });
  await store.sync();
  assert.equal(store.get("ztm"), null);
  assert.equal(errors.mock.callCount(), 1);
});
