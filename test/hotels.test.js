"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHotels, priceOf } = require("../src/hotels");

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test("without Booking.com credentials the search gives a Booking.com link and asks nothing", async () => {
  let asked = 0;
  const hotels = createHotels({ apiKey: "", affiliateId: "", fetchSource: async () => { asked++; return json({}); } });
  const r = await hotels.search({ lat: 41.3826, lon: 2.1771, checkin: "2026-11-20", checkout: "2026-11-27", city: "Barcelona" });
  assert.equal(r.configured, false);
  assert.match(r.bookingUrl, /^https:\/\/www\.booking\.com\/searchresults\.html\?.*checkin=2026-11-20.*checkout=2026-11-27/);
  assert.equal(asked, 0);
  await assert.rejects(hotels.search({ lat: 41.3, lon: 2.1, checkin: "2026-11-27", checkout: "2026-11-20" }), { status: 400 });
});

test("hotels near the destination: search, then names, places and photos, cheapest first, kept for a while", async () => {
  const asked = [];
  const fetchSource = async (url, options) => {
    asked.push({ url: String(url), headers: options.headers, body: JSON.parse(options.body) });
    if (String(url).endsWith("/accommodations/search")) return json({ data: [
      { id: 10004, currency: "PLN", price: { total: 1900.5 }, url: "https://www.booking.com/hotel/es/a.html" },
      { id: 10005, currency: { accommodation: "EUR", booker: "PLN" }, price: { total: { accommodation_currency: 300, booker_currency: 1290 } }, url: "https://www.booking.com/hotel/es/b.html" },
    ] });
    return json({ data: [
      { id: 10004, name: { "en-gb": "Hotel A" }, location: { address: { "en-gb": "Carrer 1" }, coordinates: { latitude: 41.39, longitude: 2.17 } }, rating: { stars: 4, review_score: 8.6, number_of_reviews: 1200 }, photos: [{ main_photo: true, url: { standard: "https://cf.bstatic.com/a.jpg" } }] },
      { id: 10005, name: { pl: "Hotel B" }, location: { coordinates: { latitude: 41.38, longitude: 2.18 } }, rating: { review_score: 7.9 } },
    ] });
  };
  const hotels = createHotels({ apiKey: "secret-key", affiliateId: "1234567", fetchSource, rpm: 6000, base: "https://demandapi-sandbox.booking.com/3.1" });
  const r = await hotels.search({ lat: 41.3826, lon: 2.1771, checkin: "2026-11-20", checkout: "2026-11-27", adults: 2 });
  assert.equal(r.configured, true);
  assert.equal(r.sandbox, true);
  assert.deepEqual(r.hotels.map((h) => [h.name, h.price, h.currency]), [["Hotel B", 1290, "PLN"], ["Hotel A", 1900.5, "PLN"]]);
  assert.equal(r.hotels[1].photo, "https://cf.bstatic.com/a.jpg");
  assert.equal(r.hotels[1].score, 8.6);
  assert.equal(asked[0].headers.Authorization, "Bearer secret-key");
  assert.equal(asked[0].headers["X-Affiliate-Id"], "1234567");
  assert.deepEqual(asked[0].body.guests, { number_of_adults: 2, number_of_rooms: 1 });
  assert.equal(asked[0].body.coordinates.radius, 3);
  assert.deepEqual(asked[1].body.accommodations, [10004, 10005]);
  await hotels.search({ lat: 41.3826, lon: 2.1771, checkin: "2026-11-20", checkout: "2026-11-27", adults: 2 });
  assert.equal(asked.length, 2); // the kept answer
});

test("both price shapes of the Demand API are read", () => {
  assert.deepEqual(priceOf({ currency: "EUR", price: { total: 120 } }), { total: 120, currency: "EUR" });
  assert.deepEqual(priceOf({ currency: { booker: "PLN" }, price: { total: { booker_currency: 512.345 } } }), { total: 512.35, currency: "PLN" });
  assert.equal(priceOf({}), null);
});

test("with an affiliate ID the Booking.com links are affiliate deep links, also without an API key", () => {
  const plain = createHotels({ apiKey: "", affiliateId: "" }).link({ lat: 54.35, lon: 18.65, checkin: "2026-12-01", checkout: "2026-12-03", adults: 2, city: "Gdańsk" });
  assert.equal(plain.configured, false);
  assert.doesNotMatch(plain.bookingUrl, /aid=/);
  const tagged = createHotels({ apiKey: "", affiliateId: "1234567", label: "voyage-planner" }).link({ lat: 54.35, lon: 18.65, checkin: "2026-12-01", checkout: "2026-12-03", adults: 2, city: "Gdańsk" });
  const url = new URL(tagged.bookingUrl);
  assert.equal(url.searchParams.get("aid"), "1234567");
  assert.equal(url.searchParams.get("label"), "voyage-planner");
  assert.equal(url.searchParams.get("ss"), "Gdańsk");
  assert.equal(url.searchParams.get("checkin"), "2026-12-01");
  assert.equal(url.searchParams.get("checkout"), "2026-12-03");
  assert.equal(url.searchParams.get("group_adults"), "2");
  assert.throws(() => createHotels({}).link({ lat: 54.35, lon: 18.65, checkin: "2026-12-03", checkout: "2026-12-01" }), { status: 400 });
});
