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
