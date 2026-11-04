"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createSqlConfig,
  sourceHash,
  validateSchedulePayload,
} = require("../src/database");

function validSchedule() {
  return {
    sourceKey: "https://example.test/gtfs.zip",
    routes: [{ id: "route-1" }],
    trips: [{ id: "trip-1", route: "route-1", service: "service-1" }],
    stops: [{ id: "stop-1", lat: 50, lon: 22 }],
    stopTimes: [{
      trip_id: "trip-1",
      stop_id: "stop-1",
      sequence: 1,
      arrival_seconds: 3600,
      departure_seconds: 3600,
    }],
    calendar: [{ service_id: "service-1", days: [true, true, true, true, true, false, false] }],
    calendarDates: [],
    shapes: [],
  };
}

test("source hashes do not expose source URLs", () => {
  const hash = sourceHash("https://example.test/gtfs.zip?secret=value");
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.notEqual(hash, "https://example.test/gtfs.zip?secret=value");
});

test("valid normalized schedule passes relational validation", () => {
  const result = validateSchedulePayload("ztm", validSchedule());
  assert.equal(result.serviceIds.has("service-1"), true);
});

test("unknown route references are rejected before database writes", () => {
  const payload = validSchedule();
  payload.trips[0].route = "missing";
  assert.throws(() => validateSchedulePayload("ztm", payload), /unknown route/);
});

test("unknown stop references are rejected before database writes", () => {
  const payload = validSchedule();
  payload.stopTimes[0].stop_id = "missing";
  assert.throws(() => validateSchedulePayload("ztm", payload), /unknown stop/);
});

test("unsupported agency codes are rejected", () => {
  assert.throws(() => validateSchedulePayload("other", validSchedule()), /Unsupported agency/);
});

test("Azure SQL configuration uses encrypted Entra authentication without passwords", () => {
  const config = createSqlConfig({
    AZURE_SQL_SERVER: "example.database.windows.net",
    AZURE_SQL_DATABASE: "komunikacja",
    AZURE_CLIENT_ID: "managed-identity-id",
  });
  assert.equal(config.options.encrypt, true);
  assert.equal(config.options.trustServerCertificate, false);
  assert.equal(config.authentication.type, "azure-active-directory-default");
  assert.equal(config.authentication.options.clientId, "managed-identity-id");
  assert.equal("password" in config, false);
});
