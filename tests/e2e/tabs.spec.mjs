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
});
