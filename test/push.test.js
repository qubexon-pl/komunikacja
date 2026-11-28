"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { once } = require("node:events");
const { createPush, tripReminders, tripDays } = require("../src/push");
const { createServer } = require("../src/server");

const KEYS = { PODAVO_VAPID_PUBLIC_KEY: "pub", PODAVO_VAPID_PRIVATE_KEY: "priv", PODAVO_VAPID_SUBJECT: "mailto:test@example.com" };
const USER = "11111111-1111-1111-1111-111111111111";

function memoryDb(favorites = []) {
  const rows = new Map();
  let claimed = "";
  return {
    rows,
    async save(userId, s) { rows.set(s.endpoint, { userId, hash: s.endpoint, ...s }); },
    async remove(userId, endpoint) { if (rows.get(endpoint)?.userId === userId) rows.delete(endpoint); },
    async drop(hash) { rows.delete(hash); },
    async devices(ids) { return [...rows.values()].filter((r) => ids.includes(r.userId)); },
    async tripsOfSubscribers() { return [...new Set([...rows.values()].map((r) => r.userId))].map((userId) => ({ userId, favorites: JSON.stringify(favorites) })); },
    async claimDay(day) { if (claimed >= day) return false; claimed = day; return true; },
  };
}
function fakeWebpush(fail = {}) {
  const sent = [];
  return {
    sent,
    setVapidDetails(subject, pub, priv) { this.vapid = { subject, pub, priv }; },
    async sendNotification(sub, payload) {
      const f = fail[sub.endpoint];
      if (f) { const e = new Error(f.body); e.statusCode = f.status; e.body = f.body; throw e; }
      sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
    },
  };
}
const sub = (endpoint) => ({ endpoint, keys: { p256dh: "k".repeat(20), auth: "a".repeat(10) } });

test("push is off without VAPID keys and says so", async () => {
  const push = createPush({ db: memoryDb(), env: {} });
  assert.equal(push.enabled(), false);
  assert.equal(push.publicKey(), null);
  await assert.rejects(push.subscribe(USER, sub("https://push.example/1")), /nie są jeszcze włączone/);
  assert.equal((await push.send([USER], { title: "x", body: "y" })).available, false);
});

test("subscribe validates the subscription and sends to every device of the user", async () => {
  const db = memoryDb(), wp = fakeWebpush();
  const push = createPush({ db, env: KEYS, webpush: wp });
  await assert.rejects(push.subscribe(USER, sub("http://insecure.example/1")), /Niepoprawna/);
  await push.subscribe(USER, sub("https://push.example/1"));
  await push.subscribe(USER, sub("https://push.example/2"));
  const r = await push.send([USER], { title: "Tytuł", body: "Treść", url: "/trip?id=abc", tag: "t" });
  assert.deepEqual([r.devices, r.sent], [2, 2]);
  assert.equal(wp.vapid.subject, "mailto:test@example.com");
  assert.deepEqual(wp.sent[0].payload, { title: "Tytuł", body: "Treść", url: "/trip?id=abc", tag: "t" });
});

test("a subscription the push service no longer accepts is removed; other failures are kept", async () => {
  const db = memoryDb(), wp = fakeWebpush({ "https://push.example/gone": { status: 410, body: "Gone" }, "https://push.example/busy": { status: 503, body: "busy" } });
  const push = createPush({ db, env: KEYS, webpush: wp });
  for (const e of ["gone", "busy", "ok"]) await push.subscribe(USER, sub(`https://push.example/${e}`));
  const r = await push.send([USER], { title: "x", body: "y" });
  assert.deepEqual([r.sent, r.removed], [1, 1]);
  assert.deepEqual([...db.rows.keys()].sort(), ["https://push.example/busy", "https://push.example/ok"]);
});

test("trip reminders: booked trips leaving or returning tomorrow, nothing for plans or other days", () => {
  const favs = [
    { type: "trip", status: "booked", tid: "a1", from: "Rzeszów", to: "Rzym", flight: { from: "RZE", to: "FCO", day: "2026-12-04", back: "2026-12-07" }, trip: { out: { dep: "06:10" } } },
    { type: "trip", status: "booked", tid: "b2", title: "Weekend w Krakowie", trip: { ground: { out: { day: "2026-12-01" }, back: { day: "2026-12-04" } } } },
    { type: "trip", status: "planned", tid: "c3", from: "A", to: "B", flight: { from: "RZE", to: "STN", day: "2026-12-04" } },
    { type: "trip", status: "booked", tid: "d4", from: "A", to: "B", flight: { from: "RZE", to: "STN", day: "2026-12-10" } },
  ];
  const out = tripReminders(JSON.stringify(favs), "2026-12-04");
  assert.deepEqual(out.map((m) => [m.title, m.url, m.tag]), [
    ["Jutro wyjazd o 06:10", "/trip?id=a1", "trip:a1:out"],
    ["Jutro powrót", "/trip?id=b2", "trip:b2:back"],
  ]);
  assert.match(out[0].body, /Rzeszów → Rzym/);
  assert.deepEqual(tripDays({ id: "f:RYANAIR|x|RZE|FCO|2026-12-28", detail: "powrót 03.01" }), { day: "2026-12-28", back: "2027-01-03" });
  assert.deepEqual(tripReminders("not json", "2026-12-04"), []);
});

test("daily reminders go out once a day at 8:00 Warsaw time", async () => {
  const favs = [{ type: "trip", status: "booked", tid: "a1", from: "Rzeszów", to: "Rzym", flight: { from: "RZE", to: "FCO", day: "2026-12-04" } }];
  const db = memoryDb(favs), wp = fakeWebpush();
  const push = createPush({ db, env: KEYS, webpush: wp });
  await push.subscribe(USER, sub("https://push.example/1"));
  const at = Date.parse("2026-12-03T07:00:00Z"); // 8:00 in Warsaw
  assert.equal((await push.sendDailyReminders(at)).sent, 1);
  assert.equal((await push.sendDailyReminders(at + 3600000)).skipped, true, "not twice the same day");
  assert.equal(wp.sent[0].payload.title, "Jutro wyjazd");
});

test("a reached price alert sends a push to the alert's owner", async () => {
  const db = memoryDb(), wp = fakeWebpush();
  const push = createPush({ db, env: KEYS, webpush: wp });
  await push.subscribe(USER, sub("https://push.example/1"));
  const r = await push.priceAlert({ id: "x", userId: USER, from: "RZE", to: "STN", day: "2026-12-04", back: "", maxPrice: 200 }, 149);
  assert.equal(r.sent, 1);
  assert.equal(wp.sent[0].payload.title, "Cena lotu RZE → STN: 149 zł");
  assert.equal(wp.sent[0].payload.url, "/favourites");
});

test("/api/push: key is public to signed-in users, writes need the same origin, off servers answer clearly", async () => {
  const db = memoryDb(), wp = fakeWebpush();
  const push = createPush({ db, env: KEYS, webpush: wp });
  const auth = { resolveSession: async () => ({ id: USER, email: "u@example.com" }) };
  const server = createServer({ database: {}, auth, push });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}/api/push`;
  const post = (path, body, origin = base.replace(/\/api\/push$/, "")) => fetch(`${base}/${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body) });
  try {
    assert.deepEqual(await (await fetch(`${base}/key`)).json(), { publicKey: "pub" });
    assert.equal((await post("subscribe", sub("https://push.example/1"), "https://evil.example")).status, 403);
    assert.equal((await post("subscribe", { endpoint: "nope" })).status, 400);
    assert.equal((await post("subscribe", sub("https://push.example/1"))).status, 200);
    const t = await (await post("test", {})).json();
    assert.deepEqual([t.devices, t.sent], [1, 1]);
    assert.equal((await post("unsubscribe", { endpoint: "https://push.example/1" })).status, 200);
    assert.equal(db.rows.size, 0);
  } finally {
    server.close();
  }
  const off = createServer({ database: {}, auth, push: createPush({ db: memoryDb(), env: {} }) });
  off.listen(0, "127.0.0.1");
  await once(off, "listening");
  const ob = `http://127.0.0.1:${off.address().port}`;
  try {
    assert.deepEqual(await (await fetch(`${ob}/api/push/key`)).json(), { publicKey: null });
    const r = await fetch(`${ob}/api/push/subscribe`, { method: "POST", headers: { "Content-Type": "application/json", Origin: ob }, body: JSON.stringify(sub("https://push.example/1")) });
    assert.equal(r.status, 503);
  } finally {
    off.close();
  }
});
