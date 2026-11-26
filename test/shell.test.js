"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = (file) => fs.readFileSync(path.resolve(__dirname, "..", file), "utf8");
const html = read("index.html");
const app = read("assets/app.js");
const server = read("src/server.js");

test("the side menu and the bottom bar link to existing pages only", () => {
  const side = html.slice(html.indexOf('<aside class="sidenav"'), html.indexOf("</aside>"));
  for (const href of ["/", "/my-trips", "/plan", "/destinations", "/buses", "/favourites"]) assert.ok(side.includes(`href="${href}"`), href);
  const bottom = html.slice(html.indexOf('<nav class="bottom-nav"'), html.indexOf("</nav>", html.indexOf('<nav class="bottom-nav"')));
  assert.deepEqual([...bottom.matchAll(/<span>([^<]+)<\/span>/g)].map((m) => m[1]), ["Start", "Kierunki", "Planuj", "Podróże", "Więcej"]);
  assert.match(bottom, /data-go="ztm"[^>]*href="\/buses"/);
  assert.match(bottom, /data-proxy="favLink"/);
  assert.ok(html.indexOf('<aside class="sidenav"') < html.indexOf("/assets/app.js"), "menu links exist before app.js binds [data-go]");
});

test("the dashboard is the start page at / and /start", () => {
  assert.match(app, /location\.pathname==='\/' \|\| location\.pathname==='\/start'[^\n]*sub:'start'/);
  assert.match(app, /if\(sub==='start'\) return '\/start';/);
  assert.match(app, /if\(sub==='start'\) renderStart\(\);/);
  assert.match(server, /APP_PAGES = new Set\(\["\/", "\/start",/);
  assert.match(html, /<div id="startPage" class="start-part"><\/div>/);
  assert.match(html, /\/assets\/app\.shell\.css/);
  assert.match(read("assets/app.sw.js"), /'\/assets\/app\.shell\.css'/);
});
