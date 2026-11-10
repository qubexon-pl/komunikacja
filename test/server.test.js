"use strict";

const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const { once } = require("node:events");
const test = require("node:test");
const { createServer } = require("../src/server");

async function startServer(t, database, authOverrides = {}) {
  const auth = {
    resolveSession: async (token) => token === "test-session" ? {
      id: "user-1",
      email: "rider@example.com",
      displayName: "Rider",
      isAdmin: true,
    } : null,
    startEmailVerification: async () => {},
    verifyEmail: async () => ({ user: { id: "user-2" }, session: { token: "new-session" } }),
    startPasswordReset: async () => {},
    resetPassword: async () => {},
    startAccountDeletion: async () => {},
    confirmAccountDeletion: async () => {},
    loginWithPassword: async () => ({ user: { id: "user-1" }, session: { token: "new-session" } }),
    revokeSession: async () => {},
    ...authOverrides,
  };
  const server = createServer({ database, auth });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

test("health endpoint reports database availability", async (t) => {
  let checked = false;
  const baseUrl = await startServer(t, {
    health: async () => { checked = true; },
  });
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok", database: "connected" });
  assert.equal(checked, true);
});

test("GTFS API reads and persists schedules through the database layer", async (t) => {
  const payload = { sourceKey: "test", routes: [], trips: [], stops: [], stopTimes: [], calendar: [], calendarDates: [], shapes: [] };
  let saved = null;
  const baseUrl = await startServer(t, {
    health: async () => {},
    getSchedule: async (agency, key) => agency === "ztm" && key === "test" ? payload : null,
    replaceSchedule: async (agency, value) => { saved = { agency, value }; },
  });

  const getResponse = await fetch(`${baseUrl}/api/gtfs/ztm?sourceKey=test`, { headers: { Cookie: "rzbus_session=test-session" } });
  assert.equal(getResponse.status, 200);
  assert.deepEqual(await getResponse.json(), payload);

  const postResponse = await fetch(`${baseUrl}/api/gtfs/pks`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: "rzbus_session=test-session" },
    body: JSON.stringify(payload),
  });
  assert.equal(postResponse.status, 201);
  assert.deepEqual(saved, { agency: "pks", value: payload });
});

test("static server exposes the frontend but not project files", async (t) => {
  const baseUrl = await startServer(t, {});
  const page = await fetch(baseUrl, { redirect: "manual" });
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);

  const loginPage = await fetch(`${baseUrl}/login`);
  assert.equal(loginPage.status, 200);
  assert.match(await loginPage.text(), /Kontynuuj z Google/);

  const protectedPage = await fetch(baseUrl, { headers: { Cookie: "rzbus_session=test-session" } });
  assert.equal(protectedPage.status, 200);
  assert.match(protectedPage.headers.get("content-type"), /text\/html/);

  for (const page of ["/autobusy", "/pks", "/pociagi", "/podroz"]) {
    const guest = await fetch(`${baseUrl}${page}`, { redirect: "manual" });
    assert.equal(guest.status, 200);
    assert.match(guest.headers.get("content-type"), /text\/html/);
  }

  const loginScript = await fetch(`${baseUrl}/assets/login.js`);
  assert.equal(loginScript.status, 200);

  const script = await fetch(`${baseUrl}/assets/app.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type"), /javascript/);

  const privateFile = await fetch(`${baseUrl}/package.json`, { headers: { Cookie: "rzbus_session=test-session" } });
  assert.equal(privateFile.status, 404);
  const traversedFile = await fetch(`${baseUrl}/assets/%2e%2e/package.json`, { headers: { Cookie: "rzbus_session=test-session" } });
  assert.equal(traversedFile.status, 404);
});

test("guests cannot reach account or schedule storage APIs", async (t) => {
  const baseUrl = await startServer(t, {
    health: async () => {},
    getSchedule: async () => { throw new Error("Should not be called"); },
  });
  const response = await fetch(`${baseUrl}/api/gtfs/ztm?sourceKey=test`);
  assert.equal(response.status, 401);
});

test("feed proxy only allows approved HTTPS GTFS sources", async (t) => {
  let fetchedUrl = null;
  const server = createServer({
    auth: {
      resolveSession: async (token) => token === "test-session" ? { id: "user-1", isAdmin: false } : null,
    },
    database: {},
    fetchSource: async (url) => {
      fetchedUrl = url.href;
      return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
        status: 200,
        headers: { "Content-Type": "application/zip" },
      });
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const guest = await fetch(`${baseUrl}/api/feeds/fetch?url=${encodeURIComponent("https://mkuran.pl/gtfs/rzeszow.zip")}`);
  assert.equal(guest.status, 200);

  const allowedUrl = "https://mkuran.pl/gtfs/rzeszow.zip";
  const allowed = await fetch(`${baseUrl}/api/feeds/fetch?url=${encodeURIComponent(allowedUrl)}`, {
    headers: { Cookie: "rzbus_session=test-session" },
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("content-type"), "application/octet-stream");
  assert.deepEqual([...new Uint8Array(await allowed.arrayBuffer())], [0x50, 0x4b, 0x03, 0x04]);
  assert.equal(fetchedUrl, allowedUrl);

  const denied = await fetch(`${baseUrl}/api/feeds/fetch?url=${encodeURIComponent("https://attacker.example/file.zip")}`, {
    headers: { Cookie: "rzbus_session=test-session" },
  });
  assert.equal(denied.status, 403);
  assert.equal(fetchedUrl, allowedUrl);
});

test("authentication endpoints enforce same-origin requests and set HttpOnly cookies", async (t) => {
  const baseUrl = await startServer(t, {});
  const rejected = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://attacker.example" },
    body: JSON.stringify({ email: "rider@example.com", password: "example password" }),
  });
  assert.equal(rejected.status, 403);

  const accepted = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: baseUrl },
    body: JSON.stringify({ email: "rider@example.com", password: "example password" }),
  });
  assert.equal(accepted.status, 200);
  assert.match(accepted.headers.get("set-cookie"), /HttpOnly/);
  assert.match(accepted.headers.get("set-cookie"), /SameSite=Lax/);
});

test("registration sends an email code before creating a session", async (t) => {
  const calls = [];
  const baseUrl = await startServer(t, {}, {
    startEmailVerification: async (values) => calls.push(["start", values]),
    verifyEmail: async (values) => {
      calls.push(["verify", values]);
      return { user: { id: "user-2", email: values.email }, session: { token: "new-session" } };
    },
  });
  const headers = { "Content-Type": "application/json", Origin: baseUrl };
  const registration = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "rider@example.com", displayName: "Rider", password: "a sufficiently long password" }),
  });
  assert.equal(registration.status, 202);
  assert.deepEqual(await registration.json(), { codeSent: true });
  assert.equal(registration.headers.get("set-cookie"), null);

  const verification = await fetch(`${baseUrl}/api/auth/verify-email`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "rider@example.com", code: "123456" }),
  });
  assert.equal(verification.status, 201);
  assert.match(verification.headers.get("set-cookie"), /HttpOnly/);
  assert.deepEqual(calls, [
    ["start", { email: "rider@example.com", displayName: "Rider", password: "a sufficiently long password" }],
    ["verify", { email: "rider@example.com", code: "123456" }],
  ]);
});

test("password recovery uses a same-origin code request and confirms the new password", async (t) => {
  const calls = [];
  const baseUrl = await startServer(t, {}, {
    startPasswordReset: async (email) => calls.push(["request", email]),
    resetPassword: async (values) => calls.push(["reset", values]),
  });
  const headers = { "Content-Type": "application/json", Origin: baseUrl };
  const request = await fetch(`${baseUrl}/api/auth/forgot-password`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "rider@example.com" }),
  });
  assert.equal(request.status, 200);
  const reset = await fetch(`${baseUrl}/api/auth/reset-password`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "rider@example.com", code: "123456", password: "a new sufficiently long password" }),
  });
  assert.equal(reset.status, 200);
  assert.deepEqual(calls, [
    ["request", "rider@example.com"],
    ["reset", { email: "rider@example.com", code: "123456", password: "a new sufficiently long password" }],
  ]);
});

test("account deletion requires an authenticated same-origin confirmation", async (t) => {
  const calls = [];
  const baseUrl = await startServer(t, {}, {
    startAccountDeletion: async (userId) => calls.push(["request", userId]),
    confirmAccountDeletion: async (userId, code) => calls.push(["confirm", userId, code]),
  });
  const unauthorized = await fetch(`${baseUrl}/api/auth/account/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: baseUrl },
    body: "{}",
  });
  assert.equal(unauthorized.status, 401);

  const headers = { "Content-Type": "application/json", Origin: baseUrl, Cookie: "rzbus_session=test-session" };
  const request = await fetch(`${baseUrl}/api/auth/account/delete`, { method: "POST", headers, body: "{}" });
  assert.equal(request.status, 200);
  const confirm = await fetch(`${baseUrl}/api/auth/account/delete/confirm`, {
    method: "POST",
    headers,
    body: JSON.stringify({ code: "123456" }),
  });
  assert.equal(confirm.status, 200);
  assert.deepEqual(calls, [["request", "user-1"], ["confirm", "user-1", "123456"]]);
  assert.match(confirm.headers.get("set-cookie"), /Max-Age=0/);
});

test("street search validates input and hides provider failures", async (t) => {
  const http = require("node:http");
  const { createServer } = require("../src/server");
  const queries = [];
  const server = createServer({
    database: {},
    auth: { resolveSession: async (token) => (token === "ok" ? { id: "1" } : null) },
    geocode: async (query) => {
      queries.push(query);
      if (query === "awaria") throw new Error("down");
      return { places: [{ label: "Lwowska, Rzeszów", locality: "Rzeszów", points: [[50, 22]] }], approximate: false };
    },
  });
  assert.ok(server instanceof http.Server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/geocode`;
  const headers = { Cookie: "rzbus_session=ok" };

  assert.equal((await fetch(`${base}?q=Lwowska`)).status, 200);
  assert.equal((await fetch(`${base}?q=a`, { headers })).status, 400);
  assert.equal((await fetch(`${base}?q=${"x".repeat(121)}`, { headers })).status, 400);
  const found = await fetch(`${base}?q=Lwowska`, { headers });
  assert.equal(found.status, 200);
  assert.equal((await found.json()).places[0].label, "Lwowska, Rzeszów");
  const failed = await fetch(`${base}?q=awaria`, { headers });
  assert.equal(failed.status, 502);
  assert.doesNotMatch(await failed.text(), /down/);
  assert.deepEqual(queries, ["Lwowska", "Lwowska", "awaria"]);
});

test("street suggestions fail without exposing details", async (t) => {
  const { createServer } = require("../src/server");
  const server = createServer({
    database: {},
    auth: { resolveSession: async (token) => (token === "ok" ? { id: "1" } : null) },
    suggestStreets: async (query) => {
      if (query === "awaria") throw new Error("down");
      return ["Lwowska, Rzeszów"];
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/streets`;
  const headers = { Cookie: "rzbus_session=ok" };

  assert.equal((await fetch(`${base}?q=Lwo`)).status, 200);
  assert.equal((await fetch(`${base}?q=L`, { headers })).status, 400);
  assert.deepEqual(await (await fetch(`${base}?q=Lwo`, { headers })).json(), { suggestions: ["Lwowska, Rzeszów"] });
  const failed = await fetch(`${base}?q=awaria`, { headers });
  assert.equal(failed.status, 502);
  assert.doesNotMatch(await failed.text(), /down/);
});

test("public street search is limited per visitor", async (t) => {
  const { createServer } = require("../src/server");
  const server = createServer({ database: {}, auth: { resolveSession: async () => null }, geocode: async () => ({ places: [], approximate: false }) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/api/geocode?q=Lwowska`;
  const statuses = [];
  for (let i = 0; i < 35; i += 1) statuses.push((await fetch(url)).status);
  assert.equal(statuses.at(-1), 429);
});

test("timetables are served to guests and revalidated with an ETag", async (t) => {
  const { createServer } = require("../src/server");
  const feed = { buffer: Buffer.from([0x50, 0x4b, 3, 4, 9]), etag: '"abc"' };
  const server = createServer({ database: {}, auth: { resolveSession: async () => null }, timetables: { get: async (agency) => (agency === "ztm" ? feed : null) } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/timetable`;
  const first = await fetch(`${base}/ztm`);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("etag"), '"abc"');
  assert.equal((await first.arrayBuffer()).byteLength, 5);
  assert.equal((await fetch(`${base}/ztm`, { headers: { "If-None-Match": '"abc"' } })).status, 304);
  assert.equal((await fetch(`${base}/pks`)).status, 503);
  assert.equal((await fetch(`${base}/other`)).status, 401);
});

test("favourites need an account and are cleaned before saving", async (t) => {
  const saved = [];
  const baseUrl = await startServer(t, {}, {
    getFavorites: async () => [{ type: "stop", view: "ztm", name: "Rynek" }],
    saveFavorites: async (userId, favorites) => saved.push({ userId, favorites }),
  });
  const session = { Cookie: "rzbus_session=test-session" };
  assert.equal((await fetch(`${baseUrl}/api/favorites`)).status, 401);
  assert.deepEqual(await (await fetch(`${baseUrl}/api/favorites`, { headers: session })).json(), { favorites: [{ type: "stop", view: "ztm", name: "Rynek" }] });
  const body = JSON.stringify({ favorites: [{ type: "stop", view: "ztm", name: "Rynek", extra: 1 }, { type: "bad" }] });
  assert.equal((await fetch(`${baseUrl}/api/favorites`, { method: "PUT", headers: session, body })).status, 403);
  const put = await fetch(`${baseUrl}/api/favorites`, { method: "PUT", headers: { ...session, Origin: baseUrl }, body });
  assert.equal(put.status, 200);
  assert.deepEqual(saved, [{ userId: "user-1", favorites: [{ type: "stop", view: "ztm", name: "Rynek" }] }]);
});

test("Google sign-in is hidden when provider credentials are absent", async (t) => {
  const baseUrl = await startServer(t, {});
  const response = await fetch(`${baseUrl}/api/auth/config`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).googleEnabled, false);

  const start = await fetch(`${baseUrl}/api/auth/google`);
  assert.equal(start.status, 503);
});

test("Google OAuth callback must match the initiating browser state cookie", async (t) => {
  const previous = {
    APP_BASE_URL: process.env.APP_BASE_URL,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  };
  process.env.APP_BASE_URL = "http://localhost:3000";
  process.env.GOOGLE_CLIENT_ID = "test-client";
  process.env.GOOGLE_CLIENT_SECRET = "test-secret";
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  let stateConsumed = false;
  const auth = {
    resolveSession: async () => null,
    saveOAuthState: async () => {},
    consumeOAuthState: async () => { stateConsumed = true; return null; },
  };
  const server = createServer({ database: {}, auth });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const start = await fetch(`${baseUrl}/api/auth/google`, { redirect: "manual" });
  assert.equal(start.status, 302);
  const authorizationUrl = new URL(start.headers.get("location"));
  const state = authorizationUrl.searchParams.get("state");
  const cookie = start.headers.get("set-cookie").split(";", 1)[0];
  assert.ok(state);
  assert.match(start.headers.get("set-cookie"), /HttpOnly/);

  const callback = await fetch(`${baseUrl}/api/auth/google/callback?code=attacker-code&state=${encodeURIComponent(state)}`, {
    redirect: "manual",
    headers: { Cookie: "rzbus_oauth_state=attacker-state" },
  });
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get("location"), "/login?error=google_signin_failed");
  assert.equal(stateConsumed, false);
  assert.ok(cookie.includes(state));
});

test("unauthenticated auth API endpoints remain available without exposing project files", async (t) => {
  const baseUrl = await startServer(t, {});
  const loginStyles = await fetch(`${baseUrl}/assets/login.css`);
  assert.equal(loginStyles.status, 200);
  const loginScript = await fetch(`${baseUrl}/assets/login.js`);
  assert.equal(loginScript.status, 200);
});

test("unsupported agencies and missing source keys are rejected", async (t) => {
  const baseUrl = await startServer(t, {});
  const unsupported = await fetch(`${baseUrl}/api/gtfs/other?sourceKey=test`, { headers: { Cookie: "rzbus_session=test-session" } });
  assert.equal(unsupported.status, 404);
  const missingKey = await fetch(`${baseUrl}/api/gtfs/ztm`, { headers: { Cookie: "rzbus_session=test-session" } });
  assert.equal(missingKey.status, 400);
});

test("flights and driving routes are public, validated, and old end-stop links move to the trip page", async (t) => {
  const seen = [];
  const flights = {
    search: (query) => { seen.push(query); return { flights: [], total: 0 }; },
    options: ({ origin, dest, date }) => ({ options: [], origin, dest, date }),
  };
  const server = createServer({
    database: {},
    auth: { resolveSession: async () => null },
    flights,
    drive: async () => ({ km: 167, minutes: 104 }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  assert.equal((await fetch(`${base}/api/flights?from=rze&date=2026-11-11`)).status, 200);
  assert.deepEqual(seen[0], { from: "RZE", to: "", date: "2026-11-11" });
  assert.equal((await fetch(`${base}/api/flights?date=jutro`)).status, 400);
  const options = await (await fetch(`${base}/api/flights/options?origin=50.04,22&dest=55.95,-3.19`)).json();
  assert.deepEqual(options.dest, { lat: 55.95, lon: -3.19 });
  assert.equal((await fetch(`${base}/api/flights/options?origin=x&dest=y`)).status, 400);
  assert.deepEqual((await (await fetch(`${base}/api/driving?from=50.04,22&to=50.06,19.94`)).json()).route, { km: 167, minutes: 104 });
  assert.equal((await fetch(`${base}/api/driving?from=50.04`)).status, 400);
  const old = await fetch(`${base}/koncowe`, { redirect: "manual" });
  assert.equal(old.status, 301);
  assert.equal(old.headers.get("location"), "/podroz");
});

test("only an administrator starts a flight refresh, choosing what, which days and which way", async (t) => {
  const requests = [];
  const users = { admin: { id: "1", email: "boss@example.invalid", isAdmin: true }, rider: { id: "3", email: "rider@example.invalid", isAdmin: false } };
  const routes = [{ from: "RZE", to: "BCN", airlines: ["WIZZ"] }, { from: "BCN", to: "RZE", airlines: ["WIZZ"] }];
  const server = createServer({
    database: {},
    auth: { resolveSession: async (token) => users[token] || null },
    flights: { search: () => ({}), pairsFor: ({ from, to }) => routes.filter((r) => (!from || r.from === from) && (!to || r.to === to)) },
    collector: { status: () => ({ available: true, running: false }), request: (target) => { requests.push(target); return "started"; } },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, who = "admin", origin = base) => fetch(`${base}/api/flights/refresh`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin, Cookie: `rzbus_session=${who}` }, body: JSON.stringify(body) });
  const period = { start: "2026-12-01", end: "2026-12-10" };
  const wizz = { airlines: ["WIZZ"] };

  assert.equal((await (await fetch(`${base}/api/flights/status`)).json()).available, true);
  assert.equal((await post({ scope: "network" }, "nobody")).status, 401);
  assert.equal((await post({ scope: "network" }, "rider")).status, 403);
  assert.equal((await post({ scope: "network" }, "admin", "https://evil.example")).status, 403);
  assert.equal(requests.length, 0);

  assert.equal((await post({ scope: "network" })).status, 202);
  assert.deepEqual(requests.pop(), { networkOnly: true, target: { scope: "network" } });
  assert.equal((await post({ scope: "all", ...period, ...wizz })).status, 202);
  assert.deepEqual(requests.pop(), { start: "2026-12-01", end: "2026-12-10", airlines: ["WIZZ"], target: { scope: "all", from: "", to: "", direction: "out", ...period, ...wizz } });
  assert.equal((await post({ scope: "route", from: "RZE", to: "BCN", direction: "both", ...period, ...wizz })).status, 202);
  assert.deepEqual(requests.pop().pairs, routes);
  assert.equal((await post({ scope: "route", from: "RZE", to: "BCN", direction: "back", ...period, ...wizz })).status, 202);
  assert.deepEqual(requests.pop().pairs, [routes[1]]);

  assert.equal((await post({ scope: "everything", ...period, ...wizz })).status, 400);
  assert.equal((await post({ scope: "route", from: "rze", ...period, ...wizz })).status, 400);
  assert.equal((await post({ scope: "route", from: "RZE", to: "BCN", ...period, airlines: [] })).status, 400);
  assert.equal((await post({ scope: "route", from: "RZE", to: "BCN", ...period, airlines: ["LOT"] })).status, 400);
  assert.equal((await post({ scope: "route", from: "RZE", to: "BCN", start: "2026-12-10", end: "2026-12-01", ...wizz })).status, 400);
  assert.equal((await post({ scope: "route", from: "RZE", to: "BCN", start: "2026-12-01", end: "2027-06-01", ...wizz })).status, 400);
  assert.equal((await post({ scope: "route", ...period, ...wizz })).status, 400);
  assert.equal((await post({ scope: "route", from: "RZE", to: "XXX", ...period, ...wizz })).status, 400);
  assert.equal(requests.length, 0);
  const me = await (await fetch(`${base}/api/auth/me`, { headers: { Cookie: "rzbus_session=admin" } })).json();
  assert.equal(me.user.canAdminister, true);
});

test("the rail key can be replaced only by an administrator and is never sent back", async (t) => {
  const { createServer } = require("../src/server");
  const saved = [];
  const plk = { status: async () => ({ configured: true, updatedAt: "2026-11-06T10:00:00.000Z" }), setKey: async (key) => { if (key === "bad-key") return false; saved.push(key); return true; } };
  const users = { admin: { id: "1", email: "boss@example.invalid", isAdmin: true }, listed: { id: "2", email: "listed@example.invalid", isAdmin: false }, rider: { id: "3", email: "rider@example.invalid", isAdmin: false } };
  const previous = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = "listed@example.invalid";
  t.after(() => { if (previous === undefined) delete process.env.ADMIN_EMAILS; else process.env.ADMIN_EMAILS = previous; });
  const server = createServer({ database: {}, auth: { resolveSession: async (token) => users[token] || null }, plk });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const as = (who, method = "GET", body, origin = base) => fetch(`${base}/api/settings/plk-key`, { method, headers: { "Content-Type": "application/json", Origin: origin, Cookie: `rzbus_session=${who}` }, body: body && JSON.stringify(body) });
  assert.equal((await as("nobody")).status, 401);
  assert.equal((await as("rider")).status, 403);
  assert.equal((await as("rider", "PUT", { key: "stolen-key" })).status, 403);
  const status = await (await as("admin")).json();
  assert.deepEqual(status, { configured: true, updatedAt: "2026-11-06T10:00:00.000Z" });
  assert.equal((await as("listed")).status, 200);
  assert.equal((await as("admin", "PUT", { key: "new-key" }, "https://evil.example")).status, 403);
  assert.equal((await as("admin", "PUT", { key: "  " })).status, 400);
  assert.equal((await as("admin", "PUT", { key: "bad-key" })).status, 422);
  assert.equal((await as("admin", "PUT", { key: " new-key " })).status, 200);
  assert.deepEqual(saved, ["new-key"]);
});

test("rail data is read from the database, with no visitor key or session", async (t) => {
  const { createServer } = require("../src/server");
  const asked = [];
  const body = zlib.gzipSync("[]");
  const snapshots = {
    info: async (key) => { asked.push(key); return key === "plk:schedule:2026-11-05" ? { etag: '"v1"', type: "application/json", fetchedAt: new Date() } : null; },
    read: async () => body,
  };
  const server = createServer({ database: {}, auth: { resolveSession: async () => null }, snapshots, fetchSource: async () => { throw new Error("visitors must not reach outside services"); } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/plk`;
  const first = await fetch(`${base}/schedules?date=2026-11-05`);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), []);
  assert.equal((await fetch(`${base}/schedules?date=2026-11-05`, { headers: { "If-None-Match": '"v1"' } })).status, 304);
  assert.equal((await fetch(`${base}/schedules?date=2026-11-06`)).status, 503);
  assert.equal((await fetch(`${base}/schedules?date=nonsense`)).status, 503);
  assert.equal((await fetch(`${base}/operations`)).status, 503);
  assert.equal((await fetch(`${base}/other`)).status, 401);
  assert.deepEqual(asked, ["plk:schedule:2026-11-05", "plk:schedule:2026-11-05", "plk:schedule:2026-11-06", "plk:operations"]);
});

test("live data is public, read from the database, and honest when it is missing or too old", async (t) => {
  const { createServer } = require("../src/server");
  const fetchedAt = { ztm: new Date(), pks: new Date(Date.now() - 6 * 60 * 1000) };
  const snapshots = {
    info: async (key) => { const name = key.split(":")[1]; return fetchedAt[name] ? { etag: '"v1"', type: "application/octet-stream", fetchedAt: fetchedAt[name] } : null; },
    read: async () => zlib.gzipSync("feed"),
  };
  const server = createServer({ database: {}, auth: { resolveSession: async () => null }, snapshots });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/live`;
  const feed = await fetch(`${base}/ztm`);
  assert.equal(feed.status, 200);
  assert.equal(await feed.text(), "feed");
  assert.equal(feed.headers.get("x-fetched-at"), fetchedAt.ztm.toISOString());
  assert.equal((await fetch(`${base}/pks`)).status, 503);
  assert.equal((await fetch(`${base}/weather`)).status, 503);
  assert.equal((await fetch(`${base}/other`)).status, 401);
});

test("walking distances to many stops come from one routing request, are cached and validated", async (t) => {
  const { createWalkTable } = require("../src/driving");
  const asked = [];
  const walkDistances = createWalkTable({ fetchSource: async (url) => { asked.push(String(url)); return new Response(JSON.stringify({ code: "Ok", distances: [[0, 900, null]], sources: [{ distance: 17 }], destinations: [{ distance: 0 }, { distance: 5 }, { distance: 3 }] }), { headers: { "Content-Type": "application/json" } }); } });
  const server = createServer({ database: {}, auth: { resolveSession: async () => null }, walkDistances });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const ask = (query) => fetch(`${base}/api/walk?${query}`);
  const first = await ask("from=49.9745,22.0345&to=49.9739,22.0254;49.9721,22.0266");
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { meters: [922, null] });
  assert.equal((await ask("from=49.9745,22.0345&to=49.9739,22.0254;49.9721,22.0266")).status, 200);
  assert.equal(asked.length, 1);
  assert.match(asked[0], /routed-foot\/table\/v1\/foot\/22\.0345,49\.9745;22\.0254,49\.9739;22\.0266,49\.9721\?sources=0&annotations=distance$/);
  assert.equal((await ask("from=49.9745,22.0345")).status, 400);
  assert.equal((await ask("from=x&to=49.9739,22.0254")).status, 400);
  assert.equal((await ask(`from=49.9745,22.0345&to=${Array(26).fill("49.97,22.02").join(";")}`)).status, 400);
});

test("walking distance requests wait their turn and stop for a while after the router refuses", async () => {
  const { createWalkTable } = require("../src/driving");
  let clock = 0;
  const calls = [];
  const answers = [429, 200, 200];
  const walkDistances = createWalkTable({
    gapMs: 1000, pauseMs: 60000, now: () => clock, wait: async (ms) => { clock += ms; },
    fetchSource: async () => { calls.push(clock); const status = answers.shift(); return new Response(JSON.stringify({ code: "Ok", distances: [[0, 100]] }), { status }); },
  });
  const a = { lat: 50, lon: 22 };
  await assert.rejects(walkDistances(a, [{ lat: 50.001, lon: 22 }]), /429/);
  await assert.rejects(walkDistances(a, [{ lat: 50.002, lon: 22 }]), /paused/);
  assert.equal(calls.length, 1);
  clock += 60000;
  const [first, second] = await Promise.all([walkDistances(a, [{ lat: 50.003, lon: 22 }]), walkDistances(a, [{ lat: 50.004, lon: 22 }])]);
  assert.deepEqual([first, second], [[100], [100]]);
  assert.equal(calls[2] - calls[1] >= 1000, true);
});

test("a signed-in trip search asks the airlines only about its own routes and days, and not twice", async (t) => {
  const requests = [];
  const users = { rider: { id: "3", email: "rider@example.invalid", isAdmin: false } };
  const out = [{ from: "KRK", to: "BGY", airlines: ["RYANAIR"] }];
  let reply = "started";
  const server = createServer({
    database: {},
    auth: { resolveSession: async (token) => users[token] || null },
    flights: { tripPairs: () => out, returnPairs: (pairs) => pairs.map((p) => ({ from: p.to, to: p.from, airlines: p.airlines })) },
    collector: { status: () => ({ available: true, running: false }), request: (target) => { requests.push(target); return reply; } },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const post = (body, who = "rider") => fetch(`${base}/api/flights/trip`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base, Cookie: `rzbus_session=${who}` }, body: JSON.stringify(body) });
  const trip = { origin: "50.04,22.00", dest: "45.67,9.70", date: day(7), back: day(14) };

  assert.equal((await post(trip, "nobody")).status, 401);
  assert.equal((await post({ ...trip, back: day(3) })).status, 400);
  assert.equal((await post({ ...trip, date: day(400), back: day(401) })).status, 400); // more than a year ahead
  assert.equal(requests.length, 0);

  assert.equal((await post(trip)).status, 202);
  const run = requests.pop();
  assert.deepEqual(run.jobs, [{ pairs: out, start: day(7), end: day(7) }, { pairs: [{ from: "BGY", to: "KRK", airlines: ["RYANAIR"] }], start: day(14), end: day(14) }]);
  assert.equal(run.target.scope, "trip");
  // the same days again are already fresh
  assert.deepEqual(await (await post(trip)).json(), { started: false, reason: "fresh" });
  // another day only asks about that day
  assert.equal((await post({ ...trip, back: "" , date: day(8) })).status, 202);
  assert.deepEqual(requests.pop().jobs, [{ pairs: out, start: day(8), end: day(8) }]);
  reply = "busy";
  assert.equal((await post({ ...trip, back: "", date: day(9) })).status, 409);
  // a busy run does not count as asked
  reply = "started";
  assert.equal((await post({ ...trip, back: "", date: day(9) })).status, 202);
});
