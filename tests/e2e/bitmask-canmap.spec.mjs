import { test, expect, openApp, gotoTab } from './fixtures.mjs';

// Forum feedback: bitmask enums (status, pinswap), a quieter unsaved-changes
// bar, the Parameter Database submit, and the device's CAN mappings in UART
// mode.

const cmd = (mock, c) => fetch(mock.url + '/cmd?cmd=' + encodeURIComponent(c)).then(r => r.text());

test.describe('Bitmask enums', () => {
  test('status shows its combined flags in Spot Values and on the dashboard', async ({ page, mock }) => {
    await mock.setSpot('status', 4 | 32 | 128); // UdcBelowUdcSw, MProt, TmpHs
    await openApp(page, mock);
    await expect(page.locator('#dashboard .hero-sub')).toContainText('UdcBelowUdcSw|MProt|TmpHs');
    await gotoTab(page, 'Spot Values');
    const row = page.locator('#spotValues tr', { hasText: 'status' });
    await expect(row.locator('.sv-val')).toHaveText('UdcBelowUdcSw|MProt|TmpHs');
    // The flags take the empty sparkline and unit cells too, instead of
    // squeezing into the fixed value column
    expect(Number(await row.locator('.sv-val').getAttribute('colspan'))).toBeGreaterThanOrEqual(2);
    // the top of the tester's list, not a shorter hard-coded one
    await mock.setSpot('status', 8192 | 1024);
    await expect(row.locator('.sv-val')).toHaveText('CanCrc|HwShutdown');
  });

  test('a plain enum with an unlisted value shows the number, not made-up flags', async ({ page, mock }) => {
    await mock.setSpot('opmode', 9); // 0..7 listed; 9 isn't 1|8
    await openApp(page, mock);
    await gotoTab(page, 'Spot Values');
    await expect(page.locator('#spotValues tr', { hasText: 'opmode' }).locator('.sv-val')).toHaveText('9');
  });

  test('a bitmask parameter lists its set flags and edits them as checkboxes', async ({ page, mock }) => {
    expect(await cmd(mock, 'set pinswap 5')).toBe('Set OK');
    await openApp(page, mock);
    await gotoTab(page, 'Parameters');
    const row = page.locator('#params tr', { hasText: 'pinswap' });
    await expect(row.locator('select')).toHaveCount(0);
    const sum = row.locator('.bitmask-sum');
    await expect(sum).toContainText('CurrentSensor12|PWMOutput13');
    await sum.click();
    const flags = row.locator('.bitmask-flag');
    await expect(flags).toHaveCount(4);
    await expect(flags.filter({ hasText: 'CurrentSensor12' }).locator('input')).toBeChecked();
    await expect(flags.filter({ hasText: 'Encoder/Resolver' }).locator('input')).not.toBeChecked();
    await flags.filter({ hasText: 'Encoder/Resolver' }).locator('input').click(); // flips once the inverter takes it
    await expect.poll(async () => await mock.commands()).toContain('set pinswap 7');
    await expect(sum).toContainText('CurrentSensor12|Encoder/Resolver|PWMOutput13');
    await flags.filter({ hasText: 'CurrentSensor12' }).locator('input').click();
    await expect.poll(async () => (await mock.state()).inverter.params.pinswap.value).toBe(6);
    // an ordinary enum keeps its dropdown
    await expect(page.locator('#params tr', { hasText: 'dirmode' }).locator('select')).toHaveCount(1);
  });
});

test.describe('Unsaved changes bar', () => {
  test('is a slim strip with Save and Restore that folds into a pill for the session', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Parameters');
    const input = page.locator('#params tr', { hasText: 'fweak' }).locator('input[type="number"]');
    await input.fill('70');
    await input.press('Enter');
    const bar = page.locator('#savebar');
    await expect(bar).toContainText('1 unsaved change');
    expect((await bar.boundingBox()).height).toBeLessThan(44);
    await expect(bar.locator('button', { hasText: 'Save' })).toBeVisible();
    await expect(bar.locator('button', { hasText: 'Restore' })).toBeVisible();
    await bar.locator('.savebar-hide').click();
    // Folded: still says changes are pending, but no buttons in the way
    await expect(bar.locator('.savebar-pill')).toHaveText('1 unsaved');
    await expect(bar.locator('button', { hasText: 'Restore' })).toHaveCount(0);
    // ...and stays folded for the session
    await page.reload();
    await gotoTab(page, 'Parameters');
    await input.fill('71');
    await input.press('Enter');
    await expect(page.locator('#savebar .savebar-pill')).toHaveText('1 unsaved');
    await page.locator('#savebar .savebar-pill').click();
    await page.locator('#savebar button', { hasText: 'Save' }).click();
    await expect.poll(async () => await mock.commands()).toContain('save');
    await expect(page.locator('#savebar')).toHaveCount(0);
  });

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
    test('stays one short line', async ({ page, mock }) => {
      await openApp(page, mock);
      await gotoTab(page, 'Parameters');
      const input = page.locator('#params tr', { hasText: 'fweak' }).locator('input[type="number"]');
      await input.fill('70');
      await input.press('Enter');
      const bar = page.locator('#savebar');
      await expect(bar).toContainText('1 unsaved change');
      expect((await bar.boundingBox()).height).toBeLessThan(36);
      await expect(bar.locator('.savebar-sub')).toBeHidden();
    });
  });
});

test.describe('Parameter Database submit', () => {
  test('posts the json as the multipart field "data" to api.php in a new tab', async ({ page, mock }) => {
    // Never reach the real openinverter.org: capture the post and answer it
    const posts = [];
    await page.context().route('https://openinverter.org/**', route => {
      const req = route.request();
      posts.push({ method: req.method(), url: req.url(), body: req.postData() || '', type: req.headers()['content-type'] || '' });
      route.fulfill({ status: 200, contentType: 'text/html', body: '<p>received</p>' });
    });
    await openApp(page, mock);
    await gotoTab(page, 'Parameters');
    await page.locator('#parameters button', { hasText: 'Submit parameters' }).click();
    const modal = page.locator('#submit-db-modal-overlay');
    await expect(modal).toContainText('may no longer accept submissions');
    await expect(modal.locator('a[download="params.json"]')).toHaveCount(1); // the fallback
    const popup = page.waitForEvent('popup');
    await modal.locator('#submit-db-go').click();
    await (await popup).waitForLoadState();
    expect(posts).toHaveLength(1);
    expect(posts[0].method).toBe('POST');
    expect(posts[0].url).toBe('https://openinverter.org/parameters/api.php');
    expect(posts[0].type).toContain('multipart/form-data');
    expect(posts[0].body).toContain('name="data"');
    const json = JSON.parse(posts[0].body.split('\r\n\r\n')[1].split('\r\n')[0]);
    expect(json.fweak.value).toBe(67);
    expect(json.udc.isparam).toBe(false);
    expect(json.fweak.enums).toBeUndefined(); // the UI's own fields stay behind
    await expect(modal).toHaveCount(0);
  });
});

test.describe('CAN mappings in UART mode', () => {
  test('lists the inverter\'s can print output and removes a mapping by name', async ({ page, mock }) => {
    expect(await cmd(mock, 'can tx udc 257 0 16 1')).toContain('CAN map successful');
    expect(await cmd(mock, 'can rx pot 512 8 12 2')).toContain('CAN map successful');
    await openApp(page, mock);
    await gotoTab(page, 'CAN Mapping');
    await expect.poll(async () => await mock.commands()).toContain('can print');
    const tx = page.locator('#canmapping tr', { hasText: 'udc' });
    await expect(tx).toContainText('0x101');
    const rx = page.locator('#canmapping tr', { hasText: 'pot' }).first();
    await expect(rx).toContainText('0x200');
    await expect(rx).toContainText('12');
    await tx.locator('button').click();
    await expect.poll(async () => await mock.commands()).toContain('can del udc');
    await expect(tx).toHaveCount(0);
    expect((await mock.state()).canMap.map(m => m.paramid)).toEqual([2007]);
  });

  test('says so when the inverter can\'t list them', async ({ page, mock }) => {
    await page.route(/\/cmd\?cmd=can(%20|\+)print/, route => route.fulfill({ status: 200, contentType: 'text/plain', body: 'Unknown command: can\r\n' }));
    await openApp(page, mock);
    await gotoTab(page, 'CAN Mapping');
    await expect(page.locator('#canmap-error')).toContainText('did not list its CAN mappings');
    await expect(page.locator('#canmapping')).not.toContainText('No mappings configured on the device.');
  });
});
