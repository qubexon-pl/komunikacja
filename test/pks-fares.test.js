"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createPksFares, parseResults, searchTerm } = require("../src/pks-fares");

const row = (dep, arr, km, line, price) => `<tr class=" wiersz_1"> <td class="godz odj lsk">${dep}</td> <td class="godz prz">${arr}</td> <td class="czas">16 min</td> <td class="km">${km} km</td> <td class="nrlinii"><span>${line}</span></td> <td class="uwagi">+</td> <td class="cena bilet"><a href="#"><span class="faico"><i></i></span> ${price} zł<br /><span class="etykKup">kup bilet &rsaquo;</span></a></td> </tr>`;
const page = `<table><thead><tr><th class="cena">Cena</th></tr></thead><tbody>${row("05:00", "05:16", 8, "203", "4.50")}${row("05:10", "05:28", 9, "223", "4.50")}${row("06:00", "06:20", 12, "251", "5.20")}</tbody></table>`;

test("the PKS result table gives each ride's times, distance, line and price", () => {
  assert.deepEqual(parseResults(page), [
    { departure: "05:00", arrival: "05:16", km: 8, line: "203", price: 4.5 },
    { departure: "05:10", arrival: "05:28", km: 9, line: "223", price: 4.5 },
    { departure: "06:00", arrival: "06:20", km: 12, line: "251", price: 5.2 },
  ]);
  assert.equal(searchTerm("Tyczyn Grunwaldzka POM 27 nż"), "Tyczyn");
});

test("a PKS price follows the website's steps, matches the departure and is remembered", async () => {
  const calls = [];
  const fetchSource = async (url, init = {}) => {
    calls.push([init.method || "GET", String(url), init.headers?.["User-Agent"]]);
    if (String(url).includes("opr_dane=przystanki")) {
      const term = decodeURIComponent(String(url).split("term=")[1]);
      return new Response(JSON.stringify(term === "Rzeszów" ? [{ nazwa: "RZESZÓW  D.A.", kod: "13150019", x: "22.0045", y: "50.0425" }] : [{ nazwa: "Boguchwała (kierunek z Rzeszowa)", kod: "13159562", x: "21.9420", y: "49.9843" }, { nazwa: "Daleko", kod: "1", x: "21", y: "49" }]));
    }
    if (init.method === "POST") {
      assert.match(String(init.body), /kodpp=13150019&kodpd=13159562&pomkal=0/);
      return new Response("", { status: 303, headers: { location: "wyszukiwarka-polaczen/13150019/13159562/x/y/?datap=2026-11-11" } });
    }
    return new Response(page);
  };
  const pks = createPksFares({ fetchSource, gapMs: 0 });
  const ask = (time) => pks.price({ from: { name: "Rzeszów D.A. 10", lat: 50.0424, lon: 22.0044 }, to: { name: "Boguchwała ośrodek", lat: 49.9841, lon: 21.9421 }, day: "2026-11-11", time });
  assert.deepEqual(await ask("06:00"), { price: 5.2, exact: true, km: 12, from: "RZESZÓW  D.A.", to: "Boguchwała (kierunek z Rzeszowa)" });
  assert.equal((await ask("07:00")).price, 4.5); // no such departure: the usual price
  assert.equal(calls.length, 4); // two stop searches, the search and its result; the second price came from memory
  assert.ok(calls.every((c) => c[2].startsWith("komunikacja-rzeszow")));
});
