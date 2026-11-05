"use strict";

require("dotenv").config({ quiet: true });

const crypto = require("node:crypto");
const sql = require("mssql");

const AGENCIES = new Set(["ztm", "pks"]);
const SCHEDULE_TABLES = [
  "routes",
  "trips",
  "stops",
  "stopTimes",
  "calendar",
  "calendarDates",
  "shapes",
];
const MAX_SOURCE_KEY_LENGTH = 4096;
const WRITE_CHUNK = 20000;
const READ_CHUNK = 100000;

function createSqlConfig(env = process.env) {
  const server = env.AZURE_SQL_SERVER;
  const database = env.AZURE_SQL_DATABASE;
  if (!server || !database) {
    throw new Error("AZURE_SQL_SERVER and AZURE_SQL_DATABASE must be configured.");
  }

  const identityOptions = {};
  if (env.AZURE_CLIENT_ID) identityOptions.clientId = env.AZURE_CLIENT_ID;

  return {
    server,
    database,
    port: 1433,
    connectionTimeout: 15000,
    requestTimeout: 120000,
    options: {
      encrypt: true,
      trustServerCertificate: false,
      enableArithAbort: true,
    },
    authentication: {
      type: "azure-active-directory-default",
      options: identityOptions,
    },
    pool: {
      max: 10,
      min: 0,
      idleTimeoutMillis: 30000,
    },
  };
}

function sourceHash(sourceKey) {
  if (typeof sourceKey !== "string" || sourceKey.length === 0 || sourceKey.length > MAX_SOURCE_KEY_LENGTH) {
    throw new TypeError("sourceKey must be a non-empty string of at most 4096 characters.");
  }
  return crypto.createHash("sha256").update(sourceKey).digest("hex");
}

function validateSchedulePayload(agency, payload) {
  if (!AGENCIES.has(agency)) throw new TypeError("Unsupported agency.");
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("The schedule payload must be an object.");
  }
  sourceHash(payload.sourceKey);
  for (const table of SCHEDULE_TABLES) {
    if (!Array.isArray(payload[table])) throw new TypeError(`The ${table} collection is required.`);
  }

  const routeIds = new Set();
  for (const route of payload.routes) {
    if (!route.id || routeIds.has(route.id)) throw new TypeError("Route IDs must be present and unique.");
    routeIds.add(route.id);
  }
  const stopIds = new Set();
  for (const stop of payload.stops) {
    if (!stop.id || stopIds.has(stop.id)) throw new TypeError("Stop IDs must be present and unique.");
    if (!Number.isFinite(stop.lat) || !Number.isFinite(stop.lon)) throw new TypeError("Stop coordinates must be finite.");
    stopIds.add(stop.id);
  }
  const tripIds = new Set();
  const serviceIds = new Set(payload.calendar.map((service) => service.service_id));
  for (const exception of payload.calendarDates) serviceIds.add(exception.service_id);
  for (const trip of payload.trips) {
    if (!trip.id || tripIds.has(trip.id)) throw new TypeError("Trip IDs must be present and unique.");
    if (!routeIds.has(trip.route)) throw new TypeError(`Trip ${trip.id} references an unknown route.`);
    if (!trip.service) throw new TypeError(`Trip ${trip.id} is missing a service ID.`);
    serviceIds.add(trip.service);
    tripIds.add(trip.id);
  }
  for (const stopTime of payload.stopTimes) {
    if (!tripIds.has(stopTime.trip_id)) throw new TypeError("Stop time references an unknown trip.");
    if (!stopIds.has(stopTime.stop_id)) throw new TypeError("Stop time references an unknown stop.");
    if (!Number.isInteger(stopTime.sequence) || !Number.isInteger(stopTime.arrival_seconds) || !Number.isInteger(stopTime.departure_seconds)) {
      throw new TypeError("Stop time sequence and times must be integers.");
    }
  }
  for (const exception of payload.calendarDates) {
    if (!serviceIds.has(exception.service_id) || !/^\d{8}$/.test(exception.date) || ![1, 2].includes(exception.exception_type)) {
      throw new TypeError("Service calendar exceptions must have a valid service, date, and exception type.");
    }
  }

  const shapeIds = new Set(payload.shapes.map((shape) => shape.id));
  for (const trip of payload.trips) {
    if (trip.shape && !shapeIds.has(trip.shape)) throw new TypeError(`Trip ${trip.id} references an unknown shape.`);
  }
  for (const shape of payload.shapes) {
    if (!shape.id || !Array.isArray(shape.points)) throw new TypeError("Each shape must have an ID and a points array.");
    for (const point of shape.points) {
      if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)) {
        throw new TypeError(`Shape ${shape.id} contains an invalid point.`);
      }
    }
  }
  return { sourceHash: sourceHash(payload.sourceKey), serviceIds, shapeIds };
}

function table(name, columns, rows) {
  const result = new sql.Table(`dbo.${name}`);
  result.create = false;
  for (const [columnName, type, nullable] of columns) {
    result.columns.add(columnName, type, { nullable: Boolean(nullable) });
  }
  for (const row of rows) result.rows.add(...row);
  return result;
}

// A timetable has over a million rows, so work in chunks to stay within the request timeout on small databases.
async function bulk(transaction, tableName, columns, rows) {
  for (let start = 0; start < rows.length; start += WRITE_CHUNK) {
    await transaction.request().bulk(table(tableName, columns, rows.slice(start, start + WRITE_CHUNK)));
  }
}

async function deleteRows(transaction, tableName, agency) {
  for (;;) {
    const result = await transaction.request()
      .input("agency", sql.NVarChar(10), agency)
      .query(`DELETE TOP (${WRITE_CHUNK}) FROM dbo.${tableName} WHERE agency_code = @agency;`);
    if (result.rowsAffected[0] < WRITE_CHUNK) return;
  }
}

async function replaceSchedule(pool, agency, payload) {
  const { sourceHash: hash, serviceIds, shapeIds } = validateSchedulePayload(agency, payload);
  const tx = new sql.Transaction(pool);
  await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    for (const tableName of ["GtfsStopTime", "GtfsShapePoint", "GtfsTrip", "GtfsServiceException", "GtfsServiceCalendar", "GtfsRoute", "GtfsStop", "GtfsService", "GtfsShape", "GtfsFeedImport"]) {
      await deleteRows(tx, tableName, agency);
    }

    await bulk(tx, "GtfsRoute", [
      ["agency_code", sql.NVarChar(10)],
      ["route_id", sql.NVarChar(200)],
      ["short_name", sql.NVarChar(100)],
      ["long_name", sql.NVarChar(300)],
      ["route_color", sql.Char(7), true],
      ["text_color", sql.Char(7), true],
      ["route_type", sql.Int],
    ], payload.routes.map((route) => [
      agency, route.id, route.short || route.id, route.long || "", route.color || null, route.text || null, route.type || 0,
    ]));

    await bulk(tx, "GtfsStop", [
      ["agency_code", sql.NVarChar(10)],
      ["stop_id", sql.NVarChar(200)],
      ["stop_name", sql.NVarChar(300)],
      ["stop_code", sql.NVarChar(100)],
      ["latitude", sql.Float],
      ["longitude", sql.Float],
    ], payload.stops.map((stop) => [agency, stop.id, stop.name || stop.id, stop.code || "", stop.lat, stop.lon]));

    await bulk(tx, "GtfsService", [
      ["agency_code", sql.NVarChar(10)],
      ["service_id", sql.NVarChar(200)],
    ], [...serviceIds].map((serviceId) => [agency, serviceId]));

    await bulk(tx, "GtfsServiceCalendar", [
      ["agency_code", sql.NVarChar(10)],
      ["service_id", sql.NVarChar(200)],
      ["monday", sql.Bit],
      ["tuesday", sql.Bit],
      ["wednesday", sql.Bit],
      ["thursday", sql.Bit],
      ["friday", sql.Bit],
      ["saturday", sql.Bit],
      ["sunday", sql.Bit],
      ["start_date", sql.Char(8)],
      ["end_date", sql.Char(8)],
    ], payload.calendar.map((service) => [agency, service.service_id, ...service.days, service.start, service.end]));

    await bulk(tx, "GtfsServiceException", [
      ["agency_code", sql.NVarChar(10)],
      ["service_id", sql.NVarChar(200)],
      ["service_date", sql.Char(8)],
      ["exception_type", sql.TinyInt],
    ], payload.calendarDates.map((item) => [agency, item.service_id, item.date, item.exception_type]));

    await bulk(tx, "GtfsShape", [
      ["agency_code", sql.NVarChar(10)],
      ["shape_id", sql.NVarChar(200)],
    ], [...shapeIds].map((shapeId) => [agency, shapeId]));

    await bulk(tx, "GtfsTrip", [
      ["agency_code", sql.NVarChar(10)],
      ["trip_id", sql.NVarChar(200)],
      ["route_id", sql.NVarChar(200)],
      ["service_id", sql.NVarChar(200)],
      ["headsign", sql.NVarChar(300)],
      ["direction_id", sql.SmallInt, true],
      ["shape_id", sql.NVarChar(200), true],
      ["block_id", sql.NVarChar(100), true],
      ["brigade", sql.NVarChar(100), true],
    ], payload.trips.map((trip) => [
      agency, trip.id, trip.route, trip.service, trip.headsign || "",
      trip.dir === "" || trip.dir == null ? null : Number(trip.dir),
      trip.shape || null, trip.block || null, trip.brigade || null,
    ]));

    const shapePoints = [];
    for (const shape of payload.shapes) {
      shape.points.forEach(([latitude, longitude], index) => {
        shapePoints.push([agency, shape.id, index, latitude, longitude]);
      });
    }
    await bulk(tx, "GtfsShapePoint", [
      ["agency_code", sql.NVarChar(10)],
      ["shape_id", sql.NVarChar(200)],
      ["point_sequence", sql.Int],
      ["latitude", sql.Float],
      ["longitude", sql.Float],
    ], shapePoints);

    await bulk(tx, "GtfsStopTime", [
      ["agency_code", sql.NVarChar(10)],
      ["trip_id", sql.NVarChar(200)],
      ["stop_sequence", sql.Int],
      ["stop_id", sql.NVarChar(200)],
      ["arrival_seconds", sql.Int],
      ["departure_seconds", sql.Int],
    ], payload.stopTimes.map((item) => [
      agency, item.trip_id, item.sequence, item.stop_id, item.arrival_seconds, item.departure_seconds,
    ]));

    await tx.request()
      .input("agency", sql.NVarChar(10), agency)
      .input("sourceHash", sql.Char(64), hash)
      .query(`
        INSERT INTO dbo.GtfsFeedImport (agency_code, source_hash, imported_at)
        VALUES (@agency, @sourceHash, SYSUTCDATETIME());
      `);
    await tx.commit();
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}

async function getSchedule(pool, agency, sourceKey) {
  if (!AGENCIES.has(agency)) throw new TypeError("Unsupported agency.");
  const hash = sourceHash(sourceKey);
  const request = () => pool.request().input("agency", sql.NVarChar(10), agency);
  const feedResult = await request()
    .input("sourceHash", sql.Char(64), hash)
    .query(`
      SELECT source_hash AS sourceHash, imported_at AS importedAt
      FROM dbo.GtfsFeedImport
      WHERE agency_code = @agency AND source_hash = @sourceHash
        AND imported_at >= DATEADD(hour, -12, SYSUTCDATETIME());
    `);
  if (!feedResult.recordset.length) return null;
  return readSchedule(pool, agency, feedResult.recordset[0].importedAt);
}

async function importedHash(pool, agency) {
  const result = await pool.request().input("agency", sql.NVarChar(10), agency)
    .query("SELECT source_hash AS sourceHash FROM dbo.GtfsFeedImport WHERE agency_code = @agency;");
  return result.recordset[0]?.sourceHash ?? null;
}

async function readInChunks(pool, agency, select, keyColumn, sequenceColumn) {
  const rows = [];
  let key = "";
  let sequence = -1;
  for (;;) {
    const result = await pool.request()
      .input("agency", sql.NVarChar(10), agency)
      .input("key", sql.NVarChar(200), key)
      .input("sequence", sql.Int, sequence)
      .query(`
        SELECT TOP (${READ_CHUNK}) ${select}
        WHERE agency_code = @agency AND (${keyColumn} > @key OR (${keyColumn} = @key AND ${sequenceColumn} > @sequence))
        ORDER BY ${keyColumn}, ${sequenceColumn};
      `);
    for (const row of result.recordset) rows.push(row);
    if (result.recordset.length < READ_CHUNK) return rows;
    const last = result.recordset[result.recordset.length - 1];
    key = last[keyColumn];
    sequence = last[sequenceColumn];
  }
}

async function readSchedule(pool, agency, knownImportedAt) {
  const request = () => pool.request().input("agency", sql.NVarChar(10), agency);
  const importedAt = knownImportedAt ?? (await request().query("SELECT imported_at AS importedAt FROM dbo.GtfsFeedImport WHERE agency_code = @agency;")).recordset[0]?.importedAt;
  if (!importedAt) return null;
  const routes = await request().query("SELECT route_id AS id, short_name AS short, long_name AS [long], route_color AS color, text_color AS [text], route_type AS [type] FROM dbo.GtfsRoute WHERE agency_code = @agency;");
  const trips = await request().query("SELECT trip_id AS id, route_id AS route, service_id AS service, headsign, direction_id AS dir, shape_id AS shape, block_id AS block, brigade FROM dbo.GtfsTrip WHERE agency_code = @agency;");
  const stops = await request().query("SELECT stop_id AS id, stop_name AS name, stop_code AS code, latitude AS lat, longitude AS lon FROM dbo.GtfsStop WHERE agency_code = @agency;");
  const calendars = await request().query("SELECT c.service_id, c.monday, c.tuesday, c.wednesday, c.thursday, c.friday, c.saturday, c.sunday, c.start_date AS [start], c.end_date AS [end] FROM dbo.GtfsServiceCalendar c WHERE c.agency_code = @agency;");
  const exceptions = await request().query("SELECT service_id, service_date AS [date], exception_type FROM dbo.GtfsServiceException WHERE agency_code = @agency;");
  const stopTimes = { recordset: await readInChunks(pool, agency, "trip_id, stop_sequence, stop_id, arrival_seconds, departure_seconds FROM dbo.GtfsStopTime", "trip_id", "stop_sequence") };
  const shapes = { recordset: await readInChunks(pool, agency, "shape_id, point_sequence, latitude, longitude FROM dbo.GtfsShapePoint", "shape_id", "point_sequence") };

  const shapeMap = new Map();
  for (const point of shapes.recordset) {
    if (!shapeMap.has(point.shape_id)) shapeMap.set(point.shape_id, []);
    shapeMap.get(point.shape_id).push([point.latitude, point.longitude]);
  }
  return {
    importedAt,
    routes: routes.recordset.map((row) => ({ ...row, agency })),
    trips: trips.recordset,
    stops: stops.recordset.map((row) => ({ ...row, agency })),
    stopTimes: stopTimes.recordset.map((row) => ({ ...row, sequence: row.stop_sequence, stop_sequence: undefined })),
    calendar: calendars.recordset.map((row) => ({
      service_id: row.service_id,
      days: [row.monday, row.tuesday, row.wednesday, row.thursday, row.friday, row.saturday, row.sunday],
      start: row.start,
      end: row.end,
    })),
    calendarDates: exceptions.recordset,
    shapes: [...shapeMap].map(([id, points]) => ({ id, points })),
  };
}

module.exports = {
  AGENCIES,
  createSqlConfig,
  getSchedule,
  importedHash,
  readSchedule,
  replaceSchedule,
  sourceHash,
  validateSchedulePayload,
};
