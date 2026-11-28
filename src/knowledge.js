"use strict";

// Phase 6a (docs/PODAVO_REFACTOR.md): what the app knows about a destination, from open sources only.
//  - Wikipedia (pl or en): the article about the place found next to its coordinates, its summary, picture and link.
//  - Wikidata: the facts that article is linked to (population, country, elevation, official website, time zone).
// Only the destination's name and coordinates leave the server; nothing about the traveller does. Every answer carries
// its sources and licence (Wikipedia text is CC BY-SA 4.0, Wikidata CC0), and nothing is filled in when a source has
// no value. The server keeps each answer in the database for 30 days (src/stored.js), so the sources are asked rarely.

const UA = "podavo-voyage/1.0 (destination info; https://podavo.voyage)";
const LANGS = ["pl", "en"];
const SEARCH_M = 10000;
const FALLBACK_KM = 60;

const fold = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ł/g, "l").replace(/Ł/g, "L").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function kmBetween(a, b) {
  const r = (d) => (d * Math.PI) / 180, dLat = r(b.lat - a.lat), dLon = r(b.lon - a.lon);
  return 12742 * Math.asin(Math.sqrt(Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLon / 2) ** 2));
}
const bad = (message) => Object.assign(new Error(message), { status: 400 });

// The article for the place: among Wikipedia pages next to the point, the one named like it ("Rzym", "Rome (Italy)").
function pickArticle(pages, name) {
  const want = fold(name);
  if (!want) return null;
  const named = (p) => { const t = fold(String(p.title).replace(/\s*\(.*\)$/, "").split(",")[0]); return t === want; };
  return pages.find(named) || pages.find((p) => fold(p.title).startsWith(want + " ")) || null;
}

// "Rzym Fiumicino (FCO)" -> ["Rzym Fiumicino", "Rzym"]: the name, then shorter by whole words (at least 3 letters left).
function candidates(name) {
  const words = String(name).replace(/\s*\([^)]*\)\s*$/, "").split(",")[0].trim().split(/\s+/).filter(Boolean);
  const out = [];
  for (let n = words.length; n >= 1; n -= 1) {
    const c = words.slice(0, n).join(" ");
    if (c.length >= 3 && !out.includes(c)) out.push(c);
  }
  return out.slice(0, 3);
}

// The newest value of a Wikidata claim (by its point-in-time qualifier when there are several, e.g. population).
function claim(entity, prop) {
  const list = (entity?.claims?.[prop] || []).filter((c) => c.rank !== "deprecated" && c.mainsnak?.datavalue);
  if (!list.length) return null;
  const when = (c) => c.qualifiers?.P585?.[0]?.datavalue?.value?.time || "";
  const best = list.find((c) => c.rank === "preferred") || list.slice().sort((a, b) => when(b).localeCompare(when(a)))[0];
  return { value: best.mainsnak.datavalue.value, year: when(best).slice(1, 5) || null };
}

function createKnowledge({ fetchSource = fetch } = {}) {
  async function get(url) {
    const response = await fetchSource(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    if (response.status === 404) return null;
    if (!response.ok) throw Object.assign(new Error(`Źródło odpowiedziało HTTP ${response.status}.`), { status: 502 });
    return response.json();
  }

  async function labels(ids, lang) {
    if (!ids.length) return new Map();
    const body = await get("https://www.wikidata.org/w/api.php?" + new URLSearchParams({ action: "wbgetentities", ids: ids.join("|"), props: "labels", languages: `${lang}|en`, format: "json" }));
    return new Map(Object.entries(body?.entities || {}).map(([id, e]) => [id, e.labels?.[lang]?.value || e.labels?.en?.value || null]));
  }

  async function about({ name, lat, lon, lang = "pl" }) {
    name = String(name || "").replace(/\s+/g, " ").trim();
    if (!name || name.length > 80) throw bad("Podaj nazwę miejsca.");
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw bad("Podaj współrzędne miejsca.");
    if (!LANGS.includes(lang)) lang = "pl";
    const wiki = `https://${lang}.wikipedia.org`;
    const near = await get(`${wiki}/w/api.php?` + new URLSearchParams({ action: "query", list: "geosearch", gscoord: `${lat.toFixed(4)}|${lon.toFixed(4)}`, gsradius: String(SEARCH_M), gslimit: "50", format: "json" }));
    // Places named after their airport ("Rzym Fiumicino", "Londyn Luton") are looked up as the full name first, then
    // with words dropped from the end, so the city's own article is found.
    const tries = candidates(name);
    let page = null;
    for (const n of tries) if (!page) page = pickArticle(near?.query?.geosearch || [], n);
    // A point at the airport can be farther from the city's article than the 10 km Wikipedia searches: then the article
    // of that name, if it lies within FALLBACK_KM and is not a disambiguation page.
    for (const n of tries) {
      if (page) break;
      const named = await get(`${wiki}/w/api.php?` + new URLSearchParams({ action: "query", prop: "coordinates|pageprops", titles: n, redirects: "1", format: "json" }));
      const p = Object.values(named?.query?.pages || {})[0], c = p?.coordinates?.[0];
      if (p && !p.missing && c && !(p.pageprops && "disambiguation" in p.pageprops) && kmBetween({ lat, lon }, c) <= FALLBACK_KM) page = { title: p.title };
    }
    if (!page) return { found: false, name, lang, sources: [] };
    const summary = await get(`${wiki}/api/rest_v1/page/summary/${encodeURIComponent(String(page.title).replace(/ /g, "_"))}`);
    if (!summary || summary.type === "disambiguation") return { found: false, name, lang, sources: [] };
    const qid = /^Q\d+$/.test(summary.wikibase_item || "") ? summary.wikibase_item : null;
    const out = {
      found: true, name, lang, title: summary.title, description: summary.description || null,
      extract: String(summary.extract || "").slice(0, 1200) || null,
      image: summary.thumbnail?.source || null,
      url: summary.content_urls?.desktop?.page || `${wiki}/wiki/${encodeURIComponent(page.title)}`,
      facts: {},
      sources: [{ name: "Wikipedia", url: summary.content_urls?.desktop?.page || wiki, license: "CC BY-SA 4.0" }],
    };
    if (qid) {
      const data = await get(`https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`).catch(() => null);
      const e = data?.entities?.[qid];
      if (e) {
        const pop = claim(e, "P1082"), elev = claim(e, "P2044"), site = claim(e, "P856"), country = claim(e, "P17"), zone = claim(e, "P421");
        const amount = (c) => (c ? Math.round(Number(c.value.amount)) : null);
        if (pop && Number.isFinite(amount(pop))) out.facts.population = { value: amount(pop), year: pop.year };
        if (elev && Number.isFinite(amount(elev)) && /Q11573$/.test(elev.value.unit || "")) out.facts.elevationM = amount(elev);
        if (site && /^https?:\/\//.test(site.value)) out.facts.website = site.value;
        const names = await labels([country?.value?.id, zone?.value?.id].filter((x) => /^Q\d+$/.test(x || "")), lang).catch(() => new Map());
        if (country && names.get(country.value.id)) out.facts.country = names.get(country.value.id);
        if (zone && names.get(zone.value.id)) out.facts.timeZone = names.get(zone.value.id);
        out.wikidata = qid;
        out.sources.push({ name: "Wikidata", url: `https://www.wikidata.org/wiki/${qid}`, license: "CC0" });
      }
    }
    out.fetchedAt = new Date().toISOString();
    return out;
  }
  return { about };
}

module.exports = { createKnowledge, pickArticle, claim, fold, candidates };
