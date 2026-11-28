"use strict";

// Attractions of a city from Wikipedia, in two passes:
//  1. The city's own article: its sections about sights ("Zabytki", "Atrakcje turystyczne", "Architektura",
//     "Sights", "Landmarks", "Tourism"… and their subsections) are read one by one (action=parse&section=N) and every
//     article they link to is a candidate. These are the places the article's editors chose, so they come first.
//  2. Articles with coordinates around the centre (MediaWiki geosearch) that Wikidata calls a sight (museum, church,
//     castle, monument, park…) or listed heritage, to fill the list when the article has few links.
// A candidate is kept when it has coordinates near the city and is not a town, district, station, river or person.
// Each comes with its short description, the first sentences of its text, a picture and its link, and is ranked by how
// much people read it (page views of the last 30 days). Only the city's name and coordinates leave the server.
// Wikipedia text is CC BY-SA 4.0, Wikidata CC0.

const UA = "podavo-voyage/1.0 (city attractions; https://podavo.voyage)";
const LANGS = ["pl", "en"];
const RADII = [2000, 5000, 10000]; // metres; 10 km is the most geosearch allows
const SCAN = 200; // geosearch articles looked at around the centre
const MAX = 60; // attractions returned
const NEAR_KM = 30; // a linked article farther than this from the centre is about another place
const MAX_SECTIONS = 10;
const MAX_LINKS = 200;

// Section titles about what to see (Polish and English Wikipedia).
const SIGHT_SECTION = /zabyt|atrakcj|turysty|architektur|warto zobaczy|ciekaw|obiekty|muze|ko[śs]cio[łl]|[śs]wi[ąa]tyni|pomnik|parki|ogrody|place|budowle|sights|attraction|landmark|touris|architecture|places of interest|cityscape|museum|monument|churches|parks|squares|points of interest/i;
const NOT_SIGHT_SECTION = /przypisy|bibliografi|linki|zobacz te[żz]|literatura|references|external|see also|further reading|notes|sources|demografi|gospodark|economy|transport|sport|edukacj|education|polityk|politic|klimat|climate|miasta partnerskie|twin/i;

// Wikidata "instance of" (P31) → kind shown in the app. Direct classes only; a heritage listing (P1435) counts too.
const KINDS = {
  museum: ["Q33506", "Q207694", "Q1007870", "Q2772772", "Q588140", "Q17431399", "Q1060829", "Q16735822", "Q3329412"],
  sacral: ["Q16970", "Q2977", "Q163687", "Q1088552", "Q2031836", "Q34627", "Q44613", "Q108325", "Q32815", "Q120560", "Q56242215", "Q1129743", "Q160742", "Q317557"],
  castle: ["Q23413", "Q16560", "Q1785071", "Q17715832", "Q57821", "Q57831", "Q879050", "Q751876", "Q1802963", "Q57346", "Q3950"],
  monument: ["Q4989906", "Q5003624", "Q179700", "Q483453", "Q575759", "Q1081138", "Q2319498", "Q570116", "Q13217555", "Q170980", "Q4817", "Q162875"],
  park: ["Q22698", "Q1107656", "Q167346", "Q43501", "Q2281788", "Q194195", "Q22746", "Q46169", "Q473972", "Q23397", "Q40080", "Q54050", "Q8502"],
  square: ["Q174782", "Q676050", "Q12511"],
  building: ["Q12518", "Q12280", "Q53060", "Q543654", "Q24354", "Q153562", "Q11303", "Q39715", "Q1440300", "Q839954", "Q41176", "Q7075", "Q483110", "Q1329623", "Q54831", "Q109607", "Q474", "Q173387", "Q82117"],
};
const KIND_OF = new Map(Object.entries(KINDS).flatMap(([k, list]) => list.map((id) => [id, k])));
// Never a sight, even when the city article links it: places to live in, areas, transport, rivers, schools, people.
const NOT_SIGHT_CLASS = new Set(["Q515", "Q486972", "Q1549591", "Q747074", "Q5119", "Q6256", "Q123705", "Q15284", "Q3957", "Q532", "Q4022",
  "Q55488", "Q1248784", "Q3918", "Q5", "Q1637706", "Q200250", "Q1907114", "Q7930989", "Q484170", "Q262166", "Q2074737", "Q1093829",
  "Q34442", "Q928830", "Q4830453", "Q43229", "Q178561", "Q1190554", "Q10864048", "Q13406463", "Q3624078", "Q2983893", "Q1394476"]);
// Coordinate types ({{coord|type:…}}) that are never a sight: towns, districts, stations, schools, events, companies.
const NOT_SIGHT = new Set(["city", "adm1st", "adm2nd", "adm3rd", "country", "railwaystation", "airport", "edu", "event", "pass", "isle"]);

const bad = (message) => Object.assign(new Error(message), { status: 400 });
function km(a, b) {
  const r = (d) => (d * Math.PI) / 180, dLat = r(b.lat - a.lat), dLon = r(b.lon - a.lon);
  return 12742 * Math.asin(Math.sqrt(Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLon / 2) ** 2));
}
const chunks = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));
const ids = (entity, prop) => (entity?.claims?.[prop] || []).filter((c) => c.rank !== "deprecated").map((c) => c.mainsnak?.datavalue?.value?.id).filter(Boolean);

// What the article is about, from its Wikidata item; null when it is not a place to visit. `listed`: the city
// article names it among its sights, so anything with a position that is not a town, area, station… counts.
function kindOf(entity, coordType, listed = false) {
  const classes = ids(entity, "P31");
  if (classes.some((id) => NOT_SIGHT_CLASS.has(id))) return null;
  for (const id of classes) if (KIND_OF.has(id)) return KIND_OF.get(id);
  if (ids(entity, "P1435").length) return "heritage";
  if (coordType === "landmark" || listed) return "sight";
  return null;
}
// The first sentences of the article, without the pronunciation and dates in brackets right after the title.
function shortText(extract, max = 700) {
  let t = String(extract || "").replace(/\s+/g, " ").trim().replace(/\s*\([^()]{0,160}\)/, "");
  if (t.length <= max) return t;
  t = t.slice(0, max);
  const end = Math.max(t.lastIndexOf(". "), t.lastIndexOf("! "), t.lastIndexOf("? "));
  return end > 120 ? t.slice(0, end + 1) : t.replace(/\s+\S*$/, "") + "…";
}
// Sections about sights, with their subsections ("4", "4.1", "4.2"), at most MAX_SECTIONS, in article order.
function sightSections(sections) {
  const list = (sections || []).filter((s) => s && s.index !== "" && !/^T-/.test(String(s.index)));
  const roots = list.filter((s) => SIGHT_SECTION.test(s.line || "") && !NOT_SIGHT_SECTION.test(s.line || ""));
  const out = [];
  for (const r of roots) for (const s of list) if ((s.number === r.number || String(s.number).startsWith(r.number + ".")) && !NOT_SIGHT_SECTION.test(s.line || "") && !out.includes(s)) out.push(s);
  return out.slice(0, MAX_SECTIONS);
}

function createAttractions({ fetchSource = fetch } = {}) {
  async function get(url) {
    const response = await fetchSource(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw Object.assign(new Error(`Wikipedia odpowiedziała HTTP ${response.status}.`), { status: 502 });
    return response.json();
  }

  // Titles linked from the sights sections of the city's article, in the article's order.
  async function linkedTitles(api, title) {
    const parsed = await get(api + new URLSearchParams({ action: "parse", page: title, prop: "sections", redirects: "1", format: "json", formatversion: "2" })).catch(() => null);
    const page = parsed?.parse?.title || title;
    const sections = sightSections(parsed?.parse?.sections);
    if (!sections.length) return { page, sections: [], titles: [] };
    const titles = [];
    for (const part of await Promise.all(sections.map((s) => get(api + new URLSearchParams({ action: "parse", page, section: String(s.index), prop: "links", format: "json", formatversion: "2" })).catch(() => null))))
      for (const l of part?.parse?.links || []) if (l.ns === 0 && l.exists !== false && !titles.includes(l.title) && l.title !== page) titles.push(l.title);
    return { page, sections: sections.map((s) => s.line), titles: titles.slice(0, MAX_LINKS) };
  }

  async function list({ name = "", title = "", lat, lon, radius = 10000, lang = "pl" }) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw bad("Podaj współrzędne miasta.");
    if (!LANGS.includes(lang)) lang = "pl";
    radius = RADII.includes(radius) ? radius : 10000;
    title = String(title || "").replace(/\s+/g, " ").trim().slice(0, 120);
    const api = `https://${lang}.wikipedia.org/w/api.php?`;
    const centre = { lat, lon };
    const info = { prop: "coordinates|pageprops|description|pageimages|pageviews", ppprop: "wikibase_item|disambiguation", piprop: "thumbnail", pithumbsize: "480", pilimit: "50", colimit: "50", pvipdays: "30", format: "json", formatversion: "2" };

    // 1. Articles linked from the city article's sights sections.
    const linked = title ? await linkedTitles(api, title) : { titles: [], sections: [] };
    const pages = new Map(); // pageid → { p, listed, order, type }
    for (const part of await Promise.all(chunks(linked.titles, 50).map((group) => get(api + new URLSearchParams({ action: "query", titles: group.join("|"), redirects: "1", ...info })).catch(() => null)))) {
      for (const p of part?.query?.pages || []) {
        const c = p.coordinates?.[0];
        if (!p.pageid || p.missing || !c || (p.pageprops && "disambiguation" in p.pageprops) || km(centre, c) > NEAR_KM) continue;
        if (!pages.has(p.pageid)) pages.set(p.pageid, { p, lat: c.lat, lon: c.lon, type: String(c.type || "").toLowerCase(), listed: true });
      }
    }

    // 2. Articles around the centre.
    const near = await get(api + new URLSearchParams({ action: "query", list: "geosearch", gscoord: `${lat.toFixed(4)}|${lon.toFixed(4)}`, gsradius: String(radius), gslimit: String(SCAN), gsprop: "type", format: "json", formatversion: "2" })).catch((e) => (pages.size ? null : Promise.reject(e)));
    const found = (near?.query?.geosearch || []).filter((g) => g.ns === 0 && !pages.has(g.pageid) && !NOT_SIGHT.has(String(g.type || "").toLowerCase()));
    for (const part of await Promise.all(chunks(found, 50).map((group) => get(api + new URLSearchParams({ action: "query", pageids: group.map((g) => g.pageid).join("|"), ...info })).catch(() => null)))) {
      for (const p of part?.query?.pages || []) {
        const g = found.find((x) => x.pageid === p.pageid);
        if (!g || p.missing || (p.pageprops && "disambiguation" in p.pageprops)) continue;
        pages.set(p.pageid, { p, lat: g.lat, lon: g.lon, type: String(g.type || "").toLowerCase(), listed: false });
      }
    }
    if (!pages.size) return { city: name, title, lang, radius, attractions: [], sections: linked.sections, sources: [] };

    const all = [...pages.values()].filter((x) => !NOT_SIGHT.has(x.type));
    const qids = [...new Set(all.map((x) => x.p.pageprops?.wikibase_item).filter((q) => /^Q\d+$/.test(q || "")))];
    const entities = {};
    for (const part of await Promise.all(chunks(qids, 50).map((group) => get("https://www.wikidata.org/w/api.php?" + new URLSearchParams({ action: "wbgetentities", ids: group.join("|"), props: "claims", format: "json" })).catch(() => null))))
      Object.assign(entities, part?.entities || {});

    const views = (p) => Object.values(p.pageviews || {}).reduce((s, v) => s + (Number(v) || 0), 0);
    const kept = all
      .map((x) => ({ ...x, kind: kindOf(entities[x.p.pageprops?.wikibase_item], x.type, x.listed) }))
      .filter((x) => x.kind)
      .map(({ p, lat: la, lon: lo, kind, listed }) => ({
        id: `${lang}:${p.pageid}`, title: p.title, description: p.description || "", kind, listed,
        lat: +(+la).toFixed(5), lon: +(+lo).toFixed(5), km: +km(centre, { lat: la, lon: lo }).toFixed(2), views: views(p),
        image: p.thumbnail?.source || null,
        url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(String(p.title).replace(/ /g, "_"))}`,
        wikidata: p.pageprops?.wikibase_item || null,
      }))
      // The city article's own picks first, then the rest; each group by how much it is read.
      .sort((a, b) => (b.listed - a.listed) || b.views - a.views || a.km - b.km)
      .slice(0, MAX);

    // The opening sentences of each kept article (TextExtracts gives at most 20 intros a request).
    const texts = new Map();
    for (const part of await Promise.all(chunks(kept, 20).map((group) => get(api + new URLSearchParams({
      action: "query", pageids: group.map((a) => a.id.split(":")[1]).join("|"), prop: "extracts", exintro: "1", explaintext: "1", exsentences: "5", exlimit: "20", format: "json", formatversion: "2",
    })).catch(() => null)))) for (const p of part?.query?.pages || []) texts.set(`${lang}:${p.pageid}`, shortText(p.extract));
    for (const a of kept) a.extract = texts.get(a.id) || "";

    return {
      city: name, title: linked.page || title, lang, radius, attractions: kept, sections: linked.sections,
      sources: [{ name: "Wikipedia", url: `https://${lang}.wikipedia.org`, license: "CC BY-SA 4.0" }, { name: "Wikidata", url: "https://www.wikidata.org", license: "CC0" }],
      fetchedAt: new Date().toISOString(),
    };
  }
  return { list };
}

module.exports = { createAttractions, kindOf, shortText, sightSections, KINDS };
