import { test, expect, openApp, gotoTab } from './fixtures.mjs';

test.describe('Files tab', () => {
  test('uploads a file to SPIFFS and lists it', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Files');
    await page.locator('#updatefile2').setInputFiles({
      name: 'canmap.json', mimeType: 'application/json', buffer: Buffer.from('{"x":1}'),
    });
    await expect(page.locator('tr', { hasText: 'canmap.json' })).toBeVisible();
    expect((await mock.state()).files).toContain('canmap.json');
  });

  test('deletes a file', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Files');
    await page.locator('#updatefile2').setInputFiles({
      name: 'todelete.txt', mimeType: 'text/plain', buffer: Buffer.from('bye'),
    });
    const row = page.locator('tr', { hasText: 'todelete.txt' });
    await expect(row).toBeVisible();
    page.on('dialog', d => d.accept());
    await row.locator('button', { hasText: 'Delete' }).click();
    await expect(row).toHaveCount(0);
    expect((await mock.state()).files).not.toContain('todelete.txt');
  });
});
