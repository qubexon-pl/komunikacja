"use strict";

// The city exploration plan: attractions from Wikipedia (src/attractions.js), the LLM set up as in Podavo Clean
// (src/llm.js), "Zapytaj" (src/city-ask.js), their endpoints, and the route helpers of assets/app.explore.js.
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { once } = require("node:events");
const { createAttractions, kindOf, shortText } = require("../src/attractions");
const { createLlm } = require("../src/llm");
const { createCityAsk } = require("../src/city-ask");
const { createServer } = require("../src/server");

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const KRAKOW = { lat: 50.0614, lon: 19.9372 };
const GEO = { query: { geosearch: [
  { pageid: 1, ns: 0, title: "Wawel", lat: 50.054, lon: 19.9354, type: "landmark" },
  { pageid: 2, ns: 0, title: "Kraków Główny", lat: 50.0677, lon: 19.9448, type: "railwaystation" },
  { pageid: 3, ns: 0, title: "Sukiennice", lat: 50.0617, lon: 19.9373, type: null },
  { pageid: 4, ns: 0, title: "Uniwersytet Ekonomiczny", lat: 50.069, lon: 19.954, type: null },
  { pageid: 5, ns: 0, title: "Kościół Mariacki", lat: 50.0616, lon: 19.9393, type: null },
  { pageid: 6, ns: 0, title: "Bazylika (ujednoznacznienie)", lat: 50.06, lon: 19.94, type: null },
] } };
const PAGES = { query: { pages: [
  { pageid: 1, title: "Wawel", description: "wzgórze i zamek", pageprops: { wikibase_item: "Q1" }, thumbnail: { source: "https://upload.wikimedia.org/wawel.jpg" }, pageviews: { a: 900, b: 100 } },
  { pageid: 3, title: "Sukiennice", description: "hala targowa", pageprops: { wikibase_item: "Q3" }, pageviews: { a: 300 } },
  { pageid: 4, title: "Uniwersytet Ekonomiczny", pageprops: { wikibase_item: "Q4" }, pageviews: { a: 5000 } },
  { pageid: 5, title: "Kościół Mariacki", description: "bazylika", pageprops: { wikibase_item: "Q5" }, pageviews: { a: 2000 } },
  { pageid: 6, title: "Bazylika (ujednoznacznienie)", pageprops: { wikibase_item: "Q6", disambiguation: "" } },
] } };
const claimOf = (prop, id) => ({ [prop]: [{ rank: "normal", mainsnak: { datavalue: { value: { id } } } }] });
const ENTITIES = { entities: {
  Q1: { claims: claimOf("P31", "Q23413") }, // castle
  Q3: { claims: claimOf("P1435", "Q21438156") }, // listed heritage only
  Q4: { claims: claimOf("P31", "Q3918") }, // university: not a sight
  Q5: { claims: claimOf("P31", "Q163687") }, // basilica
} };
const EXTRACTS = { query: { pages: [
  { pageid: 1, extract: "Wawel (wym. [ˈvavɛl]) – wzgórze w Krakowie nad Wisłą. Na nim zamek królewski i katedra." },
  { pageid: 5, extract: "Kościół Mariacki – gotycka bazylika na Rynku Głównym." },
] } };
function fakeWiki() {
  const asked = [];
  const fetchSource = async (url) => {
    asked.push(url);
    if (url.includes("list=geosearch")) return ok(GEO);
    if (url.includes("pageprops")) return ok(PAGES);
    if (url.includes("wbgetentities")) return ok(ENTITIES);
    if (url.includes("prop=extracts")) return ok(EXTRACTS);
    return { ok: false, status: 500, json: async () => ({}) };
  };
  return { fetchSource, asked };
}

test("attractions are Wikipedia articles near the centre that Wikidata calls a sight, most read first", async () => {
  const { fetchSource, asked } = fakeWiki();
  const out = await createAttractions({ fetchSource }).list({ name: "Kraków", ...KRAKOW, lang: "pl" });
  assert.deepEqual(out.attractions.map((a) => [a.title, a.kind]), [["Kościół Mariacki", "sacral"], ["Wawel", "castle"], ["Sukiennice", "heritage"]]);
  const wawel = out.attractions.find((a) => a.title === "Wawel");
  assert.equal(wawel.id, "pl:1");
  assert.equal(wawel.extract, "Wawel – wzgórze w Krakowie nad Wisłą. Na nim zamek królewski i katedra.");
  assert.equal(wawel.image, "https://upload.wikimedia.org/wawel.jpg");
  assert.equal(wawel.url, "https://pl.wikipedia.org/wiki/Wawel");
  assert.ok(wawel.km > 0.5 && wawel.km < 1.2);
  assert.ok(out.sources.some((s) => s.license === "CC BY-SA 4.0"));
  // The station is dropped by its coordinate type before any details are asked; nothing about the traveller is sent.
  assert.doesNotMatch(asked.find((u) => u.includes("pageprops")), /pageids=[^&]*2%7C/);
  assert.ok(asked.every((u) => /^https:\/\/(pl\.wikipedia|www\.wikidata)\.org\//.test(u)));
});

test("attraction helpers: kinds and short texts", () => {
  assert.equal(kindOf({ claims: claimOf("P31", "Q33506") }), "museum");
  assert.equal(kindOf({ claims: {} }, "landmark"), "sight");
  assert.equal(kindOf({ claims: {} }, null), null);
  const long = "Pierwsze zdanie jest dość długie i opisuje miejsce bardzo dokładnie, z wieloma szczegółami historii miasta. ".repeat(8);
  const t = shortText(long, 300);
  assert.ok(t.length <= 300 && t.endsWith("."));
});

test("the LLM is chosen as in Clean: Foundry, Azure OpenAI, OpenAI, Claude API, or off", () => {
  assert.equal(createLlm({ env: {} }).enabled(), false);
  assert.equal(createLlm({ env: { ANTHROPIC_API_KEY: "k" } }).provider(), "claude");
  assert.equal(createLlm({ env: { TIDY_OPENAI_API_KEY: "k", TIDY_OPENAI_MODEL: "m", ANTHROPIC_API_KEY: "k" } }).provider(), "openai");
  assert.equal(createLlm({ env: { TIDY_AZURE_OPENAI_ENDPOINT: "https://x.openai.azure.com/", TIDY_OPENAI_API_KEY: "k" } }).provider(), "azure-openai");
  const foundry = createLlm({ env: { VOYAGE_FOUNDRY_RESOURCE: "res", TIDY_FOUNDRY_DEPLOYMENT: "claude-dep", TIDY_AZURE_OPENAI_ENDPOINT: "https://x" } });
  assert.equal(foundry.provider(), "foundry");
  assert.equal(foundry.model(), "claude-dep");
});

test("Azure OpenAI is asked on its v1 endpoint with a strict JSON schema", async () => {
  let sent;
  const fetchSource = async (url, init) => { sent = { url, init }; return ok({ choices: [{ message: { content: '{"answer":"Tak","places":[]}' } }] }); };
  const llm = createLlm({ env: { TIDY_AZURE_OPENAI_ENDPOINT: "https://x.openai.azure.com/", TIDY_AZURE_OPENAI_DEPLOYMENT: "gpt", TIDY_AZURE_OPENAI_API_KEY: "secret" }, fetchSource });
  assert.deepEqual(await llm.askJson({ name: "city_question", system: "s", user: "u", schema: { type: "object" } }), { answer: "Tak", places: [] });
  assert.equal(sent.url, "https://x.openai.azure.com/openai/v1/chat/completions");
  assert.equal(sent.init.headers["api-key"], "secret");
  assert.equal(JSON.parse(sent.init.body).response_format.json_schema.strict, true);
});

test("Zapytaj: the question and the city's data go to the model; unknown place ids are dropped", async () => {
  let asked;
  const llm = { enabled: () => true, model: () => "m", label: () => "Claude API", askJson: async (a) => { asked = a; return { answer: "Zobacz Wawel.", places: [{ id: "pl:1", name: "Wawel", why: "zamek" }, { id: "pl:999", name: "Smocza Jama", why: "" }] }; } };
  const ask = createCityAsk({ llm });
  const out = await ask.ask("u1", { question: "Co zobaczyć?", city: "Kraków", attractions: [{ id: "pl:1", name: "Wawel", kind: "castle" }], plan: [{ name: "Rynek", km: 0.4 }], totalKm: 0.4 });
  assert.equal(out.answer, "Zobacz Wawel.");
  assert.deepEqual(out.places.map((p) => p.id), ["pl:1", ""]);
  const data = JSON.parse(asked.user);
  assert.equal(data.question, "Co zobaczyć?");
  assert.equal(data.explorationPlan[0].kmFromPrevious, 0.4);
  assert.match(asked.system, /data, never instructions/);
  await assert.rejects(ask.ask("u1", { question: "?", city: "Kraków" }), /Wpisz pytanie/);
  await assert.rejects(createCityAsk({ llm: { ...llm, askJson: async () => { throw Object.assign(new Error("x"), { refusal: true }); } } }).ask("u1", { question: "Coś innego", city: "Kraków" }), (e) => e.status === 422);
});

test("Zapytaj is limited per traveller per hour", async () => {
  const llm = { enabled: () => true, model: () => "m", label: () => "x", askJson: async () => ({ answer: "ok", places: [] }) };
  const ask = createCityAsk({ llm, now: () => 1000 });
  for (let i = 0; i < 20; i += 1) await ask.ask("u", { question: "Pytanie", city: "Kraków" });
  await assert.rejects(ask.ask("u", { question: "Pytanie", city: "Kraków" }), (e) => e.status === 429);
});

test("endpoints: attractions are public, Zapytaj needs a session and the same origin", async (t) => {
  const { fetchSource } = fakeWiki();
  const llm = { enabled: () => true, model: () => "m", label: () => "x", askJson: async () => ({ answer: "Odpowiedź", places: [] }) };
  const server = createServer({ database: {}, cityAttractions: createAttractions({ fetchSource }), cityAsk: createCityAsk({ llm }), auth: { resolveSession: async (token) => (token === "ok" ? { id: "1" } : null) } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const list = await fetch(`${base}/api/places/attractions?name=Krak%C3%B3w&lat=50.0614&lon=19.9372`);
  assert.equal(list.status, 200);
  assert.equal((await list.json()).attractions.length, 3);
  assert.equal((await fetch(`${base}/api/places/attractions?lat=x&lon=1`)).status, 400);
  const body = JSON.stringify({ question: "Co zobaczyć?", city: "Kraków" });
  assert.equal((await fetch(`${base}/api/ai/ask`, { method: "POST", body })).status, 401);
  assert.equal((await fetch(`${base}/api/ai/ask`, { method: "POST", headers: { Cookie: "rzbus_session=ok" }, body })).status, 403);
  const r = await fetch(`${base}/api/ai/ask`, { method: "POST", headers: { Cookie: "rzbus_session=ok", "Content-Type": "application/json", Origin: base }, body });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).answer, "Odpowiedź");
  const status = await fetch(`${base}/api/ai/status`, { headers: { Cookie: "rzbus_session=ok" } });
  assert.deepEqual(await status.json(), { enabled: false, ask: true });
});

function loadPVX() { const context = { URLSearchParams }; vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "assets/app.explore.js"), "utf8"), context); return context.PVX; }

test("route helpers: distances between consecutive places, the total, and the shortest order", () => {
  const X = loadPVX();
  const home = { lat: 50.0614, lon: 19.9372, label: "Hotel" };
  const items = [
    { id: "a", name: "Wawel", lat: 50.054, lon: 19.9354 },
    { id: "b", name: "Kazimierz", lat: 50.0513, lon: 19.9445 },
    { id: "c", name: "Rynek", lat: 50.0617, lon: 19.9373 },
    { id: "d", name: "Kawiarnia", lat: null, lon: null },
  ];
  const tot = X.totals(items, home);
  assert.equal(tot.legs.length, 4);
  assert.equal(tot.legs[3], null);
  assert.equal(tot.missing, 1);
  assert.ok(Math.abs(tot.km - tot.legs.slice(0, 3).reduce((s, x) => s + x, 0)) < 1e-9);
  const best = X.shortest(items, home);
  assert.deepEqual([...best.map((x) => x.id)], ["c", "a", "b", "d"]);
  assert.ok(X.totals(best, home).km < tot.km);
  const url = new URL(X.mapsUrl(items, home));
  assert.equal(url.searchParams.get("travelmode"), "walking");
  assert.equal(url.searchParams.get("waypoints").split("|").length, 2);
  assert.equal(X.fmtKm(0.43), "430 m");
  assert.equal(X.fmtKm(2.345), "2,3 km");
});

test("attraction list, details window and plan HTML: escaped names, add buttons, distances", () => {
  const X = loadPVX();
  const plan = X.planHtml({ items: [{ id: "a", name: "<b>x</b>", lat: 50, lon: 20 }, { id: "b", name: "B", lat: 50.01, lon: 20 }], start: null });
  assert.doesNotMatch(plan, /<b>x<\/b>/);
  assert.match(plan, /1,1 km/);
  assert.match(plan, /data-xp-move="b" data-dir="-1"/);
  assert.match(plan, /data-xa-plan="a"/);
  assert.match(plan, /data-xp-add-open/);
  const data = { attractions: [{ id: "pl:1", title: "Wawel", kind: "castle", km: 0.8, views: 10, lat: 50.054, lon: 19.935, url: "https://pl.wikipedia.org/wiki/Wawel", description: "zamek", extract: "Zamek." }, { id: "pl:2", title: "Rynek", kind: "square", km: 0.1, views: 5, url: "u", extract: "Plac. Duży." }] };
  const list = X.attrListHtml({ data, inPlan: new Set(["pl:1"]) });
  assert.match(list, /data-xa-open="pl:1"/);
  assert.match(list, /data-xp-unadd="pl:1"/);
  assert.match(list, /data-xp-add="pl:2"[^>]*>.*Dodaj do planu/s);
  assert.match(list, /CC BY-SA 4\.0/);
  const detail = X.detailHtml(data.attractions[0], { inPlan: false, fromKm: 0.8, fromLabel: "noclegu" });
  assert.match(detail, /Zamki i pałace · zamek · zwiedzanie ok\. 1 godz\. 15 min/);
  assert.match(detail, /800 m od noclegu/);
  assert.match(detail, /data-xa-minimap data-lat="50\.05400"/);
  assert.match(detail, /data-xa-m="add"/);
  assert.match(detail, /data-xa-m="route"/);
  assert.match(X.tabsHtml("plan", { attr: 2, plan: 1, ask: true }), /data-xa-tab="ask"/);
  assert.match(X.headHtml("Rzym", { found: true, facts: { country: "Włochy" } }), /<h4>Rzym<\/h4><small>Włochy<\/small>/);
  assert.match(X.askHtml({ city: "Kraków" }), /data-xp-ask-form/);
});

test("the city article's sights sections are read link by link and come first", async () => {
  const asked = [];
  const SECTIONS = { parse: { title: "Rzym", sections: [
    { index: "1", number: "1", line: "Historia" }, { index: "2", number: "2", line: "Zabytki" }, { index: "3", number: "2.1", line: "Starożytność" },
    { index: "4", number: "3", line: "Transport" }, { index: "5", number: "4", line: "Przypisy" },
  ] } };
  const LINKS = { 2: ["Koloseum", "Starożytny Rzym"], 3: ["Panteon (Rzym)", "Fiumicino"] };
  const fetchSource = async (url) => {
    asked.push(url);
    const u = new URL(url), q = u.searchParams;
    if (q.get("action") === "parse" && q.get("prop") === "sections") return ok(SECTIONS);
    if (q.get("action") === "parse" && q.get("prop") === "links") return ok({ parse: { links: (LINKS[q.get("section")] || []).map((title) => ({ ns: 0, title, exists: true })) } });
    if (q.get("titles")) return ok({ query: { pages: [
      { pageid: 11, title: "Koloseum", pageprops: { wikibase_item: "Q10285" }, coordinates: [{ lat: 41.8902, lon: 12.4922 }], pageviews: { a: 100 } },
      { pageid: 12, title: "Starożytny Rzym", pageprops: { wikibase_item: "Q1747689" } },
      { pageid: 13, title: "Panteon (Rzym)", pageprops: { wikibase_item: "Q99309" }, coordinates: [{ lat: 41.8986, lon: 12.4768 }], pageviews: { a: 500 } },
      { pageid: 14, title: "Fiumicino", pageprops: { wikibase_item: "Q242902" }, coordinates: [{ lat: 41.77, lon: 12.23 }], pageviews: { a: 900 } },
    ] } });
    if (q.get("list") === "geosearch") return ok({ query: { geosearch: [{ pageid: 11, ns: 0, title: "Koloseum", lat: 41.8902, lon: 12.4922 }, { pageid: 20, ns: 0, title: "Fontanna di Trevi", lat: 41.9009, lon: 12.4833, type: "landmark" }] } });
    if (q.get("pageids")?.includes("20") && q.get("prop")?.includes("pageprops")) return ok({ query: { pages: [{ pageid: 20, title: "Fontanna di Trevi", pageprops: { wikibase_item: "Q186579" }, pageviews: { a: 5000 } }] } });
    if (u.hostname === "www.wikidata.org") return ok({ entities: {
      Q10285: { claims: claimOf("P31", "Q54831") }, Q99309: { claims: claimOf("P31", "Q12345") }, Q242902: { claims: claimOf("P31", "Q747074") }, Q186579: { claims: claimOf("P31", "Q483453") },
    } });
    if (q.get("prop") === "extracts") return ok({ query: { pages: [] } });
    return { ok: false, status: 500, json: async () => ({}) };
  };
  const out = await createAttractions({ fetchSource }).list({ name: "Rzym Fiumicino", title: "Rzym", lat: 41.8933, lon: 12.4829 });
  // Panteon and Koloseum from the "Zabytki" section (by views), then Trevi from around the centre; the town of
  // Fiumicino and the article without coordinates are dropped; "Transport" and "Przypisy" are never read.
  assert.deepEqual(out.attractions.map((a) => [a.title, a.listed]), [["Panteon (Rzym)", true], ["Koloseum", true], ["Fontanna di Trevi", false]]);
  assert.deepEqual(out.sections, ["Zabytki", "Starożytność"]);
  assert.ok(!asked.some((u) => /section=(4|5)&/.test(u)));
});

test("every city's sights section is found by its heading, whatever it is called", () => {
  const { sightSections } = require("../src/attractions.js");
  const names = (list) => sightSections(list.map((line, i) => ({ index: String(i + 1), number: String(i + 1), line }))).map((s) => s.line);
  assert.deepEqual(names(["Historia", "Znane miejsca w Rzymie", "Transport", "Przypisy"]), ["Znane miejsca w Rzymie"]);
  assert.deepEqual(names(["Geografia", "Zabytki", "Sport"]), ["Zabytki"]);
  assert.deepEqual(names(["Demografia", "Atrakcje turystyczne", "Bibliografia"]), ["Atrakcje turystyczne"]);
  assert.deepEqual(names(["History", "Landmarks", "Transport", "References"]), ["Landmarks"]);
  assert.deepEqual(names(["Gospodarka", "Architektura i urbanistyka"]), ["Architektura i urbanistyka"]);
});

test("plan: each stop starts from where the traveller says, with visit times and a day schedule", () => {
  const X = loadPVX();
  const ctx = { home: { lat: 41.9, lon: 12.5, label: "Hotel" }, centre: { lat: 41.8933, lon: 12.4829, label: "centrum" } };
  const items = [
    { id: "a", name: "Koloseum", lat: 41.8902, lon: 12.4922, kind: "heritage" },
    { id: "b", name: "Panteon", lat: 41.8986, lon: 12.4768, kind: "sacral", from: "centre" },
    { id: "c", name: "Trevi", lat: 41.9009, lon: 12.4833, kind: "monument", min: 20, from: "custom", fromName: "Dworzec", fromLat: 41.901, fromLon: 12.501 },
    { id: "d", name: "Forum", lat: 41.8925, lon: 12.4853 },
  ];
  assert.equal(X.originOf(items, 0, ctx).kind, "home"); // first stop: from the hotel by default
  assert.equal(X.originOf(items, 1, ctx).kind, "centre");
  assert.equal(X.originOf(items, 2, ctx).label, "Dworzec");
  assert.equal(X.originOf(items, 3, ctx).label, "Trevi"); // later stops: from the previous one
  assert.equal(X.originOf(items, 0, { home: null, centre: ctx.centre }).kind, "centre");
  const T = X.totals(items, ctx);
  assert.ok(Math.abs(T.legs[1] - X.km(ctx.centre, items[1])) < 1e-9);
  assert.equal(T.visitMin, 30 + 30 + 20 + 30);
  assert.equal(T.totalMin, T.visitMin + T.walkMin);
  const S = X.schedule(items, ctx, "09:00");
  assert.equal(S[0].leave, X.schedule([items[0]], ctx, "09:00")[0].leave);
  assert.match(S[3].leave, /^\d\d:\d\d$/);
  const html = X.planHtml({ items, ctx, startTime: "10:30" });
  assert.match(html, /data-xp-from="b"[^>]*>.*<option value="centre" selected>/s);
  assert.match(html, /<option value="custom" selected>Dworzec/);
  assert.doesNotMatch(html.split('data-xp-from="b"')[0], /value="prev"/); // the first stop has no previous one
  assert.match(html, /data-xp-time value="10:30"/);
  assert.match(html, /Cały plan/);
});

test("suggested route fits the time, mixes kinds and is in the shortest order", () => {
  const X = loadPVX();
  const ctx = { home: null, centre: { lat: 41.8933, lon: 12.4829 } };
  const at = (id, kind, views, dLat, dLon) => ({ id, title: id, kind, views, lat: 41.8933 + dLat, lon: 12.4829 + dLon });
  const pool = [at("m1", "museum", 9000, 0.004, 0), at("m2", "museum", 8000, 0.005, 0.001), at("m3", "museum", 7000, 0.006, 0.002),
    at("c1", "sacral", 3000, -0.003, 0.002), at("p1", "park", 2000, 0, -0.006), at("s1", "square", 1500, 0.002, -0.002), at("far", "castle", 99999, 0.3, 0.3)];
  const two = X.suggest(pool, { ctx, budget: 120 });
  assert.ok(X.totals(two, ctx).totalMin <= 120);
  assert.ok(!two.some((a) => a.id === "far")); // too far to walk in the time
  const four = X.suggest(pool, { ctx, budget: 240 });
  assert.ok(X.totals(four, ctx).totalMin <= 240);
  assert.ok(new Set(four.map((a) => a.kind)).size >= 3);
  assert.ok(four.filter((a) => a.kind === "museum").length < 3); // not three museums when other kinds fit
  assert.ok(X.suggest(pool, { ctx, budget: 240, have: ["m1"] }).every((a) => a.id !== "m1"));
  assert.match(X.suggestHtml({ budget: 240, list: four }, ctx, {}), /data-xp-sugg-use="replace"/);
});

test("the attraction list shows where each place is", () => {
  const X = loadPVX();
  const data = { centre: { lat: 41.8933, lon: 12.4829 }, attractions: [{ id: "pl:1", title: "Koloseum", kind: "heritage", area: "Monti", lat: 41.8902, lon: 12.4922 }] };
  assert.match(X.attrListHtml({ data }), /xa-where[^>]*>.*Monti · 840 m od centrum/s);
});

test("the trip page loads the exploration helpers before app.js", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  assert.ok(html.indexOf("/assets/app.explore.js") > 0 && html.indexOf("/assets/app.explore.js") < html.indexOf("/assets/app.js"));
  assert.match(fs.readFileSync(path.join(__dirname, "..", "assets/app.sw.js"), "utf8"), /\/assets\/app\.explore\.js/);
  assert.match(fs.readFileSync(path.join(__dirname, "..", "assets/app.sw.js"), "utf8"), /\/assets\/app\.explore\.css/);
  assert.match(html, /\/assets\/app\.explore\.css/);
});
