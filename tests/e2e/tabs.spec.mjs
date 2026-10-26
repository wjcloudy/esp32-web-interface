import { test, expect, openApp, gotoTab } from './fixtures.mjs';

// Smoke coverage: every tab must render without an uncaught browser error
// (the page fixture fails the test if one fires) and show its main content.
const TABS = [
  ['Dashboard', '#dashboard'],
  ['Parameters', '#parameters'],
  ['Spot Values', '#spotvalues'],
  ['Plot', '#plot'],
  ['Gauges', '#gauges, .gauge, canvas'],
  ['Data Logger', 'text=Data Logger'],
  ['CAN Mapping', 'text=/CAN|Mapping/i'],
  ['Files', 'text=Files'],
  ['Update', 'text=/firmware|update/i'],
  ['Settings', 'text=/theme|settings/i'],
  ['Support', 'text=/support|help|wiki/i'],
];

test.describe('Tab smoke tests', () => {
  for (const [label, marker] of TABS) {
    test(`${label} tab renders`, async ({ page, mock }) => {
      await openApp(page, mock);
      await gotoTab(page, label);
      await expect(page.locator(marker).first()).toBeVisible();
    });
  }
});

test.describe('Spot values', () => {
  test('table lists live values with units', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Spot Values');
    const table = page.locator('#spotValues');
    await expect(table.locator('tr', { hasText: 'udc' })).toContainText('398.5');
    await expect(table.locator('tr', { hasText: 'tmphs' })).toContainText('31.2');
  });

  test('on a phone the table keeps its width wherever the list is scrolled', async ({ page, mock }) => {
    // Enough values to scroll, one with a long name. The multi-column check
    // used to measure from the list's on-screen top, which grows as the page
    // scrolls: near the end it flipped the layout and the table stretched to
    // its text
    for (let i = 0; i < 40; i++) await fetch(mock.url + `/__test/add-value?name=extra_value_${i}&value=${i}&unit=V`);
    await fetch(mock.url + '/__test/add-value?name=a_really_long_spot_value_name_that_wraps&value=1&unit=A');
    await page.setViewportSize({ width: 393, height: 852 });
    await openApp(page, mock);
    await gotoTab(page, 'Spot Values');
    const table = page.locator('#spotValues');
    await expect(table.locator('tr', { hasText: 'extra_value_39' })).toBeVisible();
    const widths = () => page.evaluate(() => {
      const t = document.querySelector('#spotValues');
      return { table: Math.round(t.getBoundingClientRect().width), vw: document.documentElement.clientWidth };
    });
    const top = await widths();
    expect(top.table).toBeLessThanOrEqual(top.vw);
    // One column fits a phone: the multi-column layout stays off
    await expect(page.locator('#spotValuesWrap')).not.toHaveClass(/multi-col/);
    // Scroll to the end, then change a value so the table resizes and the
    // layout check runs again with the list scrolled
    await table.locator('tr').last().scrollIntoViewIfNeeded();
    await fetch(mock.url + '/__test/spot?name=udc&value=123456.789');
    await expect(table.locator('tr', { hasText: 'udc' })).toContainText('123456');
    await page.waitForTimeout(300);
    // Same width as at the top: the table fills the screen, not its text
    expect(await widths()).toEqual(top);
    await expect(page.locator('#spotValuesWrap')).not.toHaveClass(/multi-col/);
  });
});
