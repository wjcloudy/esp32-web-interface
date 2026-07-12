import { test, expect, openApp, gotoTab } from './fixtures.mjs';

// Settings is split into three sub-tabs; Device & Connection is the default
async function gotoSubTab(page, label) {
  await page.locator('#settings-subtabs .page-pill', { hasText: label }).click();
}
const gotoWebSubTab = (page) => gotoSubTab(page, 'Web Interface');

test.describe('Settings tab', () => {
  test('UART pins: board preset fills them and they persist on save', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Settings');
    // UART is the default interface; a board preset fills the pins (mock=esp32)
    const preset = page.locator('#uart-board-preset');
    await expect(preset.locator('option', { hasText: 'Wemos' })).toHaveCount(1);
    await preset.selectOption({ label: 'Wemos + OpenInverter (TX3 / RX1)' });
    await expect(page.locator('#uart-rx-pin')).toHaveValue('1');
    await expect(page.locator('#uart-tx-pin')).toHaveValue('3');
    // Tweak one and save via the interface Save button
    await page.locator('#uart-tx-pin').fill('17');
    await page.locator('#iface-save').click();
    await expect.poll(async () => (await mock.state()).settings.uart_tx_pin).toBe(17);
    expect((await mock.state()).settings.uart_rx_pin).toBe(1);
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
    // Keep-awake renders as a full-size switch next to bold text, not a ToggleRow
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

  test('CAN board preset fills the pins and transceiver enable pins persist', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Settings');
    await page.locator('.seg button', { hasText: 'CAN Bus' }).click();
    const preset = page.locator('#can-board-preset');
    // Only presets for this board's architecture (mock = esp32) are offered
    await expect(preset.locator('option', { hasText: 'LilyGO T-CAN485' })).toHaveCount(1);
    await expect(preset.locator('option', { hasText: 'T-2CAN' })).toHaveCount(0); // ESP32-S3 only
    await preset.selectOption({ label: 'LilyGO T-CAN485' });
    // Enable pins fill from the preset
    await expect(page.locator('#can-pwr-pin')).toHaveValue('16');
    await expect(page.locator('#can-en-pin')).toHaveValue('23');
    // Save and confirm everything landed on the device (incl. the inverted enable pin)
    await page.locator('#iface-save').click();
    await expect.poll(async () => (await mock.state()).settings.can_pwr_pin).toBe(16);
    const s = (await mock.state()).settings;
    expect(s).toMatchObject({ can_rx_pin: 26, can_tx_pin: 27, can_en_pin: 23, can_en_inv: true, can_pwr_inv: false });
    // Blank enable pin round-trips as unused (-1)
    await page.locator('#can-en-pin').fill('');
    await page.locator('#iface-save').click();
    await expect.poll(async () => (await mock.state()).settings.can_en_pin).toBe(-1);
  });

  test('board presets are filtered to the device architecture', async ({ page, mock }) => {
    // ESP32-S3 board: only its preset is offered
    await fetch(mock.url + '/__test/set-arch?a=esp32s3');
    await openApp(page, mock);
    await gotoTab(page, 'Settings');
    await page.locator('.seg button', { hasText: 'CAN Bus' }).click();
    const preset = page.locator('#can-board-preset');
    await expect(preset.locator('option', { hasText: 'T-2CAN' })).toHaveCount(1);
    await expect(preset.locator('option', { hasText: 'Generic ESP32' })).toHaveCount(0);
    await expect(preset.locator('option', { hasText: 'T-CAN485' })).toHaveCount(0);
  });

  test('no board presets shown when the device does not report an architecture', async ({ page, mock }) => {
    // Old firmware (no arch field) must not guess — the preset dropdown is hidden
    await fetch(mock.url + '/__test/set-arch'); // clear arch
    await openApp(page, mock);
    await gotoTab(page, 'Settings');
    await page.locator('.seg button', { hasText: 'CAN Bus' }).click();
    await expect(page.locator('#can-board-preset')).toHaveCount(0);
    // The manual pin fields are still there
    await expect(page.locator('#can-pwr-pin')).toBeVisible();
  });

  test('device nickname saves to the device and shows in the sidebar and tab title', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Settings');
    await page.locator('#dev-name').fill('Bench Rig');
    await page.locator('div', { has: page.locator('#dev-name') }).last().locator('button', { hasText: 'Save' }).click();
    await expect.poll(async () => (await mock.state()).settings.dev_name).toBe('Bench Rig');
    await expect(page.locator('#device-name')).toContainText('Bench Rig');
    await expect(page).toHaveTitle(/Bench Rig/);
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
    await gotoSubTab(page, 'Configuration'); // backup/restore moved to its own sub-tab
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
    await gotoSubTab(page, 'Configuration');
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

  test('individual files back up and restore from the Configuration sub-tab', async ({ page, mock }) => {
    // Seed a presets file to back up
    await fetch(mock.url + '/__test/put-file?name=presets.json', {
      method: 'POST', body: JSON.stringify({ v: 1, presets: [{ id: 1, name: 'Track', params: { fweak: 72 } }] }),
    });
    // One handler for the whole test — a second registration would race the
    // first for the same dialog
    const dialogs = [];
    page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
    await openApp(page, mock);
    await gotoTab(page, 'Settings');
    await gotoSubTab(page, 'Configuration');
    // Backup downloads the raw device file
    const row = page.locator('.preset-row', { hasText: 'Parameter presets' });
    const dlPromise = page.waitForEvent('download');
    await row.locator('button', { hasText: 'Backup' }).click();
    const dl = await dlPromise;
    expect(dl.suggestedFilename()).toBe('presets.json');
    const chunks = [];
    for await (const c of await dl.createReadStream()) chunks.push(c);
    expect(JSON.parse(Buffer.concat(chunks).toString()).presets[0].name).toBe('Track');
    // Restore replaces a single file (after a shape check + confirm)
    await page.locator('#single-import-gauges').setInputFiles({
      name: 'gauges.json', mimeType: 'application/octet-stream',
      buffer: Buffer.from(JSON.stringify({ v: 3, pages: [{ id: 1, name: 'Restored', items: [] }] })),
    });
    await expect.poll(async () => (await mock.state()).files).toContain('gauges.json');
    const saved = await fetch(mock.url + '/gauges.json').then(r => r.json());
    expect(saved.pages[0].name).toBe('Restored');
    // A wrong-shaped file is refused: a presets file can't restore as gauges.
    // (The app reloads ITSELF after a successful restore — our reload may
    // race it and abort; either way a loaded page follows.)
    await page.reload().catch(() => {});
    await expect(page.locator('#version')).toContainText('Web: v0.1-mock');
    await gotoTab(page, 'Settings');
    await gotoSubTab(page, 'Configuration');
    const before = dialogs.length;
    await page.locator('#single-import-gauges').setInputFiles({
      name: 'presets.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ v: 1, presets: [] })),
    });
    await expect.poll(() => dialogs.length).toBeGreaterThan(before);
    expect(dialogs[dialogs.length - 1]).toContain("doesn't look like a gauge pages file");
    // ...and gauges.json on the device is untouched
    expect((await fetch(mock.url + '/gauges.json').then(r => r.json())).pages[0].name).toBe('Restored');
  });
});
