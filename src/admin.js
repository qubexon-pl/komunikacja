"use strict";

// What an administrator decides for everyone: the shared app settings (once per browser in Ustawienia before) and who
// else is an administrator. Settings are one JSON row in dbo.AppSetting; people are the dbo.AppUser rows.
const sql = require("mssql");

const SHARED_SETTINGS_KEY = "app_settings";
const SETTINGS_MAX_CHARS = 4000; // dbo.AppSetting.setting_value
const SETTINGS_CACHE_MS = 60 * 1000;
const TILES = new Set(["podavo", "esri", "osm", "hot", "sat", "carto", "google"]);
const URL_LISTS = ["rtUrls", "staticUrls", "pksRtUrls", "pksStaticUrls"];
const SWITCHES = ["demo", "traffic", "pks", "trains", "weather"];
// Desktop sign-out after this many minutes without activity; 0 turns it off.
const IDLE_DEFAULT_MINUTES = 60;
const IDLE_MAX_MINUTES = 24 * 60;

class SettingsError extends Error {
  constructor(message) { super(message); this.name = "SettingsError"; this.statusCode = 400; }
}

function httpUrl(value, label) {
  const text = typeof value === "string" ? value.trim() : "";
  let url;
  try { url = new URL(text); } catch { throw new SettingsError(`${label}: „${text.slice(0, 80)}” nie jest adresem http(s).`); }
  if (!["http:", "https:"].includes(url.protocol) || text.length > 500) throw new SettingsError(`${label}: „${text.slice(0, 80)}” nie jest adresem http(s).`);
  return text;
}

function wholeNumber(value, min, max, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new SettingsError(`${label}: podaj liczbę od ${min} do ${max}.`);
  return n;
}

// Only known settings, each checked; anything else in the request is dropped. Missing ones keep the app's default.
function sanitizeSettings(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new SettingsError("Brak ustawień do zapisania.");
  const out = {};
  if (input.threshold !== undefined) out.threshold = wholeNumber(input.threshold, 1, 10, "Próg „spóźniony”");
  if (input.refresh !== undefined) out.refresh = wholeNumber(input.refresh, 10, 60, "Odświeżanie");
  if (input.idleLogoutMinutes !== undefined) out.idleLogoutMinutes = wholeNumber(input.idleLogoutMinutes, 0, IDLE_MAX_MINUTES, "Wylogowanie po bezczynności");
  for (const key of URL_LISTS) {
    if (input[key] === undefined) continue;
    if (!Array.isArray(input[key]) || input[key].length > 6) throw new SettingsError("Podaj najwyżej 6 adresów w każdym polu.");
    out[key] = input[key].map((url) => httpUrl(url, "Adres źródła")).filter(Boolean);
  }
  if (input.proxy !== undefined) {
    if (!["auto", "custom"].includes(input.proxy)) throw new SettingsError("Nieznany rodzaj pośrednika CORS.");
    out.proxy = input.proxy;
  }
  if (input.proxyCustom !== undefined) out.proxyCustom = input.proxyCustom === "" ? "" : httpUrl(input.proxyCustom, "Pośrednik CORS");
  if (out.proxy === "custom" && !out.proxyCustom) throw new SettingsError("Wpisz adres własnego pośrednika CORS albo wybierz „Automatycznie”.");
  if (input.tiles !== undefined) {
    if (!TILES.has(input.tiles)) throw new SettingsError("Nieznany podkład mapy.");
    out.tiles = input.tiles;
  }
  if (input.gkey !== undefined) {
    const key = typeof input.gkey === "string" ? input.gkey.trim() : "";
    if (key.length > 100 || !/^[A-Za-z0-9_-]*$/.test(key)) throw new SettingsError("Klucz Google Maps ma nieprawidłowy format.");
    out.gkey = key;
  }
  for (const key of SWITCHES) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== "boolean") throw new SettingsError("Przełączniki przyjmują tylko tak albo nie.");
    out[key] = input[key];
  }
  if (JSON.stringify(out).length > SETTINGS_MAX_CHARS - 200) throw new SettingsError("Ustawienia są za długie. Usuń część adresów.");
  return out;
}

// read/save: (key) → { value, updatedAt } | null and (key, text) → void, i.e. src/database.js readSetting/saveSetting.
function createSharedSettings({ read, save, cacheMs = SETTINGS_CACHE_MS, now = Date.now }) {
  let cached = null;
  let cachedAt = 0;
  async function get() {
    if (cached && now() - cachedAt < cacheMs) return cached;
    const row = await read(SHARED_SETTINGS_KEY);
    let stored = {};
    try { stored = row ? JSON.parse(row.value) : {}; } catch { stored = {}; }
    cached = {
      settings: stored.settings && typeof stored.settings === "object" ? stored.settings : {},
      updatedAt: row?.updatedAt ? new Date(row.updatedAt).toISOString() : null,
      updatedBy: typeof stored.updatedBy === "string" ? stored.updatedBy : null,
    };
    cachedAt = now();
    return cached;
  }
  async function set(input, user) {
    const settings = sanitizeSettings(input);
    const updatedBy = String(user?.displayName || user?.email || "");
    await save(SHARED_SETTINGS_KEY, JSON.stringify({ settings, updatedBy }));
    cached = { settings, updatedAt: new Date(now()).toISOString(), updatedBy };
    cachedAt = now();
    return cached;
  }
  return { get, set };
}

const USER_COLUMNS = "user_id, email, display_name, is_admin, created_at";
const userRow = (row) => ({ id: String(row.user_id).toLowerCase(), email: row.email, displayName: row.display_name, isAdmin: Boolean(row.is_admin),
  createdAt: row.created_at ? new Date(row.created_at).toISOString() : null });

// The people of podavo.voyage (dbo.AppUser) for the admin page.
function createAdminUsers(pool) {
  async function list({ query = "", limit = 100 } = {}) {
    const q = String(query || "").trim().slice(0, 100);
    const request = pool.request().input("limit", sql.Int, Math.min(Math.max(Number(limit) || 100, 1), 500))
      .input("q", sql.NVarChar(110), `%${q.replace(/[\\%_[]/g, (c) => `\\${c}`)}%`);
    const where = q ? "WHERE email LIKE @q ESCAPE '\\' OR display_name LIKE @q ESCAPE '\\'" : "";
    const result = await request.query(`
      SELECT TOP (@limit) ${USER_COLUMNS} FROM dbo.AppUser ${where} ORDER BY is_admin DESC, created_at DESC;
      SELECT COUNT(*) AS total, SUM(CASE WHEN is_admin = 1 THEN 1 ELSE 0 END) AS admins,
             SUM(CASE WHEN created_at >= DATEADD(day, -30, SYSUTCDATETIME()) THEN 1 ELSE 0 END) AS recent FROM dbo.AppUser;`);
    const counts = result.recordsets[1][0] || {};
    return { users: result.recordsets[0].map(userRow), total: counts.total || 0, admins: counts.admins || 0, recent: counts.recent || 0 };
  }
  async function setAdmin(userId, isAdmin) {
    const result = await pool.request().input("id", sql.UniqueIdentifier, userId).input("admin", sql.Bit, isAdmin ? 1 : 0)
      .query(`UPDATE dbo.AppUser SET is_admin = @admin WHERE user_id = @id;
              SELECT ${USER_COLUMNS} FROM dbo.AppUser WHERE user_id = @id;`);
    return result.recordset[0] ? userRow(result.recordset[0]) : null;
  }
  return { list, setAdmin };
}

module.exports = { IDLE_DEFAULT_MINUTES, SHARED_SETTINGS_KEY, SettingsError, createAdminUsers, createSharedSettings, sanitizeSettings };
