import { test, expect, openApp, gotoTab } from './fixtures.mjs';

// The full parameter set the mock knows, in the app's own export format
const EXPORTED_PARAMS = {
  fweak: { unit: 'Hz', value: 72.5, isparam: true },
  udcmin: { unit: 'V', value: 460, isparam: true },
  potmin: { unit: 'dig', value: 10, isparam: true },
};

test.describe('Parameters tab', () => {
  test('renders the parameter table with schema columns', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Parameters');
    const row = page.locator('#params tr', { hasText: 'fweak' });
    await expect(row).toContainText('67'); // value
    await expect(row).toContainText('Hz'); // unit
    await expect(row).toContainText('400'); // max
    await expect(page.locator('#params')).toContainText('Motor (sine)'); // category header
  });

  test('editing a value sends set to the inverter and updates the UI', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Parameters');
    const row = page.locator('#params tr', { hasText: 'fweak' });
    await row.locator('td').nth(3).locator('span').click(); // value cell
    const input = row.locator('input[type="number"]');
    await input.fill('72');
    await input.press('Enter');
    await expect(row).toContainText('72');
    expect(await mock.commands()).toContain('set fweak 72');
    expect((await mock.state()).inverter.params.fweak.value).toBe(72);
  });

  test('enum parameters edit via dropdown', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Parameters');
    const row = page.locator('#params tr', { hasText: 'dirmode' });
    await row.locator('select').selectOption({ label: 'DefaultForward' });
    // selectOption -> onchange -> async set; poll rather than check immediately
    await expect.poll(async () => await mock.commands()).toContain('set dirmode 4');
  });

  test('search filters the table', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Parameters');
    await page.locator('#parameters input[placeholder="Search parameters..."]').fill('udc');
    await expect(page.locator('#params tr', { hasText: 'udcmin' })).toBeVisible();
    await expect(page.locator('#params tr', { hasText: 'fweak' })).toHaveCount(0);
  });

  test('save/restore flash buttons send save and load', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Parameters');
    page.on('dialog', d => d.accept());
    await page.locator('button', { hasText: 'Save parameters to flash' }).click();
    await page.locator('button', { hasText: 'Restore parameters from flash' }).click();
    await expect.poll(async () => await mock.commands()).toContain('save');
    await expect.poll(async () => await mock.commands()).toContain('load');
  });

  test('download link exports the full parameter set as JSON', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Parameters');
    const href = await page.locator('a[download="params.json"]').getAttribute('href');
    const parsed = JSON.parse(decodeURIComponent(href.replace('data:text/json;charset=utf-8,', '')));
    expect(parsed.fweak.value).toBe(67);
    expect(parsed.fweak.isparam).toBe(true);
  });

  test('load parameters from file applies every value with progress and summary', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Parameters');
    const dialogs = [];
    page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
    await page.locator('#paramfile').setInputFiles({
      name: 'params.json', mimeType: 'application/octet-stream', // Android-style mime
      buffer: Buffer.from(JSON.stringify(EXPORTED_PARAMS)),
    });
    // Confirm prompt, then a summary alert once every set has been applied
    await expect.poll(() => dialogs.length, { timeout: 15000 }).toBeGreaterThanOrEqual(2);
    expect(dialogs[0]).toContain('Apply 3 parameters');
    expect(dialogs[1]).toContain('Applied 3 of 3');
    const cmds = await mock.commands();
    expect(cmds).toContain('set fweak 72.5');
    expect(cmds).toContain('set udcmin 460');
    expect(cmds).toContain('set potmin 10');
    // The inverter model actually changed
    const inv = (await mock.state()).inverter.params;
    expect(inv.fweak.value).toBe(72.5);
    // And the UI refreshed to show the new values
    await expect(page.locator('#params tr', { hasText: 'fweak' })).toContainText('72.5');
  });

  test('load parameters accepts a flat name->value map and reports rejections', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Parameters');
    const dialogs = [];
    page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
    await page.locator('#paramfile').setInputFiles({
      name: 'flat.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ fweak: 80, doesnotexist: 5 })),
    });
    await expect.poll(() => dialogs.length, { timeout: 15000 }).toBeGreaterThanOrEqual(2);
    // The inverter rejected the unknown name — the summary must say so
    // instead of counting every non-throw as applied
    expect(dialogs[1]).toContain('Applied 1 of 2');
    expect(dialogs[1]).toContain('doesnotexist');
    expect(await mock.commands()).toContain('set fweak 80');
  });

  test('an out-of-range edit is rejected and the old value kept', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Parameters');
    const dialogs = [];
    page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
    const row = page.locator('#params tr', { hasText: 'fweak' });
    await row.locator('td').nth(3).locator('span').click();
    const input = row.locator('input[type="number"]');
    await input.fill('900'); // fweak max is 400
    await input.press('Enter');
    // Reply "Value out of range" surfaces as an alert; the table keeps 67
    await expect.poll(() => dialogs.length).toBeGreaterThanOrEqual(1);
    expect(dialogs[0]).toContain('out of range');
    await expect(row).toContainText('67');
    expect((await mock.state()).inverter.params.fweak.value).toBe(67);
  });

  test('invalid file shows an error and applies nothing', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Parameters');
    const dialogs = [];
    page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
    await page.locator('#paramfile').setInputFiles({
      name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('not json {'),
    });
    await expect.poll(() => dialogs.length).toBeGreaterThanOrEqual(1);
    expect(dialogs[0]).toContain('Could not read parameter file');
    expect((await mock.commands()).filter(c => c.startsWith('set '))).toEqual([]);
  });

  test('favorite star toggles favourites-only filtering', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Parameters');
    const star = page.locator('#params tr', { hasText: 'fweak' }).locator('td').first();
    await star.click();
    await expect(star).toHaveText('★');
    // showFavoritesOnly defaults to on, so starring immediately filters the table
    await expect(page.locator('#params tr', { hasText: 'fweak' })).toBeVisible();
    await expect(page.locator('#params tr', { hasText: 'udcmin' })).toHaveCount(0);
    // ...and the favourites-only toggle brings the full list back
    await page.locator('.toggle-row', { hasText: '★ Favorites only' }).locator('.slider').click();
    await expect(page.locator('#params tr', { hasText: 'udcmin' })).toBeVisible();
    // Favourites were persisted to the device
    await expect.poll(async () => (await mock.state()).files).toContain('favorites.json');
  });
});
