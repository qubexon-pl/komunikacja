"use strict";

// Phase 4a (docs/PODAVO_REFACTOR.md): one description of every transport provider the app already uses, one
// normalised model for what they return, and what each city can offer. Screens ask "what can this city do?" here
// instead of knowing that Rzeszów has its own GTFS import, that trains come from PKP PLK and that 48 other cities
// come from Transitous.
//
// Nothing here fetches data. The providers keep working as before (src/timetable.js, src/live-data.js, src/plk.js,
// src/city-transit.js, src/airport-transfers.js); 4b moves Rzeszów and PLK behind adapters that return these models.
//
// Honesty rules shared by every adapter:
//  - realtime is "live" only when the source itself publishes real-time data for that trip or vehicle; otherwise it is
//    "scheduled" (vehicle positions interpolated from a timetable are "scheduled" too);
//  - a fare is given only when the source gives one (or a curated, dated table does); never estimated here;
//  - every answer says where it came from and when it was fetched.

const { CITIES, cityById } = require("./pl-cities");

const MODES = ["walk", "bus", "trolleybus", "tram", "metro", "rail", "ferry", "coach", "taxi", "plane"];
const CAPABILITIES = ["plan", "departures", "stops", "lines", "vehicles", "realtime", "fares"];
// vehicles: "live" (positions from the operator), "scheduled" (positions from the timetable) or false.

const RZESZOW = { id: "rzeszow", name: "Rzeszów", centre: [50.0412, 21.9991], modes: ["bus"], live: true, operator: "ZTM Rzeszów · PKS Rzeszów" };

const PROVIDERS = {
  "rzeszow-gtfs": {
    id: "rzeszow-gtfs", name: "ZTM i PKS Rzeszów", kind: "city",
    source: "GTFS MPK Rzeszów, GTFS-RT kmrzeszow.live",
    capabilities: { plan: true, departures: true, stops: true, lines: true, vehicles: "live", realtime: true, fares: true },
    notes: "Rozkłady importowane do bazy; pozycje i opóźnienia na żywo. Ceny: taryfa ZTM i cennik PKS Rzeszów.",
  },
  transitous: {
    id: "transitous", name: "Transitous", kind: "city",
    source: "Transitous (otwarte dane GTFS i GTFS-RT operatorów)",
    // per city: realtime and live vehicles only where the operator publishes GTFS-RT (CITIES[].live)
    capabilities: { plan: true, departures: true, stops: true, lines: true, vehicles: "scheduled", realtime: false, fares: false },
    notes: "Brak cen biletów w danych. Pozycje pojazdów wynikają z rozkładu, a opóźnienia tylko tam, gdzie publikuje je przewoźnik.",
  },
  "pkp-plk": {
    id: "pkp-plk", name: "PKP PLK", kind: "rail",
    source: "PKP Polskie Linie Kolejowe (API PDP)",
    capabilities: { plan: false, departures: true, stops: true, lines: false, vehicles: false, realtime: true, fares: false },
    notes: "Odjazdy i opóźnienia na stacjach w okolicy Rzeszowa; rozkład na 90 dni.",
  },
  "airport-transfers": {
    id: "airport-transfers", name: "Dojazdy z lotnisk", kind: "airport",
    source: "Transitous i opisane ręcznie połączenia z lotnisk",
    capabilities: { plan: true, departures: true, stops: false, lines: false, vehicles: false, realtime: false, fares: true },
    notes: "Ceny z opisanej, datowanej listy połączeń z lotnisk; reszta bez ceny.",
  },
};

const PL_ZONE = "Europe/Warsaw";

// What one city offers, joined from its providers. Booleans are OR-ed; vehicles takes the best ("live" > "scheduled").
function cityCapabilities(providers) {
  const out = Object.fromEntries(CAPABILITIES.map((k) => [k, false]));
  for (const p of providers) {
    for (const k of CAPABILITIES) {
      const v = p.capabilities[k];
      if (k === "vehicles") out.vehicles = out.vehicles === "live" || v === "live" ? "live" : out.vehicles || v || false;
      else out[k] = out[k] || !!v;
    }
  }
  return out;
}
// A provider as it applies to one city (Transitous is live only where that operator publishes real-time data).
function providerFor(id, city) {
  const p = PROVIDERS[id];
  if (id !== "transitous") return { ...p, capabilities: { ...p.capabilities } };
  return { ...p, capabilities: { ...p.capabilities, realtime: !!city.live, vehicles: city.live ? "live" : "scheduled" } };
}

function describeCity(city) {
  const ids = city.id === "rzeszow" ? ["rzeszow-gtfs", "pkp-plk"] : ["transitous"];
  const providers = ids.map((id) => providerFor(id, city));
  return {
    id: city.id, name: city.name, country: "PL", zone: PL_ZONE, centre: city.centre,
    modes: city.modes.filter((m) => MODES.includes(m)).concat(city.id === "rzeszow" ? ["coach", "rail"] : []),
    operator: city.operator || "",
    providers: providers.map(({ id, name, kind, source, capabilities, notes }) => ({ id, name, kind, source, capabilities, notes })),
    capabilities: cityCapabilities(providers),
  };
}

const ALL = () => [RZESZOW, ...CITIES];
function listCities() { return ALL().map(describeCity); }
function findCity(id) {
  const c = String(id || "") === "rzeszow" ? RZESZOW : cityById(id);
  return c ? describeCity(c) : null;
}
function listProviders() { return Object.values(PROVIDERS).map((p) => ({ ...p, capabilities: { ...p.capabilities } })); }

/* ---------- normalised models ----------
   Departure: { provider, stopId, stopName, line, headsign, mode, scheduled, expected, delayMin, realtime, platform,
                cancelled, color, textColor }  times are local "YYYY-MM-DDTHH:MM" in the city's zone
   Journey:   { provider, departure, arrival, minutes, transfers, walkMin, legs:[Leg], fare|null, fetchedAt, source }
   Leg:       { mode, line, agency, from, to, departure, arrival, minutes, realtime, delayMin, color, textColor,
                headsign, stops, ticketUrl, fare|null }
   fare:      { amount, currency, note } only when the source gives one. */

const mode = (m) => (MODES.includes(m) ? m : m === "subway" ? "metro" : m === "train" || m === "suburban" ? "rail" : "bus");
const realtime = (live) => (live ? "live" : "scheduled");

// A Transitous itinerary as src/transitous.js#itinerary returns it.
function journeyFromTransitous(it, { fetchedAt = null } = {}) {
  return {
    provider: "transitous",
    departure: it.dep?.clock || null, arrival: it.arr?.clock || null,
    minutes: it.minutes, transfers: it.transfers, walkMin: it.walkMin,
    legs: (it.steps || []).map((s) => ({
      mode: mode(s.kind), line: s.line || "", agency: s.agency || "", from: s.from || "", to: s.to || "",
      departure: s.dep || null, arrival: s.arr || null, minutes: s.minutes,
      realtime: s.kind === "walk" ? null : realtime(s.live), delayMin: s.live ? s.delayMin || 0 : 0,
      color: s.color || null, textColor: s.textColor || null, headsign: s.headsign || "", stops: s.stops ?? null,
      ticketUrl: s.ticketUrl || null, fare: null,
    })),
    fare: null, fetchedAt, source: "Transitous",
  };
}

module.exports = { MODES, CAPABILITIES, PROVIDERS, listCities, findCity, listProviders, cityCapabilities, journeyFromTransitous };
