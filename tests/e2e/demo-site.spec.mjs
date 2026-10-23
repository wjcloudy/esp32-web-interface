// Smoke test for the live demo (demo/build.mjs): the real UI, built as a
// static site and served under a sub-path like GitHub Pages, must come up on
// the simulated inverter with no device behind it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect, gotoTab } from './fixtures.mjs';
import { buildDemoSite } from '../../demo/build.mjs';
import { serveStatic } from '../../demo/serve.mjs';

let server, site;
test.beforeAll(async () => {
  site = buildDemoSite(fs.mkdtempSync(path.join(os.tmpdir(), 'oi-demo-e2e-')));
  server = await serveStatic(site, { base: '/esp32-web-interface/' });
});
test.afterAll(async () => { if (server) await server.close(); });

async function openDemo(page, query = '') {
  // Any request that escapes the demo transport to the device's own paths
  // would 404 on Pages: fail loudly instead
  const escaped = [];
  page.on('response', r => { if (r.status() >= 400) escaped.push(r.status() + ' ' + r.url()); });
  await page.goto(server.url + query);
  await expect(page.locator('#oi-demo-banner')).toContainText('simulated inverter');
  await expect(page.locator('#version')).toContainText('Web: v1.12');
  return escaped;
}

test('dashboard runs on the simulated inverter, with the demo banner', async ({ page }) => {
  const escaped = await openDemo(page);
  await expect(page.locator('.hero-state')).toHaveText('Running');
  await expect(page.locator('#device-name')).toHaveText('Demo Roadster');
  await expect(page.locator('.hero-metrics .metric-value').first()).toHaveText(/^\d{3}\.\dV$/);
  await page.locator('#commandinput').fill('get udc');
  await page.locator('#commandinput').press('Enter');
  await expect(page.locator('#commandoutput')).toContainText(/> get udc\s+\d{3}\.\d\d/);
  expect(escaped).toEqual([]);
});

test('data logger records without freezing the page', async ({ page }) => {
  // The demo answers instantly: an unpaced logger loop never yielded and hung the tab
  const escaped = await openDemo(page, '#logger');
  await page.locator('button', { hasText: 'Add field to log' }).click();
  await page.locator('#logger div', { hasText: /^Select\.\.\.$/ }).last().click();
  await page.locator('#logger .hover-row').first().click();
  await page.locator('button', { hasText: 'Start logging' }).click();
  await expect.poll(() => page.locator('#data-logger-text-area').inputValue()
    .then(v => v.trim().split('\n').length), { timeout: 5000 }).toBeGreaterThan(5);
  // Still responsive: the page can run script and the button reacts
  expect(await page.evaluate(() => 1 + 1)).toBe(2);
  await page.locator('button', { hasText: 'Stop logging' }).click();
  await expect(page.locator('button', { hasText: 'Start logging' })).toBeVisible();
  expect(escaped).toEqual([]);
});

test('main tabs render with data', async ({ page }) => {
  const escaped = await openDemo(page);
  await gotoTab(page, 'Parameters');
  await expect(page.locator('#params')).toContainText('udcmin');
  await gotoTab(page, 'Spot Values');
  await expect(page.locator('#spotValues')).toContainText('udc');
  await gotoTab(page, 'Gauges');
  await expect(page.locator('#gauges')).toContainText('Driving');
  await expect(page.locator('#gauges')).toContainText('rpm');
  await gotoTab(page, 'Plot');
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
  await gotoTab(page, 'Settings');
  await expect(page.locator('#content')).toContainText('garage-wifi');
  expect(escaped).toEqual([]);
});

test('rebooting is harmless and says why', async ({ page }) => {
  await openDemo(page);
  await page.getByRole('button', { name: 'Reboot ESP32' }).click();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.locator('#oi-demo-banner')).toContainText('Demo mode: nothing was rebooted');
  await expect(page.locator('.hero-state')).toHaveText('Running');
});

test('CAN mode lists the device mappings', async ({ page }) => {
  await openDemo(page, '?can=1#canmapping');
  await expect(page.locator('#content')).toContainText('0x3E8');
});

test('updating from GitHub is harmless and says why', async ({ page }) => {
  await openDemo(page, '#update');
  await page.getByRole('button', { name: /get releases/i }).click();
  await expect(page.locator('#update select').first()).toContainText('v1.12');
  page.on('dialog', d => d.accept());
  await page.getByRole('button', { name: /download & install/i }).click();
  await expect(page.locator('#oi-demo-banner')).toContainText('Demo mode: no image was downloaded or flashed');
});

test('the banner links to the browser installer, which offers both channels', async ({ page }) => {
  const escaped = await openDemo(page);
  await page.locator('#oi-demo-banner a', { hasText: 'Install on your ESP32' }).click();
  await expect(page).toHaveURL(/\/esp32-web-interface\/flash\/$/);
  await expect(page.locator('h1')).toContainText('Install the web interface');
  // ESP Web Tools is served from the site itself, not a CDN
  await expect.poll(() => page.evaluate(() => !!window.customElements.get('esp-web-install-button'))).toBe(true);
  // A local build has no release images: the page says so and won't install
  await expect(page.locator('#manifest-error')).toBeVisible();
  await expect(page.locator('#installer button[slot="activate"]')).toBeDisabled();

  // With the images the deploy bundles (demo/flash-firmware.mjs)
  const manifest = (version) => ({ name: 'OpenInverter Web Interface', version, new_install_prompt_erase: true,
    builds: [{ chipFamily: 'ESP32', parts: [{ path: 'fw/' + version + '/esp32_' + version + '-0x000.bin', offset: 0 }] }] });
  fs.writeFileSync(path.join(site, 'flash', 'manifest-stable.json'), JSON.stringify(manifest('v4.24')));
  fs.writeFileSync(path.join(site, 'flash', 'manifest-dev.json'), JSON.stringify(manifest('v4.25-dev.12')));
  await page.evaluate(() => { try { localStorage.removeItem('oi-flash-channel'); } catch (e) {} });
  await page.reload();
  await expect(page.locator('#ver-stable')).toHaveText('v4.24');
  await expect(page.locator('#ver-dev')).toHaveText('v4.25-dev.12');
  await expect(page.locator('#manifest-error')).toBeHidden();
  await expect(page.locator('#installer')).toHaveAttribute('manifest', 'manifest-stable.json');
  await expect(page.locator('#installer button[slot="activate"]')).toBeEnabled();
  await page.locator('#channel label', { hasText: 'Dev' }).click();
  await expect(page.locator('#installer')).toHaveAttribute('manifest', 'manifest-dev.json');
  await expect(page.locator('#channel-note')).toContainText('v4.25-dev.12');
  // Only the manifests missing in the first half may have 404'd
  expect(escaped.filter(e => !/\/flash\/manifest-(stable|dev)\.json$/.test(e))).toEqual([]);
});

test('the sample layout\'s example image renders; image uploads are refused', async ({ page }) => {
  const escaped = await openDemo(page, '#gauges');
  await page.locator('.page-pill', { hasText: 'Controls' }).click();
  const img = page.locator('#gauges .wt-image img');
  await expect.poll(() => img.evaluate(el => el.complete && el.naturalWidth)).toBe(480);
  // The tile offers the bundled pictures, but the demo stores no uploads
  await page.locator('button', { hasText: 'Edit Layout' }).click();
  await page.locator('#gauges .gauge-tile:has(.wt-image)').click();
  const modal = page.locator('.modal-content');
  await expect(modal.locator('#image-file option', { hasText: 'example-badge.png' })).toHaveCount(1);
  await modal.locator('#image-upload').setInputFiles({ name: 'car.png', mimeType: 'image/png',
    buffer: fs.readFileSync(path.join(site, 'icon-180.png')) });
  await expect(modal.locator('#image-error')).toContainText('Demo mode');
  await expect(page.locator('#oi-demo-banner')).toContainText('Demo mode: no image was uploaded');
  await expect(modal.locator('#image-file')).toHaveValue('example-badge.png');
  expect(await page.evaluate(() => window.OI_DEMO.files.has('img-car.png'))).toBe(false);
  expect(escaped).toEqual([]);
});

test('the sample Vehicle page shows its background picture', async ({ page }) => {
  const escaped = await openDemo(page, '#gauges');
  await page.locator('.page-pill', { hasText: 'Vehicle' }).click();
  await expect.poll(() => page.locator('#gauges .page-bg img').evaluate(el => el.complete && el.naturalWidth)).toBe(1200);
  expect(escaped).toEqual([]);
});
