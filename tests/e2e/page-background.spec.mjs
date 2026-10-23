import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, openApp, gotoTab } from './fixtures.mjs';

// Page backgrounds: a picture behind a gauge page, pinned to the grid's own
// coordinates (full width, bg.rows cells tall), so tiles placed over spots in
// it stay there at any width. Clear tiles sit on it with no card at all.

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
const PNG = fs.readFileSync(path.join(DATA, 'example-badge.png'));
const seedImage = (mock, name) => fetch(mock.url + '/__test/put-file?name=' + name, { method: 'POST', body: PNG });
const LAYOUT = (bg) => ({ v: 3, pages: [{ id: 1, name: 'Car', bg, items: [
  { id: 1, name: 'udc', type: 'indicator', min: 0, max: 1, x: 2, y: 2, w: 1, h: 1, transparent: true },
  { id: 2, name: 'udc', type: 'text', x: 6, y: 3, w: 2, h: 1, transparent: true },
] }] });
const savedPage = async (mock) => (await fetch(mock.url + '/gauges.json').then(r => r.json())).pages.find(p => p.name === 'Car');
const bgLoaded = (page) => page.locator('#gauges .page-bg img').evaluate(img => img.complete && img.naturalWidth > 0);

// Where each tile sits as a fraction of the background's box
const tileSpots = (page) => page.evaluate(() => {
  const b = document.querySelector('#gauges .page-bg').getBoundingClientRect();
  return [...document.querySelectorAll('#gauges .grid-stack-item')].map(el => {
    const r = el.getBoundingClientRect();
    return [(r.left + r.width / 2 - b.left) / b.width, (r.top + r.height / 2 - b.top) / b.height];
  });
});

test.describe('Page backgrounds', () => {
  test('the background scales and moves with the grid: tiles keep their spot on it', async ({ page, mock }) => {
    await seedImage(mock, 'img-car.png');
    await mock.putFile('gauges.json', LAYOUT({ file: 'img-car.png', rows: 5 }));
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await expect.poll(() => bgLoaded(page)).toBe(true);
    const wide = await tileSpots(page);
    const wideBox = await page.locator('#gauges .page-bg').boundingBox();
    // Cell (2,2) of a 10x5 picture: its centre is at 25% / 50%
    expect(wide[0][0]).toBeCloseTo(0.25, 2);
    expect(wide[0][1]).toBeCloseTo(0.5, 2);
    await page.setViewportSize({ width: 820, height: 900 });
    await expect.poll(async () => (await page.locator('#gauges .page-bg').boundingBox()).width).toBeLessThan(wideBox.width - 50);
    // The grid re-lays out on a ResizeObserver tick: wait for it to settle
    const drift = async () => {
      const narrow = await tileSpots(page);
      return Math.max(...narrow.flatMap((s, i) => [Math.abs(s[0] - wide[i][0]), Math.abs(s[1] - wide[i][1])]));
    };
    await expect.poll(drift).toBeLessThan(0.01);
  });

  test('set from the page settings (upload), persisted, and back after a reload', async ({ page, mock }) => {
    await mock.putFile('gauges.json', LAYOUT(undefined));
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await page.locator('button', { hasText: 'Edit Layout' }).click();
    const box = page.locator('#page-bg-settings');
    await box.locator('#bg-upload').setInputFiles({ name: 'Car side.png', mimeType: 'image/png', buffer: PNG });
    await expect(box.locator('#bg-file')).toHaveValue('img-car-side.png');
    await expect(box.locator('#bg-rows')).toHaveValue('4'); // the page's height so far
    await box.locator('#bg-rows').fill('5');
    await box.locator('#bg-fit').selectOption('cover');
    await page.locator('button', { hasText: 'Save & Done' }).click();
    await expect.poll(async () => (await savedPage(mock)).bg).toMatchObject({ file: 'img-car-side.png', rows: 5, fit: 'cover' });
    await page.reload();
    await gotoTab(page, 'Gauges');
    await expect.poll(() => bgLoaded(page)).toBe(true);
    await expect(page.locator('#gauges .page-bg img')).toHaveCSS('object-fit', 'cover');
  });

  test('a missing background fails quietly, with a note only while editing', async ({ page, mock }) => {
    await mock.putFile('gauges.json', LAYOUT({ file: 'img-gone.png', rows: 5 }));
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await expect(page.locator('#gauges .gauge-tile').first()).toBeVisible();
    await expect(page.locator('#gauges .page-bg')).toHaveCount(0);
    await expect(page.locator('#gauges .page-bg-missing')).toHaveCount(0);
    await page.locator('button', { hasText: 'Edit Layout' }).click();
    await expect(page.locator('#gauges .page-bg-missing')).toHaveText('Background image not found: img-gone.png');
  });

  test('a settings backup carries the background image', async ({ page, mock }) => {
    await seedImage(mock, 'img-car.png');
    await mock.putFile('gauges.json', LAYOUT({ file: 'img-car.png', rows: 5 }));
    await openApp(page, mock);
    await gotoTab(page, 'Settings');
    await page.locator('#settings-subtabs .page-pill', { hasText: 'Configuration' }).click();
    const dlPromise = page.waitForEvent('download');
    await page.locator('button', { hasText: 'Export settings' }).click();
    const chunks = [];
    for await (const c of await (await dlPromise).createReadStream()) chunks.push(c);
    expect(Object.keys(JSON.parse(Buffer.concat(chunks).toString()).images)).toEqual(['img-car.png']);
    await mock.call('/edit?f=' + encodeURIComponent('/img-car.png'), { method: 'DELETE' });
    page.on('dialog', d => d.accept());
    await page.locator('#ui-settings-import').setInputFiles({ name: 'ui-settings.json', mimeType: 'application/json', buffer: Buffer.concat(chunks) });
    await expect.poll(async () => (await mock.state()).files).toContain('img-car.png');
    expect(Buffer.from(await (await fetch(mock.url + '/img-car.png')).arrayBuffer()).equals(PNG)).toBe(true);
  });

  test('Clear tiles have no card at all: no background, border or shadow', async ({ page, mock }) => {
    await mock.putFile('gauges.json', LAYOUT(undefined));
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    const css = await page.locator('#gauges .gauge-tile.tile-clear').first().evaluate(el => {
      const s = getComputedStyle(el);
      return [s.backgroundColor, s.borderTopColor, s.boxShadow, s.backdropFilter];
    });
    expect(css).toEqual(['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)', 'none', 'none']);
  });

  test('the sample layout\'s Vehicle page has its picture with lamp tiles on it', async ({ page, mock }) => {
    await mock.putFile('gauges.json', fs.readFileSync(path.join(DATA, 'gauges-sample.json'), 'utf8'));
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await page.locator('.page-pill', { hasText: 'Vehicle' }).click();
    await expect.poll(() => bgLoaded(page)).toBe(true);
    // The car is a 4x2-cell block, with gauges beside and below it
    const sample = JSON.parse(fs.readFileSync(path.join(DATA, 'gauges-sample.json'), 'utf8')).pages.find(p => p.name === 'Vehicle');
    expect(sample.bg).toMatchObject({ cols: 4, rows: 2 });
    await expect(page.locator('#gauges .gauge-tile')).toHaveCount(sample.items.length);
    // Its four car lamps are Lamp only: just the light, no name row or ON/OFF
    // caption (Plug and FWD beside the car are ordinary indicators)
    const lampOnly = sample.items.filter(g => g.lampOnly).length;
    expect(lampOnly).toBe(4);
    const lamps = page.locator('#gauges .gauge-tile:has(.ind-lamp)');
    await expect(lamps).toHaveCount(sample.items.filter(g => g.type === 'indicator').length);
    await expect(lamps.filter({ has: page.locator('.gauge-tile-name') })).toHaveCount(2);
    // Only the tiles over the car (the 4x2 block) count as on the picture;
    // its live temperatures are Badges, each a pill with name, value and unit
    const onCar = sample.items.filter(g => g.x < 4 && g.y < 2).length;
    await expect(page.locator('#gauges .gauge-tile.on-bg')).toHaveCount(onCar);
    const badges = page.locator('#gauges .on-bg .tile-badge');
    await expect(badges).toHaveCount(sample.items.filter(g => g.badge).length);
    await expect(badges.first().locator('.tb-name')).toHaveText('Inverter');
    // (the mock doesn't report tmphs: a value with its unit, or a bare dash)
    await expect(badges.first().locator('.tb-val')).toHaveText(/^(\d+°C|—)$/);
  });

  test('"Text on it" pins light or dark text on tiles over the picture only', async ({ page, mock }) => {
    await seedImage(mock, 'img-car.png');
    await mock.putFile('gauges.json', LAYOUT({ file: 'img-car.png', cols: 4, rows: 3, ink: 'light' }));
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    // The indicator at (2,2) is on the 4x3 block; the text tile at (6,3) is not
    await expect(page.locator('#gauges .gauge-tile.on-bg.ink-light')).toHaveCount(1);
    await expect(page.locator('#gauges .gauge-tile.on-bg.ink-light .ind-lamp')).toHaveCount(1);
  });

  test('a background can be a block of cells: Size and At place it on the grid', async ({ page, mock }) => {
    await seedImage(mock, 'img-car.png');
    await mock.putFile('gauges.json', LAYOUT({ file: 'img-car.png', x: 2, y: 1, cols: 4, rows: 2 }));
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await expect.poll(() => bgLoaded(page)).toBe(true);
    const box = () => page.evaluate(() => {
      const g = document.querySelector('#gauges .grid-stack').getBoundingClientRect();
      const b = document.querySelector('#gauges .page-bg').getBoundingClientRect();
      const cell = g.width / 10;
      return [(b.left - g.left) / cell, (b.top - g.top) / cell, b.width / cell, b.height / cell].map(v => Math.round(v * 100) / 100);
    });
    // Rows use the grid's whole-pixel cell height, as the tiles do: allow for rounding
    const off = async () => { const b = await box(); return Math.max(...[2, 1, 4, 2].map((v, i) => Math.abs(b[i] - v))); };
    await expect.poll(off).toBeLessThan(0.03);
    // The page is kept tall enough for the block (row 1 + 2 rows)
    expect(await page.locator('#gauges .grid-stack').evaluate(el => el.getBoundingClientRect().height / (el.getBoundingClientRect().width / 10))).toBeGreaterThanOrEqual(2.99);
    await page.setViewportSize({ width: 820, height: 900 });
    await expect.poll(off).toBeLessThan(0.03);
  });

  test('Lamp only hides an indicator\'s name and caption, and is saved', async ({ page, mock }) => {
    await mock.putFile('gauges.json', LAYOUT(undefined));
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    const tile = page.locator('#gauges .gauge-tile:has(.ind-lamp)');
    await expect(tile.locator('.gauge-tile-name')).toHaveCount(1);
    await page.locator('button', { hasText: 'Edit Layout' }).click();
    await tile.click();
    const modal = page.locator('.modal-content');
    await modal.locator('#gauge-lamp-only').check();
    await modal.locator('button', { hasText: 'Done' }).click();
    await page.locator('button', { hasText: 'Save & Done' }).click();
    await expect.poll(async () => (await savedPage(mock)).items.find(g => g.id === 1).lampOnly).toBe(true);
    await expect(tile.locator('.gauge-tile-name')).toHaveCount(0);
    await expect(tile.locator('.ind-wrap .g-unit')).toHaveCount(0);
    await expect(tile.locator('.ind-lamp')).toBeVisible();
  });
});
