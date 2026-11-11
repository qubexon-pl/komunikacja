"use strict";

// Parsers for Wizz Air answers (timetable, farechart, search); the timetable client (wizz-timetable.js) uses them.

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const amount = (p) => (p && typeof p.amount === "number" && p.amount > 0 ? p.amount : null);
const KINDS = new Set(["timetable", "farechart", "search"]);
const MAX_RESPONSES = 200;

// Each day's cheapest price, with every departure time when the timetable lists them.
function parseCalendar(data, source) {
  const rows = [];
  for (const key of ["outboundFlights", "returnFlights"]) {
    for (const f of data?.[key] ?? []) {
      if (f.priceType !== "price" || amount(f.price) === null) continue;
      const day = String(f.departureDate ?? f.date ?? "").slice(0, 10);
      if (!DAY.test(day)) continue;
      // departureDates: plain times, or {date, isCheapestOfTheDay}. The day's price belongs to the cheapest departure;
      // the other departures only get a lower bound ("from"), until a query for their own time gives their price.
      const entries = (f.departureDates ?? []).map((d) => ({
        time: String(typeof d === "string" ? d : d?.departureDate ?? d?.date ?? "").slice(0, 16),
        cheapest: typeof d === "object" && d?.isCheapestOfTheDay === true,
      })).filter((x) => TIME.test(x.time) && x.time.startsWith(day));
      const times = [...new Map(entries.map((x) => [x.time, x])).values()].sort((a, b) => a.time.localeCompare(b.time));
      const flagged = times.some((x) => x.cheapest);
      const base = { airline: "WIZZ", from: f.departureStation, to: f.arrivalStation, day, price: f.price.amount, currency: f.price.currencyCode ?? null, priceType: "list", source };
      if (!times.length) rows.push(base);
      for (const x of times) rows.push({ ...base, departure: x.time, priceType: flagged && x.cheapest ? "exact" : "list" });
    }
  }
  return rows;
}

// The search answer has every flight of the day with its own price: the basic bundle a non-member pays.
function parseSearch(data) {
  const rows = [];
  for (const key of ["outboundFlights", "returnFlights"]) {
    for (const f of data?.[key] ?? []) {
      const fares = (f.fares ?? []).filter((x) => !x.soldOut && !x.isWdc && amount(x.discountedPrice) !== null);
      if (!fares.length) continue;
      const basic = fares.filter((x) => x.bundle === "basic");
      const pick = (basic.length ? basic : fares).reduce((m, x) => (x.discountedPrice.amount < m.discountedPrice.amount ? x : m));
      rows.push({
        airline: "WIZZ",
        from: f.departureStation,
        to: f.arrivalStation,
        day: String(f.departureDateTime).slice(0, 10),
        departure: String(f.departureDateTime).slice(0, 16),
        arrival: f.arrivalDateTime ? String(f.arrivalDateTime).slice(0, 16) : null,
        flightNumber: `${f.carrierCode ?? "W6"} ${String(f.flightNumber ?? "").trim()}`.trim(),
        price: pick.discountedPrice.amount,
        currency: pick.discountedPrice.currencyCode ?? data.currencyCode ?? null,
        priceType: "exact",
        source: "har.wizz.search",
      });
    }
  }
  return rows;
}

// Exact flights of a day replace that day's calendar price; the calendar fills the other days.
function parseWizzResponses(responses) {
  if (!Array.isArray(responses) || !responses.length) throw Object.assign(new Error("Plik nie zawiera odpowiedzi Wizz Air."), { status: 400 });
  const list = responses.slice(0, MAX_RESPONSES).filter((r) => r && KINDS.has(r.kind) && r.data && typeof r.data === "object");
  const exact = list.filter((r) => r.kind === "search").flatMap((r) => parseSearch(r.data));
  const searched = new Set(exact.map((f) => `${f.from}|${f.to}|${f.day}`));
  const calendar = list.filter((r) => r.kind !== "search")
    .flatMap((r) => parseCalendar(r.data, r.kind === "timetable" ? "har.wizz.timetable" : "har.wizz.farechart"))
    .filter((f) => !searched.has(`${f.from}|${f.to}|${f.day}`));
  // A timetable day already has its departure times; the farechart price of the same day adds nothing.
  const timed = new Set(calendar.filter((f) => f.source === "har.wizz.timetable").map((f) => `${f.from}|${f.to}|${f.day}`));
  const known = calendar.filter((f) => f.source !== "har.wizz.farechart" || !timed.has(`${f.from}|${f.to}|${f.day}`));
  const priced = new Set(known.filter((f) => f.priceType === "exact" && f.departure).map((f) => `${f.from}|${f.to}|${f.departure}`));
  const rows = [...exact, ...known.filter((f) => f.priceType === "exact" || !f.departure || !priced.has(`${f.from}|${f.to}|${f.departure}`))];
  const seen = new Set();
  return rows.filter((f) => {
    const key = `${f.from}|${f.to}|${f.day}|${f.departure || ""}|${f.flightNumber || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = { parseWizzResponses };
