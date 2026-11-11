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

const FARE_COLUMNS = [
  ["airline", sql.VarChar(16), false],
  ["from_airport", sql.Char(3), false],
  ["to_airport", sql.Char(3), false],
  ["flight_day", sql.Date, false],
  ["departure_local", sql.VarChar(16), true],
  ["arrival_local", sql.VarChar(16), true],
  ["flight_number", sql.VarChar(16), true],
  ["price", sql.Decimal(10, 2), false],
  ["currency", sql.Char(3), true],
  ["price_pln", sql.Decimal(10, 2), false],
  ["seats_left", sql.Int, true],
  ["price_type", sql.VarChar(8), false],
  ["source", sql.VarChar(40), false],
  ["collected_at", sql.DateTime2(0), false],
];

async function replaceFlightFares(pool, fares) {
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    await tx.request().query("DELETE FROM dbo.FlightFare;");
    await bulk(tx, "FlightFare", FARE_COLUMNS, fares.map((fare) => [
      fare.airline, fare.from, fare.to, new Date(`${fare.day}T00:00:00Z`), fare.departure, fare.arrival, fare.flightNumber,
      fare.price, fare.currency, fare.pricePln, fare.seatsLeft, fare.priceType, fare.source, fare.collectedAt,
    ]));
    await tx.commit();
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}

// Every price the app receives is also kept here, so a route's price can be followed over time.
async function appendFareHistory(pool, fares) {
  if (!fares.length) return 0;
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    await bulk(tx, "FlightPriceHistory", FARE_COLUMNS, fares.map((fare) => [
      fare.airline, fare.from, fare.to, new Date(`${fare.day}T00:00:00Z`), fare.departure, fare.arrival, fare.flightNumber,
      fare.price, fare.currency, fare.pricePln, fare.seatsLeft, fare.priceType, String(fare.source).slice(0, 40), fare.collectedAt,
    ]));
    await tx.commit();
    return fares.length;
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}

async function readFlightFares(pool, fromDay) {
  const result = await pool.request().input("fromDay", sql.Date, new Date(`${fromDay}T00:00:00Z`)).query(`
    SELECT airline, from_airport AS [from], to_airport AS [to], CONVERT(CHAR(10), flight_day, 23) AS day,
           departure_local AS departure, arrival_local AS arrival, flight_number AS flightNumber,
           price, currency, price_pln AS pricePln, seats_left AS seatsLeft, price_type AS priceType, source, collected_at AS collectedAt
    FROM dbo.FlightFare WHERE flight_day >= @fromDay;`);
  return result.recordset;
}

async function readFlightNetwork(pool) {
  const result = await pool.request().query("SELECT network FROM dbo.FlightNetwork;");
  return result.recordset[0] ? JSON.parse(result.recordset[0].network) : null;
}

async function saveFlightNetwork(pool, network) {
  await pool.request()
    .input("network", sql.NVarChar(sql.MAX), JSON.stringify(network))
    .input("updatedAt", sql.DateTime2(0), new Date(network.updatedAt))
    .query(`
      UPDATE dbo.FlightNetwork SET network = @network, updated_at = @updatedAt;
      IF @@ROWCOUNT = 0 INSERT INTO dbo.FlightNetwork (network, updated_at) VALUES (@network, @updatedAt);`);
}

async function readSetting(pool, key) {
  const result = await pool.request()
    .input("key", sql.NVarChar(64), key)
    .query("SELECT setting_value AS value, updated_at AS updatedAt FROM dbo.AppSetting WHERE setting_key = @key;");
  return result.recordset[0] || null;
}

async function saveSetting(pool, key, value) {
  await pool.request()
    .input("key", sql.NVarChar(64), key)
    .input("value", sql.NVarChar(4000), value)
    .query(`
      UPDATE dbo.AppSetting SET setting_value = @value, updated_at = SYSUTCDATETIME() WHERE setting_key = @key;
      IF @@ROWCOUNT = 0 INSERT INTO dbo.AppSetting (setting_key, setting_value, updated_at) VALUES (@key, @value, SYSUTCDATETIME());`);
}

// Airport → city transfers (one row per airport), replaced whole when data/airport-transfers.csv changes.
async function replaceAirportTransfers(pool, rows) {
  const table = new sql.Table("dbo.AirportTransfer");
  table.create = false;
  table.columns.add("iata", sql.Char(3), { nullable: false });
  table.columns.add("city", sql.NVarChar(80), { nullable: false });
  table.columns.add("country", sql.NVarChar(60), { nullable: false });
  table.columns.add("airport", sql.NVarChar(160), { nullable: false });
  table.columns.add("ryanair", sql.Bit, { nullable: false });
  table.columns.add("wizz", sql.Bit, { nullable: false });
  table.columns.add("pickup", sql.NVarChar(160), { nullable: false });
  table.columns.add("pickup_lat", sql.Decimal(9, 6), { nullable: false });
  table.columns.add("pickup_lon", sql.Decimal(9, 6), { nullable: false });
  table.columns.add("pickup_precision", sql.NVarChar(10), { nullable: false });
  table.columns.add("mode", sql.NVarChar(10), { nullable: false });
  table.columns.add("route", sql.NVarChar(400), { nullable: false });
  table.columns.add("fare", sql.NVarChar(200), { nullable: false });
  table.columns.add("fare_eur", sql.Decimal(7, 2), { nullable: true });
  table.columns.add("walk", sql.NVarChar(400), { nullable: false });
  table.columns.add("gtfs", sql.NVarChar(12), { nullable: false });
  table.columns.add("airport_lat", sql.Decimal(9, 6), { nullable: false });
  table.columns.add("airport_lon", sql.Decimal(9, 6), { nullable: false });
  table.columns.add("updated_at", sql.DateTime2(0), { nullable: false });
  const at = new Date();
  for (const r of rows) {
    table.rows.add(r.code, r.city, r.country, r.airport, r.ryanair, r.wizz, r.pickup.name, r.pickup.lat, r.pickup.lon, r.pickup.precision,
      r.mode, r.route, r.fare, r.fareEur, r.walk, r.gtfs, r.airportLat, r.airportLon, at);
  }
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    await tx.request().query("DELETE FROM dbo.AirportTransfer;");
    if (rows.length) await tx.request().bulk(table);
    await tx.commit();
  } catch (error) {
    await tx.rollback().catch(() => {});
    throw error;
  }
}

async function readAirportTransfers(pool) {
  const result = await pool.request().query(`
    SELECT iata, city, country, airport, ryanair, wizz, pickup, pickup_lat, pickup_lon, pickup_precision, mode, route, fare, fare_eur,
      walk, gtfs, airport_lat, airport_lon FROM dbo.AirportTransfer;`);
  return result.recordset.map((r) => ({
    code: r.iata.trim(), city: r.city, country: r.country, airport: r.airport, ryanair: Boolean(r.ryanair), wizz: Boolean(r.wizz),
    pickup: { name: r.pickup, lat: Number(r.pickup_lat), lon: Number(r.pickup_lon), precision: r.pickup_precision },
    mode: r.mode, route: r.route, fare: r.fare, fareEur: r.fare_eur == null ? null : Number(r.fare_eur), walk: r.walk, gtfs: r.gtfs,
    airportLat: Number(r.airport_lat), airportLon: Number(r.airport_lon),
  }));
}

async function replaceAirportFares(pool, rows) {
  const table = new sql.Table("dbo.AirportFare");
  table.create = false;
  table.columns.add("iata", sql.Char(3), { nullable: false });
  table.columns.add("position", sql.Int, { nullable: false });
  table.columns.add("name", sql.NVarChar(120), { nullable: false });
  table.columns.add("match", sql.NVarChar(200), { nullable: false });
  table.columns.add("mode", sql.NVarChar(10), { nullable: false });
  table.columns.add("fare", sql.NVarChar(200), { nullable: false });
  table.columns.add("fare_eur", sql.Decimal(7, 2), { nullable: true });
  table.columns.add("note", sql.NVarChar(400), { nullable: false });
  table.columns.add("checked", sql.NVarChar(20), { nullable: false });
  table.columns.add("source", sql.NVarChar(300), { nullable: false });
  table.columns.add("updated_at", sql.DateTime2(0), { nullable: false });
  const at = new Date();
  rows.forEach((r, i) => table.rows.add(r.code, i, r.option, r.match, r.mode, r.fare, r.fareEur, r.note, r.checked, r.source, at));
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    await tx.request().query("DELETE FROM dbo.AirportFare;");
    if (rows.length) await tx.request().bulk(table);
    await tx.commit();
  } catch (error) {
    await tx.rollback().catch(() => {});
    throw error;
  }
}

async function readAirportFares(pool) {
  const result = await pool.request().query("SELECT iata, name, match, mode, fare, fare_eur, note, checked, source FROM dbo.AirportFare ORDER BY iata, position;");
  return result.recordset.map((r) => ({
    code: r.iata.trim(), option: r.name, match: r.match, mode: r.mode, fare: r.fare, fareEur: r.fare_eur == null ? null : Number(r.fare_eur),
    note: r.note, checked: r.checked, source: r.source,
  }));
}

// Prepared datasets. Background jobs write them; requests only read them.
function createSnapshots(pool) {
  return {
    async info(key) {
      const result = await pool.request().input("key", sql.NVarChar(64), key)
        .query("SELECT etag, content_type AS type, fetched_at AS fetchedAt FROM dbo.DataSnapshot WHERE snapshot_key = @key;");
      return result.recordset[0] || null;
    },
    async read(key) {
      const result = await pool.request().input("key", sql.NVarChar(64), key).query("SELECT body FROM dbo.DataSnapshot WHERE snapshot_key = @key;");
      return result.recordset[0]?.body || null;
    },
    async save(key, { body, type, etag }) {
      await pool.request()
        .input("key", sql.NVarChar(64), key)
        .input("type", sql.NVarChar(64), type)
        .input("etag", sql.Char(34), etag)
        .input("body", sql.VarBinary(sql.MAX), body)
        .query(`
          UPDATE dbo.DataSnapshot SET content_type = @type, etag = @etag, body = @body, fetched_at = SYSUTCDATETIME() WHERE snapshot_key = @key;
          IF @@ROWCOUNT = 0 INSERT INTO dbo.DataSnapshot (snapshot_key, content_type, etag, body, fetched_at) VALUES (@key, @type, @etag, @body, SYSUTCDATETIME());`);
    },
    async prune(prefix, before) {
      await pool.request()
        .input("prefix", sql.NVarChar(65), `${prefix}%`)
        .input("before", sql.NVarChar(64), `${prefix}${before}`)
        .query("DELETE FROM dbo.DataSnapshot WHERE snapshot_key LIKE @prefix AND snapshot_key < @before;");
    },
  };
}

module.exports = {
  AGENCIES,
  appendFareHistory,
  createSnapshots,
  createSqlConfig,
  getSchedule,
  importedHash,
  readFlightFares,
  readAirportFares,
  readAirportTransfers,
  replaceAirportFares,
  readFlightNetwork,
  saveFlightNetwork,
  saveSetting,
  readSchedule,
  readSetting,
  replaceAirportTransfers,
  replaceFlightFares,
  replaceSchedule,
  sourceHash,
  validateSchedulePayload,
};
