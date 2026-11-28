"use strict";

// Trip calendar: blocked days on the account (src/calendar.js, /api/calendar) and the calendar view (assets/app.calendar.js).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { once } = require("node:events");
const test = require("node:test");
const { normalizeBlocks, MAX_BLOCKS } = require("../src/calendar");
const { createServer } = require("../src/server");

const read = (file) => fs.readFileSync(path.resolve(__dirname, "..", file), "utf8");
const t = (pl) => pl;
function loadPVCAL() { const context = {}; vm.runInNewContext(read("assets/app.calendar.js"), context); return context.PVCAL; }

test("blocked days keep only real days in order, a known kind and a short note", () => {
  const blocks = normalizeBlocks([
    { id: "later1", from: "2026-12-24", to: "2026-12-27", kind: "off", note: "  Święta  " },
    { id: "single", from: "2026-12-05", kind: "busy", extra: 1 },
    { id: "badday", from: "2026-02-30", to: "2026-03-01" },
    { id: "backwd", from: "2026-12-10", to: "2026-12-09" },
    { id: "toolong", from: "2026-01-01", to: "2027-06-01" },
    { id: "single", from: "2026-12-06", kind: "strange" },
    "nope",
  ]);
  assert.equal(blocks.length, 3);
  assert.deepEqual(blocks[0], { id: "single", from: "2026-12-05", to: "2026-12-05", kind: "busy" });
  assert.equal(blocks[1].kind, "off"); // an unknown kind is a day off
  assert.notEqual(blocks[1].id, "single"); // ids stay unique
  assert.deepEqual(blocks[2], { id: "later1", from: "2026-12-24", to: "2026-12-27", kind: "off", note: "Święta" });
  assert.equal(normalizeBlocks(Array.from({ length: 300 }, () => ({ from: "2026-12-01" }))).length, MAX_BLOCKS);
  assert.deepEqual(normalizeBlocks({}), []);
});

async function startServer(tt, authOverrides) {
  const auth = {
    resolveSession: async (token) => (token === "test-session" ? { id: "user-1", email: "rider@example.com", displayName: "Rider" } : null),
    revokeSession: async () => {},
    ...authOverrides,
  };
  const server = createServer({ database: {}, auth });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  tt.after(() => new Promise((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${server.address().port}`;
}

test("the calendar needs an account, and blocked days are cleaned before saving", async (tt) => {
  const saved = [];
  const baseUrl = await startServer(tt, {
    getCalendarBlocks: async () => [{ id: "abc123", from: "2026-12-24", to: "2026-12-26", kind: "off" }],
    saveCalendarBlocks: async (userId, blocks) => saved.push({ userId, blocks }),
  });
  const session = { Cookie: "rzbus_session=test-session" };
  assert.equal((await fetch(`${baseUrl}/api/calendar`)).status, 401);
  assert.deepEqual(await (await fetch(`${baseUrl}/api/calendar`, { headers: session })).json(), { blocks: [{ id: "abc123", from: "2026-12-24", to: "2026-12-26", kind: "off" }] });
  const body = JSON.stringify({ blocks: [{ id: "abc123", from: "2026-12-24", to: "2026-12-26", kind: "busy", owner: "x" }, { from: "bad" }] });
  assert.equal((await fetch(`${baseUrl}/api/calendar`, { method: "PUT", headers: session, body })).status, 403);
  const put = await fetch(`${baseUrl}/api/calendar`, { method: "PUT", headers: { ...session, Origin: baseUrl }, body });
  assert.equal(put.status, 200);
  assert.deepEqual(saved, [{ userId: "user-1", blocks: [{ id: "abc123", from: "2026-12-24", to: "2026-12-26", kind: "busy" }] }]);
  assert.equal((await fetch(`${baseUrl}/api/calendar`, { method: "DELETE", headers: { ...session, Origin: baseUrl } })).status, 405);
});

test("the calendar table has the shape of Podavo Clean's busy blocks and is removed with the account", () => {
  const schema = read("database/schema.sql");
  assert.match(schema, /CREATE TABLE dbo\.CalendarBlock \(/);
  assert.match(schema, /CONSTRAINT CK_CalendarBlock_Range CHECK \(ends_on >= starts_on\)/);
  assert.match(read("src/auth.js"), /DELETE FROM dbo\.CalendarBlock WHERE user_id = @userId/);
});

test("month grid starts on Monday and covers whole weeks", () => {
  const C = loadPVCAL();
  const days = C.monthDays("2026-12"); // 1 Dec 2026 is a Tuesday
  assert.equal(days[0], "2026-11-30");
  assert.equal(days.length, 35);
  assert.equal(days.at(-1), "2027-01-03");
  assert.equal(C.monthDays("2026-03").length, 42); // 1 Mar 2026 is a Sunday
  assert.equal(C.shiftMonth("2026-12", 1), "2027-01");
  assert.equal(C.shiftMonth("2026-01", -1), "2025-12");
});

test("trips, saved plans and blocked days become calendar events across their days", () => {
  const C = loadPVCAL();
  const trips = [
    { key: "k1", tid: "trip01", title: "Lizbona", route: "Rzeszów → Lizbona", from: "2026-12-10", to: "2026-12-14", status: "booked" },
    { key: "k2", tid: "plan01", title: "Rzym", route: "Rzeszów → Rzym", from: "2026-12-12", to: "", status: "planned" },
    { key: "", tid: "shar01", title: "Ryga", from: "2026-12-20", to: "2026-12-22", status: "booked", shared: true },
  ];
  const blocks = [{ id: "off001", from: "2026-12-12", to: "2026-12-13", kind: "off", note: "Weekend" }, { id: "busy01", from: "2026-12-12", to: "2026-12-12", kind: "busy" }];
  const list = C.events(trips, blocks, t);
  assert.deepEqual([...C.onDay(list, "2026-12-12").map((e) => e.tone)], ["trip", "off", "plan", "busy"]); // by first day, then longer first
  assert.equal(list.find((e) => e.tid === "shar01").tone, "trip");
  assert.equal(list.find((e) => e.blockId === "busy01").title, "Zajęty");
  assert.deepEqual([...C.conflicts({ from: "2026-12-14", to: "2026-12-15" }, trips, blocks, t)], ["Lizbona"]);
  assert.deepEqual([...C.conflicts({ id: "off001", from: "2026-12-13", to: "2026-12-13" }, trips, blocks, t)], ["Lizbona"]); // not itself

  const html = C.render({ state: { month: "2026-12", selected: "2026-12-12", form: null }, trips, blocks, today: "2026-12-01", signedIn: true, loaded: true, t });
  assert.match(html, /data-cal-day="2026-12-12"[^>]*aria-selected="true"/);
  assert.match(html, /data-fav-open="k1"/); // own trips open from the favourites
  assert.doesNotMatch(html, /data-fav-open=""/);
  assert.match(html, /data-cal-remove="off001"/);
  assert.match(html, /Wolne dni przed Tobą: <b>2<\/b>/);
  const guest = C.render({ state: { month: "2026-12", selected: "2026-12-12" }, trips, blocks: [], today: "2026-12-01", signedIn: false, t });
  assert.match(guest, /Zaloguj się, aby blokować dni/);
  assert.doesNotMatch(guest, /data-cal-add/);
  const form = C.render({ state: { month: "2026-12", selected: "2026-12-12", form: { from: "2026-12-12", to: "2026-12-13", kind: "busy", note: "<x>", conflicts: ["Lizbona"] } }, trips, blocks, today: "2026-12-01", signedIn: true, t });
  assert.match(form, /value="busy" checked/);
  assert.match(form, /value="&lt;x&gt;"/);
  assert.match(form, /W tych dniach masz też: Lizbona/);
});

test("the calendar is a tab of Moje podróże, loaded before app.js and cached offline", () => {
  const html = read("index.html");
  assert.ok(html.indexOf("/assets/app.calendar.js") > 0 && html.indexOf("/assets/app.calendar.js") < html.indexOf("/assets/app.js\""));
  assert.ok(html.includes("/assets/app.calendar.css"));
  assert.match(read("assets/app.sw.js"), /'\/assets\/app\.calendar\.js', '\/assets\/app\.calendar\.css'/);
  const app = read("assets/app.js");
  assert.match(app, /data-mytrips-tab="calendar"/);
  assert.match(app, /pageHash\(\)==='#calendar'\?'calendar'/);
  assert.match(app, /fetch\('\/api\/calendar',\{method:'PUT'/);
});
