// Phase 10d: "no unintended horizontal scrolling" and "mobile and desktop layouts are tested independently".
// Opens every page at phone, tablet, desktop and wide sizes, in light and dark, and fails when a page is wider than
// the screen. It serves the repository's own files with the API switched off (the shell and the empty states are
// what is measured), and takes Bootstrap, Leaflet and Font Awesome from node_modules, so nothing leaves the machine.
//
//   node scripts/check-layout.mjs            (needs Playwright with Chromium: npm i -D playwright && npx playwright install chromium)
//
// Prints one line per page and size, and exits with 1 when any page scrolls sideways.
import http from 'node:http';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = require('playwright');

const WIDTHS = [320, 390, 768, 1024, 1440];
const THEMES = ['light', 'dark'];
const PAGES = ['/plan', '/destinations', '/my-trips', '/favourites', '/buses', '/buses#timetable', '/buses#lines', '/suburban', '/trains', '/trains#timetable', '/login', '/welcome'];
const HTML = { '/plan': 'index.html', '/destinations': 'index.html', '/my-trips': 'index.html', '/favourites': 'index.html', '/buses': 'index.html', '/suburban': 'index.html', '/trains': 'index.html', '/login': 'login.html', '/welcome': 'welcome.html' };
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json', '.webmanifest': 'application/json', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
const NM = join(root, 'node_modules');
const CDN = [[/bootstrap@[^/]+\/dist\/(.*)/, join(NM, 'bootstrap/dist')], [/leaflet\/1\.9\.4\/(.*)/, join(NM, 'leaflet/dist')], [/font-awesome\/6\.7\.2\/(.*)/, join(NM, '@fortawesome/fontawesome-free')], [/jszip\/3\.10\.1\/(.*)/, join(NM, 'jszip/dist')], [/protobufjs@7\.4\.0\/dist\/(.*)/, join(NM, 'protobufjs/dist')]];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  if (url.pathname === '/api/auth/me') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"user":{"id":"u1","email":"layout@example.com","name":"Layout"}}'); return; }
  if (url.pathname.startsWith('/api/') || url.pathname === '/sw.js') { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"off"}'); return; }
  const file = normalize(join(root, HTML[url.pathname] || url.pathname.slice(1)));
  if (!file.startsWith(root)) { res.writeHead(404); res.end(); return; }
  try { const body = await readFile(file); res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' }); res.end(body); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise((ok) => server.listen(0, ok));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
let failures = 0;
for (const theme of THEMES) {
  for (const width of WIDTHS) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, locale: 'pl-PL' });
    await context.route(/^https:\/\/(cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com)\//, async (route) => {
      const u = route.request().url();
      for (const [re, dir] of CDN) { const m = u.match(re); if (m) { try { return await route.fulfill({ path: join(dir, m[1].replace('leaflet.min.', 'leaflet.')) }); } catch { /* not installed */ } } }
      return route.abort();
    });
    await context.route(/^https:\/\/fonts\./, (route) => route.abort());
    const page = await context.newPage();
    for (const path of PAGES) {
      await page.goto(base + path);
      await page.waitForTimeout(1200);
      await page.addStyleTag({ content: '.tour-suggest,.modal,.modal-backdrop{display:none!important}' });
      const r = await page.evaluate(() => {
        const doc = document.documentElement, over = doc.scrollWidth - doc.clientWidth;
        // The widest element that sticks out, to say what to fix.
        let culprit = '';
        if (over > 0) {
          let worst = 0;
          for (const el of document.body.querySelectorAll('*')) {
            const right = el.getBoundingClientRect().right;
            if (right > doc.clientWidth + 1 && right > worst && el.offsetParent !== null) { worst = right; culprit = `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}`; }
          }
        }
        return { over, culprit };
      });
      const ok = r.over <= 0;
      if (!ok) failures++;
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${theme.padEnd(5)} ${String(width).padStart(4)}px ${path}${ok ? '' : `  +${r.over}px (${r.culprit})`}`);
    }
    await context.close();
  }
}
await browser.close();
server.close();
console.log(failures ? `${failures} page(s) scroll sideways.` : 'No page scrolls sideways.');
process.exit(failures ? 1 : 0);
