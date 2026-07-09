import { test, expect, openApp, gotoTab } from './fixtures.mjs';

async function enterEdit(page) {
  await page.locator('button', { hasText: 'Edit Layout' }).click();
}

async function addGauge(page, name) {
  await page.locator('button', { hasText: 'Add Gauge' }).click();
  // FieldPicker: open the newest picker and choose the spot value
  await page.locator('.main-right div', { hasText: /^Select\.\.\.$/ }).last().click();
  await page.locator('.hover-row', { hasText: name }).last().click();
}

async function savedLayout(mock) {
  return fetch(mock.url + '/gauges.json').then(r => r.json());
}

test.describe('Gauges grid', () => {
  test('adds a gauge, streams its value, persists a v2 layout with geometry', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await enterEdit(page);
    await addGauge(page, 'udc');
    await page.locator('button', { hasText: 'Save & Done' }).click();
    await expect.poll(async () => (await mock.state()).files).toContain('gauges.json');
    const layout = await savedLayout(mock);
    expect(layout.v).toBe(2);
    expect(layout.pages).toHaveLength(1);
    expect(layout.pages[0].name).toBe('Main');
    const item = layout.pages[0].items[0];
    expect(item.name).toBe('udc');
    for (const k of ['x', 'y', 'w', 'h']) expect(typeof item[k]).toBe('number');
    // The tile renders and the high-rate loop streams the value into the dial
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
    // Drag the tile ~4 cells right: distinct drag-start nudge, then the move,
    // with a settle pause so gridstack commits the drop before we save
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 10, cy + 2, { steps: 2 });
    await page.mouse.move(cx + 300, cy, { steps: 15 });
    await page.waitForTimeout(150);
    await page.mouse.up();
    // The grid attribute reflects the new column before we persist
    await expect.poll(async () => parseInt(await tile.getAttribute('gs-x') || '0')).toBeGreaterThan(0);
    await page.locator('button', { hasText: 'Save & Done' }).click();
    await expect.poll(async () => (await savedLayout(mock)).pages[0].items[0].x).toBeGreaterThan(0);
  });

  test('multiple named pages hold independent layouts', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await enterEdit(page);
    await addGauge(page, 'udc');
    // Create a second page via the prompt
    page.once('dialog', d => d.accept('Performance'));
    await page.locator('button', { hasText: 'New page' }).click();
    await expect(page.locator('.page-pill.active')).toHaveText('Performance');
    await addGauge(page, 'speed');
    await page.locator('button', { hasText: 'Save & Done' }).click();
    const layout = await savedLayout(mock);
    expect(layout.pages.map(p => p.name)).toEqual(['Main', 'Performance']);
    expect(layout.pages[0].items[0].name).toBe('udc');
    expect(layout.pages[1].items[0].name).toBe('speed');
    // Switching pills swaps the visible layout
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
    // Old layout appears as a tile on the migrated Main page
    await expect(page.locator('.gauge-tile-name', { hasText: 'udc' })).toBeVisible();
    await expect(page.locator('.page-pill.active')).toHaveText('Main');
    // Saving upgrades the stored schema to v2 with grid geometry
    await enterEdit(page);
    await page.locator('button', { hasText: 'Save & Done' }).click();
    await expect.poll(async () => (await savedLayout(mock)).v).toBe(2);
    const item = (await savedLayout(mock)).pages[0].items[0];
    expect(item.w).toBe(4); // legacy 'lg' size maps to a 4-cell span
    expect(item.max).toBe(500);
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
