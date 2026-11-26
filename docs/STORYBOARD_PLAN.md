# Storyboard plan ("Podavo.voyage — komplet ekranów")

The app is being brought to the storyboard's layout on desktop and mobile. The rules agreed for this work:

- **The existing app is restyled, not rewritten.** It stays plain JS with Bootstrap and Leaflet, the same APIs and the same data, even though the storyboard's notes mention React/TS and MapLibre.
- **The storyboard is a layout reference.** The visual style stays Podavo's: navy, interactive blue, amber for primary actions, and the existing fonts and icons.
- **Only features the app already has get the storyboard layout now.** Screens or menu items without a feature behind them are left out until they get a real back end, each in its own PR.

| # | Storyboard screen | Status |
|---|---|---|
| — | Shell: side menu (desktop), bottom bar with "+" (mobile) | **This PR** |
| 1, 11 | Strona główna / Pulpit | **This PR**: greeting, destination search, quick actions, next trip, favourites |
| 7, 13 | Transport lokalny (mobile, desktop) | PR #34 (split view, route cards, timeline); tabs Połączenia / Odjazdy / Mapa / Ulubione next |
| 2 | Wyszukiwanie połączeń | Next: restyle `#planForm` as a card (mode chips, Skąd/Dokąd rows, date range, people) |
| 3 | Wyniki lotów (z filtrami) | Next: flight result cards with sort tabs (Najlepsze / Najtańsze / Najszybsze) |
| 4 | Szczegóły trasy (door-to-door) | Next: trip page through `JourneyTimeline` |
| 8 | Mapa trasy z nawigacją | Next: full-screen trip map with a bottom summary |
| 9 | Uczestnicy (participants) | Next: sharing (exists) laid out as a participant list. Group chat waits for a back end. |
| 10, 12 | Galeria / plan with map (desktop) | Photos exist per trip: a gallery layout. The day plan waits for a back end. |
| 5, 6 | Plan dnia, Atrakcje | Not yet: no feature behind them |
| — | Dokumenty, Lista pakowania, Czat, Ustawienia page | Not yet: no feature behind them (settings stay in the account menu) |
