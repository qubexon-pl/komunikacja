"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createServer } = require("../src/server");
const { createSharedSettings, sanitizeSettings } = require("../src/admin");

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const RIDER_ID = "33333333-3333-4333-8333-333333333333";
const users = {
  admin: { id: ADMIN_ID, email: "boss@example.invalid", displayName: "Boss", isAdmin: true },
  listed: { id: "22222222-2222-4222-8222-222222222222", email: "listed@example.invalid", isAdmin: false },
  rider: { id: RIDER_ID, email: "rider@example.invalid", isAdmin: false },
};

async function start(t, extra = {}) {
  const previous = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = "listed@example.invalid";
  t.after(() => { if (previous === undefined) delete process.env.ADMIN_EMAILS; else process.env.ADMIN_EMAILS = previous; });
  const rows = new Map();
  const sharedSettings = createSharedSettings({
    read: async (key) => rows.get(key) || null,
    save: async (key, value) => { rows.set(key, { value, updatedAt: new Date("2026-11-20T10:00:00Z") }); },
  });
  const server = createServer({ database: {}, auth: { resolveSession: async (token) => users[token] || null }, sharedSettings, ...extra });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const as = (who, url, method = "GET", body, origin = base) => fetch(`${base}${url}`, { method, redirect: "manual",
    headers: { "Content-Type": "application/json", Origin: origin, Cookie: `rzbus_session=${who}` }, body: body && JSON.stringify(body) });
  return { base, as, rows };
}

test("shared settings keep only known, valid values", () => {
  assert.deepEqual(sanitizeSettings({ threshold: 5, demo: true, tiles: "osm", idleLogoutMinutes: 0, rtUrls: [" https://a.example/rt.pb "], evil: "<script>" }),
    { threshold: 5, idleLogoutMinutes: 0, rtUrls: ["https://a.example/rt.pb"], tiles: "osm", demo: true });
  assert.throws(() => sanitizeSettings({ threshold: 99 }), /od 1 do 10/);
  assert.throws(() => sanitizeSettings({ idleLogoutMinutes: -5 }), /bezczynności/);
  assert.throws(() => sanitizeSettings({ rtUrls: ["javascript:alert(1)"] }), /http/);
  assert.throws(() => sanitizeSettings({ tiles: "mine" }), /podkład/i);
  assert.throws(() => sanitizeSettings({ proxy: "custom", proxyCustom: "" }), /pośrednika/);
  assert.throws(() => sanitizeSettings({ gkey: "a b" }), /Google/);
  assert.throws(() => sanitizeSettings({ demo: "yes" }), /tak albo nie/);
  assert.throws(() => sanitizeSettings(null), /Brak ustawień/);
});

test("everyone reads the shared settings; only an administrator changes them, from this site", async (t) => {
  const { as, rows } = await start(t);
  const empty = await as("nobody", "/api/settings");
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), { settings: {}, updatedAt: null });

  assert.equal((await as("nobody", "/api/settings", "PUT", { settings: { demo: true } })).status, 401);
  assert.equal((await as("rider", "/api/settings", "PUT", { settings: { demo: true } })).status, 403);
  assert.equal((await as("admin", "/api/settings", "PUT", { settings: { demo: true } }, "https://evil.example")).status, 403);
  const bad = await as("admin", "/api/settings", "PUT", { settings: { threshold: 0 } });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /od 1 do 10/);
  assert.equal(rows.size, 0);

  const saved = await as("listed", "/api/settings", "PUT", { settings: { demo: true, idleLogoutMinutes: 30 } });
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json()).settings, { demo: true, idleLogoutMinutes: 30 });

  // A visitor and a signed-in user get the new settings; only an administrator sees who changed them.
  const guest = await (await as("nobody", "/api/settings")).json();
  assert.deepEqual(guest.settings, { demo: true, idleLogoutMinutes: 30 });
  assert.equal(guest.updatedBy, undefined);
  assert.deepEqual((await (await as("rider", "/api/settings")).json()).settings, { demo: true, idleLogoutMinutes: 30 });
  assert.equal((await (await as("admin", "/api/settings")).json()).updatedBy, "listed@example.invalid");
});

test("shared settings are read from the database at most once a minute", async () => {
  let reads = 0;
  let clock = 0;
  const store = createSharedSettings({ read: async () => { reads += 1; return { value: JSON.stringify({ settings: { refresh: 30 } }), updatedAt: new Date(0) }; },
    save: async () => {}, now: () => clock });
  assert.deepEqual((await store.get()).settings, { refresh: 30 });
  clock = 59000;
  await store.get();
  assert.equal(reads, 1);
  clock = 61000;
  await store.get();
  assert.equal(reads, 2);
});

test("administrators list people and grant or remove administrator rights, but not their own", async (t) => {
  const changes = [];
  const people = [
    { id: ADMIN_ID, email: "boss@example.invalid", displayName: "Boss", isAdmin: true, createdAt: null },
    { id: RIDER_ID, email: "rider@example.invalid", displayName: "Rider", isAdmin: false, createdAt: null },
    { id: "22222222-2222-4222-8222-222222222222", email: "LISTED@example.invalid", displayName: "Listed", isAdmin: false, createdAt: null },
  ];
  const adminUsers = {
    list: async ({ query }) => ({ users: people.filter((p) => !query || p.email.includes(query)), total: 3, admins: 1, recent: 2 }),
    setAdmin: async (id, isAdmin) => { changes.push([id, isAdmin]); const p = people.find((x) => x.id === id); return p ? { ...p, isAdmin } : null; },
  };
  const { as } = await start(t, { adminUsers });
  assert.equal((await as("nobody", "/api/admin/users")).status, 401);
  assert.equal((await as("rider", "/api/admin/users")).status, 403);
  assert.equal((await as("rider", `/api/admin/users/${RIDER_ID}`, "PUT", { isAdmin: true })).status, 403);

  const list = await (await as("admin", "/api/admin/users")).json();
  assert.equal(list.total, 3);
  assert.equal(list.me, ADMIN_ID);
  const listed = list.users.find((u) => u.displayName === "Listed");
  assert.equal(listed.isAdmin, true); // ADMIN_EMAILS counts, whatever the database says
  assert.equal(listed.fromConfig, true);
  assert.equal((await (await as("admin", "/api/admin/users?q=rider")).json()).users.length, 1);

  assert.equal((await as("admin", `/api/admin/users/${RIDER_ID}`, "PUT", { isAdmin: true }, "https://evil.example")).status, 403);
  assert.equal((await as("admin", "/api/admin/users/not-a-guid", "PUT", { isAdmin: true })).status, 400);
  assert.equal((await as("admin", `/api/admin/users/${RIDER_ID}`, "PUT", { isAdmin: "yes" })).status, 400);
  assert.equal((await as("admin", `/api/admin/users/${ADMIN_ID}`, "PUT", { isAdmin: false })).status, 409);
  assert.equal((await as("admin", "/api/admin/users/44444444-4444-4444-8444-444444444444", "PUT", { isAdmin: true })).status, 404);
  const granted = await as("admin", `/api/admin/users/${RIDER_ID}`, "PUT", { isAdmin: true });
  assert.equal(granted.status, 200);
  assert.equal((await granted.json()).user.isAdmin, true);
  assert.deepEqual(changes, [["44444444-4444-4444-8444-444444444444", true], [RIDER_ID, true]]);
});

test("the admin page is only for signed-in administrators", async (t) => {
  const { as } = await start(t);
  const guest = await as("nobody", "/admin");
  assert.equal(guest.status, 302);
  assert.equal(guest.headers.get("location"), "/login?returnTo=%2Fadmin");
  const rider = await as("rider", "/admin");
  assert.equal(rider.status, 302);
  assert.equal(rider.headers.get("location"), "/plan");
  const admin = await as("admin", "/admin");
  assert.equal(admin.status, 200);
  assert.match(await admin.text(), /Panel administratora/);
  assert.equal((await as("admin", "/admin.html")).status, 404);
  assert.equal((await as("nobody", "/assets/app.admin.js")).status, 200);
});

test("the app takes its settings from the administrator, not from this browser, and admin links stay hidden from others", () => {
  const app = fs.readFileSync(path.resolve(__dirname, "../assets/app.js"), "utf8");
  const html = fs.readFileSync(path.resolve(__dirname, "../index.html"), "utf8");
  assert.match(app, /let CFG = settingsFrom\(store\(SHARED_KEY\)\)/);
  assert.match(app, /fetch\('\/api\/settings'\)/);
  assert.doesNotMatch(app, /store\('rzbus\.cfg', CFG\)/);
  assert.doesNotMatch(html, /id="settingsModal"/);
  for (const link of html.match(/<li[^>]*admin-link[^>]*>/g)) assert.match(link, /admin-only/);
  assert.ok(html.indexOf("app.defaults.js") < html.indexOf("/assets/app.js"));
});
