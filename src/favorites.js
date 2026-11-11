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
      const flight = flightOf(item.flight);
      if (flight) favorite.flight = flight;
      // The choices of the plan: outbound and return flight (their keys) and the way to the airport.
      if (item.plan && typeof item.plan === "object" && text(item.plan.out)) favorite.plan = { out: text(item.plan.out), ret: text(item.plan.ret), access: text(item.plan.access) };
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
