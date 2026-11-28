"use strict";

// Attractions of a city from Wikipedia: the articles with coordinates around the city centre (MediaWiki geosearch),
// kept when Wikidata says what they are (museum, church, castle, park, monument…) or that they are listed heritage,
// with each article's short description, the first sentences of its text, a picture and its link. Ranked by how much
// people read them (page views of the last 30 days), so the best known sights come first.
// Only the city's name and coordinates leave the server. Wikipedia text is CC BY-SA 4.0, Wikidata CC0.

const UA = "podavo-voyage/1.0 (city attractions; https://podavo.voyage)";
const LANGS = ["pl", "en"];
const RADII = [2000, 5000, 10000]; // metres; 10 km is the most geosearch allows
const SCAN = 200; // articles looked at around the centre
const MAX = 60; // attractions returned

// Wikidata "instance of" (P31) → kind shown in the app. Direct classes only; a heritage listing (P1435) counts too.
const KINDS = {
  museum: ["Q33506", "Q207694", "Q1007870", "Q2772772", "Q588140", "Q17431399", "Q1060829", "Q16735822", "Q3329412"],
  sacral: ["Q16970", "Q2977", "Q163687", "Q1088552", "Q2031836", "Q34627", "Q44613", "Q108325", "Q32815", "Q120560", "Q56242215", "Q1129743", "Q160742", "Q317557"],
  castle: ["Q23413", "Q16560", "Q1785071", "Q17715832", "Q57821", "Q57831", "Q879050", "Q751876", "Q1802963", "Q57346"],
  monument: ["Q4989906", "Q5003624", "Q179700", "Q483453", "Q575759", "Q1081138", "Q2319498", "Q570116"],
  park: ["Q22698", "Q1107656", "Q167346", "Q43501", "Q2281788", "Q194195", "Q22746", "Q46169", "Q473972", "Q23397", "Q40080", "Q54050", "Q8502"],
  square: ["Q174782", "Q676050"],
  building: ["Q12518", "Q12280", "Q53060", "Q543654", "Q24354", "Q153562", "Q11303", "Q39715", "Q1440300", "Q839954", "Q41176", "Q7075", "Q483110", "Q1329623"],
};
const KIND_OF = new Map(Object.entries(KINDS).flatMap(([k, ids]) => ids.map((id) => [id, k])));
// Coordinate types ({{coord|type:…}}) that are never a sight: towns, districts, stations, schools, events, companies.
const NOT_SIGHT = new Set(["city", "adm1st", "adm2nd", "adm3rd", "country", "railwaystation", "airport", "edu", "event", "pass", "isle"]);

const bad = (message) => Object.assign(new Error(message), { status: 400 });
function km(a, b) {
  const r = (d) => (d * Math.PI) / 180, dLat = r(b.lat - a.lat), dLon = r(b.lon - a.lon);
  return 12742 * Math.asin(Math.sqrt(Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLon / 2) ** 2));
}
const chunks = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));
const ids = (entity, prop) => (entity?.claims?.[prop] || []).filter((c) => c.rank !== "deprecated").map((c) => c.mainsnak?.datavalue?.value?.id).filter(Boolean);

// What the article is about, from its Wikidata item; null when it is not a place to visit.
function kindOf(entity, coordType) {
  for (const id of ids(entity, "P31")) if (KIND_OF.has(id)) return KIND_OF.get(id);
  if (ids(entity, "P1435").length) return "heritage";
  if (coordType === "landmark") return "sight";
  return null;
}
// The first sentences of the article, without the pronunciation and dates in brackets right after the title.
function shortText(extract, max = 420) {
  let t = String(extract || "").replace(/\s+/g, " ").trim().replace(/\s*\([^()]{0,160}\)/, "");
  if (t.length <= max) return t;
  t = t.slice(0, max);
  const end = Math.max(t.lastIndexOf(". "), t.lastIndexOf("! "), t.lastIndexOf("? "));
  return end > 120 ? t.slice(0, end + 1) : t.replace(/\s+\S*$/, "") + "…";
}

function createAttractions({ fetchSource = fetch } = {}) {
  async function get(url) {
    const response = await fetchSource(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw Object.assign(new Error(`Wikipedia odpowiedziała HTTP ${response.status}.`), { status: 502 });
    return response.json();
  }

  async function list({ name = "", lat, lon, radius = 10000, lang = "pl" }) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw bad("Podaj współrzędne miasta.");
    if (!LANGS.includes(lang)) lang = "pl";
    radius = RADII.includes(radius) ? radius : 10000;
    const api = `https://${lang}.wikipedia.org/w/api.php?`;
    const centre = { lat, lon };
    const near = await get(api + new URLSearchParams({ action: "query", list: "geosearch", gscoord: `${lat.toFixed(4)}|${lon.toFixed(4)}`, gsradius: String(radius), gslimit: String(SCAN), gsprop: "type", format: "json", formatversion: "2" }));
    const found = (near?.query?.geosearch || []).filter((p) => p.ns === 0 && !NOT_SIGHT.has(String(p.type || "").toLowerCase()));
    if (!found.length) return { city: name, lang, radius, attractions: [], sources: [] };

    // Article details: the Wikidata item, short description, picture and page views, 50 articles a request.
    const pages = new Map();
    for (const part of await Promise.all(chunks(found, 50).map((group) => get(api + new URLSearchParams({
      action: "query", pageids: group.map((p) => p.pageid).join("|"), prop: "pageprops|description|pageimages|pageviews",
      ppprop: "wikibase_item|disambiguation", piprop: "thumbnail", pithumbsize: "320", pilimit: "50", pvipdays: "30", format: "json", formatversion: "2",
    })).catch(() => null)))) for (const p of part?.query?.pages || []) pages.set(p.pageid, p);

    const items = found.map((g) => ({ g, p: pages.get(g.pageid) })).filter(({ p }) => p && !p.missing && !(p.pageprops && "disambiguation" in p.pageprops));
    const qids = [...new Set(items.map(({ p }) => p.pageprops?.wikibase_item).filter((q) => /^Q\d+$/.test(q || "")))];
    const entities = {};
    for (const part of await Promise.all(chunks(qids, 50).map((group) => get("https://www.wikidata.org/w/api.php?" + new URLSearchParams({ action: "wbgetentities", ids: group.join("|"), props: "claims", format: "json" })).catch(() => null))))
      Object.assign(entities, part?.entities || {});

    const views = (p) => Object.values(p.pageviews || {}).reduce((s, v) => s + (Number(v) || 0), 0);
    const kept = items
      .map(({ g, p }) => ({ g, p, kind: kindOf(entities[p.pageprops?.wikibase_item], String(g.type || "").toLowerCase()) }))
      .filter((x) => x.kind)
      .map(({ g, p, kind }) => ({
        id: `${lang}:${g.pageid}`, title: p.title, description: p.description || "", kind,
        lat: +g.lat.toFixed(5), lon: +g.lon.toFixed(5), km: +km(centre, g).toFixed(2), views: views(p),
        image: p.thumbnail?.source || null,
        url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(String(p.title).replace(/ /g, "_"))}`,
        wikidata: p.pageprops?.wikibase_item || null,
      }))
      .sort((a, b) => b.views - a.views || a.km - b.km)
      .slice(0, MAX);

    // The opening sentences of each kept article (TextExtracts gives at most 20 intros a request).
    const texts = new Map();
    for (const part of await Promise.all(chunks(kept, 20).map((group) => get(api + new URLSearchParams({
      action: "query", pageids: group.map((a) => a.id.split(":")[1]).join("|"), prop: "extracts", exintro: "1", explaintext: "1", exsentences: "3", exlimit: "20", format: "json", formatversion: "2",
    })).catch(() => null)))) for (const p of part?.query?.pages || []) texts.set(`${lang}:${p.pageid}`, shortText(p.extract));
    for (const a of kept) a.extract = texts.get(a.id) || "";

    return {
      city: name, lang, radius, attractions: kept,
      sources: [{ name: "Wikipedia", url: `https://${lang}.wikipedia.org`, license: "CC BY-SA 4.0" }, { name: "Wikidata", url: "https://www.wikidata.org", license: "CC0" }],
      fetchedAt: new Date().toISOString(),
    };
  }
  return { list };
}

module.exports = { createAttractions, kindOf, shortText, KINDS };
