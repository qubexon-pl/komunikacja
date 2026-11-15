"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createAirportTransfers, recordsFromCsv, localToUtc, utcToLocal, DATA_FILE } = require("../src/airport-transfers");

const plan = (startTime, endTime, legs) => ({ startTime, endTime, legs });
const transitous = (itineraries) => new Response(JSON.stringify({ itineraries }));

test("the bundled CSV parses into one record per airport with coordinates", () => {
  const records = recordsFromCsv(fs.readFileSync(DATA_FILE, "utf8"));
  assert.ok(records.length > 200);
  const arn = records.find((r) => r.code === "ARN");
  assert.equal(arn.mode, "rail");
  assert.equal(arn.pickup.name, "Stockholm Arlanda Central");
  assert.equal(arn.fareEur, 11.4);
  const vie = records.find((r) => r.code === "VIE");
  assert.match(vie.walk, /Air Rail Center/); // quoted field with a comma
  assert.equal(records.find((r) => r.code === "LUX").fareEur, 0);
  assert.equal(new Set(records.map((r) => r.code)).size, records.length);
});

test("local flight times convert to UTC and back across time zones", () => {
  const ms = localToUtc("2026-11-15T19:00", "Europe/Stockholm");
  assert.equal(new Date(ms).toISOString(), "2026-11-15T18:00:00.000Z");
  assert.deepEqual(utcToLocal(ms, "Atlantic/Canary"), { day: "2026-11-15", clock: "18:00" });
  assert.equal(new Date(localToUtc("2026-07-01T12:00", "Europe/London")).toISOString(), "2026-07-01T11:00:00.000Z");
});

test("the database copy is replaced only when the CSV changes, and lookups add the fare in PLN", async () => {
  const settings = new Map();
  let stored = [];
  let replaced = 0;
  const database = {
    readSetting: async (key) => (settings.has(key) ? { value: settings.get(key) } : null),
    saveSetting: async (key, value) => settings.set(key, value),
    replace: async (rows) => { replaced++; stored = rows; },
    read: async () => stored,
  };
  const toPln = async (amount) => amount * 4.3;
  const first = createAirportTransfers({ database, toPln });
  const { transfers, missing } = await first.lookup(["arn", "XXX", "KRK"]);
  assert.deepEqual(transfers.map((t) => t.code).sort(), ["ARN", "KRK"]);
  assert.deepEqual(missing, ["XXX"]);
  assert.equal(transfers.find((t) => t.code === "ARN").farePln, 49);
  assert.equal(transfers.find((t) => t.code === "ARN").zone, "Europe/Stockholm");
  await createAirportTransfers({ database, toPln }).lookup(["ARN"]);
  assert.equal(replaced, 1);
});

test("connections ask Transitous once per trip, from the pickup point after landing, and keep the answer", async () => {
  const asked = [];
  const fetchSource = async (url, options) => {
    asked.push({ url: new URL(url), ua: options.headers["User-Agent"] });
    return transitous([
      plan("2026-11-15T18:34:00Z", "2026-11-15T18:59:00Z", [
        { mode: "WALK", duration: 240, startTime: "2026-11-15T18:34:00Z", endTime: "2026-11-15T18:38:00Z" },
        { mode: "HIGHSPEED_RAIL", displayName: "Arlanda Express", agencyName: "Arlanda Express", headsign: "Stockholm C", from: { name: "Arlanda Norra" }, to: { name: "Stockholm C" }, startTime: "2026-11-15T18:38:00Z", endTime: "2026-11-15T18:58:00Z" },
      ]),
    ]);
  };
  const transfers = createAirportTransfers({ fetchSource, minGapMs: 0 });
  const query = { code: "ARN", lat: 59.3303, lon: 18.0586, time: "2026-11-15T19:00", dir: "from" };
  const result = await transfers.connections(query);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].url.searchParams.get("fromPlace"), "59.64957,17.92809");
  assert.equal(asked[0].url.searchParams.get("time"), "2026-11-15T18:30:00.000Z"); // 19:00 local + 30 min, in UTC
  assert.match(asked[0].ua, /komunikacja/);
  assert.equal(result.trips[0].dep.clock, "19:34");
  assert.equal(result.trips[0].legs[0].kind, "rail");
  assert.equal(result.trips[0].legs[0].line, "Arlanda Express");
  await transfers.connections(query);
  assert.equal(asked.length, 1);
});

test("a destination at the airport itself means the city centre, and the return trip arrives two hours early", async () => {
  const asked = [];
  const fetchSource = async (url) => { asked.push(new URL(url)); return transitous([]); };
  const geocode = async (q) => ({ places: [{ label: q, points: [[59.33, 18.06]] }] });
  const transfers = createAirportTransfers({ fetchSource, geocode, minGapMs: 0 });
  const there = await transfers.connections({ code: "ARN", lat: 59.6485, lon: 17.9288, time: "2026-11-15T19:00", dir: "from" });
  assert.equal(there.target.centre, true);
  assert.equal(there.target.label, "Stockholm");
  await transfers.connections({ code: "ARN", lat: 59.33, lon: 18.06, time: "2026-11-22T09:05", dir: "to" });
  assert.equal(asked[1].searchParams.get("arriveBy"), "true");
  assert.equal(asked[1].searchParams.get("toPlace"), "59.64957,17.92809");
  assert.equal(asked[1].searchParams.get("time"), "2026-11-22T06:00:00.000Z"); // 09:05 local − 2 h, rounded to 15 min, in UTC
});

test("unknown airports and bad input are refused without asking Transitous", async () => {
  let asked = 0;
  const transfers = createAirportTransfers({ fetchSource: async () => { asked++; return transitous([]); }, minGapMs: 0 });
  await assert.rejects(transfers.connections({ code: "ZZZ", lat: 1, lon: 1, time: "2026-11-15T19:00" }), { status: 404 });
  await assert.rejects(transfers.connections({ code: "ARN", lat: 1, lon: 1, time: "tomorrow" }), { status: 400 });
  assert.equal(asked, 0);
});

test("without a city centre the stored ways into town are still offered (Vienna: S7, CAT, Railjet)", async () => {
  const transfers = createAirportTransfers({ fetchSource: async () => transitous([]), geocode: async () => ({ places: [] }), toPln: async (eur) => eur * 4.3, minGapMs: 0 });
  const vie = await transfers.options({ code: "VIE", lat: 48.1208, lon: 16.5630, time: "2027-05-01T14:15", label: "Flughafen Wien" });
  assert.equal(vie.note, "centre-unknown");
  assert.equal(vie.source, "database");
  assert.ok(vie.options.length > 0, "the database copy of the routes is used instead of an empty list");
  assert.ok(vie.options.every((o) => o.kind && o.name));
});
