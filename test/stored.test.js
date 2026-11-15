"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createStoredAnswers } = require("../src/stored");

function memoryStore() {
  const rows = new Map();
  return { rows, read: async (k) => rows.get(k) || null, save: async (k, { body }) => { rows.set(k, body); } };
}

test("a lookup reads the database first and asks the outside service only when nothing fresh is stored", async () => {
  const store = memoryStore();
  let clock = 1_000_000, asked = 0;
  const outside = async (q) => { asked++; return { places: [{ label: q }] }; };
  const first = createStoredAnswers(store, { now: () => clock }).wrap("geo", 60_000, outside, (q) => [q], (v) => !!v?.places?.length);
  assert.deepEqual(await first("Wiedeń"), { places: [{ label: "Wiedeń" }] });
  assert.equal(asked, 1);
  assert.equal(store.rows.size, 1, "the answer is stored for the next visitor");
  // after a restart (new memory), the database copy answers
  const second = createStoredAnswers(store, { now: () => clock }).wrap("geo", 60_000, outside, (q) => [q], (v) => !!v?.places?.length);
  assert.deepEqual(await second("Wiedeń"), { places: [{ label: "Wiedeń" }] });
  assert.equal(asked, 1, "no second call to the outside service");
  // once it is too old, the service is asked again
  clock += 61_000;
  await second("Wiedeń");
  assert.equal(asked, 2);
});

test("errors and empty answers are not stored, and without a database the service is used directly", async () => {
  const store = memoryStore();
  const wrap = createStoredAnswers(store).wrap;
  const empty = wrap("geo", 60_000, async () => ({ places: [] }), (q) => [q], (v) => !!v?.places?.length);
  await empty("Nigdzie");
  assert.equal(store.rows.size, 0);
  const failing = wrap("wx", 60_000, async () => { throw new Error("down"); });
  await assert.rejects(failing(1), /down/);
  assert.equal(store.rows.size, 0);
  const fn = async () => 1;
  assert.equal(createStoredAnswers(null).wrap("x", 1, fn), fn);
});
