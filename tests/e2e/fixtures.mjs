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
