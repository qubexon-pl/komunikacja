"use strict";

// The list itself lives in assets/app.cities.js so the browser has it before the first page is drawn.
const CITIES = require("../assets/app.cities.js");

const BY_ID = new Map(CITIES.map((c) => [c.id, c]));
const cityById = (id) => BY_ID.get(String(id || "")) || null;
// What the browser needs: the list without anything server-only.
const publicCities = () => CITIES.map(({ id, name, centre, modes, live, operator }) => ({ id, name, centre, modes, live, operator: operator || "" }));

module.exports = { CITIES, cityById, publicCities };
