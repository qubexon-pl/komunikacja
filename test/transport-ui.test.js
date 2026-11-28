"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const read = (file) => fs.readFileSync(path.resolve(__dirname, "..", file), "utf8");
const html = read("index.html");
const app = read("assets/app.js");

function loadPVT() {
  const context = {};
  vm.runInNewContext(read("assets/app.transport.js"), context);
  return context.PVT;
}
const EN = (pl, en) => en;

// A trip in the shape src/transitous.js `itinerary` returns.
const trip = (over = {}) => ({
  dep: { clock: "09:18" }, arr: { clock: "09:52" }, minutes: 34, transfers: 1, walkMin: 5,
  steps: [
    { kind: "walk", minutes: 3, from: "Start", to: "Pl. Wolności", dep: "09:18", arr: "09:21" },
    { kind: "bus", line: "0A", from: "Pl. Wolności", to: "Dworzec Główny PKP", dep: "09:21", arr: "09:43", minutes: 22, stops: 7, headsign: "Dworzec", agency: "ZTM", live: false, delayMin: 0 },
    { kind: "walk", minutes: 2, from: "Dworzec Główny PKP", to: "Rzeszów Główny", dep: "09:43", arr: "09:45" },
    { kind: "rail", line: "IC 37004", from: "Rzeszów Główny", to: "Kraków Główny", dep: "09:48", arr: "09:52", minutes: 4, live: true, delayMin: 3 },
  ],
  shape: [],
  ...over,
});

test("the page loads the transport module and stylesheet before app.js, and the service worker caches them", () => {
  assert.ok(html.indexOf("/assets/app.transport.js") > 0 && html.indexOf("/assets/app.transport.js") < html.indexOf("/assets/app.js"));
  assert.ok(html.indexOf("/assets/app.transport.css") > html.indexOf("/assets/app.mobile.css"));
  const sw = read("assets/app.sw.js");
  assert.match(sw, /'\/assets\/app\.transport\.js'/);
  assert.match(sw, /'\/assets\/app\.transport\.css'/);
});

test("the timeline adds a transfer with the real time between rides and ends at the destination", () => {
  const P = loadPVT();
  const ev = P.stepsToEvents(trip().steps, EN);
  assert.deepEqual([...ev.map((e) => e.kind)], ["walk", "bus", "walk", "transfer", "rail", "arrive"]);
  assert.equal(ev[3].place, "5 min to change"); // 09:43 off the bus, 09:48 train
  assert.equal(ev.at(-1).time, "09:52");
  assert.equal(ev.at(-1).title, "Kraków Główny");
  assert.equal(P.clockGap("23:50", "00:10"), 20);
});

test("only legs with an operator prediction are shown as live; the rest say scheduled", () => {
  const P = loadPVT();
  const [, bus, , rail] = trip().steps;
  assert.equal(P.legStatus(bus, EN).state, "scheduled");
  assert.equal(P.legStatus(rail, EN).state, "late");
  assert.equal(P.legStatus(rail, EN).text, "+3 min");
  assert.equal(P.legStatus({ kind: "walk" }), null);
  // The trip's state is the first ride's: here the bus has no live data, so the card must not claim live.
  const card = P.routeCard(trip(), 0, { t: EN });
  assert.match(card, /pvt-rt scheduled[^>]*>.*scheduled/s);
  assert.equal(P.tripStatus(trip(), EN).state, "scheduled");
  const onTime = trip({ steps: [{ kind: "tram", line: "3", dep: "10:00", arr: "10:10", live: true, delayMin: 0 }] });
  assert.equal(P.tripStatus(onTime, EN).text, "on time");
});

test("the route card shows the summary collapsed, the timeline on demand, and no invented price or platform", () => {
  const P = loadPVT();
  const card = P.routeCard(trip(), 2, { t: EN, selected: true, fastest: true, canSave: true, navUrl: "https://www.google.com/maps/dir/?api=1" });
  assert.match(card, /data-cp-trip="2" aria-pressed="true"/);
  assert.match(card, /34 min/);
  assert.match(card, /09:18 – 09:52/);
  assert.match(card, /1 transfer · 5 min walk/);
  assert.match(card, /Fastest/);
  assert.match(card, /<details class="tr-more" data-cp-more="2">/);
  assert.match(card, /data-cp-show="2"/);
  assert.match(card, /data-cp-save="2"/);
  assert.doesNotMatch(card, /tr-price|zł|jt-plat/);
  assert.doesNotMatch(P.routeCard(trip(), 0, { t: EN }), /data-cp-save/);
  assert.match(P.routeCard(trip(), 0, { t: EN, open: true }), /data-cp-more="0" open/);
});

test("stop names and line labels from the data are escaped", () => {
  const P = loadPVT();
  const bad = trip({ steps: [{ kind: "bus", line: "<b>1</b>", from: "A & B", to: '"><img src=x>', dep: "10:00", arr: "10:05", minutes: 5 }] });
  const out = P.routeCard(bad, 0, { t: EN }) + P.mapSummary(bad, 0, { t: EN });
  assert.doesNotMatch(out, /<img|<b>1<\/b>/);
  assert.match(out, /&lt;b&gt;1&lt;\/b&gt;/);
  assert.match(out, /A &amp; B/);
});

test("the map summary names the selected route and links back to its details", () => {
  const P = loadPVT();
  const out = P.mapSummary(trip(), 1, { t: EN });
  assert.match(out, /Selected route · 34 min/);
  assert.match(out, /data-cp-detail="1"/);
  assert.match(out, /IC 37004/);
  assert.equal(P.mapSummary(null, 0), "");
});

test("the freshness line names the source and the time the data was fetched", () => {
  const P = loadPVT();
  const out = P.freshness(Date.UTC(2026, 10, 26, 8, 5), "Europe/Warsaw", "Transitous", EN);
  assert.match(out, /Transitous · as of 09:05/);
  assert.match(P.freshness(NaN, "", "Transitous", EN), /Transitous<\/small>/);
});

test("app.js renders step-by-step lists and city results through the shared transport module", () => {
  assert.match(app, /function csSteps\(steps\)\{ return PVT\.journeyTimeline\(PVT\.stepsToEvents\(steps, L2\)/);
  assert.match(app, /PVT\.routeCard\(t,i,/);
  assert.match(app, /PVT\.mapSummary\(/);
  for (const hook of ["data-cp-show", "data-cp-detail", "data-cp-map-close", "data-cp-here"]) assert.ok(app.includes(hook), hook);
});

test("departure board: delays only for live departures, platforms for trains, cancelled struck out, line filter", () => {
  const PVT = loadPVT(), now = Date.parse("2026-12-01T08:00:00Z");
  const dep = (o) => ({ line: "4", headsign: "Bronowice", mode: "tram", scheduled: "2026-12-01T09:10", expected: "2026-12-01T09:10", at: now + 10 * 60000, delayMin: 0, realtime: "scheduled", platform: "", cancelled: false, ...o });
  const board = PVT.departureBoard([
    dep({}),
    dep({ line: "8", realtime: "live", delayMin: 3, expected: "2026-12-01T09:13" }),
    dep({ line: "R 33100", mode: "rail", platform: "2", track: "4", realtime: "live", delayMin: 0 }),
    dep({ line: "52", cancelled: true }),
  ], { now, t: EN });
  const rows = board.split("<li").slice(1);
  assert.doesNotMatch(rows[0], /ctx-st/); // scheduled: no delay, no "on time"
  assert.match(rows[1], /<b>09:13<\/b> <s>09:10<\/s>/);
  assert.match(rows[1], /\+3 min/);
  assert.match(rows[2], /platform 2 · track 4/);
  assert.match(rows[2], /on time/);
  assert.match(rows[3], /<s>09:10<\/s>/);
  assert.match(rows[3], /cancelled/);
  assert.equal(PVT.departureBoard([dep({}), dep({ line: "8" })], { now, line: "8" }).split("<li").length - 1, 1);
  assert.match(PVT.departureBoard([], { t: EN, empty: "Nothing" }), /empty-note">Nothing/);
  assert.match(PVT.departureBoard([dep({ headsign: "<b>x</b>" })], { now }), /&lt;b&gt;x&lt;\/b&gt;/);
});

test("a board row can open something and carry a star; past rows are dimmed without a countdown", () => {
  const PVT = loadPVT(), now = Date.parse("2026-12-01T08:00:00Z");
  const dep = (o) => ({ line: "18", headsign: "Dworzec", mode: "bus", scheduled: "0000-00-00T09:10", expected: "0000-00-00T09:10", at: now + 10 * 60000, realtime: "scheduled", color: "#C41E3A", textColor: "#fff", route: "r18", ...o });
  const board = PVT.departureBoard([dep({ at: now - 5 * 60000 }), dep({})], { now, t: EN, open: (x) => ["data-route", x.route], after: () => '<button class="star">*</button>' });
  const rows = board.split("<li").slice(1);
  assert.match(rows[0], /class="past has-open"/);
  assert.doesNotMatch(rows[0], /now|min</);
  assert.match(rows[1], /<button type="button" class="ctx-dep-open" data-route="r18">/);
  assert.match(rows[1], /10 min/);
  assert.match(rows[1], /<\/button><button class="star">\*<\/button><\/li>/);
  assert.doesNotMatch(PVT.departureBoard([dep({})], { now }), /has-open/); // without options the row stays as before
});

test("the Rzeszów stop board draws the shared board from the browser timetable", () => {
  assert.match(app, /PVT\.departureBoard\(deps, \{t:L2, now:TT\.day===0\?now\*1000:0, open:x=>\['data-route',x\.route\], after:x=>lineStar\(x\.route\)\}\)/);
  assert.match(app, /realtime:'scheduled'/);
});

test("the city stop board reads the shared departures endpoint and draws the shared board", () => {
  assert.match(app, /fetch\('\/api\/transport\/departures\?'\+new URLSearchParams\(\{\.\.\.q, limit:'50'\}\)\)/);
  assert.match(app, /const q=\{provider:'transitous', stop:stop\.id\}/);
  assert.match(app, /PVT\.departureBoard\(list, \{t:L2, now, line:CTX\.line/);
});
