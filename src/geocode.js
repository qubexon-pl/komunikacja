"use strict";

const SEARCH_URL = "https://nominatim.openstreetmap.org/search";
const SUGGEST_URL = "https://photon.komoot.io/api/";
const USER_AGENT = "komunikacja-rzeszow/1.0 (https://github.com/qubexon-pl/komunikacja)";
const VIEWBOX = "21.45,50.30,22.55,49.75";
const SUGGEST_GAP_MS = 250;
const SUGGEST_LIMIT = 6;
// Photon is sometimes slow to answer from corporate networks; a suggestion a little late beats none.
const SUGGEST_TIMEOUT_MS = 10000;
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

// A town named exactly as typed goes first: "Warszawa" is the capital, not the hamlet "Warszawa" near Hłudno.
function townFirst(places, query) {
  const wanted = fold(query);
  const isTown = (place) => fold(place.label) === wanted;
  return [...places.filter(isTown), ...places.filter((place) => !isTown(place))];
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
    if (near.length && query.includes(",")) return near;
    const known = new Set(near.map((place) => place.label.toLowerCase()));
    const far = await search(query, "country").catch((error) => {
      console.warn("Country search failed:", error.message);
      status.partial = true;
      return [];
    });
    return townFirst(rzeszowFirst([...near, ...far.filter((place) => !known.has(place.label.toLowerCase()))]), query);
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

// Edit distance, for small typos in street names ("Siedmogrodzka" for "Siedmiogrodzka").
function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const keep = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = keep;
    }
  }
  return row[b.length];
}

// The typed word is in the name, or one of its words starts almost like it (one typo in 5+ letters, two in 8+).
function nameMatches(name, word) {
  const folded = fold(name);
  if (folded.includes(word)) return true;
  const allowed = word.length >= 8 ? 2 : word.length >= 5 ? 1 : 0;
  return allowed > 0 && folded.split(/[\s-]+/).some((part) => distance(word, part.slice(0, word.length + 1)) <= allowed || distance(word, part.slice(0, word.length)) <= allowed);
}

const pointOf = (feature) => {
  const [lon, lat] = feature?.geometry?.coordinates || [];
  return Number.isFinite(lat) && Number.isFinite(lon) ? [Math.round(lat * 1e6) / 1e6, Math.round(lon * 1e6) / 1e6] : null;
};

// Photon also matches shops and bus stops by their own name, so the typed word must be in the street name.
function toPlaceSuggestions(features, query) {
  const word = fold(query).split(" ")[0];
  const streets = new Map();
  const houses = new Map();
  const cities = new Map();
  for (const feature of Array.isArray(features) ? features : []) {
    const { type, name, street, housenumber: houseNumber, city, country, countrycode: countryCode } = feature.properties || {};
    const point = pointOf(feature);
    if (type === "city" && name && fold(name).includes(word)) {
      const label = country ? `${name}, ${country}` : name;
      if (!cities.has(label.toLowerCase())) cities.set(label.toLowerCase(), { label, point });
      continue;
    }
    if (countryCode && countryCode !== "PL") continue;
    const roadName = type === "street" ? name : type === "house" && houseNumber ? street : "";
    if (!roadName || !nameMatches(roadName, word)) continue;
    const road = type === "house" ? `${roadName} ${houseNumber}` : roadName;
    const label = city ? `${road}, ${city}` : road;
    const group = type === "house" ? houses : streets;
    if (!group.has(label.toLowerCase())) group.set(label.toLowerCase(), { label, point });
  }
  // A city named exactly as typed is what was meant, so it comes before streets that only contain the word.
  const wanted = fold(query);
  const exactCities = [...cities.values()].filter((place) => fold(place.label.split(",")[0]) === wanted);
  const otherCities = [...cities.values()].filter((place) => !exactCities.includes(place));
  // With a house number typed, that exact house is what was meant.
  const first = /\d/.test(query) ? [...houses.values(), ...streets.values()] : [...streets.values(), ...houses.values()];
  return [...exactCities, ...first, ...otherCities].slice(0, SUGGEST_LIMIT);
}

function toSuggestions(features, query) {
  return toPlaceSuggestions(features, query).map((place) => place.label);
}

const RZESZOW = [50.0378, 22.0049];
const nearPoint = (near) => (Array.isArray(near) && near.every(Number.isFinite) && Math.abs(near[0]) <= 90 && Math.abs(near[1]) <= 180 ? near : null);

function createStreetSuggester({ fetchSource = fetch, minGapMs = SUGGEST_GAP_MS } = {}) {
  const cache = new Map();
  let queue = Promise.resolve();
  let lastRequestAt = 0;

  // Suggestions with their map point; `near` biases them to another city (for example the trip's destination).
  async function places(value, near = null) {
    const query = normalizeQuery(value);
    if (query.length < 2) return [];
    const bias = nearPoint(near) || RZESZOW;
    const key = `${bias.map((x) => x.toFixed(2)).join(",")}|${query.toLowerCase()}`;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.places;

    const run = queue.then(async () => {
      const wait = lastRequestAt + minGapMs - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      lastRequestAt = Date.now();
      const url = new URL(SUGGEST_URL);
      url.search = new URLSearchParams({ q: query, limit: "15", lat: String(bias[0]), lon: String(bias[1]), location_bias_scale: "0.5" }).toString();
      url.searchParams.append("layer", "street");
      url.searchParams.append("layer", "house");
      url.searchParams.append("layer", "city");
      const response = await fetchSource(url, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(SUGGEST_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`Photon returned HTTP ${response.status}.`);
      return toPlaceSuggestions((await response.json()).features, query);
    });
    queue = run.catch(() => {});
    const found = await run;
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
    cache.set(key, { at: Date.now(), places: found });
    return found;
  }

  async function suggest(value, near = null) {
    return (await places(value, near)).map((place) => place.label);
  }
  suggest.places = places;
  return suggest;
}

module.exports = { createGeocoder, createStreetSuggester, normalizeQuery };
