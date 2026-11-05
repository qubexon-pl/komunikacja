"use strict";

const MAX_FAVORITES = 50;
const MAX_TEXT = 200;
const VIEWS = new Set(["ztm", "pks", "kolej"]);

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
    if (item.type === "route" && text(item.from) && text(item.to)) favorite = { type: "route", view: item.view, from: text(item.from), to: text(item.to) };
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
