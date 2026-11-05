"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createTimetableStore } = require("../src/timetable");
const { normalizeFavorites, MAX_FAVORITES } = require("../src/favorites");

const zip = (marker) => new Uint8Array([0x50, 0x4b, 3, 4, marker]);
const reply = (body, status = 200) => new Response(body, { status });

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "timetable-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test("a timetable is downloaded once and then served from memory", async (t) => {
  let calls = 0;
  const store = createTimetableStore({
    dir: await tempDir(t),
    sources: { ztm: ["https://a.example/ztm.zip"] },
    fetchSource: async () => { calls += 1; return reply(zip(1)); },
  });
  const first = await store.get("ztm");
  const second = await store.get("ztm");
  assert.equal(calls, 1);
  assert.equal(first.etag, second.etag);
  assert.equal(await store.get("unknown"), null);
});

test("a saved timetable survives a restart while the source is down", async (t) => {
  const dir = await tempDir(t);
  const sources = { ztm: ["https://a.example/ztm.zip"] };
  await createTimetableStore({ dir, sources, fetchSource: async () => reply(zip(2)) }).get("ztm");
  const restarted = createTimetableStore({ dir, sources, maxAgeMs: 0, fetchSource: async () => { throw new Error("down"); } });
  const feed = await restarted.get("ztm");
  assert.equal(feed.buffer[4], 2);
});

test("an HTML page is rejected and the next source is tried", async (t) => {
  const store = createTimetableStore({
    dir: await tempDir(t),
    sources: { ztm: ["https://a.example/bad", "https://b.example/ztm.zip"] },
    fetchSource: async (url) => reply(url.hostname === "a.example" ? "<html>sorry</html>" : zip(3)),
  });
  assert.equal((await store.get("ztm")).buffer[4], 3);
});

test("failed sources are not retried on every request", async (t) => {
  let calls = 0;
  const store = createTimetableStore({
    dir: await tempDir(t),
    sources: { pks: ["https://a.example/pks.zip"] },
    fetchSource: async () => { calls += 1; return reply("gone", 404); },
  });
  assert.equal(await store.get("pks"), null);
  assert.equal(await store.get("pks"), null);
  assert.equal(calls, 1);
});

test("favourites keep only known fields and drop duplicates", () => {
  const route = { type: "route", view: "ztm", from: "Lwowska 12", to: "Hetmańska 40", admin: true };
  const result = normalizeFavorites([
    route,
    { ...route },
    { type: "stop", view: "kolej", name: "  Łańcut " },
    { type: "stop", view: "koncowe", name: "Nie" },
    { type: "route", view: "ztm", from: "Tylko skąd" },
    { type: "script", view: "ztm", name: "x" },
    null,
  ]);
  assert.deepEqual(result, [
    { type: "route", view: "ztm", from: "Lwowska 12", to: "Hetmańska 40" },
    { type: "stop", view: "kolej", name: "Łańcut" },
  ]);
  assert.deepEqual(normalizeFavorites("nope"), []);
});

test("favourites are limited in number and length", () => {
  const many = Array.from({ length: 80 }, (_, index) => ({ type: "stop", view: "ztm", name: `Stop ${index}` }));
  assert.equal(normalizeFavorites(many).length, MAX_FAVORITES);
  assert.equal(normalizeFavorites([{ type: "stop", view: "ztm", name: "x".repeat(500) }])[0].name.length, 200);
});
