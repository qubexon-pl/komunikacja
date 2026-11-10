"use strict";

const JSZip = require("jszip");

function splitLine(line) {
  if (!line.includes('"')) return line.split(",");
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted && char === '"' && line[i + 1] === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells;
}

function readCsv(text, onRow) {
  const lines = (text || "").replace(/^﻿/, "").split(/\r?\n/);
  const header = new Map(splitLine(lines[0] || "").map((name, index) => [name.trim(), index]));
  for (let i = 1; i < lines.length; i += 1) {
    if (!lines[i]) continue;
    const cells = splitLine(lines[i]);
    onRow((name) => cells[header.get(name)] ?? "");
  }
}

function seconds(value) {
  const parts = value.split(":");
  if (parts.length < 2) return null;
  return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2] || 0);
}

// Builds the same shape that replaceSchedule stores. PKS IDs get a prefix so they never clash with ZTM IDs.
async function parseFeed(buffer, agency, sourceKey) {
  const prefix = agency === "pks" ? "pks:" : "";
  const id = (value) => (value ? prefix + value : "");
  const zip = await JSZip.loadAsync(buffer);
  const read = async (name) => {
    const file = zip.file(name) || zip.file(new RegExp(`(^|/)${name.replace(".", "\\.")}$`))[0];
    return file ? file.async("string") : "";
  };

  const routes = [];
  readCsv(await read("routes.txt"), (cell) => {
    const color = cell("route_color");
    const text = cell("route_text_color");
    routes.push({
      id: id(cell("route_id")),
      short: cell("route_short_name") || cell("route_id"),
      long: cell("route_long_name"),
      color: color ? `#${color}` : null,
      text: text ? `#${text}` : null,
      type: Number(cell("route_type")) || 0,
      agency,
    });
  });
  const routeIds = new Set(routes.map((route) => route.id));

  const stops = [];
  readCsv(await read("stops.txt"), (cell) => {
    stops.push({ id: id(cell("stop_id")), name: cell("stop_name"), code: cell("stop_code"), lat: Number(cell("stop_lat")), lon: Number(cell("stop_lon")), agency });
  });
  const stopIds = new Set(stops.map((stop) => stop.id));

  const points = new Map();
  readCsv(await read("shapes.txt"), (cell) => {
    const shape = id(cell("shape_id"));
    if (!points.has(shape)) points.set(shape, []);
    points.get(shape).push([Number(cell("shape_pt_sequence")), Number(cell("shape_pt_lat")), Number(cell("shape_pt_lon"))]);
  });
  const shapes = [...points].map(([shapeId, rows]) => ({
    id: shapeId,
    points: rows.sort((a, b) => a[0] - b[0]).map(([, lat, lon]) => [lat, lon]),
  }));

  const trips = [];
  readCsv(await read("trips.txt"), (cell) => {
    const route = id(cell("route_id"));
    if (!routeIds.has(route)) return;
    const shape = id(cell("shape_id"));
    trips.push({
      id: id(cell("trip_id")),
      route,
      service: id(cell("service_id")),
      headsign: cell("trip_headsign"),
      dir: cell("direction_id"),
      shape: points.has(shape) ? shape : null,
      block: cell("block_id") || null,
      brigade: cell("brigade") || cell("block_short_name") || null,
    });
  });
  const tripIds = new Set(trips.map((trip) => trip.id));

  const stopTimes = [];
  readCsv(await read("stop_times.txt"), (cell) => {
    const trip = id(cell("trip_id"));
    const stop = id(cell("stop_id"));
    const arrival = seconds(cell("arrival_time"));
    const departure = seconds(cell("departure_time"));
    if (!tripIds.has(trip) || !stopIds.has(stop) || (arrival == null && departure == null)) return;
    stopTimes.push({
      trip_id: trip,
      stop_id: stop,
      sequence: Number(cell("stop_sequence")),
      arrival_seconds: arrival ?? departure,
      departure_seconds: departure ?? arrival,
    });
  });

  const dayNames = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  const calendar = [];
  readCsv(await read("calendar.txt"), (cell) => {
    calendar.push({ service_id: id(cell("service_id")), days: dayNames.map((day) => cell(day) === "1"), start: cell("start_date"), end: cell("end_date") });
  });
  const calendarDates = [];
  readCsv(await read("calendar_dates.txt"), (cell) => {
    calendarDates.push({ service_id: id(cell("service_id")), date: cell("date"), exception_type: Number(cell("exception_type")) });
  });

  return { sourceKey, routes, trips, stops, stopTimes, calendar, calendarDates, shapes };
}

module.exports = { parseFeed, readCsv };
