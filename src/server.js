"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const tls = require("node:tls");
const { createAirportTransfers } = require("./airport-transfers");
const { AGENCIES, createSnapshots, createSqlConfig, getSchedule, importedHash, readAirportTransfers, readFlightFares, readFlightNetwork, readSchedule, readSetting, replaceAirportTransfers, replaceFlightFares, appendFareHistory, replaceSchedule, saveFlightNetwork, saveSetting } = require("./database");
const { MAX_WALK_TARGETS, PATH_URLS, createDrivingRouter, createPathRouter, createWalkTable, parsePoint } = require("./driving");
const { createFlightCollector, trackerDatabase } = require("./flight-collector");
const { readNetwork } = require("./flight-network");
const { createFlightStore } = require("./flights");
const { createAlertDatabase, createPriceAlerts } = require("./price-alerts");
const { createWizzTimetable } = require("./wizz-timetable");
const { createTripWeather } = require("./trip-weather");
const { createPksFares } = require("./pks-fares");
const { createRates } = require("./rates");
const { createGeocoder, createStreetSuggester } = require("./geocode");
const { normalizeFavorites } = require("./favorites");
const { LIVE_SOURCES, createLiveCollector } = require("./live-data");
const { OPERATIONS_KEY, createPlkCollector, scheduleKey } = require("./plk");
const { ageOf } = require("./snapshots");
const { createScheduleStore } = require("./schedule");
const { createTimetableStore } = require("./timetable");
const { AuthError, SESSION_TTL_SECONDS, createAuthService, isEmailConfigured, safeReturnTo } = require("./auth");

const ROOT = path.resolve(__dirname, "..");
const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
  [".webmanifest", "application/manifest+json"],
]);
const COMPRESSIBLE = new Set([".css", ".html", ".js", ".json", ".svg", ".webmanifest"]);
const acceptsGzip = (req) => /\bgzip\b/.test(req?.headers?.["accept-encoding"] || "");
const MAX_BODY_BYTES = 100 * 1024 * 1024;
const MAX_AUTH_BODY_BYTES = 16 * 1024;
const MAX_FEED_BYTES = 50 * 1024 * 1024;
const SESSION_COOKIE = "rzbus_session";
const OAUTH_COOKIE = "rzbus_oauth_state";
const APP_PAGES = new Set(["/", "/autobusy", "/pks", "/pociagi", "/podroz", "/kierunki", "/ulubione"]);
const MAX_FAVORITES_BYTES = 64 * 1024;
const PLK_ROUTES = new Set(["schedules", "operations"]);
const PLK_KEY_SETTING = "plk_api_key";
const PLK_KEY_MAX_LENGTH = 512;
const PUBLIC_LIMITS = { streets: 120, geocode: 30, feeds: 120, timetable: 20, schedule: 20, plk: 60, live: 120, flights: 120, driving: 30, path: 120, walk: 60, fuel: 30, "pks-price": 120, weather: 60, transfers: 120, "transfer-trips": 30 };
const authAttempts = new Map();
const publicRequests = new Map();
const GTFS_SOURCE_PATHS = new Map([
  ["mkuran.pl", new Set(["/gtfs/rzeszow.zip"])],
  ["cdn.zbiorkom.live", new Set(["/gtfs/rzeszow.zip"])],
  ["kmrzeszow.live", new Set([
    "/gtfs/rt/gtfsrt.pb",
    "/gtfs-pks/rt/gtfsrt.pb",
    "/gtfs-pks/latest.zip",
  ])],
  ["www.mpkrzeszow.pl", new Set([
    "/gtfs/rt/gtfsrt.pb",
    "/gtfs-pks/rt/gtfsrt.pb",
    "/gtfs-pks/latest.zip",
  ])],
]);

function json(res, status, value) {
  const body = JSON.stringify(value);
  const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  // Larger answers (flight lists, route lists) travel compressed.
  if (body.length > 4096 && acceptsGzip(res.req)) {
    const packed = zlib.gzipSync(body, { level: 6 });
    res.writeHead(status, { ...headers, "Content-Encoding": "gzip", Vary: "Accept-Encoding", "Content-Length": packed.length });
    res.end(packed);
    return;
  }
  res.writeHead(status, headers);
  res.end(body);
}

async function readJson(req, maxBytes = MAX_BODY_BYTES) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error("Request body is too large.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.statusCode = 400;
    throw error;
  }
}

function readCookie(req, name) {
  const cookies = req.headers.cookie || "";
  for (const part of cookies.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function isSecureRequest() {
  return process.env.NODE_ENV === "production" || process.env.APP_BASE_URL?.startsWith("https://");
}

function appendCookie(res, cookie) {
  const existing = res.getHeader("Set-Cookie");
  res.setHeader("Set-Cookie", existing ? [...(Array.isArray(existing) ? existing : [existing]), cookie] : cookie);
}

function setSessionCookie(res, token) {
  const secure = isSecureRequest() ? "; Secure" : "";
  appendCookie(res, `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}${secure}`);
}

function clearSessionCookie(res) {
  const secure = isSecureRequest() ? "; Secure" : "";
  appendCookie(res, `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

function setOAuthCookie(res, state) {
  const secure = isSecureRequest() ? "; Secure" : "";
  appendCookie(res, `${OAUTH_COOKIE}=${encodeURIComponent(state)}; Path=/api/auth/google; HttpOnly; SameSite=Lax; Max-Age=600${secure}`);
}

function clearOAuthCookie(res) {
  const secure = isSecureRequest() ? "; Secure" : "";
  appendCookie(res, `${OAUTH_COOKIE}=; Path=/api/auth/google; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

function constantTimeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireSameOrigin(req) {
  const origin = req.headers.origin;
  const configuredOrigin = process.env.APP_BASE_URL ? new URL(process.env.APP_BASE_URL).origin : `http://${req.headers.host}`;
  if (!origin || origin !== configuredOrigin) {
    throw new AuthError("Nie udało się zweryfikować źródła żądania.", 403);
  }
}

function takeAuthAttempt(req) {
  const key = req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const previous = authAttempts.get(key);
  if (!previous || now - previous.startedAt >= 15 * 60 * 1000) {
    authAttempts.set(key, { startedAt: now, count: 1 });
    return true;
  }
  previous.count += 1;
  return previous.count <= 15;
}

// Public endpoints call paid or fair-use services, so each visitor gets a share per minute.
function takePublicRequest(req, name) {
  const key = `${name}|${req.socket.remoteAddress || "unknown"}`;
  const now = Date.now();
  const entry = publicRequests.get(key);
  if (!entry || now - entry.startedAt >= 60 * 1000) {
    if (publicRequests.size > 10000) publicRequests.clear();
    publicRequests.set(key, { startedAt: now, count: 1 });
    return true;
  }
  entry.count += 1;
  return entry.count <= PUBLIC_LIMITS[name];
}

function authRedirect(res, pathname, search = "") {
  res.writeHead(302, { Location: `${pathname}${search}`, "Cache-Control": "no-store" });
  res.end();
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SCAN_DAYS = 90;
// Trips, single prices and alerts can be planned a year ahead; an admin scan still covers at most 90 days at once.
const PLAN_AHEAD_DAYS = 366;

function serveFlights(res, url, action, flights) {
  if (!flights) {
    json(res, 503, { error: "Dane o lotach są niedostępne." });
    return;
  }
  const code = (name) => (url.searchParams.get(name) || "").trim().toUpperCase();
  const date = url.searchParams.get("date") || "";
  const back = url.searchParams.get("back") || "";
  if ((date && !ISO_DAY.test(date)) || (back && !ISO_DAY.test(back))) {
    json(res, 400, { error: "Nieprawidłowa data." });
    return;
  }
  if (action !== "options") {
    json(res, 200, flights.search({ from: code("from"), to: code("to"), date }));
    return;
  }
  const origin = parsePoint(url.searchParams.get("origin"));
  const dest = parsePoint(url.searchParams.get("dest"));
  if (!origin || !dest) {
    json(res, 400, { error: "Podaj współrzędne początku i celu." });
    return;
  }
  if (back && date && back < date) {
    json(res, 400, { error: "Powrót nie może być przed wyjazdem." });
    return;
  }
  const radius = url.searchParams.get("radius") === "any" ? 5000 : Number(url.searchParams.get("radius")) || undefined;
  const prefer = (url.searchParams.get("prefer") || "").toUpperCase();
  json(res, 200, flights.options({ origin, dest, date, back, radius, prefer }));
}

// A trip search asks the airlines only about its own routes and days, and the same day of a route at most every 6 hours.
// A day of a route is asked again when its last check is more than 3 hours old (the same rule as for Wizz Air).
const TRIP_FETCH_FRESH_MS = 3 * 60 * 60 * 1000;
async function fetchTripFlights(req, res, collector, flights, asked, wizz = null) {
  const { origin = "", dest = "", date = "", back = "", prefer = "", radius = 0 } = await readJson(req);
  const preferred = /^[A-Z]{3}$/.test(String(prefer).toUpperCase()) ? String(prefer).toUpperCase() : "";
  const from = parsePoint(origin);
  const to = parsePoint(dest);
  const today = new Date().toISOString().slice(0, 10);
  const ahead = (day) => (Date.parse(day) - Date.parse(today)) / 86400000;
  if (!from || !to || !ISO_DAY.test(date) || (back && !ISO_DAY.test(back)) || ahead(date) < -1 || ahead(back || date) > PLAN_AHEAD_DAYS || (back && back < date)) {
    json(res, 400, { error: "Nieprawidłowe miejsca lub daty podróży." });
    return;
  }
  if (!flights || (!collector && !wizz)) {
    respondToRun(res, "unavailable");
    return;
  }
  const target = { scope: "trip", from: "", to: "", direction: back ? "both" : "out", start: date, end: back || date };
  // Wizz Air through its timetable: two weeks either side of the chosen days, for the routes Wizz flies.
  const wizzPairs = wizz ? flights.tripPairs({ origin: from, dest: to, prefer: preferred, radius: Number(radius) || undefined }).filter((pair) => pair.airlines.includes("WIZZ")) : [];
  const viaWizz = wizz && wizzPairs.length ? wizz.searchRoutes(wizzPairs, date, back) : "unavailable";
  const apis = viaWizz;
  const out = collector ? withoutWizz(flights.tripPairs({ origin: from, dest: to, prefer: preferred, radius: Number(radius) || undefined })) : [];
  if (!out.length) {
    if (apis === "started" || apis === "busy") respondToRun(res, apis);
    else if (apis === "fresh") json(res, 200, { started: false, reason: "fresh" });
    else json(res, 200, { started: false, reason: "no-routes" });
    return;
  }
  const now = Date.now();
  for (const [key, at] of asked) if (now - at >= TRIP_FETCH_FRESH_MS) asked.delete(key);
  const key = (pair, day) => `${pair.from}|${pair.to}|${day}`;
  const jobs = [{ pairs: out, start: date, end: date }, ...(back ? [{ pairs: withoutWizz(flights.returnPairs(out)), start: back, end: back }] : [])]
    .map((job) => ({ ...job, pairs: job.pairs.filter((pair) => !asked.has(key(pair, job.start))) }))
    .filter((job) => job.pairs.length);
  const codes = (list) => [...new Set(list)].join(",");
  Object.assign(target, { from: codes(out.map((pair) => pair.from)), to: codes(out.map((pair) => pair.to)) });
  const result = jobs.length ? collector.request({ jobs, target }) : "fresh";
  if (result === "started") for (const job of jobs) for (const pair of job.pairs) asked.set(key(pair, job.start), now);
  // Either source working is enough; the planner then waits for both.
  const best = [result, apis].find((r) => r === "started") || [result, apis].find((r) => r === "busy") || (result === "fresh" || apis === "fresh" ? "fresh" : "unavailable");
  if (best === "fresh") json(res, 200, { started: false, reason: "fresh" });
  else respondToRun(res, best);
}

// "Update the price" of one flight: the flight-tracker asks the airline about that route and day only.
// An explicit request may repeat a route and day after an hour, a trip search only after 6 hours.
const FARE_REFRESH_FRESH_MS = 60 * 60 * 1000;
async function refreshFare(req, res, collector, flights, asked) {
  const { from = "", to = "", day = "", back = "", airline = "" } = await readJson(req);
  const code = (value) => String(value).trim().toUpperCase();
  const a = code(from);
  const b = code(to);
  const today = new Date().toISOString().slice(0, 10);
  const ahead = (value) => (Date.parse(value) - Date.parse(today)) / 86400000;
  if (!/^[A-Z]{3}$/.test(a) || !/^[A-Z]{3}$/.test(b) || a === b || !ISO_DAY.test(day) || (back && !ISO_DAY.test(back)) || ahead(day) < 0 || ahead(back || day) > PLAN_AHEAD_DAYS || (back && back < day)) {
    json(res, 400, { error: "Nieprawidłowa trasa lub data lotu." });
    return;
  }
  if (!collector || !flights) {
    respondToRun(res, "unavailable");
    return;
  }
  if (code(airline) === "WIZZ") {
    json(res, 200, { started: false, reason: "wizz-blocked" });
    return;
  }
  const airlines = code(airline) === "RYANAIR" ? ["RYANAIR"] : [];
  const out = withoutWizz(flights.pairsFor({ from: a, to: b, airlines }));
  if (!out.length) {
    json(res, 200, { started: false, reason: "no-routes" });
    return;
  }
  const now = Date.now();
  const key = (pair, value) => `${pair.from}|${pair.to}|${value}`;
  const jobs = [{ pairs: out, start: day, end: day }, ...(back ? [{ pairs: withoutWizz(flights.returnPairs(out)), start: back, end: back }] : [])]
    .map((job) => ({ ...job, pairs: job.pairs.filter((pair) => !(now - (asked.get(key(pair, job.start)) || 0) < FARE_REFRESH_FRESH_MS)) }))
    .filter((job) => job.pairs.length);
  if (!jobs.length) {
    json(res, 200, { started: false, reason: "fresh" });
    return;
  }
  const result = collector.request({ jobs, target: { scope: "trip", from: a, to: b, direction: back ? "both" : "out", start: day, end: back || day } });
  if (result === "started") for (const job of jobs) for (const pair of job.pairs) asked.set(key(pair, job.start), now);
  respondToRun(res, result);
}

// Fuel price used to compare driving with the train. FUEL_PRICE_PB95 / _ON / _LPG override the defaults.
const FUEL_DEFAULTS = { pb95: 6.04, on: 7.74, lpg: null, date: "2026-11-10", source: "Ministerstwo Energii — maksymalna cena detaliczna" };
function fuelPrices(env = process.env) {
  const value = (name, fallback) => {
    const number = Number(String(env[name] || "").replace(",", "."));
    return number > 0 && number < 50 ? number : fallback;
  };
  const custom = ["FUEL_PRICE_PB95", "FUEL_PRICE_ON", "FUEL_PRICE_LPG"].some((name) => env[name]);
  return {
    pb95: value("FUEL_PRICE_PB95", FUEL_DEFAULTS.pb95),
    on: value("FUEL_PRICE_ON", FUEL_DEFAULTS.on),
    lpg: value("FUEL_PRICE_LPG", FUEL_DEFAULTS.lpg),
    date: custom ? env.FUEL_PRICE_DATE || "" : FUEL_DEFAULTS.date,
    source: custom ? env.FUEL_PRICE_SOURCE || "ustawienia serwera" : FUEL_DEFAULTS.source,
  };
}

// Price alerts of the signed-in user: list, add, remove.
async function serveAlerts(req, res, alerts, segments) {
  if (!alerts) {
    json(res, 503, { error: "Alerty cenowe są niedostępne na tym serwerze." });
    return;
  }
  try {
    if (segments.length === 2 && req.method === "GET") {
      json(res, 200, { alerts: await alerts.list(req.user.id) });
      return;
    }
    if (segments.length === 2 && req.method === "POST") {
      requireSameOrigin(req);
      json(res, 201, { alert: await alerts.create(req.user.id, await readJson(req)) });
      return;
    }
    if (segments.length === 3 && req.method === "DELETE") {
      requireSameOrigin(req);
      await alerts.remove(req.user.id, segments[2]);
      res.writeHead(204);
      res.end();
      return;
    }
    res.setHeader("Allow", "GET, POST, DELETE");
    json(res, 405, { error: "Method not allowed." });
  } catch (error) {
    if (error.status && error.status < 500) json(res, error.status, { error: error.message });
    else throw error;
  }
}

// Wizz Air shows the tracker's automated browser "no flights", so its prices are not scraped automatically.
// They come from the API.SH provider (if configured) and from what an administrator imports from a normal browser.
const withoutWizz = (pairs) => pairs.map((pair) => ({ ...pair, airlines: pair.airlines.filter((airline) => airline !== "WIZZ") })).filter((pair) => pair.airlines.length);

// PKS ticket price between two timetable stops (name and position), from the PKS journey planner.
async function servePksPrice(res, url, pksFares) {
  const q = (name) => url.searchParams.get(name) || "";
  const stop = (prefix) => ({ name: q(prefix).slice(0, 80), lat: Number(q(prefix + "Lat")), lon: Number(q(prefix + "Lon")) });
  const from = stop("from"), to = stop("to"), day = q("day");
  if (!from.name || !to.name || ![from.lat, from.lon, to.lat, to.lon].every(Number.isFinite) || !ISO_DAY.test(day)) {
    json(res, 400, { error: "Podaj przystanki i dzień." });
    return;
  }
  try {
    json(res, 200, await pksFares.price({ from, to, day, time: q("time").slice(0, 5), line: q("line").slice(0, 10) }));
  } catch (error) {
    json(res, error.status === 429 || error.status === 403 ? 429 : 502, { error: error.message, price: null });
  }
}

// A signed-in user's own settings, such as the airports and airlines chosen on the destinations map.
async function servePreferences(req, res, auth) {
  if (req.method === "GET") {
    json(res, 200, { preferences: auth.getPreferences ? await auth.getPreferences(req.user.id) : {} });
    return;
  }
  if (req.method === "PUT") {
    requireSameOrigin(req);
    const { preferences = {} } = await readJson(req, 64 * 1024);
    if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) {
      json(res, 400, { error: "Nieprawidłowe ustawienia." });
      return;
    }
    await auth.savePreferences(req.user.id, preferences);
    json(res, 200, { saved: true });
    return;
  }
  res.setHeader("Allow", "GET, PUT");
  json(res, 405, { error: "Method not allowed." });
}

function respondToRun(res, result) {
  if (result === "unavailable") json(res, 503, { error: "Na tym serwerze nie działa pobieranie lotów." });
  else if (result === "busy") json(res, 409, { error: "Loty są już pobierane." });
  else json(res, 202, { started: true });
}

async function serveDriving(res, url, drive) {
  const from = parsePoint(url.searchParams.get("from"));
  const to = parsePoint(url.searchParams.get("to"));
  if (!from || !to) {
    json(res, 400, { error: "Podaj współrzędne początku i celu." });
    return;
  }
  try {
    json(res, 200, { route: await drive(from, to) });
  } catch (error) {
    console.error("Driving route failed:", error.message);
    json(res, 502, { error: "Wyznaczanie trasy jest chwilowo niedostępne." });
  }
}

async function servePath(res, url, findPath) {
  const mode = url.searchParams.get("mode");
  const from = parsePoint(url.searchParams.get("from"));
  const to = parsePoint(url.searchParams.get("to"));
  if (!Object.hasOwn(PATH_URLS, mode || "") || !from || !to) {
    json(res, 400, { error: "Podaj rodzaj trasy oraz współrzędne początku i celu." });
    return;
  }
  try {
    json(res, 200, { points: await findPath(mode, from, to) });
  } catch (error) {
    console.error("Route path failed:", error.message);
    json(res, 502, { error: "Wyznaczanie trasy jest chwilowo niedostępne." });
  }
}

// to: up to 25 stops as lat,lon;lat,lon. Answers metres on foot, null where no path was found.
async function serveWalk(res, url, walkDistances) {
  const from = parsePoint(url.searchParams.get("from"));
  const targets = String(url.searchParams.get("to") || "").split(";").filter(Boolean).map(parsePoint);
  if (!from || !targets.length || targets.length > MAX_WALK_TARGETS || targets.some((p) => !p)) {
    json(res, 400, { error: `Podaj punkt startu i do ${MAX_WALK_TARGETS} przystanków.` });
    return;
  }
  try {
    json(res, 200, { meters: await walkDistances(from, targets) });
  } catch (error) {
    console.error("Walking distances failed:", error.message);
    json(res, 502, { error: "Wyznaczanie dojścia jest chwilowo niedostępne." });
  }
}

function serveStatic(res, pathname, root) {
  if (pathname === "/koncowe") {
    res.writeHead(301, { Location: "/podroz" });
    res.end();
    return;
  }
  const isLoginPage = pathname === "/login";
  const isAppPage = APP_PAGES.has(pathname);
  const isLoginAsset = pathname === "/assets/login.css" || pathname === "/assets/login.js" || pathname === "/assets/i18n.js";
  const isLogo = /^\/assets\/logo(-\d+)?\.png$/.test(pathname); // the app logo, in the sizes it is used
  if (!isAppPage && !isLoginPage && !pathname.startsWith("/assets/")) {
    json(res, 404, { error: "Not found." });
    return;
  }
  if (pathname.startsWith("/assets/") && !isLoginAsset && !isLogo && !pathname.startsWith("/assets/app.")) {
    json(res, 404, { error: "Not found." });
    return;
  }
  const requestedPath = isAppPage ? "/index.html" : isLoginPage ? "/login.html" : pathname;
  const filePath = path.resolve(root, `.${requestedPath}`);
  if (!filePath.startsWith(`${root}${path.sep}`)) {
    json(res, 403, { error: "Forbidden." });
    return;
  }
  if (!isLoginPage && !isAppPage && !filePath.startsWith(`${path.resolve(root, "assets")}${path.sep}`)) {
    json(res, 404, { error: "Not found." });
    return;
  }
  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) {
      json(res, 404, { error: "Not found." });
      return;
    }
    // The browser keeps the file and only asks whether it changed (304), so reloads are quick but edits show at once.
    const etag = `W/"${stats.size.toString(36)}-${Math.round(stats.mtimeMs).toString(36)}"`;
    const ext = path.extname(filePath);
    const base = {
      "Content-Type": MIME_TYPES.get(ext) || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Cache-Control": "no-cache",
      ETag: etag,
      Vary: "Accept-Encoding",
    };
    if (res.req?.headers?.["if-none-match"] === etag) {
      res.writeHead(304, base);
      res.end();
      return;
    }
    const gzip = COMPRESSIBLE.has(ext) && stats.size > 1024 && acceptsGzip(res.req);
    res.writeHead(200, gzip ? { ...base, "Content-Encoding": "gzip" } : base);
    const streams = gzip ? [fs.createReadStream(filePath), zlib.createGzip({ level: 6 }), res] : [fs.createReadStream(filePath), res];
    pipeline(...streams).catch(() => {
      if (!res.headersSent) json(res, 500, { error: "Unable to serve the requested file." });
    });
  });
}

async function googleLogin(req, res, auth, url) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const baseUrl = process.env.APP_BASE_URL;
  if (!clientId || !clientSecret || !baseUrl) {
    json(res, 503, { error: "Logowanie przez Google nie jest skonfigurowane." });
    return;
  }
  const state = crypto.randomBytes(32).toString("base64url");
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const returnTo = safeReturnTo(url.searchParams.get("returnTo"));
  await auth.saveOAuthState(state, verifier, returnTo);
  setOAuthCookie(res, state);

  const redirectUri = `${baseUrl.replace(/\/+$/, "")}/api/auth/google/callback`;
  const authorization = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorization.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  authRedirect(res, authorization.toString());
}

async function googleCallback(req, res, auth, url) {
  if (url.searchParams.has("error")) {
    clearOAuthCookie(res);
    authRedirect(res, "/login", "?error=google_signin_failed");
    return;
  }
  const returnedState = url.searchParams.get("state");
  if (!constantTimeEqual(readCookie(req, OAUTH_COOKIE), returnedState)) {
    clearOAuthCookie(res);
    authRedirect(res, "/login", "?error=google_signin_failed");
    return;
  }
  const state = await auth.consumeOAuthState(returnedState);
  const code = url.searchParams.get("code");
  if (!state || !code) {
    clearOAuthCookie(res);
    authRedirect(res, "/login", "?error=google_signin_failed");
    return;
  }

  const baseUrl = process.env.APP_BASE_URL.replace(/\/+$/, "");
  const redirectUri = `${baseUrl}/api/auth/google/callback`;
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      code,
      code_verifier: state.codeVerifier,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!tokenResponse.ok) throw new AuthError("Nie udało się dokończyć logowania przez Google.", 401);
  const token = await tokenResponse.json();
  if (!token.access_token) throw new AuthError("Google zwróciło nieprawidłową odpowiedź.", 401);

  const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${token.access_token}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!profileResponse.ok) throw new AuthError("Nie udało się dokończyć logowania przez Google.", 401);
  const profile = await profileResponse.json();
  if (profile.email_verified !== true || !profile.sub || !profile.email) {
    throw new AuthError("Użyj konta Google ze zweryfikowanym adresem e-mail.", 401);
  }

  const result = await auth.signInWithGoogle({
    subject: profile.sub,
    email: profile.email,
    displayName: profile.name,
  });
  setSessionCookie(res, result.session.token);
  clearOAuthCookie(res);
  authRedirect(res, safeReturnTo(state.returnTo));
}

async function handleAuth(req, res, url, auth) {
  const route = url.pathname;
  if (route === "/api/auth/config" && req.method === "GET") {
    json(res, 200, {
      googleEnabled: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.APP_BASE_URL),
      emailEnabled: isEmailConfigured(),
    });
    return true;
  }
  if (route === "/api/auth/me" && req.method === "GET") {
    const user = await auth.resolveSession(readCookie(req, SESSION_COOKIE));
    json(res, 200, { user: user && { ...user, canAdminister: isAppAdmin(user) } });
    return true;
  }
  if (route === "/api/auth/register" && req.method === "POST") {
    requireSameOrigin(req);
    if (!takeAuthAttempt(req)) {
      json(res, 429, { error: "Zbyt wiele prób. Spróbuj ponownie za 15 minut." });
      return true;
    }
    await auth.startEmailVerification(await readJson(req, MAX_AUTH_BODY_BYTES));
    json(res, 202, { codeSent: true });
    return true;
  }
  if (route === "/api/auth/verify-email" && req.method === "POST") {
    requireSameOrigin(req);
    if (!takeAuthAttempt(req)) {
      json(res, 429, { error: "Zbyt wiele prób. Spróbuj ponownie za 15 minut." });
      return true;
    }
    const result = await auth.verifyEmail(await readJson(req, MAX_AUTH_BODY_BYTES));
    setSessionCookie(res, result.session.token);
    json(res, 201, { user: result.user });
    return true;
  }
  if (route === "/api/auth/forgot-password" && req.method === "POST") {
    requireSameOrigin(req);
    if (!takeAuthAttempt(req)) {
      json(res, 429, { error: "Zbyt wiele prób. Spróbuj ponownie za 15 minut." });
      return true;
    }
    const { email } = await readJson(req, MAX_AUTH_BODY_BYTES);
    await auth.startPasswordReset(email);
    json(res, 200, { requested: true });
    return true;
  }
  if (route === "/api/auth/reset-password" && req.method === "POST") {
    requireSameOrigin(req);
    if (!takeAuthAttempt(req)) {
      json(res, 429, { error: "Zbyt wiele prób. Spróbuj ponownie za 15 minut." });
      return true;
    }
    await auth.resetPassword(await readJson(req, MAX_AUTH_BODY_BYTES));
    json(res, 200, { reset: true });
    return true;
  }
  if (route === "/api/auth/account/delete" && req.method === "POST") {
    requireSameOrigin(req);
    if (!takeAuthAttempt(req)) {
      json(res, 429, { error: "Zbyt wiele prób. Spróbuj ponownie za 15 minut." });
      return true;
    }
    await readJson(req, MAX_AUTH_BODY_BYTES);
    const user = await auth.resolveSession(readCookie(req, SESSION_COOKIE));
    if (!user) {
      json(res, 401, { error: "Zaloguj się, aby kontynuować." });
      return true;
    }
    await auth.startAccountDeletion(user.id);
    json(res, 200, { codeSent: true });
    return true;
  }
  if (route === "/api/auth/account/delete/confirm" && req.method === "POST") {
    requireSameOrigin(req);
    if (!takeAuthAttempt(req)) {
      json(res, 429, { error: "Zbyt wiele prób. Spróbuj ponownie za 15 minut." });
      return true;
    }
    const user = await auth.resolveSession(readCookie(req, SESSION_COOKIE));
    if (!user) {
      json(res, 401, { error: "Zaloguj się, aby kontynuować." });
      return true;
    }
    const { code } = await readJson(req, MAX_AUTH_BODY_BYTES);
    await auth.confirmAccountDeletion(user.id, code);
    clearSessionCookie(res);
    json(res, 200, { deleted: true });
    return true;
  }
  if (route === "/api/auth/login" && req.method === "POST") {
    requireSameOrigin(req);
    if (!takeAuthAttempt(req)) {
      json(res, 429, { error: "Zbyt wiele prób. Spróbuj ponownie za 15 minut." });
      return true;
    }
    const result = await auth.loginWithPassword(await readJson(req, MAX_AUTH_BODY_BYTES));
    setSessionCookie(res, result.session.token);
    json(res, 200, { user: result.user });
    return true;
  }
  if (route === "/api/auth/logout" && req.method === "POST") {
    requireSameOrigin(req);
    await auth.revokeSession(readCookie(req, SESSION_COOKIE));
    clearSessionCookie(res);
    json(res, 200, { signedOut: true });
    return true;
  }
  if (route === "/api/auth/google" && req.method === "GET") {
    await googleLogin(req, res, auth, url);
    return true;
  }
  if (route === "/api/auth/google/callback" && req.method === "GET") {
    try {
      await googleCallback(req, res, auth, url);
    } catch (error) {
      if (error.statusCode >= 500) console.error("Google sign-in failed:", error.message);
      clearOAuthCookie(res);
      authRedirect(
        res,
        "/login",
        error.statusCode === 409 ? "?error=google_account_exists" : "?error=google_signin_failed",
      );
    }
    return true;
  }
  return false;
}

// Every visitor request ends here: it reads the database and never reaches an outside service.
async function serveSnapshot(req, res, snapshots, key, maxAgeMs = Infinity) {
  const info = key ? await snapshots?.info(key) : null;
  if (!info || ageOf(info, Date.now()) > maxAgeMs) {
    json(res, 503, { error: "Dane są chwilowo niedostępne." });
    return;
  }
  const headers = { ETag: info.etag, "Cache-Control": "no-cache", "X-Fetched-At": new Date(info.fetchedAt).toISOString(), "X-Content-Type-Options": "nosniff" };
  if (req.headers["if-none-match"] === info.etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  const body = await snapshots.read(key);
  res.writeHead(200, { ...headers, "Content-Type": info.type, "Content-Encoding": "gzip", "Content-Length": body.length });
  res.end(body);
}

async function serveTimetable(req, res, agency, timetables) {
  const feed = await timetables?.get(agency);
  if (!feed) {
    json(res, 503, { error: "Rozkład jest chwilowo niedostępny." });
    return;
  }
  const headers = { ETag: feed.etag, "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff" };
  if (req.headers["if-none-match"] === feed.etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  res.writeHead(200, { ...headers, "Content-Type": "application/zip", "Content-Length": feed.buffer.length });
  res.end(feed.buffer);
}

function isAppAdmin(user) {
  const admins = (process.env.ADMIN_EMAILS || "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean);
  return Boolean(user.isAdmin || admins.includes(String(user.email).toLowerCase()));
}

// The saved key is never sent back: an administrator can replace it but not read it.
async function servePlkKey(req, res, plk) {
  if (!isAppAdmin(req.user)) {
    json(res, 403, { error: "Klucz może zmienić tylko administrator." });
    return;
  }
  if (!plk) {
    json(res, 503, { error: "Pociągi nie są skonfigurowane na tym serwerze." });
    return;
  }
  if (req.method === "GET") {
    json(res, 200, await plk.status());
    return;
  }
  if (req.method !== "PUT") {
    res.setHeader("Allow", "GET, PUT");
    json(res, 405, { error: "Method not allowed." });
    return;
  }
  requireSameOrigin(req);
  const { key } = await readJson(req);
  const value = typeof key === "string" ? key.trim() : "";
  if (!value || value.length > PLK_KEY_MAX_LENGTH) {
    json(res, 400, { error: "Wklej klucz API PKP PLK." });
    return;
  }
  try {
    if (await plk.setKey(value)) json(res, 200, { saved: true });
    else json(res, 422, { error: "PKP PLK odrzuciło ten klucz. Sprawdź, czy jest poprawny." });
  } catch (error) {
    console.error("Rail key could not be saved:", error.message);
    json(res, 502, { error: "Nie udało się sprawdzić ani zapisać klucza. Spróbuj ponownie." });
  }
}

async function proxyGtfsSource(res, url, fetchSource = fetch) {
  const sourceValue = url.searchParams.get("url");
  if (!sourceValue || sourceValue.length > 2048) {
    json(res, 400, { error: "A valid GTFS source URL is required." });
    return;
  }
  let source;
  try {
    source = new URL(sourceValue);
  } catch {
    json(res, 400, { error: "A valid GTFS source URL is required." });
    return;
  }
  const allowedPaths = GTFS_SOURCE_PATHS.get(source.hostname.toLowerCase());
  if (source.protocol !== "https:" || source.username || source.password || !allowedPaths?.has(source.pathname)) {
    json(res, 403, { error: "This GTFS source is not allowed." });
    return;
  }
  source.hash = "";
  const upstream = await fetchSource(source, {
    headers: { Accept: "application/octet-stream, application/zip" },
    redirect: "error",
    signal: AbortSignal.timeout(60000),
  });
  if (!upstream.ok) {
    json(res, 502, { error: `GTFS source returned HTTP ${upstream.status}.` });
    return;
  }
  const contentLength = Number(upstream.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_FEED_BYTES) {
    json(res, 413, { error: "GTFS source exceeds the 50 MB limit." });
    return;
  }
  const bytes = Buffer.from(await upstream.arrayBuffer());
  if (bytes.length === 0) {
    json(res, 502, { error: "GTFS source returned an empty response." });
    return;
  }
  if (bytes.length > MAX_FEED_BYTES) {
    json(res, 413, { error: "GTFS source exceeds the 50 MB limit." });
    return;
  }
  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Length": bytes.length,
    "Cache-Control": "private, max-age=60",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(bytes);
}

function createServer({ database, auth, fetchSource = fetch, geocode = createGeocoder({ fetchSource }), suggestStreets = createStreetSuggester({ fetchSource }), timetables = null, snapshots = null, plk = null, flights = null, collector = null, drive = createDrivingRouter({ fetchSource }), findPath = createPathRouter({ fetchSource }), walkDistances = createWalkTable({ fetchSource }), alerts = null, fareRates = createRates({ fetchSource }), wizz = null, pksFares = createPksFares({ fetchSource }), tripWeather = createTripWeather({ fetchSource }), transfers = null, staticRoot = ROOT }) {
  const airportTransfers = transfers || createAirportTransfers({ fetchSource, toPln: fareRates, geocode, snapshots });
  const root = path.resolve(staticRoot);
  const tripAsked = new Map(); // route and day → when a trip search last asked the airlines
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

      if (url.pathname.startsWith("/api/auth/")) {
        if (await handleAuth(req, res, url, auth)) return;
        json(res, 404, { error: "Authentication endpoint not found." });
        return;
      }

      if (segments[0] === "api") {
        if (segments[1] === "health" && req.method === "GET") {
          await database.health();
          json(res, 200, { status: "ok", database: "connected" });
          return;
        }
        const publicRoute = req.method === "GET" && (
          (segments[1] === "streets" && segments.length === 2)
          || (segments[1] === "geocode" && segments.length === 2)
          || (segments[1] === "feeds" && segments[2] === "fetch" && segments.length === 3)
          || (segments[1] === "timetable" && segments.length === 3 && AGENCIES.has(segments[2]))
          || (segments[1] === "schedule" && segments.length === 3 && AGENCIES.has(segments[2]))
          || (segments[1] === "plk" && segments.length === 3 && PLK_ROUTES.has(segments[2]))
          || (segments[1] === "live" && segments.length === 3 && Object.hasOwn(LIVE_SOURCES, segments[2]))
          || (segments[1] === "flights" && (segments.length === 2 || (segments.length === 3 && ["options", "status", "network"].includes(segments[2]))))
          || (segments[1] === "driving" && segments.length === 2)
          || (segments[1] === "path" && segments.length === 2)
          || (segments[1] === "walk" && segments.length === 2)
          || (segments[1] === "fuel" && segments.length === 2)
          || (segments[1] === "pks-price" && segments.length === 2)
          || (segments[1] === "weather" && segments.length === 2)
          || (segments[1] === "airport-transfers" && (segments.length === 2 || (segments.length === 3 && segments[2] === "connections")))
        ) ? (segments[1] === "feeds" ? "feeds" : segments[1] === "airport-transfers" ? (segments[2] ? "transfer-trips" : "transfers") : segments[1]) : null;
        if (publicRoute && !takePublicRequest(req, publicRoute)) {
          json(res, 429, { error: "Zbyt wiele zapytań. Spróbuj ponownie za chwilę." });
          return;
        }
        if (publicRoute === "schedule") {
          await serveSnapshot(req, res, snapshots, `schedule:${segments[2]}`);
          return;
        }
        if (publicRoute === "timetable") {
          await serveTimetable(req, res, segments[2], timetables);
          return;
        }
        if (publicRoute === "live") {
          await serveSnapshot(req, res, snapshots, `live:${segments[2]}`, LIVE_SOURCES[segments[2]].maxAgeMs);
          return;
        }
        if (publicRoute === "plk") {
          await serveSnapshot(req, res, snapshots, segments[2] === "operations" ? OPERATIONS_KEY : scheduleKey(url.searchParams.get("date")));
          return;
        }
        if (publicRoute === "flights" && segments[2] === "status") {
          const a = collector ? collector.status() : { available: false, running: false };
          // The admin panel reads the tracker; a trip search waits for both.
          const w = wizz ? wizz.status() : { available: false, running: false };
          json(res, 200, { ...a, available: a.available || w.available, running: a.running || w.running, tracker: a, wizz: w });
          return;
        }
        if (publicRoute === "flights" && segments[2] === "network") {
          json(res, 200, flights ? flights.network() : { airports: [], routes: [] });
          return;
        }
        if (publicRoute === "flights") {
          serveFlights(res, url, segments[2], flights);
          return;
        }
        if (publicRoute === "transfers") {
          try {
            json(res, 200, await airportTransfers.lookup((url.searchParams.get("codes") || "").split(",")));
          } catch (error) {
            json(res, 502, { error: error.message, transfers: [] });
          }
          return;
        }
        if (publicRoute === "transfer-trips") {
          try {
            const q = (name) => url.searchParams.get(name) || "";
            json(res, 200, await airportTransfers.connections({ code: q("code"), lat: Number(q("lat")), lon: Number(q("lon")), time: q("time"), dir: q("dir") || "from", label: q("label") }));
          } catch (error) {
            json(res, [400, 404].includes(error.status) ? error.status : 502, { error: error.message, trips: [] });
          }
          return;
        }
        if (publicRoute === "weather") {
          try {
            const n = (name) => Number(url.searchParams.get(name));
            json(res, 200, await tripWeather.forecast({ lat: n("lat"), lon: n("lon"), from: url.searchParams.get("from") || "", to: url.searchParams.get("to") || "" }));
          } catch (error) {
            json(res, error.status === 400 ? 400 : 502, { error: error.message, days: [] });
          }
          return;
        }
        if (publicRoute === "pks-price") {
          await servePksPrice(res, url, pksFares);
          return;
        }
        if (publicRoute === "fuel") {
          json(res, 200, fuelPrices());
          return;
        }
        if (publicRoute === "driving") {
          await serveDriving(res, url, drive);
          return;
        }
        if (publicRoute === "path") {
          await servePath(res, url, findPath);
          return;
        }
        if (publicRoute === "walk") {
          await serveWalk(res, url, walkDistances);
          return;
        }
        if (segments[1] === "streets" && segments.length === 2 && req.method === "GET") {
          const query = url.searchParams.get("q")?.trim() || "";
          if (query.length < 2 || query.length > 80) {
            json(res, 400, { error: "Wpisz od 2 do 80 znaków." });
            return;
          }
          try {
            json(res, 200, { suggestions: await suggestStreets(query) });
          } catch (error) {
            console.error("Street suggestions failed:", error.message);
            json(res, 502, { error: "Podpowiedzi ulic są chwilowo niedostępne." });
          }
          return;
        }
        if (segments[1] === "geocode" && segments.length === 2 && req.method === "GET") {
          const query = url.searchParams.get("q")?.trim() || "";
          if (query.length < 2 || query.length > 120) {
            json(res, 400, { error: "Wpisz od 2 do 120 znaków." });
            return;
          }
          try {
            json(res, 200, await geocode(query, { world: url.searchParams.get("scope") === "world" }));
          } catch (error) {
            console.error("Street search failed:", error.message);
            json(res, 502, { error: "Wyszukiwarka ulic jest chwilowo niedostępna." });
          }
          return;
        }
        if (segments[1] === "feeds" && segments[2] === "fetch" && segments.length === 3 && req.method === "GET") {
          await proxyGtfsSource(res, url, fetchSource);
          return;
        }
        req.user = await auth.resolveSession(readCookie(req, SESSION_COOKIE));
        if (!req.user) {
          json(res, 401, { error: "Zaloguj się, aby kontynuować." });
          return;
        }
        if (segments[1] === "flights" && segments[2] === "trip" && segments.length === 3) {
          if (req.method !== "POST") {
            res.setHeader("Allow", "POST");
            json(res, 405, { error: "Method not allowed." });
            return;
          }
          requireSameOrigin(req);
          await fetchTripFlights(req, res, collector, flights, tripAsked, wizz);
          return;
        }
        if (segments[1] === "preferences" && segments.length === 2) {
          await servePreferences(req, res, auth);
          return;
        }
        if (segments[1] === "alerts" && segments.length <= 3) {
          await serveAlerts(req, res, alerts, segments);
          return;
        }
        if (segments[1] === "flights" && segments[2] === "wizz-time" && segments.length === 3) {
          if (req.method !== "POST") {
            res.setHeader("Allow", "POST");
            json(res, 405, { error: "Method not allowed." });
            return;
          }
          requireSameOrigin(req);
          if (!wizz) {
            json(res, 503, { error: "Zapytania do Wizz Air są wyłączone." });
            return;
          }
          const { from = "", to = "", time = "" } = await readJson(req);
          try {
            json(res, 200, await wizz.priceForTime({ from: String(from).toUpperCase(), to: String(to).toUpperCase(), time: String(time) }));
          } catch (error) {
            json(res, error.status && error.status < 600 ? error.status : 502, { error: error.message });
          }
          return;
        }
        if (segments[1] === "flights" && segments[2] === "fare" && segments.length === 3) {
          if (req.method !== "POST") {
            res.setHeader("Allow", "POST");
            json(res, 405, { error: "Method not allowed." });
            return;
          }
          requireSameOrigin(req);
          await refreshFare(req, res, collector, flights, tripAsked);
          return;
        }
        if (segments[1] === "settings" && segments[2] === "plk-key" && segments.length === 3) {
          await servePlkKey(req, res, plk);
          return;
        }
        if (segments[1] === "favorites" && segments.length === 2) {
          if (req.method === "GET") {
            json(res, 200, { favorites: await auth.getFavorites(req.user.id) });
            return;
          }
          if (req.method === "PUT") {
            requireSameOrigin(req);
            const { favorites } = await readJson(req, MAX_FAVORITES_BYTES);
            const saved = normalizeFavorites(favorites);
            await auth.saveFavorites(req.user.id, saved);
            json(res, 200, { favorites: saved });
            return;
          }
          res.setHeader("Allow", "GET, PUT");
          json(res, 405, { error: "Method not allowed." });
          return;
        }
        if (segments[1] === "gtfs" && segments.length === 3 && AGENCIES.has(segments[2])) {
          const agency = segments[2];
          if (req.method === "GET") {
            const sourceKey = url.searchParams.get("sourceKey");
            if (!sourceKey) {
              json(res, 400, { error: "sourceKey is required." });
              return;
            }
            const schedule = await database.getSchedule(agency, sourceKey);
            if (!schedule) {
              json(res, 404, { error: "No current schedule matches this source." });
              return;
            }
            json(res, 200, schedule);
            return;
          }
          if (req.method === "POST") {
            if (!req.user.isAdmin) {
              json(res, 403, { error: "Administrator access is required to import shared schedules." });
              return;
            }
            const payload = await readJson(req);
            await database.replaceSchedule(agency, payload);
            json(res, 201, { saved: true });
            return;
          }
          res.setHeader("Allow", "GET, POST");
          json(res, 405, { error: "Method not allowed." });
          return;
        }
        json(res, 404, { error: "API endpoint not found." });
        return;
      }

      if (url.pathname === "/login") {
        const user = await auth.resolveSession(readCookie(req, SESSION_COOKIE));
        if (user) {
          authRedirect(res, safeReturnTo(url.searchParams.get("returnTo")));
          return;
        }
        serveStatic(res, url.pathname, root);
        return;
      }
      if (url.pathname === "/assets/login.css" || url.pathname === "/assets/login.js") {
        serveStatic(res, url.pathname, root);
        return;
      }
      serveStatic(res, url.pathname, root);
    } catch (error) {
      if (res.headersSent) {
        res.destroy(error);
        return;
      }
      const status = error.statusCode || (error instanceof TypeError ? 400 : 500);
      if (status >= 500) console.error("Request failed:", error.message);
      json(res, status, { error: status >= 500 ? "Nie udało się wykonać żądania." : error.message });
    }
  });
}

// Networks that inspect HTTPS (such as Zscaler) re-sign traffic with a root that only the OS trusts.
function trustSystemCertificates() {
  if (typeof tls.getCACertificates !== "function" || typeof tls.setDefaultCACertificates !== "function") return;
  tls.setDefaultCACertificates([...new Set([...tls.getCACertificates("default"), ...tls.getCACertificates("system")])]);
}

async function main() {
  trustSystemCertificates();
  const sql = require("mssql");
  const pool = await new sql.ConnectionPool(createSqlConfig()).connect();
  const auth = createAuthService(pool);
  const timetables = createTimetableStore();
  timetables.start();
  const snapshots = createSnapshots(pool);
  const schedules = createScheduleStore({
    timetables,
    snapshots,
    database: {
      importedHash: (agency) => importedHash(pool, agency),
      read: (agency) => readSchedule(pool, agency),
      replace: (agency, payload) => replaceSchedule(pool, agency, payload),
    },
  });
  schedules.start();
  const plk = createPlkCollector({ snapshots, readKey: () => readSetting(pool, PLK_KEY_SETTING), saveKey: (value) => saveSetting(pool, PLK_KEY_SETTING, value) });
  plk.start();
  const live = createLiveCollector({ snapshots });
  live.start();
  const trackerDir = process.env.FLIGHT_TRACKER_DIR;
  const flights = createFlightStore({
    file: process.env.FLIGHT_FARES_FILE || (trackerDir ? trackerDatabase(trackerDir) : ""),
    database: {
      readFares: (day) => readFlightFares(pool, day),
      replaceFares: (rows) => replaceFlightFares(pool, rows),
      appendHistory: (rows) => appendFareHistory(pool, rows),
      readNetwork: () => readFlightNetwork(pool),
      saveNetwork: (network) => saveFlightNetwork(pool, network),
    },
  });
  flights.start();
  const collector = createFlightCollector({
    flights,
    updateNetwork: async ({ force = false } = {}) => {
      if (force || flights.networkIsStale()) await flights.saveNetwork(await readNetwork({ dir: trackerDir, previous: flights.network() }));
    },
  });
  // Wizz Air timetable: the working API version is found at start and remembered in the database.
  const wizz = createWizzTimetable({ flights, toPln: createRates(), readVersion: () => readSetting(pool, "wizz-api-version").then((r) => r?.value || null), saveVersion: (v) => saveSetting(pool, "wizz-api-version", v) });
  wizz.start();
  const alerts = createPriceAlerts({ db: createAlertDatabase(pool), flights, collector, sendEmail: (message) => auth.sendNotice(message) });
  alerts.start();
  const transfers = createAirportTransfers({
    snapshots,
    toPln: createRates(),
    geocode: createGeocoder(),
    database: {
      read: () => readAirportTransfers(pool),
      replace: (rows) => replaceAirportTransfers(pool, rows),
      readSetting: (key) => readSetting(pool, key),
      saveSetting: (key, value) => saveSetting(pool, key, value),
    },
  });
  transfers.ready().catch((error) => console.warn("Airport transfers could not load:", error.message));
  const server = createServer({
    auth,
    transfers,
    timetables,
    snapshots,
    plk,
    flights,
    collector,
    alerts,
    wizz,
    database: {
      health: async () => pool.request().query("SELECT 1 AS ok"),
      getSchedule: (agency, sourceKey) => getSchedule(pool, agency, sourceKey),
      replaceSchedule: (agency, payload) => replaceSchedule(pool, agency, payload),
    },
  });
  const port = Number(process.env.PORT || 3000);
  server.listen(port, () => console.log(`Komunikacja is listening on http://localhost:${port}`));
  const close = () => server.close(async () => {
    timetables.stop();
    schedules.stop();
    plk.stop();
    live.stop();
    flights.stop();
    alerts.stop();
    await pool.close();
    process.exit(0);
  });
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Unable to start the application:", error.message);
    process.exitCode = 1;
  });
}

module.exports = { createServer, proxyGtfsSource, readJson };
