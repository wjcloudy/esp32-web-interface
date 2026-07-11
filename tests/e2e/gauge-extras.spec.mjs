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

  test('values stream over SSE when the device offers it (no polling round-trips)', async ({ page, mock }) => {
    await seedLayout(mock, [
      { id: 1, name: 'udc', type: 'radial', min: 0, max: 500, x: 0, y: 0, w: 3, h: 3 },
    ]);
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await expect(page.locator('.svg-gauge .g-val')).toContainText('398.5');
    // The stream opened...
    await expect.poll(async () => await mock.commands()).toContain('stream udc');
    // ...and live updates arrive over it, not via new 'get' polls
    const getsBefore = (await mock.commands()).filter(c => c === 'get udc').length;
    await setSpot(mock, 'udc', 250);
    await expect(page.locator('.svg-gauge .g-val')).toContainText('250.0');
    expect((await mock.commands()).filter(c => c === 'get udc').length).toBe(getsBefore);
  });

  test('falls back to polling when the stream is unavailable (old firmware)', async ({ page, mock }) => {
    await seedLayout(mock, [
      { id: 1, name: 'udc', type: 'radial', min: 0, max: 500, x: 0, y: 0, w: 3, h: 3 },
    ]);
    await page.route('**/stream**', route => route.abort());
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    // Values still flow — via the classic get loop
    await expect(page.locator('.svg-gauge .g-val')).toContainText('398.5');
    await expect.poll(async () => await mock.commands()).toContain('get udc');
  });

  test('session recorder captures the stream and exports CSV', async ({ page, mock }) => {
    await seedLayout(mock, [
      { id: 1, name: 'udc', type: 'radial', min: 0, max: 500, x: 0, y: 0, w: 3, h: 3 },
    ]);
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await expect(page.locator('.svg-gauge .g-val')).toContainText('398.5');
    await page.locator('#rec-btn').click(); // ● Record
    await expect(page.locator('#rec-btn')).toContainText('Stop');
    // Let a few ticks land, with a value change mid-recording
    await setSpot(mock, 'udc', 123);
    await expect(page.locator('.svg-gauge .g-val')).toContainText('123.0');
    await page.locator('#rec-btn').click(); // ■ Stop
    const modal = page.locator('.modal-content');
    await expect(modal.locator('#rec-summary')).toContainText('samples of 1 value(s)');
    // CSV download: time column + one column per recorded value
    const dlPromise = page.waitForEvent('download');
    await modal.locator('button', { hasText: 'Download CSV' }).click();
    const dl = await dlPromise;
    const chunks = [];
    for await (const c of await dl.createReadStream()) chunks.push(c);
    const csv = Buffer.concat(chunks).toString().trim().split('\n');
    expect(csv[0]).toBe('time_s,udc');
    expect(csv.length).toBeGreaterThan(2);
    expect(csv.some(l => l.endsWith(',123'))).toBe(true);
  });

  test('full-screen mode hides the chrome and the exit button restores it', async ({ page, mock }) => {
    await seedLayout(mock, [
      { id: 1, name: 'udc', type: 'radial', min: 0, max: 500, x: 0, y: 0, w: 3, h: 3 },
    ]);
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await page.locator('#fullscreen-btn').click();
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
