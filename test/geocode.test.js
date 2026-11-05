"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createGeocoder, createStreetSuggester, normalizeQuery } = require("../src/geocode");

function response(items) {
  return { ok: true, json: async () => items };
}

const segment = (road, city, lat, lon, houseNumber) => ({
  lat: String(lat),
  lon: String(lon),
  address: { road, city, ...(houseNumber ? { house_number: houseNumber } : {}) },
});

test("street prefixes are removed before searching", () => {
  assert.equal(normalizeQuery("  ul.  Hetmańska 40 "), "Hetmańska 40");
  assert.equal(normalizeQuery("Aleja Rejtana"), "Rejtana");
  assert.equal(normalizeQuery("os. Baranówka"), "Baranówka");
  assert.equal(normalizeQuery("Ulanowska"), "Ulanowska");
  assert.equal(normalizeQuery(undefined), "");
});

test("segments of one street become a single place, with Rzeszów listed first", async () => {
  const geocode = createGeocoder({
    minGapMs: 0,
    fetchSource: async () => response([
      segment("Kwiatowa", "Łańcut", 50.06, 22.23),
      segment("Kwiatowa", "Rzeszów", 49.96, 21.97),
      segment("Kwiatowa", "Rzeszów", 49.97, 21.98),
    ]),
  });
  const { places, approximate } = await geocode("Kwiatowa");
  assert.deepEqual(places.map((place) => place.label), ["Kwiatowa, Rzeszów", "Kwiatowa, Łańcut"]);
  assert.equal(places[0].points.length, 2);
  assert.equal(approximate, false);
});

test("a street that does not exist returns no places", async () => {
  const geocode = createGeocoder({ minGapMs: 0, fetchSource: async () => response([]) });
  assert.deepEqual(await geocode("Xyzzyqq"), { places: [], approximate: false });
});

test("an unknown house number falls back to the street and says so", async () => {
  const queries = [];
  const geocode = createGeocoder({
    minGapMs: 0,
    fetchSource: async (url) => {
      const query = url.searchParams.get("q");
      queries.push(query);
      return response(query === "Hetmańska" ? [segment("Hetmańska", "Rzeszów", 50.02, 22.0)] : []);
    },
  });
  const result = await geocode("ul. Hetmańska 9999");
  assert.deepEqual(queries, ["Hetmańska 9999", "Hetmańska"]);
  assert.equal(result.approximate, true);
  assert.equal(result.places[0].label, "Hetmańska, Rzeszów");
});

test("an exact house number wins over a street with a similar name", async () => {
  const geocode = createGeocoder({
    minGapMs: 0,
    fetchSource: async () => response([
      segment("Aleja Tadeusza Rejtana", "Rzeszów", 50.02, 22.01, "20"),
      segment("Rejtana", "Rzeszów", 50.03, 22.02),
    ]),
  });
  const { places } = await geocode("ul. Rejtana 20");
  assert.deepEqual(places.map((place) => place.label), ["Aleja Tadeusza Rejtana 20, Rzeszów"]);
});

test("repeat searches are cached and requests identify the app without user data", async () => {
  const calls = [];
  const geocode = createGeocoder({
    minGapMs: 0,
    fetchSource: async (url, options) => {
      calls.push({ url, options });
      return response([segment("Lwowska", "Rzeszów", 50.03, 22.02)]);
    },
  });
  await geocode("Lwowska");
  await geocode("lwowska");
  assert.equal(calls.length, 1);
  assert.match(calls[0].options.headers["User-Agent"], /^komunikacja-rzeszow\//);
  assert.equal(calls[0].url.searchParams.get("bounded"), "1");
});

test("requests stay at least the minimum gap apart", async () => {
  const times = [];
  const geocode = createGeocoder({
    minGapMs: 60,
    fetchSource: async () => {
      times.push(Date.now());
      return response([]);
    },
  });
  await Promise.all([geocode("Jeden"), geocode("Dwa")]);
  assert.ok(times[1] - times[0] >= 55);
});

test("suggestions keep streets and house numbers, without duplicates or shops", async () => {
  const feature = (properties) => ({ properties });
  const queries = [];
  const suggest = createStreetSuggester({
    minGapMs: 0,
    fetchSource: async (url) => {
      queries.push(url.searchParams.get("q"));
      return {
        ok: true,
        json: async () => ({ features: [
          feature({ type: "street", name: "Lwowska", city: "Rzeszów" }),
          feature({ type: "street", name: "Lwowska", city: "Rzeszów", district: "Wilkowyja" }),
          feature({ type: "house", name: "Rejtana uniwersytet 05", street: "Aleja Tadeusza Rejtana", city: "Rzeszów" }),
          feature({ type: "house", name: "Lwowianka", street: "Generała Langiewicza", housenumber: "29b", city: "Rzeszów" }),
          feature({ type: "house", name: "Apteka", street: "Lwowska", housenumber: "26", city: "Rzeszów" }),
          feature({ type: "street", name: "Lwowska", city: "Tyczyn" }),
        ] }),
      };
    },
  });
  assert.deepEqual(await suggest("ul. Lwo"), ["Lwowska, Rzeszów", "Lwowska, Tyczyn", "Lwowska 26, Rzeszów"]);
  await suggest("lwo");
  assert.deepEqual(queries, ["Lwo"]);
  assert.deepEqual(await suggest("L"), []);
});

test("suggestions match the street name whatever the Polish letters", async () => {
  const suggest = createStreetSuggester({
    minGapMs: 0,
    fetchSource: async () => ({ ok: true, json: async () => ({ features: [{ properties: { type: "street", name: "Łańcucka", city: "Rzeszów" } }] }) }),
  });
  assert.deepEqual(await suggest("lancuc"), ["Łańcucka, Rzeszów"]);
});

test("a suggestion failure is reported and not cached", async () => {
  let calls = 0;
  const suggest = createStreetSuggester({
    minGapMs: 0,
    fetchSource: async () => {
      calls += 1;
      return calls === 1 ? { ok: false, status: 500 } : { ok: true, json: async () => ({ features: [] }) };
    },
  });
  await assert.rejects(suggest("Lwo"), /500/);
  assert.deepEqual(await suggest("Lwo"), []);
});

test("a provider failure is reported and not cached", async () => {
  let calls = 0;
  const geocode = createGeocoder({
    minGapMs: 0,
    fetchSource: async () => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 503 };
      return response([segment("Lwowska", "Rzeszów", 50.03, 22.02)]);
    },
  });
  await assert.rejects(geocode("Lwowska"), /503/);
  assert.equal((await geocode("Lwowska")).places.length, 1);
});
