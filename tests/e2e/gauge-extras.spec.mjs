import { test, expect, openApp, gotoTab } from './fixtures.mjs';

// Newer gauge features: needle dials, peak-hold markers, value alarms,
// formula (computed) tiles, dual-series line tiles and drive mode.
const seedLayout = (mock, items, extra = {}) =>
  fetch(mock.url + '/__test/put-file?name=gauges.json', {
    method: 'POST', body: JSON.stringify({ v: 3, pages: [{ id: 1, name: 'Main', items }], ...extra }),
  });
const setSpot = (mock, name, value) =>
  fetch(mock.url + `/__test/spot?name=${name}&value=${value}`);

test.describe('Gauge extras', () => {
  test('needle style renders a rotating pointer with a hub', async ({ page, mock }) => {
    await seedLayout(mock, [
      { id: 1, name: 'udc', type: 'radial', gstyle: 'needle', min: 0, max: 500, x: 0, y: 0, w: 3, h: 3 },
    ]);
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    // Pointer appears once the stream delivers a value (udc = 398.5)
    await expect(page.locator('.g-needle line')).toBeVisible();
    await expect(page.locator('.g-hub')).toBeVisible();
    // The fill arc is hidden in needle mode
    await expect(page.locator('.g-value').first()).toHaveAttribute('opacity', '0');
    // Pointer angle tracks the value: 398.5 / 500 of the 270° sweep ≈ 215°
    const t = await page.locator('.g-needle').getAttribute('style');
    expect(t).toMatch(/rotate\(215\.\d+deg\)/);
  });

  test('peak-hold marker stays at the session high after the value drops', async ({ page, mock }) => {
    await setSpot(mock, 'udc', 300);
    await seedLayout(mock, [
      { id: 1, name: 'udc', type: 'radial', peak: true, min: 0, max: 500, x: 0, y: 0, w: 3, h: 3 },
      { id: 2, name: 'udc', type: 'bar', peak: true, min: 0, max: 500, x: 3, y: 0, w: 4, h: 2 },
    ]);
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await expect(page.locator('.svg-gauge .g-val')).toContainText('300.0');
    await setSpot(mock, 'udc', 100);
    await expect(page.locator('.svg-gauge .g-val')).toContainText('100.0');
    // Radial: tick drawn on the arc; bar: tick parked at 300/500 = 60%
    await expect(page.locator('.g-peak-tick')).toBeVisible();
    const barTick = page.locator('.bar-peak-tick');
    await expect(barTick).toBeVisible();
    expect(await barTick.getAttribute('style')).toMatch(/left:\s*60(\.\d+)?%/);
  });

  test('value alarm flashes the tile while in the warn zone and clears below it', async ({ page, mock }) => {
    await seedLayout(mock, [
      { id: 1, name: 'udc', type: 'radial', warn: 200, alarm: 'flash', min: 0, max: 500, x: 0, y: 0, w: 3, h: 3 },
    ]);
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    // udc starts at 398.5 — already past the 200 threshold
    const tile = page.locator('.gauge-tile').first();
    await expect(tile).toHaveClass(/alarming/);
    await setSpot(mock, 'udc', 100);
    await expect(tile).not.toHaveClass(/alarming/);
  });

  test('formula tiles compute their value from spot values', async ({ page, mock }) => {
    await seedLayout(mock, [
      { id: 1, type: 'text', calc: 'udc*2', unit: 'X', decimals: 0, x: 0, y: 0, w: 3, h: 2 },
    ]);
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    // udc = 398.5 → udc*2 = 797, with the tile's own unit text
    const tile = page.locator('.gauge-tile').first();
    await expect(tile).toContainText('797');
    await expect(tile).toContainText('X');
    // The formula doubles as the title when no label is set
    await expect(tile.locator('.gauge-tile-name')).toContainText('udc*2');
  });

  test('line tiles plot a second value with both live readouts', async ({ page, mock }) => {
    await seedLayout(mock, [
      { id: 1, name: 'udc', name2: 'tmphs', type: 'line', min: 0, max: 500, x: 0, y: 0, w: 5, h: 3 },
    ]);
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    const tile = page.locator('.gauge-tile').first();
    await expect(tile).toContainText('398.5');
    await expect(tile).toContainText('31.2');
    // Both series made it onto the chart
    await expect.poll(() => page.evaluate(() => {
      const canvas = document.querySelector('.gauge-tile canvas');
      const c = canvas && window.Chart.getChart(canvas);
      return c ? c.data.datasets.length : 0;
    })).toBe(2);
  });

  test('drive mode hides the chrome and the exit button restores it', async ({ page, mock }) => {
    await seedLayout(mock, [
      { id: 1, name: 'udc', type: 'radial', min: 0, max: 500, x: 0, y: 0, w: 3, h: 3 },
    ]);
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await page.locator('#drive-mode-btn').click();
    await expect(page.locator('body')).toHaveClass(/kiosk/);
    await expect(page.locator('#navbar')).toBeHidden();
    await expect(page.locator('#gauges-head')).toBeHidden();
    // Gauges keep streaming underneath
    await expect(page.locator('.svg-gauge .g-val')).toContainText('398.5');
    await page.locator('.kiosk-exit').click();
    await expect(page.locator('body')).not.toHaveClass(/kiosk/);
    await expect(page.locator('#navbar')).toBeVisible();
  });
});
