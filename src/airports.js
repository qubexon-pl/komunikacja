"use strict";

// Airports served by low-cost airlines from south-east Poland, plus common destinations.
const AIRPORTS = [
  ["RZE", "Rzeszów", "Polska", 50.11, 22.019],
  ["KRK", "Kraków", "Polska", 50.078, 19.785],
  ["KTW", "Katowice", "Polska", 50.474, 19.08],
  ["LUZ", "Lublin", "Polska", 51.24, 22.714],
  ["WAW", "Warszawa Chopin", "Polska", 52.166, 20.967],
  ["WMI", "Warszawa Modlin", "Polska", 52.451, 20.652],
  ["WRO", "Wrocław", "Polska", 51.103, 16.886],
  ["POZ", "Poznań", "Polska", 52.421, 16.826],
  ["GDN", "Gdańsk", "Polska", 54.378, 18.466],
  ["SZZ", "Szczecin", "Polska", 53.585, 14.902],
  ["BZG", "Bydgoszcz", "Polska", 53.097, 17.978],
  ["LCJ", "Łódź", "Polska", 51.722, 19.398],
  ["STN", "Londyn Stansted", "Wielka Brytania", 51.885, 0.235],
  ["LTN", "Londyn Luton", "Wielka Brytania", 51.875, -0.368],
  ["LGW", "Londyn Gatwick", "Wielka Brytania", 51.148, -0.19],
  ["EDI", "Edynburg", "Wielka Brytania", 55.95, -3.373],
  ["GLA", "Glasgow", "Wielka Brytania", 55.872, -4.433],
  ["MAN", "Manchester", "Wielka Brytania", 53.354, -2.275],
  ["BHX", "Birmingham", "Wielka Brytania", 52.454, -1.748],
  ["LBA", "Leeds", "Wielka Brytania", 53.866, -1.661],
  ["LPL", "Liverpool", "Wielka Brytania", 53.334, -2.85],
  ["BRS", "Bristol", "Wielka Brytania", 51.383, -2.719],
  ["DUB", "Dublin", "Irlandia", 53.421, -6.27],
  ["CRL", "Bruksela Charleroi", "Belgia", 50.46, 4.453],
  ["BRU", "Bruksela", "Belgia", 50.901, 4.484],
  ["EIN", "Eindhoven", "Holandia", 51.45, 5.375],
  ["AMS", "Amsterdam", "Holandia", 52.309, 4.764],
  ["BVA", "Paryż Beauvais", "Francja", 49.454, 2.113],
  ["ORY", "Paryż Orly", "Francja", 48.723, 2.379],
  ["NCE", "Nicea", "Francja", 43.658, 7.216],
  ["MRS", "Marsylia", "Francja", 43.436, 5.215],
  ["BCN", "Barcelona", "Hiszpania", 41.297, 2.078],
  ["GRO", "Girona", "Hiszpania", 41.901, 2.76],
  ["MAD", "Madryt", "Hiszpania", 40.472, -3.561],
  ["AGP", "Malaga", "Hiszpania", 36.675, -4.499],
  ["ALC", "Alicante", "Hiszpania", 38.282, -0.558],
  ["VLC", "Walencja", "Hiszpania", 39.489, -0.482],
  ["PMI", "Palma de Mallorca", "Hiszpania", 39.552, 2.739],
  ["TFS", "Teneryfa", "Hiszpania", 28.044, -16.572],
  ["LIS", "Lizbona", "Portugalia", 38.774, -9.134],
  ["OPO", "Porto", "Portugalia", 41.248, -8.681],
  ["FAO", "Faro", "Portugalia", 37.014, -7.966],
  ["FCO", "Rzym Fiumicino", "Włochy", 41.8, 12.239],
  ["CIA", "Rzym Ciampino", "Włochy", 41.799, 12.595],
  ["BGY", "Mediolan Bergamo", "Włochy", 45.674, 9.704],
  ["MXP", "Mediolan Malpensa", "Włochy", 45.63, 8.723],
  ["VCE", "Wenecja", "Włochy", 45.505, 12.352],
  ["TSF", "Wenecja Treviso", "Włochy", 45.648, 12.194],
  ["BLQ", "Bolonia", "Włochy", 44.535, 11.289],
  ["NAP", "Neapol", "Włochy", 40.886, 14.291],
  ["BRI", "Bari", "Włochy", 41.139, 16.761],
  ["CTA", "Katania", "Włochy", 37.467, 15.066],
  ["BER", "Berlin", "Niemcy", 52.362, 13.5],
  ["HHN", "Frankfurt Hahn", "Niemcy", 49.948, 7.264],
  ["DTM", "Dortmund", "Niemcy", 51.518, 7.612],
  ["CGN", "Kolonia", "Niemcy", 50.866, 7.143],
  ["MUC", "Monachium", "Niemcy", 48.354, 11.786],
  ["MMX", "Malmö", "Szwecja", 55.536, 13.376],
  ["ARN", "Sztokholm Arlanda", "Szwecja", 59.652, 17.919],
  ["GOT", "Göteborg", "Szwecja", 57.663, 12.28],
  ["OSL", "Oslo", "Norwegia", 60.194, 11.1],
  ["TRF", "Oslo Torp", "Norwegia", 59.187, 10.259],
  ["CPH", "Kopenhaga", "Dania", 55.618, 12.656],
  ["BLL", "Billund", "Dania", 55.74, 9.152],
  ["VIE", "Wiedeń", "Austria", 48.11, 16.57],
  ["PRG", "Praga", "Czechy", 50.101, 14.26],
  ["BUD", "Budapeszt", "Węgry", 47.43, 19.261],
  ["ATH", "Ateny", "Grecja", 37.936, 23.944],
  ["SKG", "Saloniki", "Grecja", 40.52, 22.971],
  ["CFU", "Korfu", "Grecja", 39.602, 19.912],
  ["RHO", "Rodos", "Grecja", 36.405, 28.086],
  ["HER", "Heraklion", "Grecja", 35.34, 25.18],
  ["LCA", "Larnaka", "Cypr", 34.875, 33.625],
  ["PFO", "Pafos", "Cypr", 34.718, 32.486],
  ["MLA", "Malta", "Malta", 35.857, 14.477],
  ["TIA", "Tirana", "Albania", 41.415, 19.721],
  ["TGD", "Podgorica", "Czarnogóra", 42.359, 19.252],
  ["SOF", "Sofia", "Bułgaria", 42.696, 23.411],
  ["BOJ", "Burgas", "Bułgaria", 42.57, 27.515],
  ["OTP", "Bukareszt", "Rumunia", 44.572, 26.102],
  ["IST", "Stambuł", "Turcja", 41.262, 28.742],
  ["SAW", "Stambuł Sabiha", "Turcja", 40.899, 29.309],
  ["AYT", "Antalya", "Turcja", 36.899, 30.8],
  ["TLV", "Tel Awiw", "Izrael", 32.011, 34.887],
  ["KUT", "Kutaisi", "Gruzja", 42.177, 42.482],
].map(([code, city, country, lat, lon]) => ({ code, city, country, lat, lon }));

const BY_CODE = new Map(AIRPORTS.map((airport) => [airport.code, airport]));

// Live airline lists add what the table above lacks; its own names stay because they read better in Polish.
function addAirports(list) {
  for (const airport of list) {
    if (BY_CODE.has(airport.code) || !Number.isFinite(airport.lat) || !Number.isFinite(airport.lon)) continue;
    AIRPORTS.push(airport);
    BY_CODE.set(airport.code, airport);
  }
}

function kmBetween(a, b) {
  const rad = (value) => value * Math.PI / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

function airportsNear(point, maxKm) {
  return AIRPORTS.map((airport) => ({ ...airport, km: Math.round(kmBetween(point, airport)) }))
    .filter((airport) => airport.km <= maxKm)
    .sort((a, b) => a.km - b.km);
}

function airportLabel(code) {
  const airport = BY_CODE.get(code);
  return airport ? `${airport.city} (${code})` : code;
}

module.exports = { AIRPORTS, BY_CODE, addAirports, airportLabel, airportsNear, kmBetween };
