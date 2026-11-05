// Shared Playwright fixtures: each test gets its own mock ESP (random port,
// fully isolated state) plus a page that FAILS the test on any uncaught
// browser error — the strongest cheap net for a no-build global-scope app.
import { test as base, expect } from '@playwright/test';
import { URLSearchParams } from 'node:url';
import { createMockEsp } from '../mock-esp/server.mjs';

export const test = base.extend({
  mock: async ({}, use) => {
    const { close, url, ssePort } = await createMockEsp();
    await use({
      url,
      ssePort,
      commands: async () => (await fetch(url + '/__test/commands')).json(),
      state: async () => (await fetch(url + '/__test/state')).json(),
      setFwStatus: async (s) => fetch(url + '/__test/fw-status', { method: 'POST', body: JSON.stringify(s) }),
      /** Drive a spot value on the simulated inverter. */
      setSpot: async (name, value) => fetch(url + `/__test/spot?name=${name}&value=${value}`),
      /** Seed a SPIFFS file (string or object → JSON). */
      putFile: async (name, content) => fetch(url + '/__test/put-file?name=' + encodeURIComponent(name), {
        method: 'POST', body: typeof content === 'string' ? content : JSON.stringify(content),
      }),
      /** Switch the device into CAN mode before the page loads (as a saved setting). */
      enableCan: async () => fetch(url + '/settings?can_mode=1', { method: 'POST' }),
      /** SSE listener state: 'on', 'off' (port refuses connections), '404' or 'hang' (takes the connection, never answers). */
      setSse: async (mode) => fetch(url + '/__test/sse?mode=' + mode),
      /** Delay every reply (both ports) by `ms`: a client far away. */
      setLatency: async (ms) => fetch(url + '/__test/latency?ms=' + ms),
      /** A 'json' holds the simulated UART for `ms`; other commands and stream samples queue behind it. */
      setJsonCost: async (ms) => fetch(url + '/__test/uart?jsonMs=' + ms),
      /** Create an account directly (first one must be an admin). */
      addUser: async (name, password, role = 'viewer') => {
        const r = await fetch(url + '/__test/add-user?' + new URLSearchParams({ name, password, role }));
        if (!r.ok) throw new Error('addUser: ' + await r.text());
      },
      /** Move the mock's clock forward (session expiry). */
      advanceClock: async (ms) => fetch(url + '/__test/clock?advance=' + ms),
      /**
       * An HTTP call as a script would make it: { cookie, bearer, headers,
       * form (urlencoded body), body, csrf (default true: sends X-OI-Auth) }.
       */
      call: async (pathAndQuery, { method = 'GET', cookie, bearer, headers = {}, form, body, csrf = true } = {}) => {
        const h = { ...headers };
        if (cookie) h.Cookie = cookie;
        if (bearer) h.Authorization = 'Bearer ' + bearer;
        if (csrf) h['X-OI-Auth'] = '1';
        if (form) { h['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
        const r = await fetch(url + pathAndQuery, { method, headers: h, body, redirect: 'manual' });
        return { status: r.status, headers: r.headers, text: await r.text() };
      },
      /** Sign in over HTTP; returns { status, cookie ("oisess=..."), token }. */
      signIn: async (user, password, extra = {}) => {
        const r = await fetch(url + '/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-OI-Auth': '1' },
          body: new URLSearchParams({ user, password, ...extra }).toString(),
        });
        const sc = r.headers.get('set-cookie');
        return { status: r.status, cookie: sc ? sc.split(';')[0] : null, setCookie: sc, token: r.headers.get('x-oi-token'), retryAfter: r.headers.get('retry-after') };
      },
    });
    await close(); // also drops any open SSE stream, which would hold the server up
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
    // No test traffic ever reaches the real GitHub API (the app's daily
    // update check runs on load): abort by default — it must fail silently.
    // Tests that exercise the check register their own fulfilling route,
    // which wins because later-registered routes take precedence.
    await page.route('https://api.github.com/**', route => route.abort());
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await use(page);
    expect(errors, 'uncaught page errors during test').toEqual([]);
  },
});

export { expect };

/** Navigate to the app and wait for the first parameter fetch to land. */
export async function openApp(page, mock, { version = 'v0.1-mock' } = {}) {
  await page.goto(mock.url);
  // The top bar shows on every screen size (on phones the nav links sit in a drawer)
  await expect(page.locator('#topbar')).toBeVisible();
  // App is live once the json poll has populated the store (navbar shows F/W version)
  await expect(page.locator('#version')).toContainText('Web: ' + version);
}

/** Sign the browser in through the mock's API (sets the session cookie). */
export async function signInBrowser(page, mock, user, password) {
  const { cookie } = await mock.signIn(user, password);
  if (!cookie) throw new Error('sign-in failed for ' + user);
  await page.context().addCookies([{ name: 'oisess', value: cookie.slice('oisess='.length), url: mock.url, httpOnly: true, sameSite: 'Strict' }]);
}

// Sidebar on wide screens; on phones the sidebar is a drawer behind the
// bottom bar's More button, so open it first when the link isn't showing
export async function gotoTab(page, label) {
  const more = page.locator('#bottombar-more');
  if ((await more.isVisible()) && !(await page.evaluate(() => document.body.classList.contains('nav-open')))) {
    await more.click();
  }
  await page.locator('.tablink', { hasText: label }).click();
}
