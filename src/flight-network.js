"use strict";


const RYANAIR_URL = "https://www.ryanair.com/api/views/locate";
const USER_AGENT = "komunikacja-rzeszow/1.0 (https://github.com/qubexon-pl/komunikacja)";
const REQUEST_GAP_MS = 300;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ryanairAirports(items) {
  return items.map((item) => ({
    code: item.code,
    city: item.name,
    country: item.country?.name || "",
    lat: item.coordinates?.latitude,
    lon: item.coordinates?.longitude,
  }));
}

// The Wizz map also lists one-stop connections and city codes such as LON, so only direct flights between its airports count.
function parseWizzMap(map) {
  const cities = map?.cities || [];
  const known = new Set(cities.map((city) => city.iata));
  return {
    airports: cities.map((city) => ({ code: city.iata, city: city.shortName, wizzName: city.shortName, country: city.countryName, lat: city.latitude, lon: city.longitude })),
    routes: cities.flatMap((city) => (city.connections || [])
      .filter((connection) => connection.isDirectFlight && known.has(connection.iata))
      .map((connection) => ({ from: city.iata, to: connection.iata }))),
  };
}

async function readRyanair({ fetchSource = fetch, gapMs = REQUEST_GAP_MS } = {}) {
  const get = async (route) => {
    const response = await fetchSource(`${RYANAIR_URL}/${route}`, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`Ryanair returned HTTP ${response.status}.`);
    return response.json();
  };
  const airports = ryanairAirports(await get("5/airports/pl/active"));
  const routes = [];
  for (const { code } of airports) {
    for (const route of await get(`searchWidget/routes/pl/airport/${code}`)) routes.push({ from: code, to: route.arrivalAirport.code });
    await sleep(gapMs);
  }
  return { airports, routes };
}

function mergeNetwork(sources) {
  const airports = new Map();
  const routes = new Map();
  for (const [airline, source] of Object.entries(sources)) {
    for (const airport of source.airports) {
      if (!airports.has(airport.code)) airports.set(airport.code, airport);
      else if (airport.wizzName) airports.get(airport.code).wizzName = airport.wizzName; // the Wizz web pages use Wizz's own city names
    }
    for (const { from, to } of source.routes) {
      const key = `${from}|${to}`;
      const route = routes.get(key) || { from, to, airlines: [] };
      if (!route.airlines.includes(airline)) route.airlines.push(airline);
      routes.set(key, route);
    }
  }
  return { airports: [...airports.values()], routes: [...routes.values()] };
}

function fromPrevious(previous, airline) {
  return {
    airports: previous?.airports || [],
    routes: (previous?.routes || []).filter((route) => route.airlines.includes(airline)),
  };
}

// One airline failing must not erase its routes, so the previous list stands in for it.
// Both lists come from the airlines' APIs (no browser); without a Wizz Air reader the last known Wizz routes stay.
async function readNetwork({ previous = null, ryanair = readRyanair, wizz = async () => fromPrevious(previous, "WIZZ") }) {
  const read = async (airline, load) => {
    try {
      return await load();
    } catch (error) {
      console.error(`${airline} route list failed:`, error.message);
      return fromPrevious(previous, airline);
    }
  };
  const RYANAIR = await read("RYANAIR", () => ryanair());
  const WIZZ = await read("WIZZ", () => wizz());
  return { ...mergeNetwork({ RYANAIR, WIZZ }), updatedAt: new Date().toISOString() };
}

module.exports = { mergeNetwork, parseWizzMap, readNetwork, readRyanair, ryanairAirports };
