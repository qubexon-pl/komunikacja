"use strict";

// Daily forecast at a trip's destination, from Open-Meteo (free, no key). Open-Meteo forecasts 16 days ahead, so a
// later trip gets an empty list and the date from which the forecast will exist. One answer per place (rounded to
// about 10 km) is kept for an hour and shared by everyone planning a trip there.

const FORECAST_DAYS = 16;
const KEEP_MS = 60 * 60 * 1000;
const NOW_KEEP_MS = 20 * 60 * 1000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function createTripWeather({ fetchSource = fetch, now = Date.now } = {}) {
  const cache = new Map();

  async function daily(lat, lon) {
    const key = `${lat.toFixed(1)},${lon.toFixed(1)}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < KEEP_MS) return hit.days;
    const url = "https://api.open-meteo.com/v1/forecast?" + new URLSearchParams({
      latitude: lat.toFixed(2),
      longitude: lon.toFixed(2),
      daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max",
      // Hourly values in the same request, so a card for a 00:49 landing shows the night, not the day's maximum.
      hourly: "temperature_2m,precipitation_probability,weather_code",
      forecast_days: String(FORECAST_DAYS),
      timezone: "auto",
    });
    const response = await fetchSource(url, { headers: { "User-Agent": "komunikacja-rzeszow/1.0" }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw Object.assign(new Error(`Open-Meteo zwrócił HTTP ${response.status}.`), { status: 502 });
    const body = await response.json();
    const d = body.daily || {};
    const pick = (name, i) => (Array.isArray(d[name]) && Number.isFinite(d[name][i]) ? d[name][i] : null);
    // Local hours of each day as [hour, temperature, rain chance, weather code] (times are the place's own, timezone=auto).
    const h = body.hourly || {}, hours = new Map();
    (h.time || []).forEach((time, i) => {
      const temp = h.temperature_2m?.[i];
      if (typeof time !== "string" || !Number.isFinite(temp)) return;
      const day = time.slice(0, 10), list = hours.get(day) || hours.set(day, []).get(day);
      const num = (v) => (Number.isFinite(v) ? v : null);
      list.push([Number(time.slice(11, 13)), temp, num(h.precipitation_probability?.[i]), num(h.weather_code?.[i])]);
    });
    const days = (d.time || []).map((day, i) => ({
      day,
      code: pick("weather_code", i),
      max: pick("temperature_2m_max", i),
      min: pick("temperature_2m_min", i),
      rainChance: pick("precipitation_probability_max", i),
      rainMm: pick("precipitation_sum", i),
      windKmh: pick("wind_speed_10m_max", i),
      ...(hours.has(day) ? { hours: hours.get(day) } : {}),
    })).filter((x) => DAY.test(x.day) && x.max != null && x.min != null); // the last day can come back empty
    cache.set(key, { at: now(), days });
    if (cache.size > 500) cache.clear();
    return days;
  }

  // Days from..to (inclusive) that have a forecast; availableFrom says when the first missing day will get one.
  async function forecast({ lat, lon, from, to }) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || !DAY.test(from) || !DAY.test(to) || to < from) {
      throw Object.assign(new Error("Podaj miejsce i daty."), { status: 400 });
    }
    const all = await daily(lat, lon);
    const days = all.filter((x) => x.day >= from && x.day <= to);
    const last = all.at(-1)?.day || null;
    const missing = !last || to > last;
    const firstMissing = missing ? (last && from <= last ? next(last) : from) : null;
    return { days, forecastUntil: last, availableFrom: firstMissing ? addDays(firstMissing, -(FORECAST_DAYS - 1)) : null };
  }

  // The weather where the person is now, for the home-page widget: current conditions and the next hours, in the same
  // shape as the Rzeszów snapshot (/api/live/weather), plus the name of the town when the map knows it. Coordinates are
  // rounded to about 1 km before they leave the server, and one answer per square is kept for 20 minutes.
  const nowCache = new Map();
  let lastNameAt = -Infinity;

  async function placeName(lat, lon) {
    // Nominatim allows one request a second; a busy second goes without a name rather than waiting.
    if (now() - lastNameAt < 1100) return null;
    lastNameAt = now();
    try {
      const url = "https://nominatim.openstreetmap.org/reverse?" + new URLSearchParams({ lat: lat.toFixed(2), lon: lon.toFixed(2), format: "jsonv2", zoom: "10", "accept-language": "pl" });
      const response = await fetchSource(url, { headers: { "User-Agent": "komunikacja-rzeszow/1.0" }, signal: AbortSignal.timeout(4000) });
      if (!response.ok) return null;
      const a = (await response.json())?.address || {};
      const name = a.city || a.town || a.village || a.municipality || a.county || null;
      return typeof name === "string" && name.trim() ? name.trim().slice(0, 80) : null;
    } catch {
      return null;
    }
  }

  async function current({ lat, lon }) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      throw Object.assign(new Error("Podaj miejsce."), { status: 400 });
    }
    const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
    const hit = nowCache.get(key);
    if (hit && now() - hit.at < NOW_KEEP_MS) return hit.value;
    const url = "https://api.open-meteo.com/v1/forecast?" + new URLSearchParams({
      latitude: lat.toFixed(2),
      longitude: lon.toFixed(2),
      current: "temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,is_day",
      hourly: "temperature_2m,precipitation_probability,precipitation,weather_code",
      forecast_hours: "8",
      timezone: "auto",
    });
    const [response, place] = await Promise.all([
      fetchSource(url, { headers: { "User-Agent": "komunikacja-rzeszow/1.0" }, signal: AbortSignal.timeout(10000) }),
      placeName(lat, lon),
    ]);
    if (!response.ok) throw Object.assign(new Error(`Open-Meteo zwrócił HTTP ${response.status}.`), { status: 502 });
    const body = await response.json();
    if (!body?.current) throw Object.assign(new Error("Open-Meteo nie podał pogody."), { status: 502 });
    const value = { current: body.current, hourly: body.hourly || {}, timezone: body.timezone || null, place };
    nowCache.set(key, { at: now(), value });
    if (nowCache.size > 500) nowCache.clear();
    return value;
  }

  return { forecast, current };
}

const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const next = (day) => addDays(day, 1);

module.exports = { createTripWeather, FORECAST_DAYS };
