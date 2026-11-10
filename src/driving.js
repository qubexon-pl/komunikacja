"use strict";

const ROUTE_URL = "https://router.project-osrm.org/route/v1/driving/";
const PATH_URLS = { walk: "https://routing.openstreetmap.de/routed-foot/route/v1/foot/", car: ROUTE_URL };
const WALK_TABLE_URL = "https://routing.openstreetmap.de/routed-foot/table/v1/foot/";
const MAX_WALK_TARGETS = 25;
const USER_AGENT = "komunikacja-rzeszow/1.0 (https://github.com/qubexon-pl/komunikacja)";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_LIMIT = 500;

function parsePoint(value) {
  const [lat, lon] = String(value || "").split(",").map(Number);
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

function createDrivingRouter({ fetchSource = fetch } = {}) {
  const cache = new Map();

  return async function drive(from, to) {
    const key = [from.lat, from.lon, to.lat, to.lon].map((value) => value.toFixed(3)).join(",");
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.result;

    const url = new URL(`${ROUTE_URL}${from.lon},${from.lat};${to.lon},${to.lat}`);
    url.search = "overview=false";
    const response = await fetchSource(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`OSRM returned HTTP ${response.status}.`);
    const route = (await response.json()).routes?.[0];
    if (!route) return null;
    const result = { km: Math.round(route.distance / 1000), minutes: Math.round(route.duration / 60) };
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
    cache.set(key, { at: Date.now(), result });
    return result;
  };
}

// The line drawn on the trip map, following footpaths or roads.
function createPathRouter({ fetchSource = fetch } = {}) {
  const cache = new Map();

  return async function findPath(mode, from, to) {
    const key = [mode, ...[from.lat, from.lon, to.lat, to.lon].map((value) => value.toFixed(4))].join(",");
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.points;

    const url = new URL(`${PATH_URLS[mode]}${from.lon},${from.lat};${to.lon},${to.lat}`);
    url.search = `overview=${mode === "walk" ? "full" : "simplified"}&geometries=geojson`;
    const response = await fetchSource(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`Routing returned HTTP ${response.status}.`);
    const line = (await response.json()).routes?.[0]?.geometry?.coordinates;
    if (!line) return null;
    const points = line.map(([lon, lat]) => [lat, lon]);
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
    cache.set(key, { at: Date.now(), points });
    return points;
  };
}

// Walking distance along real paths from one place to many stops, in one request.
// The router is a free fair-use service: requests go one at a time with a gap, and a refusal pauses them.
const WALK_GAP_MS = 1100;
const WALK_PAUSE_MS = 60 * 1000;
function createWalkTable({ fetchSource = fetch, gapMs = WALK_GAP_MS, pauseMs = WALK_PAUSE_MS, now = Date.now, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const cache = new Map();
  let queue = Promise.resolve();
  let lastAt = 0;
  let pausedUntil = 0;
  const inTurn = (task) => {
    const run = queue.then(async () => {
      if (now() < pausedUntil) throw new Error("Walking table paused after a refusal.");
      const gap = lastAt + gapMs - now();
      if (gap > 0) await wait(gap);
      try {
        return await task();
      } finally {
        lastAt = now();
      }
    });
    queue = run.catch(() => {});
    return run;
  };

  return async function walkDistances(from, targets) {
    const key = [from, ...targets].map((p) => `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`).join(";");
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.meters;

    const url = new URL(`${WALK_TABLE_URL}${[from, ...targets].map((p) => `${p.lon},${p.lat}`).join(";")}`);
    url.search = "sources=0&annotations=distance";
    const body = await inTurn(async () => {
      const response = await fetchSource(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(15000) });
      if (response.status === 429) pausedUntil = now() + pauseMs;
      if (!response.ok) throw new Error(`Walking table returned HTTP ${response.status}.`);
      return response.json();
    });
    const row = body.distances?.[0];
    if (body.code !== "Ok" || !Array.isArray(row) || row.length !== targets.length + 1) throw new Error("Walking table returned no distances.");
    // The path starts where the place meets the nearest path, so that first stretch is added.
    const start = body.sources?.[0]?.distance || 0;
    const meters = row.slice(1).map((value, i) => (value == null ? null : Math.round(value + start + (body.destinations?.[i + 1]?.distance || 0))));
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
    cache.set(key, { at: Date.now(), meters });
    return meters;
  };
}

module.exports = { MAX_WALK_TARGETS, PATH_URLS, createDrivingRouter, createPathRouter, createWalkTable, parsePoint };
