"use strict";

const MAX_FAVORITES = 50;
const MAX_TEXT = 200;
const VIEWS = new Set(["ztm", "pks", "kolej", "podroz"]);
const IATA = /^[A-Z]{3}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// The flight of a saved trip: airports, days, airline and the price when it was saved. Anything else is dropped.
function flightOf(value) {
  if (!value || typeof value !== "object" || !IATA.test(value.from) || !IATA.test(value.to) || !DAY.test(value.day)) return null;
  const flight = { from: value.from, to: value.to, day: value.day, back: DAY.test(value.back) ? value.back : "", airline: /^[A-Z0-9]{2,12}$/.test(value.airline) ? value.airline : "" };
  if (Number.isFinite(value.price) && value.price > 0 && value.price < 100000) flight.price = Math.round(value.price);
  return flight;
}

function text(value) {
  return typeof value === "string" ? value.trim().slice(0, MAX_TEXT) : "";
}

// What a saved trip looked like when it was saved (flights, the way to the airport, the chosen way into town), so its
// page can be shown without planning again. It comes from the browser: plain data only — short strings, finite numbers,
// small lists, a few levels deep — and at most MAX_SNAPSHOT characters.
const MAX_SNAPSHOT = 60000; // steps to the airport, weather places, costs, a hotel; a trip in several legs holds each leg
const MAX_DEPTH = 8; // trip → legs → leg → snapshot → access → steps → step → link
function plain(value, depth = 0) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return value.slice(0, 300);
  if (depth >= MAX_DEPTH) return null;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => plain(v, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [key, v] of Object.entries(value).slice(0, 40)) if (/^[A-Za-z][A-Za-z0-9]{0,23}$/.test(key) && v !== undefined) out[key] = plain(v, depth + 1);
    return out;
  }
  return null;
}
function snapshotOf(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const clean = plain(value);
  return JSON.stringify(clean).length <= MAX_SNAPSHOT ? clean : null;
}

// Favourites arrive from the browser, so only known fields of known shapes are kept.
function normalizeFavorites(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const favorites = [];
  for (const item of value) {
    if (!item || !VIEWS.has(item.view)) continue;
    let favorite = null;
    if (item.type === "stop" && text(item.name)) favorite = { type: "stop", view: item.view, name: text(item.name) };
    if (item.type === "line" && text(item.id) && text(item.name)) favorite = { type: "line", view: item.view, id: text(item.id), name: text(item.name) };
    if (item.type === "route" && text(item.from) && text(item.to)) favorite = { type: "route", view: item.view, from: text(item.from), to: text(item.to) };
    if (item.type === "trip" && text(item.id) && text(item.from) && text(item.to) && text(item.name)) {
      favorite = { type: "trip", view: "podroz", id: text(item.id), from: text(item.from), to: text(item.to), name: text(item.name), detail: text(item.detail) };
      // The traveller's own name for the trip and the places in between (Rzeszów → Szczecin → Gdańsk → Wrocław).
      const title = text(item.title).slice(0, 80);
      if (title) favorite.title = title;
      const stops = Array.isArray(item.stops) ? item.stops.map(text).filter(Boolean).slice(0, 6) : [];
      if (stops.length) favorite.stops = stops;
      const flight = flightOf(item.flight);
      if (flight) favorite.flight = flight;
      // The choices of the plan: outbound and return flight (their keys) and the way to the airport.
      if (item.plan && typeof item.plan === "object" && text(item.plan.out)) favorite.plan = { out: text(item.plan.out), ret: text(item.plan.ret), access: text(item.plan.access), xfer: text(item.plan.xfer) };
      // "planned": kept in favourites; "booked": the traveller's own trip, listed under My trips.
      if (item.status === "booked" || item.status === "planned") favorite.status = item.status;
      if (/^[a-z0-9]{6,24}$/.test(item.tid || "")) favorite.tid = item.tid;
      const trip = snapshotOf(item.trip);
      if (trip) favorite.trip = trip;
    }
    if (!favorite) continue;
    const key = JSON.stringify(favorite);
    if (seen.has(key)) continue;
    seen.add(key);
    favorites.push(favorite);
    if (favorites.length === MAX_FAVORITES) break;
  }
  return favorites;
}

module.exports = { MAX_FAVORITES, normalizeFavorites };
