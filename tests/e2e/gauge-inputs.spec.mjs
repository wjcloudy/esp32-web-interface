import { test, expect, openApp, gotoTab } from './fixtures.mjs';

// Tile settings fields keep what is typed: the gauge view re-renders on
// every poll and sample, which used to write the stored value back over a
// half-typed entry (a Figures list vanished mid-word, "0.5" became "50").

const saved = (mock) => fetch(mock.url + '/gauges.json').then(r => r.json());
// Type one key at a time with pauses long enough for polls to land between
const typeSlowly = async (page, text) => {
  for (const ch of text) { await page.keyboard.type(ch); await page.waitForTimeout(120); }
};

test.describe('Tile settings fields', () => {
  test('the status Figures list can be typed, and commits on blur', async ({ page, mock }) => {
    await openApp(page, mock);
    // A fast poll: a re-render lands between almost every keystroke
    await page.locator('.control', { hasText: 'Refresh' }).locator('select').selectOption('1000');
    await page.locator('button', { hasText: 'Edit Layout' }).click();
    await page.locator('#dashboard .gauge-tile.hero-card').click();
    const figs = page.locator('#status-figs');
    await figs.click();
    await typeSlowly(page, 'udc, tmphs,cpuload');
    await page.waitForTimeout(1200); // a poll while the field still has focus
    await expect(figs).toHaveValue('udc, tmphs,cpuload');
    await page.locator('.modal-content button', { hasText: 'Done' }).click();
    await page.locator('button', { hasText: 'Save & Done' }).click();
    await expect.poll(async () => (await saved(mock)).pages.find(p => p.items.some(g => g.type === 'status'))
      .items.find(g => g.type === 'status').figs).toEqual(['udc', 'tmphs', 'cpuload']);
  });

  test('Enter commits the Figures list and shows it normalised', async ({ page, mock }) => {
    await openApp(page, mock);
    await page.locator('button', { hasText: 'Edit Layout' }).click();
    await page.locator('#dashboard .gauge-tile.hero-card').click();
    const figs = page.locator('#status-figs');
    await figs.fill('');
    await figs.pressSequentially('udc  tmphs', { delay: 30 });
    await figs.press('Enter');
    await expect(figs).toHaveValue('udc, tmphs');
  });

  test('number fields take decimals, negatives and multi-digit entries', async ({ page, mock }) => {
    await mock.putFile('gauges.json', { v: 3, pages: [{ id: 1, name: 'Main', items: [
      { id: 1, name: 'udc', type: 'line', min: 0, max: 500, x: 0, y: 0, w: 4, h: 3 },
    ] }] });
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await page.locator('button', { hasText: 'Edit Layout' }).click();
    await page.locator('#gauges .gauge-tile').first().click();
    const min = page.locator('#gauge-min');
    const points = page.locator('.modal-content input[type=number][max="500"]');
    await min.fill('');
    await min.click();
    await typeSlowly(page, '-2.5');
    await expect(min).toHaveValue('-2.5');
    await points.fill('');
    await points.click();
    await typeSlowly(page, '100');
    await expect(points).toHaveValue('100'); // not clamped to 5 on the first digit, then "500"
    await page.locator('.modal-content button', { hasText: 'Done' }).click();
    await page.locator('button', { hasText: 'Save & Done' }).click();
    await expect.poll(async () => (await saved(mock)).pages.find(p => p.name === 'Main').items[0]).toMatchObject({ min: -2.5, points: 100 });
  });
});
