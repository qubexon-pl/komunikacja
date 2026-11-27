"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { once } = require("node:events");
const { createNearby, toPlaces, kindOf, overpassQuery } = require("../src/nearby");
const { createServer } = require("../src/server");

const OSM = { elements: [
  { type: "node", id: 1, lat: 50.0375, lon: 22.0047, tags: { name: "Muzeum Okręgowe", "name:en": "District Museum", tourism: "museum", opening_hours: "Tu-Su 10:00-17:00", website: "https://muzeum.rzeszow.pl", wikipedia: "pl:Muzeum Okręgowe w Rzeszowie", wheelchair: "limited" } },
  { type: "way", id: 2, center: { lat: 50.0371, lon: 22.0051 }, tags: { name: "Muzeum Okręgowe", tourism: "museum" } }, // the same museum as a building
  { type: "way", id: 3, center: { lat: 50.0336, lon: 22.0001 }, tags: { name: "Zamek Lubomirskich", historic: "castle" } },
  { type: "node", id: 4, lat: 50.0380, lon: 22.0020, tags: { name: "Bistro", amenity: "restaurant", cuisine: "polish;regional" } },
  { type: "node", id: 5, lat: 50.0380, lon: 22.0020, tags: { amenity: "cafe" } }, // no name
  { type: "node", id: 6, lat: 50.0380, lon: 22.0020, tags: { name: "Krzyż", historic: "wayside_cross" } }, // not a sight
  { type: "node", id: 7, lat: 50.0381, lon: 22.0021, tags: { name: "Strona", amenity: "cafe", website: "javascript:alert(1)" } },
] };
const CENTRE = { lat: 50.037, lon: 22.004 };

test("OSM places: named, classified, deduplicated, nearest first, only the tags OSM has", () => {
  const list = toPlaces(OSM, CENTRE, "pl");
  assert.deepEqual(list.map((p) => [p.name, p.cat]), [["Muzeum Okręgowe", "museum"], ["Bistro", "food"], ["Strona", "cafe"], ["Zamek Lubomirskich", "sight"]]);
  const m = list[0];
  assert.equal(m.id, "n1");
  assert.equal(m.openingHours, "Tu-Su 10:00-17:00");
  assert.equal(m.wikipedia, "pl:Muzeum Okręgowe w Rzeszowie");
  assert.equal(m.wheelchair, "limited");
  assert.equal(list[1].cuisine, "polish, regional");
  assert.equal(list[2].website, undefined); // not an http(s) address
  assert.equal(list[3].openingHours, undefined);
  assert.equal(toPlaces(OSM, CENTRE, "en")[0].name, "District Museum");
  assert.equal(kindOf({ historic: "wayside_shrine" }), null);
});

test("the Overpass query asks only for named places of the chosen kinds around the rounded point", () => {
  const q = overpassQuery({ lat: 50.037, lon: 22.004, radius: 1500, cats: ["museum", "view"] });
  assert.match(q, /tourism"~"\^\(museum\|gallery\)\$"\]\["name"\]\(around:1500,50\.0370,22\.0040\)/);
  assert.match(q, /viewpoint/);
  assert.doesNotMatch(q, /restaurant/);
});

test("nearby() validates, clamps the radius and says where the data comes from", async () => {
  let sent = "";
  const fetchSource = async (url, o) => { sent = decodeURIComponent(String(o.body)); return { ok: true, status: 200, json: async () => OSM }; };
  const n = createNearby({ fetchSource });
  const r = await n.nearby({ lat: 50.03712345, lon: 22.00412345, radius: 99999, cats: ["museum", "bogus"] });
  assert.equal(r.radius, 5000);
  assert.deepEqual(r.cats, ["museum"]);
  assert.deepEqual(r.centre, CENTRE); // rounded to about 100 m before it leaves
  assert.match(sent, /around:5000,50\.0370,22\.0040/);
  assert.equal(r.license, "ODbL");
  await assert.rejects(n.nearby({ lat: NaN, lon: 1 }), /współrzędne/);
  await assert.rejects(n.nearby({ lat: 1, lon: 1, cats: ["bogus"] }), /rodzaj/);
  const down = createNearby({ fetchSource: async () => ({ ok: false, status: 504 }) });
  await assert.rejects(down.nearby({ lat: 1, lon: 1 }), /HTTP 504/);
});

test("GET /api/places/nearby", async () => {
  const server = createServer({ database: {}, auth: { resolveSession: async () => null }, nearbyPlaces: createNearby({ fetchSource: async () => ({ ok: true, status: 200, json: async () => OSM }) }) });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}/api/places/nearby`;
  try {
    assert.equal((await fetch(`${base}?lat=50`)).status, 400);
    const r = await fetch(`${base}?lat=50.037&lon=22.004&cats=museum,sight`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(body.places.length >= 2);
    assert.equal(body.attribution, "© OpenStreetMap contributors");
  } finally {
    server.close();
  }
});
