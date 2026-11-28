"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createPriceAlerts, validateAlert } = require("../src/price-alerts");
const { createServer } = require("../src/server");

const TODAY = "2026-11-10";

function memoryDb(initial = []) {
  const rows = initial.map((a) => ({ lastPrice: null, lastScanAt: null, notifiedPrice: null, ...a }));
  return {
    rows,
    list: async (userId) => rows.filter((a) => a.userId === userId),
    count: async (userId) => rows.filter((a) => a.userId === userId).length,
    create: async (userId, alert) => { const row = { id: `00000000-0000-0000-0000-00000000000${rows.length + 1}`, userId, ...alert, lastPrice: null, lastScanAt: null, notifiedPrice: null }; rows.push(row); return row; },
    remove: async (userId, id) => { const i = rows.findIndex((a) => a.userId === userId && a.id === id); if (i < 0) return false; rows.splice(i, 1); return true; },
    active: async (today) => rows.filter((a) => a.day >= today),
    checked: async (id, price) => { rows.find((a) => a.id === id).lastPrice = price; },
    scanned: async (ids) => { for (const id of ids) rows.find((a) => a.id === id).lastScanAt = new Date(`${TODAY}T10:00:00Z`).toISOString(); },
    notified: async (id, price) => { rows.find((a) => a.id === id).notifiedPrice = price; },
  };
}

test("an alert needs real airports, a day within a year, a price and a known schedule", () => {
  assert.deepEqual(validateAlert({ from: "krk", to: "bgy", day: "2026-12-01", back: "2026-12-08", maxPrice: "199,50", everyHours: 12, airline: "wizz" }, TODAY),
    { from: "KRK", to: "BGY", day: "2026-12-01", back: "2026-12-08", airline: "WIZZ", maxPrice: 199.5, everyHours: 12, label: "" });
  assert.throws(() => validateAlert({ from: "KRK", to: "BGY", day: "2027-12-01", maxPrice: 100, everyHours: 12 }, TODAY), /roku/);
  assert.throws(() => validateAlert({ from: "KRK", to: "BGY", day: "2026-12-01", maxPrice: 100, everyHours: 5 }, TODAY), /często/);
  assert.throws(() => validateAlert({ from: "KRK", to: "BGY", day: "2026-12-01", back: "2026-11-30", maxPrice: 100, everyHours: 12 }, TODAY), /powrotu/);
});

test("a due alert asks the tracker about its days, and the user is emailed once when the price reaches the limit", async () => {
  let prices = { "KRK|BGY|2026-12-01": 150, "BGY|KRK|2026-12-08": 120 };
  const flights = {
    cheapest: ({ from, to, day }) => (prices[`${from}|${to}|${day}`] ? { pricePln: prices[`${from}|${to}|${day}`], departure: `${day}T06:20`, priceType: "exact" } : null),
    pairsFor: ({ from, to, airlines }) => [{ from, to, airlines: airlines.length ? airlines : ["RYANAIR", "WIZZ"] }],
  };
  const runs = [];
  const collector = { status: () => ({ running: false }), request: (run) => { runs.push(run); return "started"; } };
  const sent = [];
  const db = memoryDb([{ id: "a1", userId: "u1", email: "rider@example.invalid", from: "KRK", to: "BGY", day: "2026-12-01", back: "2026-12-08", airline: "", maxPrice: 250, everyHours: 12 }]);
  const alerts = createPriceAlerts({ db, flights, collector, sendEmail: async (m) => sent.push(m), now: () => new Date(`${TODAY}T10:00:00Z`) });

  const first = await alerts.tick();
  assert.deepEqual([first.checked, first.notified, first.scanned], [1, 0, 1]); // 270 zł is above the limit
  assert.equal(db.rows[0].lastPrice, 270);
  assert.deepEqual(runs[0].jobs.map((j) => [j.pairs[0].from, j.pairs[0].to, j.start]), [["KRK", "BGY", "2026-12-01"], ["BGY", "KRK", "2026-12-08"]]);

  prices = { "KRK|BGY|2026-12-01": 99, "BGY|KRK|2026-12-08": 120 };
  const second = await alerts.tick();
  assert.deepEqual([second.notified, second.scanned], [1, 0]); // checked again within 12 hours: no new scan
  assert.match(sent[0].subject, /KRK → BGY: 219 zł/);
  assert.match(sent[0].text, /Twój limit: 250 zł/);
  assert.equal((await alerts.tick()).notified, 0); // the same price is not sent twice
  prices["KRK|BGY|2026-12-01"] = 80;
  assert.equal((await alerts.tick()).notified, 1); // a lower one is
});

test("signed-in users list, add and remove their own alerts", async (t) => {
  const flights = { cheapest: () => ({ pricePln: 120, priceType: "list" }), pairsFor: () => [] };
  const alerts = createPriceAlerts({ db: memoryDb(), flights, now: () => new Date() });
  const server = createServer({
    database: {},
    auth: { resolveSession: async (token) => (token === "rider" ? { id: "u1", email: "rider@example.invalid" } : null) },
    alerts,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { "Content-Type": "application/json", Origin: base, Cookie: "rzbus_session=rider" };
  const day = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const created = await fetch(`${base}/api/alerts`, { method: "POST", headers, body: JSON.stringify({ from: "KTW", to: "BCN", day, maxPrice: 150, everyHours: 24 }) });
  assert.equal(created.status, 201);
  const { alert } = await created.json();
  assert.deepEqual([alert.currentPrice, alert.reached], [120, true]);
  const bad = await fetch(`${base}/api/alerts`, { method: "POST", headers, body: JSON.stringify({ from: "KTW", to: "BCN", day, maxPrice: 0, everyHours: 24 }) });
  assert.equal(bad.status, 400);
  const list = await (await fetch(`${base}/api/alerts`, { headers })).json();
  assert.equal(list.alerts.length, 1);
  assert.equal((await fetch(`${base}/api/alerts/${alert.id}`, { method: "DELETE", headers })).status, 204);
  assert.equal((await fetch(`${base}/api/alerts`, { headers: { Origin: base } })).status, 401);
});

test("a reached alert is also sent as a push, and a push alone counts as the user being told", async () => {
  const flights = { cheapest: () => ({ pricePln: 99, departure: "2026-12-01T06:20", priceType: "exact" }), pairsFor: () => [] };
  const pushed = [];
  const db = memoryDb([{ id: "a1", userId: "u1", email: "", from: "KRK", to: "BGY", day: "2026-12-01", back: "", airline: "", maxPrice: 150, everyHours: 12 }]);
  const alerts = createPriceAlerts({ db, flights, sendPush: async (alert, price) => { pushed.push([alert.id, price]); return { sent: 1 }; }, now: () => new Date(`${TODAY}T10:00:00Z`) });
  assert.equal((await alerts.tick()).notified, 1);
  assert.deepEqual(pushed, [["a1", 99]]);
  assert.equal(db.rows[0].notifiedPrice, 99);
  assert.equal((await alerts.tick()).notified, 0);
});

test("an alert's limit and schedule can be changed; a new limit can notify again", async () => {
  const flights = { cheapest: () => ({ pricePln: 300, departure: "2026-12-01T06:20", priceType: "exact" }), pairsFor: () => [] };
  const db = memoryDb([{ id: "00000000-0000-0000-0000-0000000000a1", userId: "u1", email: "", from: "KRK", to: "BGY", day: "2026-12-01", back: "", airline: "", maxPrice: 250, everyHours: 12, label: "Kraków → Bergamo", notifiedPrice: 240 }]);
  db.update = async (userId, id, change) => { const row = db.rows.find((a) => a.userId === userId && a.id === id); if (!row) return null; if (row.maxPrice !== change.maxPrice) row.notifiedPrice = null; Object.assign(row, change); return row; };
  const alerts = createPriceAlerts({ db, flights, now: () => new Date(`${TODAY}T10:00:00Z`) });
  const saved = await alerts.update("u1", "00000000-0000-0000-0000-0000000000A1", { maxPrice: "320", everyHours: 24 });
  assert.equal(saved.maxPrice, 320);
  assert.equal(saved.everyHours, 24);
  assert.equal(saved.label, "Kraków → Bergamo");
  assert.equal(saved.reached, true);
  assert.equal(db.rows[0].notifiedPrice, null);
  await assert.rejects(alerts.update("u1", "00000000-0000-0000-0000-0000000000a1", { maxPrice: 0 }), /1 do 100 000/);
  await assert.rejects(alerts.update("u2", "00000000-0000-0000-0000-0000000000a1", { maxPrice: 100 }), /Nie znaleziono/);
});
