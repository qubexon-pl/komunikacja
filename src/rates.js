"use strict";

// Prices come in the seller's currency; the app compares them in PLN using the NBP average rates (table A).
const NBP_URL = "https://api.nbp.pl/api/exchangerates/tables/A/?format=json";
const RATES_TTL_MS = 12 * 60 * 60 * 1000;

function createRates({ fetchSource = fetch, now = Date.now } = {}) {
  let table = null;
  let loadedAt = 0;
  return async function toPln(amount, currency) {
    const value = Number(amount);
    if (!(value > 0) || !currency) return null;
    if (currency === "PLN") return value;
    if (!table || now() - loadedAt > RATES_TTL_MS) {
      const response = await fetchSource(NBP_URL, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(`NBP rates returned HTTP ${response.status}.`);
      const [body] = await response.json();
      table = new Map(body.rates.map((rate) => [rate.code, rate.mid]));
      loadedAt = now();
    }
    const rate = table.get(currency);
    return rate ? Math.round(value * rate * 100) / 100 : null;
  };
}

module.exports = { createRates };
