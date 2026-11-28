"use strict";

// Web Push: notifications on the phone or computer even when Podavo is closed. They work in the installed app
// (Android and desktop browsers, and iPhone/iPad from iOS 16.4 once Podavo is added to the home screen). This is
// the same mechanism as in Tidy: VAPID keys on the server and the browser's own push service, so it needs no
// Firebase project.
//
// What is sent:
// - right away: a price alert reached its price (next to the email);
// - once a day at 8:00 Polish time: a booked trip that leaves tomorrow, and the return trip tomorrow.
//
// Settings (environment variables). Generate the pair once with `npm run push:keys`:
//   PODAVO_VAPID_PUBLIC_KEY, PODAVO_VAPID_PRIVATE_KEY   empty = push is off (everything else keeps working)
//   PODAVO_VAPID_SUBJECT                                contact for push services, e.g. mailto:kontakt@podavo.pl
// Needs dbo.PushSubscription (database/schema.sql).
//
// Payloads hold only what the user's own trip or alert already shows them (route and date); they are encrypted for
// the device by the browser's keys and never include other participants' names or addresses.

const { createHash } = require("node:crypto");
const sql = require("mssql");

const ZONE = "Europe/Warsaw";
const MAX_DEVICES = 10;

class PushInputError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const hash = (endpoint) => createHash("sha256").update(endpoint).digest("hex");
const short = (value, n = 90) => {
  const t = String(value ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// The push service says this subscription can never work again: gone, or made with other VAPID keys.
const deadSubscription = (status, body) =>
  status === 404 || status === 410 ||
  ((status === 400 || status === 401 || status === 403) && /correspond|mismatch|VapidPkHash|invalid.?(registration|token|subscription)|unsubscribed|expired/i.test(body));

/* ---------- Database ---------- */

function createPushDatabase(pool) {
  return {
    async save(userId, sub) {
      await pool.request()
        .input("hash", sql.Char(64), hash(sub.endpoint))
        .input("userId", sql.UniqueIdentifier, userId)
        .input("endpoint", sql.NVarChar(1000), sub.endpoint)
        .input("p256dh", sql.VarChar(200), sub.p256dh)
        .input("auth", sql.VarChar(100), sub.auth)
        .query(`MERGE dbo.PushSubscription AS t USING (SELECT @hash AS endpoint_hash) AS s ON t.endpoint_hash = s.endpoint_hash
                WHEN MATCHED THEN UPDATE SET user_id = @userId, endpoint = @endpoint, p256dh = @p256dh, auth = @auth
                WHEN NOT MATCHED THEN INSERT (endpoint_hash, user_id, endpoint, p256dh, auth) VALUES (@hash, @userId, @endpoint, @p256dh, @auth);`);
      // Keep a user's device list small (old browsers that never unsubscribed).
      await pool.request().input("userId", sql.UniqueIdentifier, userId).input("max", sql.Int, MAX_DEVICES).query(
        `DELETE dbo.PushSubscription WHERE user_id = @userId AND endpoint_hash NOT IN
           (SELECT TOP (@max) endpoint_hash FROM dbo.PushSubscription WHERE user_id = @userId ORDER BY created_at DESC);`);
    },
    async remove(userId, endpoint) {
      await pool.request().input("hash", sql.Char(64), hash(endpoint)).input("userId", sql.UniqueIdentifier, userId)
        .query("DELETE dbo.PushSubscription WHERE endpoint_hash = @hash AND user_id = @userId;");
    },
    async drop(endpointHash) {
      await pool.request().input("hash", sql.Char(64), endpointHash).query("DELETE dbo.PushSubscription WHERE endpoint_hash = @hash;");
    },
    async devices(userIds) {
      const req = pool.request();
      userIds.forEach((id, i) => req.input(`u${i}`, sql.UniqueIdentifier, id));
      const result = await req.query(`SELECT endpoint_hash, endpoint, p256dh, auth FROM dbo.PushSubscription WHERE user_id IN (${userIds.map((_, i) => `@u${i}`).join(",")});`);
      return result.recordset.map((r) => ({ hash: r.endpoint_hash, endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth }));
    },
    // Saved trips of everyone with at least one device (the favourites JSON holds the trips).
    async tripsOfSubscribers() {
      const result = await pool.request().query(`SELECT f.user_id, f.favorites FROM dbo.UserFavorites f
        WHERE EXISTS (SELECT 1 FROM dbo.PushSubscription p WHERE p.user_id = f.user_id);`);
      return result.recordset.map((r) => ({ userId: String(r.user_id).toLowerCase(), favorites: r.favorites }));
    },
    // Once a day, also across restarts and several instances: the day is claimed in dbo.AppSetting.
    async claimDay(day) {
      const result = await pool.request().input("day", sql.NVarChar(4000), day).query(`
        DECLARE @n int;
        UPDATE dbo.AppSetting SET setting_value = @day, updated_at = SYSUTCDATETIME() WHERE setting_key = 'push.daily' AND setting_value < @day;
        SET @n = @@ROWCOUNT;
        IF @n = 0 AND NOT EXISTS (SELECT 1 FROM dbo.AppSetting WHERE setting_key = 'push.daily')
        BEGIN
          INSERT dbo.AppSetting (setting_key, setting_value, updated_at) VALUES ('push.daily', @day, SYSUTCDATETIME());
          SET @n = 1;
        END
        SELECT @n AS n;`);
      return !!result.recordset[0]?.n;
    },
  };
}

/* ---------- Trips that need a reminder ---------- */

// Departure and return day of a saved trip, as the app reads them (flight, trip by train/bus, or several legs).
function tripDays(f) {
  if (f?.flight?.day) return { day: f.flight.day, back: f.flight.back || "" };
  const m = /^f:[A-Z]+\|[^|]*\|[A-Z]{3}\|[A-Z]{3}\|(\d{4}-\d{2}-\d{2})/.exec(f?.id || "");
  if (m) {
    const back = /powrót (\d{2})\.(\d{2})/.exec(f.detail || "");
    const year = m[1].slice(0, 4);
    let backDay = back ? `${year}-${back[2]}-${back[1]}` : "";
    if (backDay && backDay < m[1]) backDay = `${Number(year) + 1}-${back[2]}-${back[1]}`;
    return { day: m[1], back: backDay };
  }
  const legs = f?.trip?.multi ? f.trip.legs : null;
  if (legs?.length) {
    const last = legs[legs.length - 1].arrDay || legs[legs.length - 1].day || "";
    return { day: legs[0].day || "", back: last > (legs[0].day || "") ? last : "" };
  }
  const g = f?.trip?.ground;
  if (g?.out?.day) return { day: g.out.day, back: g.back?.day || g.roundBack || "" };
  return { day: "", back: "" };
}

const tripName = (f) => short(f.title || [f.from, f.to].filter(Boolean).join(" → ") || "Twoja podróż", 70);
const outTime = (f) => (/^\d{2}:\d{2}/.test(f?.trip?.out?.dep || "") ? f.trip.out.dep.slice(0, 5) : "");

// Reminders for one user's favourites: a booked trip that leaves tomorrow, or comes back tomorrow.
function tripReminders(favorites, tomorrow) {
  let items;
  try {
    items = typeof favorites === "string" ? JSON.parse(favorites) : favorites;
  } catch {
    return [];
  }
  const list = Array.isArray(items) ? items : Array.isArray(items?.items) ? items.items : [];
  const out = [];
  for (const f of list) {
    if (f?.type !== "trip" || f.status !== "booked" || !f.tid) continue;
    const { day, back } = tripDays(f);
    const url = `/trip?id=${encodeURIComponent(f.tid)}`;
    if (day === tomorrow) {
      const at = outTime(f);
      out.push({ title: `Jutro wyjazd${at ? ` o ${at}` : ""}`, body: `${tripName(f)}. Sprawdź dojazd i plan podróży.`, url, tag: `trip:${f.tid}:out` });
    } else if (back && back === tomorrow) {
      out.push({ title: "Jutro powrót", body: `${tripName(f)}. Sprawdź dojazd na lotnisko lub dworzec.`, url, tag: `trip:${f.tid}:back` });
    }
  }
  return out;
}

/* ---------- Sending ---------- */

function warsaw(t = Date.now()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(t)).map((p) => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}
const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

function createPush({ db, webpush = null, env = process.env, now = () => Date.now(), hour = Number(env.PODAVO_PUSH_HOUR) || 8 } = {}) {
  const publicKey = () => String(env.PODAVO_VAPID_PUBLIC_KEY || "").trim();
  const privateKey = () => String(env.PODAVO_VAPID_PRIVATE_KEY || "").trim();
  const enabled = () => !!db && !!publicKey() && !!privateKey();
  let lib = webpush;
  let configured = false;
  function client() {
    if (!lib) lib = require("web-push");
    if (!configured) {
      // Push services (Apple's especially) reject a subject that is not a mailto: or https: URL.
      const subject = String(env.PODAVO_VAPID_SUBJECT || "").trim();
      lib.setVapidDetails(/^(mailto:|https:\/\/)/.test(subject) ? subject : "mailto:kontakt@podavo.pl", publicKey(), privateKey());
      configured = true;
    }
    return lib;
  }

  async function subscribe(userId, body) {
    if (!enabled()) throw new PushInputError("Powiadomienia push nie są jeszcze włączone na serwerze.");
    const endpoint = String(body?.endpoint || "");
    const p256dh = String(body?.keys?.p256dh || "");
    const auth = String(body?.keys?.auth || "");
    if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000 || !p256dh || p256dh.length > 200 || !auth || auth.length > 100)
      throw new PushInputError("Niepoprawna subskrypcja powiadomień.");
    await db.save(userId, { endpoint, p256dh, auth });
  }

  async function unsubscribe(userId, endpoint) {
    if (!enabled() || !endpoint) return;
    await db.remove(userId, String(endpoint));
  }

  // Sends to every device of each user. Never throws (logs instead); returns counts.
  async function send(userIds, msg, urgent = true) {
    const report = { available: enabled(), devices: 0, sent: 0, removed: 0, errors: [] };
    const users = [...new Set(userIds.filter(Boolean))];
    if (!report.available || !users.length) return report;
    try {
      const subs = await db.devices(users);
      report.devices = subs.length;
      const payload = JSON.stringify({ title: short(msg.title, 80), body: short(msg.body, 180), url: msg.url || "/", tag: msg.tag || "" });
      await Promise.all(subs.map(async (s) => {
        const host = (() => { try { return new URL(s.endpoint).host; } catch { return "?"; } })();
        try {
          await client().sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload,
            { TTL: 24 * 3600, urgency: urgent ? "high" : "normal", timeout: 10000 });
          report.sent += 1;
        } catch (error) {
          const status = error.statusCode;
          const detail = String(error.body || error.message || "").slice(0, 300);
          report.errors.push(`${host}: ${status ?? ""} ${detail}`.trim());
          if (deadSubscription(status, detail)) {
            report.removed += 1;
            await db.drop(s.hash).catch(() => {});
          } else console.warn(`push failed (${host}):`, status ?? "", detail);
        }
      }));
    } catch (error) {
      report.available = false;
      report.errors.push(error.message);
      console.warn("push:", error.message);
    }
    return report;
  }

  // "Wyślij powiadomienie testowe": the user's own devices. Each test gets its own tag so a second one shows too.
  async function test(userId) {
    const r = await send([userId], { title: "Podavo: powiadomienie testowe", body: "Tak będą wyglądać przypomnienia o podróżach i alerty cenowe.", url: "/my-trips", tag: `test:${now()}` });
    return { available: r.available, devices: r.devices, sent: r.sent, removed: r.removed };
  }

  // A price alert reached its price.
  function priceAlert(alert, price) {
    if (!alert?.userId) return Promise.resolve(null);
    const days = alert.back ? `${alert.day} – ${alert.back}` : alert.day;
    return send([alert.userId], {
      title: `Cena lotu ${alert.from} → ${alert.to}: ${price} zł`,
      body: `${days}. Twój limit to ${alert.maxPrice} zł.`,
      url: "/favourites",
      tag: `alert:${alert.id}`,
    });
  }

  async function sendDailyReminders(t = now()) {
    if (!enabled()) return { sent: 0 };
    const today = warsaw(t).day;
    if (!(await db.claimDay(today))) return { sent: 0, skipped: true };
    const tomorrow = addDays(today, 1);
    let sent = 0;
    for (const row of await db.tripsOfSubscribers()) {
      for (const msg of tripReminders(row.favorites, tomorrow)) {
        const r = await send([row.userId], msg, false);
        sent += r.sent;
      }
    }
    console.log(`push: daily reminders ${today}: ${sent} sent`);
    return { sent };
  }

  // Checks the clock every 15 minutes; at 8:00 Polish time (or the first check after it) it sends the reminders.
  function start() {
    if (!enabled()) return;
    let lastDay = "";
    const tick = () => {
      const { day, hour: h } = warsaw(now());
      if (day === lastDay || h < hour || h >= 21) return;
      lastDay = day;
      sendDailyReminders().catch((error) => {
        console.warn("push reminders:", error.message);
        lastDay = "";
      });
    };
    setTimeout(tick, 60000).unref?.();
    setInterval(tick, 15 * 60000).unref?.();
  }

  return { enabled, publicKey: () => (enabled() ? publicKey() : null), subscribe, unsubscribe, send, test, priceAlert, sendDailyReminders, start };
}

module.exports = { createPush, createPushDatabase, tripReminders, tripDays, PushInputError };
