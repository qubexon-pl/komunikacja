# Komunikacja — Rzeszów

Three-tier web application for Rzeszów public transport:

1. **Frontend** — `index.html` and `assets/` provide the map, timetable search, vehicle status, train board, and settings.
2. **Backend** — `src/server.js` serves the UI and transit data to everyone, keeps favourites on accounts, and exposes authentication, health, and GTFS APIs. Public endpoints that call outside services are rate limited per visitor.
3. **Database** — Azure SQL stores user accounts, provider identities, hashed sessions, and the static GTFS timetable in normalized relational tables. Live vehicle positions remain transient and are refreshed from the public GTFS-Realtime feeds.

## Pages

The app has one page per transport category: `/autobusy` (ZTM, also served at `/`), `/pks`, and `/pociagi`. Each has its own map, statistics, late list, search, and journey planner. `/koncowe` shows the terminal stops of all three categories on one map; a stop counts when at least 15% of a line direction's trips over the next seven days end there. Typing a destination there lists the termini of lines that pass near it, which is the direction to travel, and the nearest terminus. Bus and PKS planners use only that category's stops and lines; the train planner finds direct connections from the PKP PLK data. Tabs switch pages without reloading the timetable. Weather refreshes every 45 minutes.

## Other Polish cities

Every transport page names the selected city in its header. Without a city chosen by hand, the app picks the city with city transport nearest the device's location (the same location the weather widget uses). Each category has three tabs: "Szukaj połączenia", "Rozkład jazdy" and "Linie" (favourites have their own page). Trains show the stations of the selected city ("Wszystkie stacje: Warszawa", then each station) and, under "Linie", the destinations of today's trains from the city.

Every transport page names the selected city in its header. Until a city is chosen by hand, the app picks the city with city transport nearest the device (the location the weather widget uses). Each category has three tabs: "Szukaj połączenia", "Rozkład jazdy" and "Linie"; favourites have their own page. Trains show the stations of the selected city ("Wszystkie stacje: Warszawa", then each station) and, under "Linie", the destinations of today's trains from the city.

The city picker on the transport pages lists Rzeszów, which has the full pages above, and 48 other Polish cities with city transport (Warszawa, Kraków, Łódź, Wrocław, Poznań, Gdańsk, Gdynia, Szczecin, Bydgoszcz, Lublin, Białystok, Katowice and the GZM, Toruń, Kielce and more; the list is in [`assets/app.cities.js`](./assets/app.cities.js), read by both the browser and the server). For them "Komunikacja miejska" shows a journey planner with trams, buses and metro moving on the map, and "Rozkład jazdy" shows departures from a stop for any day and hour, filtered by line, with live delays where the operator publishes them, and "Linie" lists the lines running in the next half hour. Trains work for every town with a station, as before.

These cities come from [Transitous](https://transitous.org), which already imports each operator's open GTFS feed and its GTFS-Realtime delays, so no feed download, database import or API key is needed. The server asks Transitous one request at a time and keeps answers (stop searches for an hour, departures for 30 seconds, journeys for 10 minutes, vehicles for a minute). Endpoints: `/api/transit/cities`, `/api/transit/stops?city=<id>&q=<text>`, `/api/transit/departures?stop=<id>&time=<local>`, `/api/transit/lines?city=<id>`, plus the existing `/api/transit/plan` and `/api/transit/vehicles`. To add a city, check that its operator is in Transitous' [`feeds/pl.json`](https://github.com/public-transport/transitous/blob/main/feeds/pl.json) and add a row to `assets/app.cities.js`.

## Timetables

The server downloads each timetable once a day into `.cache/timetables` (or `TIMETABLE_CACHE_DIR`). When the feed changes it is imported into Azure SQL in one transaction, so a failed import keeps the previous timetable. Visitors load it from `/api/schedule/<agency>`, a compressed copy built from the database once per import. If the database has no copy, `/api/timetable/<agency>` serves the downloaded file instead. Custom timetable addresses from Ustawienia are fetched directly.

Bus and PKS pages list every departure from a stop for today or the next six days, 20 per page, and open on the page with the next departure. The train board lists today's trains, 15 per page. The journey planner has earlier and later buttons to move beyond its search window.

## Street search

"Jak dojechać" accepts a street, with or without a house number, as well as a stop or station name. The server checks the address with OpenStreetMap's public Nominatim service through `/api/geocode`, at most one request per second and with a 24-hour cache. Nominatim does not allow search-as-you-type, so live suggestions come from the Photon service through `/api/streets` and the chosen address is still checked with Nominatim when the form is submitted. The planner then compares several stops near each address and counts the estimated walk. Heavier traffic would need a self-hosted or paid geocoder.

## Flights and European cities

Trips by plane are planned between any two places: a Polish address, or a city anywhere in Europe (typed by name, such as "Zurych", "Lizbona" or "Ryga", or by airport code). The planner looks for flights from the airports nearest the start (within the chosen radius) to the airports within 200 km of the destination, and ranks them by the whole journey, including the trip to and from the airport. In a multi-stop trip each stage can start abroad, for example Barcelona to Rome.

Airports come from the built-in list in `src/airports.js`, which covers the capitals and main holiday and business airports of Europe, and from the route lists of Ryanair and Wizz Air, refreshed weekly. Fares come from three sources:

1. **Ryanair** through its public fare finder and timetable (`src/ryanair-api.js`). No key is needed; `RYANAIR_API=off` turns it off.
2. **Wizz Air** through its timetable (`src/wizz-timetable.js`). No key is needed.
3. **Every other airline** (LOT, Lufthansa, Swiss, SAS, KLM, Air France, easyJet and others) through the [Duffel](https://duffel.com) flights API (`src/duffel-api.js`), including flights with one change. It needs `DUFFEL_ACCESS_TOKEN`; without it this source is off and only Ryanair and Wizz Air are searched. A `duffel_test_` token returns Duffel's sample airline only, so use a live token for real fares. Searches are free up to Duffel's search-to-booking ratio and billed per search beyond it, so each trip search asks about at most four routes, and the same route and day only once every three hours. Ryanair and Wizz Air offers from Duffel are ignored. These fares are kept in memory for six hours and open in Google Flights, which links to the airline's own booking.

## Accommodation

The planner's last step, before saving, has a Nocleg section for the destination; a trip in stages gets one for each city where the traveller spends a night. It offers three ways to add a stay, and the chosen one is saved with the trip and shown on the trip page, map and costs:

- **Search in the app** through the Booking.com Demand API (`src/hotels.js`, `/api/hotels`). It needs `BOOKING_API_KEY` and `BOOKING_AFFILIATE_ID` from the Booking.com Affiliate Partner Centre, which Booking.com grants only to approved Managed Affiliate Partners. It uses the sandbox until `BOOKING_API_BASE` points to production.
- **Search on Booking.com** with the place, dates and number of people filled in. With `BOOKING_AFFILIATE_ID` set (even without an API key) these are affiliate deep links (`aid`, plus `label`, default `voyage-planner`), so bookings made from them are credited to the partner.
- **Add by hand**: name, address (placed on the map), price and booking link.

## Welcome page and app tour

Visitors who are not signed in land on a welcome page (`welcome.html`, served at `/` for them and always at `/welcome`); signed-in users get the app at `/` as before, and `/plan` always opens the app. The guided tour (`assets/app.tour.js`, same walk-through as in Podavo Clean) is offered once per device on the first visit, and can be reopened from the `?` button in the top bar, from the Konto menu, or with `/plan?tour=1`.

## Database design

The schema in [`database/schema.sql`](./database/schema.sql) separates agencies, routes, stops, services, service calendars, service exceptions, trips, stop times, shapes, shape points, and feed import metadata. Account data is separated into users, local credentials, external identities, sessions, and short-lived email challenges; pending registrations are stored separately and do not create an account before email verification. Composite primary and foreign keys keep IDs scoped to their agency and enforce the timetable relationships. The source URL is represented in storage only by a SHA-256 hash.

## Azure SQL

The development database is `komunikacja` on `datateamserverdev.database.windows.net` in the `Data Team Subscription` (`rg_dataengineering_we_dev_001`, West Europe, Basic tier).

Authentication uses Microsoft Entra Default credentials: Azure CLI credentials for local development and managed identity when hosted in Azure. No SQL passwords are stored in the repository.

1. Install Node.js 20 or newer and run `npm install`.
2. Sign in with an identity that has database access:

   ```powershell
   az login --subscription "Data Team Subscription"
   ```

3. Copy `.env.example` to `.env` and set `AZURE_SQL_SERVER` and `AZURE_SQL_DATABASE` if they differ from the development defaults.
4. Apply the idempotent schema and start the application:

   ```powershell
   npm run db:migrate
   npm start
   ```

5. Open `http://localhost:3000`. Check database connectivity at `/api/health`.

The Azure SQL server firewall must allow the client or hosting environment. Do not add a broad firewall rule; request a narrowly scoped rule for the required egress IP if connectivity is blocked.

## User sign-in

Accounts are optional: guests can use every transit feature. Favourites are saved in the browser for guests and on the account after signing in, so run `npm run db:migrate` to create the favourites table.

The app supports verified email/password registration and Google sign-in. New local accounts are created only after the user enters the emailed verification code. Password-reset codes expire after 10 minutes and changing a password revokes existing sessions. Account deletion requires a signed-in session and an emailed confirmation code; it removes the account's credentials, provider identities, and sessions. Google accounts require a Google-verified email. Shared GTFS imports are restricted to administrator accounts.

Email codes are sent through any SMTP account, or through SendGrid. For a free setup, turn on 2-Step Verification for a Gmail account, create an App Password, and set `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_USER` and `SMTP_FROM` to the address, and `SMTP_PASS` to the App Password. SMTP is used instead of SendGrid when both are configured.

The database stores only an HMAC of each short-lived code, and code attempts and resend frequency are limited. Azure Communication Services Email was not selected for new deployments because Microsoft has announced its retirement by September 30, 2028; its Azure-managed domains also have fixed sending limits. To enable registration, recovery, and account deletion:

1. Create a SendGrid account, enable two-factor authentication, and authenticate a sender identity/domain. This repository does not create the provider account or verify a domain. Single Sender Verification is suitable for testing; domain authentication is recommended for production.
2. Create a restricted API key with only **Mail Send** access, then set `SENDGRID_API_KEY` and `SENDGRID_FROM_EMAIL`. Keep the API key in `.env` for local development or a secret store such as Azure Key Vault when hosted.
3. Set `AUTH_CODE_PEPPER` to a persistent random secret of at least 32 characters. For example, generate one locally in PowerShell:

   ```powershell
   [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(48))
   ```

For local development without SendGrid, set `AUTH_EMAIL_CONSOLE=true` to print codes to the server console instead of sending them; `AUTH_CODE_PEPPER` is still required, and the setting is ignored when `NODE_ENV=production`.

Restart the app after configuring these values. The registration and recovery options remain unavailable in the login page until the SendGrid settings and code pepper are present. SendGrid's documented free trial is limited to 100 emails per day for 60 days; ongoing use requires a paid plan.

1. Copy `.env.example` to `.env`. Configure `APP_BASE_URL` to the exact origin you use to open the app (for local development, `http://localhost:3000`).
2. To enable Google sign-in, create a Google OAuth **Web application** client and set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Register this exact authorized redirect URI in Google Cloud:

   ```text
   http://localhost:3000/api/auth/google/callback
   ```

   For deployment, use the HTTPS app origin instead. Restart the server after changing OAuth settings.
3. Set `ADMIN_EMAILS` to a comma-separated list of trusted, Google-verified administrator email addresses **before** those users first sign in with Google. Local email/password registrations never receive administrator privileges. Only admins can import or replace shared transit schedules.
4. Configure SendGrid as described above if local registration, password recovery, or account deletion should be enabled.
5. Run `npm run db:migrate` again to create the account, identity, session, and email-challenge tables, then run `npm start` and open `/login`.

Google credentials and `ADMIN_EMAILS` are secrets/configuration: do not commit them. For production, store them in Azure App Service settings or Key Vault, use HTTPS, and grant the app identity least-privilege database access.

## AI sightseeing plan

On a saved trip's page, each city's sightseeing section has a **Plan od AI** box. The traveller sets their preferences once (interests, pace, budget, how much they like to walk, a free-text note about themselves) and can add a wish for this trip only. The server (`src/ai-planner.js`) then builds the context from the database and asks Claude for a day-by-day plan:

- the preferences, saved in `UserPreference` under `travelStyle` and reused for every later trip;
- the trip itself from `UserFavorites`: dates, arrival time, hotel, people, and the places already in its sightseeing plan (not repeated);
- the traveller's other saved trips and the places they planned there, as a hint of what they like;
- the Open-Meteo forecast for the stay, so rainy days get indoor places.

Claude (`claude-opus-5-5`, structured JSON output, with Anthropic's server-side fallback if a request is declined) returns real places with approximate positions, times, a reason tied to the preferences, tips and typical prices, in Polish. Positions more than 60 km from the city are dropped. Each place has a **Dojazd** button that fills the city transport planner from the previous place (or the hotel) half an hour before the proposed time, so the ride can be added to the trip as before. The last plan per trip and city is stored in `dbo.TripAiPlan`; each user can ask for 8 plans an hour.

To enable it:

1. Create an API key in the Claude Console (console.anthropic.com → API keys) and set `ANTHROPIC_API_KEY` in `.env` locally, or as an App Service application setting (better: a Key Vault reference) on Azure. Without it the box is hidden and nothing else changes.
2. Optionally set `AI_PLAN_MODEL` to another Claude model id.
3. Run `npm run db:migrate` to create `TripAiPlan`.

A plan uses roughly 3–6k input and 2–4k output tokens, about $0.05–0.10 at Opus 5.5 prices.

## Local checks

```powershell
npm test
```
