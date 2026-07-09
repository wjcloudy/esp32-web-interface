import { test, expect, openApp, gotoTab } from './fixtures.mjs';

test.describe('Settings tab', () => {
  test('UART TX/RX swap posts to /settings and persists in mock state', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Settings');
    // The swap switch sits next to its text, not wrapping it
    const toggle = page.locator('div', { hasText: 'Swap TX/RX Pins' }).locator('label.switch .slider').last();
    await toggle.click();
    await expect.poll(async () => (await mock.state()).settings.txrx_swapped).toBe(true);
  });

  test('renamed tiles and keep-awake switch styling', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Settings');
    await expect(page.locator('h3', { hasText: 'Appearance & Display' })).toBeVisible();
    await expect(page.locator('h3', { hasText: 'Data Interface' })).toBeVisible();
    await expect(page.locator('h3', { hasText: /^Theme$/ })).toHaveCount(0);
    // Keep-awake renders as a full-size switch next to bold text (same pattern
    // as Swap TX/RX Pins), not a ToggleRow
    const wrap = page.locator('div', { has: page.locator('span', { hasText: /^Keep screen awake$/ }) }).last();
    await expect(wrap.locator('label.switch input[type="checkbox"]')).toHaveCount(1);
  });

  test('dashboard hero metrics are configurable (up to 5)', async ({ page, mock }) => {
    await openApp(page, mock);
    // Defaults show battery voltage + inverter temp
    await expect(page.locator('.metric-label', { hasText: 'Battery voltage' })).toBeVisible();
    await gotoTab(page, 'Settings');
    const selects = page.locator('select[title^="Dashboard value"]');
    await expect(selects).toHaveCount(5);
    await selects.nth(2).selectOption('speed');
    await selects.nth(3).selectOption('opmode');
    await gotoTab(page, 'Dashboard');
    await expect(page.locator('.metric-label', { hasText: 'Motor speed' })).toBeVisible();
    await expect(page.locator('.metric-label', { hasText: /^opmode$/ })).toBeVisible();
    // Enum metric shows its resolved label, not the raw number
    const opmodeMetric = page.locator('.metric', { hasText: 'opmode' });
    await expect(opmodeMetric.locator('.metric-value')).toContainText('Off');
  });

  test('export settings produces a JSON bundle download', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Settings');
    const dlPromise = page.waitForEvent('download');
    await page.locator('button', { hasText: 'Export settings' }).click();
    const dl = await dlPromise;
    const stream = await dl.createReadStream();
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    const bundle = JSON.parse(Buffer.concat(chunks).toString());
    expect(bundle.type).toBe('openinverter-ui-settings');
  });

  test('import settings uploads layout files to the device and reloads', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Settings');
    page.on('dialog', d => d.accept());
    const bundle = {
      type: 'openinverter-ui-settings',
      favorites: { p: ['fweak'], s: [] },
      gauges: { items: [{ name: 'udc' }] },
    };
    await page.locator('#ui-settings-import').setInputFiles({
      name: 'backup.json', mimeType: 'application/octet-stream', // Android-style mime
      buffer: Buffer.from(JSON.stringify(bundle)),
    });
    await expect.poll(async () => (await mock.state()).files).toContain('favorites.json');
    expect((await mock.state()).files).toContain('gauges.json');
  });
});
