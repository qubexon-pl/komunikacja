"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { once } = require("node:events");
const { createKnowledge, pickArticle, claim } = require("../src/knowledge");
const { createServer } = require("../src/server");

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const ROME = { title: "Rzym", wikibase_item: "Q220", description: "stolica Włoch", extract: "Rzym – stolica Włoch.", thumbnail: { source: "https://upload.wikimedia.org/rzym.jpg" }, content_urls: { desktop: { page: "https://pl.wikipedia.org/wiki/Rzym" } } };
const Q220 = { entities: { Q220: { claims: {
  P1082: [
    { rank: "normal", mainsnak: { datavalue: { value: { amount: "+2748109" } } }, qualifiers: { P585: [{ datavalue: { value: { time: "+2022-01-01T00:00:00Z" } } }] } },
    { rank: "normal", mainsnak: { datavalue: { value: { amount: "+2873000" } } }, qualifiers: { P585: [{ datavalue: { value: { time: "+2016-01-01T00:00:00Z" } } }] } },
  ],
  P2044: [{ rank: "normal", mainsnak: { datavalue: { value: { amount: "+21", unit: "http://www.wikidata.org/entity/Q11573" } } } }],
  P17: [{ rank: "normal", mainsnak: { datavalue: { value: { id: "Q38" } } } }],
  P421: [{ rank: "normal", mainsnak: { datavalue: { value: { id: "Q6655" } } } }],
  P856: [{ rank: "normal", mainsnak: { datavalue: { value: "https://www.comune.roma.it" } } }],
} } } };
const LABELS = { entities: { Q38: { labels: { pl: { value: "Włochy" } } }, Q6655: { labels: { pl: { value: "UTC+01:00" } } } } };

function fakeFetch(over = {}) {
  const asked = [];
  const fetchSource = async (url) => {
    asked.push(url);
    if (url.includes("list=geosearch")) return ok(over.geo || { query: { geosearch: [{ title: "Watykan" }, { title: "Rzym" }, { title: "Rzym (stacja kolejowa)" }] } });
    if (url.includes("prop=coordinates")) return ok(over.named || { query: { pages: {} } });
    if (url.includes("/page/summary/")) return ok(over.summary || ROME);
    if (url.includes("Special:EntityData")) return ok(Q220);
    if (url.includes("wbgetentities")) return ok(LABELS);
    return { ok: false, status: 500, json: async () => ({}) };
  };
  return { fetchSource, asked };
}

test("the article is the page named like the place, not the nearest one", () => {
  const pages = [{ title: "Watykan" }, { title: "Rzym Termini" }, { title: "Rzym" }];
  assert.equal(pickArticle(pages, "Rzym").title, "Rzym");
  assert.equal(pickArticle([{ title: "Málaga" }], "Malaga").title, "Málaga");
  assert.equal(pickArticle([{ title: "Łódź" }], "Lodz").title, "Łódź");
  assert.equal(pickArticle([{ title: "Watykan" }], "Rzym"), null);
});

test("the newest Wikidata value wins (population by year)", () => {
  assert.deepEqual(claim(Q220.entities.Q220, "P1082"), { value: { amount: "+2748109" }, year: "2022" });
  assert.equal(claim(Q220.entities.Q220, "P9999"), null);
});

test("about a place: Wikipedia summary, Wikidata facts, sources and licences", async () => {
  const { fetchSource, asked } = fakeFetch();
  const r = await createKnowledge({ fetchSource }).about({ name: "Rzym", lat: 41.8933, lon: 12.4829, lang: "pl" });
  assert.equal(r.found, true);
  assert.equal(r.title, "Rzym");
  assert.match(r.extract, /stolica/);
  assert.deepEqual(r.facts, { population: { value: 2748109, year: "2022" }, elevationM: 21, website: "https://www.comune.roma.it", country: "Włochy", timeZone: "UTC+01:00" });
  assert.deepEqual(r.sources.map((s) => [s.name, s.license]), [["Wikipedia", "CC BY-SA 4.0"], ["Wikidata", "CC0"]]);
  // only the place goes out: its name and coordinates
  assert.ok(asked.every((u) => /wikipedia\.org|wikidata\.org/.test(u)));
});

test("a point at the airport finds the city by name when it is close enough; nothing is invented otherwise", async () => {
  const far = fakeFetch({ geo: { query: { geosearch: [{ title: "Port lotniczy Rzym-Fiumicino" }] } }, named: { query: { pages: { 1: { title: "Rzym", coordinates: [{ lat: 41.89, lon: 12.48 }] } } } } });
  const r = await createKnowledge({ fetchSource: far.fetchSource }).about({ name: "Rzym", lat: 41.80, lon: 12.25, lang: "pl" });
  assert.equal(r.title, "Rzym");
  const tooFar = fakeFetch({ geo: { query: { geosearch: [] } }, named: { query: { pages: { 1: { title: "Rzym", coordinates: [{ lat: 41.89, lon: 12.48 }] } } } } });
  const none = await createKnowledge({ fetchSource: tooFar.fetchSource }).about({ name: "Rzym", lat: 50.0, lon: 22.0, lang: "pl" });
  assert.deepEqual(none, { found: false, name: "Rzym", lang: "pl", sources: [] });
  const dis = fakeFetch({ geo: { query: { geosearch: [] } }, named: { query: { pages: { 1: { title: "Rzym", pageprops: { disambiguation: "" }, coordinates: [{ lat: 41.89, lon: 12.48 }] } } } } });
  assert.equal((await createKnowledge({ fetchSource: dis.fetchSource }).about({ name: "Rzym", lat: 41.8, lon: 12.25 })).found, false);
  await assert.rejects(createKnowledge({ fetchSource: far.fetchSource }).about({ name: "", lat: 1, lon: 1 }), /nazwę/);
});

test("GET /api/places/about answers and validates", async () => {
  const { fetchSource } = fakeFetch();
  const server = createServer({ database: {}, auth: { resolveSession: async () => null }, knowledge: createKnowledge({ fetchSource }) });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}/api/places/about`;
  try {
    assert.equal((await fetch(`${base}?name=Rzym`)).status, 400);
    const r = await fetch(`${base}?name=Rzym&lat=41.89&lon=12.48&lang=pl`);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).facts.country, "Włochy");
  } finally {
    server.close();
  }
});
