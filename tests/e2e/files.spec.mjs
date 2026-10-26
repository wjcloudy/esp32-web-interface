import { test, expect, openApp, gotoTab, signInBrowser } from './fixtures.mjs';

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
    await row.locator('button', { hasText: 'Delete' }).click();
    await page.locator('#file-delete-confirm').click();
    await expect(row).toHaveCount(0);
    expect((await mock.state()).files).not.toContain('todelete.txt');
  });
  test('the list reflects files already on the device, and delete targets the listed name', async ({ page, mock }) => {
    await mock.putFile('a.json', '{}');
    await mock.putFile('b.bin', 'xx');
    const deletes = [];
    page.on('request', r => { if (r.method() === 'DELETE') deletes.push(new URL(r.url())); });
    await openApp(page, mock);
    await gotoTab(page, 'Files');
    await expect(page.locator('#files tbody tr:not(.files-group-head)')).toHaveCount(2);
    await page.locator('#files tr', { hasText: 'a.json' }).locator('button', { hasText: 'Delete' }).click();
    await page.locator('#file-delete-confirm').click();
    await expect(page.locator('#files tbody tr:not(.files-group-head)')).toHaveCount(1);
    await expect(page.locator('#files tbody tr:not(.files-group-head)')).toContainText('b.bin');
    // The Files tab sends the bare SPIFFS name; firmware handleFileDelete
    // must accept it with or without the leading '/'
    expect(deletes.map(u => u.pathname + u.search)).toEqual(['/edit?f=a.json']);
    expect((await mock.state()).files).toEqual(['b.bin']);
  });

  test('Delete asks first: Cancel keeps the file', async ({ page, mock }) => {
    await mock.putFile('keep.json', '{}');
    await openApp(page, mock);
    await gotoTab(page, 'Files');
    await page.locator('#files tr', { hasText: 'keep.json' }).locator('button', { hasText: 'Delete' }).click();
    await expect(page.locator('#file-delete-modal-overlay')).toContainText('Delete keep.json?');
    await page.locator('#file-delete-modal-overlay button', { hasText: 'Cancel' }).click();
    await expect(page.locator('#file-delete-modal-overlay')).toHaveCount(0);
    expect((await mock.state()).files).toContain('keep.json');
  });

  test('system files (from the image manifest) are grouped apart, marked Original, Modified or Missing', async ({ page, mock }) => {
    await mock.putFile('fs-manifest.json', { v: 2, files: { 'app.js.gz': 5, 'style.css.gz': 3, 'fonts/OFL.txt': 4, 'fs-manifest.json': null } });
    await mock.putFile('app.js.gz', 'xxxxx');      // same size: original
    await mock.putFile('style.css.gz', 'changed'); // different size: modified
    await mock.putFile('gauges.json', '{}');        // yours
    await mock.putFile('img-car.png', 'png');       // yours
    await openApp(page, mock);
    await gotoTab(page, 'Files');
    const mine = page.locator('#files-mine'), system = page.locator('#files-system');
    await expect(mine.locator('.files-group-head')).toContainText('Your files');
    await expect(mine.locator('tr:not(.files-group-head)')).toHaveText([/gauges\.json/, /img-car\.png/]);
    await expect(system.locator('.files-group-head')).toContainText('System files');
    await expect(system.locator('tr', { hasText: 'app.js.gz' }).locator('.file-badge')).toHaveText('Original');
    await expect(system.locator('tr', { hasText: 'style.css.gz' }).locator('.file-badge')).toHaveText('Modified');
    // Shipped but no longer on the device: listed, with nothing to act on
    const gone = system.locator('tr', { hasText: 'fonts/OFL.txt' });
    await expect(gone.locator('.file-badge')).toHaveText('Missing');
    await expect(gone.locator('button')).toHaveCount(0);
    // Deleting a system file warns that the page may break
    await system.locator('tr', { hasText: 'app.js.gz' }).locator('button', { hasText: 'Delete' }).click();
    await expect(page.locator('#file-delete-modal-overlay')).toContainText("It's a system file");
  });

  test('a file in a folder can be deleted (the list gives its full path)', async ({ page, mock }) => {
    await mock.putFile('fonts/custom.woff2', 'font');
    const deletes = [];
    page.on('request', r => { if (r.method() === 'DELETE') deletes.push(new URL(r.url()).searchParams.get('f')); });
    await openApp(page, mock);
    await gotoTab(page, 'Files');
    await page.locator('#files tr', { hasText: 'fonts/custom.woff2' }).locator('button', { hasText: 'Delete' }).click();
    await page.locator('#file-delete-confirm').click();
    await expect(page.locator('#files tr', { hasText: 'fonts/custom.woff2' })).toHaveCount(0);
    expect(deletes).toEqual(['fonts/custom.woff2']);
    expect((await mock.state()).files).not.toContain('fonts/custom.woff2');
  });

  test('a refused delete says why instead of doing nothing', async ({ page, mock }) => {
    // With sign-in on, the web interface's own files are an admin's
    await mock.addUser('admin', 'admin-pass-1', 'admin');
    await mock.addUser('oscar', 'operator-pass', 'operator');
    await mock.putFile('app.js.gz', 'x');
    await signInBrowser(page, mock, 'oscar', 'operator-pass');
    await page.goto(mock.url);
    await gotoTab(page, 'Files');
    await page.locator('#files tr', { hasText: 'app.js.gz' }).locator('button', { hasText: 'Delete' }).click();
    await page.locator('#file-delete-confirm').click();
    await expect(page.locator('#files-msg')).toHaveText('Deleting app.js.gz needs an admin account.');
    expect((await mock.state()).files).toContain('app.js.gz');
  });

  test('Download beside Delete saves the file as the device serves it', async ({ page, mock }) => {
    await mock.putFile('notes.json', '{"keep":true}');
    await openApp(page, mock);
    await gotoTab(page, 'Files');
    const row = page.locator('#files tbody tr', { hasText: 'notes.json' });
    await expect(row.locator('button', { hasText: 'Delete' })).toBeVisible();
    const dl = page.waitForEvent('download');
    await row.locator('a', { hasText: 'Download' }).click();
    const file = await dl;
    expect(file.suggestedFilename()).toBe('notes.json');
    const chunks = [];
    for await (const c of await file.createReadStream()) chunks.push(c);
    expect(Buffer.concat(chunks).toString()).toBe('{"keep":true}');
  });

  test('uploading over an existing file replaces its content', async ({ page, mock }) => {
    await mock.putFile('notes.txt', 'old');
    await openApp(page, mock);
    await gotoTab(page, 'Files');
    await page.locator('#updatefile2').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('new') });
    await expect.poll(async () => fetch(mock.url + '/notes.txt').then(r => r.text())).toBe('new');
    await expect(page.locator('#files tbody tr', { hasText: 'notes.txt' })).toHaveCount(1);
  });
});
