"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const JSZip = require("jszip");
const { readCsv } = require("./gtfs-import");
const { SERVED_STATIONS } = require("./plk");

const SOURCE = "https://mkuran.pl/gtfs/polish_trains.zip";
const ASSETS = path.resolve(__dirname, "..", "assets");
const TOLERANCE_KM = 0.03;
const KM_PER_DEGREE = 111.32;
const SERVED = new Set(SERVED_STATIONS);

function offLine(point, start, end) {
  const scale = Math.cos((start[0] * Math.PI) / 180);
  const [x, y] = [(point[1] - start[1]) * scale, point[0] - start[0]];
  const [dx, dy] = [(end[1] - start[1]) * scale, end[0] - start[0]];
  const length = dx * dx + dy * dy;
  const along = length ? Math.max(0, Math.min(1, (x * dx + y * dy) / length)) : 0;
  return Math.hypot(x - along * dx, y - along * dy) * KM_PER_DEGREE;
}

function simplify(points, tolerance = TOLERANCE_KM) {
  if (points.length < 3) return points;
  const keep = new Set([0, points.length - 1]);
  const pending = [[0, points.length - 1]];
  while (pending.length) {
    const [first, last] = pending.pop();
    let farthest = -1;
    let distance = tolerance;
    for (let i = first + 1; i < last; i += 1) {
      const off = offLine(points[i], points[first], points[last]);
      if (off > distance) {
        distance = off;
        farthest = i;
      }
    }
    if (farthest < 0) continue;
    keep.add(farthest);
    pending.push([first, farthest], [farthest, last]);
  }
  return [...keep].sort((a, b) => a - b).map((index) => points[index]);
}

const rounded = (value) => Number(Number(value).toFixed(5));

// Each stop splits the line, so a station always sits exactly on a kept point.
function simplifyTrack(points, stations) {
  const stops = [...stations]
    .map(([id, km]) => ({ id, index: points.reduce((best, point, i) => (Math.abs(point[2] - km) < Math.abs(points[best][2] - km) ? i : best), 0) }))
    .sort((a, b) => a.index - b.index);
  const line = [];
  const at = {};
  let from = 0;
  for (const stop of stops) {
    if (stop.index > from) line.push(...simplify(points.slice(from, stop.index + 1)).slice(0, -1));
    from = Math.max(from, stop.index);
    at[stop.id] = line.length;
  }
  line.push(...simplify(points.slice(from)));
  return { at, points: line.map(([lat, lon]) => [rounded(lat), rounded(lon)]) };
}

function buildRailMap({ stops, trips, stopTimes, shapes }) {
  const parents = new Map();
  const stations = [];
  readCsv(stops, (cell) => {
    parents.set(cell("stop_id"), cell("parent_station") || cell("stop_id"));
    if (cell("location_type") === "1" && /^\d+$/.test(cell("stop_id"))) stations.push([Number(cell("stop_id")), cell("stop_name"), rounded(cell("stop_lat")), rounded(cell("stop_lon"))]);
  });
  stations.sort((a, b) => a[0] - b[0]);

  const shapeOfTrip = new Map();
  readCsv(trips, (cell) => {
    if (cell("shape_id").startsWith("RAIL")) shapeOfTrip.set(cell("trip_id"), cell("shape_id"));
  });
  const stationsOnShape = new Map();
  const served = new Set();
  readCsv(stopTimes, (cell) => {
    const shape = shapeOfTrip.get(cell("trip_id"));
    if (!shape) return;
    const station = parents.get(cell("stop_id")) || cell("stop_id");
    if (!stationsOnShape.has(shape)) stationsOnShape.set(shape, new Map());
    if (!stationsOnShape.get(shape).has(station)) stationsOnShape.get(shape).set(station, Number(cell("shape_dist_traveled")));
    if (SERVED.has(station)) served.add(shape);
  });
  const lines = new Map([...served].map((shape) => [shape, []]));
  readCsv(shapes, (cell) => {
    lines.get(cell("shape_id"))?.push([Number(cell("shape_pt_lat")), Number(cell("shape_pt_lon")), Number(cell("shape_dist_traveled"))]);
  });
  const tracks = [...lines].filter(([, points]) => points.length > 1).map(([shape, points]) => simplifyTrack(points, stationsOnShape.get(shape)));
  return { stations, tracks };
}

async function readSource(file) {
  if (file) return fs.readFile(file);
  const response = await fetch(SOURCE, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Rail timetable returned HTTP ${response.status}.`);
  return Buffer.from(await response.arrayBuffer());
}

async function main() {
  const zip = await JSZip.loadAsync(await readSource(process.argv[2]));
  const text = (name) => zip.file(name).async("string");
  const { stations, tracks } = buildRailMap({ stops: await text("stops.txt"), trips: await text("trips.txt"), stopTimes: await text("stop_times.txt"), shapes: await text("shapes.txt") });
  const lines = (rows) => `[\n${rows.map((row) => JSON.stringify(row)).join(",\n")}\n]\n`;
  await fs.writeFile(path.join(ASSETS, "app.rail-stations.json"), lines(stations));
  await fs.writeFile(path.join(ASSETS, "app.rail-tracks.json"), lines(tracks));
  console.log(`Saved ${stations.length} stations and ${tracks.length} tracks.`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { buildRailMap, simplify };
