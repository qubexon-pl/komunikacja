"use strict";

// Polish cities whose city transport (trams, buses, metro) is shown on the "Komunikacja miejska" page outside Rzeszów.
// Rzeszów keeps its own, fuller pages (imported GTFS, live positions from kmrzeszów.live). For every city below the
// timetables, journeys, live vehicle positions and stop departures come from Transitous, which already imports each
// operator's open GTFS feed (and its GTFS-Realtime delays where "live" is true), so no per-city download, database
// import or API key is needed. To add a city: check that its operator is in Transitous' feeds/pl.json
// (https://github.com/public-transport/transitous/blob/main/feeds/pl.json) and add a row here.
//
// id: stable key (saved in the browser), name: as in the railway station list (so the city picker can match it),
// centre: [lat, lon] of the city centre, km: how far from the centre stops are searched,
// modes: what runs there, live: the operator publishes real-time delays, operator: shown under the city name.

const CITIES = [
  { id: "warszawa", name: "Warszawa", centre: [52.2297, 21.0122], km: 30, modes: ["metro", "tram", "bus", "rail"], live: true, operator: "ZTM Warszawa" },
  { id: "krakow", name: "Kraków", centre: [50.0614, 19.9366], km: 25, modes: ["tram", "bus"], live: true, operator: "ZTP Kraków" },
  { id: "lodz", name: "Łódź", centre: [51.7592, 19.4560], km: 22, modes: ["tram", "bus"], live: true, operator: "MPK Łódź" },
  { id: "wroclaw", name: "Wrocław", centre: [51.1079, 17.0385], km: 22, modes: ["tram", "bus"], live: true, operator: "MPK Wrocław" },
  { id: "poznan", name: "Poznań", centre: [52.4064, 16.9252], km: 22, modes: ["tram", "bus"], live: true, operator: "ZTM Poznań" },
  { id: "gdansk", name: "Gdańsk", centre: [54.3520, 18.6466], km: 22, modes: ["tram", "bus"], live: true, operator: "ZTM Gdańsk" },
  { id: "gdynia", name: "Gdynia", centre: [54.5189, 18.5305], km: 18, modes: ["bus", "trolleybus"], live: true, operator: "ZKM Gdynia" },
  { id: "szczecin", name: "Szczecin", centre: [53.4285, 14.5528], km: 22, modes: ["tram", "bus"], live: true, operator: "ZDiTM Szczecin" },
  { id: "bydgoszcz", name: "Bydgoszcz", centre: [53.1235, 18.0084], km: 18, modes: ["tram", "bus"], live: false, operator: "ZDMiKP Bydgoszcz" },
  { id: "lublin", name: "Lublin", centre: [51.2465, 22.5684], km: 18, modes: ["bus", "trolleybus"], live: true, operator: "ZTM Lublin" },
  { id: "bialystok", name: "Białystok", centre: [53.1325, 23.1688], km: 16, modes: ["bus"], live: true, operator: "BKM Białystok" },
  { id: "katowice", name: "Katowice", centre: [50.2649, 19.0238], km: 25, modes: ["tram", "bus"], live: true, operator: "Metropolia GZM" },
  { id: "gliwice", name: "Gliwice", centre: [50.2945, 18.6714], km: 15, modes: ["bus"], live: true, operator: "Metropolia GZM" },
  { id: "sosnowiec", name: "Sosnowiec", centre: [50.2863, 19.1041], km: 15, modes: ["tram", "bus"], live: true, operator: "Metropolia GZM" },
  { id: "torun", name: "Toruń", centre: [53.0138, 18.5984], km: 15, modes: ["tram", "bus"], live: true, operator: "MZK Toruń" },
  { id: "kielce", name: "Kielce", centre: [50.8661, 20.6286], km: 15, modes: ["bus"], live: true, operator: "ZTM Kielce" },
  { id: "radom", name: "Radom", centre: [51.4027, 21.1471], km: 14, modes: ["bus"], live: true },
  { id: "olsztyn", name: "Olsztyn", centre: [53.7784, 20.4801], km: 14, modes: ["tram", "bus"], live: true },
  { id: "opole", name: "Opole", centre: [50.6751, 17.9213], km: 14, modes: ["bus"], live: true },
  { id: "czestochowa", name: "Częstochowa", centre: [50.8118, 19.1203], km: 15, modes: ["tram", "bus"], live: true },
  { id: "gorzow", name: "Gorzów Wielkopolski", centre: [52.7368, 15.2288], km: 12, modes: ["tram", "bus"], live: true },
  { id: "zielona-gora", name: "Zielona Góra", centre: [51.9356, 15.5062], km: 14, modes: ["bus"], live: true },
  { id: "bielsko-biala", name: "Bielsko-Biała", centre: [49.8224, 19.0584], km: 14, modes: ["bus"], live: true },
  { id: "elblag", name: "Elbląg", centre: [54.1522, 19.4088], km: 12, modes: ["tram", "bus"], live: true },
  { id: "plock", name: "Płock", centre: [52.5468, 19.7064], km: 12, modes: ["bus"], live: true },
  { id: "tarnow", name: "Tarnów", centre: [50.0121, 20.9858], km: 12, modes: ["bus"], live: true },
  { id: "koszalin", name: "Koszalin", centre: [54.1944, 16.1722], km: 12, modes: ["bus"], live: true },
  { id: "slupsk", name: "Słupsk", centre: [54.4641, 17.0285], km: 12, modes: ["bus"], live: true },
  { id: "legnica", name: "Legnica", centre: [51.2070, 16.1553], km: 12, modes: ["bus"], live: true },
  { id: "rybnik", name: "Rybnik", centre: [50.0971, 18.5418], km: 14, modes: ["bus"], live: true },
  { id: "kalisz", name: "Kalisz", centre: [51.7611, 18.0910], km: 12, modes: ["bus"], live: true },
  { id: "konin", name: "Konin", centre: [52.2230, 18.2511], km: 12, modes: ["bus"], live: true },
  { id: "piotrkow", name: "Piotrków Trybunalski", centre: [51.4052, 19.7030], km: 10, modes: ["bus"], live: true },
  { id: "siedlce", name: "Siedlce", centre: [52.1676, 22.2902], km: 10, modes: ["bus"], live: true },
  { id: "przemysl", name: "Przemyśl", centre: [49.7838, 22.7678], km: 10, modes: ["bus"], live: true },
  { id: "krosno", name: "Krosno", centre: [49.6887, 21.7706], km: 10, modes: ["bus"], live: true },
  { id: "mielec", name: "Mielec", centre: [50.2873, 21.4239], km: 10, modes: ["bus"], live: true },
  { id: "stalowa-wola", name: "Stalowa Wola", centre: [50.5826, 22.0532], km: 10, modes: ["bus"], live: true },
  { id: "chelm", name: "Chełm", centre: [51.1431, 23.4716], km: 10, modes: ["bus"], live: true },
  { id: "zamosc", name: "Zamość", centre: [50.7231, 23.2520], km: 10, modes: ["bus"], live: false },
  { id: "wloclawek", name: "Włocławek", centre: [52.6483, 19.0677], km: 10, modes: ["bus"], live: false },
  { id: "lomza", name: "Łomża", centre: [53.1781, 22.0590], km: 10, modes: ["bus"], live: false },
  { id: "ostroleka", name: "Ostrołęka", centre: [53.0786, 21.5751], km: 10, modes: ["bus"], live: true },
  { id: "suwalki", name: "Suwałki", centre: [54.1118, 22.9309], km: 10, modes: ["bus"], live: true },
  { id: "elk", name: "Ełk", centre: [53.8282, 22.3647], km: 10, modes: ["bus"], live: true },
  { id: "pila", name: "Piła", centre: [53.1514, 16.7378], km: 10, modes: ["bus"], live: true },
  { id: "leszno", name: "Leszno", centre: [51.8406, 16.5749], km: 10, modes: ["bus"], live: true },
  { id: "zakopane", name: "Zakopane", centre: [49.2992, 19.9496], km: 10, modes: ["bus"], live: true },
];

const BY_ID = new Map(CITIES.map((c) => [c.id, c]));
const cityById = (id) => BY_ID.get(String(id || "")) || null;
// What the browser needs: the list without anything server-only.
const publicCities = () => CITIES.map(({ id, name, centre, modes, live, operator }) => ({ id, name, centre, modes, live, operator: operator || "" }));

module.exports = { CITIES, cityById, publicCities };
