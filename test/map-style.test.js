"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const read = (file) => fs.readFileSync(path.resolve(__dirname, "..", file), "utf8");
function load() { const ctx = {}; vm.runInNewContext(read("assets/app.mapstyle.js"), ctx); return ctx.PODAVO_MAP; }
const clone = (x) => JSON.parse(JSON.stringify(x));

test("labels use the plain Noto Sans, never italics; bold stays bold", () => {
  const M = load();
  const water = clone(M.styleLayer({ id: "water_name_point", type: "symbol", "source-layer": "water_name", layout: { "text-field": "{name}", "text-font": ["Noto Sans Italic"] } }));
  assert.deepEqual(water.layout["text-font"], ["Noto Sans Regular"]);
  const city = clone(M.styleLayer({ id: "place_city", type: "symbol", "source-layer": "place", layout: { "text-field": "{name}", "text-font": ["Noto Sans Bold"] } }));
  assert.deepEqual(city.layout["text-font"], ["Noto Sans Bold"]);
  assert.equal(city.paint["text-color"], M.PASTEL.label);
});

test("the Podavo Clean pastels colour water, parks, buildings and major roads", () => {
  const M = load();
  assert.equal(M.styleLayer({ id: "water", type: "fill", "source-layer": "water" }).paint["fill-color"], "#aee0e6");
  assert.equal(M.styleLayer({ id: "park", type: "fill", "source-layer": "park" }).paint["fill-color"], "#cdebd6");
  assert.equal(M.styleLayer({ id: "highway_major", type: "line", "source-layer": "transportation" }).paint["line-color"], "#fde9b3");
  assert.equal(M.styleLayer({ id: "background", type: "background" }).paint["background-color"], "#f1f6ee");
  // Unlike Podavo Clean, rail stays visible on a transport map.
  assert.ok(M.styleLayer({ id: "railway", type: "line", "source-layer": "transportation" }).paint["line-opacity"] >= 0.5);
});

test("Podavo is the default map and an admin choice; the page loads the style before app.js", () => {
  assert.match(read("assets/app.defaults.js"), /tiles: 'podavo'/);
  assert.match(read("src/admin.js"), /TILES = new Set\(\["podavo",/);
  assert.match(read("admin.html"), /<option value="podavo">/);
  const html = read("index.html");
  assert.ok(html.indexOf("/assets/app.mapstyle.js") < html.indexOf('<script src="/assets/app.js">'));
  assert.match(read("assets/app.js"), /CFG\.tiles==='podavo' && !isDark\(\)/);
});

test("the full-screen city map can always be closed", () => {
  const app = read("assets/app.js");
  assert.match(app, /data-cp-map-close aria-label=/);
  assert.match(app, /e\.key==='Escape' && CITY\.el\?\.classList\.contains\('map-full'\)/);
  assert.match(app, /function setSubpage\(sub\)\{[\s\S]{0,240}map-full[^\n]*setCityMap\(false\)/);
  assert.match(read("assets/app.transport.css"), /\.map-full \.cp-map-wrap\{position:fixed;[^}]*top:var\(--cp-top/);
});
