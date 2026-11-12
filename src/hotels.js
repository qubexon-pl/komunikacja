"use strict";

// Hotels near the destination for the dates of a saved trip, from the Booking.com Demand API.
// It runs against the sandbox by default (https://demandapi-sandbox.booking.com), which uses the normal affiliate
// credentials from the Booking.com Partner Centre: BOOKING_API_KEY (Bearer token) and BOOKING_AFFILIATE_ID.
// BOOKING_API_BASE points it elsewhere (for example the production base URL once the account is approved).
// Without credentials the app offers a Booking.com search link and adding a hotel by hand instead.
//
// Polite use: one request at a time, at most BOOKING_RPM per minute (the sandbox allows 50), answers kept for 30 minutes,
// and a pause of one minute after HTTP 429. The key is never logged or sent to the browser.

const DEFAULT_BASE = "https://demandapi-sandbox.booking.com/3.1";
const KEEP_MS = 30 * 60 * 1000;
const PAUSE_MS = 60 * 1000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RESULTS = 20;

const pick = (value) => {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") return value["pl"] || value["pl-pl"] || value["en-gb"] || value["en-us"] || Object.values(value).find((v) => typeof v === "string") || "";
  return String(value);
};
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const safeUrl = (value) => { try { const u = new URL(value); return u.protocol === "https:" ? u.href : null; } catch { return null; } };

// The price of a search result in both API shapes: 3.1 (total is a number) and 3.2+ (total.booker_currency).
function priceOf(item) {
  const p = item?.price;
  if (!p) return null;
  const total = typeof p.total === "number" ? p.total : num(p.total?.booker_currency ?? p.total?.accommodation_currency);
  const currency = typeof item.currency === "string" ? item.currency : item.currency?.booker || item.currency?.accommodation || null;
  return total != null ? { total: Math.round(total * 100) / 100, currency } : null;
}

function hotelFrom(item, detail, origin) {
  const loc = detail?.location || {};
  const lat = num(loc.coordinates?.latitude), lon = num(loc.coordinates?.longitude);
  const photo = (detail?.photos || []).find((p) => p.main_photo) || (detail?.photos || [])[0];
  const price = priceOf(item);
  const km = origin && lat != null && lon != null ? Math.round(distanceKm(origin.lat, origin.lon, lat, lon) * 10) / 10 : null;
  return {
    id: item.id,
    name: pick(detail?.name) || `Obiekt ${item.id}`,
    address: [pick(loc.address), loc.postal_code, pick(loc.city_name)].filter(Boolean).join(", "),
    lat, lon, km,
    stars: num(detail?.rating?.stars), score: num(detail?.rating?.review_score), reviews: num(detail?.rating?.number_of_reviews),
    photo: safeUrl(photo?.url?.standard || photo?.url?.thumbnail_large || "") || "",
    price: price?.total ?? null, currency: price?.currency || null,
    url: safeUrl(item.url || detail?.url || "") || "",
  };
}

function distanceKm(aLat, aLon, bLat, bLon) {
  const r = Math.PI / 180, dLat = (bLat - aLat) * r, dLon = (bLon - aLon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

// A Booking.com search page for the same place and dates: always available, also without API credentials.
function bookingSearchUrl({ city = "", checkin, checkout, adults = 1, lat, lon }) {
  const params = new URLSearchParams({ ss: city || `${lat},${lon}`, checkin, checkout, group_adults: String(adults), no_rooms: "1", group_children: "0" });
  if (Number.isFinite(lat) && Number.isFinite(lon)) { params.set("latitude", String(lat)); params.set("longitude", String(lon)); }
  return `https://www.booking.com/searchresults.html?${params}`;
}

function createHotels({ apiKey = process.env.BOOKING_API_KEY || "", affiliateId = process.env.BOOKING_AFFILIATE_ID || "", base = process.env.BOOKING_API_BASE || DEFAULT_BASE,
  rpm = Number(process.env.BOOKING_RPM) || 30, fetchSource = fetch, now = Date.now } = {}) {
  const configured = !!(apiKey && /^\d+$/.test(String(affiliateId)));
  const cache = new Map();
  let queue = Promise.resolve();
  let last = 0;
  let pausedUntil = 0;

  function post(path, body) {
    const run = queue.then(async () => {
      if (now() < pausedUntil) throw Object.assign(new Error("Booking.com poprosił o chwilę przerwy. Spróbuj za minutę."), { status: 429 });
      const wait = last + Math.ceil(60000 / rpm) - now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      last = now();
      const response = await fetchSource(`${base}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "X-Affiliate-Id": String(affiliateId), "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
      });
      if (response.status === 429) { pausedUntil = now() + PAUSE_MS; throw Object.assign(new Error("Booking.com: zbyt wiele zapytań, przerwa na minutę."), { status: 429 }); }
      if (response.status === 401 || response.status === 403) throw Object.assign(new Error("Booking.com odrzucił klucz API (sprawdź BOOKING_API_KEY i BOOKING_AFFILIATE_ID)."), { status: 502 });
      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
        throw Object.assign(new Error(`Booking.com zwrócił HTTP ${response.status}.`), { status: 502, detail });
      }
      return response.json();
    });
    queue = run.catch(() => {});
    return run;
  }

  async function search({ lat, lon, checkin, checkout, adults = 1, city = "", radius = 3 }) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw Object.assign(new Error("Nieprawidłowe miejsce."), { status: 400 });
    if (!DAY.test(checkin || "") || !DAY.test(checkout || "") || checkout <= checkin) throw Object.assign(new Error("Podaj daty przyjazdu i wyjazdu."), { status: 400 });
    const guests = Math.min(8, Math.max(1, Math.round(Number(adults) || 1)));
    const link = bookingSearchUrl({ city, checkin, checkout, adults: guests, lat, lon });
    if (!configured) return { configured: false, hotels: [], bookingUrl: link };
    const key = `${lat.toFixed(3)},${lon.toFixed(3)}|${checkin}|${checkout}|${guests}|${radius}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < KEEP_MS) return hit.result;
    const found = await post("/accommodations/search", {
      booker: { country: "pl", platform: "desktop" }, checkin, checkout, currency: "PLN",
      guests: { number_of_adults: guests, number_of_rooms: 1 },
      coordinates: { latitude: lat, longitude: lon, radius: Math.min(20, Math.max(1, Number(radius) || 3)) },
      rows: MAX_RESULTS,
    });
    const items = (found?.data || []).filter((x) => Number.isInteger(x?.id)).slice(0, MAX_RESULTS);
    let details = [];
    if (items.length) {
      const d = await post("/accommodations/details", { accommodations: items.map((x) => x.id), extras: ["photos"], languages: ["pl", "en-gb"] }).catch(() => null);
      details = d?.data || [];
    }
    const byId = new Map(details.map((x) => [x.id, x]));
    const hotels = items.map((x) => hotelFrom(x, byId.get(x.id), { lat, lon })).sort((a, b) => (a.price ?? 1e9) - (b.price ?? 1e9));
    const result = { configured: true, sandbox: /sandbox/.test(base), hotels, bookingUrl: link, fetchedAt: now() };
    cache.set(key, { at: now(), result });
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    return result;
  }

  return { search, configured: () => configured };
}

module.exports = { createHotels, bookingSearchUrl, priceOf, hotelFrom };
