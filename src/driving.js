"use strict";

const ROUTE_URL = "https://router.project-osrm.org/route/v1/driving/";
const PATH_URLS = { walk: "https://routing.openstreetmap.de/routed-foot/route/v1/foot/", car: ROUTE_URL };
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

module.exports = { PATH_URLS, createDrivingRouter, createPathRouter, parsePoint };
