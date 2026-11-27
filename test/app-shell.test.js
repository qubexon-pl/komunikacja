"use strict";
// Phase 2b: the responsive shell (docs/PODAVO_REFACTOR.md). One navigation list serves the phone bottom bar and the
// desktop sidebar, so these checks hold both together.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const html = read("index.html");
const css = read("assets/app.shell.css");

test("the shell stylesheet loads last and the service worker caches it", () => {
  assert.ok(html.indexOf("/assets/app.shell.css") > html.indexOf("/assets/app.transport.css"));
  assert.match(read("assets/app.sw.js"), /'\/assets\/app\.shell\.css'/);
});

test("one navigation list: the five pages plus a collapse button that is hidden on phones", () => {
  const nav = html.slice(html.indexOf('<nav class="bottom-nav"'), html.indexOf("</nav>", html.indexOf('<nav class="bottom-nav"')));
  assert.equal((nav.match(/<a /g) || []).length, 5);
  assert.match(nav, /id="sideToggle"[^>]*aria-controls="sideNav"/);
  assert.match(html, /<nav class="bottom-nav" id="sideNav"/);
  assert.match(css, /^\.side-toggle\{display:none\}/m);
});

test("the sidebar starts at the desktop breakpoint and the phone bar below the tablet one", () => {
  assert.match(css, /@media \(min-width:1024px\)\{[\s\S]*\.bottom-nav\{[\s\S]*position:fixed/);
  assert.match(read("assets/app.css"), /@media \(max-width:767px\)\{\s*\.bottom-nav\{position:fixed/);
});

test("collapsing keeps page names for screen readers instead of removing them", () => {
  assert.match(css, /body\.side-collapsed \.bottom-nav a span[^{]*\{[^}]*clip:rect\(0 0 0 0\)/);
  assert.doesNotMatch(css, /body\.side-collapsed \.bottom-nav a span[^{]*\{[^}]*display:none/);
  const js = read("assets/app.js");
  assert.match(js, /podavo\.sideCollapsed/);
  assert.match(js, /setAttribute\('aria-expanded'/);
});
