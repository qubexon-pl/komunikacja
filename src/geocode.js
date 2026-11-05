"use strict";

const SEARCH_URL = "https://nominatim.openstreetmap.org/search";
const SUGGEST_URL = "https://photon.komoot.io/api/";
const USER_AGENT = "komunikacja-rzeszow/1.0 (https://github.com/qubexon-pl/komunikacja)";
const VIEWBOX = "21.45,50.30,22.55,49.75";
const SUGGEST_GAP_MS = 250;
const SUGGEST_LIMIT = 6;
const MIN_REQUEST_GAP_MS = 1100;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_LIMIT = 500;
const MAX_POINTS = 10;
const WORLD_LIMIT = 5;
const SCOPES = {
  area: { limit: "15", countrycodes: "pl", viewbox: VIEWBOX, bounded: "1", layer: "address" },
  country: { limit: "40", countrycodes: "pl", layer: "address" },
  world: { limit: "15" },
};
const PREFIX = /^(ul\.?|ulica|al\.?|aleja|aleje|os\.?|osiedle|pl\.?|plac)\s+/i;
const HOUSE_NUMBER = /\s+\d+[a-z]?(\s*[/-]\s*\d+[a-z]?)?$/i;

function normalizeQuery(value) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ").replace(PREFIX, "");
}

function localityOf(address = {}) {
  return address.city || address.town || address.village || address.hamlet || address.municipality || "";
}

function rzeszowFirst(places) {
  return places.sort((a, b) => (b.locality === "Rzeszów") - (a.locality === "Rzeszów"));
}

// One street comes back as many segments; keep them together so distance is measured along the whole street.
function toPlaces(items) {
  const places = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const lat = Number(item.lat);
    const lon = Number(item.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const address = item.address || {};
    // Companies and shops carry a town in their own name, so "Kraków" must not match one in Rzeszów.
    const name = address.road || (["place", "boundary", "highway"].includes(item.category) ? item.name : "");
    if (!name) continue;
    const locality = localityOf(address);
    const street = address.house_number ? `${name} ${address.house_number}` : name;
    const label = locality && locality !== name ? `${street}, ${locality}` : street;
    const key = label.toLowerCase();
    if (!places.has(key)) places.set(key, { label, locality, exact: Boolean(address.house_number), points: [] });
    const place = places.get(key);
    if (place.points.length < MAX_POINTS) place.points.push([lat, lon]);
  }
  return rzeszowFirst([...places.values()]);
}

// Towns and cities far from Rzeszów: the name alone identifies them, so the first few matches are enough.
function toWorldPlaces(items) {
  const places = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const lat = Number(item.lat);
    const lon = Number(item.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const address = item.address || {};
    const name = item.name || localityOf(address);
    if (!name) continue;
    const label = address.country && address.country !== name ? `${name}, ${address.country}` : name;
    if (!places.has(label.toLowerCase())) places.set(label.toLowerCase(), { label, locality: localityOf(address) || name, exact: false, world: true, points: [[lat, lon]] });
  }
  return [...places.values()].slice(0, WORLD_LIMIT);
}

function createGeocoder({ fetchSource = fetch, minGapMs = MIN_REQUEST_GAP_MS } = {}) {
  const cache = new Map();
  let queue = Promise.resolve();
  let lastRequestAt = 0;

  function search(query, scope) {
    const run = queue.then(async () => {
      const wait = lastRequestAt + minGapMs - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      lastRequestAt = Date.now();
      const url = new URL(SEARCH_URL);
      url.search = new URLSearchParams({ q: query, format: "jsonv2", addressdetails: "1", ...SCOPES[scope] }).toString();
      const response = await fetchSource(url, {
        headers: { "User-Agent": USER_AGENT, "Accept-Language": "pl" },
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error(`Nominatim returned HTTP ${response.status}.`);
      return (scope === "world" ? toWorldPlaces : toPlaces)(await response.json());
    });
    queue = run.catch(() => {});
    return run;
  }

  // The area search keeps Rzeszów on the list and answers fast; the country search finds other cities but is sometimes slow.
  async function inPoland(query, status) {
    const near = await search(query, "area");
    if (query.includes(",")) return near;
    const known = new Set(near.map((place) => place.label.toLowerCase()));
    const far = await search(query, "country").catch((error) => {
      console.warn("Country search failed:", error.message);
      status.partial = true;
      return [];
    });
    return rzeszowFirst([...near, ...far.filter((place) => !known.has(place.label.toLowerCase()))]);
  }

  return async function geocode(value, { world = false } = {}) {
    const query = normalizeQuery(value);
    const key = `${world ? "world:" : ""}${query.toLowerCase()}`;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.result;

    const status = { partial: false };
    let places = await (world ? search(query, "world") : inPoland(query, status));
    let approximate = false;
    const street = query.replace(HOUSE_NUMBER, "");
    if (street !== query && places.some((place) => place.exact)) {
      // A city whose map lacks this house number still has the street, so it stays on the list of options.
      const exact = places.filter((place) => place.exact);
      const covered = new Set(exact.map((place) => place.locality));
      const others = world ? [] : (await search(street, "area")).filter((place) => !covered.has(place.locality));
      places = rzeszowFirst([...exact, ...others]);
    }
    if (!world && !places.length && street !== query) {
      places = await inPoland(street, status);
      approximate = places.length > 0;
    }
    const result = { places, approximate };
    if (status.partial) return result; // a short list must not hide other cities for a whole day
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
    cache.set(key, { at: Date.now(), result });
    return result;
  };
}

function fold(value) {
  return String(value).toLowerCase().replace(/ł/g, "l").normalize("NFD").replace(/\p{M}/gu, "");
}

// Photon also matches shops and bus stops by their own name, so the typed word must be in the street name.
function toSuggestions(features, query) {
  const word = fold(query).split(" ")[0];
  const streets = new Map();
  const houses = new Map();
  const cities = new Map();
  for (const feature of Array.isArray(features) ? features : []) {
    const { type, name, street, housenumber: houseNumber, city, country, countrycode: countryCode } = feature.properties || {};
    if (type === "city" && name && fold(name).includes(word)) {
      const label = country ? `${name}, ${country}` : name;
      if (!cities.has(label.toLowerCase())) cities.set(label.toLowerCase(), label);
      continue;
    }
    if (countryCode && countryCode !== "PL") continue;
    const roadName = type === "street" ? name : type === "house" && houseNumber ? street : "";
    if (!roadName || !fold(roadName).includes(word)) continue;
    const road = type === "house" ? `${roadName} ${houseNumber}` : roadName;
    const label = city ? `${road}, ${city}` : road;
    const group = type === "house" ? houses : streets;
    if (!group.has(label.toLowerCase())) group.set(label.toLowerCase(), label);
  }
  return [...streets.values(), ...houses.values(), ...cities.values()].slice(0, SUGGEST_LIMIT);
}

function createStreetSuggester({ fetchSource = fetch, minGapMs = SUGGEST_GAP_MS } = {}) {
  const cache = new Map();
  let queue = Promise.resolve();
  let lastRequestAt = 0;

  return async function suggest(value) {
    const query = normalizeQuery(value);
    if (query.length < 2) return [];
    const key = query.toLowerCase();
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.suggestions;

    const run = queue.then(async () => {
      const wait = lastRequestAt + minGapMs - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      lastRequestAt = Date.now();
      const url = new URL(SUGGEST_URL);
      url.search = new URLSearchParams({ q: query, limit: "15", lat: "50.0378", lon: "22.0049", location_bias_scale: "0.5" }).toString();
      url.searchParams.append("layer", "street");
      url.searchParams.append("layer", "house");
      url.searchParams.append("layer", "city");
      const response = await fetchSource(url, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(4000),
      });
      if (!response.ok) throw new Error(`Photon returned HTTP ${response.status}.`);
      return toSuggestions((await response.json()).features, query);
    });
    queue = run.catch(() => {});
    const suggestions = await run;
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
    cache.set(key, { at: Date.now(), suggestions });
    return suggestions;
  };
}

module.exports = { createGeocoder, createStreetSuggester, normalizeQuery };
