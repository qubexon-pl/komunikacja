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

test("each category has its own page and weather refreshes every 45 minutes", () => {
  assert.match(source, /ztm:\{path:'\/autobusy'/);
  assert.match(source, /pks:\{path:'\/pks'/);
  assert.match(source, /kolej:\{path:'\/pociagi'/);
  assert.match(source, /weatherTick\(\); \}, 45\*60\*1000\)/);
});
