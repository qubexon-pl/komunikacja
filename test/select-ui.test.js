"use strict";
// iPhone-style drop-down lists (assets/app.select.js). The DOM behaviour is checked in a browser; here placement.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const load = () => { const c = {}; vm.runInNewContext(read("assets/app.select.js"), c); return c.PVSelect; };
const box = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });

test("the list opens under the field when it fits", () => {
  const p = load().place(box(20, 100, 300, 44), 390, 844, 400);
  assert.equal(p.down, true);
  assert.equal(p.top, 150);
  assert.equal(p.left, 20);
  assert.equal(p.width, 300);
  assert.ok(p.maxHeight >= 400);
});

test("a field near the bottom opens its list above, and a long list scrolls", () => {
  const p = load().place(box(20, 700, 300, 44), 390, 844, 2000);
  assert.equal(p.down, false);
  assert.ok(p.maxHeight <= 420);
  assert.equal(p.top, 700 - 6 - p.maxHeight);
});

test("a narrow field still gets a readable list kept inside the screen", () => {
  const p = load().place(box(330, 100, 50, 40), 390, 844, 200);
  assert.equal(p.width, 180);
  assert.equal(p.left, 390 - 8 - 180);
});

test("every page that has drop-downs loads the list and its styles, and the offline cache has them", () => {
  for (const f of ["index.html", "admin.html"]) {
    const html = read(f);
    assert.ok(html.includes("/assets/app.select.js"), f);
    assert.ok(html.includes("/assets/app.select.css"), f);
  }
  const sw = read("assets/app.sw.js");
  assert.ok(sw.includes("'/assets/app.select.js'") && sw.includes("'/assets/app.select.css'"));
});

test("a list whose options are longer than the field grows to fit them, up to a limit", () => {
  const { place } = load();
  assert.equal(place(box(20, 100, 200, 44), 1440, 900, 300, 260).width, 260);
  assert.equal(place(box(20, 100, 200, 44), 1440, 900, 300, 900).width, 360);
  assert.equal(place(box(20, 100, 200, 44), 320, 900, 300, 900).width, 304);
});
