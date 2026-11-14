"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { normalizeFavorites } = require("../src/favorites");


test("a saved trip keeps its own name, the places in between and deep step details", () => {
  const leg = { kind: "flight", snap: { access: { steps: [{ icon: "car", text: "Jedź", link: { href: "https://maps.example/x", label: "Mapy" } }] } } };
  const [trip] = normalizeFavorites([{ type: "trip", view: "podroz", id: "m:1", from: "Rzeszów", to: "Wrocław", name: "Lot + pociąg", title: "  Majówka nad morzem  ",
    stops: ["Szczecin", "", "Gdańsk", 5], trip: { multi: true, legs: [leg] } }]);
  assert.equal(trip.title, "Majówka nad morzem");
  assert.deepEqual(trip.stops, ["Szczecin", "Gdańsk"]);
  assert.equal(trip.trip.legs[0].snap.access.steps[0].link.href, "https://maps.example/x");
});
