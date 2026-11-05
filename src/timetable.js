"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const DAY_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000;
const CHECK_MS = 60 * 60 * 1000;
const MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_DIR = path.resolve(__dirname, "..", ".cache", "timetables");
const SOURCES = {
  ztm: ["https://mkuran.pl/gtfs/rzeszow.zip"],
  pks: [
    "https://kmrzeszow.live/gtfs/pks.zip",
    "https://kmrzeszow.live/gtfs/pks/gtfs.zip",
    "https://www.mpkrzeszow.pl/gtfs/pks.zip",
  ],
};

function isZip(buffer) {
  return buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
}

function etagOf(buffer) {
  return `"${crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 32)}"`;
}

// Keeps a copy of each timetable on disk, so visitors do not depend on the source being up.
function createTimetableStore({
  fetchSource = fetch,
  dir = process.env.TIMETABLE_CACHE_DIR || DEFAULT_DIR,
  sources = SOURCES,
  maxAgeMs = DAY_MS,
  retryMs = RETRY_MS,
} = {}) {
  const feeds = new Map(Object.keys(sources).map((agency) => [agency, { buffer: null, etag: null, fetchedAt: 0, failedAt: 0, loaded: false, refreshing: null }]));
  let timer = null;

  async function readDisk(agency, feed) {
    feed.loaded = true;
    const file = path.join(dir, `${agency}.zip`);
    try {
      const [buffer, stats] = await Promise.all([fs.readFile(file), fs.stat(file)]);
      if (isZip(buffer)) Object.assign(feed, { buffer, etag: etagOf(buffer), fetchedAt: stats.mtimeMs });
    } catch (error) {
      if (error.code !== "ENOENT") console.error(`Timetable cache for ${agency} could not be read:`, error.message);
    }
  }

  async function download(agency, feed) {
    for (const url of sources[agency]) {
      try {
        const response = await fetchSource(new URL(url), { signal: AbortSignal.timeout(60000) });
        if (!response.ok) continue;
        const buffer = Buffer.from(await response.arrayBuffer());
        if (!isZip(buffer) || buffer.length > MAX_BYTES) continue;
        await fs.mkdir(dir, { recursive: true });
        const file = path.join(dir, `${agency}.zip`);
        await fs.writeFile(`${file}.tmp`, buffer);
        await fs.rename(`${file}.tmp`, file);
        Object.assign(feed, { buffer, etag: etagOf(buffer), fetchedAt: Date.now(), failedAt: 0 });
        return;
      } catch (error) {
        console.error(`Timetable download from ${url} failed:`, error.message);
      }
    }
    feed.failedAt = Date.now();
  }

  function refresh(agency, feed) {
    if (!feed.refreshing) {
      feed.refreshing = download(agency, feed).finally(() => { feed.refreshing = null; });
    }
    return feed.refreshing;
  }

  async function get(agency) {
    const feed = feeds.get(agency);
    if (!feed) return null;
    if (!feed.loaded) await readDisk(agency, feed);
    const stale = Date.now() - feed.fetchedAt >= maxAgeMs;
    const mayRetry = Date.now() - feed.failedAt >= retryMs;
    if (stale && mayRetry) {
      const update = refresh(agency, feed);
      if (!feed.buffer) await update;
    }
    return feed.buffer ? { buffer: feed.buffer, etag: feed.etag } : null;
  }

  function start() {
    const check = () => Promise.all([...feeds.keys()].map(get)).catch((error) => console.error("Timetable refresh failed:", error.message));
    check();
    timer = setInterval(check, CHECK_MS);
    timer.unref();
  }

  function stop() {
    clearInterval(timer);
  }

  return { get, start, stop };
}

module.exports = { createTimetableStore };
