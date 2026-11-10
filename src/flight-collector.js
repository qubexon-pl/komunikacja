"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");

const TRACKER_DB = path.join("data", "flights.db");
const WATCH_PREFIX = "komunikacja: ";
const DEFAULT_ROUTES = "RZE:STN,LTN,EDI,DUB,ALC,BGY;KRK:STN,DUB,BCN,BGY;KTW:LTN,EIN,BCN,BGY";
const RUN_TIMEOUT_MS = 30 * 60 * 1000;
const WIZZ_DAY_TIMEOUT_MS = 30 * 1000;
const STAY_DAYS = 3;
const SCAN_STAY_DAYS = 1;

const isoDay = (date) => date.toISOString().slice(0, 10);
const AIRLINES = ["RYANAIR", "WIZZ"];

function trackerDatabase(dir) {
  return path.join(dir, TRACKER_DB);
}

// The whole route list for the days an administrator picked.
function buildWatches(routes, start, end, airlines = AIRLINES) {
  return routes.split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const [origin, destinations] = part.split(":");
    return { name: `${WATCH_PREFIX}${origin}`, origin, destinations, start, end, min_days: STAY_DAYS, max_days: STAY_DAYS, airlines: airlines.join(",") };
  });
}

// One watch per origin and airline, so an airline is only asked about the routes it flies.
// The tracker opens a day with its return one stay later, so a one-day stay past the end reaches the last chosen day.
function watchesForPairs(pairs, start, end) {
  const groups = new Map();
  const lastDay = isoDay(new Date(Date.parse(`${end}T12:00:00Z`) + SCAN_STAY_DAYS * 86400000));
  for (const { from, to, airlines } of pairs) {
    for (const airline of airlines) {
      const key = `${from} ${airline}`;
      if (!groups.has(key)) groups.set(key, { name: `${WATCH_PREFIX}${key}`, origin: from, destinations: [], start, end: lastDay, min_days: SCAN_STAY_DAYS, max_days: SCAN_STAY_DAYS, airlines: airline });
      groups.get(key).destinations.push(to);
    }
  }
  return [...groups.values()].map((watch) => ({ ...watch, destinations: watch.destinations.join(",") }));
}

// Several routes with their own days in one run, e.g. the way out on the 16th and back on the 23rd.
function watchesForJobs(jobs) {
  return jobs.flatMap((job) => watchesForPairs(job.pairs, job.start, job.end).map((watch) => ({ ...watch, name: `${watch.name} ${job.start}` })));
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

// The Wizz flight finder page is addressed by city name ("krakow", "bratyslawa"), not by airport code.
function wizzSlug(name) {
  return String(name || "").toLowerCase().replace(/ł/g, "l").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
async function writeWizzCities(dir, network) {
  const cities = {};
  for (const airport of network?.airports || []) {
    const slug = wizzSlug(airport.wizzName || airport.city);
    if (slug) cities[airport.code] = slug;
  }
  await fs.mkdir(path.join(dir, "data"), { recursive: true });
  await fs.writeFile(path.join(dir, "data", "wizz-cities.json"), JSON.stringify(cities, null, 1));
}

function wizzTime(pairs, start, end) {
  const days = (Date.parse(end) - Date.parse(start)) / 86400000 + 1;
  return pairs.filter((pair) => pair.airlines.includes("WIZZ")).length * days * WIZZ_DAY_TIMEOUT_MS;
}
function scanTimeout(jobs) {
  return RUN_TIMEOUT_MS + jobs.reduce((sum, job) => sum + wizzTime(job.pairs, job.start, job.end), 0);
}

function runTracker(dir, { wizzMode = "", timeoutMs = RUN_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    // Wizz Air shows the tracker's browser no flights, so the tracker collects Ryanair only.
    const env = { ...process.env, WIZZ_ENABLED: "false", ...(wizzMode ? { WIZZ_MODE: wizzMode } : {}) };
    const child = spawn(process.execPath, ["--use-system-ca", "--no-warnings=ExperimentalWarning", "src/collect.js"], { cwd: dir, env, stdio: "inherit" });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`flight-tracker exited with code ${code}.`));
    });
  });
}

// Flights are fetched only on request (an administrator, or a trip search for its own days): each run opens a browser and calls the airlines.
function createFlightCollector({
  flights,
  dir = process.env.FLIGHT_TRACKER_DIR || "",
  routes = process.env.FLIGHT_ROUTES || DEFAULT_ROUTES,
  prepare = writeWatches,
  collect = runTracker,
  updateNetwork = async () => {},
  now = () => new Date(),
}) {
  let running = false;
  let last = { target: null, startedAt: null, finishedAt: null, error: null };

  // pairs: chosen routes, or jobs: routes each with their own days; without them the configured route list. networkOnly: only the airlines' route list.
  async function run({ pairs = null, jobs = null, start = "", end = "", airlines = AIRLINES, target = null, networkOnly = false } = {}) {
    if (!dir || running) return false;
    running = true;
    last = { target, startedAt: now().toISOString(), finishedAt: null, error: null };
    try {
      if (networkOnly) {
        await updateNetwork({ force: true });
        return true;
      }
      await updateNetwork().catch((error) => console.error("Route list update failed:", error.message));
      const chosen = jobs || (pairs ? [{ pairs, start, end }] : null);
      await prepare(dir, chosen ? watchesForJobs(chosen) : buildWatches(routes, start, end, airlines));
      if (flights.network) await writeWizzCities(dir, flights.network()).catch((error) => console.error("Wizz city names:", error.message));
      await collect(dir, chosen ? { wizzMode: "detailed", timeoutMs: scanTimeout(chosen) } : {});
      await flights.sync();
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

  return { request, run, status };
}

module.exports = { wizzSlug, writeWizzCities, buildWatches, createFlightCollector, trackerDatabase, watchesForJobs, watchesForPairs, writeWatches };
