"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.resolve(__dirname, "../assets/app.js"), "utf8");
const start = source.indexOf("const FEED_GRACE_MS=");
const end = source.indexOf("async function refreshLive(){");

function loadFeeds(fetchFirst) {
  const context = { fetchFirst, setTimeout, Promise, Map, Error };
  vm.runInNewContext(`${source.slice(start, end).replace("FEED_GRACE_MS=2500", "FEED_GRACE_MS=20")}; this.feedResult = feedResult;`, context);
  return context.feedResult;
}

const ztm = { urls: ["ztm"] };
const pks = { urls: ["pks"] };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a slow second feed does not hold up the first", async () => {
  let finishPks;
  const feedResult = loadFeeds((urls) => (urls[0] === "ztm"
    ? Promise.resolve({ url: "ztm" })
    : new Promise((resolve) => { finishPks = resolve; })));
  const [first, second] = await Promise.allSettled([ztm, pks].map(feedResult));
  assert.equal(first.status, "fulfilled");
  assert.equal(second.status, "rejected");
  finishPks({ url: "pks" });
});

test("a slow feed reaches the map on the next refresh without restarting", async () => {
  let calls = 0;
  let finishPks;
  const feedResult = loadFeeds(() => {
    calls += 1;
    return new Promise((resolve) => { finishPks = resolve; });
  });
  await assert.rejects(feedResult(pks, 1));
  await assert.rejects(feedResult(pks, 1));
  assert.equal(calls, 1);
  finishPks({ url: "pks" });
  await wait(5);
  assert.equal((await feedResult(pks, 1)).url, "pks");
  assert.equal(calls, 2);
  finishPks({ url: "pks-2" });
  await wait(5);
  assert.equal((await feedResult(pks, 1)).url, "pks-2");
});

test("the last good data covers a refresh still in progress, and a failure clears it", async () => {
  const results = [Promise.resolve({ url: "good" }), new Promise(() => {})];
  const feedResult = loadFeeds(() => results.shift());
  assert.equal((await feedResult(pks, 1)).url, "good");
  await wait(5);
  assert.equal((await feedResult(pks, 1)).url, "good");

  let failFeed;
  const failing = loadFeeds(() => new Promise((_, reject) => { failFeed = reject; }));
  const attempt = failing(pks, 1);
  failFeed(new Error("offline"));
  await assert.rejects(attempt, /offline/);
});

test("the first feed reports its real failure", async () => {
  const feedResult = loadFeeds(() => Promise.reject(new Error("offline")));
  await assert.rejects(feedResult(ztm, 0), /offline/);
});

const fetchSource = source.slice(source.indexOf("function isZip(buf){"), source.lastIndexOf("/* ===", source.indexOf("GTFS-Realtime (protobuf)")));

function loadFetchBin(proxy, responses) {
  const requested = [];
  const context = {
    CFG: { proxy, proxyCustom: "https://custom/?u=" },
    encodeURIComponent,
    Uint8Array,
    Date,
    Math,
    Error,
    fetchTimeout: async (url) => {
      requested.push(url.split(/[?&]_=/)[0]);
      const response = Object.entries(responses).find(([prefix]) => url.startsWith(prefix))?.[1];
      if (!response) throw new Error("blocked");
      return response;
    },
  };
  vm.runInNewContext(`${fetchSource}; this.fetchBin = fetchBin; this.fetchFirst = fetchFirst; this.isZip = isZip;`, context);
  return { fetchBin: context.fetchBin, fetchFirst: context.fetchFirst, isZip: context.isZip, requested };
}

const zip = new Uint8Array([0x50, 0x4b, 3, 4]).buffer;
const html = new TextEncoder().encode("<html>").buffer;
const file = "https://feed/a.zip";

test("the app's own server is tried whatever proxy setting was saved", async () => {
  for (const proxy of ["direct", "custom", "auto"]) {
    const { fetchBin, requested } = loadFetchBin(proxy, { "/api/feeds/fetch": zip });
    assert.equal(await fetchBin(file), zip);
    assert.ok(requested.at(-1).startsWith("/api/feeds/fetch"), proxy);
  }
});

test("each address gets a direct and a server attempt, in order", async () => {
  const second = "https://feed/b.pb";
  const { fetchFirst, requested } = loadFetchBin("auto", { [second]: zip });
  assert.equal((await fetchFirst([file, second], 1000)).url, second);
  assert.deepEqual(requested, [file, `/api/feeds/fetch?url=${encodeURIComponent(file)}`, second]);
});

test("no request goes through a third-party proxy", () => {
  assert.doesNotMatch(source, /corsproxy|allorigins|codetabs/);
});

test("a response that is not a zip gives up on that address", async () => {
  const { fetchBin, isZip, requested } = loadFetchBin("auto", { [file]: html, "/api/feeds/fetch": zip });
  await assert.rejects(fetchBin(file, 1000, isZip), /nieprawidłowa/);
  assert.equal(requested.length, 1);
  assert.equal(isZip(new ArrayBuffer(0)), false);
  assert.equal(isZip(zip), true);
});
