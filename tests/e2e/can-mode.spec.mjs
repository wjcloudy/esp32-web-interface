import { test, expect, openApp, gotoTab } from './fixtures.mjs';

// The UI against the firmware's CAN backend: /cmd answered by
// canExecuteCommand (tab-separated get, terse replies, can list JSON,
// json with "can_cache":true). The device is put in CAN mode before load,
// as a saved setting would be.

const cmd = (mock, c) => fetch(mock.url + '/cmd?cmd=' + encodeURIComponent(c)).then(r => r.text());

test.describe('CAN mode', () => {
  test.beforeEach(async ({ mock }) => { await mock.enableCan(); });

  test('dashboard shows the CAN link as connected and loads values from the CAN json', async ({ page, mock }) => {
    await openApp(page, mock);
    const pill = page.locator('aside span', { hasText: /^CAN #1$/ });
    await expect.poll(async () => pill.evaluate(el => el.style.background)).toContain('--green');
    await expect(page.locator('#dashboard')).toContainText('398.5');
    await gotoTab(page, 'Spot Values');
    await expect(page.locator('#spotValues tr', { hasText: 'udc' })).toContainText('398.5');
  });

  // Regression: the json's bare "can_cache":true marker used to become a spot value
  test('the can_cache marker does not show up as a spot value', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Spot Values');
    await expect(page.locator('#spotValues tr', { hasText: 'udc' })).toContainText('398.5');
    await expect(page.locator('#spotValues')).not.toContainText('can_cache');
  });

  test('a device without a param cache shows the CAN link as down', async ({ page, mock }) => {
    await fetch(mock.url + '/__test/can-cache?loaded=0');
    await page.goto(mock.url);
    await expect(page.locator('#version')).toContainText('Web: v0.1-mock');
    const pill = page.locator('aside span', { hasText: /^CAN #1$/ });
    await expect(pill).toBeVisible();
    // red until a json reply carries can_cache, then green on the next poll
    await expect.poll(async () => pill.evaluate(el => el.style.background)).toContain('--red');
    await fetch(mock.url + '/__test/can-cache?loaded=1');
    await expect.poll(async () => pill.evaluate(el => el.style.background), { timeout: 15000 }).toContain('--green');
  });

  test('parameter edits go out as CAN sets and rejections keep the old value', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Parameters');
    const input = page.locator('#params tr', { hasText: 'fweak' }).locator('input[type="number"]');
    await expect(input).toHaveValue('67');
    await input.fill('80');
    await input.press('Enter');
    await expect.poll(async () => (await mock.state()).inverter.params.fweak.value).toBe(80);
    expect(await mock.commands()).toContain('set fweak 80');
    // The CAN layer's SDO range abort comes back as "Value out of range"
    const dialogs = [];
    page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
    await input.blur();
    await input.fill('900');
    await input.press('Enter');
    await expect.poll(() => dialogs.length).toBeGreaterThanOrEqual(1);
    expect(dialogs[0]).toContain('out of range');
    await expect(input).toHaveValue('80');
    expect((await mock.state()).inverter.params.fweak.value).toBe(80);
  });

  test('save to flash uses the CAN save command and reports its reply', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Parameters');
    const alerts = [];
    page.on('dialog', d => { alerts.push(d.message()); d.accept(); });
    await page.locator('button', { hasText: 'Save parameters to flash' }).click();
    await expect.poll(() => alerts).toEqual(['saved']);
    expect(await mock.commands()).toContain('save');
  });

  test('spot-value favourites stream through fast CAN gets', async ({ page, mock }) => {
    await mock.putFile('favorites.json', { p: [], s: ['udc', 'tmphs'] });
    await openApp(page, mock);
    await gotoTab(page, 'Spot Values');
    await page.locator('#spotvalues .toggle-row', { hasText: '★ Favorites only' }).locator('.slider').click();
    await expect.poll(async () => await mock.commands()).toContain('get udc,tmphs');
    await mock.setSpot('udc', 222);
    await expect(page.locator('#spotValues tr', { hasText: 'udc' })).toContainText('222');
  });

  test('CAN Mapping tab lists device mappings from can list and removes one', async ({ page, mock }) => {
    expect(await cmd(mock, 'can tx udc 257 0 16 1')).toBe('ok');
    expect(await cmd(mock, 'can rx pot 512 8 12 1')).toBe('ok');
    await openApp(page, mock);
    await gotoTab(page, 'CAN Mapping');
    const tx = page.locator('#canmapping tr', { hasText: 'udc' });
    await expect(tx).toContainText('0x101');
    await expect(page.locator('#canmapping tr', { hasText: 'pot' }).first()).toContainText('0x200');
    await tx.locator('button').click();
    await expect.poll(async () => await mock.commands()).toContain('can rm 12544 1');
    await expect(tx).toHaveCount(0);
    expect((await mock.state()).canMap.map(m => m.paramid)).toEqual([2007]);
  });

  test('a new mapping is sent as can tx with its bias and saved', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'CAN Mapping');
    await expect(page.locator('#canmapping')).toContainText('No mappings configured on the device.');
    await page.locator('#canmapping button', { hasText: 'Add new mapping' }).click();
    const row = page.locator('#canmapping tbody tr').last();
    await row.locator('select').first().selectOption('tmphs');
    await row.locator('input[type="text"]').fill('0x250');
    await row.locator('input[type="number"]').nth(1).fill('16');
    // Bias is the last field; 5.39 inverters reject a can tx line without it
    await row.locator('input[type="number"]').nth(3).fill('-40');
    page.on('dialog', d => d.accept());
    await page.locator('#canmapping button', { hasText: 'Save mappings to flash' }).click();
    await expect.poll(async () => await mock.commands()).toContain('can tx tmphs 592 0 16 1 -40');
    await expect.poll(async () => await mock.commands()).toContain('save');
    await expect(page.locator('#canmapping tr', { hasText: 'tmphs' }).first()).toContainText('0x250');
    await expect(page.locator('#canmapping tr', { hasText: 'tmphs' }).first()).toContainText('-40');
  });

  test('a new mapping left at the default bias still sends it', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'CAN Mapping');
    await page.locator('#canmapping button', { hasText: 'Add new mapping' }).click();
    const row = page.locator('#canmapping tbody tr').last();
    await row.locator('select').first().selectOption('tmphs');
    await row.locator('input[type="text"]').fill('0x250');
    page.on('dialog', d => d.accept());
    await page.locator('#canmapping button', { hasText: 'Save mappings to flash' }).click();
    await expect.poll(async () => await mock.commands()).toContain('can tx tmphs 592 0 8 1 0');
  });
});

// Nothing on the CAN Mapping page scrolls sideways at any window width: the
// edit rows are grids that wrap, and the device's mapping tables fit
const overflowing = page => page.evaluate(() => [document.documentElement, ...document.querySelectorAll('#canmapping *')]
  .filter(e => e.scrollWidth > e.clientWidth + 1 && (e === document.documentElement || ['auto', 'scroll'].includes(getComputedStyle(e).overflowX)))
  .map(e => e.tagName + '.' + e.className + ' ' + e.scrollWidth + '>' + e.clientWidth));
const fillRow = async (page) => {
  await page.locator('#canmapping button', { hasText: 'Add new mapping' }).click();
  const nums = page.locator('table.canmap-new').first().locator('tbody tr').last().locator('input[type="number"]');
  for (const [i, v] of ['63', '32', '0.0625', '-128'].entries()) await nums.nth(i).fill(v);
};

for (const width of [375, 520, 640, 760, 900, 1100, 1440]) {
  test.describe(`CAN Mapping at ${width}px`, () => {
    test.use(width < 600 ? { viewport: { width, height: 812 }, isMobile: true, hasTouch: true } : { viewport: { width, height: 800 } });

    test('UART: mappings and a new row fit the window', async ({ page, mock }) => {
      await cmd(mock, 'can tx udc 257 0 16 1 -7');
      await cmd(mock, 'can rx pot 512 8 12 2');
      await openApp(page, mock);
      await gotoTab(page, 'CAN Mapping');
      await expect(page.locator('#canmapping tr', { hasText: 'udc' })).toContainText('-7');
      await fillRow(page);
      await expect(page.locator('table.canmap-new td[data-label="Bias"] input')).toHaveValue('-128');
      expect(await overflowing(page)).toEqual([]);
    });

    test('CAN: virtual values fit the window too', async ({ page, mock }) => {
      await mock.enableCan();
      await mock.putFile('virtualvals.json', { items: [{ name: 'v_pack', unit: 'V', id: 0x355, pos: 0, len: 16, gain: 0.1, offset: 0, signed: true }] });
      await openApp(page, mock);
      await gotoTab(page, 'CAN Mapping');
      await expect(page.locator('#canmapping')).toContainText('Virtual spot values');
      await fillRow(page);
      expect(await overflowing(page)).toEqual([]);
    });
  });
}
