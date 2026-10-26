// README screenshots, from the live demo's simulated inverter - never a real
// device. Builds the demo site (demo/build.mjs), serves it, and drives the real
// UI in headless Chromium:
//
//   npm run screenshots              -> doc/screenshots/*.png, *.jpg
//   npm run screenshots -- <outDir>
//
// Reproducible: the browser clock is paused at a fixed date and stepped by
// hand, and the demo's values are a pure function of that clock, so a run on
// the same machine draws the same pixels. (Fonts differ between operating
// systems; CI renders on Ubuntu.)
//
//   <name>.png             a desktop page, 1440x900 (dark unless -light)
//   mobile-<name>.png      a phone screen, 393x852 points
//   hero.jpg               desktop gauges in a browser window beside one phone
//   mobile.jpg             a row of phones with captions
//
// Like the other generated assets, a shot that cannot be taken is reported and
// skipped; the run fails only if nothing at all was captured.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDemoSite } from '../../demo/build.mjs';
import { serveStatic } from '../../demo/serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'doc', 'screenshots'));
const T0 = new Date('2026-06-13T10:30:00Z'); // the demo's frozen "now"
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 393, height: 852 };
const STATUS = 54; // phone status bar, drawn by the frame
// Seconds into the demo drive for the live pages: hard on the throttle
// (see simulate() in demo/demo-data.js)
const DRIVE = 57;

// Pictures show the app, not the demo's banner or a live session's chrome
const SHOT_CSS = `#oi-demo-banner{display:none!important}
*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important}
::-webkit-scrollbar{display:none}`;

fs.mkdirSync(OUT, { recursive: true });
// A fresh private directory each run, never a fixed name in the shared temp dir
const site = buildDemoSite(fs.mkdtempSync(path.join(os.tmpdir(), 'oi-demo-screenshots-')));
const server = await serveStatic(site, { base: '/esp32-web-interface/' });
const browser = await chromium.launch();
const missed = [];
const taken = [];

// Advance the paused clock in small steps: each step lets the app's polls
// resolve before the next timer is due, exactly as on a live page
async function run(page, seconds, step = 100) {
  for (let t = 0; t < seconds * 1000; t += step) await page.clock.runFor(step);
}

async function open(context, hash, { can = false } = {}) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.clock.install({ time: T0 });
  await page.clock.pauseAt(T0);
  await page.addInitScript(() => { try { localStorage.setItem('spotSparks', '1'); } catch (e) {} });
  await page.goto(server.url + (can ? '?can=1' : '') + '#' + hash);
  await page.addStyleTag({ content: SHOT_CSS });
  await page.locator('#topbar').waitFor(); // on phones the nav links sit in a closed drawer
  // Real network (the bundled gauge layout) and layout observers settle
  // while the clock stands still, so they land at the same simulated moment
  await page.waitForLoadState('networkidle');
  await run(page, 1);
  await page.waitForTimeout(300);
  page.errors = errors;
  return page;
}

async function shoot(page, file, opts = {}) {
  if (page.errors.length) throw new Error('page error: ' + page.errors[0]);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(OUT, file), ...opts });
  taken.push(file);
}

async function shot(file, fn) {
  try { await fn(); } catch (e) { missed.push(file + ': ' + String(e.message || e).split('\n')[0]); }
}

// The demo starts with favourites set; a page full of values sells it better
async function allRows(page) {
  const fav = page.locator('label.toggle-row', { hasText: 'Favorites only' });
  if (await fav.count() && await fav.first().locator('input').isChecked()) { await fav.first().click(); await run(page, 1); }
}

// ------------------------------------------------------------ desktop
for (const scheme of ['dark', 'light']) {
  const ctx = await browser.newContext({ viewport: DESKTOP, colorScheme: scheme, reducedMotion: 'reduce' });
  const sfx = scheme === 'light' ? '-light' : '';

  await shot(`dashboard${sfx}.png`, async () => {
    const page = await open(ctx, 'dashboard');
    await run(page, 185); // fill the 60-sample sparklines (one json poll per 3 s)
    await page.locator('#commandinput').fill('get udc,idc,speed,tmpm');
    await page.locator('#commandinput').press('Enter');
    await run(page, 1);
    await shoot(page, `dashboard${sfx}.png`);
    await page.close();
  });

  await shot(`gauges${sfx}.png`, async () => {
    const page = await open(ctx, 'gauges/Driving');
    await run(page, DRIVE);
    await shoot(page, `gauges${sfx}.png`);
    await page.close();
  });

  // The sample layout's car status page: the photo background with lamps
  // and badges over it (waits for the picture, a real fetch, to decode)
  await shot(`vehicle${sfx}.png`, async () => {
    const page = await open(ctx, 'gauges/Vehicle');
    await page.locator('#gauges .page-bg img').evaluate(img => img.complete ? null : new Promise(r => { img.onload = r; img.onerror = r; }));
    await run(page, DRIVE);
    await shoot(page, `vehicle${sfx}.png`);
    await page.close();
  });

  if (scheme === 'light') { await ctx.close(); continue; }

  await shot('plot.png', async () => {
    const page = await open(ctx, 'plot');
    await page.getByRole('button', { name: 'Start' }).click();
    await run(page, DRIVE);
    await shoot(page, 'plot.png');
    await page.close();
  });

  await shot('spotvalues.png', async () => {
    const page = await open(ctx, 'spotvalues');
    await allRows(page);
    await run(page, 120); // sparklines: one sample per 3 s json poll
    await shoot(page, 'spotvalues.png');
    await page.close();
  });

  await shot('parameters.png', async () => {
    const page = await open(ctx, 'parameters');
    await allRows(page);
    await shoot(page, 'parameters.png');
    await page.close();
  });

  await shot('canmapping.png', async () => {
    const page = await open(ctx, 'canmapping', { can: true });
    await run(page, 2);
    await shoot(page, 'canmapping.png');
    await page.close();
  });

  await shot('settings.png', async () => {
    const page = await open(ctx, 'settings');
    await run(page, 2);
    await shoot(page, 'settings.png');
    await page.close();
  });

  await shot('update.png', async () => {
    const page = await open(ctx, 'update');
    await run(page, 1);
    const get = page.getByRole('button', { name: /get releases/i });
    if (await get.count()) { await get.first().click(); await run(page, 1); }
    await shoot(page, 'update.png');
    await page.close();
  });

  await ctx.close();
}

// ------------------------------------------------------------ phone
const PHONE_SHOTS = [
  { name: 'dashboard', hash: 'dashboard', caption: 'Dashboard', secs: 185 },
  { name: 'gauges', hash: 'gauges/Driving', caption: 'Gauges', secs: DRIVE },
  { name: 'spotvalues', hash: 'spotvalues', caption: 'Spot values', secs: 12 },
  { name: 'parameters', hash: 'parameters', caption: 'Parameters', secs: 1, all: true },
];
const phones = [];
{
  const ctx = await browser.newContext({
    viewport: { width: PHONE.width, height: PHONE.height - STATUS }, deviceScaleFactor: 2,
    isMobile: true, hasTouch: true, colorScheme: 'dark', reducedMotion: 'reduce',
  });
  for (const s of PHONE_SHOTS) {
    await shot(`mobile-${s.name}.png`, async () => {
      const page = await open(ctx, s.hash);
      if (s.all) await allRows(page);
      await run(page, s.secs);
      await shoot(page, `mobile-${s.name}.png`);
      phones.push(s);
      await page.close();
    });
  }
  await ctx.close();
}

// ------------------------------------------------------------ composites
// Phone frames and a browser window on a gradient, drawn by the browser
const dataUrl = (file) => 'data:image/png;base64,' + fs.readFileSync(path.join(OUT, file)).toString('base64');
const STYLE = `*{box-sizing:border-box;margin:0}
#canvas{position:relative;overflow:hidden;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  background:radial-gradient(60% 70% at 12% 10%,rgba(91,157,255,.45),transparent 60%),
    radial-gradient(50% 60% at 92% 95%,rgba(255,207,84,.28),transparent 60%),
    radial-gradient(45% 55% at 60% 0%,rgba(255,107,107,.22),transparent 60%),
    linear-gradient(140deg,#121826 0%,#0d131c 50%,#0a1016 100%)}
.phone{position:absolute;width:425px;height:884px;padding:16px;border-radius:70px;
  background:linear-gradient(150deg,#4a4f57 0%,#1b1e23 22%,#0e1013 60%,#30343b 100%);
  box-shadow:inset 0 0 0 2px #07080a,inset 0 0 0 5px #23262c,0 0 0 1.5px rgba(255,255,255,.18),0 60px 110px -30px rgba(0,0,0,.75)}
.screen{position:relative;width:393px;height:852px;border-radius:55px;overflow:hidden;background:#0b0f15}
.screen img{position:absolute;left:0;top:${STATUS}px;width:393px;height:${PHONE.height - STATUS}px}
.status{position:absolute;inset:0 0 auto 0;height:${STATUS}px;display:flex;align-items:center;justify-content:space-between;
  padding:4px 34px 0 50px;color:#fff;font-weight:600;font-size:17px}
.island{position:absolute;top:11px;left:50%;transform:translateX(-50%);width:124px;height:36px;border-radius:20px;background:#000}
.home{position:absolute;bottom:8px;left:50%;transform:translateX(-50%);width:138px;height:5px;border-radius:3px;background:rgba(255,255,255,.7)}
.window{position:absolute;border-radius:12px;overflow:hidden;background:#0d1014;
  box-shadow:0 0 0 1px rgba(255,255,255,.14),0 60px 120px -30px rgba(0,0,0,.75)}
.bar{height:38px;display:flex;align-items:center;gap:8px;padding:0 16px;background:linear-gradient(#23262d,#1a1d22)}
.dot{width:12px;height:12px;border-radius:50%}
.url{margin:0 auto;transform:translateX(-30px);height:24px;padding:3px 16px;border-radius:7px;background:rgba(255,255,255,.07);
  color:rgba(255,255,255,.72);font-size:13px}
.window img{display:block;width:100%}
.caption{position:absolute;color:#f2f5fa;font-weight:600;font-size:26px;text-align:center;opacity:.92}`;

const phoneHtml = (file, style) => `<div class="phone" style="${style}"><div class="screen">
  <div class="status"><span>9:41</span><span>&#9679;&#9679;&#9679;</span></div><div class="island"></div>
  <img src="${dataUrl(file)}"><div class="home"></div></div></div>`;

async function compose(width, height, body, file, scale = 1) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
  await page.setContent(`<html><head><style>${STYLE}</style></head><body><div id="canvas" style="width:${width}px;height:${height}px">${body}</div></body></html>`);
  await page.evaluate(() => Promise.all([...document.images].map(i => i.decode())));
  await page.locator('#canvas').screenshot({ path: path.join(OUT, file), type: 'jpeg', quality: 84 });
  taken.push(file);
  await page.close();
}

await shot('hero.jpg', async () => {
  if (!taken.includes('gauges.png') || !phones.some(p => p.name === 'dashboard')) throw new Error('needs gauges.png and mobile-dashboard.png');
  const win = `<div class="window" style="left:40px;top:50px;width:1300px;z-index:1"><div class="bar">
    <i class="dot" style="background:#ff5f57"></i><i class="dot" style="background:#febc2e"></i><i class="dot" style="background:#28c840"></i>
    <span class="url">inverter.local</span></div><img src="${dataUrl('gauges.png')}"></div>`;
  await compose(1600, 960, win + phoneHtml('mobile-dashboard.png', 'left:1250px;top:300px;transform-origin:top left;transform:scale(.68);z-index:2'), 'hero.jpg');
});

await shot('mobile.jpg', async () => {
  if (!phones.length) throw new Error('no phone screens');
  const gap = 56, scale = 0.78, w = 425 * scale;
  const W = Math.round(phones.length * w + (phones.length + 1) * gap), H = Math.round(884 * scale + 150);
  const body = phones.map((s, i) => {
    const x = gap + i * (w + gap);
    return phoneHtml(`mobile-${s.name}.png`, `left:${x - (425 - w) / 2}px;top:${40 - (884 - 884 * scale) / 2}px;transform:scale(${scale})`) +
      `<div class="caption" style="left:${x}px;width:${w}px;top:${884 * scale + 70}px">${s.caption}</div>`;
  }).join('');
  await compose(W, H, body, 'mobile.jpg');
});

await browser.close();
await server.close();
console.log(`${taken.length} screenshots in ${path.relative(ROOT, OUT) || OUT}: ${taken.join(', ')}`);
if (missed.length) console.log(`skipped ${missed.length}:\n  ${missed.join('\n  ')}`);
if (!taken.length) process.exit(1);
