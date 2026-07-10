import { test, expect, openApp, gotoTab } from './fixtures.mjs';

// Settings is split into two sub-tabs; Device & Connection is the default
async function gotoWebSubTab(page) {
  await page.locator('#settings-subtabs .page-pill', { hasText: 'Web Interface' }).click();
}

test.describe('Settings tab', () => {
  test('UART TX/RX swap posts to /settings and persists in mock state', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Settings');
    // The swap switch sits next to its text, not wrapping it — anchor on the
    // innermost row div holding the exact span, then take ITS slider (a
    // broader hasText match would catch the keep-awake switch further down)
    const row = page.locator('#settings div', { has: page.locator('span', { hasText: /^Swap TX\/RX Pins$/ }) }).last();
    await row.locator('label.switch .slider').click();
    await expect.poll(async () => (await mock.state()).settings.txrx_swapped).toBe(true);
  });

  test('sub-tabs split device and web-interface cards', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Settings');
    // Device & Connection is the default sub-tab
    await expect(page.locator('h3', { hasText: 'Data Interface' })).toBeVisible();
    await expect(page.locator('h3', { hasText: 'Appearance & Display' })).toHaveCount(0);
    await gotoWebSubTab(page);
    await expect(page.locator('h3', { hasText: 'Appearance & Display' })).toBeVisible();
    await expect(page.locator('h3', { hasText: 'Data Interface' })).toHaveCount(0);
    await expect(page.locator('h3', { hasText: /^Theme$/ })).toHaveCount(0);
    // Keep-awake renders as a full-size switch next to bold text (same pattern
    // as Swap TX/RX Pins), not a ToggleRow
    const wrap = page.locator('div', { has: page.locator('span', { hasText: /^Keep screen awake$/ }) }).last();
    await expect(wrap.locator('label.switch input[type="checkbox"]')).toHaveCount(1);
  });

  test('CAN scan stays disabled until the interface change is saved', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Settings');
    // Pick CAN Bus on the segmented control — an unsaved change
    await page.locator('.seg button', { hasText: 'CAN Bus' }).click();
    const scan = page.locator('#can-scan-btn');
    await expect(scan).toBeDisabled();
    await expect(page.locator('#settings')).toContainText('Unsaved changes');
    // Save applies the mode; scanning becomes available
    await page.locator('#iface-save').click();
    await expect(scan).toBeEnabled();
    await expect.poll(async () => (await mock.state()).settings.can_mode).toBe(true);
    await expect(page.locator('#settings')).not.toContainText('Unsaved changes');
    // ...and a scan now actually reaches the bus
    await scan.click();
    await expect(scan).toContainText('Found 1 device(s)');
    // Editing a CAN parameter dirties the config again -> scan re-disabled
    await page.locator('#settings label', { hasText: 'RX Pin' }).locator('input').fill('7');
    await expect(scan).toBeDisabled();
  });

  test('WiFi card shows station signal strength and the AP-fallback toggle posts', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Settings');
    // Live link state from /wifi-status: SSID, IP and signal bars
    await expect(page.locator('#settings')).toContainText('Connected to');
    await expect(page.locator('#settings')).toContainText('mocknet');
    await expect(page.locator('#wifi-signal')).toContainText('-58 dBm · Good');
    await expect(page.locator('#wifi-signal i.on')).toHaveCount(3); // -58 = 3 of 4 bars
    // The fallback toggle persists to the device
    await page.locator('.toggle-row', { hasText: 'Access point only as fallback' }).locator('.slider').click();
    await expect.poll(async () => (await mock.state()).settings.ap_fallback).toBe(true);
  });

  test('dashboard hero metrics are configurable (up to 5)', async ({ page, mock }) => {
    await openApp(page, mock);
    // Defaults show battery voltage + inverter temp
    await expect(page.locator('.metric-label', { hasText: 'Battery voltage' })).toBeVisible();
    await gotoTab(page, 'Settings');
    await gotoWebSubTab(page);
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

  test('theme and accent persist to the device (uiprefs.json)', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Settings');
    await gotoWebSubTab(page);
    // Pick a preset accent swatch and switch to dark theme
    await page.locator('.accent-swatches .swatch').nth(1).click();
    await page.locator('select.styled').first().selectOption('dark');
    // Dashboard metric choices ride along in the same device file
    await page.locator('select[title^="Dashboard value"]').nth(2).selectOption('speed');
    // Debounced write lands on the ESP
    await expect.poll(async () => (await mock.state()).files, { timeout: 5000 }).toContain('uiprefs.json');
    await expect.poll(async () => (await fetch(mock.url + '/uiprefs.json').then(r => r.json())).dashMetrics).toContain('speed');
    const prefs = await fetch(mock.url + '/uiprefs.json').then(r => r.json());
    expect(prefs.theme).toBe('dark');
    expect(prefs.accentColor).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  test('device-stored uiprefs apply on load in a fresh browser', async ({ page, mock }) => {
    // Seed the device file, then open the app with clean localStorage
    const prefs = { theme: 'dark', accentColor: '#ff6b8b', dashMetrics: ['speed', 'udc'] };
    await fetch(mock.url + '/__test/put-file?name=uiprefs.json', { method: 'POST', body: JSON.stringify(prefs) });
    await openApp(page, mock);
    await expect.poll(async () => page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('dark');
    expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--accent'))).toBe('#ff6b8b');
    // Device-stored dashboard metrics apply too (speed shows on the hero card)
    await expect(page.locator('.metric-label', { hasText: 'Motor speed' })).toBeVisible({ timeout: 10000 });
  });

  test('export settings produces a JSON bundle download', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Settings');
    await gotoWebSubTab(page);
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
    await gotoWebSubTab(page);
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
    // gauges.json uploads after favorites.json, so poll for the LATER one
    // (a synchronous check right after favorites lands races the gauges POST)
    await expect.poll(async () => (await mock.state()).files).toContain('gauges.json');
    expect((await mock.state()).files).toContain('favorites.json');
  });
});
