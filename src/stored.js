"use strict";

const crypto = require("node:crypto");

// Answers of outside services kept in the database (dbo.DataSnapshot). Every lookup reads the database first and asks
// the outside service only when nothing fresh is stored; a successful answer is then stored for the next visitor, so the
// free services (Nominatim, Photon, OSRM, Open-Meteo, NBP) are asked as rarely as possible.
function createStoredAnswers(snapshots, { now = Date.now, log = console } = {}) {
  const memory = new Map();
  const remember = (key, entry) => {
    memory.set(key, entry);
    if (memory.size > 3000) memory.delete(memory.keys().next().value);
  };

  // prefix: short name of the service; ttlMs: how long an answer stays fresh; keyOf: the arguments that make it unique;
  // worth: whether an answer should be kept (errors and "not configured" answers are not).
  function wrap(prefix, ttlMs, fn, keyOf = (...args) => args, worth = (value) => value != null) {
    if (typeof fn !== "function" || !snapshots || typeof snapshots.read !== "function" || typeof snapshots.save !== "function") return fn;
    return async (...args) => {
      const id = crypto.createHash("sha1").update(JSON.stringify(keyOf(...args))).digest("hex").slice(0, 24);
      const key = `${prefix}:${id}`;
      const fresh = (entry) => entry && Number.isFinite(entry.at) && now() - entry.at < ttlMs;
      const hit = memory.get(key);
      if (fresh(hit)) return hit.value;
      const body = await snapshots.read(key).catch(() => null);
      if (body) {
        try {
          const saved = JSON.parse(Buffer.from(body).toString("utf8"));
          if (fresh(saved)) { remember(key, saved); return saved.value; }
        } catch { /* a damaged copy is simply fetched again */ }
      }
      const value = await fn(...args);
      if (worth(value)) {
        const entry = { at: now(), value };
        remember(key, entry);
        snapshots.save(key, { body: Buffer.from(JSON.stringify(entry)), type: "application/json", etag: `"${id}"` })
          .catch((error) => log.warn(`Stored answers (${prefix}): could not save.`, error.message));
      }
      return value;
    };
  }
  return { wrap };
}

module.exports = { createStoredAnswers };
