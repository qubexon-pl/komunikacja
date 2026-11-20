"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createAirportTransfers, faresFromCsv, FARES_FILE } = require("../src/airport-transfers");
const { createCityTransit, clip } = require("../src/city-transit");
const { decodePolyline } = require("../src/transitous");
const { textOptions } = require("../src/airport-text");

const leg = (mode, line, agency, from, to, start, end, extra = {}) => ({ mode, displayName: line, agencyName: agency, from: { name: from, lat: 41.3, lon: 2.07 }, to: { name: to }, startTime: start, endTime: end, ...extra });
const walk = (start, end) => ({ mode: "WALK", duration: (Date.parse(end) - Date.parse(start)) / 1000, startTime: start, endTime: end, from: { name: "" }, to: { name: "" } });
const it = (legs) => ({ startTime: legs[0].startTime, endTime: legs.at(-1).endTime, legs });

test("the reviewed fares file parses, with a taxi price for every airport it covers", () => {
  const fares = faresFromCsv(fs.readFileSync(FARES_FILE, "utf8"));
  assert.ok(fares.length >= 30);
  const codes = new Set(fares.map((f) => f.code));
  for (const code of codes) assert.ok(fares.some((f) => f.code === code && f.match === "^taxi$"), `${code} has a taxi row`);
  assert.equal(fares.find((f) => f.code === "BCN" && /Aerob/.test(f.option)).fareEur, 7.25);
});

test("every way into town is listed once, from the terminal, with its departures, fare in PLN and a taxi", async () => {
  const asked = [];
  const answers = {
    any: [it([walk("2026-11-20T11:00:00Z", "2026-11-20T11:02:00Z"), leg("BUS", "A2", "Monbus (Aerobús)", "Aeroport T2B", "Pl. Catalunya", "2026-11-20T11:05:00Z", "2026-11-20T11:40:00Z")]),
      it([leg("BUS", "A2", "Monbus (Aerobús)", "Aeroport T2B", "Pl. Catalunya", "2026-11-20T11:15:00Z", "2026-11-20T11:50:00Z")])],
    RAIL: [it([walk("2026-11-20T10:58:00Z", "2026-11-20T11:06:00Z"), leg("REGIONAL_RAIL", "R2N", "Renfe Cercanias", "El Prat Aeroport", "Passeig de Gràcia", "2026-11-20T11:08:00Z", "2026-11-20T11:35:00Z")])],
    "BUS,COACH": [it([leg("BUS", "46", "TMB", "Aeroport T2", "Pl. Espanya", "2026-11-20T11:03:00Z", "2026-11-20T11:45:00Z")])],
  };
  const transitous = { plan: async (p) => { asked.push(p); return { itineraries: answers[p.transitModes || "any"] }; } };
  const geocode = async () => ({ places: [{ points: [[41.3826, 2.1771]] }] });
  const drive = async () => ({ km: 16, minutes: 22 });
  const t = createAirportTransfers({ transitous, geocode, drive, toPln: async (eur) => eur * 4.25 });
  const r = await t.options({ code: "BCN", time: "2026-11-20T11:55" });
  assert.equal(asked.length, 3);
  assert.equal(asked[0].fromPlace, "41.30331,2.07690"); // the terminal pickup point, not the middle of the airport
  assert.equal(asked[0].time, "2026-11-20T11:00:00.000Z"); // 11:55 local + 30 min, down to the half hour, in UTC
  assert.equal(r.target.centre, true);
  const by = Object.fromEntries(r.options.filter((o) => o.timetable || o.kind === "taxi").map((o) => [o.line, o]));
  assert.deepEqual(Object.keys(by).sort(), ["46", "A2", "R2N", "Taxi"]);
  // Metro L9 is in the reviewed prices but not in this timetable answer: listed anyway, with its typical time and price.
  const metro = r.options.find((o) => o.name === "Metro L9 Sud");
  assert.equal(metro.timetable, false);
  assert.equal(metro.minutes, 50);
  assert.equal(metro.fare.eur, 5.5);
  assert.equal(r.options.filter((o) => !o.timetable && o.kind !== "taxi").length, 1); // "metro L9" from the airport list is the same one
  assert.deepEqual(by.A2.departures, ["12:05", "12:15"]);
  assert.equal(by.A2.name, "Aerobús A1 / A2");
  assert.equal(by.A2.fare.pln, 31);
  assert.equal(by.R2N.board.name, "El Prat Aeroport");
  assert.equal(by.R2N.board.walkMin, 8);
  assert.equal(by["46"].fare.eur, 2.65);
  assert.equal(by.Taxi.minutes, 27);
  assert.equal(by.Taxi.fare.eur, 38);
  await t.options({ code: "BCN", time: "2026-11-20T11:58" }); // same half hour: the kept answer
  assert.equal(asked.length, 3);
});

test("the airport list's words become separate options with their own prices", () => {
  const parts = textOptions({ route: "Arlanda Express ~18 min; SL commuter train (cheaper)", fare: "SEK 129 coach / SEK 340 Arlanda Express", mode: "rail" });
  assert.deepEqual(parts.map((p) => [p.kind, p.name, p.minutes, p.prices.map((q) => `${q.currency} ${q.amount}`)]), [
    ["rail", "Arlanda Express", 18, ["SEK 340"]], ["rail", "SL commuter train", null, []], ["bus", "Coach", null, ["SEK 129"]],
  ]);
  const stn = textOptions({ route: "Stansted Express to Liverpool Street ~50 min", fare: "GBP 19-25 walk-up Stansted Express (GBP 9.90 if booked ahead; coach from GBP 7)", mode: "rail" });
  assert.deepEqual(stn.map((p) => [p.name, p.prices.map((q) => q.amount)]), [["Stansted Express to Liverpool Street", [19, 9.9]], ["Coach", [7]]]);
  const dub = textOptions({ route: "Dublin Express/Aircoach ~30 min; Dublin Bus 16/41 cheaper", fare: "EUR 2 TFI bus / EUR 8-10 Dublin Express", mode: "bus" });
  assert.deepEqual(dub.map((p) => [p.kind, p.prices.map((q) => q.amount)]), [["bus", [8]], ["bus", [2]]]);
  assert.equal(textOptions({ route: "100E airport express bus ~35 min", fare: "HUF 2,500 100E", mode: "bus" })[0].prices[0].amount, 2500);
});

test("Arlanda Express, missing from open timetables, is still offered with its price and time", async () => {
  const transitous = { plan: async () => ({ itineraries: [it([leg("REGIONAL_RAIL", "41", "SL", "Arlanda C", "Stockholm City", "2026-11-20T11:44:00Z", "2026-11-20T12:30:00Z")])] }) };
  const t = createAirportTransfers({ transitous, geocode: async () => ({ places: [{ points: [[59.3303, 18.0586]] }] }), toPln: async (v, cur) => v * ({ SEK: 0.39, EUR: 4.25 }[cur]) });
  const r = await t.options({ code: "ARN", time: "2026-11-20T12:00" });
  const ax = r.options.find((o) => o.name === "Arlanda Express");
  assert.equal(ax.timetable, false);
  assert.equal(ax.minutes, 18);
  assert.equal(ax.fare.pln, 128);
  assert.equal(r.options.find((o) => o.timetable).name, "SL commuter train (pendeltåg)");
  assert.ok(r.options.some((o) => o.name === "Flygbussarna coach"));
  assert.equal(r.options.filter((o) => /coach/i.test(o.name)).length, 1);
});

test("a city journey is planned at the local time of the destination and kept for a while", async () => {
  const asked = [];
  const transitous = { plan: async (p) => { asked.push(p); return { itineraries: [it([leg("SUBWAY", "L3", "TMB", "Catalunya", "Lesseps", "2026-11-20T11:04:00Z", "2026-11-20T11:16:00Z", { legGeometry: { points: "_p~iF~ps|U_ulLnnqC", precision: 5 } })])], direct: [] }; } };
  const city = createCityTransit({ transitous });
  const q = { from: "41.387,2.170", to: "41.414,2.152", time: "2026-11-20T12:00", zone: "Europe/Madrid" };
  const r = await city.plan(q);
  assert.equal(asked[0].time, "2026-11-20T11:00:00.000Z");
  assert.equal(r.trips[0].dep.clock, "12:04");
  assert.equal(r.trips[0].steps[0].line, "L3");
  assert.equal(r.trips[0].shape[0].points.length, 2);
  await city.plan(q);
  assert.equal(asked.length, 1);
  await assert.rejects(city.plan({ ...q, zone: "Mars/Base" }), { status: 400 });
  await assert.rejects(city.plan({ ...q, from: "x" }), { status: 400 });
});

test("vehicles are asked for a snapped area once a minute and sent as timed positions; wide views are refused", async () => {
  let asked = 0;
  const t0 = Date.parse("2026-11-20T11:00:00Z");
  const transitous = { mapTrips: async () => { asked++; return [{ trips: [{ tripId: "t1", routeShortName: "46" }], mode: "BUS", routeColor: "", from: { name: "A" }, to: { name: "B" },
    departure: "2026-11-20T11:00:00Z", arrival: "2026-11-20T11:02:00Z", scheduledDeparture: "2026-11-20T10:59:00Z", realTime: true, polyline: "_p~iF~ps|U_ulLnnqC" }]; } };
  const city = createCityTransit({ transitous, now: () => t0 + 5000 });
  const r = await city.vehicles({ min: "41.37,2.14", max: "41.40,2.19", zoom: "14" });
  assert.equal(asked, 1);
  assert.equal(r.vehicles.length, 1);
  assert.equal(r.vehicles[0].line, "46");
  assert.equal(r.vehicles[0].delayMin, 1);
  assert.equal(r.vehicles[0].t1, t0 + 120000);
  await city.vehicles({ min: "41.371,2.141", max: "41.399,2.189", zoom: "14" }); // a slightly moved view shares the answer
  assert.equal(asked, 1);
  assert.deepEqual(await city.vehicles({ min: "41.0,1.8", max: "41.6,2.5", zoom: "14" }), { vehicles: [], tooWide: true });
  assert.deepEqual(await city.vehicles({ min: "41.37,2.14", max: "41.40,2.19", zoom: "10" }), { vehicles: [], tooWide: true });
  assert.equal(asked, 1);
});

test("a ride is cut to the asked minutes along its line", () => {
  const line = decodePolyline("_p~iF~ps|U_ulLnnqC", 5);
  assert.deepEqual(line, [[38.5, -120.2], [40.7, -120.95]]);
  const part = clip([[0, 0], [0, 1]], 0, 100000, 50000, 200000);
  assert.equal(part.t0, 50000);
  assert.equal(part.t1, 100000);
  assert.deepEqual(part.path[0], [0, 0.5]);
  assert.deepEqual(part.path.at(-1), [0, 1]);
});

test("when the address search fails, the city centre comes from Transitous and is then kept", async () => {
  let geocoded = 0, transitousAsked = 0, planned = 0;
  const transitous = {
    geocode: async (q) => { transitousAsked++; assert.equal(q.text, "Stockholm"); return [{ type: "STOP", name: "Far", lat: 10, lon: 10 }, { type: "PLACE", name: "Stockholm", lat: 59.3251, lon: 18.0711 }]; },
    plan: async () => { planned++; return { itineraries: [] }; },
  };
  const geocode = async () => { geocoded++; throw new Error("HTTP 429"); };
  const t = createAirportTransfers({ transitous, geocode });
  const r = await t.options({ code: "ARN", time: "2026-11-14T10:15" });
  assert.equal(r.target.label, "Stockholm");
  assert.equal(r.target.lat, 59.3251);
  assert.ok(r.options.some((o) => o.name === "Arlanda Express")); // the listed ways into town are there even without timetables
  await t.options({ code: "ARN", time: "2026-11-15T18:00" });
  assert.equal(geocoded, 1);
  assert.equal(transitousAsked, 1); // the centre is kept
  assert.ok(planned >= 3);
});

test("stops of a Polish city are searched near its centre, and stops in other cities are left out", async () => {
  const asked = [];
  const transitous = { geocode: async (q) => { asked.push(q); return [
    { type: "STOP", id: "pl-warszawa_7013", name: "Centrum", lat: 52.2306, lon: 21.0107 },
    { type: "STOP", id: "pl-warszawa_7014", name: "Centrum", lat: 52.2306, lon: 21.0107 }, // same stop twice: shown once
    { type: "STOP", id: "pl-lodz_1", name: "Centrum", lat: 51.7592, lon: 19.456 }, // Łódź, far away
    { type: "ADDRESS", id: "a", name: "Centralna", lat: 52.23, lon: 21.01 },
  ]; } };
  const city = createCityTransit({ transitous });
  const r = await city.stops({ city: "warszawa", q: "Centrum" });
  assert.equal(asked[0].type, "STOP");
  assert.equal(asked[0].place, "52.2297,21.0122");
  assert.deepEqual(r.stops.map((s) => s.id), ["pl-warszawa_7013"]);
  await city.stops({ city: "warszawa", q: "centrum " }); // the same words again: the kept answer
  assert.equal(asked.length, 1);
  assert.deepEqual(await city.stops({ city: "warszawa", q: "C" }), { stops: [] });
  await assert.rejects(city.stops({ city: "atlantyda", q: "Centrum" }), { status: 400 });
});

test("departures from a stop are in Polish local time, with live delays and cancellations", async () => {
  const asked = [];
  const t0 = Date.parse("2026-11-20T11:00:00Z");
  const transitous = { stopTimes: async (q) => { asked.push(q); return { place: { name: "Centrum" }, stopTimes: [
    { mode: "TRAM", displayName: "25", headsign: "Banacha", routeColor: "C2185B", realTime: true, place: { departure: "2026-11-20T11:07:00Z", scheduledDeparture: "2026-11-20T11:04:00Z", track: "08" } },
    { mode: "BUS", routeShortName: "175", headsign: "Lotnisko Chopina", realTime: false, place: { departure: "2026-11-20T11:02:00Z", scheduledDeparture: "2026-11-20T11:02:00Z" } },
    { mode: "SUBWAY", displayName: "M1", headsign: "Kabaty", realTime: true, cancelled: true, place: { departure: "2026-11-20T11:10:00Z", scheduledDeparture: "2026-11-20T11:10:00Z" } },
  ] }; } };
  const city = createCityTransit({ transitous, now: () => t0 });
  const r = await city.departures({ stop: "pl-warszawa_7013" });
  assert.equal(asked[0].stopId, "pl-warszawa_7013");
  assert.equal(asked[0].time, "2026-11-20T11:00:00.000Z");
  assert.deepEqual(r.departures.map((d) => [d.line, d.kind, d.clock, d.planned, d.delayMin, d.live, d.cancelled]), [
    ["175", "bus", "12:02", "12:02", 0, false, false],
    ["25", "tram", "12:07", "12:04", 3, true, false],
    ["M1", "metro", "12:10", "12:10", 0, true, true],
  ]);
  assert.equal(r.departures[1].color, "#C2185B");
  assert.equal(r.departures[1].platform, "08");
  assert.equal(r.stop.name, "Centrum");
  await city.departures({ stop: "pl-warszawa_7013" });
  assert.equal(asked.length, 1); // kept for 30 s
  await assert.rejects(city.departures({ stop: "" }), { status: 400 });
  await assert.rejects(city.departures({ stop: "x", time: "jutro" }), { status: 400 });
});

test("every Polish city has a centre, a search radius and what runs there", () => {
  const { CITIES, publicCities } = require("../src/pl-cities");
  assert.ok(CITIES.length >= 30);
  assert.equal(new Set(CITIES.map((c) => c.id)).size, CITIES.length);
  assert.equal(new Set(CITIES.map((c) => c.name)).size, CITIES.length);
  for (const c of CITIES) {
    assert.ok(c.centre[0] > 49 && c.centre[0] < 55 && c.centre[1] > 14 && c.centre[1] < 24.2, c.name);
    assert.ok(c.km >= 5 && c.km <= 40, c.name);
    assert.ok(c.modes.length && c.modes.every((m) => ["metro", "tram", "bus", "trolleybus", "rail"].includes(m)), c.name);
  }
  assert.ok(!CITIES.some((c) => c.name === "Rzeszów")); // Rzeszów has its own pages
  for (const name of ["Warszawa", "Kraków", "Wrocław", "Gdańsk", "Poznań", "Łódź"]) assert.ok(publicCities().some((c) => c.name === name), name);
});

test("lines of a Polish city come from the vehicles on their way across the city, counted once per trip", async () => {
  const asked = [];
  const t0 = Date.parse("2026-11-20T11:00:00Z");
  const seg = (trip, line, mode, extra = {}) => ({ trips: [{ tripId: trip, routeShortName: line }], mode, routeColor: "", from: { name: "A" }, to: { name: "B" }, departure: "2026-11-20T11:05:00Z", arrival: "2026-11-20T11:07:00Z", polyline: "", ...extra });
  const transitous = { mapTrips: async (q) => { asked.push(q); return [
    seg("t1", "10", "TRAM"), seg("t1", "10", "TRAM"), seg("t2", "10", "TRAM", { realTime: true, scheduledDeparture: "2026-11-20T11:01:00Z" }),
    seg("b1", "2", "BUS"), seg("x", "", "BUS"),
  ]; } };
  const city = createCityTransit({ transitous, now: () => t0 });
  const r = await city.lines({ city: "wroclaw" });
  assert.deepEqual(r.lines.map((l) => [l.line, l.kind, l.vehicles, l.late]), [["2", "bus", 1, 0], ["10", "tram", 2, 1]]);
  assert.equal(asked[0].startTime, "2026-11-20T11:00:00.000Z");
  assert.equal(asked[0].endTime, "2026-11-20T11:30:00.000Z");
  const [s, w] = asked[0].min.split(",").map(Number), [n, e] = asked[0].max.split(",").map(Number);
  assert.ok(s < 51.1079 && n > 51.1079 && w < 17.0385 && e > 17.0385);
  await city.lines({ city: "wroclaw" });
  assert.equal(asked.length, 1); // kept for 5 minutes
  await assert.rejects(city.lines({ city: "nigdzie" }), { status: 400 });
});
