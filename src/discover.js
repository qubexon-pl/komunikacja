"use strict";

// Phase 5a (docs/PODAVO_REFACTOR.md): the discovery answer. Fares come from the flight store's discover() (stored,
// real fares only); the forecast from Open-Meteo is added for the first destinations whose trip falls within its 16-day
// range. A trip further out gets weather: null and the day the forecast will exist; nothing is guessed from climate.
// Only the destination's coordinates go to Open-Meteo, never the traveller's.

const WEATHER_FOR = 8;

function summarise(days) {
  if (!days?.length) return null;
  const nums = (k) => days.map((d) => d[k]).filter(Number.isFinite);
  const rain = nums("rainChance");
  return {
    min: Math.round(Math.min(...nums("min"))), max: Math.round(Math.max(...nums("max"))),
    rainChance: rain.length ? Math.max(...rain) : null, code: days[0].code ?? null, days: days.length,
  };
}

function createDiscover({ flights, weather = null, weatherFor = WEATHER_FOR }) {
  async function discover(q) {
    if (!flights?.discover) throw Object.assign(new Error("Dane o lotach są niedostępne."), { status: 503 });
    const out = flights.discover(q);
    const withWeather = await Promise.all(out.destinations.map(async (d, i) => {
      if (!weather || i >= weatherFor) return { ...d, weather: null };
      const from = d.outbound.day, to = d.ret?.day || from;
      try {
        const f = await weather.forecast({ lat: d.lat, lon: d.lon, from, to });
        return { ...d, weather: summarise(f.days), weatherFrom: f.days?.length ? null : f.availableFrom || null };
      } catch {
        return { ...d, weather: null };
      }
    }));
    return { ...out, destinations: withWeather, source: "Ceny: zapisane taryfy linii lotniczych · Pogoda: Open-Meteo", groundNote: "Dojazd na lotnisko to szacunek kosztu paliwa, nie cena biletu." };
  }
  return { discover };
}

module.exports = { createDiscover, summarise };
