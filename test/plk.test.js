"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const zlib = require("node:zlib");

const { compactOperation, compactSchedule, createPlkCollector, scheduleKey } = require("../src/plk");

const DAY = "2026-11-06";
const NOW = Date.parse(`${DAY}T12:00:00Z`);
const running = (oid, status = "P", od = DAY) => ({ sid: 2026, oid, od, s: status, st: [{ id: 1, aa: `${DAY}T10:00:00`, adm: 2, cf: true }, { id: 2 }] });

function answer(url) {
  if (url.pathname.endsWith("schedules/shortened")) return Response.json({ rt: [{ sid: 2026, oid: 5, ccs: "IC", nn: "3810", st: [{ id: 1, dtm: "08:00:00" }] }], dc: { st: {}, cr: {} } });
  const page = Number(url.searchParams.get("page") || 1);
  return Response.json({ tr: [running(page)], pg: { hn: page < 4 } });
}

function collector({ key = "secret", respond = answer, savedKeys = [], refreshMinutes = 20 } = {}) {
  const calls = [];
  const saved = new Map();
  const clock = { now: NOW };
  const snapshots = {
    info: async (name) => saved.get(name) || null,
    save: async (name, snapshot) => { saved.set(name, { ...snapshot, fetchedAt: new Date(clock.now) }); },
    prune: async (prefix, before) => { for (const name of saved.keys()) if (name.startsWith(prefix) && name < `${prefix}${before}`) saved.delete(name); },
  };
  const plk = createPlkCollector({
    snapshots,
    refreshMinutes,
    readKey: async () => (key ? { value: key, updatedAt: "2026-11-06T10:00:00.000Z" } : null),
    saveKey: async (value) => { savedKeys.push(value); },
    fetchSource: async (url, options) => { calls.push({ url, key: options.headers["X-API-Key"] }); return respond(url); },
    now: () => clock.now,
  });
  return { calls, clock, plk, saved, savedKeys };
}

const read = (saved, name) => JSON.parse(zlib.gunzipSync(saved.get(name).body));
const operationCalls = (calls) => calls.filter((call) => call.url.pathname.endsWith("operations/shortened"));
const scheduleCalls = (calls) => calls.filter((call) => call.url.pathname.endsWith("schedules/shortened"));

test("a timetable is cut down to what the app shows, including trains running past midnight", () => {
  const compact = compactSchedule({
    rt: [{ sid: 2026, oid: 7, ccs: "IC", nn: "3810", nm: "KOSSAK", cc: "IC", st: [{ id: 1, dtm: "23:50:00", dpl: "2", dtr: "4" }, { id: 2, atm: "00:10:00", ady: 1, apl: "1" }] }],
    dc: { st: { 1: { id: 1, nm: "Rzeszów Główny", lat: 50, lon: 22 } }, cr: { IC: "PKP Intercity" } },
  });
  assert.deepEqual(compact.trains, [[2026, 7, "IC", "3810", "KOSSAK", "IC", [[1, null, 85800, "2", "4"], [2, 87000, null, "1", ""]]]]);
  assert.deepEqual(compact.stations, [[1, "Rzeszów Główny", 50, 22]]);
  assert.deepEqual(compact.carriers, [["IC", "PKP Intercity"]]);
});

test("live data keeps only stops with something to report", () => {
  assert.deepEqual(compactOperation(running(9)), [2026, 9, DAY, "P", [[1, 2, null, `${DAY}T10:00:00`, null, 1, 0]]]);
});

const fill = async (plk, clock) => { for (let run = 0; run < 4; run += 1) { if (run) clock.now += 20 * 60 * 1000; await plk.refresh(); } };

test("one refresh stores every live page and starts with the nearest timetables", async () => {
  const { calls, plk, saved } = collector();
  await plk.refresh();
  assert.equal(operationCalls(calls).length, 4);
  assert.equal(scheduleCalls(calls).length, 25);
  assert.equal(calls[0].key, "secret");
  assert.equal(calls[0].url.searchParams.has("stations"), false);
  assert.deepEqual(read(saved, "plk:operations").map((train) => train[1]), [1, 2, 3, 4]);
  assert.ok(saved.has(scheduleKey(DAY)));
  assert.ok(saved.has(scheduleKey("2026-11-05")));
  assert.ok(!JSON.stringify([...saved.values()].map((entry) => entry.etag)).includes("secret"));
});

test("three months of timetables arrive within the hourly limit, without blocking delays", async () => {
  const { calls, clock, plk, saved } = collector();
  for (let run = 0; run < 4; run += 1) { await plk.refresh(); clock.now += 20 * 60 * 1000; }
  assert.equal(scheduleCalls(calls).length, 92);
  assert.ok(saved.has(scheduleKey("2027-02-04")));
  assert.equal(operationCalls(calls).length, 16);
  assert.ok(calls.length < 110);
});

test("delays refresh on the set interval and timetables once a day", async () => {
  const { calls, clock, plk } = collector();
  await fill(plk, clock);
  const timetables = scheduleCalls(calls).length;
  const delays = operationCalls(calls).length;
  clock.now += 20 * 60 * 1000;
  await plk.refresh();
  assert.equal(operationCalls(calls).length, delays + 4);
  assert.equal(scheduleCalls(calls).length, timetables);
  clock.now += 24 * 60 * 60 * 1000;
  await plk.refresh();
  assert.equal(scheduleCalls(calls).length, timetables + 25);
});

test("a restart finds fresh data in the database and calls nobody", async () => {
  const { calls, clock, plk } = collector();
  await fill(plk, clock);
  const before = calls.length;
  await plk.refresh();
  assert.equal(calls.length, before);
});

test("the interval can be changed", async () => {
  const { calls, clock, plk } = collector({ refreshMinutes: 5 });
  await plk.refresh();
  clock.now += 5 * 60 * 1000;
  await plk.refresh();
  assert.equal(operationCalls(calls).length, 8);
});

test("finished trains and older days are left out of the live copy", async () => {
  const { plk, saved } = collector({ respond: (url) => (url.pathname.endsWith("operations/shortened") ? Response.json({ tr: [running(1), running(2, "C"), running(3, "P", "2026-11-04"), running(4, "P", "2026-11-05")], pg: {} }) : answer(url)) });
  await plk.refresh();
  assert.deepEqual(read(saved, "plk:operations").map((train) => train[1]), [1, 4]);
});

test("old timetables are removed from the database", async () => {
  const { clock, plk, saved } = collector();
  await plk.refresh();
  assert.ok(saved.has(scheduleKey(DAY)));
  clock.now += 3 * 86400000;
  await plk.refresh();
  assert.ok(!saved.has(scheduleKey(DAY)));
});

test("without a saved key PKP is not called", async () => {
  const { calls, plk, saved } = collector({ key: null });
  await plk.refresh();
  assert.deepEqual(await plk.status(), { configured: false, updatedAt: null });
  assert.equal(calls.length, 0);
  assert.equal(saved.size, 0);
});

test("a failed page keeps the last complete copy", async (t) => {
  t.mock.method(console, "error", () => {});
  let fail = false;
  const { clock, plk, saved } = collector({ respond: (url) => (fail && url.searchParams.get("page") === "3" ? new Response("{}", { status: 500 }) : answer(url)) });
  await plk.refresh();
  const before = saved.get("plk:operations").fetchedAt;
  fail = true;
  clock.now += 20 * 60 * 1000;
  await plk.refresh();
  assert.equal(saved.get("plk:operations").fetchedAt, before);
});

test("a refusal pauses further calls", async (t) => {
  t.mock.method(console, "error", () => {});
  const { calls, clock, plk } = collector({ respond: () => new Response("{}", { status: 429 }) });
  await plk.refresh();
  assert.equal(calls.length, 1);
  clock.now += 60 * 1000;
  await plk.refresh();
  assert.equal(calls.length, 1);
  clock.now += 10 * 60 * 1000;
  await plk.refresh();
  assert.equal(calls.length, 2);
});

test("the hourly and daily budgets hold, however often it runs", async () => {
  const { calls, clock, plk } = collector({ refreshMinutes: 1 });
  for (let round = 0; round < 60; round += 1) { clock.now += 60 * 1000; await plk.refresh(); }
  assert.ok(calls.length <= 90);
  for (let round = 0; round < 23 * 60; round += 1) { clock.now += 60 * 1000; await plk.refresh(); }
  assert.ok(calls.length <= 950);
});

test("a key is saved only after PKP accepts it", async () => {
  let accepted = false;
  const { plk, savedKeys } = collector({ respond: () => (accepted ? Response.json({}) : new Response("{}", { status: 401 })) });
  assert.equal(await plk.setKey("wrong"), false);
  assert.deepEqual(savedKeys, []);
  accepted = true;
  assert.equal(await plk.setKey("right"), true);
  assert.deepEqual(savedKeys, ["right"]);
});
