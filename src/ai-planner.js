"use strict";

// AI sightseeing plan for one city of a saved trip. Claude reads what the app already knows about the traveller —
// their travel preferences, the trip itself (dates, hotel, how they arrive), their other trips and the places they
// already planned to visit — plus the weather forecast, and proposes a day-by-day plan of places to visit.
// Each place comes with an approximate position, so the trip page can route to it with the city transport planner.
//
// Needs ANTHROPIC_API_KEY. Without it the feature reports itself as unavailable and the app works as before.

const sql = require("mssql");
const { fitDay, checkDay } = require("./route-fit");
// 8b: conflicts are worked out on every read, never stored, so they follow the current order and hours.
const withChecks = (plan) => (plan && Array.isArray(plan.days) ? { ...plan, days: plan.days.map((d) => ({ ...d, conflicts: checkDay(d) })) } : plan);

const MODEL = process.env.AI_PLAN_MODEL || "claude-opus-5-5";
const MAX_DAYS = 5;
const MAX_STOPS = 7;
const MAX_TRIPS_IN_CONTEXT = 15;
const PER_USER_PER_HOUR = 8;
const CATALOGUE_MIN = 8; // fewer catalogued places than this: the plan falls back to the model's own knowledge
const CATALOGUE_MAX = 80;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TID = /^[a-z0-9]{6,24}$/;

const INTERESTS = ["museums", "history", "architecture", "art", "food", "cafes", "nightlife", "nature", "views", "shopping", "kids", "sport", "religious", "hidden"];
const PACES = ["relaxed", "balanced", "packed"];
const BUDGETS = ["low", "medium", "high"];
const WALKING = ["little", "some", "lots"];
const CATEGORIES = ["sight", "museum", "food", "cafe", "park", "view", "shopping", "nightlife", "activity", "other"];

const bad = (message, status = 400) => Object.assign(new Error(message), { status, expose: true }); // shown to the traveller
const text = (value, max) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");
const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
const point = (value) => {
  const lat = Number(value?.lat), lon = Number(value?.lon);
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
};
const km = (a, b) => {
  const r = (d) => (d * Math.PI) / 180, dLat = r(b.lat - a.lat), dLon = r(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};
const addDays = (day, n) => new Date(Date.parse(day + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);

// Travel preferences as the traveller set them on the trip page (stored in UserPreference under "travelStyle").
function normalizeStyle(value) {
  const v = value && typeof value === "object" ? value : {};
  const interests = Array.isArray(v.interests) ? [...new Set(v.interests.filter((x) => INTERESTS.includes(x)))] : [];
  return {
    interests,
    pace: pick(v.pace, PACES, "balanced"),
    budget: pick(v.budget, BUDGETS, "medium"),
    walking: pick(v.walking, WALKING, "some"),
    notes: text(v.notes, 400),
  };
}

// The JSON the model must return (structured outputs: every field required, no extra fields).
const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "days", "tips"],
  properties: {
    summary: { type: "string", description: "Two or three sentences: why this plan suits the traveller." },
    days: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["day", "theme", "weatherNote", "stops"],
        properties: {
          day: { type: "string", description: "YYYY-MM-DD" },
          theme: { type: "string" },
          weatherNote: { type: "string", description: "Empty when there is no forecast for the day." },
          stops: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["placeId", "time", "name", "category", "lat", "lon", "minutes", "why", "tip", "priceNote"],
              properties: {
                placeId: { type: "string", description: "The id of the place in the catalogue, copied exactly; empty only when no catalogue was given" },
                time: { type: "string", description: "Local start time HH:MM" },
                name: { type: "string", description: "The real name of the place, as on a map" },
                category: { type: "string", enum: CATEGORIES },
                lat: { type: "number" },
                lon: { type: "number" },
                minutes: { type: "integer", description: "How long to stay" },
                why: { type: "string", description: "One sentence tying the place to the traveller's preferences" },
                tip: { type: "string", description: "A practical tip, or empty" },
                priceNote: { type: "string", description: "Typical entry or meal price, or empty" },
              },
            },
          },
        },
      },
    },
    tips: { type: "array", items: { type: "string" } },
  },
};

const SYSTEM = `You plan city sightseeing for travellers who use podavo.voyage, a Polish travel planner.
You get the traveller's preferences, the trip (city, dates, where they sleep, when they arrive and leave), their other trips and the places they already put in their plans, and the weather forecast when it exists.
Propose a realistic day-by-day plan for the given city only:
- Use real, well-known places that exist in that city; give their approximate latitude and longitude. Never invent a place.
- Follow the preferences: interests decide the kind of places, pace decides how many stops a day (relaxed 3-4, balanced 4-5, packed 5-${MAX_STOPS}), walking decides how spread out a day may be, budget decides paid attractions and restaurants.
- Do not repeat places the traveller has already planned in this city; use their past trips only as a hint of what they like.
- On the arrival day start after the arrival time; on the departure day finish in time to leave. Group nearby places in the same day, in a sensible walking or public transport order, starting near where they sleep when it is known.
- When the forecast shows rain or strong wind, prefer indoor places that day and say so in weatherNote.
- Include one place to eat per day that fits the budget.
- Write all text (summary, theme, weatherNote, why, tip, priceNote, tips) in Polish, short and concrete. Prices in the local currency.
- At most ${MAX_DAYS} days and ${MAX_STOPS} stops a day. Keep tips to at most 4 short items.
- When the data has a "catalogue" of places (from OpenStreetMap), every stop must be one of them: copy its id into placeId and its name exactly, and use its opening hours when they are given. Do not add places that are not in the catalogue. Without a catalogue, leave placeId empty.`;

// What the traveller's other saved trips say about them: where they went and which places they planned there.
function travelHistory(favorites, tid) {
  const trips = (Array.isArray(favorites) ? favorites : []).filter((f) => f?.type === "trip" && f.tid !== tid);
  return trips.slice(-MAX_TRIPS_IN_CONTEXT).map((f) => {
    const T = f.trip || {};
    const local = Array.isArray(T.local) ? T.local : [];
    const places = local.flatMap((g) => (Array.isArray(g?.items) ? g.items.map((x) => text(x?.to, 80)) : [])).filter(Boolean);
    return {
      to: text(f.title || f.to, 80),
      when: text(T.out?.day || f.flight?.day || "", 10),
      status: f.status || "planned",
      ...(places.length ? { places: [...new Set(places)].slice(0, 12) } : {}),
    };
  });
}

// Places of this city already in the trip's own sightseeing plan.
function plannedHere(trip, city) {
  const local = Array.isArray(trip?.local) ? trip.local : [];
  const group = local.find((g) => g?.city === city);
  return [...new Set((group?.items || []).map((x) => text(x?.to, 80)).filter(Boolean))];
}

function arrivalOf(trip) {
  const T = trip || {};
  return text(T.out?.arr || T.out?.arrival || "", 16) || null;
}

// The model's answer, checked: known days only, places near the city, sane numbers.
// With a catalogue (7c), a stop is kept only when it names a catalogued place, and its name, position and kind come
// from the catalogue, not from the model.
const CAT_OF = { museum: "museum", sight: "sight", view: "view", park: "park", food: "food", cafe: "cafe", nightlife: "nightlife" };
function cleanPlan(raw, { centre, days, catalogue = null }) {
  const allowed = new Set(days);
  const known = catalogue && catalogue.size ? catalogue : null;
  const out = {
    summary: text(raw?.summary, 600),
    days: [],
    tips: (Array.isArray(raw?.tips) ? raw.tips : []).map((x) => text(x, 200)).filter(Boolean).slice(0, 4),
  };
  for (const d of Array.isArray(raw?.days) ? raw.days : []) {
    if (!DAY.test(d?.day) || !allowed.has(d.day) || out.days.some((x) => x.day === d.day)) continue;
    const stops = [];
    for (const s of Array.isArray(d.stops) ? d.stops : []) {
      const place = known ? known.get(text(s?.placeId, 40)) : null;
      if (known && !place) continue; // not from the catalogue: an invented or unknown place is dropped
      const name = place ? place.name : text(s?.name, 120);
      if (!name) continue;
      const at = place ? { lat: place.lat, lon: place.lon } : point(s);
      // A position far from the city is a mistake: keep the place, drop the position (the page searches it by name).
      const near = at && centre && km(centre, at) <= 60 ? at : null;
      stops.push({
        time: /^\d{2}:\d{2}$/.test(s.time) ? s.time : "",
        name,
        category: place ? CAT_OF[place.cat] || "other" : pick(s.category, CATEGORIES, "other"),
        ...(place ? { osm: place.id, ...(place.openingHours ? { openingHours: place.openingHours } : {}) } : {}),
        lat: near ? Math.round(near.lat * 1e5) / 1e5 : null,
        lon: near ? Math.round(near.lon * 1e5) / 1e5 : null,
        minutes: Number.isInteger(s.minutes) && s.minutes > 0 ? Math.min(s.minutes, 480) : null,
        why: text(s.why, 240),
        tip: text(s.tip, 240),
        priceNote: text(s.priceNote, 120),
      });
      if (stops.length === MAX_STOPS) break;
    }
    if (stops.length) out.days.push({ day: d.day, theme: text(d.theme, 120), weatherNote: text(d.weatherNote, 200), stops });
  }
  out.days.sort((a, b) => a.day.localeCompare(b.day));
  return out;
}

function createPlanStore(pool) {
  return {
    async read(userId, tripId, city) {
      const r = await pool.request()
        .input("userId", sql.UniqueIdentifier, userId).input("tripId", sql.VarChar(24), tripId).input("city", sql.NVarChar(120), city)
        .query("SELECT [plan], created_at FROM dbo.TripAiPlan WHERE user_id = @userId AND trip_id = @tripId AND city = @city;");
      const row = r.recordset[0];
      return row ? { ...JSON.parse(row.plan), createdAt: new Date(row.created_at).toISOString() } : null;
    },
    async save(userId, tripId, city, plan, model) {
      await pool.request()
        .input("userId", sql.UniqueIdentifier, userId).input("tripId", sql.VarChar(24), tripId).input("city", sql.NVarChar(120), city)
        .input("plan", sql.NVarChar(sql.MAX), JSON.stringify(plan)).input("model", sql.VarChar(60), model)
        .query(`
          UPDATE dbo.TripAiPlan WITH (UPDLOCK, SERIALIZABLE) SET [plan] = @plan, model = @model, created_at = SYSUTCDATETIME()
            WHERE user_id = @userId AND trip_id = @tripId AND city = @city;
          IF @@ROWCOUNT = 0
            INSERT INTO dbo.TripAiPlan (user_id, trip_id, city, [plan], model) VALUES (@userId, @tripId, @city, @plan, @model);`);
    },
  };
}

// client: an Anthropic SDK client (or a stand-in in tests); null switches the feature off.
function createAiPlanner({ client = null, store, getFavorites, getPreferences, savePreferences, forecast = null, places = null, model = MODEL, now = Date.now } = {}) {
  const used = new Map(); // userId → times of recent generations

  function allowed(userId) {
    const t = now(), recent = (used.get(userId) || []).filter((x) => t - x < 3600000);
    if (recent.length >= PER_USER_PER_HOUR) return false;
    recent.push(t);
    used.set(userId, recent);
    if (used.size > 5000) used.clear();
    return true;
  }

  async function findTrip(userId, tid) {
    if (!TID.test(tid || "")) throw bad("Nieprawidłowa podróż.");
    const favorites = await getFavorites(userId);
    const trip = favorites.find((f) => f?.type === "trip" && f.tid === tid);
    if (!trip) throw bad("Nie znaleźliśmy tej podróży na Twoim koncie.", 404);
    return { favorites, trip };
  }

  async function saved(userId, { tid, city }) {
    const name = text(city, 120);
    if (!name) throw bad("Podaj miasto.");
    await findTrip(userId, tid);
    return withChecks(await store.read(userId, tid, name));
  }

  async function styleOf(userId) {
    return normalizeStyle((await getPreferences(userId))?.travelStyle);
  }

  async function saveStyle(userId, style) {
    const current = (await getPreferences(userId)) || {};
    const clean = normalizeStyle(style);
    await savePreferences(userId, { ...current, travelStyle: clean });
    return clean;
  }

  async function generate(userId, body = {}) {
    if (!client) throw bad("Plan od AI nie jest włączony na tym serwerze.", 503);
    const city = text(body.city, 120), centre = point(body.centre), home = point(body.home);
    if (!city || !centre) throw bad("Podaj miasto i jego położenie.");
    const { favorites, trip } = await findTrip(userId, body.tid);
    const first = DAY.test(body.day) ? body.day : new Date(now()).toISOString().slice(0, 10);
    const last = DAY.test(body.back) && body.back >= first ? body.back : first;
    const days = [];
    for (let d = first; d <= last && days.length < MAX_DAYS; d = addDays(d, 1)) days.push(d);
    const style = body.style ? await saveStyle(userId, body.style) : await styleOf(userId);
    if (!allowed(userId)) throw bad("Plan od AI można przygotować kilka razy na godzinę. Spróbuj ponownie później.", 429);

    let weather = [];
    if (forecast) {
      try {
        const r = await forecast({ lat: centre.lat, lon: centre.lon, from: days[0], to: days.at(-1) });
        weather = (r?.days || []).map((d) => ({ day: d.day, min: d.min, max: d.max, rainChance: d.rainChance, rainMm: d.rainMm, windKmh: d.windKmh }));
      } catch (error) {
        console.warn("AI plan: no forecast:", error.message);
      }
    }
    // 7c: the places the plan may use, from the OpenStreetMap catalogue around the stay (or the centre).
    let catalogue = null;
    if (places) {
      try {
        const at = home || centre, r = await places({ lat: at.lat, lon: at.lon, radius: 3000, cats: Object.keys(CAT_OF), lang: "pl" });
        const list = (r?.places || []).slice(0, CATALOGUE_MAX);
        if (list.length >= CATALOGUE_MIN) catalogue = new Map(list.map((p) => [p.id, p]));
      } catch (error) {
        console.warn("AI plan: no catalogue:", error.message);
      }
    }
    const T = trip.trip || {};
    const context = {
      city,
      cityCentre: centre,
      days,
      stayingAt: home ? { ...home, name: text(body.homeLabel, 120) || text(T.hotel?.name, 120) || null } : (T.hotel?.name ? { name: text(T.hotel.name, 120) } : null),
      arrival: arrivalOf(T),
      people: Number.isInteger(T.people) && T.people > 0 ? T.people : 1,
      trip: { title: text(trip.title || `${trip.from} → ${trip.to}`, 120), status: trip.status || "planned" },
      preferences: style,
      extraWish: text(body.note, 300),
      alreadyPlannedHere: plannedHere(T, text(body.local, 120) || city),
      otherTrips: travelHistory(favorites, trip.tid),
      weather,
      ...(catalogue ? { catalogue: [...catalogue.values()].map((p) => ({ id: p.id, name: p.name, kind: p.cat, km: p.km, ...(p.openingHours ? { hours: p.openingHours } : {}) })) } : {}),
    };

    const response = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: { type: "json_schema", schema: PLAN_SCHEMA } },
      system: SYSTEM,
      messages: [{ role: "user", content: `Prepare the plan from this data (JSON):\n${JSON.stringify(context)}` }],
    });
    if (response.stop_reason === "refusal") throw bad("AI nie przygotowało planu dla tego miejsca. Spróbuj zmienić życzenia.", 422);
    if (response.stop_reason === "max_tokens") throw bad("Plan wyszedł za długi. Wybierz krótszy pobyt lub spokojniejsze tempo.", 502);
    const textBlock = (response.content || []).find((b) => b.type === "text");
    let raw;
    try {
      raw = JSON.parse(textBlock?.text || "");
    } catch {
      throw bad("AI zwróciło nieczytelną odpowiedź. Spróbuj ponownie.", 502);
    }
    const plan = { ...cleanPlan(raw, { centre, days, catalogue }), city, preferences: style, note: context.extraWish, source: catalogue ? "osm" : "model" };
    if (!plan.days.length) throw bad("AI nie zaproponowało żadnych miejsc. Spróbuj ponownie.", 502);
    await store.save(userId, trip.tid, city, plan, response.model || model);
    return withChecks({ ...plan, createdAt: new Date(now()).toISOString() });
  }

  // 8a: one day of the saved plan in the order that walks the least from the stay; times move with the order.
  async function fit(userId, body = {}) {
    const name = text(body.city, 120);
    if (!name || !DAY.test(body.day || "")) throw bad("Podaj miasto i dzień.");
    await findTrip(userId, body.tid);
    const plan = await store.read(userId, body.tid, name);
    const d = plan?.days?.find((x) => x.day === body.day);
    if (!d) throw bad("Nie ma planu na ten dzień.", 404);
    const { stops, walkKm, savedKm } = fitDay(d.stops, { start: point(body.start) });
    const { createdAt, ...kept } = plan;
    const next = { ...kept, days: plan.days.map(({ conflicts, ...x }) => (x.day === d.day ? { ...x, stops, walkKm, fitted: true } : x)) };
    await store.save(userId, body.tid, name, next, "route-fit");
    return { plan: withChecks({ ...next, createdAt }), savedKm };
  }

  return { enabled: () => !!client, saved, generate, fit, styleOf, saveStyle };
}

// The real client, when a key is configured.
function createAnthropicClient(env = process.env) {
  if (!String(env.ANTHROPIC_API_KEY || "").trim()) return null;
  const { default: Anthropic } = require("@anthropic-ai/sdk");
  return new Anthropic({ timeout: 120000, maxRetries: 2 });
}

module.exports = { createAiPlanner, createPlanStore, createAnthropicClient, normalizeStyle, cleanPlan, travelHistory, PLAN_SCHEMA, INTERESTS };
