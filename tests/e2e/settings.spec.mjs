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
