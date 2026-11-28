"use strict";

// Phase 8a (docs/PODAVO_REFACTOR.md): the order of a day's stops that walks the least, starting where the traveller
// sleeps. Walking time is an estimate from the straight-line distance (×1.3 for streets, 4.5 km/h) and says so; it is
// never shown as a route. Stops without a position keep their place after the positioned ones they followed.

const STREET = 1.3;
const WALK_KMH = 4.5;

function km(a, b) {
  const r = (d) => (d * Math.PI) / 180, dLat = r(b.lat - a.lat), dLon = r(b.lon - a.lon);
  return 12742 * Math.asin(Math.sqrt(Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLon / 2) ** 2));
}
const has = (p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon);
const walkKm = (a, b) => km(a, b) * STREET;
const walkMinutes = (a, b) => Math.max(1, Math.round((walkKm(a, b) / WALK_KMH) * 60));

// Total length of an open path start → p[order[0]] → … (start may be null).
function pathKm(start, points, order) {
  let sum = 0, prev = start;
  for (const i of order) { if (prev) sum += walkKm(prev, points[i]); prev = points[i]; }
  return sum;
}

// Nearest neighbour from the start, then 2-opt until nothing improves. Exact for small days, good enough for 7 stops.
function bestOrder(start, points) {
  const n = points.length;
  if (n < 2) return points.map((_, i) => i);
  const left = new Set(points.map((_, i) => i)), order = [];
  let at = start || points[0];
  if (!start) { order.push(0); left.delete(0); }
  while (left.size) {
    let best = null;
    for (const i of left) if (best == null || km(at, points[i]) < km(at, points[best])) best = i;
    order.push(best); left.delete(best); at = points[best];
  }
  for (let improved = true; improved;) {
    improved = false;
    for (let i = start ? 0 : 1; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        const next = [...order.slice(0, i), ...order.slice(i, j + 1).reverse(), ...order.slice(j + 1)];
        if (pathKm(start, points, next) + 1e-9 < pathKm(start, points, order)) { order.splice(0, n, ...next); improved = true; }
      }
    }
  }
  return order;
}

const toMin = (t) => (/^\d{2}:\d{2}$/.test(t || "") ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3)) : null);
const toClock = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

// A day's stops in the best walking order with new start times: the day starts at its earliest planned time, each
// stop lasts its own minutes (60 when unknown) and the walk between stops is added.
function fitDay(stops, { start = null } = {}) {
  const list = Array.isArray(stops) ? stops : [];
  const placed = list.map((s, i) => ({ s, i })).filter((x) => has(x.s));
  const order = bestOrder(has(start) ? start : null, placed.map((x) => x.s));
  const sorted = order.map((k) => placed[k].i);
  // stops without a position stay right after the stop they followed before
  for (const [i, s] of list.entries()) {
    if (has(s)) continue;
    const before = list.slice(0, i).reverse().find(has), at = before ? sorted.indexOf(list.indexOf(before)) + 1 : 0;
    sorted.splice(at, 0, i);
  }
  const first = Math.min(...list.map((s) => toMin(s.time)).filter((m) => m != null), Infinity);
  let clock = Number.isFinite(first) ? first : null, prev = has(start) ? start : null, totalKm = 0;
  const out = sorted.map((i) => {
    const s = list[i], walk = prev && has(s) ? walkMinutes(prev, s) : 0;
    if (prev && has(s)) totalKm += walkKm(prev, s);
    if (clock != null && (prev || walk)) clock += walk;
    const stop = { ...s, ...(clock != null ? { time: toClock(clock) } : {}), ...(walk ? { walkMin: walk } : {}) };
    if (clock != null) clock += Number.isInteger(s.minutes) && s.minutes > 0 ? s.minutes : 60;
    if (has(s)) prev = s;
    return stop;
  });
  const before = pathKm(has(start) ? start : null, list.filter(has), list.filter(has).map((_, i) => i));
  return { stops: out, order: sorted, walkKm: Math.round(totalKm * 10) / 10, savedKm: Math.max(0, Math.round((before - totalKm) * 10) / 10) };
}

module.exports = { fitDay, bestOrder, pathKm, walkMinutes, walkKm, km };

/* ---------- 8b: conflicts in a planned day ----------
   Opening hours are read only in the common OSM forms ("Mo-Fr 09:00-17:00; Sa 10:00-14:00; Su off", "24/7",
   "Tu-Su 10:00-18:00,19:00-21:00"); anything else (months, holidays, sunrise, "by appointment") makes the hours
   unknown, and then nothing is claimed about the place being open or closed. */
const DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
function parseHours(text) {
  const src = String(text || "").trim();
  if (!src) return null;
  if (src === "24/7") return DAYS.map(() => [[0, 1440]]);
  const week = DAYS.map(() => null);
  for (const raw of src.split(";").map((x) => x.trim()).filter(Boolean)) {
    if (/^PH\b/.test(raw)) continue; // public holidays: not known for a date here
    const m = /^((?:(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?)(?:,(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?)*)?\s*(off|closed|(?:\d{2}:\d{2}-\d{2}:\d{2})(?:,\s*\d{2}:\d{2}-\d{2}:\d{2})*)$/.exec(raw);
    if (!m) return null;
    const days = new Set();
    for (const part of (m[1] || "Mo-Su").split(",")) {
      const [a, b] = part.split("-").map((d) => DAYS.indexOf(d));
      for (let i = a, n = 0; n < 7; i = (i + 1) % 7, n++) { days.add(i); if (i === (b ?? a)) break; }
    }
    const ranges = /^(off|closed)$/.test(m[2]) ? [] : m[2].split(",").map((r) => r.trim().split("-").map(toMin)).map(([s, e]) => [s, e <= s ? e + 1440 : e]);
    for (const d of days) week[d] = ranges;
  }
  // in OSM a weekday no rule mentions is closed
  return week.some((x) => x) ? week.map((x) => x || []) : null;
}
const weekday = (day) => (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7;

// [{index, kind: "overlap"|"closed"|"outside", minutes?, hours?}] for one day of stops, in their planned order.
function checkDay(day) {
  const stops = day?.stops || [], out = [];
  stops.forEach((s, i) => {
    const start = toMin(s.time), len = Number.isInteger(s.minutes) && s.minutes > 0 ? s.minutes : null;
    const next = stops[i + 1], nextStart = toMin(next?.time);
    if (start != null && len && nextStart != null) {
      const over = start + len + (next.walkMin || 0) - nextStart;
      if (over > 5) out.push({ index: i, kind: "overlap", minutes: over });
    }
    const week = parseHours(s.openingHours);
    if (!week || start == null || !/^\d{4}-\d{2}-\d{2}$/.test(day.day || "")) return;
    const today = week[weekday(day.day)];
    if (!today.length) { out.push({ index: i, kind: "closed", hours: s.openingHours }); return; }
    const end = start + (len || 30);
    if (!today.some(([a, b]) => start >= a && end <= b)) out.push({ index: i, kind: "outside", hours: s.openingHours });
  });
  return out;
}

module.exports.parseHours = parseHours;
module.exports.checkDay = checkDay;
