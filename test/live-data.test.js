"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const zlib = require("node:zlib");

const { createLiveCollector } = require("../src/live-data");

const source = { type: "application/octet-stream", everyMs: 60000, retryMs: 60000, maxAgeMs: 1000, urls: ["https://one.example/feed", "https://two.example/feed"] };
const page = (body, status = 200, type = "application/octet-stream") => new Response(body, { status, headers: { "Content-Type": type } });

function collector(respond) {
  const calls = [];
  const saved = new Map();
  const clock = { now: 100000 };
  const snapshots = {
    info: async (key) => saved.get(key) || null,
    save: async (key, snapshot) => { saved.set(key, { ...snapshot, fetchedAt: new Date(clock.now) }); },
  };
  const live = createLiveCollector({ snapshots, sources: { ztm: source }, fetchSource: async (url) => { calls.push(url.hostname); return respond(url.hostname, calls.length); }, now: () => clock.now });
  return { calls, clock, live, saved };
}

const stored = (saved) => zlib.gunzipSync(saved.get("live:ztm").body).toString();

test("a source is fetched into the database", async () => {
  const { calls, live, saved } = collector(() => page("feed"));
  await live.refresh();
  assert.equal(stored(saved), "feed");
  assert.equal(saved.get("live:ztm").type, "application/octet-stream");
  assert.deepEqual(calls, ["one.example"]);
});

test("a fresh copy in the database is left alone, so a restart costs no call", async () => {
  const { calls, clock, live } = collector(() => page("feed"));
  await live.refresh();
  clock.now += 30000;
  await live.refresh();
  assert.equal(calls.length, 1);
  clock.now += 30000;
  await live.refresh();
  assert.equal(calls.length, 2);
});

test("the next address is used when the first fails, and is tried first from then on", async () => {
  const { calls, clock, live, saved } = collector((host) => (host === "one.example" ? page("gone", 404) : page("feed")));
  await live.refresh();
  assert.equal(stored(saved), "feed");
  assert.deepEqual(calls, ["one.example", "two.example"]);
  clock.now += 60000;
  await live.refresh();
  assert.deepEqual(calls.slice(2), ["two.example"]);
});

test("an ordinary web page or an empty answer is not saved", async () => {
  const { live, saved } = collector((host) => (host === "one.example" ? page("<html>", 200, "text/html") : page("")));
  await live.refresh();
  assert.equal(saved.size, 0);
});

test("the last good copy stays when a source fails", async (t) => {
  t.mock.method(console, "warn", () => {});
  const { clock, live, saved } = collector((host, call) => { if (call === 1) return page("feed"); throw new Error("offline"); });
  await live.refresh();
  clock.now += 70000;
  await live.refresh();
  assert.equal(stored(saved), "feed");
});
