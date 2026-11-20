# voyage product backlog

*Last updated: 20 November 2026*

This backlog builds on what voyage already does and aims at one position:

> **Plan, travel and remember the whole trip, door to door, especially by public transport.**

Booking.com, Google and Expedia use their planners to sell rooms and flights. Wanderlog and TripIt organise bookings
you made elsewhere. Rome2Rio shows how to get from A to B but stops there. None of them follows the traveller from
their front door, through the city buses and trains at both ends, to the photo archive afterwards. voyage already
does most of that for Poland. The items below close the gaps where competitors are clearly better, and deepen the
things only voyage does.

## How to read this

- **Priority**: **P0** do next (biggest gap or biggest edge, roughly the next 1 to 2 months), **P1** after that,
  **P2** later or when there is demand.
- **Effort** for one developer with Claude: **S** up to 3 days, **M** 1 to 2 weeks, **L** 3 to 6 weeks, **XL** more.
- **Edge** says what the item does against competitors: *close gap* (they have it, we don't), *extend lead* (only we
  have it, make it stronger), *new* (nobody does it well).

## What voyage has today

Taken from the code and README, so the backlog doesn't repeat it:

- City transport for Rzeszów (ZTM, PKS) from GTFS, and for 48 more Polish cities through Transitous: journey planner,
  stop timetables, lines, live vehicles and delays. Trains in all of Poland from PKP PLK. Terminal stops map.
- Trip planner: door-to-door from a street address, flights across Europe (Ryanair, Wizz Air, Duffel) ranked by the
  whole journey including airport transfers (`data/airport-transfers.csv` plus live Transitous), car (OSRM), multi-stop
  stages, calendar and finish steps.
- Accommodation step (Nocleg): Booking.com Demand API (needs partner approval), Booking deep links with affiliate id,
  or added by hand.
- Trip page: stages, sightseeing plan, map, cost per person in PLN (NBP rates), weather forecast for the stay.
- AI sightseeing plan with Claude, using saved preferences, other trips and the forecast.
- Flight price alerts by e-mail.
- Sharing a trip with participants who have an account, optionally with live location, and an inbox for invitations.
- My trips and archive with photos (chunked upload to ADLS, offline queue) and trip costs.
- Polish and English, web, PWA with offline trip data, Android and iOS apps (Capacitor), admin page with shared
  settings, Google and e-mail sign-in.

## Where competitors are ahead

| Competitor | What they do better today | Backlog answer |
|---|---|---|
| **Booking.com AI Trip Planner** | Real hotel prices, availability, instant booking, reviews, huge inventory, chat-style planning | E6 (stays with transit score), E5 (chat planner), E10 (partner revenue) |
| **Wanderlog** | Real-time co-editing, budget and expense splitting, Gmail import of bookings, route optimisation, offline maps (Pro) | E2, E4, E5.4, E7 |
| **TripIt** | Forward any confirmation e-mail and it builds the itinerary; real-time flight alerts (delays, gates), check-in reminders | E1, E2 |
| **Google (Maps, Search, Gemini)** | AI itineraries inside Maps, hotel and flight price tracking, saved places lists, everything synced to the calendar | E5, E9, E10.1 |
| **Rome2Rio / Omio** | Any A to B worldwide with every mode and price; Omio books trains and coaches across Europe | E3 (prices, coaches, European rail) |
| **Polarsteps** | Automatic trip tracking and a printed travel book | E8 |

## Now / Next / Later

| | Items |
|---|---|
| **Now (P0)** | E1.1 Notifications, E1.2 Today view, E1.3 Delay and connection alerts, E2.1 Forward a booking e-mail, E2.2 Ticket wallet, E3.1 Train ticket prices, E4.1 Shared expenses, E10.1 Calendar export |
| **Next (P1)** | E1.4 Leave-now reminders, E3.2 Coaches and European rail, E3.3 Bike share, E4.2 Live co-editing, E5.1 Trip chat, E5.2 Rain re-plan, E6.1 Transit score for stays, E7.1 Offline maps, E8.1 Trip story page, E9.1 Where can I go for X zł |
| **Later (P2)** | everything else below |

---

## E1. Travel companion on the day (live trip mode)

**Why:** TripIt's paid tier is mostly this, and Booking's planner does nothing once you leave home. voyage already
has live delays for trains, city transport and flights but shows them only when the user goes looking. Turning the
saved trip into something that tells you what to do next is the single biggest step past every competitor, because
nobody else knows your bus to the airport as well as your flight.

| # | Item | Priority | Effort | Edge |
|---|---|---|---|---|
| E1.1 | **Push notifications**: Web Push for the PWA, Firebase / APNs through `@capacitor/push-notifications` for the apps, a `PushSubscription` table, per-user settings (what, quiet hours). Foundation for E1.3, E1.4, E4 and E9. Today alerts go out only by e-mail. | P0 | M | close gap |
| E1.2 | **Today view**: on travel days the app opens on the current trip, showing the next step (leave home at 06:40, bus 14 from Rejtana, train IC 3512 platform 2) with a countdown, then the next one. Works offline from the saved trip. | P0 | M | extend lead |
| E1.3 | **Delay and connection alerts**: watch every leg of a trip in progress (PKP PLK delays, Transitous GTFS-RT, flight status) and notify when a leg is late, and when a connection is at risk. Offer the next working alternative from the planner in one tap. | P0 | L | new |
| E1.4 | **Leave-now and check-in reminders**: "leave in 15 minutes to catch your bus", online check-in opens (Ryanair 24 h / Wizz 30 h before), hotel check-in time. Uses the real walk time to the stop. | P1 | S | close gap |
| E1.5 | **Live location for participants on the day**: the sharing already exists; show everyone's position and ETA on the Today view map, and a "running late" one-tap message to the group. | P2 | M | extend lead |
| E1.6 | **Home screen widget** (Android first) with the next step and departure countdown. | P2 | M | new |

## E2. Get every booking into the trip

**Why:** People book flights, trains and rooms all over the web. TripIt and Wanderlog win because a forwarded e-mail
becomes an itinerary. voyage plans better trips but asks the user to type bookings in. Claude is already wired up
(`src/ai-planner.js`), so parsing a confirmation is a small step.

| # | Item | Priority | Effort | Edge |
|---|---|---|---|---|
| E2.1 | **Forward a booking e-mail**: a personal address (or upload a PDF / screenshot) parsed by Claude with structured output into a flight, train, coach, hotel or event leg, matched to an existing trip by dates and places or creating a new one. Handles Polish confirmations (PKP Intercity, Polregio, Ryanair, Wizz, LOT, Booking, Airbnb). | P0 | L | close gap |
| E2.2 | **Ticket wallet**: keep boarding passes and train tickets (PDF, QR, Apple / Google Wallet passes) on the leg they belong to, available offline in the app and shown in the Today view at the right moment. | P0 | M | close gap |
| E2.3 | **Mark a planned leg as booked**: price paid, booking reference and link, so the cost page uses real prices instead of estimates. | P1 | S | extend lead |
| E2.4 | **Gmail / Outlook connection** (opt-in, read only confirmations) for automatic import, as Wanderlog and TripIt do. Needs Google's restricted-scope review, so start with forwarding. | P2 | L | close gap |

## E3. Public transport depth (the moat)

**Why:** This is where voyage is already better than everyone. Rome2Rio shows modes but rough prices; Google Maps
has no fares for most Polish trains and coaches; Booking has none of it. Making the ground part complete and priced
makes the door-to-door cost honest, which is the main promise.

| # | Item | Priority | Effort | Edge |
|---|---|---|---|---|
| E3.1 | **Train ticket prices**: PKP Intercity and Polregio fares (published tariff by distance plus the class, and discounts: student 51%, senior, Big Family Card), shown on each train leg and used in the trip cost. Link to buy on the carrier site. | P0 | M | extend lead |
| E3.2 | **Coaches and European rail**: FlixBus, RegioJet, Leo Express, ÖBB / DB / ČD connections from and to Poland, from Transitous (which already covers Europe) plus their own price APIs or deep links. Lets a trip to Prague or Vienna be planned without a plane. | P1 | L | close gap |
| E3.3 | **Bike and scooter share**: Nextbike / city bikes from GBFS feeds as a first and last mile option, with docks on the map. | P1 | M | new |
| E3.4 | **City ticket advice**: for each city, which ticket to buy for the stay (24 h, 72 h, single rides) based on the planned rides, with price and where to buy (app, machine). Rzeszów ZTM prices already exist. | P1 | M | new |
| E3.5 | **CO₂ and cost comparison per trip**: show car vs train vs plane for the whole door-to-door journey, with fuel, tolls and parking for the car. | P2 | M | new |
| E3.6 | **Step-free and luggage-friendly routes**: prefer low-floor vehicles and stations with lifts, fewer changes with big luggage. Data from GTFS `wheelchair_boarding` where published. | P2 | M | new |
| E3.7 | **More countries for city transport**: extend `app.cities.js` beyond Poland (Czechia, Germany, Lithuania, Slovakia first) since Transitous already has the feeds. | P1 | M | extend lead |
| E3.8 | **Night trains and sleeper options** shown as "travel and sleep", saving a hotel night in the cost. | P2 | S | new |

## E4. Group trips and money

**Why:** Wanderlog's group features and expense splitting are a key reason people pick it. voyage already has
participants, cost per person and NBP exchange rates, so adding the money part is cheap and very sticky.

| # | Item | Priority | Effort | Edge |
|---|---|---|---|---|
| E4.1 | **Shared expenses**: log what each person paid (any currency, converted with NBP rates), split equally or by share, show who owes whom and the fewest transfers to settle; budget vs actual on the cost page; archived with the trip. | P0 | M | close gap |
| E4.2 | **Live co-editing**: participants edit the plan together, see each other's changes immediately, with a change history. | P1 | L | close gap |
| E4.3 | **Vote on options**: put two hotels, dates or routes in front of the group and let them vote. | P2 | M | close gap |
| E4.4 | **Invite people without an account** by link (read only, or join after sign-up). Today invitations need an existing account. | P1 | S | close gap |
| E4.5 | **BLIK / bank transfer links** to settle debts in one tap. | P2 | M | new |

## E5. AI planner 2.0

**Why:** Booking, Google Gemini and Maps now plan whole trips in a chat. voyage's AI plans only the sightseeing inside
a city. Extending it to the whole trip, and grounding it in real timetables and prices, gives an AI plan you can
actually travel, which theirs isn't.

| # | Item | Priority | Effort | Edge |
|---|---|---|---|---|
| E5.1 | **Trip chat**: "a long weekend in Gdańsk by train for two, under 1,500 zł" produces a full trip draft (dates, trains from the user's address, stay area, day plans) using voyage's own planner as tools, so every leg is real. The user edits the draft in the normal planner. | P1 | L | new |
| E5.2 | **Re-plan the day**: on rain, a closure or a late arrival, the AI rebuilds the rest of the day around what's left, using the forecast that is already fetched. | P1 | M | new |
| E5.3 | **Opening hours and tickets check** for AI places (Google Places / OSM `opening_hours`), with booking links for museums that need a slot. | P1 | M | close gap |
| E5.4 | **Route optimisation**: order the day's places to cut travel time, by city transport and walking. | P1 | M | close gap |
| E5.5 | **Save places from anywhere**: share a link, Instagram post or screenshot to voyage and it becomes a place on the trip's map (Claude extracts it). | P2 | M | close gap |
| E5.6 | **Cost of the AI**: cache plans per city and preference profile, try a smaller Claude model for drafts, keep Opus for the final plan. | P2 | S | n/a |

## E6. Stays that fit the trip

**Why:** This is Booking's home ground, and voyage can't beat its inventory. It can beat it on choosing *where* to
stay: Booking sorts by price and stars, but a traveller without a car needs a place near a good tram line, or next to
the station they arrive at.

| # | Item | Priority | Effort | Edge |
|---|---|---|---|---|
| E6.1 | **Transit score for stays**: for each hotel offer, minutes by public transport to the arrival station or airport and to the planned sights, shown next to the price and usable as a sort. | P1 | M | new |
| E6.2 | **Recommended area to stay** on the map before searching, from the trip's plan and transport. | P1 | M | new |
| E6.3 | **Get Booking.com partner approval** (or a second source with an open API, e.g. an Expedia / Hotellook affiliate) so in-app search works in production. Business task, then switching `BOOKING_API_BASE`. | P1 | S (tech) | close gap |
| E6.4 | **Stay price watch**: alert when the price of a saved hotel drops before the free cancellation deadline. | P2 | M | close gap |

## E7. Offline and reliability abroad

**Why:** Roaming outside the EU and weak signal in trains are the moments travellers need the app most. The PWA
already keeps trip data offline; maps and timetables are the missing part.

| # | Item | Priority | Effort | Edge |
|---|---|---|---|---|
| E7.1 | **Offline maps for the trip**: download map tiles (or vector tiles) for each city of the trip, from the trip page, with the size shown. | P1 | M | close gap |
| E7.2 | **Offline timetables for travel days**: save the planned connections and the next few alternatives for each leg, so the Today view still works without a signal. | P1 | M | extend lead |
| E7.3 | **Status page and error budget** for outside sources (Transitous, PKP PLK, Ryanair, Duffel, Open-Meteo) on the admin page, with automatic fallback messages. Parts exist in `dataIssues()`. | P2 | S | n/a |

## E8. Memories and the archive

**Why:** voyage keeps the trip after it ends, which Booking and TripIt don't. Polarsteps shows how much people love
this. Making the archive shareable also brings in new users.

| # | Item | Priority | Effort | Edge |
|---|---|---|---|---|
| E8.1 | **Trip story page**: a shareable, read-only page with the route on a map, photos placed by EXIF location and time, costs (optional) and notes. | P1 | M | extend lead |
| E8.2 | **Travel stats**: kilometres by mode, CO₂ saved by taking the train, cities and countries, money spent per year. | P2 | S | new |
| E8.3 | **Photo book / PDF** of a trip to print or send. | P2 | M | close gap |
| E8.4 | **Plan again**: copy a past trip to new dates with fresh connections and prices. | P1 | S | new |
| E8.5 | **Journal notes** per day, with voice notes in the apps. | P2 | S | close gap |

## E9. Inspiration and deals

**Why:** Booking's planner starts with "where should I go?". voyage can answer it better for people who travel by
train or cheap flights from where they live.

| # | Item | Priority | Effort | Edge |
|---|---|---|---|---|
| E9.1 | **Where can I go for X zł**: from the user's address, for given dates and budget, list places reachable door to door (train, coach, flight + transfers) with total cost and time, on a map. | P1 | L | new |
| E9.2 | **Price alerts for whole trips**: extend `src/price-alerts.js` from one flight route to a saved trip (flights + trains), sent by push (E1.1) as well as e-mail. | P1 | M | extend lead |
| E9.3 | **Weekend ideas** each week, based on the user's style and the forecast. | P2 | M | new |

## E10. Platform, reach and business

**Why:** Small things that competitors take for granted, plus what voyage needs to grow and pay for itself.

| # | Item | Priority | Effort | Edge |
|---|---|---|---|---|
| E10.1 | **Calendar export**: an `.ics` file and a live calendar feed per trip (and all trips), with each leg as an event and the departure place. | P0 | S | close gap |
| E10.2 | **Export to Google Maps / share a day** as a list of places with directions. | P2 | S | close gap |
| E10.3 | **More languages**: Ukrainian and German first (large groups travelling in and to Poland). `i18n.js` already supports two. | P2 | M | close gap |
| E10.4 | **Accessibility (WCAG 2.2 AA)** pass on the planner, trip page and Today view. | P1 | M | n/a |
| E10.5 | **Finish moving the API to FastAPI** so one service runs in production (see `docs/MOBILE.md`). | P2 | XL | n/a |
| E10.6 | **Revenue without selling out**: affiliate links already exist for Booking; add carrier and coach affiliate programmes and an optional voyage Pro (offline maps, unlimited AI, trip-wide alerts). Keep planning free and neutral, and say so. | P2 | M | n/a |
| E10.7 | **Product analytics** (privacy-friendly, e.g. self-hosted) to see which steps of the planner people drop out of. | P1 | S | n/a |
| E10.8 | **Data export and GDPR**: download all my trips, photos and expenses. | P2 | S | n/a |
| E10.9 | **App store launch**: store listings, screenshots in PL / EN, reviews prompt, iOS release. | P1 | M | n/a |

---

## Suggested order

1. **E1.1 Notifications** first: E1.3, E1.4, E4 and E9.2 all depend on it.
2. **E1.2 Today view + E1.3 alerts**: the feature that shows the difference from every competitor in a demo.
3. **E2.1 Forward a booking + E2.2 ticket wallet**: removes the main reason to keep TripIt or Wanderlog next to voyage.
4. **E3.1 Train prices + E4.1 shared expenses + E10.1 calendar**: make the cost honest and the trip shareable.
5. Then the P1 list, starting with E5.1 Trip chat and E6.1 transit score, which give voyage its own answer to
   Booking's planner.

## Sources

Competitor features were checked against their public pages and recent coverage (November 2026):
[Booking.com agentic AI tools](https://www.hospitalitynet.org/news/4129287/bookingcom-debuts-agentic-ai-innovations-adding-to-its-robust-suite-of-genai-tools-for-customers),
[Booking.com AI Trip Planner update (Skift)](https://skift.com/2024/10/30/booking-coms-ai-trip-planner-got-a-big-update-heres-how-it-works),
[Wanderlog on the App Store](https://apps.apple.com/app/id1476732439),
[TripIt review (Going)](https://www.going.com/guides/tripit-review),
[TripIt Pro features](https://m.tripit.com/pro/features),
[Google Maps AI itineraries in Europe (TechRepublic)](https://www.techrepublic.com/article/news-google-maps-ai-itineraries-emea-uk/),
[Google vacation planning in Search, Maps and Gemini (TechCrunch)](https://techcrunch.com/2025/03/27/google-rolls-out-new-vacation-planning-features-to-search-maps-and-gemini),
[How Gemini plans trips (Google)](https://blog.google/products-and-platforms/products/gemini/how-gemini-plans-trips/).
