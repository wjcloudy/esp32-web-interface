import { test, expect, openApp, gotoTab } from './fixtures.mjs';

// URL breadcrumbs: #tab (and #gauges/<page>) make every view bookmarkable
test.describe('URL breadcrumbs', () => {
  test('opening #parameters lands on the Parameters tab', async ({ page, mock }) => {
    await page.goto(mock.url + '/#parameters');
    await expect(page.locator('#version')).toContainText('Web: vMOCK');
    await expect(page.locator('.tablink.active')).toHaveText(/Parameters/);
    await expect(page.locator('#params')).toBeVisible();
  });

  test('switching tabs updates the hash for bookmarking', async ({ page, mock }) => {
    await openApp(page, mock);
    // The default tab normalises the empty hash without a history entry
    await expect.poll(() => new URL(page.url()).hash).toBe('#dashboard');
    await gotoTab(page, 'Settings');
    await expect.poll(() => new URL(page.url()).hash).toBe('#settings');
  });

  test('browser back returns to the previous tab', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Spot Values');
    await gotoTab(page, 'Files');
    await page.goBack();
    await expect(page.locator('.tablink.active')).toHaveText(/Spot Values/);
  });

  test('#gauges/<page name> deep-links to that gauge page (case-insensitive)', async ({ page, mock }) => {
    const layout = { v: 3, pages: [
      { id: 1, name: 'Main', items: [] },
      { id: 2, name: 'Driving', items: [{ id: 1, name: 'speed', type: 'text', x: 0, y: 0, w: 2, h: 1 }] },
    ] };
    await fetch(mock.url + '/__test/put-file?name=gauges.json', { method: 'POST', body: JSON.stringify(layout) });
    await page.goto(mock.url + '/#gauges/driving');
    await expect(page.locator('.page-pill.active')).toHaveText('Driving');
  });

  test('switching gauge pages rewrites the hash without history spam', async ({ page, mock }) => {
    const layout = { v: 3, pages: [
      { id: 1, name: 'Main', items: [] },
      { id: 2, name: 'Debug', items: [] },
    ] };
    await fetch(mock.url + '/__test/put-file?name=gauges.json', { method: 'POST', body: JSON.stringify(layout) });
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await expect.poll(() => new URL(page.url()).hash).toBe('#gauges/Main');
    await page.locator('.page-pill', { hasText: 'Debug' }).click();
    await expect.poll(() => new URL(page.url()).hash).toBe('#gauges/Debug');
    // Page flips use replaceState: one back step leaves the gauges tab
    // entirely instead of unwinding every page visit
    await page.goBack();
    await expect(page.locator('.tablink.active')).toHaveText(/Dashboard/);
  });
});
