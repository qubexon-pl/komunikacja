"use strict";

// Price alerts: a signed-in user picks a flight route, the days and the most they want to pay, and how often
// the price should be checked. The server asks the flight-tracker about due alerts on that schedule, compares
// the cheapest known ticket with the limit after every check and emails the user when the price is reached.

const ALERT_EVERY_HOURS = [3, 6, 12, 24, 72, 168];
const MAX_ALERTS_PER_USER = 20;
const MAX_DAYS_AHEAD = 366;
const TICK_MS = 10 * 60 * 1000;
const IATA = /^[A-Z]{3}$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

class AlertError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const isoDay = (date) => date.toISOString().slice(0, 10);
const dayValue = (value) => (value instanceof Date ? isoDay(value) : value ? String(value).slice(0, 10) : null);
const money = (value) => (value == null ? null : Math.round(Number(value) * 100) / 100);

function toAlert(row) {
  return {
    id: String(row.alert_id).toLowerCase(),
    from: String(row.from_airport).trim(),
    to: String(row.to_airport).trim(),
    day: dayValue(row.depart_day),
    back: dayValue(row.return_day),
    airline: row.airline || "",
    maxPrice: money(row.max_price_pln),
    everyHours: row.every_hours,
    label: row.label || "",
    lastPrice: money(row.last_price_pln),
    lastCheckedAt: row.last_checked_at ? new Date(row.last_checked_at).toISOString() : null,
    lastScanAt: row.last_scan_at ? new Date(row.last_scan_at).toISOString() : null,
    notifiedPrice: money(row.notified_price_pln),
    notifiedAt: row.notified_at ? new Date(row.notified_at).toISOString() : null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    email: row.email || undefined,
  };
}

// Checks what a user typed; the same rules apply whether the alert comes from a flight card or a saved trip.
function validateAlert(input, today) {
  const code = (value) => String(value || "").trim().toUpperCase();
  const from = code(input.from);
  const to = code(input.to);
  const day = String(input.day || "");
  const back = String(input.back || "");
  const airline = ["RYANAIR", "WIZZ"].includes(code(input.airline)) ? code(input.airline) : "";
  const maxPrice = Number(String(input.maxPrice ?? "").replace(",", "."));
  const everyHours = Number(input.everyHours);
  const ahead = (value) => (Date.parse(value) - Date.parse(today)) / 86400000;
  if (!IATA.test(from) || !IATA.test(to) || from === to) throw new AlertError("Wybierz lotnisko wylotu i przylotu.");
  if (!ISO_DAY.test(day) || ahead(day) < 0 || ahead(day) > MAX_DAYS_AHEAD) throw new AlertError("Podaj datę wylotu w ciągu najbliższego roku.");
  if (back && (!ISO_DAY.test(back) || back < day || ahead(back) > MAX_DAYS_AHEAD)) throw new AlertError("Data powrotu nie może być wcześniejsza niż data wylotu.");
  if (!(maxPrice >= 1 && maxPrice <= 100000)) throw new AlertError("Podaj cenę od 1 do 100 000 zł.");
  if (!ALERT_EVERY_HOURS.includes(everyHours)) throw new AlertError("Wybierz, jak często sprawdzać cenę.");
  return { from, to, day, back: back || null, airline, maxPrice: Math.round(maxPrice * 100) / 100, everyHours, label: String(input.label || "").trim().slice(0, 200) };
}

/* ---------- Azure SQL ---------- */
function createAlertDatabase(pool) {
  const sql = require("mssql");
  return {
    async list(userId) {
      const result = await pool.request().input("userId", sql.UniqueIdentifier, userId)
        .query("SELECT * FROM dbo.PriceAlert WHERE user_id = @userId ORDER BY depart_day, created_at;");
      return result.recordset.map(toAlert);
    },
    async count(userId) {
      const result = await pool.request().input("userId", sql.UniqueIdentifier, userId)
        .query("SELECT COUNT(*) AS n FROM dbo.PriceAlert WHERE user_id = @userId;");
      return result.recordset[0].n;
    },
    async create(userId, alert) {
      const result = await pool.request()
        .input("userId", sql.UniqueIdentifier, userId)
        .input("from", sql.Char(3), alert.from)
        .input("to", sql.Char(3), alert.to)
        .input("day", sql.Date, alert.day)
        .input("back", sql.Date, alert.back)
        .input("airline", sql.VarChar(16), alert.airline || null)
        .input("maxPrice", sql.Decimal(10, 2), alert.maxPrice)
        .input("everyHours", sql.Int, alert.everyHours)
        .input("label", sql.NVarChar(200), alert.label || null)
        .query(`
          INSERT INTO dbo.PriceAlert (user_id, from_airport, to_airport, depart_day, return_day, airline, max_price_pln, every_hours, label)
          OUTPUT INSERTED.*
          VALUES (@userId, @from, @to, @day, @back, @airline, @maxPrice, @everyHours, @label);`);
      return toAlert(result.recordset[0]);
    },
    async remove(userId, id) {
      const result = await pool.request().input("userId", sql.UniqueIdentifier, userId).input("id", sql.UniqueIdentifier, id)
        .query("DELETE FROM dbo.PriceAlert WHERE alert_id = @id AND user_id = @userId;");
      return result.rowsAffected[0] > 0;
    },
    // Alerts still worth checking, with the address to notify.
    async active(today) {
      const result = await pool.request().input("today", sql.Date, today).query(`
        SELECT a.*, u.email FROM dbo.PriceAlert a JOIN dbo.AppUser u ON u.user_id = a.user_id
        WHERE a.depart_day >= @today;`);
      return result.recordset.map(toAlert);
    },
    async checked(id, price) {
      await pool.request().input("id", sql.UniqueIdentifier, id).input("price", sql.Decimal(10, 2), price)
        .query("UPDATE dbo.PriceAlert SET last_price_pln = @price, last_checked_at = SYSUTCDATETIME() WHERE alert_id = @id;");
    },
    async scanned(ids) {
      for (const id of ids) {
        await pool.request().input("id", sql.UniqueIdentifier, id)
          .query("UPDATE dbo.PriceAlert SET last_scan_at = SYSUTCDATETIME() WHERE alert_id = @id;");
      }
    },
    async notified(id, price) {
      await pool.request().input("id", sql.UniqueIdentifier, id).input("price", sql.Decimal(10, 2), price)
        .query("UPDATE dbo.PriceAlert SET notified_price_pln = @price, notified_at = SYSUTCDATETIME() WHERE alert_id = @id;");
    },
  };
}

/* ---------- Checking prices ---------- */
// The cheapest known ticket for the alert; a round trip needs both directions to be known.
function alertPrice(flights, alert) {
  const out = flights.cheapest({ from: alert.from, to: alert.to, day: alert.day, airline: alert.airline });
  if (!out) return null;
  if (!alert.back) return { price: out.pricePln, out, back: null };
  const back = flights.cheapest({ from: alert.to, to: alert.from, day: alert.back, airline: alert.airline });
  return back ? { price: Math.round((out.pricePln + back.pricePln) * 100) / 100, out, back } : null;
}

// A user hears about a price once; a later, lower price is worth another message.
const shouldNotify = (alert, price) => price != null && price <= alert.maxPrice && (alert.notifiedPrice == null || price < alert.notifiedPrice);

function noticeText(alert, found, appUrl) {
  const fmt = (day) => day.split("-").reverse().join(".");
  const lines = [
    `Cena lotu ${alert.from} → ${alert.to} spadła do ${found.price} zł (Twój limit: ${alert.maxPrice} zł).`,
    "",
    `Wylot: ${fmt(alert.day)}${found.out.departure ? " o " + found.out.departure.slice(11) : ""} · ${found.out.pricePln} zł`,
  ];
  if (found.back) lines.push(`Powrót: ${fmt(alert.back)}${found.back.departure ? " o " + found.back.departure.slice(11) : ""} · ${found.back.pricePln} zł`);
  if (found.out.priceType === "list" || found.back?.priceType === "list") lines.push("", "Wizz Air podaje najtańszy lot dnia; cenę konkretnego lotu potwierdź u przewoźnika.");
  lines.push("", "Cena może się zmienić w każdej chwili. Sprawdź ją u przewoźnika przed zakupem.");
  if (appUrl) lines.push("", `Ulubione i alerty: ${appUrl.replace(/\/$/, "")}/ulubione`);
  return lines.join("\n");
}

function createPriceAlerts({ db, flights, collector = null, sendEmail = null, now = () => new Date(), tickMs = TICK_MS, appUrl = process.env.APP_URL || "" }) {
  let timer = null;
  let ticking = false;

  async function tick() {
    if (ticking) return { checked: 0, notified: 0, scanned: 0 };
    ticking = true;
    try {
      const today = isoDay(now());
      const alerts = await db.active(today);
      let notified = 0;
      for (const alert of alerts) {
        const found = alertPrice(flights, alert);
        const price = found?.price ?? null;
        if (price !== alert.lastPrice) await db.checked(alert.id, price);
        if (shouldNotify(alert, price) && sendEmail && alert.email) {
          try {
            await sendEmail({ to: alert.email, subject: `Cena lotu ${alert.from} → ${alert.to}: ${price} zł — W drogę`, text: noticeText(alert, found, appUrl) });
            await db.notified(alert.id, price);
            notified += 1;
          } catch (error) {
            console.error("Price alert email failed:", error.message);
          }
        }
      }
      // Due alerts ask the airlines again; the tracker runs one collection at a time.
      const due = alerts.filter((alert) => !alert.lastScanAt || now().getTime() - Date.parse(alert.lastScanAt) >= alert.everyHours * 3600000);
      let scanned = 0;
      if (due.length && collector && !collector.status().running) {
        const jobs = [];
        for (const alert of due) {
          const airlines = alert.airline ? [alert.airline] : [];
          const out = flights.pairsFor({ from: alert.from, to: alert.to, airlines });
          if (out.length) jobs.push({ pairs: out, start: alert.day, end: alert.day });
          if (alert.back) {
            const home = flights.pairsFor({ from: alert.to, to: alert.from, airlines });
            if (home.length) jobs.push({ pairs: home, start: alert.back, end: alert.back });
          }
        }
        if (jobs.length) {
          const days = jobs.map((job) => job.start).sort();
          const result = collector.request({ jobs, target: { scope: "alerts", from: [...new Set(due.map((a) => a.from))].join(","), to: [...new Set(due.map((a) => a.to))].join(","), direction: "both", start: days[0], end: days[days.length - 1] } });
          if (result === "started") {
            await db.scanned(due.map((alert) => alert.id));
            scanned = due.length;
          }
        }
      }
      return { checked: alerts.length, notified, scanned };
    } catch (error) {
      console.error("Price alerts:", error.message);
      return { checked: 0, notified: 0, scanned: 0, error: error.message };
    } finally {
      ticking = false;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(tick, tickMs);
    timer.unref?.();
    setTimeout(tick, 60 * 1000).unref?.();
  }

  function stop() {
    clearInterval(timer);
    timer = null;
  }

  // What the API offers a signed-in user; each alert carries its current price.
  async function list(userId) {
    return (await db.list(userId)).map((alert) => {
      const found = alertPrice(flights, alert);
      return { ...alert, email: undefined, currentPrice: found?.price ?? null, reached: found ? found.price <= alert.maxPrice : false };
    });
  }

  async function create(userId, input) {
    const alert = validateAlert(input, isoDay(now()));
    if ((await db.count(userId)) >= MAX_ALERTS_PER_USER) throw new AlertError(`Możesz mieć najwyżej ${MAX_ALERTS_PER_USER} alertów cenowych.`);
    const saved = await db.create(userId, alert);
    const found = alertPrice(flights, saved);
    return { ...saved, email: undefined, currentPrice: found?.price ?? null, reached: found ? found.price <= saved.maxPrice : false };
  }

  async function remove(userId, id) {
    if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw new AlertError("Nie znaleziono alertu.", 404);
    if (!(await db.remove(userId, id))) throw new AlertError("Nie znaleziono alertu.", 404);
  }

  return { create, list, remove, start, stop, tick };
}

module.exports = { ALERT_EVERY_HOURS, AlertError, MAX_ALERTS_PER_USER, alertPrice, createAlertDatabase, createPriceAlerts, noticeText, shouldNotify, validateAlert };
