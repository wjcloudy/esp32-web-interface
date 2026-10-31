import { test, expect, openApp, gotoTab } from './fixtures.mjs';

// The syncofs tuner (data/syncofs.html): a standalone page on the inverter.js
// bridge. Its knobs were jQuery Knob, which 404'd after the v4 rewrite and
// left nothing to turn; and its manualid knob sent `set syncofs`.

async function openTuner(page, mock, { foc = true, syncofs = 0 } = {}) {
  if (foc) await fetch(mock.url + '/__test/foc');
  if (syncofs) await mock.call('/cmd?cmd=' + encodeURIComponent('set syncofs ' + syncofs));
  const missing = [];
  page.on('response', r => { if (r.status() >= 400) missing.push(r.status() + ' ' + r.url()); });
  await page.goto(mock.url + '/syncofs.html');
  return missing;
}

const knob = (page, name) => page.locator('#' + name + ' svg[role=slider]');
const input = (page, name) => page.locator('#' + name + ' input');
const sets = async (mock) => (await mock.commands()).filter(c => c.startsWith('set '));

test.describe('Syncofs tuner', () => {
  test('renders both knobs and the graph, starting from the inverter values', async ({ page, mock }) => {
    const missing = await openTuner(page, mock, { syncofs: 12340 });
    await expect(knob(page, 'syncofs')).toBeVisible();
    await expect(knob(page, 'manualid')).toBeVisible();
    await expect(knob(page, 'syncofs')).toHaveAttribute('aria-disabled', 'false');
    await expect(knob(page, 'syncofs')).toHaveAttribute('aria-valuenow', '12340');
    await expect(knob(page, 'manualid')).toHaveAttribute('aria-valuenow', '0');
    await expect(page.locator('#syncofsChart')).toBeVisible();
    await expect(page.locator('#rd-opmode')).toHaveText('Off');
    await expect(page.locator('#notrunning')).toBeVisible();
    expect(missing).toEqual([]);
    // Fits a phone: no sideways scroll
    await page.setViewportSize({ width: 375, height: 800 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  });

  test('each knob sets its own parameter', async ({ page, mock }) => {
    await openTuner(page, mock, { syncofs: 1000 });
    await expect(knob(page, 'syncofs')).toHaveAttribute('aria-valuenow', '1000');

    // syncofs: typed value, then arrow keys and the mouse wheel (step 10)
    await input(page, 'syncofs').fill('1500');
    await input(page, 'syncofs').press('Enter');
    await expect.poll(() => sets(mock)).toContain('set syncofs 1500');
    await knob(page, 'syncofs').focus();
    await page.keyboard.press('ArrowUp');
    await expect.poll(() => sets(mock)).toContain('set syncofs 1510');
    await knob(page, 'syncofs').hover();
    await page.mouse.wheel(0, -100);
    await expect.poll(() => sets(mock)).toContain('set syncofs 1520');
    expect((await mock.state()).inverter.params.syncofs.value).toBe(1520);

    // manualid: typed, arrow keys, and a drag from the dial's start
    await input(page, 'manualid').fill('5');
    await input(page, 'manualid').press('Enter');
    await expect.poll(() => sets(mock)).toContain('set manualid 5');
    // ...and reads the speed it causes, for the graph
    await expect.poll(async () => (await mock.commands()).slice(-3)).toContain('get speed');
    await knob(page, 'manualid').focus();
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => sets(mock)).toContain('set manualid 4');

    const b = await knob(page, 'manualid').boundingBox();
    const cx = b.x + b.width / 2, cy = b.y + b.height / 2, r = b.width * 0.43;
    const at = (deg) => [cx + r * Math.sin(deg * Math.PI / 180), cy - r * Math.cos(deg * Math.PI / 180)];
    await page.mouse.move(...at(-130));
    await page.mouse.down();
    await page.mouse.move(...at(-120), { steps: 4 }); // 15° of 270° → 6 A
    await page.mouse.up();
    await expect.poll(() => sets(mock)).toContain('set manualid 6');
    expect((await mock.state()).inverter.params.manualid.value).toBe(6);

    // Nothing ever went to the wrong parameter
    const all = await sets(mock);
    expect(all.filter(c => c.startsWith('set syncofs ')).map(c => +c.split(' ')[2])).toEqual([1000, 1500, 1510, 1520]);
    expect(all.filter(c => c.startsWith('set manualid '))).toEqual(['set manualid 5', 'set manualid 4', 'set manualid 6']);
    await expect(page.locator('#lastcmd')).toHaveText('set manualid 6 → Set OK');
  });

  test('refuses hard jumps; a manualid jump zeroes the current', async ({ page, mock }) => {
    await openTuner(page, mock, { syncofs: 2000 });
    await expect(knob(page, 'syncofs')).toHaveAttribute('aria-valuenow', '2000');

    await input(page, 'syncofs').fill('40000');
    await input(page, 'syncofs').press('Enter');
    await expect(page.locator('#text_slowdown')).toBeVisible();
    await expect(knob(page, 'syncofs')).toHaveAttribute('aria-valuenow', '2000');

    await input(page, 'manualid').fill('8');
    await input(page, 'manualid').press('Enter');
    await expect.poll(() => sets(mock)).toContain('set manualid 8');
    await input(page, 'manualid').fill('50');
    await input(page, 'manualid').press('Enter');
    await expect.poll(async () => (await sets(mock)).slice(-1)[0]).toBe('set manualid 0');
    await expect(knob(page, 'manualid')).toHaveAttribute('aria-valuenow', '0');
    const all = await sets(mock);
    expect(all).not.toContain('set syncofs 40000');
    expect(all).not.toContain('set manualid 50');

    // The zero button always sends
    await input(page, 'manualid').fill('3');
    await input(page, 'manualid').press('Enter');
    await expect.poll(() => sets(mock)).toContain('set manualid 3');
    await page.locator('#zero').click();
    await expect.poll(async () => (await mock.state()).inverter.params.manualid.value).toBe(0);
  });

  test('says so on firmware without syncofs (sine build)', async ({ page, mock }) => {
    await openTuner(page, mock, { foc: false });
    await expect(page.locator('#nofoc')).toBeVisible();
    await expect(knob(page, 'syncofs')).toHaveAttribute('aria-disabled', 'true');
    await expect(input(page, 'manualid')).toBeDisabled();
  });

  test('is reachable from the Parameters page', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Parameters');
    await expect(page.locator('a[href="/syncofs.html"]')).toBeVisible();
  });
});
