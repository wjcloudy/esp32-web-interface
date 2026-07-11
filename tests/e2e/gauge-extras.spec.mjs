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

  test('needle uses the set colour', async ({ page, mock }) => {
    await seedLayout(mock, [
      { id: 1, name: 'udc', type: 'radial', gstyle: 'needle', color: '#b78cff', min: 0, max: 500, x: 0, y: 0, w: 3, h: 3 },
    ]);
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await expect(page.locator('.g-needle line')).toHaveAttribute('stroke', '#b78cff');
  });

  test('centred gauge uses the reverse colour below the pivot', async ({ page, mock }) => {
    // idc streams 0 by default; set it below centre so the reverse colour shows
    await fetch(mock.url + '/__test/spot?name=speed&value=-100'); // reuse a signed-capable value
    await seedLayout(mock, [
      { id: 1, name: 'speed', type: 'bar', center: 0, revColor: '#54e6a4', color: '#4cc9f0', min: -300, max: 300, x: 0, y: 0, w: 5, h: 2 },
    ]);
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    // Value -100 is below centre 0 → the fill uses the reverse colour, not the gradient
    await expect.poll(async () =>
      page.locator('.bar-fill').first().evaluate(el => el.style.background)
    ).toContain('rgb(84, 230, 164)'); // #54e6a4
    // Above centre it reverts to the gradient (no solid reverse colour)
    await fetch(mock.url + '/__test/spot?name=speed&value=150');
    await expect.poll(async () =>
      page.locator('.bar-fill').first().evaluate(el => el.style.background)
    ).toContain('gradient');
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

  test('values stream over SSE in CAN mode too', async ({ page, mock }) => {
    await fetch(mock.url + '/settings?can_mode=1', { method: 'POST' });
    await seedLayout(mock, [
      { id: 1, name: 'udc', type: 'radial', min: 0, max: 500, x: 0, y: 0, w: 3, h: 3 },
    ]);
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await expect(page.locator('.svg-gauge .g-val')).toContainText('398.5');
    await expect.poll(async () => await mock.commands()).toContain('stream udc');
    // Live updates flow over the stream, not fresh polls
    const getsBefore = (await mock.commands()).filter(c => c === 'get udc').length;
    await setSpot(mock, 'udc', 320);
    await expect(page.locator('.svg-gauge .g-val')).toContainText('320.0');
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

  test('transparent tiles drop the card background and outline', async ({ page, mock }) => {
    await seedLayout(mock, [
      { id: 1, name: 'udc', type: 'radial', transparent: true, min: 0, max: 500, x: 0, y: 0, w: 3, h: 3 },
      { id: 2, name: 'udc', type: 'radial', min: 0, max: 500, x: 3, y: 0, w: 3, h: 3 },
    ]);
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    const clear = page.locator('.gauge-tile').first();
    const normal = page.locator('.gauge-tile').nth(1);
    await expect(clear).toHaveClass(/tile-clear/);
    await expect(normal).not.toHaveClass(/tile-clear/);
    expect(await clear.evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
    expect(await normal.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
    // The option round-trips through the settings modal
    await page.locator('button', { hasText: 'Edit Layout' }).click();
    await clear.click();
    const modal = page.locator('.modal-content');
    await expect(modal.locator('#gauge-transparent')).toBeChecked();
    await modal.locator('#gauge-transparent').uncheck();
    await expect(clear).not.toHaveClass(/tile-clear/);
  });

  test('centred gauge draws no arc/fill when the value is unavailable', async ({ page, mock }) => {
    // A name the inverter doesn't report → the tile reads "—". A centred
    // gauge must NOT draw the below-centre segment in that state.
    await seedLayout(mock, [
      { id: 1, name: 'nonexistent', type: 'radial', center: 0, min: -500, max: 500, x: 0, y: 0, w: 3, h: 3 },
      { id: 2, name: 'nonexistent', type: 'bar', center: 0, min: -500, max: 500, x: 3, y: 0, w: 4, h: 2 },
    ]);
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await expect(page.locator('.svg-gauge .g-val').first()).toContainText('—');
    await expect(page.locator('.svg-gauge .g-value').first()).toHaveAttribute('opacity', '0');
    expect(await page.locator('.bar-fill').first().evaluate(el => el.style.width)).toMatch(/^0(\.0)?%$/);
  });

  test('centred gauge draws the arc/fill once a valid value arrives', async ({ page, mock }) => {
    // udc = 398.5, above the 0 centre → arc/fill both shown
    await seedLayout(mock, [
      { id: 1, name: 'udc', type: 'radial', center: 0, min: -500, max: 500, x: 0, y: 0, w: 3, h: 3 },
      { id: 2, name: 'udc', type: 'bar', center: 0, min: -500, max: 500, x: 3, y: 0, w: 4, h: 2 },
    ]);
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await expect(page.locator('.svg-gauge .g-val').first()).toContainText('398.5');
    await expect(page.locator('.svg-gauge .g-value').first()).toHaveAttribute('opacity', '1');
    expect(await page.locator('.bar-fill').first().evaluate(el => parseFloat(el.style.width))).toBeGreaterThan(0);
  });

  test('wide screens cap tile height so a tall page fits the viewport', async ({ page, mock }) => {
    // Wide + short: square cells (width/10) would make a 9-row page ~2000px tall
    await page.setViewportSize({ width: 2400, height: 700 });
    await seedLayout(mock, [
      { id: 1, name: 'udc', type: 'radial', min: 0, max: 500, x: 0, y: 0, w: 3, h: 3 },
      { id: 2, name: 'udc', type: 'radial', min: 0, max: 500, x: 0, y: 3, w: 3, h: 3 },
      { id: 3, name: 'udc', type: 'radial', min: 0, max: 500, x: 0, y: 6, w: 3, h: 3 },
    ]);
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await page.locator('.grid-stack-item').nth(2).waitFor();
    // Every tile's bottom sits within the viewport — no downward scroll needed
    const maxBottom = await page.evaluate(() =>
      [...document.querySelectorAll('.grid-stack-item')]
        .reduce((m, el) => Math.max(m, el.getBoundingClientRect().bottom), 0));
    expect(maxBottom).toBeLessThanOrEqual(700 + 2);
    // ...and the cells stay square (a 3x3 tile is as wide as it is tall)
    const box = await page.locator('.grid-stack-item').first().boundingBox();
    expect(Math.abs(box.width - box.height)).toBeLessThanOrEqual(3);
  });

  test('swipe flips between gauge pages in view mode', async ({ page, mock }) => {
    await fetch(mock.url + '/__test/put-file?name=gauges.json', {
      method: 'POST', body: JSON.stringify({ v: 3, pages: [
        { id: 1, name: 'Drive', items: [{ id: 1, name: 'udc', type: 'radial', min: 0, max: 500, x: 0, y: 0, w: 3, h: 3 }] },
        { id: 2, name: 'Batt', items: [{ id: 2, name: 'tmphs', type: 'radial', min: 0, max: 100, x: 0, y: 0, w: 3, h: 3 }] },
      ] }),
    });
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await expect(page.locator('.page-pill.active')).toHaveText('Drive');
    // Drag left over the gauge area → next page
    const area = await page.locator('#gauges .main-left').boundingBox();
    const y = area.y + area.height - 40;
    await page.mouse.move(area.x + area.width - 60, y);
    await page.mouse.down();
    await page.mouse.move(area.x + 40, y, { steps: 8 });
    await page.mouse.up();
    await expect(page.locator('.page-pill.active')).toHaveText('Batt');
    // Drag right → back to the previous page
    await page.mouse.move(area.x + 40, y);
    await page.mouse.down();
    await page.mouse.move(area.x + area.width - 60, y, { steps: 8 });
    await page.mouse.up();
    await expect(page.locator('.page-pill.active')).toHaveText('Drive');
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
