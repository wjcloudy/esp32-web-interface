import { test, expect, openApp, gotoTab } from './fixtures.mjs';

// The once-a-day GitHub release check behind the navbar update badge.
// The fixtures abort real GitHub API traffic; these tests fulfil the
// /releases/latest route with scripted payloads instead.
const fulfillLatest = (page, body) =>
  page.route('https://api.github.com/repos/**/releases/latest', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }));

test.describe('Update availability badge', () => {
  test('a newer release shows the navbar badge; clicking opens the Update tab', async ({ page, mock }) => {
    await fulfillLatest(page, { tag_name: 'v99.1' });
    await openApp(page, mock);
    const badge = page.locator('#update-badge');
    await expect(badge).toBeVisible();
    await expect(badge).toContainText('v99.1');
    await badge.locator('span').click();
    await expect(page.locator('#update')).toBeVisible();
  });

  test('a non-version tag from the API is discarded (XSS guard)', async ({ page, mock }) => {
    await fulfillLatest(page, { tag_name: '<img src=x onerror=alert(1)> v99.9' });
    await openApp(page, mock);
    await page.waitForTimeout(600);
    await expect(page.locator('#update-badge')).toHaveCount(0);
    // ...and nothing version-shaped was cached from it either
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('updateCheck') || '{}').tag)).toBeNull();
  });

  test('an equal-or-older release shows no badge', async ({ page, mock }) => {
    await fulfillLatest(page, { tag_name: 'v0.0' }); // mock runs v0.1-mock
    await openApp(page, mock);
    await page.waitForTimeout(600);
    await expect(page.locator('#update-badge')).toHaveCount(0);
  });

  test('offline check fails silently (no badge, no page errors)', async ({ page, mock }) => {
    // fixtures abort api.github.com by default — this is the offline path
    await openApp(page, mock);
    await page.waitForTimeout(600);
    await expect(page.locator('#update-badge')).toHaveCount(0);
  });

  test('dismiss hides the badge for that version, across reloads', async ({ page, mock }) => {
    await fulfillLatest(page, { tag_name: 'v99.1' });
    await openApp(page, mock);
    await page.locator('#update-badge button').click();
    await expect(page.locator('#update-badge')).toHaveCount(0);
    await page.reload();
    await expect(page.locator('#version')).toContainText('Web: v0.1-mock');
    await page.waitForTimeout(600);
    await expect(page.locator('#update-badge')).toHaveCount(0);
  });

  test('manual check reports up-to-date; disabling the auto check stops requests', async ({ page, mock }) => {
    let calls = 0;
    await page.route('https://api.github.com/repos/**/releases/latest', route => {
      calls++;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tag_name: 'v0.1' }) });
    });
    await openApp(page, mock);
    await gotoTab(page, 'Update');
    // Check now bypasses the daily cache; v0.1 equals the running version
    await page.locator('button', { hasText: 'Check for updates now' }).click();
    await expect(page.locator('#update')).toContainText('Up to date');
    // Toggle the daily check off, clear the cache so a fresh load WOULD
    // check if it were still enabled, and reload: no request may fire
    await page.locator('.toggle-row', { hasText: 'Check GitHub' }).locator('.slider').click();
    await page.evaluate(() => localStorage.removeItem('updateCheck'));
    const before = calls;
    await page.reload();
    await expect(page.locator('#version')).toContainText('Web: v0.1-mock');
    await page.waitForTimeout(800);
    expect(calls).toBe(before);
  });
});
