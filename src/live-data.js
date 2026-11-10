"use strict";

const { ageOf, packSnapshot } = require("./snapshots");

const USER_AGENT = "komunikacja-rzeszow/1.0 (https://github.com/qubexon-pl/komunikacja)";
const FETCH_TIMEOUT_MS = 15000;
const FRESH_SHARE = 0.9;
const POSITIONS = { type: "application/octet-stream", everyMs: 20 * 1000, retryMs: 5 * 60 * 1000, maxAgeMs: 5 * 60 * 1000 };
const LIVE_SOURCES = {
  ztm: { ...POSITIONS, urls: ["https://kmrzeszow.live/gtfs/rt/gtfsrt.pb", "https://www.mpkrzeszow.pl/gtfs/rt/gtfsrt.pb"] },
  pks: { ...POSITIONS, urls: ["https://kmrzeszow.live/gtfs-pks/rt/gtfsrt.pb", "https://www.mpkrzeszow.pl/gtfs-pks/rt/gtfsrt.pb"] },
  weather: {
    type: "application/json; charset=utf-8",
    everyMs: 30 * 60 * 1000,
    retryMs: 5 * 60 * 1000,
    maxAgeMs: 3 * 60 * 60 * 1000,
    urls: ["https://api.open-meteo.com/v1/forecast?latitude=50.0412&longitude=21.9991&current=temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,is_day&hourly=temperature_2m,precipitation_probability,precipitation,weather_code&forecast_hours=8&timezone=Europe%2FWarsaw"],
  },
};

// Runs on the server on a fixed schedule. Visitors read the result from the database, so they never reach these sources.
function createLiveCollector({ snapshots, sources = LIVE_SOURCES, fetchSource = fetch, now = Date.now }) {
  const feeds = Object.entries(sources).map(([name, source]) => ({ name, source, key: `live:${name}`, timer: null, working: source.urls[0] }));
  let running = false;

  async function load(feed) {
    const urls = [feed.working, ...feed.source.urls.filter((url) => url !== feed.working)];
    for (const url of urls) {
      try {
        const response = await fetchSource(new URL(url), { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        // A missing feed can answer with an ordinary web page.
        if (!response.ok || response.headers.get("content-type")?.includes("text/html")) continue;
        const body = Buffer.from(await response.arrayBuffer());
        if (!body.length) continue;
        await snapshots.save(feed.key, await packSnapshot(body, feed.source.type));
        feed.working = url;
        return true;
      } catch (error) {
        console.warn(`Live source ${feed.name} failed:`, error.message);
      }
    }
    return false;
  }

  // A restart or a second copy of the app finds a fresh snapshot and leaves the source alone.
  async function refresh(feed) {
    const info = await snapshots.info(feed.key).catch(() => null);
    if (info && ageOf(info, now()) < feed.source.everyMs * FRESH_SHARE) return true;
    return load(feed);
  }

  async function run(feed) {
    const loaded = await refresh(feed);
    if (!running) return;
    feed.timer = setTimeout(() => run(feed), loaded ? feed.source.everyMs : feed.source.retryMs);
    feed.timer.unref?.();
  }

  return {
    refresh: () => Promise.all(feeds.map(refresh)),
    start() {
      running = true;
      for (const feed of feeds) run(feed);
    },
    stop() {
      running = false;
      for (const feed of feeds) clearTimeout(feed.timer);
    },
  };
}

module.exports = { LIVE_SOURCES, createLiveCollector };
