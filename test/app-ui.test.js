"use strict";
// Phase 2c: shared sheets (assets/app.ui.js). The DOM behaviour is checked in a browser; here the pure parts.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
function loadPVUI(lang = "pl") {
  const context = { document: { documentElement: { lang } } };
  vm.runInNewContext(read("assets/app.ui.js"), context);
  return context.PVUI;
}

test("Tab and Shift+Tab wrap round inside the sheet", () => {
  const { nextFocus } = loadPVUI();
  assert.equal(nextFocus(0, 3, false), 1);
  assert.equal(nextFocus(2, 3, false), 0); // last → first
  assert.equal(nextFocus(0, 3, true), 2); // first → last
  assert.equal(nextFocus(-1, 3, false), 0); // focus outside → first
  assert.equal(nextFocus(-1, 3, true), 2);
  assert.equal(nextFocus(0, 0, false), -1);
});

test("a sheet is a labelled modal dialog with a close button and a focus trap marker", () => {
  const html = loadPVUI().sheetHtml({ id: "s1", title: "Koszty <podróży>", html: "<p>x</p>", size: "lg" });
  assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="s1-title"/);
  assert.match(html, /<h2 class="pv-sheet-title" id="s1-title">Koszty &lt;podróży&gt;<\/h2>/);
  assert.match(html, /class="pv-sheet pv-sheet-lg"/);
  assert.match(html, /data-pv-trap/);
  assert.match(html, /data-pv-close aria-label="Zamknij"/);
  assert.match(html, /<div class="pv-sheet-body"><p>x<\/p><\/div>/);
});

test("unknown sizes fall back to the standard sheet, and English labels follow the page language", () => {
  const html = loadPVUI("en").sheetHtml({ id: "s2", title: "Costs", size: "huge" });
  assert.match(html, /class="pv-sheet pv-sheet-md"/);
  assert.match(html, /aria-label="Close"/);
  assert.doesNotMatch(html, /pv-sheet-foot/);
});

test("the module loads before app.js so Back closes a sheet before the page router sees it", () => {
  const html = read("index.html");
  assert.ok(html.indexOf("/assets/app.ui.js") > 0 && html.indexOf("/assets/app.ui.js") < html.indexOf("/assets/app.js"));
  assert.match(read("assets/app.sw.js"), /'\/assets\/app\.ui\.js'/);
  const ui = read("assets/app.ui.js");
  assert.match(ui, /addEventListener\('popstate'[\s\S]*stopImmediatePropagation/);
});

test("the trip page sheets use the shared Back, scroll and focus behaviour", () => {
  const js = read("assets/app.js");
  assert.match(js, /class="tp-sheet tp-sheet-\$\{TRIPV\.sheet\}"[^>]*data-pv-trap/);
  assert.match(js, /PVUI\.layer\.enter\('trip'/);
  assert.match(js, /PVUI\.layer\.leave\('trip'\)/);
});

test("the stepper marks done, current and later steps, and disables steps not reached yet", () => {
  const steps = [{ label: "Loty", info: "RZE 06:25" }, { label: "Dojazd na lotnisko", info: "Autobus 0A" }, { label: "Na miejscu" }, { label: "Plan podróży" }];
  const html = loadPVUI().stepper(steps, 2, { attr: "data-flight-step" });
  assert.match(html, /<nav class="pv-stepper" aria-label="Kroki planowania">/);
  assert.match(html, /--pv-steps:4/);
  assert.match(html, /class="pv-step done"><button type="button" data-flight-step="1" aria-current="false">/);
  assert.match(html, /class="pv-step on"><button type="button" data-flight-step="2" aria-current="step">/);
  assert.match(html, /data-flight-step="3" disabled/);
  assert.match(html, /<span class="pv-sr">Krok 1 z 4, gotowe: <\/span>/);
  assert.match(html, /<p class="pv-step-now" aria-hidden="true"><span>Krok 2 z 4<\/span> · <b>Dojazd na lotnisko<\/b> · Autobus 0A<\/p>/);
  assert.doesNotMatch(html, /Na miejscu<\/span><small>/); // no info for steps not reached
});

test("a later step can be enabled, labels are escaped and the current step is clamped", () => {
  const html = loadPVUI("en").stepper([{ label: "Connection" }, { label: "Save <trip>", enabled: true }], 9, { attr: "data-ground-step" });
  assert.match(html, /data-ground-step="2" aria-current="step"/);
  assert.match(html, /Save &lt;trip&gt;/);
  assert.match(html, /Step 2 of 2/);
});

test("both planner step bars use the shared stepper", () => {
  const js = read("assets/app.js");
  assert.match(js, /function stepBar\(P, f\)\{[\s\S]*?PVUI\.stepper\(steps, cur, \{attr:'data-flight-step'/);
  assert.match(js, /function groundStepBar\(P\)\{[\s\S]*?PVUI\.stepper\(steps, cur, \{attr:'data-ground-step'\}/);
});

test("the planner's journey line keeps details out of the page and opens them in a sheet", () => {
  const js = read("assets/app.js");
  const fn = js.slice(js.indexOf("function journeyLine("), js.indexOf("function compareHtml("));
  assert.doesNotMatch(fn, /jl-details|jl-panel/); // no inline detail column any more
  assert.match(fn, /JL_DETAIL\.set\(k, \{title, sub, detail\}\)/);
  assert.match(fn, /aria-haspopup="dialog"/);
  assert.match(js, /function openJourneyDetail\(k\)\{[\s\S]*?PVUI\.sheet\.open\(/);
  assert.match(js, /closest\('\[data-jl\]'\); if\(jl\)\{ openJourneyDetail\(jl\.dataset\.jl\)/);
});

test("cost breakdowns, price assumptions, baggage and the route step by step open in a sheet", () => {
  const js = read("assets/app.js");
  const between = (a, b) => js.slice(js.indexOf(a), js.indexOf(b, js.indexOf(a)));
  // the shared button keeps its content ready and opens it in PVUI.sheet; the planner's click handler opens it
  assert.match(between("function infoButton(", "function openInfo("), /data-pv-info="\$\{k\}" aria-haspopup="dialog"/);
  assert.match(between("function openInfo(", "function journeyLine("), /PVUI\.sheet\.open\(/);
  assert.match(js, /closest\('\[data-pv-info\]'\); if\(inf\)\{ openInfo\(inf\.dataset\.pvInfo\)/);
  // a map or flight button inside a sheet closes it first, then opens the map or flight window
  assert.match(between("function wireSheet(", "const INFO="), /\[data-route\][\s\S]*h\.close\(\); openTripMap/);
  // step 2: fuel and ticket assumptions are no longer printed under the table; the route is behind a button
  const cmp = between("function compareHtml(", "const MODE_OF_ICON");
  assert.doesNotMatch(cmp, /<small>Samochód: koszt paliwa/);
  assert.match(cmp, /infoButton\('Jak liczymy koszt dojazdu'/);
  const acc = between("function accessDetails(", "/* ---------- Z lotniska");
  assert.doesNotMatch(acc, /\$\{o\.steps\?\.length\?stepsHtml\(o\.steps\):''\}\s*\$\{o\.back/); // no inline step list
  assert.match(acc, /infoButton\('Trasa krok po kroku'/);
  // step 4: the total and the per-person price stay; the rows go to "Szczegóły kosztów"
  assert.match(js, /<div class="plan-extra">\$\{costSummary\(tripCosts\(P,offer\)\)\}/);
  assert.match(between("function costSummary(", "/* ---------- Pogoda"), /infoButton\('Szczegóły kosztów'[\s\S]*costCard\(c,\{head:false\}\)/);
  // flight cards: no per-mode price list on the card, a "Rozbicie ceny" button with the baggage note instead
  assert.doesNotMatch(between("function flightPlanCard(", "function alertButton("), /priceSplit\(P,f\)/);
  assert.doesNotMatch(between("function planSummaryCard(", "function flightNote("), /priceSplit\(P,f\)/);
  assert.match(between("function priceInfo(", "function priceHeadline("), /priceSplit\(P,f\)[\s\S]*BAGGAGE_NOTE/);
});

test("the trip page's own cost sheet still shows every cost row", () => {
  const js = read("assets/app.js");
  assert.match(js, /if\(k==='cost'\) return costCard\(costs\);/);
});
