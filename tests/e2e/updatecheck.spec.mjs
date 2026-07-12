import { test, expect, openApp, gotoTab } from './fixtures.mjs';

// The once-a-day GitHub release check behind the navbar update badge.
// The fixtures abort real GitHub API traffic; these tests fulfil the
// /releases/latest route with scripted payloads instead.
const fulfillLatest = (page, body) =>
  page.route('https://api.github.com/repos/**/releases/latest', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }));

test.describe('Update availability badge', () => {
  test('a newer release shows the navbar badge; clicking opens the Update tab pre-loaded', async ({ page, mock }) => {
    await fulfillLatest(page, { tag_name: 'v99.1' });
    // The Update tab auto-loads the release LIST when a newer release is known
    await page.route(/api\.github\.com\/repos\/[^/]+\/[^/]+\/releases$/, route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
        { tag_name: 'v99.1', assets: [{ name: 'esp32_v99.1-ota.bin', browser_download_url: 'http://example.invalid/ota.bin' }] },
      ]) }));
    await openApp(page, mock);
    const badge = page.locator('#update-badge');
    await expect(badge).toBeVisible();
    await expect(badge).toContainText('v99.1');
    await badge.locator('span').click();
    await expect(page.locator('#update')).toBeVisible();
    // The newer-release note sits with the install controls, which are
    // already populated — no separate "check" step to repeat
    await expect(page.locator('#update-newer-note')).toContainText('v99.1');
    await expect(page.locator('#update select', { hasText: 'v99.1' }).first()).toBeVisible();
    await expect(page.locator('button', { hasText: 'Download & install' })).toBeVisible();
  });

  test('badge auto-load pre-selects THIS board\'s image, not the default target', async ({ page, mock }) => {
    // Regression: the auto-load promise captured the first render's target
    // (the esp32 default, before /otainfo answered), pre-selecting the wrong
    // board's image on an S3 — refused by the chip check only after a
    // full download
    await fetch(mock.url + '/__test/otainfo', { method: 'POST', body: JSON.stringify({ target: 'esp32s3' }) });
    await fulfillLatest(page, { tag_name: 'v99.1' });
    await page.route(/api\.github\.com\/repos\/[^/]+\/[^/]+\/releases$/, route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
        { tag_name: 'v99.1', assets: [
          { name: 'esp32_v99.1-ota.bin', browser_download_url: 'http://example.invalid/esp32-ota.bin' },
          { name: 'esp32s3_v99.1-ota.bin', browser_download_url: 'http://example.invalid/esp32s3-ota.bin' },
        ] },
      ]) }));
    await openApp(page, mock);
    await page.locator('#update-badge span').click();
    const assetSel = page.locator('#update select').nth(1); // release, then asset
    await expect(assetSel).toBeVisible();
    await expect(assetSel).toHaveValue('http://example.invalid/esp32s3-ota.bin');
    await expect(page.locator('#update')).toContainText('esp32s3_v99.1-ota.bin (this board)');
  });

  test('an existing board on the old target name still matches the renamed image', async ({ page, mock }) => {
    // Back-compat: a device flashed before the esp32_wemos/esp32_t2can ->
    // esp32/esp32s3 rename still reports the old target; it must map onto the
    // new asset prefix so it auto-selects the right board's image.
    await fetch(mock.url + '/__test/otainfo', { method: 'POST', body: JSON.stringify({ target: 'esp32_t2can' }) });
    await fulfillLatest(page, { tag_name: 'v99.1' });
    await page.route(/api\.github\.com\/repos\/[^/]+\/[^/]+\/releases$/, route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
        { tag_name: 'v99.1', assets: [
          { name: 'esp32_v99.1-ota.bin', browser_download_url: 'http://example.invalid/esp32-ota.bin' },
          { name: 'esp32s3_v99.1-ota.bin', browser_download_url: 'http://example.invalid/esp32s3-ota.bin' },
        ] },
      ]) }));
    await openApp(page, mock);
    await page.locator('#update-badge span').click();
    const assetSel = page.locator('#update select').nth(1);
    await expect(assetSel).toBeVisible();
    // old esp32_t2can -> esp32s3 asset
    await expect(assetSel).toHaveValue('http://example.invalid/esp32s3-ota.bin');
    await expect(page.locator('#update')).toContainText('esp32s3_v99.1-ota.bin (this board)');
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

  test('disabling the daily check stops all requests', async ({ page, mock }) => {
    let calls = 0;
    await page.route('https://api.github.com/repos/**/releases/latest', route => {
      calls++;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tag_name: 'v0.1' }) });
    });
    await openApp(page, mock);
    await expect.poll(() => calls).toBe(1); // the on-load daily check
    await gotoTab(page, 'Update');
    // Toggle the daily check off, clear the cache so a fresh load WOULD
    // check if it were still enabled, and reload: no request may fire
    await page.locator('.toggle-row', { hasText: 'Daily update check' }).locator('.slider').click();
    await page.evaluate(() => localStorage.removeItem('updateCheck'));
    await page.reload();
    await expect(page.locator('#version')).toContainText('Web: v0.1-mock');
    await page.waitForTimeout(800);
    expect(calls).toBe(1);
  });
});
