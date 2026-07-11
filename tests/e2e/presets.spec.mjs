import { test, expect, openApp, gotoTab } from './fixtures.mjs';

// Parameter presets: named name->value sets stored in presets.json,
// applied from the Parameters rail or an Apply-preset action tile.
const seedPresets = (mock, presets) =>
  fetch(mock.url + '/__test/put-file?name=presets.json', { method: 'POST', body: JSON.stringify({ v: 1, presets }) });

test.describe('Parameter presets', () => {
  test('create a preset in the editor and persist it to the device', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Parameters');
    await page.locator('button', { hasText: 'New preset' }).click();
    const modal = page.locator('.modal-content');
    await modal.locator('input[maxlength="24"]').fill('Track day');
    // Add one param via the picker; its live value (67) prefills, then edit it
    await modal.locator('div', { hasText: /^Select\.\.\.$/ }).last().click();
    await modal.locator('.hover-row', { hasText: 'fweak' }).last().click();
    const valInput = modal.locator('input[type="number"]').first();
    await expect(valInput).toHaveValue('67');
    await valInput.fill('72');
    await modal.locator('button', { hasText: 'Save preset' }).click();
    // Row appears in the rail and the file landed on the device
    await expect(page.locator('.preset-row', { hasText: 'Track day' })).toBeVisible();
    await expect.poll(async () => (await mock.state()).files).toContain('presets.json');
    const saved = await fetch(mock.url + '/presets.json').then(r => r.json());
    expect(saved.presets[0].params).toEqual({ fweak: 72 });
  });

  test('apply a preset with progress, rejection reporting, and optional flash save declined', async ({ page, mock }) => {
    await seedPresets(mock, [{ id: 1, name: 'Track', params: { fweak: 72, doesnotexist: 5 } }]);
    await openApp(page, mock);
    await gotoTab(page, 'Parameters');
    const dialogs = [];
    page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
    // Plain Apply: live-only, never touches flash
    await page.locator('.preset-row', { hasText: 'Track' }).locator('button', { hasText: /^Apply$/ }).click();
    await expect.poll(() => dialogs.length, { timeout: 15000 }).toBeGreaterThanOrEqual(2);
    expect(dialogs[0]).toContain('Apply preset "Track" (2 parameters)');
    expect(dialogs[1]).toContain('Applied 1 of 2');
    expect(dialogs[1]).toContain('doesnotexist');
    expect(await mock.commands()).toContain('set fweak 72');
    expect((await mock.state()).inverter.params.fweak.value).toBe(72);
    expect((await mock.commands()).filter(c => c === 'save')).toEqual([]);
  });

  test('Apply & save applies then saves to flash', async ({ page, mock }) => {
    await seedPresets(mock, [{ id: 1, name: 'Street', params: { fweak: 70 } }]);
    await openApp(page, mock);
    await gotoTab(page, 'Parameters');
    const dialogs = [];
    page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
    await page.locator('.preset-row', { hasText: 'Street' }).locator('button', { hasText: 'Apply & save' }).click();
    await expect.poll(async () => await mock.commands(), { timeout: 15000 }).toContain('save');
    expect(await mock.commands()).toContain('set fweak 70');
    expect(dialogs[dialogs.length - 1]).toContain('Saved to flash');
  });

  test('changed-from-default captures exactly the tuned parameters', async ({ page, mock }) => {
    // Tune one param away from its default before the app loads
    await fetch(mock.url + '/cmd?cmd=' + encodeURIComponent('set fweak 80'));
    await openApp(page, mock);
    await gotoTab(page, 'Parameters');
    await page.locator('button', { hasText: 'New preset' }).click();
    const modal = page.locator('.modal-content');
    await modal.locator('button', { hasText: 'Add changed-from-default' }).click();
    // Only fweak (80 vs default 67) counts — the mock's Set_Hour also differs
    // from its default, but clock settings are excluded from the capture
    await expect(modal).toContainText('1 parameter(s)');
    await expect(modal).toContainText('fweak');
    await expect(modal).not.toContainText('Set_Hour');
    await expect(modal.locator('input[type="number"]').first()).toHaveValue('80');
  });

  test('Apply-preset action tile fires the whole set from a gauges page', async ({ page, mock }) => {
    await seedPresets(mock, [{ id: 3, name: 'Valet', params: { potmin: 100, fweak: 60 } }]);
    const layout = { v: 3, pages: [{ id: 1, name: 'Main', items: [
      { id: 1, type: 'action', act: 'preset', presetId: 3, label: 'Valet mode', confirm: false, x: 0, y: 0, w: 3, h: 1 },
    ] }] };
    await fetch(mock.url + '/__test/put-file?name=gauges.json', { method: 'POST', body: JSON.stringify(layout) });
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    const btn = page.locator('.action-tile-btn', { hasText: 'Valet mode' });
    await btn.click();
    await expect(btn).toHaveClass(/ok/, { timeout: 10000 });
    const cmds = await mock.commands();
    expect(cmds).toContain('set potmin 100');
    expect(cmds).toContain('set fweak 60');
    expect((await mock.state()).inverter.params.potmin.value).toBe(100);
  });

  test('settings export bundles the presets', async ({ page, mock }) => {
    await seedPresets(mock, [{ id: 1, name: 'Track', params: { fweak: 72 } }]);
    await openApp(page, mock);
    await gotoTab(page, 'Settings');
    await page.locator('#settings-subtabs .page-pill', { hasText: 'Web Interface' }).click();
    const dlPromise = page.waitForEvent('download');
    await page.locator('button', { hasText: 'Export settings' }).click();
    const dl = await dlPromise;
    const chunks = [];
    for await (const c of await dl.createReadStream()) chunks.push(c);
    const bundle = JSON.parse(Buffer.concat(chunks).toString());
    expect(bundle.presets.presets[0]).toEqual({ id: 1, name: 'Track', params: { fweak: 72 } });
  });
});
