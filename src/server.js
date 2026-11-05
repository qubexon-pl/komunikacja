"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const crypto = require("node:crypto");
const tls = require("node:tls");
const { AGENCIES, createSqlConfig, getSchedule, importedHash, readFlightFares, readFlightNetwork, readSchedule, replaceFlightFares, replaceSchedule, saveFlightNetwork } = require("./database");
const { createDrivingRouter, parsePoint } = require("./driving");
const { createFlightCollector, trackerDatabase } = require("./flight-collector");
const { readNetwork } = require("./flight-network");
const { createFlightStore } = require("./flights");
const { createGeocoder, createStreetSuggester } = require("./geocode");
const { normalizeFavorites } = require("./favorites");
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
]);
const MAX_BODY_BYTES = 100 * 1024 * 1024;
const MAX_AUTH_BODY_BYTES = 16 * 1024;
const MAX_FEED_BYTES = 50 * 1024 * 1024;
const SESSION_COOKIE = "rzbus_session";
const OAUTH_COOKIE = "rzbus_oauth_state";
const APP_PAGES = new Set(["/", "/autobusy", "/pks", "/pociagi", "/podroz"]);
const MAX_FAVORITES_BYTES = 64 * 1024;
const PLK_API = "https://pdp-api.plk-sa.pl/api/v1/";
const PLK_ROUTES = new Set(["schedules", "operations"]);
const PUBLIC_LIMITS = { streets: 120, geocode: 30, feeds: 120, timetable: 20, schedule: 20, plk: 60, flights: 120, driving: 30 };
const authAttempts = new Map();
const publicRequests = new Map();
const GTFS_SOURCE_PATHS = new Map([
  ["mkuran.pl", new Set(["/gtfs/rzeszow.zip"])],
  ["cdn.zbiorkom.live", new Set(["/gtfs/rzeszow.zip"])],
  ["kmrzeszow.live", new Set([
    "/gtfs/rt/gtfsrt.pb",
    "/gtfs/rt/pks/gtfsrt.pb",
    "/gtfs/pks/rt/gtfsrt.pb",
    "/gtfs/pks.zip",
    "/gtfs/pks/gtfs.zip",
  ])],
  ["www.mpkrzeszow.pl", new Set([
    "/gtfs/rt/gtfsrt.pb",
    "/gtfs/rt/pks/gtfsrt.pb",
    "/gtfs/pks.zip",
  ])],
]);

function json(res, status, value) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(value));
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
  const stay = Math.min(Math.max(Number.parseInt(url.searchParams.get("stay"), 10) || 0, 0), MAX_SCAN_DAYS);
  json(res, 200, flights.options({ origin, dest, date, stay, back }));
}

// Each run opens a browser and calls the airlines, so only administrators may start one.
async function refreshFlights(req, res, collector, flights) {
  if (!isFlightAdmin(req.user)) {
    json(res, 403, { error: "Odświeżanie lotów jest dostępne tylko dla administratora." });
    return;
  }
  const { from = "", to = "", start = "", end = "", airlines = [] } = await readJson(req);
  const iata = /^[A-Z]{3}$/;
  const scan = Boolean(from || to);
  if ((from && !iata.test(from)) || (to && !iata.test(to)) || !Array.isArray(airlines)) {
    json(res, 400, { error: "Nieprawidłowe lotnisko." });
    return;
  }
  const days = (Date.parse(end) - Date.parse(start)) / 86400000;
  if (scan && !(ISO_DAY.test(start) && ISO_DAY.test(end) && days >= 0 && days <= MAX_SCAN_DAYS)) {
    json(res, 400, { error: `Podaj okres do ${MAX_SCAN_DAYS} dni.` });
    return;
  }
  const pairs = scan ? flights.pairsFor({ from, to, airlines }) : null;
  if (scan && !pairs.length) {
    json(res, 400, { error: "Żadna z linii nie lata tą trasą." });
    return;
  }
  const result = collector ? collector.request(scan ? { pairs, start, end, target: { from, to, start, end } } : {}) : "unavailable";
  if (result === "unavailable") json(res, 503, { error: "Na tym serwerze nie działa pobieranie lotów." });
  else if (result === "busy") json(res, 409, { error: "Loty są już pobierane." });
  else json(res, 202, { started: true });
}

function isFlightAdmin(user) {
  const admins = (process.env.ADMIN_EMAILS || "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean);
  return Boolean(user.isAdmin || admins.includes(String(user.email).toLowerCase()));
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

function serveStatic(res, pathname, root) {
  if (pathname === "/koncowe") {
    res.writeHead(301, { Location: "/podroz" });
    res.end();
    return;
  }
  const isLoginPage = pathname === "/login";
  const isAppPage = APP_PAGES.has(pathname);
  const isLoginAsset = pathname === "/assets/login.css" || pathname === "/assets/login.js" || pathname === "/assets/i18n.js";
  if (!isAppPage && !isLoginPage && !pathname.startsWith("/assets/")) {
    json(res, 404, { error: "Not found." });
    return;
  }
  if (pathname.startsWith("/assets/") && !isLoginAsset && !pathname.startsWith("/assets/app.")) {
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
    res.writeHead(200, {
      "Content-Type": MIME_TYPES.get(path.extname(filePath)) || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Cache-Control": "no-store",
    });
    pipeline(fs.createReadStream(filePath), res).catch(() => {
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
    json(res, 200, { user });
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

function serveSchedule(req, res, agency, schedules) {
  const copy = schedules?.get(agency);
  if (!copy) {
    json(res, 503, { error: "Rozkład jest chwilowo niedostępny." });
    return;
  }
  const headers = { ETag: copy.etag, "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff" };
  if (req.headers["if-none-match"] === copy.etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  res.writeHead(200, { ...headers, "Content-Type": "application/json; charset=utf-8", "Content-Encoding": "gzip", "Content-Length": copy.body.length });
  res.end(copy.body);
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

// The rail API does not allow browser calls, and its key must not pass through third parties.
async function proxyPlk(req, res, url, route, fetchSource) {
  const key = req.headers["x-api-key"];
  if (!key) {
    json(res, 401, { error: "Brak klucza PKP PLK." });
    return;
  }
  try {
    const upstream = await fetchSource(new URL(`${PLK_API}${route}${url.search}`), {
      headers: { "X-API-Key": key, Accept: "application/json" },
      signal: AbortSignal.timeout(25000),
    });
    res.writeHead(upstream.status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(await upstream.text());
  } catch (error) {
    console.error("Rail API request failed:", error.message);
    json(res, 502, { error: "API PKP PLK jest chwilowo niedostępne." });
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

function createServer({ database, auth, fetchSource = fetch, geocode = createGeocoder({ fetchSource }), suggestStreets = createStreetSuggester({ fetchSource }), timetables = null, schedules = null, flights = null, collector = null, drive = createDrivingRouter({ fetchSource }), staticRoot = ROOT }) {
  const root = path.resolve(staticRoot);
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
          || (segments[1] === "flights" && (segments.length === 2 || (segments.length === 3 && ["options", "status", "network"].includes(segments[2]))))
          || (segments[1] === "driving" && segments.length === 2)
        ) ? (segments[1] === "feeds" ? "feeds" : segments[1]) : null;
        if (publicRoute && !takePublicRequest(req, publicRoute)) {
          json(res, 429, { error: "Zbyt wiele zapytań. Spróbuj ponownie za chwilę." });
          return;
        }
        if (publicRoute === "schedule") {
          serveSchedule(req, res, segments[2], schedules);
          return;
        }
        if (publicRoute === "timetable") {
          await serveTimetable(req, res, segments[2], timetables);
          return;
        }
        if (publicRoute === "plk") {
          await proxyPlk(req, res, url, segments[2], fetchSource);
          return;
        }
        if (publicRoute === "flights" && segments[2] === "status") {
          json(res, 200, collector ? collector.status() : { available: false, running: false });
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
        if (publicRoute === "driving") {
          await serveDriving(res, url, drive);
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
        if (segments[1] === "flights" && segments[2] === "refresh" && segments.length === 3) {
          if (req.method !== "POST") {
            res.setHeader("Allow", "POST");
            json(res, 405, { error: "Method not allowed." });
            return;
          }
          requireSameOrigin(req);
          await refreshFlights(req, res, collector, flights);
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
  const schedules = createScheduleStore({
    timetables,
    database: {
      importedHash: (agency) => importedHash(pool, agency),
      read: (agency) => readSchedule(pool, agency),
      replace: (agency, payload) => replaceSchedule(pool, agency, payload),
    },
  });
  schedules.start();
  const trackerDir = process.env.FLIGHT_TRACKER_DIR;
  const flights = createFlightStore({
    file: process.env.FLIGHT_FARES_FILE || (trackerDir ? trackerDatabase(trackerDir) : ""),
    database: {
      readFares: (day) => readFlightFares(pool, day),
      replaceFares: (rows) => replaceFlightFares(pool, rows),
      readNetwork: () => readFlightNetwork(pool),
      saveNetwork: (network) => saveFlightNetwork(pool, network),
    },
  });
  flights.start();
  const collector = createFlightCollector({
    flights,
    updateNetwork: async () => {
      if (flights.networkIsStale()) await flights.saveNetwork(await readNetwork({ dir: trackerDir, previous: flights.network() }));
    },
  });
  collector.start();
  const server = createServer({
    auth,
    timetables,
    schedules,
    flights,
    collector,
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
    flights.stop();
    collector.stop();
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
