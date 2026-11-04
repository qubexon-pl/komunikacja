"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.resolve(__dirname, "../assets/app.js"), "utf8");
const start = source.indexOf("function rawTripId(id){");
const end = source.indexOf("function dirKey(t){");

function loadResolver(trips, runningOn) {
  const tripAlias = new Map();
  const context = {
    GT: { trips: new Map(Object.entries(trips)), tripAlias },
    dayInfo: (offset) => ({ offset }),
    serviceOn: (service, day) => runningOn[day.offset]?.includes(service) ?? false,
  };
  vm.runInNewContext(source.slice(start, end), context);
  for (const id of Object.keys(trips)) {
    const raw = context.rawTripId(id);
    if (raw !== id) tripAlias.set(raw, [...(tripAlias.get(raw) || []), id]);
  }
  return context.resolveTripId;
}

const trips = {
  "2026-10-01_100": { service: "october" },
  "2026-11-02_100": { service: "november" },
  "pks:2026-10-01_100": { service: "pks" },
  plain: { service: "october" },
};

test("a live trip ID resolves to the timetable version running today", () => {
  assert.equal(loadResolver(trips, { 0: ["october"] })("100"), "2026-10-01_100");
  assert.equal(loadResolver(trips, { 0: ["november"] })("100"), "2026-11-02_100");
});

test("a trip running past midnight falls back to yesterday's service", () => {
  assert.equal(loadResolver(trips, { "-1": ["october"] })("100"), "2026-10-01_100");
});

test("a trip with no running service still resolves so its line can be shown", () => {
  assert.equal(loadResolver(trips, {})("100"), "2026-11-02_100");
});

test("agency prefixes stay separate and exact or unknown IDs are unchanged", () => {
  const resolve = loadResolver(trips, { 0: ["pks", "november"] });
  assert.equal(resolve("pks:100"), "pks:2026-10-01_100");
  assert.equal(resolve("plain"), "plain");
  assert.equal(resolve("999"), "999");
  assert.equal(resolve(null), null);
});
