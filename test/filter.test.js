"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.resolve(__dirname, "../assets/app.js"), "utf8");
const start = source.indexOf("function matchesFilter(v){");
const end = source.indexOf("function renderMarkers(){");

function loadFilter(query, lines = []) {
  const context = {
    S: { focus: null, agency: "all", filter: "all", query },
    statusOf: () => "ok",
    focusLegOf: () => null,
    findRoutesByShort: (value) => lines.filter((line) => line.toLowerCase() === value),
  };
  vm.runInNewContext(source.slice(start, end), context);
  return context.matchesFilter;
}

const vehicles = [
  { short: "1", label: "2045", id: "2045", headsign: "Dworzec", plate: "", routeLong: "" },
  { short: "12", label: "2046", id: "2046", headsign: "Baranówka", plate: "", routeLong: "" },
  { short: "27", label: "1103", id: "1103", headsign: "Al. 1 Maja", plate: "", routeLong: "" },
  { short: "A", label: "3001", id: "3001", headsign: "Lotnisko", plate: "", routeLong: "" },
  { short: "4", label: "12", id: "12", headsign: "Aleja Rejtana", plate: "", routeLong: "" },
];
const search = (query, lines) => vehicles.filter(loadFilter(query, lines)).map((vehicle) => vehicle.short);

test("a one-digit search shows only that line, not every vehicle containing the digit", () => {
  assert.deepEqual(search("1"), ["1"]);
  assert.deepEqual(search("27"), ["27"]);
});

test("a short numeric search also finds an exact vehicle number", () => {
  assert.deepEqual(search("12"), ["12", "4"]);
});

test("a letter that names a line does not match words starting with it", () => {
  assert.deepEqual(search("a", ["A"]), ["A"]);
});

test("short text and long searches still match directions and vehicle numbers", () => {
  assert.deepEqual(search("dwo"), ["1"]);
  assert.deepEqual(search("baran"), ["12"]);
  assert.deepEqual(search("1103"), ["27"]);
});
