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
    await modal.locator('select').first().selectOption('line'); // Type is the first select
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
    await modal.locator('select').last().selectOption('1000'); // Sample is the last select (Type, Decimals, Sample)
    await modal.locator('button', { hasText: 'Done' }).click();
    await page.locator('button', { hasText: 'Save & Done' }).click();
    await expect.poll(async () => {
      const item = (await savedLayout(mock)).pages[0].items[0];
      return { points: item.points, sampleMs: item.sampleMs, type: item.type };
    }).toEqual({ points: 60, sampleMs: 1000, type: 'line' });
  });

  test('text tiles: live value with decimals, static caption, custom label', async ({ page, mock }) => {
    const layout = { v: 3, pages: [{ id: 1, name: 'Main', items: [
      { id: 1, name: 'udc', type: 'text', decimals: 2, label: 'Battery V', x: 0, y: 0, w: 3, h: 2 },
      { id: 2, name: '', type: 'text', text: 'DRIVE READY', x: 3, y: 0, w: 4, h: 2 },
    ] }] };
    await fetch(mock.url + '/__test/put-file?name=gauges.json', { method: 'POST', body: JSON.stringify(layout) });
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    // Live value rendered as text with 2 decimals + unit
    await expect(page.locator('.gauge-tile').first()).toContainText('398.50');
    await expect(page.locator('.gauge-tile').first()).toContainText('V');
    // Custom label replaces the value name on the tile
    await expect(page.locator('.gauge-tile-name', { hasText: 'Battery V' })).toBeVisible();
    // Static caption tile needs no value at all
    await expect(page.locator('.gauge-tile', { hasText: 'DRIVE READY' })).toBeVisible();
    // ...and counts as configured in edit mode: no 'tap to set up' nag and
    // no name row above the caption
    await enterEdit(page);
    await expect(page.locator('.gauge-tile', { hasText: 'DRIVE READY' })).not.toContainText('tap to set up');
    await expect(page.locator('.gauge-tile', { hasText: 'DRIVE READY' }).locator('.gauge-tile-name')).toHaveCount(0);
  });

  test('decimals setting applies to radial dials', async ({ page, mock }) => {
    const layout = { v: 3, pages: [{ id: 1, name: 'Main', items: [
      { id: 1, name: 'udc', type: 'radial', min: 0, max: 500, decimals: 0, x: 0, y: 0, w: 3, h: 3 },
    ] }] };
    await fetch(mock.url + '/__test/put-file?name=gauges.json', { method: 'POST', body: JSON.stringify(layout) });
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await expect(page.locator('.gauge-tile .g-val')).toHaveText('399'); // 398.5 @ 0 decimals
  });

  test('label and decimals configure from the settings modal and persist', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await enterEdit(page);
    await addGauge(page, 'udc');
    await page.locator('.gauge-tile').click();
    const modal = page.locator('.modal-content');
    await modal.locator('input[maxlength="24"]').fill('Pack Volts'); // Label
    await modal.locator('select').nth(1).selectOption('2'); // Decimals (select #2: type is first)
    await modal.locator('button', { hasText: 'Done' }).click();
    await expect(page.locator('.gauge-tile-name', { hasText: 'Pack Volts' })).toBeVisible();
    await expect(page.locator('.gauge-tile .g-val')).toContainText('398.50');
    await page.locator('button', { hasText: 'Save & Done' }).click();
    await expect.poll(async () => {
      const item = (await savedLayout(mock)).pages[0].items[0];
      return { label: item.label, decimals: item.decimals };
    }).toEqual({ label: 'Pack Volts', decimals: 2 });
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
    const tile = page.locator('.grid-stack-item');
    const before = (await tile.boundingBox()).width;
    const size = page.locator('.modal-content input[title^="Size"]');
    await size.fill('3');
    await size.dispatchEvent('change');
    // Assert on the observable geometry, not gs-w (gridstack strips that
    // attribute after parsing, so it's racy): the tile visibly grows and
    // loses the tiny class, and the new size persists.
    await expect.poll(async () => (await tile.boundingBox()).width, { timeout: 10000 }).toBeGreaterThan(before + 20);
    await expect(tile).not.toHaveClass(/tile-tiny/);
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

  test('inverted indicator lights while the value is OFF', async ({ page, mock }) => {
    const layout = { v: 3, pages: [{ id: 1, name: 'Main', items: [
      { id: 1, name: 'pot', type: 'indicator', min: 0, max: 4095, invert: true, color: '#ff6b6b', x: 0, y: 0, w: 3, h: 3 },
    ] }] };
    await fetch(mock.url + '/__test/put-file?name=gauges.json', { method: 'POST', body: JSON.stringify(layout) });
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    const lamp = page.locator('.ind-lamp');
    // pot is 0 — below the midpoint, so the value is OFF and the inverted
    // lamp is LIT; the caption still names the value's real state
    await expect(lamp).toHaveClass(/on/, { timeout: 5000 });
    await expect(page.locator('.ind-wrap .g-unit')).toHaveText('OFF');
    // Value comes ON -> inverted lamp goes dark
    await fetch(mock.url + '/__test/spot?name=pot&value=3000');
    await expect(lamp).not.toHaveClass(/on/, { timeout: 5000 });
    await expect(page.locator('.ind-wrap .g-unit')).toHaveText('ON');
  });

  test('indicator with Min = Max lights only on the exact value', async ({ page, mock }) => {
    const layout = { v: 3, pages: [{ id: 1, name: 'Main', items: [
      { id: 1, name: 'opmode', type: 'indicator', min: 3, max: 3, x: 0, y: 0, w: 3, h: 3 },
    ] }] };
    await fetch(mock.url + '/__test/put-file?name=gauges.json', { method: 'POST', body: JSON.stringify(layout) });
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    const lamp = page.locator('.ind-lamp');
    await expect(lamp).toBeVisible();
    await expect(lamp).not.toHaveClass(/on/); // opmode 0
    await fetch(mock.url + '/__test/spot?name=opmode&value=3');
    await expect(lamp).toHaveClass(/on/, { timeout: 5000 });
    // 4 is past the old midpoint but NOT the exact value — stays dark
    await fetch(mock.url + '/__test/spot?name=opmode&value=4');
    await expect(lamp).not.toHaveClass(/on/, { timeout: 5000 });
  });

  test('indicator invert checkbox round-trips through the settings modal', async ({ page, mock }) => {
    const layout = { v: 3, pages: [{ id: 1, name: 'Main', items: [
      { id: 1, name: 'pot', type: 'indicator', min: 0, max: 1, x: 0, y: 0, w: 3, h: 3 },
    ] }] };
    await fetch(mock.url + '/__test/put-file?name=gauges.json', { method: 'POST', body: JSON.stringify(layout) });
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await enterEdit(page);
    await page.locator('.gauge-tile').click();
    const modal = page.locator('.modal-content');
    await modal.locator('label', { hasText: 'Invert' }).locator('input[type="checkbox"]').check();
    await modal.locator('button', { hasText: 'Done' }).click();
    await page.locator('button', { hasText: 'Save & Done' }).click();
    await expect.poll(async () => (await savedLayout(mock)).pages[0].items[0].invert).toBe(true);
  });

  test('conditional page display switches to the page whose condition matches', async ({ page, mock }) => {
    // Conditions are inclusive ranges: Boost matches opmode EXACTLY 3 (not
    // 0-2 or 4), Fast matches speed 500-and-up (open-ended max)
    const layout = { v: 3, pages: [
      { id: 1, name: 'Main', items: [{ id: 1, name: 'udc', type: 'text', x: 0, y: 0, w: 2, h: 1 }] },
      { id: 2, name: 'Boost', cond: { name: 'opmode', min: 3, max: 3 }, items: [] },
      { id: 3, name: 'Fast', cond: { name: 'speed', min: 500 }, items: [] },
    ] };
    await fetch(mock.url + '/__test/put-file?name=gauges.json', { method: 'POST', body: JSON.stringify(layout) });
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    // opmode 0 / speed 0: nothing matches, first page shows
    await page.waitForTimeout(500);
    await expect(page.locator('.page-pill.active')).toHaveText('Main');
    // opmode 2 is below the 3..3 range -> still no match
    await fetch(mock.url + '/__test/spot?name=opmode&value=2');
    await page.waitForTimeout(500);
    await expect(page.locator('.page-pill.active')).toHaveText('Main');
    // opmode exactly 3 -> Boost
    await fetch(mock.url + '/__test/spot?name=opmode&value=3');
    await expect(page.locator('.page-pill.active')).toHaveText('Boost', { timeout: 5000 });
    // opmode 4 leaves the range: no page matches -> stays put
    await fetch(mock.url + '/__test/spot?name=opmode&value=4');
    await page.waitForTimeout(500);
    await expect(page.locator('.page-pill.active')).toHaveText('Boost');
    // Open-ended range: speed 900 >= 500 -> Fast
    await fetch(mock.url + '/__test/spot?name=speed&value=900');
    await expect(page.locator('.page-pill.active')).toHaveText('Fast', { timeout: 5000 });
    // The user can browse away while the condition still matches
    await page.locator('.page-pill', { hasText: 'Main' }).click();
    await page.waitForTimeout(500);
    await expect(page.locator('.page-pill.active')).toHaveText('Main');
    // A fresh match still fires
    await fetch(mock.url + '/__test/spot?name=speed&value=0');
    await page.waitForTimeout(300);
    await fetch(mock.url + '/__test/spot?name=speed&value=900');
    await expect(page.locator('.page-pill.active')).toHaveText('Fast', { timeout: 5000 });
  });

  test('inverted condition matches outside the range (any-error page)', async ({ page, mock }) => {
    const layout = { v: 3, pages: [
      { id: 1, name: 'Main', items: [{ id: 1, name: 'udc', type: 'text', x: 0, y: 0, w: 2, h: 1 }] },
      { id: 2, name: 'Fault', cond: { name: 'lasterr', min: 0, max: 0, invert: true }, items: [] },
    ] };
    await fetch(mock.url + '/__test/put-file?name=gauges.json', { method: 'POST', body: JSON.stringify(layout) });
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    // lasterr 0 is inside 0..0, inverted -> no match
    await page.waitForTimeout(500);
    await expect(page.locator('.page-pill.active')).toHaveText('Main');
    await fetch(mock.url + '/__test/spot?name=lasterr&value=1');
    await expect(page.locator('.page-pill.active')).toHaveText('Fault', { timeout: 5000 });
  });

  test('Auto pages toggle disarms conditional display and persists', async ({ page, mock }) => {
    const layout = { v: 3, pages: [
      { id: 1, name: 'Main', items: [{ id: 1, name: 'udc', type: 'text', x: 0, y: 0, w: 2, h: 1 }] },
      { id: 2, name: 'Fast', cond: { name: 'speed', min: 500 }, items: [] },
    ] };
    await fetch(mock.url + '/__test/put-file?name=gauges.json', { method: 'POST', body: JSON.stringify(layout) });
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await expect(page.locator('#auto-pages')).toBeVisible();
    await page.locator('#auto-pages .slider').click(); // off
    await expect.poll(async () => (await savedLayout(mock)).autoPage).toBe(false);
    await fetch(mock.url + '/__test/spot?name=speed&value=900');
    await page.waitForTimeout(700);
    await expect(page.locator('.page-pill.active')).toHaveText('Main');
    // The saved off state survives a reload
    await page.reload();
    await expect(page.locator('#version')).toContainText('Web: v0.1-mock');
    await page.waitForTimeout(700);
    await expect(page.locator('.page-pill.active')).toHaveText('Main');
  });

  test('sample layout replaces pages after confirmation and persists', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await enterEdit(page);
    await addGauge(page, 'udc'); // an existing layout the sample must replace
    const dialogs = [];
    page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
    await page.locator('button', { hasText: 'Load sample layout' }).click();
    await expect(page.locator('.page-pill', { hasText: 'Driving' })).toBeVisible();
    expect(dialogs[0]).toContain('Replace your current gauges');
    for (const name of ['Battery', 'Temps', 'Charging', 'Debug']) {
      await expect(page.locator('.page-pill', { hasText: name })).toBeVisible();
    }
    // Persisted straight to the device, conditional Charging page included
    await expect.poll(async () => (await savedLayout(mock)).pages.length).toBe(5);
    const saved = await savedLayout(mock);
    expect(saved.autoPage).toBe(true);
    expect(saved.pages[3].cond).toEqual({ name: 'opmode', min: 4, max: 4 });
    // The Auto pages toggle is visible now a condition exists
    await expect(page.locator('#auto-pages')).toBeVisible();
  });

  test('declining the sample-layout confirmation changes nothing', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await enterEdit(page);
    await addGauge(page, 'udc');
    page.on('dialog', d => d.dismiss());
    await page.locator('button', { hasText: 'Load sample layout' }).click();
    await page.waitForTimeout(400);
    await expect(page.locator('.page-pill', { hasText: 'Driving' })).toHaveCount(0);
    await expect(page.locator('.gauge-tile-name', { hasText: 'udc' })).toBeVisible();
  });

  test('action tile sets a parameter when pressed (configured via modal)', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await enterEdit(page);
    await page.locator('button', { hasText: 'Add Gauge' }).click();
    const modal = page.locator('.modal-content');
    await modal.locator('select').first().selectOption('action');
    // Pick the parameter and target value; confirm stays on by default
    await modal.locator('div', { hasText: /^Select\.\.\.$/ }).last().click();
    await modal.locator('.hover-row', { hasText: 'fweak' }).last().click();
    await modal.locator('input[type="number"]').first().fill('72');
    await modal.locator('button', { hasText: 'Done' }).click();
    await page.locator('button', { hasText: 'Save & Done' }).click();
    await expect.poll(async () => (await savedLayout(mock)).pages[0].items[0].type).toBe('action');
    const item = (await savedLayout(mock)).pages[0].items[0];
    expect(item.param).toBe('fweak');
    expect(item.value).toBe(72);
    // Fire it (accept the confirm dialog) — the inverter actually changes
    page.once('dialog', d => d.accept());
    const btn = page.locator('.action-tile-btn');
    await expect(btn).toContainText('set fweak 72'); // no label -> summary
    await btn.click();
    await expect(btn).toHaveClass(/ok/, { timeout: 5000 });
    expect(await mock.commands()).toContain('set fweak 72');
    expect((await mock.state()).inverter.params.fweak.value).toBe(72);
  });

  test('action tile confirm dialog: dismissing fires nothing', async ({ page, mock }) => {
    const layout = { v: 3, pages: [{ id: 1, name: 'Main', items: [
      { id: 1, type: 'action', param: 'fweak', value: 90, label: 'Boost', x: 0, y: 0, w: 2, h: 1 },
    ] }] };
    await fetch(mock.url + '/__test/put-file?name=gauges.json', { method: 'POST', body: JSON.stringify(layout) });
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    page.once('dialog', d => d.dismiss());
    await page.locator('.action-tile-btn', { hasText: 'Boost' }).click();
    await page.waitForTimeout(400);
    expect((await mock.commands()).filter(c => c.startsWith('set '))).toEqual([]);
    expect((await mock.state()).inverter.params.fweak.value).toBe(67);
  });

  test('CAN action tile sends a frame in CAN mode, fails cleanly in UART mode', async ({ page, mock }) => {
    const layout = { v: 3, pages: [{ id: 1, name: 'Main', items: [
      { id: 1, type: 'action', act: 'can', canId: '0x180', canData: '01 02', confirm: false, label: 'Heater', x: 0, y: 0, w: 2, h: 1 },
    ] }] };
    await fetch(mock.url + '/__test/put-file?name=gauges.json', { method: 'POST', body: JSON.stringify(layout) });
    // UART mode first: the button must fail with a flash, not send anything
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    const btn = page.locator('.action-tile-btn', { hasText: 'Heater' });
    await btn.click();
    await expect(btn).toHaveClass(/fail/, { timeout: 5000 });
    expect((await mock.commands()).filter(c => c.startsWith('can-send'))).toEqual([]);
    // Switch the device to CAN mode and reload: now it sends
    await fetch(mock.url + '/settings?can_mode=1', { method: 'POST' });
    await page.reload();
    await expect(page.locator('#version')).toContainText('Web: v0.1-mock');
    await gotoTab(page, 'Gauges');
    await btn.click();
    await expect(btn).toHaveClass(/ok/, { timeout: 5000 });
    await expect.poll(async () => await mock.commands()).toContain('can-send 0x180 01 02');
  });

  test('toggle tile flips a parameter and follows its live value', async ({ page, mock }) => {
    const layout = { v: 3, pages: [{ id: 1, name: 'Main', items: [
      { id: 1, type: 'toggle', param: 'potmin', onValue: 100, offValue: 0, label: 'Heat', x: 0, y: 0, w: 2, h: 2 },
    ] }] };
    await fetch(mock.url + '/__test/put-file?name=gauges.json', { method: 'POST', body: JSON.stringify(layout) });
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    const box = page.locator('.toggle-tile input[type="checkbox"]');
    // potmin starts at 0 = the OFF value
    await expect(box).not.toBeChecked();
    // Flip on: sets the ON value, and the streamed value moves the switch
    await page.locator('.toggle-tile').click();
    await expect.poll(async () => await mock.commands()).toContain('set potmin 100');
    await expect(box).toBeChecked({ timeout: 5000 });
    expect((await mock.state()).inverter.params.potmin.value).toBe(100);
    // Flip off again
    await page.locator('.toggle-tile').click();
    await expect.poll(async () => await mock.commands()).toContain('set potmin 0');
    await expect(box).not.toBeChecked({ timeout: 5000 });
  });

  test('CAN toggle sends the on/off payloads on one ID', async ({ page, mock }) => {
    const layout = { v: 3, pages: [{ id: 1, name: 'Main', items: [
      { id: 1, type: 'toggle', act: 'can', canId: '0x200', onData: '01', offData: '00', label: 'Pump', x: 0, y: 0, w: 2, h: 2 },
    ] }] };
    await fetch(mock.url + '/__test/put-file?name=gauges.json', { method: 'POST', body: JSON.stringify(layout) });
    await fetch(mock.url + '/settings?can_mode=1', { method: 'POST' });
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    const box = page.locator('.toggle-tile input[type="checkbox"]');
    await page.locator('.toggle-tile').click();
    await expect.poll(async () => await mock.commands()).toContain('can-send 0x200 01');
    await expect(box).toBeChecked(); // optimistic position (raw CAN has no feedback)
    await page.locator('.toggle-tile').click();
    await expect.poll(async () => await mock.commands()).toContain('can-send 0x200 00');
    await expect(box).not.toBeChecked();
  });

  test('slider tile interpolates Min..Max and sets the parameter on release', async ({ page, mock }) => {
    const layout = { v: 3, pages: [{ id: 1, name: 'Main', items: [
      { id: 1, type: 'slider', param: 'fweak', min: 0, max: 400, decimals: 0, label: 'Field weak', x: 0, y: 0, w: 4, h: 1 },
    ] }] };
    await fetch(mock.url + '/__test/put-file?name=gauges.json', { method: 'POST', body: JSON.stringify(layout) });
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    const range = page.locator('.slider-tile input[type="range"]');
    await expect(range).toBeVisible();
    // Knob follows the live value while idle (fweak streams back as 67)
    await expect.poll(async () => await range.inputValue(), { timeout: 5000 }).toBe('67');
    // Drag to 300: input events during the drag, ONE set on release
    await range.evaluate(el => {
      // runs in the browser: Event comes from the page's window
      const W = el.ownerDocument.defaultView;
      el.value = 300;
      el.dispatchEvent(new W.Event('input', { bubbles: true }));
      el.dispatchEvent(new W.Event('change', { bubbles: true }));
    });
    await expect.poll(async () => await mock.commands()).toContain('set fweak 300');
    expect((await mock.state()).inverter.params.fweak.value).toBe(300);
    await expect(page.locator('.slider-tile .g-val')).toContainText('300');
  });

  test('page condition editor round-trips through Save & Done', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await enterEdit(page);
    await page.locator('button', { hasText: 'Add condition' }).click();
    await page.locator('#page-cond div', { hasText: /^Select\.\.\.$/ }).last().click();
    await page.locator('.hover-row', { hasText: 'speed' }).last().click();
    // Min clears to blank (open-ended), Max set — "3000 and below"
    await page.locator('#page-cond input[type="number"]').nth(0).fill('');
    await page.locator('#page-cond input[type="number"]').nth(1).fill('3000');
    await page.locator('button', { hasText: 'Save & Done' }).click();
    // A blank bound persists as ABSENT (open end), not a default snapped back
    await expect.poll(async () => (await savedLayout(mock)).pages[0].cond)
      .toEqual({ name: 'speed', max: 3000 });
    // The Auto pages toggle appears once any page carries a condition
    await expect(page.locator('#auto-pages')).toBeVisible();
  });
});
