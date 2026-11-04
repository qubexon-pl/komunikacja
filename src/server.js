"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const crypto = require("node:crypto");
const tls = require("node:tls");
const { AGENCIES, createSqlConfig, getSchedule, replaceSchedule } = require("./database");
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
const authAttempts = new Map();
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

function authRedirect(res, pathname, search = "") {
  res.writeHead(302, { Location: `${pathname}${search}`, "Cache-Control": "no-store" });
  res.end();
}

function serveStatic(res, pathname, root) {
  const isLoginPage = pathname === "/login";
  const isLoginAsset = pathname === "/assets/login.css" || pathname === "/assets/login.js";
  if (pathname !== "/" && !isLoginPage && !pathname.startsWith("/assets/")) {
    json(res, 404, { error: "Not found." });
    return;
  }
  if (pathname.startsWith("/assets/") && !isLoginAsset && !pathname.startsWith("/assets/app.")) {
    json(res, 404, { error: "Not found." });
    return;
  }
  const requestedPath = pathname === "/" ? "/index.html" : isLoginPage ? "/login.html" : pathname;
  const filePath = path.resolve(root, `.${requestedPath}`);
  if (!filePath.startsWith(`${root}${path.sep}`)) {
    json(res, 403, { error: "Forbidden." });
    return;
  }
  if (!isLoginPage && pathname !== "/" && !filePath.startsWith(`${path.resolve(root, "assets")}${path.sep}`)) {
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

function createServer({ database, auth, fetchSource = fetch, staticRoot = ROOT }) {
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
        req.user = await auth.resolveSession(readCookie(req, SESSION_COOKIE));
        if (!req.user) {
          json(res, 401, { error: "Zaloguj się, aby kontynuować." });
          return;
        }
        if (segments[1] === "feeds" && segments[2] === "fetch" && segments.length === 3 && req.method === "GET") {
          await proxyGtfsSource(res, url, fetchSource);
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
      const user = await auth.resolveSession(readCookie(req, SESSION_COOKIE));
      if (!user) {
        authRedirect(res, "/login", `?returnTo=${encodeURIComponent(url.pathname + url.search)}`);
        return;
      }
      if (url.pathname.startsWith("/assets/login.")) {
        json(res, 404, { error: "Not found." });
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
  const server = createServer({
    auth,
    database: {
      health: async () => pool.request().query("SELECT 1 AS ok"),
      getSchedule: (agency, sourceKey) => getSchedule(pool, agency, sourceKey),
      replaceSchedule: (agency, payload) => replaceSchedule(pool, agency, payload),
    },
  });
  const port = Number(process.env.PORT || 3000);
  server.listen(port, () => console.log(`Komunikacja is listening on http://localhost:${port}`));
  const close = () => server.close(async () => {
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
