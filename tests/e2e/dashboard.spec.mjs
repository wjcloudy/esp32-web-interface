import { test, expect, openApp } from './fixtures.mjs';

test.describe('Dashboard', () => {
  test('loads and shows live inverter status', async ({ page, mock }) => {
    await openApp(page, mock);
    const dash = page.locator('#dashboard');
    await expect(dash).toBeVisible();
    // Enum-typed spot values resolve through their unit mapping
    await expect(dash).toContainText('Off'); // opmode 0=Off
    await expect(dash).toContainText('398.5'); // udc
    // Firmware version resolved from the version enum
    await expect(page.locator('#version')).toContainText('5.27.R-sine');
  });

  test('command console sends command, echoes it, and prints the reply', async ({ page, mock }) => {
    await openApp(page, mock);
    const input = page.locator('#commandinput');
    await input.fill('errors');
    await input.press('Enter');
    const out = page.locator('#commandoutput');
    await expect(out).toContainText('> errors');
    await expect(out).toContainText('No errors');
    expect(await mock.commands()).toContain('errors');
  });
});
