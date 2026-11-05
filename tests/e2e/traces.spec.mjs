import { test, expect, openApp, gotoTab } from './fixtures.mjs';

// Every trace (line tiles, Dashboard sparklines, the Spot Values trend
// column) advances once per sample, whether or not the value changed: a
// steady or zero signal keeps scrolling in step with its neighbours instead
// of freezing until it moves. The mock inverter's values hold still unless
// a test drives them.

const sparkPoints = (loc) => loc.evaluate(el => {
  const pl = el.querySelector('svg.spark polyline');
  return pl ? pl.getAttribute('points').trim().split(/\s+/).length : 0;
});

test.describe('Traces advance on time', () => {
  test('a line tile scrolls while its value holds steady', async ({ page, mock }) => {
    await mock.putFile('gauges.json', { v: 3, pages: [{ id: 1, name: 'Main', items: [
      { id: 1, name: 'udc', type: 'line', min: 0, max: 500, points: 20, sampleMs: 100, x: 0, y: 0, w: 4, h: 3 },
    ] }] });
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await expect(page.locator('#gauges .g-val')).toContainText('398.5');
    const len = () => page.evaluate(() => window.Chart.getChart(document.querySelector('#gauges canvas')).data.datasets[0].data.length);
    // udc never changes, yet the history fills to the configured length
    await expect.poll(len, { timeout: 10000 }).toBe(20);
    const ys = await page.evaluate(() => window.Chart.getChart(document.querySelector('#gauges canvas')).data.datasets[0].data.map(p => p.y));
    expect(new Set(ys)).toEqual(new Set([398.5]));
  });

  test('a line tile keeps its time axis when the value leaves the scale', async ({ page, mock }) => {
    await mock.putFile('gauges.json', { v: 3, pages: [{ id: 1, name: 'Main', items: [
      { id: 1, name: 'tmphs', type: 'line', min: 0, max: 100, points: 20, sampleMs: 100, x: 0, y: 0, w: 4, h: 3 },
    ] }] });
    await mock.setSpot('tmphs', 0);
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    const x = () => page.evaluate(() => {
      const c = window.Chart.getChart(document.querySelector('#gauges canvas'));
      return c ? [c.scales.x.min, c.scales.x.max] : null;
    });
    // Filling: the trace grows from the right, the axis doesn't stretch it
    await expect.poll(x).toEqual([0, 19]);
    // Below the scale (a value that swings negative): Chart.js used to fit x
    // to the points still on screen, squeezing the trace sideways
    await mock.setSpot('tmphs', -40);
    await page.waitForTimeout(800);
    expect(await x()).toEqual([0, 19]);
  });

  test('Dashboard metric and status sparklines advance with steady values', async ({ page, mock }) => {
    await mock.putFile('gauges.json', { v: 4, dashboard: 9, pages: [{ id: 9, name: 'Dashboard', items: [
      { id: 1, type: 'status', figs: ['udc', 'tmphs'], x: 0, y: 0, w: 6, h: 3 },
      { id: 2, type: 'metric', name: 'udc', x: 6, y: 0, w: 3, h: 2 },
    ] }] });
    await openApp(page, mock);
    const metric = page.locator('#dashboard .widget-metric');
    const fig = page.locator('#dashboard .hero-metrics .metric').first();
    await expect(metric).toContainText('398.5');
    // Before: one point per CHANGE, so a steady value never drew a line
    await expect.poll(() => sparkPoints(metric), { timeout: 10000 }).toBeGreaterThan(10);
    await expect.poll(() => sparkPoints(fig), { timeout: 10000 }).toBeGreaterThan(10);
    // ...and it keeps going, capped at the history length
    await expect.poll(() => sparkPoints(metric), { timeout: 15000 }).toBe(60);
  });

  test('the Spot Values trend column advances with a steady value', async ({ page, mock }) => {
    await page.addInitScript(() => { try { localStorage.setItem('spotSparks', '1'); } catch (e) {} });
    await openApp(page, mock);
    await page.locator('.control', { hasText: 'Refresh' }).locator('select').selectOption('1000');
    await gotoTab(page, 'Spot Values');
    // The name cell also holds its tooltip text: match the name itself
    const row = page.getByRole('row', { name: /^☆ udc \d/ });
    await expect(row).toHaveCount(1);
    // One point per json poll (1 s here), changed or not
    await expect.poll(() => sparkPoints(row), { timeout: 10000 }).toBeGreaterThan(3);
  });
});
