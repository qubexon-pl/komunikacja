"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { WINDOW_DAYS, lastChange } = require("./flights");

const TRACKER_DB = path.join("data", "flights.db");
const WATCH_PREFIX = "komunikacja: ";
const DEFAULT_ROUTES = "RZE:STN,LTN,EDI,DUB,ALC,BGY;KRK:STN,DUB,BCN,BGY;KTW:LTN,EIN,BCN,BGY";
const DEFAULT_INTERVAL_HOURS = 24;
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const RUN_TIMEOUT_MS = 90 * 60 * 1000;
const STAY_DAYS = 3;
const FULL_RUN_MARKER = path.join("data", "komunikacja-last-full-run");

const isoDay = (date) => date.toISOString().slice(0, 10);

function trackerDatabase(dir) {
  return path.join(dir, TRACKER_DB);
}

function buildWatches(routes, now, days = WINDOW_DAYS) {
  const start = isoDay(now);
  const end = isoDay(new Date(now.getTime() + days * 86400000));
  return routes.split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const [origin, destinations] = part.split(":");
    return { name: `${WATCH_PREFIX}${origin}`, origin, destinations, start, end, min_days: STAY_DAYS, max_days: STAY_DAYS, airlines: "RYANAIR,WIZZ" };
  });
}

// One watch per origin and airline, so an airline is only asked about the routes it flies.
function watchesForPairs(pairs, start, end) {
  const groups = new Map();
  for (const { from, to, airlines } of pairs) {
    for (const airline of airlines) {
      const key = `${from} ${airline}`;
      if (!groups.has(key)) groups.set(key, { name: `${WATCH_PREFIX}${key}`, origin: from, destinations: [], start, end, min_days: STAY_DAYS, max_days: STAY_DAYS, airlines: airline });
      groups.get(key).destinations.push(to);
    }
  }
  return [...groups.values()].map((watch) => ({ ...watch, destinations: watch.destinations.join(",") }));
}

// The tracker reads watches.json only while it has no watches, so later runs move the dates in its database instead.
async function writeWatches(dir, watches) {
  const file = trackerDatabase(dir);
  const exists = await fs.stat(file).then(() => true, () => false);
  if (!exists) {
    await fs.writeFile(path.join(dir, "watches.json"), JSON.stringify(watches, null, 2));
    return;
  }
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(file);
  try {
    db.prepare("DELETE FROM watches WHERE name LIKE ?").run(`${WATCH_PREFIX}%`);
    const add = db.prepare("INSERT INTO watches (name, origin, destinations, start_date, end_date, min_days, max_days, airlines) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    for (const w of watches) add.run(w.name, w.origin, w.destinations, w.start, w.end, w.min_days, w.max_days, w.airlines);
  } finally {
    db.close();
  }
}

function runTracker(dir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--use-system-ca", "--no-warnings=ExperimentalWarning", "src/collect.js"], { cwd: dir, stdio: "inherit" });
    const timer = setTimeout(() => child.kill(), RUN_TIMEOUT_MS);
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`flight-tracker exited with code ${code}.`));
    });
  });
}

function createFlightCollector({
  flights,
  dir = process.env.FLIGHT_TRACKER_DIR || "",
  routes = process.env.FLIGHT_ROUTES || DEFAULT_ROUTES,
  intervalMs = Number(process.env.FLIGHT_COLLECT_HOURS || DEFAULT_INTERVAL_HOURS) * 3600000,
  prepare = writeWatches,
  collect = runTracker,
  statFile = (file) => (file.endsWith(TRACKER_DB) ? lastChange(file) : fs.stat(file)),
  markFullRun = (folder) => fs.writeFile(path.join(folder, FULL_RUN_MARKER), new Date().toISOString()),
  updateNetwork = async () => {},
  now = () => new Date(),
  checkIntervalMs = CHECK_INTERVAL_MS,
}) {
  let running = false;
  let timer = null;
  let last = { target: null, startedAt: null, finishedAt: null, error: null };

  // A refresh of one route must not postpone the daily run, so full runs leave their own marker.
  async function isDue() {
    const stats = await statFile(path.join(dir, FULL_RUN_MARKER)).catch(() => statFile(trackerDatabase(dir))).catch(() => null);
    return !stats || now().getTime() - stats.mtimeMs >= intervalMs;
  }

  async function run({ pairs = null, start = "", end = "", target = null } = {}) {
    if (!dir || running) return false;
    running = true;
    last = { target, startedAt: now().toISOString(), finishedAt: null, error: null };
    try {
      await updateNetwork().catch((error) => console.error("Route list update failed:", error.message));
      await prepare(dir, pairs ? watchesForPairs(pairs, start, end) : buildWatches(routes, now(), WINDOW_DAYS));
      await collect(dir);
      await flights.sync();
      if (!pairs) await markFullRun(dir);
      return true;
    } catch (error) {
      last.error = error.message;
      throw error;
    } finally {
      last.finishedAt = now().toISOString();
      running = false;
    }
  }

  function status() {
    return { available: Boolean(dir), running, ...last };
  }

  // The caller only starts the run; it takes minutes, so progress is read from status().
  function request(target) {
    if (!dir) return "unavailable";
    if (running) return "busy";
    run(target).catch((error) => console.error("Flight collection failed:", error.message));
    return "started";
  }

  async function tick() {
    if (!dir || !(await isDue())) return false;
    return run();
  }

  function start() {
    if (!dir) return;
    const safely = () => tick().catch((error) => console.error("Flight collection failed:", error.message));
    safely();
    timer = setInterval(safely, checkIntervalMs);
    timer.unref?.();
  }

  function stop() {
    clearInterval(timer);
  }

  return { request, run, start, status, stop, tick };
}

module.exports = { buildWatches, createFlightCollector, trackerDatabase, watchesForPairs, writeWatches };
