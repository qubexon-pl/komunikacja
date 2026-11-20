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

  for (const page of ["/buses", "/suburban", "/trains", "/plan", "/destinations", "/favourites", "/my-trips", "/trip"]) {
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

test("the Android app is offered at /download/voyage.apk once the deploy has put it there, or on Google Play", async (t) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "voyage-static-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const server = createServer({ database: {}, auth: { resolveSession: async () => null }, staticRoot: root });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  assert.equal((await fetch(`${baseUrl}/download/voyage.apk`, { method: "HEAD" })).status, 404);
  assert.deepEqual(await (await fetch(`${baseUrl}/api/android-app`)).json(), { store: null, apk: null });

  fs.mkdirSync(path.join(root, "download"));
  fs.writeFileSync(path.join(root, "download", "voyage.apk"), Buffer.from("PK\u0003\u0004apk"));
  fs.writeFileSync(path.join(root, "download", "other.apk"), "x");
  const head = await fetch(`${baseUrl}/download/voyage.apk`, { method: "HEAD" });
  assert.equal(head.status, 200);
  const apk = await fetch(`${baseUrl}/download/voyage.apk`);
  assert.equal(apk.status, 200);
  assert.equal(apk.headers.get("content-type"), "application/vnd.android.package-archive");
  assert.match(apk.headers.get("content-disposition"), /attachment; filename="podavo-voyage\.apk"/);
  assert.equal((await apk.arrayBuffer()).byteLength, 7);
  assert.equal((await fetch(`${baseUrl}/download/other.apk`)).status, 404);
  assert.deepEqual(await (await fetch(`${baseUrl}/api/android-app`)).json(), { store: null, apk: "/download/voyage.apk" });
  const before = process.env.ANDROID_STORE_URL;
  t.after(() => { if (before === undefined) delete process.env.ANDROID_STORE_URL; else process.env.ANDROID_STORE_URL = before; });
  process.env.ANDROID_STORE_URL = "https://evil.example/app";
  assert.equal((await (await fetch(`${baseUrl}/api/android-app`)).json()).store, null);
  process.env.ANDROID_STORE_URL = "https://play.google.com/store/apps/details?id=app.podavo.voyage";
  assert.equal((await (await fetch(`${baseUrl}/api/android-app`)).json()).store, process.env.ANDROID_STORE_URL);
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

test("the Android app reaches the API from its own origin and signs in with a bearer token", async (t) => {
  const baseUrl = await startServer(t, {});
  const app = "https://localhost";
  const preflight = await fetch(`${baseUrl}/api/auth/login`, { method: "OPTIONS", headers: { Origin: app, "Access-Control-Request-Method": "POST" } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), app);
  assert.match(preflight.headers.get("access-control-allow-headers"), /Authorization/);

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: app, "X-Auth-Mode": "token" },
    body: JSON.stringify({ email: "rider@example.com", password: "example password" }),
  });
  assert.equal(login.status, 200);
  assert.equal(login.headers.get("access-control-allow-origin"), app);
  assert.equal((await login.json()).token, "new-session");

  const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { Origin: app, Authorization: "Bearer test-session" } });
  assert.equal((await me.json()).user.email, "rider@example.com");

  // Other sites get no CORS access, no token in the body, and a bearer token from them is not a session.
  const site = "https://attacker.example";
  const other = await fetch(`${baseUrl}/api/auth/me`, { headers: { Origin: site, Authorization: "Bearer test-session" } });
  assert.equal(other.headers.get("access-control-allow-origin"), null);
  assert.equal((await other.json()).user, null);
  const web = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: baseUrl },
    body: JSON.stringify({ email: "rider@example.com", password: "example password" }),
  });
  assert.equal((await web.json()).token, undefined);
});

test("sign-in by e-mail code: the code request sets no session, the right code signs in", async (t) => {
  const calls = [];
  const baseUrl = await startServer(t, {}, {
    startEmailLogin: async (values) => { calls.push(["code", values]); return { email: values.email, resendIn: 60 }; },
    verifyEmailLogin: async (values) => {
      calls.push(["verify", values]);
      return { user: { id: "user-2", email: values.email }, session: { token: "new-session" } };
    },
  });
  const headers = { "Content-Type": "application/json", Origin: baseUrl };
  const code = await fetch(`${baseUrl}/api/auth/code`, { method: "POST", headers, body: JSON.stringify({ email: "rider@example.com" }) });
  assert.equal(code.status, 202);
  assert.deepEqual(await code.json(), { email: "rider@example.com", resendIn: 60 });
  assert.equal(code.headers.get("set-cookie"), null);

  const verify = await fetch(`${baseUrl}/api/auth/verify`, { method: "POST", headers, body: JSON.stringify({ email: "rider@example.com", code: "123456" }) });
  assert.equal(verify.status, 201);
  assert.match(verify.headers.get("set-cookie"), /rzbus_session=new-session;.*HttpOnly/);
  assert.equal((await verify.json()).user.id, "user-2");
  assert.deepEqual(calls, [["code", { email: "rider@example.com" }], ["verify", { email: "rider@example.com", code: "123456" }]]);

  // The old registration and reset steps are gone: the code replaces them.
  for (const old of ["register", "verify-email", "forgot-password", "reset-password"]) {
    assert.equal((await fetch(`${baseUrl}/api/auth/${old}`, { method: "POST", headers, body: "{}" })).status, 404);
  }
});

test("the phone app may sign in from its own origin only in token mode, never a web page elsewhere", async (t) => {
  const baseUrl = await startServer(t, {}, { startEmailLogin: async (values) => ({ email: values.email, resendIn: 60 }) });
  const send = (headers) => fetch(`${baseUrl}/api/auth/code`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ email: "a@example.com" }) });
  assert.equal((await send({ Origin: "capacitor://localhost", "X-Auth-Mode": "token" })).status, 202);
  assert.equal((await send({ Origin: "capacitor://localhost" })).status, 403);
  assert.equal((await send({ Origin: "https://evil.example", "X-Auth-Mode": "token" })).status, 403);
});

test("the optional password is shown, set and removed only for the signed-in person", async (t) => {
  const calls = [];
  const baseUrl = await startServer(t, {}, {
    passwordStatus: async (user) => ({ hasPassword: false, user: user.id }),
    setPassword: async (user, password, current, keep) => { calls.push(["set", user.id, password, current, keep]); return { hasPassword: true }; },
    removePassword: async (user, current) => { calls.push(["remove", user.id, current]); return { hasPassword: false }; },
  });
  assert.equal((await fetch(`${baseUrl}/api/auth/password`)).status, 401);
  const headers = { "Content-Type": "application/json", Origin: baseUrl, Cookie: "rzbus_session=test-session" };
  assert.deepEqual(await (await fetch(`${baseUrl}/api/auth/password`, { headers })).json(), { hasPassword: false, user: "user-1" });
  assert.equal((await fetch(`${baseUrl}/api/auth/password`, { method: "PUT", headers: { ...headers, Origin: "https://evil.example" }, body: "{}" })).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/auth/password`, { method: "PUT", headers, body: JSON.stringify({ password: "a long new password" }) })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/auth/password`, { method: "DELETE", headers, body: JSON.stringify({ currentPassword: "a long new password" }) })).status, 200);
  assert.deepEqual(calls, [["set", "user-1", "a long new password", undefined, "test-session"], ["remove", "user-1", "a long new password"]]);
});

test("account deletion requires an authenticated same-origin confirmation", async (t) => {
  const calls = [];
  const baseUrl = await startServer(t, {}, {
    startAccountDeletion: async (user) => calls.push(["request", user.id]),
    confirmAccountDeletion: async (user, code) => calls.push(["confirm", user.id, code]),
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
    geocode: async () => { throw new Error("down too"); },
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

test("when street suggestions fail, the address search suggests exact addresses with their points", async (t) => {
  const { createServer } = require("../src/server");
  const server = createServer({
    database: {},
    auth: { resolveSession: async () => ({ id: "1" }) },
    suggestStreets: async () => { throw new Error("The operation was aborted due to timeout"); },
    geocode: async () => ({ places: [{ label: "Siedmiogrodzka 9, Warszawa", points: [[52.2307512, 20.9698838]] }], approximate: false }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/streets?q=Siedmiogrodzka%209`, { headers: { Cookie: "rzbus_session=ok" } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    suggestions: ["Siedmiogrodzka 9, Warszawa"],
    places: [{ label: "Siedmiogrodzka 9, Warszawa", point: [52.2307512, 20.9698838] }],
  });
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
  const config = await response.json();
  assert.equal(config.googleEnabled, false);
  assert.equal(config.googleNativeEnabled, false);

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

test("ON/WARD brand assets are served to everyone, but not the pack's notes", async (t) => {
  const baseUrl = await startServer(t, {});
  for (const [file, type] of [
    ["/assets/onward/logos/wordmark-light.svg", "image/svg+xml"],
    ["/assets/onward/icons/plane.svg", "image/svg+xml"],
    ["/assets/onward/illustrations/no-results.svg", "image/svg+xml"],
    ["/assets/onward/banners/city.svg", "image/svg+xml"],
    ["/assets/onward/css/tokens.css", "text/css"],
    ["/assets/onward/png/icon-192.png", "image/png"],
    ["/assets/onward/page-banners/city-buses.svg", "image/svg+xml"],
    ["/assets/onward/banners/flight-destinations.svg", "image/svg+xml"],
    ["/assets/onward/weather/partly-cloudy.svg", "image/svg+xml"],
    ["/assets/onward/map/pin-a.svg", "image/svg+xml"],
    ["/assets/onward/illustrations/plan-a-trip.svg", "image/svg+xml"],
    ["/assets/onward/decorations/soft-waves.svg", "image/svg+xml"],
    ["/assets/onward/illustrations/no-favourites.svg", "image/svg+xml"],
    ["/assets/onward/icons/suburban-bus.svg", "image/svg+xml"],
    ["/assets/onward/logos/wordmark-on-dark.svg", "image/svg+xml"],
    ["/assets/onward/i18n/pl-PL.json", "application/json"],
    ["/assets/onward/i18n/en-GB.json", "application/json"],
    ["/assets/hero.svg", "image/svg+xml"],
    ["/sw.js", "javascript"],
    ["/assets/app.native.js", "javascript"],
    ["/assets/app.photos.js", "javascript"],
    ["/assets/manifest.webmanifest", "application/manifest+json"],
  ]) {
    const res = await fetch(`${baseUrl}${file}`);
    assert.equal(res.status, 200, file);
    assert.match(res.headers.get("content-type"), new RegExp(type.replace("+", "\\+")), file);
  }
  for (const file of ["/assets/onward/AGENT_IMPLEMENTATION_GUIDE.md", "/assets/onward/AGENT_I18N_PL.md", "/assets/onward/extended-manifest.json",
    "/assets/onward/manifest.json", "/assets/onward/icons/../README.md", "/assets/onward/i18n/other.json"]) {
    assert.equal((await fetch(`${baseUrl}${file}`)).status, 404, file);
  }
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
  assert.equal(old.headers.get("location"), "/plan");
  // the Polish page addresses lead to the English ones, with their query
  const polish = await fetch(`${base}/podroz-szczegoly?id=abc123`, { redirect: "manual" });
  assert.equal(polish.status, 301);
  assert.equal(polish.headers.get("location"), "/trip?id=abc123");
  assert.equal((await fetch(`${base}/ulubione`, { redirect: "manual" })).headers.get("location"), "/favourites");
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

test("a trip search to a city Ryanair and Wizz Air do not fly to asks the fare API about the nearest airports", async (t) => {
  const users = { rider: { id: "3", email: "rider@example.invalid", isAdmin: false } };
  const asked = [];
  const server = createServer({
    database: {},
    auth: { resolveSession: async (token) => users[token] || null },
    flights: { tripPairs: () => [], returnPairs: () => [], apiPairs: () => [{ from: "RZE", to: "ZRH", airlines: [] }] },
    duffel: { searchRoutes: (pairs, date, back) => { asked.push({ pairs, date, back }); return "started"; }, status: () => ({ available: true, running: true, progress: { done: 1, total: 2 } }) },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const response = await fetch(`${base}/api/flights/trip`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base, Cookie: "rzbus_session=rider" }, body: JSON.stringify({ origin: "50.04,22.00", dest: "47.38,8.54", date: day(7), back: day(14) }) });
  assert.equal(response.status, 202);
  assert.deepEqual(asked, [{ pairs: [{ from: "RZE", to: "ZRH", airlines: [] }], date: day(7), back: day(14) }]);
  const status = await (await fetch(`${base}/api/flights/status`)).json();
  assert.equal(status.running, true);
  assert.deepEqual(status.progress, { done: 1, total: 2 });
});

test("trip sharing requests are passed on to the FastAPI server with the session cookie, and a stopped API is reported plainly", async (t) => {
  const seen = [];
  let apiUp = true;
  const fetchSource = async (url, init) => {
    if (!apiUp) throw new TypeError("fetch failed");
    seen.push({ url: String(url), method: init.method, cookie: init.headers.cookie, origin: init.headers.origin, body: init.body ? init.body.toString() : null });
    return new Response(JSON.stringify({ member: { name: "Ania" } }), { status: 201, headers: { "Content-Type": "application/json" } });
  };
  const server = createServer({ database: {}, auth: { resolveSession: async () => null }, fetchSource });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const added = await fetch(`${base}/api/trips/trip0001/members?x=1`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: "rzbus_session=abc", Origin: "http://localhost:3000" }, body: JSON.stringify({ email: "ania@example.com" }) });
  assert.equal(added.status, 201);
  assert.deepEqual(await added.json(), { member: { name: "Ania" } });
  assert.deepEqual(seen, [{ url: "http://127.0.0.1:8000/api/trips/trip0001/members?x=1", method: "POST", cookie: "rzbus_session=abc", origin: "http://localhost:3000", body: '{"email":"ania@example.com"}' }]);
  apiUp = false;
  const down = await fetch(`${base}/api/trips/shared`);
  assert.equal(down.status, 503);
  assert.equal((await down.json()).code, "api-offline");
});

test("trip photos are passed on to FastAPI with their chunk offset, so the app does not mistake a 404 for an unsaved trip", async (t) => {
  const seen = [];
  const fetchSource = async (url, init) => {
    seen.push({ url: String(url), method: init.method, offset: init.headers["upload-offset"], size: init.body ? init.body.length : 0 });
    return new Response(JSON.stringify({ photo: { received: 200000 } }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const server = createServer({ database: {}, auth: { resolveSession: async () => null }, fetchSource });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const put = await fetch(`${base}/api/photos/abc/content`, { method: "PUT", headers: { "Content-Type": "application/octet-stream", "Upload-Offset": "0", Origin: base }, body: Buffer.alloc(200000, 1) });
  assert.equal(put.status, 200);
  const list = await fetch(`${base}/api/photos?tripId=trip0001`);
  assert.equal(list.status, 200);
  assert.deepEqual(seen, [
    { url: "http://127.0.0.1:8000/api/photos/abc/content", method: "PUT", offset: "0", size: 200000 },
    { url: "http://127.0.0.1:8000/api/photos?tripId=trip0001", method: "GET", offset: undefined, size: 0 },
  ]);
});

test("the EUR rate is served for prices in two currencies, and a bad currency is refused", async (t) => {
  const asked = [];
  const server = createServer({ database: {}, auth: { resolveSession: async () => null }, fareRates: async (amount, code) => { asked.push(code); return amount * 4.2537; }, fetchSource: async () => { throw new Error("no outside calls"); } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/rates`;
  const eur = await fetch(`${base}?currency=EUR`);
  assert.equal(eur.status, 200);
  assert.deepEqual(await eur.json(), { currency: "EUR", pln: 4.2537 });
  assert.equal((await fetch(`${base}?currency=E1`)).status, 400);
  assert.deepEqual(asked, ["EUR"]);
});

test("visitors who are not signed in start on the welcome page, signed-in users on the app", async (t) => {
  const baseUrl = await startServer(t, {});
  const guest = await fetch(`${baseUrl}/`);
  assert.equal(guest.status, 200);
  assert.match(guest.headers.get("vary"), /Cookie/);
  const welcome = await guest.text();
  assert.match(welcome, /<title>Witaj · podavo\.voyage<\/title>/);
  assert.match(welcome, /href="\/plan\?tour=1"/);
  const signedIn = await fetch(`${baseUrl}/`, { headers: { cookie: "rzbus_session=test-session" } });
  assert.match(await signedIn.text(), /<title>Zaplanuj podróż · podavo\.voyage<\/title>/);
  const direct = await fetch(`${baseUrl}/welcome`, { headers: { cookie: "rzbus_session=test-session" } });
  assert.match(await direct.text(), /<title>Witaj · podavo\.voyage<\/title>/);
  assert.equal((await fetch(`${baseUrl}/plan`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/assets/app.welcome.css`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/assets/app.tour.js`)).status, 200);
});

test("the weather where the person is has its own public route and checks the place", async (t) => {
  const asked = [];
  const tripWeather = {
    forecast: async () => ({ days: [] }),
    current: async (q) => { asked.push(q); if (!Number.isFinite(q.lat)) throw Object.assign(new Error("Podaj miejsce."), { status: 400 }); return { current: { temperature_2m: 5 }, hourly: {}, place: "Rzeszów" }; },
  };
  const server = createServer({ database: {}, auth: { resolveSession: async () => null }, tripWeather });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/weather/now`;
  const ok = await fetch(`${base}?lat=50.04&lon=22.00`);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).place, "Rzeszów");
  assert.deepEqual(asked[0], { lat: 50.04, lon: 22 });
  assert.equal((await fetch(`${base}?lat=x&lon=1`)).status, 400);
});

test("Polish city transport: the city list, stop search and departures are public and failures stay readable", async (t) => {
  const asked = [];
  const cityTransit = {
    stops: async (q) => { asked.push(["stops", q]); return { stops: [{ id: "s1", name: "Rynek" }] }; },
    departures: async (q) => { asked.push(["departures", q]); if (q.stop === "bad") throw Object.assign(new Error("Wybierz przystanek."), { status: 400 }); throw new Error("Transitous zwrócił HTTP 503."); },
  };
  const server = createServer({ database: {}, auth: { resolveSession: async () => null }, cityTransit });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/transit`;
  const cities = await (await fetch(`${base}/cities`)).json();
  assert.ok(cities.cities.some((c) => c.id === "wroclaw" && c.modes.includes("tram")));
  assert.deepEqual(await (await fetch(`${base}/stops?city=wroclaw&q=Rynek`)).json(), { stops: [{ id: "s1", name: "Rynek" }] });
  assert.equal((await fetch(`${base}/departures?stop=bad`)).status, 400);
  const down = await fetch(`${base}/departures?stop=s1`);
  assert.equal(down.status, 502);
  assert.deepEqual((await down.json()).departures, []);
  assert.deepEqual(asked[0], ["stops", { city: "wroclaw", q: "Rynek" }]);
});

test("Polish city lines are public and a Transitous failure answers with an empty list", async (t) => {
  const cityTransit = { lines: async ({ city }) => { if (city === "x") throw new Error("Transitous zwrócił HTTP 503."); return { city, lines: [{ line: "10", kind: "tram", vehicles: 3, late: 0 }] }; } };
  const server = createServer({ database: {}, auth: { resolveSession: async () => null }, cityTransit });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/transit/lines`;
  assert.equal((await (await fetch(`${base}?city=wroclaw`)).json()).lines[0].line, "10");
  const down = await fetch(`${base}?city=x`);
  assert.equal(down.status, 502);
  assert.deepEqual((await down.json()).lines, []);
});
