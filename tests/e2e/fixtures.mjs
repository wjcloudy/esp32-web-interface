// Shared Playwright fixtures: each test gets its own mock ESP (random port,
// fully isolated state) plus a page that FAILS the test on any uncaught
// browser error — the strongest cheap net for a no-build global-scope app.
import { test as base, expect } from '@playwright/test';
import { createMockEsp } from '../mock-esp/server.mjs';

export const test = base.extend({
  mock: async ({}, use) => {
    const { server, url } = await createMockEsp();
    await use({
      url,
      commands: async () => (await fetch(url + '/__test/commands')).json(),
      state: async () => (await fetch(url + '/__test/state')).json(),
      setFwStatus: async (s) => fetch(url + '/__test/fw-status', { method: 'POST', body: JSON.stringify(s) }),
    });
    server.close();
  },
  page: async ({ page }, use) => {
    // Stub out the PWA service worker: on localhost (a secure context) it
    // registers, skipWaiting()s and clients.claim()s the page mid-load, which
    // intermittently aborts in-flight vendor script requests under parallel
    // test load (preact/preactHooks undefined). It does no caching, so it's
    // irrelevant to what these tests exercise. Real hardware is unaffected.
    await page.addInitScript(() => {
      // register() rejects (app swallows it with .catch) — no SW ever installs
      try {
        Object.defineProperty(navigator, 'serviceWorker', {
          configurable: true,
          get: () => ({ register: () => Promise.reject(new Error('sw disabled in tests')) }),
        });
      } catch (e) {}
    });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await use(page);
    expect(errors, 'uncaught page errors during test').toEqual([]);
  },
});

export { expect };

/** Navigate to the app and wait for the first parameter fetch to land. */
export async function openApp(page, mock) {
  await page.goto(mock.url);
  await expect(page.locator('.tablink', { hasText: 'Dashboard' })).toBeVisible();
  // App is live once the json poll has populated the store (navbar shows F/W version)
  await expect(page.locator('#version')).toContainText('Web: vMOCK');
}

export async function gotoTab(page, label) {
  await page.locator('.tablink', { hasText: label }).click();
}
