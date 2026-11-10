"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { buildRailMap, simplify } = require("../src/rail-map");

const feed = {
  stops: [
    "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station",
    "82669,Rzeszów Główny,50.04307,22.00595,1,",
    "82669_RAIL_1,Rzeszów Główny,50.04307,22.00595,0,82669",
    "80416,Kraków Główny,50.06861,19.9478,1,",
    "80416_RAIL_1,Kraków Główny,50.06861,19.9478,0,80416",
    "79905,Kraków Płaszów,50.03,19.99,1,",
    "79905_RAIL_1,Kraków Płaszów,50.03,19.99,0,79905",
  ].join("\n"),
  trips: "trip_id,shape_id\nnear,RAIL_1\nfar,RAIL_2\nbus,BUS_1",
  stopTimes: [
    "trip_id,stop_id,shape_dist_traveled",
    "near,82669_RAIL_1,0",
    "near,80416_RAIL_1,10",
    "far,80416_RAIL_1,0",
    "far,79905_RAIL_1,10",
    "bus,82669_RAIL_1,0",
  ].join("\n"),
  shapes: [
    "shape_id,shape_pt_lat,shape_pt_lon,shape_dist_traveled",
    "RAIL_1,50.0,22.0,0",
    "RAIL_1,50.1,21.0,5",
    "RAIL_1,50.0,20.0,10",
    "RAIL_2,50.0,20.0,0",
    "RAIL_2,50.0,19.0,10",
    "BUS_1,50.0,22.0,0",
    "BUS_1,50.0,21.0,10",
  ].join("\n"),
};

test("only tracks of trains calling near Rzeszów are kept, with their stations on the line", () => {
  const { stations, tracks } = buildRailMap(feed);
  assert.deepEqual(stations.map((station) => station[0]), [79905, 80416, 82669]);
  assert.equal(tracks.length, 1);
  assert.deepEqual(tracks[0].points, [[50, 22], [50.1, 21], [50, 20]]);
  assert.deepEqual(tracks[0].at, { 82669: 0, 80416: 2 });
});

test("a track loses points that do not change its shape", () => {
  const line = [[50, 20], [50, 20.001], [50, 20.002], [50.5, 20.003], [50, 20.004]];
  assert.deepEqual(simplify(line), [[50, 20], [50, 20.002], [50.5, 20.003], [50, 20.004]]);
});
