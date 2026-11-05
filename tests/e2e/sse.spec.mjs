import { test, expect, openApp, gotoTab } from './fixtures.mjs';

// Gauge value transport: the firmware pushes values over SSE from a
// separate listener (sse_port in /settings); any failure must fall back to
// the /cmd get polling loop without losing live updates.

const radial = [{ id: 1, name: 'udc', type: 'radial', min: 0, max: 500, x: 0, y: 0, w: 3, h: 3 }];
const gaugeVal = (page) => page.locator('.svg-gauge .g-val');
const getPolls = async (mock) => (await mock.commands()).filter(c => c === 'get udc').length;

test.describe('Gauge value transport', () => {
  test.beforeEach(async ({ mock }) => { await mock.putFile('gauges.json', { v: 3, pages: [{ id: 1, name: 'Main', items: radial }] }); });

  test('the stream opens on the advertised SSE port, not the web server port', async ({ page, mock }) => {
    const streamUrls = [];
    page.on('request', r => { if (r.url().includes('/stream?')) streamUrls.push(new URL(r.url())); });
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await expect(gaugeVal(page)).toContainText('398.5');
    // The Dashboard streams its own status values first; pick the page's stream
    const pageStream = () => streamUrls.find(u => u.searchParams.get('names') === 'udc');
    await expect.poll(() => !!pageStream()).toBe(true);
    expect(Number(pageStream().port)).toBe(mock.ssePort);
    expect(pageStream().searchParams.get('ms')).toBe('100');
  });

  for (const mode of ['off', '404']) {
    test(`falls back to polling when the SSE port ${mode === 'off' ? 'refuses connections' : 'answers 404'}`, async ({ page, mock }) => {
      await mock.setSse(mode);
      await openApp(page, mock);
      await gotoTab(page, 'Gauges');
      await expect(gaugeVal(page)).toContainText('398.5');
      await expect.poll(() => getPolls(mock)).toBeGreaterThan(0);
      await mock.setSpot('udc', 211);
      await expect(gaugeVal(page)).toContainText('211.0');
      expect(await mock.commands()).not.toContain('stream udc');
    });
  }

  test('a stream that dies mid-session hands over to polling and keeps updating', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await expect.poll(async () => await mock.commands()).toContain('stream udc');
    await mock.setSpot('udc', 300);
    await expect(gaugeVal(page)).toContainText('300.0');
    // The poll that bridges the stream's start has stood down
    const bridged = await getPolls(mock);
    await page.waitForTimeout(500);
    expect(await getPolls(mock)).toBe(bridged);
    // Kill the stream (and keep the port shut so a reconnect can't win)
    await mock.setSse('off');
    await expect.poll(() => getPolls(mock)).toBeGreaterThan(0);
    await mock.setSpot('udc', 123);
    await expect(gaugeVal(page)).toContainText('123.0');
  });

  test('CAN mode polling fallback parses the tab-separated get reply', async ({ page, mock }) => {
    await mock.enableCan();
    await mock.setSse('off');
    await mock.putFile('gauges.json', { v: 3, pages: [{ id: 1, name: 'Main', items: [
      ...radial, { id: 2, name: 'tmphs', type: 'text', x: 3, y: 0, w: 2, h: 1 },
    ] }] });
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await expect(gaugeVal(page)).toContainText('398.5');
    await expect(page.locator('.gauge-tile').nth(1)).toContainText('31.2');
    await expect.poll(async () => await mock.commands()).toContain('get udc,tmphs');
    await mock.setSpot('tmphs', 45.5);
    await expect(page.locator('.gauge-tile').nth(1)).toContainText('45.5');
  });

  test('leaving the Gauges tab closes the stream', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await expect.poll(async () => await mock.commands()).toContain('stream udc');
    await gotoTab(page, 'Settings'); // not the Dashboard: its status tile streams too
    // The listener holds one client; once the browser closes the
    // EventSource the mock drops its handle
    await expect.poll(async () => (await fetch(mock.url + '/__test/state').then(r => r.json())).sseOpen).toBe(false);
  });
});
