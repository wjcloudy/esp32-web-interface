import { test, expect, openApp, gotoTab } from './fixtures.mjs';

async function enterEdit(page) {
  await page.locator('button', { hasText: 'Edit Layout' }).click();
}

// Add Gauge opens the new tile's settings modal; pick the value and close it
async function addGauge(page, name) {
  await page.locator('button', { hasText: 'Add Gauge' }).click();
  const modal = page.locator('.modal-content');
  await modal.locator('div', { hasText: /^Select\.\.\.$/ }).last().click();
  await modal.locator('.hover-row', { hasText: name }).last().click();
  await modal.locator('button', { hasText: 'Done' }).click();
}

async function savedLayout(mock) {
  return fetch(mock.url + '/gauges.json').then(r => r.json());
}

test.describe('Gauges grid', () => {
  test('adds a gauge, streams its value, persists a v3 layout with geometry', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await enterEdit(page);
    await addGauge(page, 'udc');
    await page.locator('button', { hasText: 'Save & Done' }).click();
    await expect.poll(async () => (await mock.state()).files).toContain('gauges.json');
    const layout = await savedLayout(mock);
    expect(layout.v).toBe(3);
    expect(layout.pages).toHaveLength(1);
    expect(layout.pages[0].name).toBe('Main');
    const item = layout.pages[0].items[0];
    expect(item.name).toBe('udc');
    for (const k of ['x', 'y', 'w', 'h']) expect(typeof item[k]).toBe('number');
    await expect(page.locator('.gauge-tile .g-val')).toContainText('398.5');
  });

  test('tiles can be moved by dragging (position round-trips)', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await enterEdit(page);
    await addGauge(page, 'udc');
    const tile = page.locator('.grid-stack-item');
    await expect(tile).toBeVisible();
    const before = await tile.boundingBox();
    const cx = before.x + before.width / 2, cy = before.y + before.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 10, cy + 2, { steps: 2 });
    await page.mouse.move(cx + 300, cy, { steps: 15 });
    await page.waitForTimeout(150);
    await page.mouse.up();
    await expect.poll(async () => parseInt(await tile.getAttribute('gs-x') || '0')).toBeGreaterThan(0);
    // The click fired on mouseup after the drag must NOT open the settings
    // modal (tap-vs-drag guard)
    await page.waitForTimeout(250);
    await expect(page.locator('.modal-content')).toHaveCount(0);
    await page.locator('button', { hasText: 'Save & Done' }).click();
    await expect.poll(async () => (await savedLayout(mock)).pages[0].items[0].x).toBeGreaterThan(0);
  });

  test('radial tiles resize live, snap to squares, and clamp at 2x2', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await enterEdit(page);
    await addGauge(page, 'udc');
    const tile = page.locator('.grid-stack-item');
    await tile.hover();
    const handle = tile.locator('.ui-resizable-se');
    await expect(handle).toBeAttached();
    const svgBefore = parseInt(await page.locator('.gauge-tile svg').getAttribute('width'));
    // Grow, deliberately non-square (much wider than tall)
    let hb = await handle.boundingBox();
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + 280, hb.y + 60, { steps: 10 });
    await page.waitForTimeout(150);
    await page.mouse.up();
    // Snaps back to a square, larger than before
    await expect.poll(async () => await tile.getAttribute('gs-w')).not.toBe('3');
    const w = parseInt(await tile.getAttribute('gs-w')), h = parseInt(await tile.getAttribute('gs-h'));
    expect(w).toBe(h);
    expect(w).toBeGreaterThan(3);
    // Dial rescaled live via ResizeObserver (no remount)
    await expect.poll(async () => parseInt(await page.locator('.gauge-tile svg').getAttribute('width'))).toBeGreaterThan(svgBefore);
    // Attempt to shrink below the minimum — engine clamps at 2x2.
    // Aim just inside the tile's top-left so the drag stays over the grid.
    await tile.hover();
    hb = await handle.boundingBox();
    const tb = await tile.boundingBox();
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(tb.x + 15, tb.y + 15, { steps: 10 });
    await page.waitForTimeout(150);
    await page.mouse.up();
    await expect.poll(async () => await tile.getAttribute('gs-w')).toBe('2');
    expect(await tile.getAttribute('gs-h')).toBe('2');
  });

  test('line gauge fits a long flat tile without overflowing', async ({ page, mock }) => {
    const layout = { v: 2, pages: [{ id: 1, name: 'Main', items: [
      { id: 1, name: 'pot', type: 'line', min: 0, max: 4095, x: 0, y: 0, w: 8, h: 2 },
    ] }] };
    await fetch(mock.url + '/__test/put-file?name=gauges.json', { method: 'POST', body: JSON.stringify(layout) });
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    const tile = page.locator('.grid-stack-item');
    const canvas = tile.locator('canvas');
    await expect(canvas).toBeVisible();
    // Poll: the ResizeObserver needs a beat to settle the chart into the tile
    await expect.poll(async () => {
      const tb = await tile.boundingBox();
      const cb = await canvas.boundingBox();
      return cb.width > cb.height && // landscape chart in a landscape tile
        cb.y + cb.height <= tb.y + tb.height + 1 &&
        cb.x + cb.width <= tb.x + tb.width + 1;
    }, { timeout: 10000 }).toBe(true);
    await expect(tile.locator('.g-val')).toContainText('0.0');
  });

  test('tile config modal edits value, range and type in place', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await enterEdit(page);
    await addGauge(page, 'udc');
    // Reopen settings from the tile's gear button
    await page.locator('.gauge-tile').click();
    const modal = page.locator('.modal-content');
    await expect(modal).toBeVisible();
    await modal.locator('input[type="number"]').nth(1).fill('500'); // max
    await modal.locator('select').selectOption('line');
    await modal.locator('button', { hasText: 'Done' }).click();
    await page.locator('button', { hasText: 'Save & Done' }).click();
    await expect.poll(async () => (await savedLayout(mock)).pages[0].items[0].max).toBe(500);
    expect((await savedLayout(mock)).pages[0].items[0].type).toBe('line');
  });

  test('line gauge points and sample rate configure and persist', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await enterEdit(page);
    await addGauge(page, 'udc');
    await page.locator('.gauge-tile').click();
    const modal = page.locator('.modal-content');
    await modal.locator('select').first().selectOption('line');
    // Line-specific history controls appear; points input is labelled
    await modal.locator('input[min="5"]').fill('60'); // points (min=5 is unique to it)
    await modal.locator('select').nth(1).selectOption('1000'); // sample every 1s
    await modal.locator('button', { hasText: 'Done' }).click();
    await page.locator('button', { hasText: 'Save & Done' }).click();
    await expect.poll(async () => {
      const item = (await savedLayout(mock)).pages[0].items[0];
      return { points: item.points, sampleMs: item.sampleMs, type: item.type };
    }).toEqual({ points: 60, sampleMs: 1000, type: 'line' });
  });

  test('duplicate button clones a tile with its full config', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await enterEdit(page);
    await addGauge(page, 'udc');
    // Give the original a custom range so the copy proves config carries over
    await page.locator('.gauge-tile').click();
    const modal = page.locator('.modal-content');
    await modal.locator('input[type="number"]').nth(1).fill('500'); // max
    await modal.locator('button', { hasText: 'Duplicate' }).click();
    await expect(page.locator('.grid-stack-item')).toHaveCount(2);
    await expect(page.locator('.gauge-tile-name', { hasText: 'udc' })).toHaveCount(2);
    await page.locator('button', { hasText: 'Save & Done' }).click();
    await expect.poll(async () => (await savedLayout(mock)).pages[0].items.length).toBe(2);
    const items = (await savedLayout(mock)).pages[0].items;
    expect(items[1].name).toBe('udc');
    expect(items[1].max).toBe(500); // config copied
    expect(items[1].id).not.toBe(items[0].id); // but a distinct tile
  });

  test('removing a gauge from its config modal deletes the tile', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await enterEdit(page);
    await addGauge(page, 'udc');
    await page.locator('.gauge-tile').click();
    await page.locator('.modal-content button', { hasText: 'Remove' }).click();
    await expect(page.locator('.grid-stack-item')).toHaveCount(0);
  });

  test('indicator lamp lights while the value is inside its on-range (1x1 tile)', async ({ page, mock }) => {
    const layout = { v: 2, pages: [{ id: 1, name: 'Main', items: [
      { id: 1, name: 'pot', type: 'indicator', min: 1, max: 4095, color: '#ff6b6b', x: 0, y: 0, w: 1, h: 1 },
    ] }] };
    await fetch(mock.url + '/__test/put-file?name=gauges.json', { method: 'POST', body: JSON.stringify(layout) });
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    const tile = page.locator('.grid-stack-item');
    // Indicators are exempt from the 2x2 minimum — the tile renders one cell
    // wide (attribute checks are racy: gridstack strips default w=1 at init)
    const gridBox = await page.locator('.grid-stack').boundingBox();
    await expect.poll(async () => (await tile.boundingBox()).width).toBeLessThan(gridBox.width / 10 * 1.5);
    const lamp = page.locator('.ind-lamp');
    await expect(lamp).toBeVisible();
    // Switching point is the midpoint of min/max: (1 + 4095) / 2 = 2048
    // pot is 0 -> below the midpoint -> off
    await expect(lamp).not.toHaveClass(/on/);
    await expect(page.locator('.ind-wrap .g-unit')).toHaveText('OFF');
    // Below the midpoint stays off; the streaming loop picks changes up
    await fetch(mock.url + '/__test/spot?name=pot&value=1000');
    await page.waitForTimeout(600);
    await expect(lamp).not.toHaveClass(/on/);
    // Past the midpoint -> on
    await fetch(mock.url + '/__test/spot?name=pot&value=3000');
    await expect(lamp).toHaveClass(/on/, { timeout: 5000 });
    await expect(page.locator('.ind-wrap .g-unit')).toHaveText('ON');
  });

  test('indicator works with enum (Off/On style) spot values', async ({ page, mock }) => {
    // opmode has an enum unit (0=Off, 1=Run, ...): values arrive numerically,
    // the midpoint of 0..1 switches at 0.5, and the caption shows the label
    const layout = { v: 2, pages: [{ id: 1, name: 'Main', items: [
      { id: 1, name: 'opmode', type: 'indicator', min: 0, max: 1, x: 0, y: 0, w: 3, h: 3 },
    ] }] };
    await fetch(mock.url + '/__test/put-file?name=gauges.json', { method: 'POST', body: JSON.stringify(layout) });
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    const lamp = page.locator('.ind-lamp');
    await expect(lamp).toBeVisible();
    await expect(lamp).not.toHaveClass(/on/);
    await expect(page.locator('.ind-wrap .g-unit')).toHaveText('Off'); // enum label, not OFF
    await fetch(mock.url + '/__test/spot?name=opmode&value=1');
    await expect(lamp).toHaveClass(/on/, { timeout: 5000 });
    await expect(page.locator('.ind-wrap .g-unit')).toHaveText('Run');
  });

  test('indicator lamp stays visible in a 2x2 tile at a phone viewport', async ({ page, mock }) => {
    const layout = { v: 2, pages: [{ id: 1, name: 'Main', items: [
      { id: 1, name: 'pot', type: 'indicator', min: 1, max: 1, color: '#2fbf71', x: 0, y: 0, w: 2, h: 2 },
    ] }] };
    await fetch(mock.url + '/__test/put-file?name=gauges.json', { method: 'POST', body: JSON.stringify(layout) });
    await page.setViewportSize({ width: 390, height: 780 });
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    const lamp = page.locator('.ind-lamp');
    await expect(lamp).toBeVisible();
    // The lamp gets real space even though the tile is tiny (name row yields)
    await expect.poll(async () => (await lamp.boundingBox()).height).toBeGreaterThan(8);
  });

  test('indicator tiles shrink down to 1x1 by dragging', async ({ page, mock }) => {
    const layout = { v: 2, pages: [{ id: 1, name: 'Main', items: [
      { id: 1, name: 'pot', type: 'indicator', min: 1, max: 1, x: 0, y: 0, w: 3, h: 3 },
    ] }] };
    await fetch(mock.url + '/__test/put-file?name=gauges.json', { method: 'POST', body: JSON.stringify(layout) });
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await enterEdit(page);
    const tile = page.locator('.grid-stack-item');
    await tile.hover();
    const handle = tile.locator('.ui-resizable-se');
    const hb = await handle.boundingBox();
    const tb = await tile.boundingBox();
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(tb.x + 10, tb.y + 10, { steps: 10 });
    await page.waitForTimeout(150);
    await page.mouse.up();
    // Shrunk to a single cell (attribute checks are racy for default w=1)
    const gridBox = await page.locator('.grid-stack').boundingBox();
    await expect.poll(async () => (await tile.boundingBox()).width).toBeLessThan(gridBox.width / 10 * 1.5);
    await page.locator('button', { hasText: 'Save & Done' }).click();
    // save() omits default w/h of 1 — our sync normalises them back to 1
    await expect.poll(async () => (await savedLayout(mock)).pages[0].items[0].w).toBe(1);
  });

  test('multiple named pages hold independent layouts', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await enterEdit(page);
    await addGauge(page, 'udc');
    page.once('dialog', d => d.accept('Performance'));
    await page.locator('button', { hasText: 'New page' }).click();
    await expect(page.locator('.page-pill.active')).toHaveText('Performance');
    await addGauge(page, 'speed');
    await page.locator('button', { hasText: 'Save & Done' }).click();
    const layout = await savedLayout(mock);
    expect(layout.pages.map(p => p.name)).toEqual(['Main', 'Performance']);
    expect(layout.pages[0].items[0].name).toBe('udc');
    expect(layout.pages[1].items[0].name).toBe('speed');
    await page.locator('.page-pill', { hasText: 'Main' }).click();
    await expect(page.locator('.gauge-tile-name', { hasText: 'udc' })).toBeVisible();
    await expect(page.locator('.gauge-tile-name', { hasText: 'speed' })).toHaveCount(0);
  });

  test('page rename and delete', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await enterEdit(page);
    page.once('dialog', d => d.accept('Debug'));
    await page.locator('button', { hasText: 'New page' }).click();
    page.once('dialog', d => d.accept('Driving'));
    await page.locator('button', { hasText: 'Rename' }).click();
    await expect(page.locator('.page-pill.active')).toHaveText('Driving');
    page.once('dialog', d => d.accept()); // confirm delete
    await page.locator('button', { hasText: 'Delete' }).click();
    await expect(page.locator('.page-pill', { hasText: 'Driving' })).toHaveCount(0);
    await expect(page.locator('.page-pill.active')).toHaveText('Main');
  });

  test('legacy v1 gauges.json migrates to a single page', async ({ page, mock }) => {
    const v1 = { items: [{ id: 1, name: 'udc', min: 0, max: 500, type: 'radial', size: 'lg' }], size: 'md' };
    await fetch(mock.url + '/__test/put-file?name=gauges.json', { method: 'POST', body: JSON.stringify(v1) });
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await expect(page.locator('.gauge-tile-name', { hasText: 'udc' })).toBeVisible();
    await expect(page.locator('.page-pill.active')).toHaveText('Main');
    await enterEdit(page);
    await page.locator('button', { hasText: 'Save & Done' }).click();
    await expect.poll(async () => (await savedLayout(mock)).v).toBe(3);
    const item = (await savedLayout(mock)).pages[0].items[0];
    expect(item.w).toBe(4); // legacy 'lg' size maps to a 4-cell span
    expect(item.max).toBe(500);
  });

  test('v2 (12-column) layouts rescale onto the 10-column grid', async ({ page, mock }) => {
    const v2 = { v: 2, pages: [{ id: 1, name: 'Main', items: [
      { id: 1, name: 'speed', type: 'radial', min: 0, max: 8000, x: 6, y: 0, w: 6, h: 6 },
    ] }] };
    await fetch(mock.url + '/__test/put-file?name=gauges.json', { method: 'POST', body: JSON.stringify(v2) });
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await expect(page.locator('.gauge-tile-name', { hasText: 'speed' })).toBeVisible();
    await enterEdit(page);
    await page.locator('button', { hasText: 'Save & Done' }).click();
    await expect.poll(async () => (await savedLayout(mock)).v).toBe(3);
    const item = (await savedLayout(mock)).pages[0].items[0];
    // 6/12 of the grid stays half the grid: 6 -> 5 of 10 columns, still square
    expect(item.w).toBe(5);
    expect(item.h).toBe(5);
    expect(item.x).toBe(5);
  });

  test('tiny tiles: no resize grip, tap opens settings, size set from modal', async ({ page, mock }) => {
    const layout = { v: 3, pages: [{ id: 1, name: 'Main', items: [
      { id: 1, name: 'opmode', type: 'indicator', min: 0, max: 1, x: 0, y: 0, w: 1, h: 1 },
    ] }] };
    await fetch(mock.url + '/__test/put-file?name=gauges.json', { method: 'POST', body: JSON.stringify(layout) });
    await page.setViewportSize({ width: 390, height: 800 });
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await enterEdit(page);
    // The grip would cover the whole ~23px tile and swallow every tap
    await expect(page.locator('.ui-resizable-se')).toBeHidden();
    await page.locator('.gauge-tile').click();
    await expect(page.locator('.modal-content')).toBeVisible();
    // Grow it from the modal instead: 1 -> 3 cells
    const size = page.locator('.modal-content input[title^="Size"]');
    await size.fill('3');
    await size.dispatchEvent('change');
    await expect.poll(async () => page.locator('.grid-stack-item').getAttribute('gs-w')).toBe('3');
    // No longer tiny, so the grip comes back (class check — the open modal
    // overlays the grip itself, so a visibility check would be unreliable)
    await expect(page.locator('.grid-stack-item')).not.toHaveClass(/tile-tiny/);
    // And the new size persists
    await page.locator('.modal-content button', { hasText: 'Done' }).click();
    await page.locator('button', { hasText: 'Save & Done' }).click();
    await expect.poll(async () => (await savedLayout(mock)).pages[0].items[0].w).toBe(3);
  });

  test('editing works at a mobile viewport', async ({ page, mock }) => {
    await page.setViewportSize({ width: 390, height: 780 });
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await enterEdit(page);
    await addGauge(page, 'tmphs');
    await expect(page.locator('.grid-stack-item')).toBeVisible();
    await page.locator('button', { hasText: 'Save & Done' }).click();
    await expect.poll(async () => (await mock.state()).files).toContain('gauges.json');
  });
});
