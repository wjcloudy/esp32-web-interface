import { test, expect, openApp, gotoTab, signInBrowser } from './fixtures.mjs';
/* global URLSearchParams */

// MQTT card on Settings → Device & Connection: settings are admin-only
// (/mqtt), the connection status is for any viewer (/mqtt/status), and the
// stored password never comes back from the device.

const setStatus = (mock, s) => fetch(mock.url + '/__test/mqtt-status', { method: 'POST', body: JSON.stringify(s) });

test.describe('MQTT settings', () => {
  test('saves broker settings, keeps the password private and shows the connection', async ({ page, mock }) => {
    await openApp(page, mock); await gotoTab(page, 'Settings');
    const box = page.locator('#mqtt-box');
    await expect(box.locator('#mqtt-status')).toContainText('Off');

    // Enabling without a host is refused in the UI, and the toggle stays off
    await box.locator('label.toggle-row', { hasText: 'Publish to MQTT' }).click();
    await expect(box.getByRole('alert')).toContainText('broker host');
    await expect(box.getByRole('checkbox', { name: 'Publish to MQTT' })).not.toBeChecked();

    await box.locator('#mqtt-host').fill('homeassistant.local');
    await box.locator('#mqtt-port').fill('1884');
    await box.locator('#mqtt-user').fill('ha');
    await box.locator('#mqtt-pass').fill('s3cret pass');
    await box.locator('#mqtt-names').fill('udc, tmphs; udc nosuchvalue');
    await box.locator('#mqtt-interval').fill('10');
    // A name the inverter's parameter list doesn't have is flagged before saving
    await expect(box.locator('#mqtt-unknown')).toHaveText("Not in this inverter's parameter list: nosuchvalue");
    // The help text shows real angle brackets, not HTML entities
    await expect(box).toContainText('<prefix>/<name>');
    await box.locator('#mqtt-save').click();
    await expect(box.getByRole('status')).toContainText('Saved');

    let st = await mock.state();
    expect(st.mqtt).toMatchObject({ host: 'homeassistant.local', port: 1884, user: 'ha', pass: 's3cret pass',
      names: 'udc,tmphs,nosuchvalue', interval: 10, enabled: false });
    // The device reports only that a password is stored
    const cfg = await (await fetch(mock.url + '/mqtt')).json();
    expect(cfg.pass).toBeUndefined();
    expect(cfg.pass_set).toBe(true);
    await expect(box.locator('#mqtt-pass')).toHaveValue('');
    await expect(box.locator('#mqtt-pass')).toHaveAttribute('placeholder', /stored/);

    // Enabling saves at once; a blank password field keeps the stored one
    await box.locator('label.toggle-row', { hasText: 'Publish to MQTT' }).click();
    await expect.poll(async () => (await mock.state()).mqtt.enabled).toBe(true);
    expect((await mock.state()).mqtt.pass).toBe('s3cret pass');

    await setStatus(mock, { connected: true, publish_count: 42, last_publish_age: 3, unknown: ['nosuchvalue'] });
    await expect(box.locator('#mqtt-status')).toContainText('Connected', { timeout: 8000 });
    await expect(box.locator('#mqtt-status')).toContainText('42 values published');
    await expect(box.locator('#mqtt-status')).toContainText('Not found on the inverter: nosuchvalue');

    // Removing the stored password
    await box.locator('#mqtt-pass-clear').check();
    await box.locator('#mqtt-save').click();
    await expect.poll(async () => (await mock.state()).mqtt.pass).toBe('');
    await page.reload(); await gotoTab(page, 'Settings');
    await expect(box.locator('#mqtt-host')).toHaveValue('homeassistant.local');
    await expect(box.locator('#mqtt-pass')).toHaveAttribute('placeholder', 'optional');
  });

  test('a failed connection shows its reason', async ({ page, mock }) => {
    await fetch(mock.url + '/mqtt', { method: 'POST', body: new URLSearchParams({ enabled: '1', host: '10.0.0.9' }) });
    await setStatus(mock, { connected: false, last_error: 'bad username or password' });
    await openApp(page, mock); await gotoTab(page, 'Settings');
    await expect(page.locator('#mqtt-status .pill')).toHaveText('bad username or password');
  });

  test('a viewer sees the status but not the settings, and the device refuses them', async ({ page, mock }) => {
    await fetch(mock.url + '/__test/add-user?name=admin&password=admin-pass-1&role=admin');
    await fetch(mock.url + '/__test/add-user?name=vera&password=viewer-pass&role=viewer');
    await signInBrowser(page, mock, 'vera', 'viewer-pass');
    await openApp(page, mock); await gotoTab(page, 'Settings');
    const box = page.locator('#mqtt-box');
    await expect(box.locator('#mqtt-status')).toContainText('Off');
    await expect(box.locator('#mqtt-host')).toHaveCount(0);
    const cookie = (await page.context().cookies()).map(c => c.name + '=' + c.value).join('; ');
    expect((await fetch(mock.url + '/mqtt', { headers: { Cookie: cookie } })).status).toBe(403);
    expect((await fetch(mock.url + '/mqtt/status', { headers: { Cookie: cookie } })).status).toBe(200);
  });

  test('reset settings clears the MQTT setup', async ({ mock }) => {
    await fetch(mock.url + '/mqtt', { method: 'POST', body: new URLSearchParams({ host: 'broker', pass: 'x' }) });
    await fetch(mock.url + '/settings?reset_settings=1', { method: 'POST' });
    expect((await mock.state()).mqtt).toMatchObject({ host: '', pass: '', enabled: false });
  });
});
