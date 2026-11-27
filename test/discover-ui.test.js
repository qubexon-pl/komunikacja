"use strict";
// Phase 5b: the discovery list (assets/app.discover.js) and its wiring in the "Kierunki" panel.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const read = (file) => fs.readFileSync(path.resolve(__dirname, "..", file), "utf8");
const html = read("index.html");
const app = read("assets/app.js");
function loadPVD() { const context = {}; vm.runInNewContext(read("assets/app.discover.js"), context); return context.PVD; }
const PL = (pl) => pl;
const fare = (from, to, day, pricePln, airline = "RYANAIR") => ({ airline, from, to, day, departure: `${day}T10:15`, pricePln });
const dest = (over = {}) => ({ city: "Londyn Luton", country: "Wielka Brytania", code: "LTN", alsoAirports: ["STN"], flightPln: 238, groundPln: 9, totalPln: 247, days: 6, outbound: fare("RZE", "LTN", "2026-12-04", 119), ret: fare("LTN", "RZE", "2026-12-07", 119), weather: null, ...over });

test("a discovery card shows the stored price, both flights and the drive as an estimate", () => {
  const h = loadPVD().card(dest(), { t: PL });
  assert.match(h, /238 zł/);
  assert.match(h, /lot w obie strony/);
  assert.match(h, /RZE → LTN/);
  assert.match(h, /LTN → RZE/);
  assert.match(h, /także STN/);
  assert.match(h, /9 zł dojazd na lotnisko \(szacunek\)/);
  assert.match(h, /data-disc-plan="LTN"/);
});

test("weather only from a forecast; otherwise the day the forecast will exist, never a guess", () => {
  const PVD = loadPVD();
  assert.match(PVD.card(dest({ weather: { min: 4, max: 9, rainChance: 60, code: 61, days: 4 } }), { t: PL }), /4–9°C · deszcz 60%/);
  const later = PVD.card(dest({ weatherFrom: "2026-12-05" }), { t: PL });
  assert.match(later, /Prognoza od/);
  assert.doesNotMatch(later, /°C/);
  assert.doesNotMatch(PVD.card(dest(), { t: PL }), /°C|Prognoza/);
  assert.equal(PVD.sky(0)[0], "sun");
  assert.equal(PVD.sky(73)[0], "snowflake");
  assert.equal(PVD.sky(null), null);
});

test("the list says where prices come from, and explains an empty answer", () => {
  const PVD = loadPVD();
  const h = PVD.list({ destinations: [dest()], collectedAt: "2026-11-27T18:00:00Z" }, { t: PL });
  assert.match(h, /zapisanych wyszukiwań/);
  assert.match(h, /Open-Meteo/);
  assert.match(PVD.list({ destinations: [], nights: 3 }, { t: PL }), /tam i z powrotem/);
  assert.match(PVD.list({ destinations: [] }, { t: PL }), /Nie mamy zapisanych lotów/);
  assert.doesNotMatch(PVD.card(dest({ city: "<b>x</b>" }), { t: PL }), /<b>x<\/b>/);
});

test("the Kierunki panel offers the list and the map, and the list asks /api/discover", () => {
  assert.ok(html.indexOf("/assets/app.discover.js") > 0 && html.indexOf("/assets/app.discover.js") < html.indexOf("/assets/app.js"));
  assert.match(html, /data-disc-mode="list"/);
  assert.match(html, /data-disc-mode="map"/);
  assert.match(html, /id="discWhen"/);
  assert.match(html, /id="discNights"/);
  assert.match(app, /fetch\('\/api\/discover\?'/);
  assert.match(app, /if\(discApply\(\)\) return;/);
  // only the start point, rounded to about 1 km, leaves the browser
  assert.match(app, /toFixed\(2\)\},\$\{\(\+home\[1\]\)\.toFixed\(2\)/);
  assert.match(read("assets/app.sw.js"), /'\/assets\/app\.discover\.js'/);
});

test("5c: a typed wish becomes checked filters, in Polish and English", () => {
  const PVD = loadPVD(), C = ["Hiszpania", "Włochy", "Grecja", "Wielka Brytania"], o = { today: "2026-11-27", countries: C };
  const plain = (q) => JSON.parse(JSON.stringify(q));
  assert.deepEqual(plain(PVD.parseQuery("Hiszpania w lutym na weekend do 400 zł", o)), { maxPrice: 400, nights: 2, month: "2027-02", country: "Hiszpania", text: "" });
  assert.deepEqual(plain(PVD.parseQuery("we Włoszech w marcu na tydzień", o)), { nights: 7, month: "2027-03", country: "Włochy", text: "" });
  assert.deepEqual(plain(PVD.parseQuery("Rome in March for a week under 300", o)), { maxPrice: 300, nights: 7, month: "2027-03", text: "rome" });
  assert.equal(PVD.parseQuery("w grudniu", o).month, "2026-12"); // this year's month while it lasts
  assert.equal(PVD.parseQuery("w maju 5 dni", o).nights, 4);
  assert.equal(PVD.parseQuery("6 nocy", o).nights, 5); // clamped to the nearest stay the filter offers (shorter on a tie)
  assert.equal(PVD.parseQuery("Majorka", o).month, undefined); // "maj" only as a whole word
  assert.equal(PVD.parseQuery("do 5 zł", o).maxPrice, undefined); // out of range: ignored, not guessed
  assert.equal(PVD.parseQuery("w jedną stronę", o).nights, 0);
  const chips = PVD.queryChips(PVD.parseQuery("Grecja maj do 300 zł", o), PL);
  assert.match(chips, /do 300 zł/);
  assert.match(chips, /Grecja/);
});

test("5c: the wish is read in the browser; nothing is sent but the filters", () => {
  assert.match(app, /PVD\.parseQuery\(text,\{today:ymdOf\(0\), countries\}\)/);
  assert.doesNotMatch(read("assets/app.discover.js"), /fetch\(/);
});
