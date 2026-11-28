"use strict";

// Phase 7a (docs/PODAVO_REFACTOR.md): places worth visiting around a point, from OpenStreetMap (Overpass API).
// Only named places with a known kind are returned; opening hours, website and the Wikipedia link are passed on only
// when OSM has them. Only the point (rounded to about 100 m) and the radius go out. Answers are kept in the database
// for 14 days (src/stored.js), so the catalogue of places grows as trips are planned. Data © OpenStreetMap
// contributors, ODbL: every answer says so.

// Public Overpass servers, tried in order: the main one is often busy, so a slow or refused answer moves to the next.
const OVERPASS = (process.env.OVERPASS_URL || "https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter,https://overpass.private.coffee/api/interpreter")
  .split(",").map((u) => u.trim()).filter(Boolean);
const SLOW = "Mapa miejsc (OpenStreetMap) odpowiada teraz zbyt wolno. Spróbuj ponownie za chwilę.";
const UA = "podavo-voyage/1.0 (local exploring; https://podavo.voyage)";
const MAX = 120;

// OSM tag → category, in the order a place is classified (the first match wins).
const KINDS = [
  ["museum", (t) => t.tourism === "museum" || t.tourism === "gallery"],
  ["sight", (t) => t.tourism === "attraction" || (t.historic && t.historic !== "yes" && !["memorial", "wayside_cross", "wayside_shrine", "boundary_stone", "milestone"].includes(t.historic)) || t.building === "cathedral"],
  ["view", (t) => t.tourism === "viewpoint"],
  ["park", (t) => t.leisure === "park" || t.leisure === "garden" || t.tourism === "zoo" || t.tourism === "theme_park"],
  ["food", (t) => t.amenity === "restaurant"],
  ["cafe", (t) => t.amenity === "cafe" || t.amenity === "ice_cream"],
  ["nightlife", (t) => t.amenity === "bar" || t.amenity === "pub"],
];
const CATEGORIES = KINDS.map(([k]) => k);
const QUERY = {
  museum: ['nwr["tourism"~"^(museum|gallery)$"]'],
  sight: ['nwr["tourism"="attraction"]', 'nwr["historic"~"^(castle|monument|ruins|church|city_gate|palace|fort|archaeological_site|building|manor|tower)$"]'],
  view: ['nwr["tourism"="viewpoint"]'],
  park: ['nwr["leisure"~"^(park|garden)$"]', 'nwr["tourism"~"^(zoo|theme_park)$"]'],
  food: ['nwr["amenity"="restaurant"]'],
  cafe: ['nwr["amenity"~"^(cafe|ice_cream)$"]'],
  nightlife: ['nwr["amenity"~"^(bar|pub)$"]'],
};

const bad = (message) => Object.assign(new Error(message), { status: 400 });
function km(a, b) {
  const r = (d) => (d * Math.PI) / 180, dLat = r(b.lat - a.lat), dLon = r(b.lon - a.lon);
  return 12742 * Math.asin(Math.sqrt(Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLon / 2) ** 2));
}
const kindOf = (tags) => KINDS.find(([, test]) => test(tags))?.[0] || null;

function overpassQuery({ lat, lon, radius, cats }) {
  const around = `(around:${radius},${lat.toFixed(4)},${lon.toFixed(4)})`;
  const parts = cats.flatMap((c) => QUERY[c]).map((q) => `${q}["name"]${around};`).join("");
  return `[out:json][timeout:12];(${parts});out center tags ${MAX * 3};`;
}

function toPlaces(body, point, lang) {
  const seen = new Set(), out = [];
  for (const e of body?.elements || []) {
    const t = e.tags || {}, lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon, cat = kindOf(t);
    const name = (lang && t[`name:${lang}`]) || t.name;
    if (!name || !cat || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const key = `${cat}|${name.toLowerCase()}`;
    if (seen.has(key)) continue; // the same museum as a node and a building
    seen.add(key);
    const place = { id: `${e.type[0]}${e.id}`, name: String(name).slice(0, 120), cat, lat: +lat.toFixed(6), lon: +lon.toFixed(6), km: +km(point, { lat, lon }).toFixed(2) };
    if (t.opening_hours) place.openingHours = String(t.opening_hours).slice(0, 200);
    const site = t.website || t["contact:website"];
    if (/^https?:\/\//.test(site || "")) place.website = String(site).slice(0, 300);
    if (/^[a-z]{2,3}:.+/.test(t.wikipedia || "")) place.wikipedia = String(t.wikipedia).slice(0, 200);
    if (t.wheelchair === "yes" || t.wheelchair === "no" || t.wheelchair === "limited") place.wheelchair = t.wheelchair;
    if (t.cuisine && (cat === "food" || cat === "cafe")) place.cuisine = String(t.cuisine).split(";").slice(0, 3).join(", ").slice(0, 80);
    out.push(place);
  }
  return out.sort((a, b) => a.km - b.km).slice(0, MAX);
}

function createNearby({ fetchSource = fetch, url = OVERPASS } = {}) {
  const urls = Array.isArray(url) ? url : [url];
  async function nearby({ lat, lon, radius = 1500, cats = CATEGORIES, lang = "pl" }) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw bad("Podaj współrzędne miejsca.");
    const r = Math.min(5000, Math.max(300, Math.round(Number(radius) || 1500)));
    const list = [...new Set((cats || []).filter((c) => CATEGORIES.includes(c)))];
    if (!list.length) throw bad("Wybierz rodzaj miejsc.");
    const point = { lat: Math.round(lat * 1000) / 1000, lon: Math.round(lon * 1000) / 1000 };
    const body = new URLSearchParams({ data: overpassQuery({ ...point, radius: r, cats: list }) }).toString();
    let data = null;
    for (const server of urls) {
      try {
        const response = await fetchSource(server, {
          method: "POST", headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) continue; // busy (429/504) or down: the next server
        data = await response.json();
        break;
      } catch {
        // timed out or unreachable: the next server
      }
    }
    if (!data) throw Object.assign(new Error(SLOW), { status: 504 });
    const places = toPlaces(data, point, lang === "en" ? "en" : "pl");
    return { centre: point, radius: r, cats: list, places, source: "OpenStreetMap", license: "ODbL", attribution: "© OpenStreetMap contributors", fetchedAt: new Date().toISOString() };
  }
  return { nearby };
}

module.exports = { createNearby, toPlaces, kindOf, overpassQuery, CATEGORIES };
