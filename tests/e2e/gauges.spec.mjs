import { test, expect, openApp, gotoTab } from './fixtures.mjs';

async function addGauge(page, name) {
  await page.locator('button', { hasText: 'Add Gauge' }).click();
  // FieldPicker: open the last picker and choose the spot value
  await page.locator('.main-right div', { hasText: /^Select\.\.\.$/ }).last().click();
  await page.locator('.hover-row', { hasText: name }).last().click();
}

test.describe('Gauges tab', () => {
  test('adds a gauge and streams its value', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await page.locator('button', { hasText: 'Edit Layout' }).click();
    await addGauge(page, 'udc');
    await page.locator('button', { hasText: 'Save & Done' }).click();
    // Layout persisted to the device
    await expect.poll(async () => (await mock.state()).files).toContain('gauges.json');
    // Default size is medium (230px)
    await expect(page.locator('#gauge-container svg[width="230"]')).toBeVisible();
    // The high-rate loop streams the value into the dial
    await expect(page.locator('#gauge-container .g-val')).toContainText('398.5');
  });

  test('gauges can be sized individually', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await page.locator('button', { hasText: 'Edit Layout' }).click();
    await addGauge(page, 'udc');
    await addGauge(page, 'tmphs');
    // Size the second gauge Large; the first keeps the default (Medium)
    await page.locator('select[title="Size for this gauge"]').last().selectOption('lg');
    await expect(page.locator('#gauge-container svg[width="230"]')).toBeVisible();
    await expect(page.locator('#gauge-container svg[width="300"]')).toBeVisible();
    // Per-gauge size round-trips through the saved layout
    await page.locator('button', { hasText: 'Save & Done' }).click();
    await expect.poll(async () => {
      const files = await fetch(mock.url + '/gauges.json').then(r => r.json()).catch(() => null);
      return files && files.items && files.items.map(i => i.size || '');
    }).toEqual(['', 'lg']);
  });

  test('global size select changes gauges without an override', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await page.locator('button', { hasText: 'Edit Layout' }).click();
    await addGauge(page, 'udc');
    await page.locator('button', { hasText: 'Save & Done' }).click();
    await page.locator('select[title*="Default gauge size"]').selectOption('xs');
    await expect(page.locator('#gauge-container svg[width="130"]')).toBeVisible();
  });
});
