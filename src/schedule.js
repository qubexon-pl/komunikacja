"use strict";

const crypto = require("node:crypto");
const { promisify } = require("node:util");
const zlib = require("node:zlib");
const { sourceHash } = require("./database");
const { parseFeed } = require("./gtfs-import");

const gzip = promisify(zlib.gzip);
const CHECK_MS = 60 * 60 * 1000;

// The database is the source of truth. Visitors get a compressed copy, so it is read once per import, not per person.
function createScheduleStore({ database, timetables, parse = parseFeed, agencies = ["ztm", "pks"] }) {
  const copies = new Map();
  let queue = Promise.resolve();
  let timer = null;

  async function buildCopy(agency) {
    const schedule = await database.read(agency);
    const body = await gzip(JSON.stringify(schedule));
    copies.set(agency, { body, etag: `"${crypto.createHash("sha256").update(body).digest("hex").slice(0, 32)}"` });
  }

  async function sync(agency) {
    const stored = await database.importedHash(agency);
    const feed = await timetables.get(agency);
    if (feed) {
      const sourceKey = `gtfs:${feed.etag}`;
      if (stored !== sourceHash(sourceKey)) {
        const started = Date.now();
        const payload = await parse(feed.buffer, agency, sourceKey);
        await database.replace(agency, payload);
        console.log(`Timetable ${agency} stored in the database: ${payload.stopTimes.length} stop times in ${Math.round((Date.now() - started) / 1000)} s.`);
        await buildCopy(agency);
        return;
      }
    }
    if (stored && !copies.has(agency)) await buildCopy(agency);
  }

  function syncAll() {
    for (const agency of agencies) {
      queue = queue.then(() => sync(agency)).catch((error) => console.error(`Timetable ${agency} database sync failed:`, error.message));
    }
    return queue;
  }

  function start() {
    syncAll();
    timer = setInterval(syncAll, CHECK_MS);
    timer.unref();
  }

  function stop() {
    clearInterval(timer);
  }

  return { get: (agency) => copies.get(agency) || null, start, stop, sync: syncAll };
}

module.exports = { createScheduleStore };
