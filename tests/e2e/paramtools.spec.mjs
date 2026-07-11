import { test, expect, openApp, gotoTab } from './fixtures.mjs';

// Parameters-tab tooling: compare-to-file diff and the change log.
test.describe('Parameter tools', () => {
  test('compare-to-file shows a read-only diff and captures differences as a preset', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Parameters');
    // fweak differs (67 live vs 72), udcmin matches (450), notreal is file-only
    await page.locator('#comparefile').setInputFiles({
      name: 'trackday.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ fweak: 72, udcmin: 450, notreal: 5 })),
    });
    const modal = page.locator('.modal-content');
    await expect(modal).toContainText('1 value(s) differ, 1 match, 1 in the file only');
    await expect(modal).toContainText('Nothing has been applied');
    const row = modal.locator('#param-compare-table tr', { hasText: 'fweak' });
    await expect(row).toContainText('67');
    await expect(row).toContainText('72');
    // Comparing is read-only — no 'set' reached the inverter
    expect((await mock.commands()).filter(c => c.startsWith('set '))).toEqual([]);
    // Differences become a preset draft named after the file
    await modal.locator('button', { hasText: 'Save differences as preset' }).click();
    const editor = page.locator('.modal-content');
    await expect(editor.locator('input[maxlength="24"]')).toHaveValue('trackday');
    await expect(editor).toContainText('1 parameter(s)');
    await expect(editor).toContainText('fweak');
    await expect(editor.locator('input[type="number"]').first()).toHaveValue('72');
  });

  test('change log records UI sets, persists to the device, and clears', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Parameters');
    page.on('dialog', d => d.accept());
    // Edit fweak in the table (always-editable input; Enter commits)
    const input = page.locator('#params tr', { hasText: 'fweak' }).locator('input[type="number"]');
    await input.fill('71');
    await input.press('Enter');
    await expect.poll(async () => (await mock.state()).inverter.params.fweak.value).toBe(71);
    // The log modal shows the entry with its accepted tick
    await page.locator('button', { hasText: 'Change log' }).click();
    const modal = page.locator('.modal-content');
    const entry = modal.locator('#param-log-table tr', { hasText: 'fweak' });
    await expect(entry).toContainText('71');
    await expect(entry).toContainText('✓');
    // The debounced write lands on the device as paramlog.json
    await expect.poll(async () => (await mock.state()).files, { timeout: 6000 }).toContain('paramlog.json');
    const saved = await fetch(mock.url + '/paramlog.json').then(r => r.json());
    expect(saved.entries.some(e => e.name === 'fweak' && e.value === '71' && e.ok)).toBe(true);
    // Clearing empties both the view and the device file
    await modal.locator('button', { hasText: 'Clear log' }).click();
    await expect(modal).toContainText('No parameter changes recorded yet');
    await expect.poll(async () => (await fetch(mock.url + '/paramlog.json').then(r => r.json())).entries).toEqual([]);
  });
});
