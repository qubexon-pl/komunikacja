"use strict";

// The airport list describes the ways into town in words: "Arlanda Express ~18 min; SL commuter train (cheaper)" and
// "SEK 129 coach / SEK 340 Arlanda Express". This turns such a description into separate options, each with its
// typical time and its own price, so the app can list every one of them — also those missing from open timetables.

const CURRENCIES = new Set(["EUR", "GBP", "SEK", "NOK", "DKK", "CHF", "CZK", "HUF", "PLN", "RON", "BGN", "ISK", "ALL", "AMD", "AZN", "BAM", "EGP", "GEL",
  "ILS", "JOD", "MDL", "MAD", "MKD", "SAR", "RSD", "TRY", "AED", "USD"]);
const STOP = new Set(["from", "walk", "up", "booked", "ahead", "if", "incl", "to", "the", "and", "or", "via", "cheaper", "cheapest", "approx", "about", "one", "way",
  "single", "return", "ticket", "tickets", "fare", "only", "each", "per", "adult", "online", "at", "in", "on", "of", "for", "with", "by", "min", "h", "s",
  "advance", "contactless", "winter", "summer", "night", "day", "peak", "off", "weekend", "weekday", "card", "app", "cash", "driver", "machine", "zone", "zones", "supplement"]);
// Words that name a kind of transport, not a particular service: "train" alone cannot tell two trains apart.
const GENERIC = new Set(["train", "trains", "bus", "buses", "coach", "coaches", "metro", "express", "line", "airport", "station", "central", "centre", "center",
  "city", "shuttle", "regional", "commuter", "local", "tram", "taxi", "rail", "railway", "terminal", "stop", "pl", "plaza", "square"]);
const KINDS = [
  ["taxi", /\b(taxi|cab)\b/i],
  ["metro", /\b(metro|subway|underground|tube|m\d)\b/i],
  ["tram", /\b(tram|light rail)\b/i],
  ["ferry", /\b(ferry|boat|water ?bus)\b/i],
  ["bus", /\b(bus|buses|coach|aircoach|aerob\w*|flygbuss\w*|navette)\b/i], // before rail: "Dublin Express/Aircoach" is a coach
  ["rail", /\b(train|rail|railjet|express|pendel\w*|commuter|flytoget|s-?bahn|s\d{1,2}|r\d\w?|rodalies|cercan\w*|leonardo|fl\d|dart|cat)\b/i],
  ["bus", /\bshuttle\b/i],
];

const fold = (text) => String(text || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const words = (text) => (fold(text).match(/[a-z0-9]+/g) || []).filter((w) => w.length >= 2 && !STOP.has(w));
const telling = (text) => words(text).filter((w) => !GENERIC.has(w));
function kindOfText(text, fallback = "bus") {
  for (const [kind, re] of KINDS) if (re.test(text)) return kind;
  return fallback;
}

// "Aerobús to Pl. Catalunya ~35 min; R2 Nord train (T2); metro L9" → three parts with name, minutes and kind.
function adviceParts(route, fallbackKind) {
  return String(route || "").split(/;|\s\/\s/).map((s) => s.trim()).filter(Boolean).map((text) => {
    const m = /~?\s?(\d+(?:[.,]\d+)?)\s?(min|h)\b/i.exec(text);
    const minutes = m ? Math.round(parseFloat(m[1].replace(",", ".")) * (m[2].toLowerCase() === "h" ? 60 : 1)) : null;
    const name = text.replace(/,?\s*~?\s?\d+(?:[.,]\d+)?\s?(min|h)\b.*$/i, "").replace(/\((?:cheaper|cheapest)\)/i, "").replace(/\s+/g, " ").trim().replace(/[,;:]$/, "");
    return { name: name || text, text, minutes, kind: kindOfText(text, fallbackKind) };
  });
}

// "GBP 19-25 walk-up Stansted Express (GBP 9.90 if booked ahead; coach from GBP 7)" → priced pieces with their words.
function farePieces(fare) {
  const text = String(fare || "");
  const found = [...text.matchAll(/([A-Z]{3})\s?(\d[\d,.]*)(?:\s?[-–]\s?(\d[\d,.]*))?/g)].filter((m) => CURRENCIES.has(m[1]));
  const num = (v) => Number(String(v).replace(/,(?=\d{3}\b)/g, "").replace(",", ".").replace(/\.$/, ""));
  return found.map((m, i) => {
    const prevEnd = i ? found[i - 1].index + found[i - 1][0].length : 0;
    const nextStart = i + 1 < found.length ? found[i + 1].index : text.length;
    // " / " (with spaces) separates prices; "Southern/Thameslink" is one price for both.
    const before = text.slice(prevEnd, m.index).split(/\s\/\s|[();]/).pop();
    const after = text.slice(m.index + m[0].length, nextStart).split(/\s\/\s|[();]/)[0];
    const label = `${before} ${after}`.replace(/\s+/g, " ").trim();
    return { currency: m[1], amount: num(m[2]), high: m[3] ? num(m[3]) : null, label, text: `${before}${m[0]}${after}`.replace(/\s+/g, " ").trim() };
  }).filter((p) => Number.isFinite(p.amount));
}

// Do two descriptions name the same service? ("R2" and line "R2N", "Milan" and "Milano", "Aerobús" and "Monbus (Aerobús)")
function sameService(a, b) {
  const x = telling(a), y = telling(b);
  if (!x.length || !y.length) return false;
  const near = (w, v) => v === w || ((/\d/.test(w) || w.length >= 4) && v.startsWith(w)) || ((/\d/.test(v) || v.length >= 4) && w.startsWith(v));
  return x.some((w) => y.some((v) => near(w, v)));
}

// The options of one airport described in words, each with the fare pieces that belong to it.
function textOptions(rec) {
  const parts = adviceParts(rec.route, rec.mode).map((p) => ({ ...p, prices: [] }));
  const extra = [];
  let last = null;
  const pieces = farePieces(rec.fare).map((piece, order) => ({ ...piece, order, named: telling(piece.label).length ? parts.find((p) => sameService(p.text, piece.label)) || null : null }));
  // Prices that name their service go first, so "EUR 2 TFI bus" cannot take the coach that "EUR 8-10 Dublin Express" names.
  for (const piece of [...pieces.filter((p) => p.named), ...pieces.filter((p) => !p.named)]) {
    const said = telling(piece.label);
    const kind = kindOfText(piece.label, "");
    let into = piece.named;
    const free = parts.filter((p) => p.kind === kind && !p.prices.length);
    if (!into && kind && (said.length === 0 || free.length === 1)) into = free[0] || null;
    if (!into && !kind && !said.length) into = last || parts.find((p) => !p.prices.length) || parts[0] || null; // "if booked ahead": another price of the same option
    if (!into) {
      // A price for a way the description does not name ("SEK 129 coach"): it is an option of its own.
      into = { name: piece.label.replace(/^from\s+/i, "").replace(/\s+from$/i, "").replace(/^\w/, (c) => c.toUpperCase()), text: piece.label, minutes: null, kind: kind || rec.mode, prices: [] };
      extra.push(into);
    }
    into.prices.push(piece);
    last = into;
  }
  for (const p of [...parts, ...extra]) p.prices.sort((a, b) => a.order - b.order);
  return [...parts, ...extra].filter((p) => p.name);
}

module.exports = { adviceParts, farePieces, textOptions, sameService, kindOfText, telling, CURRENCIES };
