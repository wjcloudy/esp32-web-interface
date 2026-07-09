import { test, expect, openApp, gotoTab } from './fixtures.mjs';

test.describe('Update tab', () => {
  test('single-file upload stores the file on the device', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Update');
    page.on('dialog', d => d.accept());
    await page.locator('#updatefile').setInputFiles({
      name: 'tweak.js', mimeType: 'application/javascript', buffer: Buffer.from('// tweak'),
    });
    await expect.poll(async () => (await mock.state()).files).toContain('tweak.js');
  });

  test('UART firmware install runs the page loop to 100%', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Update');
    page.on('dialog', d => d.accept());
    await page.locator('#update-firmware-file').setInputFiles({
      name: 'stm32_sine.bin', mimeType: 'application/octet-stream',
      buffer: Buffer.from('FAKEFIRMWARE'.repeat(64)),
    });
    // Progress bar appears and completes (mock reports 4 pages)
    await expect(page.locator('#progress')).toBeVisible();
    await expect(page.locator('#progress-label')).toHaveText('100%', { timeout: 15000 });
    await expect(page.locator('#progress-msg')).toContainText('Update Done!');
    // The flash loop stepped through every page, then cleaned up the upload
    const state = await mock.state();
    expect(state.fwSteps).toEqual([-1, 0, 1, 2, 3]);
    await expect.poll(async () => (await mock.state()).files).not.toContain('stm32_sine.bin');
  });
});
