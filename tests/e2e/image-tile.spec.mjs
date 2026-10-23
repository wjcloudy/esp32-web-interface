import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, openApp, gotoTab, signInBrowser } from './fixtures.mjs';

// Image tiles: a picture from the device's filesystem on any gauge page or
// the Dashboard. Uploads go to /edit as img-<name>.<ext>, which the firmware
// lets an operator write (other .png files are the UI's, admin-only).

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
const PNG = fs.readFileSync(path.join(DATA, 'icon-180.png')); // any real PNG

// A page with one picture uploaded earlier, one shipped picture beside it
const LAYOUT = { v: 3, pages: [{ id: 1, name: 'Main', items: [
  { id: 1, type: 'image', file: 'img-wiring.png', x: 0, y: 0, w: 4, h: 2 },
  { id: 2, type: 'image', file: 'example-badge.png', x: 4, y: 0, w: 4, h: 1 },
] }] };

const savedPage = async (mock, name = 'Main') =>
  (await fetch(mock.url + '/gauges.json').then(r => r.json())).pages.find(p => p.name === name);
// Decoded, not just present: a corrupted (text-mangled) upload has no size
const imgLoaded = (loc) => loc.evaluate(img => img.complete && img.naturalWidth > 0);

async function addImageTile(page) {
  await page.locator('button', { hasText: 'Edit Layout' }).click();
  await page.locator('button', { hasText: 'Add Gauge' }).click();
  const modal = page.locator('.modal-content');
  await modal.locator('select').first().selectOption('image');
  return modal;
}

test.describe('Image tiles', () => {
  test('upload a PNG into a new image tile; it survives a reload', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    const modal = await addImageTile(page);
    await modal.locator('#image-upload').setInputFiles({ name: 'My Car!.png', mimeType: 'image/png', buffer: PNG });
    // Stored under the img- prefix with a short, URL-safe name, byte for byte
    await expect(modal.locator('#image-file')).toHaveValue('img-my-car.png');
    const stored = await fetch(mock.url + '/img-my-car.png');
    expect(stored.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await stored.arrayBuffer()).equals(PNG)).toBe(true);
    await modal.locator('#image-fit').selectOption('cover');
    await modal.locator('#image-link').fill('https://openinverter.org/');
    await modal.locator('input[maxlength="24"]').fill('My car');
    await modal.locator('button', { hasText: 'Done' }).click();
    await page.locator('button', { hasText: 'Save & Done' }).click();
    await expect.poll(async () => (await savedPage(mock))?.items[0]).toMatchObject({
      type: 'image', file: 'img-my-car.png', fit: 'cover', href: 'https://openinverter.org/', label: 'My car' });

    await page.reload();
    await gotoTab(page, 'Gauges');
    const img = page.locator('#gauges .wt-image img');
    await expect(img).toHaveCSS('object-fit', 'cover');
    await expect.poll(() => imgLoaded(img)).toBe(true);
    await expect(page.locator('#gauges .wt-image .img-caption')).toHaveText('My car');
    await expect(page.locator('#gauges .wt-image a.img-link')).toHaveAttribute('href', 'https://openinverter.org/');
    // The picture sits inside its tile: nothing scrolls
    const fits = await page.locator('#gauges .gauge-tile:has(.wt-image)').evaluate(t => t.scrollHeight <= t.clientHeight + 1);
    expect(fits).toBe(true);
  });

  test('an image over the size cap is refused with the reason, and nothing is stored', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    const modal = await addImageTile(page);
    await modal.locator('#image-upload').setInputFiles({ name: 'huge.png', mimeType: 'image/png', buffer: Buffer.alloc(300 * 1024) });
    await expect(modal.locator('#image-error')).toContainText('the limit is 200 KB');
    expect((await mock.state()).files.some(n => n.startsWith('img-'))).toBe(false);
  });

  test('an existing image on the device can be picked', async ({ page, mock }) => {
    await fetch(mock.url + '/__test/put-file?name=img-wiring.png', { method: 'POST', body: PNG }); // seeded, not uploaded
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    const modal = await addImageTile(page);
    await modal.locator('#image-file').selectOption('img-wiring.png');
    await modal.locator('button', { hasText: 'Done' }).click();
    await expect.poll(() => imgLoaded(page.locator('#gauges .wt-image img'))).toBe(true);
  });

  test('an operator may upload image-tile pictures but not replace the UI\'s own images', async ({ page, mock }) => {
    await mock.addUser('admin', 'admin-pass-1', 'admin');
    await mock.addUser('olly', 'operator-pass', 'operator');
    await signInBrowser(page, mock, 'olly', 'operator-pass');
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    const modal = await addImageTile(page);
    await modal.locator('#image-upload').setInputFiles({ name: 'badge.png', mimeType: 'image/png', buffer: PNG });
    await expect(modal.locator('#image-file')).toHaveValue('img-badge.png');
    // The same operator writing a UI image over HTTP is refused
    const { cookie } = await mock.signIn('olly', 'operator-pass');
    const fd = new FormData();
    fd.append('updatefile', new Blob([PNG], { type: 'image/png' }), 'logo.png');
    const r = await mock.call('/edit', { method: 'POST', cookie, body: fd });
    expect(r.status).toBe(403);
  });

  test('the sample layout shows the bundled example image', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await page.locator('button', { hasText: 'Edit Layout' }).click();
    page.on('dialog', d => d.accept());
    await page.locator('button', { hasText: 'Load sample layout' }).click();
    await page.locator('.page-pill', { hasText: 'Controls' }).click();
    await page.locator('button', { hasText: 'Save & Done' }).click();
    const img = page.locator('#gauges .wt-image img');
    await expect(img).toHaveAttribute('src', 'example-badge.png');
    await expect.poll(() => imgLoaded(img)).toBe(true);
    // The other pages are unchanged: Controls gained one tile
    expect((await savedPage(mock, 'Controls')).items.filter(g => g.type === 'image')).toHaveLength(1);
  });

  test('no shipped file uses the img- prefix, so an update never overwrites a user image', () => {
    expect(fs.readdirSync(DATA).filter(n => n.startsWith('img-'))).toEqual([]);
  });

  test('a settings backup carries the layout images and restores them byte for byte', async ({ page, mock }) => {
    await fetch(mock.url + '/__test/put-file?name=img-wiring.png', { method: 'POST', body: PNG });
    await fetch(mock.url + '/__test/put-file?name=img-unused.png', { method: 'POST', body: PNG });
    await mock.putFile('gauges.json', LAYOUT);
    await openApp(page, mock);
    await gotoTab(page, 'Settings');
    await page.locator('#settings-subtabs .page-pill', { hasText: 'Configuration' }).click();
    const dlPromise = page.waitForEvent('download');
    await page.locator('button', { hasText: 'Export settings' }).click();
    const chunks = [];
    for await (const c of await (await dlPromise).createReadStream()) chunks.push(c);
    const bundle = JSON.parse(Buffer.concat(chunks).toString());
    // Only what the pages show; the UI's own example picture isn't a backup's
    expect(Object.keys(bundle.images)).toEqual(['img-wiring.png']);

    // A fresh device: the image is gone, the bundle brings it back
    await mock.call('/edit?f=' + encodeURIComponent('/img-wiring.png'), { method: 'DELETE' });
    await mock.call('/edit?f=' + encodeURIComponent('/gauges.json'), { method: 'DELETE' });
    expect((await mock.state()).files).not.toContain('img-wiring.png');
    const dialogs = [];
    page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
    await page.locator('#ui-settings-import').setInputFiles({ name: 'ui-settings.json', mimeType: 'application/json', buffer: Buffer.concat(chunks) });
    await expect.poll(async () => (await mock.state()).files).toContain('gauges.json');
    const back = await fetch(mock.url + '/img-wiring.png');
    expect(Buffer.from(await back.arrayBuffer()).equals(PNG)).toBe(true);
    await expect.poll(() => dialogs.join('|')).toContain('Settings imported — reloading');
    await gotoTab(page, 'Gauges');
    await expect.poll(() => imgLoaded(page.locator('#gauges .wt-image img[src^="img-wiring"]'))).toBe(true);
  });

  test('a layout whose image is missing shows a placeholder, not a broken page', async ({ page, mock }) => {
    await mock.putFile('gauges.json', LAYOUT); // img-wiring.png was never uploaded here
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await expect(page.locator('#gauges .wt-image .img-empty')).toHaveText('Image not found: img-wiring.png');
    await expect(page.locator('#gauges .wt-image img')).toHaveCount(1); // the shipped picture beside it still shows
  });

  test('uploaded images are put back after a web-interface update', async ({ page, mock }) => {
    await fetch(mock.url + '/__test/put-file?name=img-wiring.png', { method: 'POST', body: PNG });
    await mock.putFile('gauges.json', LAYOUT);
    await openApp(page, mock);
    await gotoTab(page, 'Update');
    page.on('dialog', d => d.accept());
    await page.locator('#esp-ota-file').setInputFiles({
      name: 'esp32_v9.9-ota.bin', mimeType: 'application/octet-stream', buffer: Buffer.from('OIWEBOTA-test-image'),
    });
    await expect.poll(async () => (await mock.state()).otaFlashes).toBe(1);
    expect((await mock.state()).files).not.toContain('img-wiring.png'); // the update wiped it
    await page.reload();
    await expect.poll(async () => (await mock.state()).files).toContain('img-wiring.png');
    const back = await fetch(mock.url + '/img-wiring.png');
    expect(Buffer.from(await back.arrayBuffer()).equals(PNG)).toBe(true);
  });
});

