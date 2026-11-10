"use strict";

const { sourceHash } = require("./database");
const { parseFeed } = require("./gtfs-import");
const { packSnapshot } = require("./snapshots");

const CHECK_MS = 60 * 60 * 1000;

// The database is the source of truth. Visitors get a compressed copy prepared once per import, also kept there.
function createScheduleStore({ database, snapshots, timetables, parse = parseFeed, agencies = ["ztm", "pks"] }) {
  let queue = Promise.resolve();
  let timer = null;

  async function buildCopy(agency) {
    await snapshots.save(`schedule:${agency}`, await packSnapshot(await database.read(agency)));
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
    if (stored && !await snapshots.info(`schedule:${agency}`)) await buildCopy(agency);
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

  return { start, stop, sync: syncAll };
}

module.exports = { createScheduleStore };
