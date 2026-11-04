"use strict";

const assert = require("node:assert/strict");
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
  assert.equal(page.status, 302);
  assert.equal(page.headers.get("location"), "/login?returnTo=%2F");

  const loginPage = await fetch(`${baseUrl}/login`);
  assert.equal(loginPage.status, 200);
  assert.match(await loginPage.text(), /Kontynuuj z Google/);

  const protectedPage = await fetch(baseUrl, { headers: { Cookie: "rzbus_session=test-session" } });
  assert.equal(protectedPage.status, 200);
  assert.match(protectedPage.headers.get("content-type"), /text\/html/);

  const loginScript = await fetch(`${baseUrl}/assets/login.js`);
  assert.equal(loginScript.status, 200);

  const script = await fetch(`${baseUrl}/assets/app.js`, { headers: { Cookie: "rzbus_session=test-session" } });
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type"), /javascript/);

  const privateFile = await fetch(`${baseUrl}/package.json`, { headers: { Cookie: "rzbus_session=test-session" } });
  assert.equal(privateFile.status, 404);
  const traversedFile = await fetch(`${baseUrl}/assets/%2e%2e/package.json`, { headers: { Cookie: "rzbus_session=test-session" } });
  assert.equal(traversedFile.status, 404);
});

test("unauthenticated requests cannot access transit APIs", async (t) => {
  const baseUrl = await startServer(t, {
    health: async () => {},
    getSchedule: async () => { throw new Error("Should not be called"); },
  });
  const response = await fetch(`${baseUrl}/api/gtfs/ztm?sourceKey=test`);
  assert.equal(response.status, 401);
});

test("authenticated feed proxy only allows approved HTTPS GTFS sources", async (t) => {
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

  const deniedAnonymous = await fetch(`${baseUrl}/api/feeds/fetch?url=${encodeURIComponent("https://mkuran.pl/gtfs/rzeszow.zip")}`);
  assert.equal(deniedAnonymous.status, 401);

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
