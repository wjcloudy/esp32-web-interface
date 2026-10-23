import { test, expect, openApp, gotoTab } from './fixtures.mjs';

// Radial and bar Style options: Segmented (LED blocks lit up to the value,
// warn-coloured past Warn) and Zones (normal, caution and danger bands from
// Warn, with a pointer/marker at the value instead of a fill).
const seedLayout = (mock, items) =>
  fetch(mock.url + '/__test/put-file?name=gauges.json', {
    method: 'POST', body: JSON.stringify({ v: 3, pages: [{ id: 1, name: 'Main', items }] }),
  });
const setSpot = (mock, name, value) => fetch(mock.url + `/__test/spot?name=${name}&value=${value}`);
const tile = (n) => `#gauges .grid-stack-item[gs-id="${n}"]`;

test.describe('Gauge styles', () => {
  test('Segmented radial lights the blocks up to the value; past Warn they take the warn colour', async ({ page, mock }) => {
    await seedLayout(mock, [{ id: 1, name: 'udc', type: 'radial', gstyle: 'segments', min: 0, max: 500, warn: 350, warnColor: '#ff0000', x: 0, y: 0, w: 3, h: 3 }]);
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    // The block count follows the tile's measured size, so read both together
    // once it settles. udc = 398.5 of 500: about 80% of the blocks lit
    const lit = (sel) => page.locator(sel).evaluateAll(els => [els.length, els.filter(e => e.classList.contains('on')).length]);
    await expect.poll(async () => { const [n, on] = await lit(tile(1) + ' .g-seg'); return n >= 12 && on === Math.round(n * 398.5 / 500); }).toBe(true);
    await expect(page.locator(tile(1) + ' .g-value')).toHaveCount(0);
    // Blocks standing for 350 and up sweep the warn colour's hue gently (red ±8°);
    // the lowest is on the normal cyan-to-green sweep
    const strokes = await page.locator(tile(1) + ' .g-seg.on').evaluateAll(els => els.map(e => e.getAttribute('stroke')));
    const hue = (hsl) => Number(/^hsl\((\d+),/.exec(hsl)[1]);
    const last = hue(strokes[strokes.length - 1]);
    expect(last <= 8 || last >= 352).toBe(true);
    expect(strokes[0]).toMatch(/^#/);
    await expect(page.locator(tile(1) + ' .g-val')).toHaveText('398.5');
  });

  test('Zone track radial draws normal, caution and danger bands with a pointer', async ({ page, mock }) => {
    await seedLayout(mock, [
      { id: 1, name: 'udc', type: 'radial', gstyle: 'zones', min: 0, max: 500, warn: 450, x: 0, y: 0, w: 3, h: 3 },
      { id: 2, name: 'udc', type: 'radial', gstyle: 'zones', min: 0, max: 500, x: 3, y: 0, w: 3, h: 3 },
    ]);
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await expect(page.locator(tile(1) + ' .g-zone')).toHaveCount(3);
    // Each band is a hue-offset gradient around its colour, like the fill
    await expect(page.locator(tile(1) + ' .g-zone').nth(1)).toHaveAttribute('stroke', /^url\(#ggrad1f59e0b\)$/);
    await expect(page.locator(tile(1) + ' .g-zone').nth(2)).toHaveAttribute('stroke', /^url\(#ggrad1ef4444\)$/);
    await expect(page.locator(tile(1) + ' linearGradient#ggrad1ef4444 stop')).toHaveCount(3);
    // Without Warn it's one band
    await expect(page.locator(tile(2) + ' .g-zone')).toHaveCount(1);
    // The pointer tracks the value like a needle: 398.5 / 500 of 270° ≈ 215°
    expect(await page.locator(tile(1) + ' .g-pointer').getAttribute('style')).toMatch(/rotate\(215\.\d+deg\)/);
    await expect(page.locator(tile(1) + ' .g-value')).toHaveCount(0);
  });

  test('Segmented and Zone band bars', async ({ page, mock }) => {
    await seedLayout(mock, [
      { id: 1, name: 'udc', type: 'bar', gstyle: 'segments', min: 0, max: 500, x: 0, y: 0, w: 6, h: 1 },
      { id: 2, name: 'udc', type: 'bar', gstyle: 'zones', min: 0, max: 500, warn: 450, x: 0, y: 1, w: 6, h: 1 },
    ]);
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    const lit = (sel) => page.locator(sel).evaluateAll(els => [els.length, els.filter(e => e.classList.contains('on')).length]);
    await expect.poll(async () => { const [n, on] = await lit(tile(1) + ' .bar-seg'); return n >= 8 && on === Math.round(n * 398.5 / 500); }).toBe(true);
    await expect(page.locator(tile(1) + ' .bar-fill')).toHaveCount(0);
    await expect(page.locator(tile(2) + ' .bar-zone')).toHaveCount(3);
    await expect(page.locator(tile(2) + ' .bar-fill')).toHaveCount(0);
    // The marker sits at the value: 398.5 / 500 = 79.7% along
    await expect(page.locator(tile(2) + ' .bar-marker')).toHaveAttribute('style', /left: ?79\.70?%/);
    // A value past Warn turns the marker the warn colour
    await setSpot(mock, 'udc', 470);
    await expect(page.locator(tile(2) + ' .bar-marker')).toHaveCSS('background-color', 'rgb(245, 158, 11)');
  });

  test('the Style picker offers each type its own styles and saves the choice', async ({ page, mock }) => {
    await seedLayout(mock, [
      { id: 1, name: 'udc', type: 'radial', min: 0, max: 500, x: 0, y: 0, w: 3, h: 3 },
      { id: 2, name: 'udc', type: 'bar', min: 0, max: 500, x: 3, y: 0, w: 4, h: 1 },
    ]);
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await page.locator('button', { hasText: 'Edit Layout' }).click();
    const modal = page.locator('.modal-content');
    await page.locator(tile(1) + ' .gauge-tile').click();
    await expect(modal.locator('#gauge-style option')).toHaveText(['Filled arc', 'Needle dial', 'Segmented', 'Zone track']);
    await modal.locator('#gauge-style').selectOption('zones');
    // Zones reads Warn: without one it says so
    await expect(modal.getByText('Set Warn ≥ to get caution and danger bands')).toBeVisible();
    await modal.locator('button', { hasText: 'Done' }).click();
    await page.locator(tile(2) + ' .gauge-tile').click();
    await expect(modal.locator('#gauge-style option')).toHaveText(['Filled bar', 'Segmented LED', 'Zone bands']);
    await modal.locator('#gauge-style').selectOption('segments');
    await modal.locator('button', { hasText: 'Done' }).click();
    await page.locator('button', { hasText: 'Save & Done' }).click();
    await expect.poll(async () => (await fetch(mock.url + '/gauges.json').then(r => r.json())).pages.find(p => p.name === 'Main').items.map(g => g.gstyle))
      .toEqual(['zones', 'segments']);
    await expect(page.locator(tile(1) + ' .g-zone')).toHaveCount(1);
    await expect(page.locator(tile(2) + ' .bar-seg').first()).toBeVisible();
  });
});
