"use strict";

// PKS Rzeszów ticket prices from its public journey planner (pks.rzeszow.pl), the same steps the website takes:
// stop search (JSON) → route search (form, 303 redirect) → result table with "4.50 zł" in td.cena.
// Kept polite: the app's own User-Agent, one request at a time with a gap, answers kept for 30 days (a ticket
// between two stops rarely changes), and a pause of an hour after HTTP 429 or 403 without retrying.

const BASE = "https://pks.rzeszow.pl/wyszukiwarka-polaczen,201";
const USER_AGENT = "komunikacja-rzeszow/1.0 (personal trip planner test)";
const GAP_MS = 2000;
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const PAUSE_MS = 60 * 60 * 1000;
const NEAR_M = 1500;

const fold = (text) => String(text || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ł/g, "l");
function metres(a, b) {
  const rad = (x) => (x * Math.PI) / 180, dLat = rad(b[0] - a[0]), dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(h));
}
// The word to search the planner by: the town, i.e. the first word of the timetable's stop name.
function searchTerm(name) {
  const words = String(name).replace(/[^\p{L}\d .-]/gu, " ").split(/\s+/).filter(Boolean);
  return (words.find((w) => w.length >= 3) || words[0] || "").slice(0, 40);
}

// Rows of the result table: departure, arrival, distance, line and price.
function parseResults(html) {
  const body = html.slice(html.indexOf("<tbody"), html.lastIndexOf("</tbody>"));
  const rows = [];
  for (const row of body.split(/<tr[\s>]/).slice(1)) {
    const cell = (cls) => new RegExp(`<td class="[^"]*\\b${cls}\\b[^"]*"[^>]*>([\\s\\S]*?)</td>`).exec(row)?.[1] ?? "";
    const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();
    const price = /(\d+[.,]\d{2})\s*zł/.exec(text(cell("cena")))?.[1];
    const dep = /\d{1,2}:\d{2}/.exec(text(cell("odj")))?.[0];
    if (!price || !dep) continue;
    rows.push({
      departure: dep.padStart(5, "0"),
      arrival: /\d{1,2}:\d{2}/.exec(text(cell("prz")))?.[0]?.padStart(5, "0") || null,
      km: Number(/(\d+)\s*km/.exec(text(cell("km")))?.[1]) || null,
      line: text(cell("nrlinii")) || null,
      price: Number(price.replace(",", ".")),
    });
  }
  return rows;
}

function createPksFares({ fetchSource = fetch, now = Date.now, gapMs = GAP_MS } = {}) {
  const stopsByTerm = new Map();
  const fares = new Map();
  let queue = Promise.resolve();
  let lastCall = 0;
  let pausedUntil = 0;

  function request(url, init = {}) {
    const job = queue.then(async () => {
      if (now() < pausedUntil) throw Object.assign(new Error("PKS poprosił o przerwę; kolejne zapytanie za godzinę."), { status: 429 });
      const wait = lastCall + gapMs - now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      lastCall = now();
      const send = () => fetchSource(url, { ...init, headers: { "User-Agent": USER_AGENT, ...(init.headers || {}) }, signal: AbortSignal.timeout(30000) });
      // The server sometimes refuses a reused HTTP/2 stream (a transport error, not a refusal of the request): try once more.
      const response = await send().catch(async (error) => {
        if (!/fetch failed/i.test(error.message)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return send();
      });
      if (response.status === 429 || response.status === 403) {
        pausedUntil = now() + PAUSE_MS;
        throw Object.assign(new Error(`PKS odmówił (HTTP ${response.status}). Przerwa na godzinę.`), { status: response.status });
      }
      return response;
    });
    queue = job.catch(() => {});
    return job;
  }

  async function stops(term) {
    const key = fold(term), known = stopsByTerm.get(key);
    if (known && now() - known.at < KEEP_MS) return known.list;
    const response = await request(`${BASE}?opr_dane=przystanki&term=${encodeURIComponent(term)}`, { headers: { Accept: "application/json" } });
    if (!response.ok) throw Object.assign(new Error(`PKS zwrócił HTTP ${response.status}.`), { status: 502 });
    const list = (await response.json().catch(() => [])).filter((s) => s && s.kod && s.nazwa).map((s) => ({ code: String(s.kod), name: s.nazwa, point: [Number(s.y), Number(s.x)] }));
    stopsByTerm.set(key, { at: now(), list });
    return list;
  }

  // The planner's stop nearest to the timetable stop (names differ between the two, positions do not).
  async function findStop({ name, lat, lon }) {
    const list = await stops(searchTerm(name));
    const here = [Number(lat), Number(lon)];
    const near = list.map((s) => ({ ...s, dist: Number.isFinite(s.point[0]) ? metres(here, s.point) : Infinity })).sort((a, b) => a.dist - b.dist)[0];
    return near && near.dist <= NEAR_M ? near : null;
  }

  // Price of a ride between two stops on a day; with a time (and line), the matching departure's price.
  async function price({ from, to, day, time = "", line = "" }) {
    const [a, b] = [await findStop(from), await findStop(to)];
    if (!a || !b) return { price: null, reason: "no-stop" };
    const key = `${a.code}|${b.code}`;
    let known = fares.get(key);
    if (!known || now() - known.at >= KEEP_MS) {
      const form = new URLSearchParams({ kodpp: a.code, kodpd: b.code, pomkal: "0", przyp: a.name, przyd: b.name, datap: day });
      const search = await request(BASE, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form, redirect: "manual" });
      const location = search.headers.get("location");
      if (search.status !== 303 || !location) return { price: null, reason: "no-result" };
      const page = await request(new URL(location, BASE).toString());
      const rows = page.ok ? parseResults(await page.text()) : [];
      known = { at: now(), rows };
      fares.set(key, known);
    }
    const rows = known.rows;
    if (!rows.length) return { price: null, reason: "no-rows", from: a.name, to: b.name };
    const exact = rows.find((r) => r.departure === time && (!line || r.line === String(line))) || rows.find((r) => r.departure === time);
    // Without that departure, the price most rides between these stops have.
    const counts = new Map(); for (const r of rows) counts.set(r.price, (counts.get(r.price) || 0) + 1);
    const usual = [...counts].sort((x, y) => y[1] - x[1])[0][0];
    return { price: exact ? exact.price : usual, exact: !!exact, km: (exact || rows[0]).km, from: a.name, to: b.name };
  }

  return { findStop, price };
}

module.exports = { createPksFares, parseResults, searchTerm };
