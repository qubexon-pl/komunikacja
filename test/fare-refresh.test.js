"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("../src/server");

async function start(t, options) {
  const server = createServer({
    database: {},
    auth: { resolveSession: async (token) => (token === "rider" ? { id: "3", email: "rider@example.invalid" } : null) },
    ...options,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

test("updating one flight's price asks the tracker about that route and day only, then not again within an hour", async (t) => {
  const runs = [];
  const collector = { request: (run) => { runs.push(run); return "started"; }, status: () => ({ available: true, running: false }) };
  const flights = {
    pairsFor: ({ from, to, airlines }) => [{ from, to, airlines: airlines.length ? airlines : ["RYANAIR", "WIZZ"] }],
    returnPairs: (pairs) => pairs.map((p) => ({ from: p.to, to: p.from, airlines: p.airlines })),
  };
  const base = await start(t, { collector, flights });
  const ask = (body) => fetch(`${base}/api/flights/fare`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base, Cookie: "rzbus_session=rider" }, body: JSON.stringify(body) });
  const body = { from: "krk", to: "BGY", day: day(7), back: day(14), airline: "RYANAIR" };
  assert.equal((await ask(body)).status, 202);
  assert.deepEqual(runs[0].jobs.map((j) => [j.pairs[0].from, j.pairs[0].to, j.start, j.pairs[0].airlines.join()]), [["KRK", "BGY", day(7), "RYANAIR"], ["BGY", "KRK", day(14), "RYANAIR"]]);
  const again = await ask(body);
  assert.equal(again.status, 200);
  assert.equal((await again.json()).reason, "fresh");
  assert.equal(runs.length, 1);
  assert.equal((await ask({ ...body, from: "KRAKOW" })).status, 400);
  // Wizz Air shows the automated browser no flights, so its prices are never scraped.
  const wizz = await ask({ ...body, airline: "WIZZ", day: day(20), back: "" });
  assert.deepEqual([wizz.status, (await wizz.json()).reason, runs.length], [200, "wizz-blocked", 1]);
  const guest = await fetch(`${base}/api/flights/fare`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify(body) });
  assert.equal(guest.status, 401);
});

test("the fuel price has a default and can be set on the server", async (t) => {
  const base = await start(t, {});
  const fuel = await (await fetch(`${base}/api/fuel`)).json();
  assert.ok(fuel.pb95 > 3 && fuel.pb95 < 12);
  assert.ok(fuel.source);
});
