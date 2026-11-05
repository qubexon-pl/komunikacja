"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.resolve(__dirname, "../assets/app.js"), "utf8");

function loadTrainPlanner(trains) {
  const context = { TR: { trains }, railName: (id) => id };
  const start = source.indexOf("function planTrainTrips(");
  vm.runInNewContext(source.slice(start, source.indexOf("function renderTrainPlan(")), context);
  return context.planTrainTrips;
}

const stop = (id, predDep, predArr = predDep) => ({ id, predDep, predArr, cn: false });
const train = (key, stops, extra = {}) => ({ key, stops, cancelled: false, ...extra });

test("the train planner lists direct trains in departure order", () => {
  const plan = loadTrainPlanner([
    train("later", [stop("A", 2000), stop("B", 2600)]),
    train("sooner", [stop("A", 1500), stop("C", 1800), stop("B", 2100)]),
  ]);
  assert.deepEqual(Array.from(plan("A", "B", 1000), (result) => result.t.key), ["sooner", "later"]);
});

test("the train planner respects direction, departure time, and cancellations", () => {
  const plan = loadTrainPlanner([
    train("wrong-way", [stop("B", 1500), stop("A", 1800)]),
    train("gone", [stop("A", 100), stop("B", 400)]),
    train("too-far", [stop("A", 1000 + 7 * 3600), stop("B", 1000 + 8 * 3600)]),
    train("cancelled", [stop("A", 1500), stop("B", 1800)], { cancelled: true }),
    train("stop-cancelled", [{ ...stop("A", 1500), cn: true }, stop("B", 1800)]),
    train("ok", [stop("A", 1600), stop("B", 1900)]),
  ]);
  assert.deepEqual(Array.from(plan("A", "B", 1000), (result) => result.t.key), ["ok"]);
});

function loadPaging() {
  const context = {};
  vm.runInNewContext(source.slice(source.indexOf("function paginate("), source.indexOf("function pagerHtml(")), context);
  return context;
}

test("timetable pages split rows and stay in range", () => {
  const { paginate } = loadPaging();
  const rows = Array.from({ length: 45 }, (_, index) => index);
  const middle = paginate(rows, 2, 20);
  assert.deepEqual([middle.page, middle.pages, middle.total, middle.rows.length, middle.rows[0]], [2, 3, 45, 20, 20]);
  assert.equal(paginate(rows, 99, 20).page, 3);
  assert.equal(paginate(rows, 99, 20).rows.length, 5);
  assert.equal(paginate(rows, 0, 20).page, 1);
  assert.deepEqual([paginate([], 1, 20).pages, paginate([], 1, 20).rows.length], [1, 0]);
});

test("the timetable opens on the page with the next departure", () => {
  const { pageOfNow } = loadPaging();
  const times = Array.from({ length: 45 }, (_, index) => index * 10);
  const same = (value) => value;
  assert.equal(pageOfNow(times, 20, same, 0), 1);
  assert.equal(pageOfNow(times, 20, same, 185), 1);
  assert.equal(pageOfNow(times, 20, same, 195), 2);
  assert.equal(pageOfNow(times, 20, same, 9999), 3);
  assert.equal(pageOfNow([], 20, same, 0), 1);
});

function loadTermini() {
  const context = {};
  const start = source.indexOf("const TERM_MIN_SHARE=");
  vm.runInNewContext(`${source.slice(start, source.indexOf("function busTermini("))}; this.collectTermini = collectTermini; this.terminalName = terminalName;`, context);
  return context;
}
const tripsTo = (route, dir, last, count) => Array.from({ length: count }, () => ({ route, dir, last }));
const plain = (value) => JSON.parse(JSON.stringify(value));

test("platform numbers are removed from a terminus name", () => {
  const { terminalName } = loadTermini();
  assert.equal(terminalName("Dworzec Główny PKP 03"), "Dworzec Główny PKP");
  assert.equal(terminalName("Lubelska Zajezdnia MPK"), "Lubelska Zajezdnia MPK");
  assert.equal(terminalName("Osiedle 1000-lecia"), "Osiedle 1000-lecia");
});

test("platforms of one terminus are merged and share its lines", () => {
  const { collectTermini } = loadTermini();
  const result = collectTermini([...tripsTo("1", "d0", "Dworzec 01", 10), ...tripsTo("2", "d0", "Dworzec 03", 10)]);
  assert.deepEqual(plain(result), [{ name: "Dworzec", routes: ["1", "2"], stops: ["Dworzec 01", "Dworzec 03"] }]);
});

test("rare trips to a depot do not create a terminus, but real variants do", () => {
  const { collectTermini } = loadTermini();
  const result = collectTermini([
    ...tripsTo("1", "d0", "Pętla", 40),
    ...tripsTo("1", "d0", "Zajezdnia", 2),
    ...tripsTo("1", "d0", "Pętla skrócona", 10),
    ...tripsTo("1", "d1", "Dworzec", 5),
  ]);
  assert.deepEqual(Array.from(result, (terminus) => terminus.name).sort(), ["Dworzec", "Pętla", "Pętla skrócona"]);
});

test("each category has its own page and weather refreshes every 45 minutes", () => {
  assert.match(source, /ztm:\{path:'\/autobusy'/);
  assert.match(source, /pks:\{path:'\/pks'/);
  assert.match(source, /kolej:\{path:'\/pociagi'/);
  assert.match(source, /koncowe:\{path:'\/koncowe'/);
  assert.match(source, /weatherTick\(\); \}, 45\*60\*1000\)/);
});
