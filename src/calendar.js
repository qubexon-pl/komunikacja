"use strict";

// Days the traveller blocks in the trip calendar ("Moje podróże" → "Kalendarz"): days off that are free for travel
// ("off") and days that are taken ("busy"). Trips and favourites are not stored here; the calendar reads them from
// the favourites. Each block is one typed row of dbo.CalendarBlock, with the same shape as Podavo Clean's
// dbo.BusyBlock (start, end, note), so both apps can later read one shared calendar.

const MAX_BLOCKS = 200;
const MAX_SPAN_DAYS = 366;
const MAX_NOTE = 200;
const KINDS = new Set(["off", "busy"]);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[a-z0-9]{6,24}$/;

// A real calendar day (2026-02-30 is refused), as YYYY-MM-DD.
function dayOf(value) {
  if (typeof value !== "string" || !DAY.test(value)) return "";
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : "";
}

const spanDays = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;

function newId() {
  return (Date.now().toString(36) + Math.random().toString(36).slice(2, 10)).slice(0, 16);
}

// Blocks arrive from the browser, so only known fields of known shapes are kept, sorted by first day.
function normalizeBlocks(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const blocks = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const from = dayOf(item.from);
    const to = dayOf(item.to) || from;
    if (!from || to < from || spanDays(from, to) > MAX_SPAN_DAYS) continue;
    const kind = KINDS.has(item.kind) ? item.kind : "off";
    let id = typeof item.id === "string" && ID.test(item.id) ? item.id : newId();
    while (seen.has(id)) id = newId();
    seen.add(id);
    const note = typeof item.note === "string" ? item.note.replace(/\s+/g, " ").trim().slice(0, MAX_NOTE) : "";
    blocks.push(note ? { id, from, to, kind, note } : { id, from, to, kind });
    if (blocks.length === MAX_BLOCKS) break;
  }
  return blocks.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.id.localeCompare(b.id));
}

module.exports = { MAX_BLOCKS, MAX_SPAN_DAYS, normalizeBlocks };
