import { test, expect } from './fixtures.mjs';

// Far from the device (through a router, over the internet) every round
// trip is expensive: the first live value must not wait on more of them
// than it needs. The layout and settings are asked for alongside
// /auth/state, and the /cmd poll bridges until the stream delivers — so a
// value shows about two round trips after the app script lands (sign-in
// state + layout, then one sample), and a stream port that never answers
// costs nothing.

// Mock latency, added before every reply. Large, so the few hundred ms a busy
// machine adds (the full suite runs in parallel) stays small next to the
// round-trip budgets: the old code took ~3.5 round trips, the budget is 3
const RTT = 1500;
const layout = { v: 4, dashboard: 9, pages: [
  { id: 9, name: 'Dashboard', items: [
    { id: 11, type: 'status', x: 0, y: 0, w: 6, h: 3 },
    { id: 12, type: 'metric', name: 'udc', x: 6, y: 0, w: 3, h: 2 },
  ] },
  { id: 1, name: 'Main', items: [{ id: 1, name: 'udc', type: 'radial', min: 0, max: 500, x: 0, y: 0, w: 3, h: 3 }] },
] };
const views = {
  gauges: '#gauges .svg-gauge .g-val',
  dashboard: '#dashboard .widget-metric .metric-value',
};

// ms from app.js arriving to the first value on screen (in-page clock)
async function firstValueAfterApp(page, mock, tab) {
  await page.addInitScript((sel) => {
    const id = setInterval(() => {
      const el = document.querySelector(sel);
      if (el && /\d/.test(el.textContent)) { window.__firstValue = window.performance.now(); clearInterval(id); }
    }, 5);
  }, views[tab]);
  await page.goto(mock.url + '/#' + tab);
  await expect.poll(() => page.evaluate(() => window.__firstValue || 0), { timeout: 15000 }).toBeGreaterThan(0);
  return page.evaluate(() => window.__firstValue -
    window.performance.getEntriesByType('resource').find(e => e.name.endsWith('/app.js')).responseEnd);
}

test.describe('First values with a slow link', () => {
  test.beforeEach(async ({ mock }) => {
    await mock.putFile('gauges.json', layout);
    await mock.setLatency(RTT);
  });

  for (const tab of Object.keys(views)) {
    test(`${tab}: the first value lands within about two round trips`, async ({ page, mock }) => {
      const order = [];
      page.on('request', r => order.push('>' + new URL(r.url()).pathname));
      page.on('requestfinished', r => order.push('<' + new URL(r.url()).pathname));
      const ms = await firstValueAfterApp(page, mock, tab);
      // Was ~3.5 round trips: layout and settings only after /auth/state
      // answered, then the stream opened on a second pass once sse_port landed
      expect(ms).toBeLessThan(3 * RTT);
      // The layout goes out before /auth/state comes back
      expect(order.indexOf('>/gauges.json')).toBeGreaterThan(-1);
      expect(order.indexOf('>/gauges.json')).toBeLessThan(order.indexOf('</auth/state'));
    });
  }

  test('a stream port that never answers still shows values at once', async ({ page, mock }) => {
    await mock.setSse('hang'); // e.g. a router forwarding only port 80
    const ms = await firstValueAfterApp(page, mock, 'gauges');
    // Was: nothing at all until the browser gave up on the connection
    expect(ms).toBeLessThan(4 * RTT);
    await mock.setLatency(0);
    await mock.setSpot('udc', 222);
    await expect(page.locator(views.gauges)).toContainText('222.0');
  });
});
