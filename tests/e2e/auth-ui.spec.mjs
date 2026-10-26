import { test, expect, openApp, gotoTab, signInBrowser } from './fixtures.mjs';

// Users & sign-in in the browser: first-user setup, sign-in/out, what each
// role sees, how refusals surface, and the phone layout.

const ADMIN = ['admin', 'admin-pass-1'];
const VIEW = ['vera', 'viewer-pass'];
const OPER = ['oscar', 'operator-pass'];

const signInUi = async (page, user, password, { remember = false } = {}) => {
  await expect(page.locator('#login')).toBeVisible();
  await page.locator('#login-user').fill(user);
  await page.locator('#login-password').fill(password);
  if (remember) await page.locator('#login-remember').check();
  await page.locator('#login-submit').click();
};

test.describe('Sign-in off (no users)', () => {
  test('no sign-in screen, no account in the sidebar; Settings offers the first admin', async ({ page, mock }) => {
    await openApp(page, mock);
    await expect(page.locator('#login')).toHaveCount(0);
    await expect(page.locator('#whoami')).toHaveCount(0);
    await expect(page.locator('#readonly-bar')).toHaveCount(0);
    await gotoTab(page, 'Settings');
    await page.locator('#settings-users-tab').click();
    await expect(page.locator('#users-setup')).toContainText('Sign-in is off');
  });

  test('first-user setup creates an admin, signs in, and turns sign-in on', async ({ page, mock }) => {
    await openApp(page, mock);
    await gotoTab(page, 'Settings');
    await page.locator('#settings-users-tab').click();
    await page.locator('#setup-user').fill('Admin');
    await page.locator('#setup-pw').fill('short');
    await page.locator('#setup-pw2').fill('short');
    await page.locator('#setup-create').click();
    await expect(page.locator('#users-setup .auth-err')).toContainText('at least 8');
    await page.locator('#setup-pw').fill(ADMIN[1]);
    await page.locator('#setup-pw2').fill(ADMIN[1] + 'x');
    await page.locator('#setup-create').click();
    await expect(page.locator('#users-setup .auth-err')).toContainText("don't match");
    await page.locator('#setup-pw2').fill(ADMIN[1]);
    await page.locator('#setup-create').click();
    // Reloaded, signed in as the new admin
    await expect(page.locator('#whoami')).toContainText('admin');
    await expect(page.locator('#version')).toContainText('Web: v0.1-mock');
    expect((await mock.state()).users).toEqual([{ name: 'admin', role: 'admin' }]);
    // A fresh browser now gets the sign-in screen
    const other = await page.context().browser().newPage();
    await other.goto(mock.url);
    await expect(other.locator('#login')).toBeVisible();
    await other.close();
  });
});

test.describe('Sign-in on', () => {
  test.beforeEach(async ({ mock }) => {
    await mock.addUser(...ADMIN, 'admin');
    await mock.addUser(...VIEW, 'viewer');
    await mock.addUser(...OPER, 'operator');
  });

  test('sign in, wrong password, sign out', async ({ page, mock }) => {
    await page.goto(mock.url);
    // The card carries the full mark: ring and all three phase waves
    await expect(page.locator('#login .login-logo path')).toHaveCount(3);
    await signInUi(page, 'admin', 'wrong-password');
    await expect(page.locator('#login-error')).toContainText('Incorrect');
    await expect(page.locator('#login-password')).toHaveValue('');
    await signInUi(page, ...ADMIN);
    await expect(page.locator('#whoami')).toContainText('admin');
    await expect(page.locator('.tablink', { hasText: 'Dashboard' })).toBeVisible();
    await page.locator('#signout').click();
    await expect(page.locator('#login')).toBeVisible();
    await expect(page.locator('#login-user')).toHaveValue('admin'); // remembered for next time
    expect((await mock.state()).sessions).toBe(0);
  });

  test('a viewer sees a read-only UI; the device refuses writes and the UI says why', async ({ page, mock }) => {
    await signInBrowser(page, mock, ...VIEW);
    await openApp(page, mock);
    await expect(page.locator('#readonly-bar')).toContainText('Read-only');
    await expect(page.locator('#whoami')).toContainText('Read-only');
    // Write controls are disabled (inert), reads still work
    await expect(page.locator('.perm-gate[inert]', { hasText: 'Start inverter' })).toHaveCount(1);
    await expect(page.locator('.perm-gate[inert]', { hasText: 'Reboot ESP32' })).toHaveCount(1);
    await page.locator('#commandinput').fill('get udc');
    await page.locator('#commandinput').press('Enter');
    await expect(page.locator('#commandoutput')).toContainText('398.50');
    // Forcing a write through the terminal: refused by the device, toast in the UI
    await page.locator('#commandinput').fill('save');
    await page.locator('#commandinput').press('Enter');
    await expect(page.locator('.oi-toast')).toContainText('needs Operator access');
    expect(await mock.commands()).not.toContain('save');
    await gotoTab(page, 'Parameters');
    await expect(page.locator('#paramBody input[type=number]').first()).toHaveJSProperty('readOnly', true);
    await gotoTab(page, 'Update');
    await expect(page.locator('#update-perm-note')).toContainText('admin');
    await gotoTab(page, 'Settings');
    await expect(page.locator('#settings-perm-note')).toBeVisible();
    await page.locator('#settings-users-tab').click();
    await expect(page.locator('#my-account')).toContainText('vera');
    await expect(page.locator('#user-list')).toHaveCount(0);
  });

  test('an operator can drive the inverter but not the device', async ({ page, mock }) => {
    await signInBrowser(page, mock, ...OPER);
    await openApp(page, mock);
    await expect(page.locator('#readonly-bar')).toHaveCount(0);
    await expect(page.locator('.perm-gate[inert]', { hasText: 'Start inverter' })).toHaveCount(0);
    await expect(page.locator('.perm-gate[inert]', { hasText: 'Reboot ESP32' })).toHaveCount(1);
    await page.locator('button', { hasText: 'Start inverter in manual mode' }).click();
    await page.locator('#start-confirm').click();
    await expect.poll(async () => (await mock.commands()).includes('start 2')).toBe(true);
  });

  test('admin manages users: add, change role, reset password, remove', async ({ page, mock }) => {
    await signInBrowser(page, mock, ...ADMIN);
    await openApp(page, mock);
    await page.locator('#whoami').click();
    await expect(page.locator('#user-list .user-row')).toHaveCount(3);
    await page.locator('#new-user').fill('Petra');
    await page.locator('#new-role').selectOption('operator');
    await page.locator('#new-pw').fill('petra-pass-1');
    await page.locator('#new-pw2').fill('petra-pass-1');
    await page.locator('#new-add').click();
    await expect(page.locator('#user-list .user-row[data-user="petra"]')).toBeVisible();
    await page.locator('#role-petra').selectOption('viewer');
    await expect.poll(async () => (await mock.state()).users.find(u => u.name === 'petra')?.role).toBe('viewer');
    // Reset a password from the list
    await page.locator('.user-row[data-user="vera"] button', { hasText: 'Password' }).click();
    await page.locator('#reset-pw').fill('vera-new-pass');
    await page.locator('#reset-pw2').fill('vera-new-pass');
    await page.locator('#reset-save').click();
    await expect(page.locator('#reset-pw')).toHaveCount(0);
    expect((await mock.signIn('vera', 'vera-new-pass')).status).toBe(200);
    // Remove (with confirmation)
    page.once('dialog', d => d.accept());
    await page.locator('.user-row[data-user="oscar"] button', { hasText: 'Remove' }).click();
    await expect(page.locator('#user-list .user-row[data-user="oscar"]')).toHaveCount(0);
    // Your own row: no remove, no role change
    await expect(page.locator('.user-row[data-user="admin"] button', { hasText: 'Remove' })).toHaveCount(0);
    await expect(page.locator('#role-admin')).toBeDisabled();
  });

  test('a session that ends while the app is open drops back to sign-in', async ({ page, mock }) => {
    await signInBrowser(page, mock, ...VIEW);
    await openApp(page, mock);
    await mock.advanceClock(13 * 3600e3);
    await expect(page.locator('#login')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.login-note')).toContainText('session has ended');
    await signInUi(page, ...VIEW);
    await expect(page.locator('#whoami')).toContainText('vera');
  });

  test('gauges stream over SSE with a ticket when signed in', async ({ page, mock }) => {
    await mock.putFile('gauges.json', { v: 3, pages: [{ id: 1, name: 'Main', items: [{ id: 1, name: 'udc', type: 'radial', min: 0, max: 500, x: 0, y: 0, w: 3, h: 3 }] }] });
    const streams = [];
    page.on('request', r => { if (r.url().includes('/stream?')) streams.push(new URL(r.url())); });
    await signInBrowser(page, mock, ...VIEW);
    await openApp(page, mock);
    await gotoTab(page, 'Gauges');
    await expect(page.locator('.svg-gauge .g-val')).toContainText('398.5');
    await expect.poll(() => streams.length).toBeGreaterThan(0);
    expect(streams[0].searchParams.get('t')).toMatch(/^[0-9a-f]{32}$/);
    await expect.poll(async () => (await mock.state()).sseOpen).toBe(true);
    await mock.setSpot('udc', 222);
    await expect(page.locator('.svg-gauge .g-val')).toContainText('222.0');
  });
});

test.describe('Phone (375×812)', () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

  test('sign-in screen fits, has phone-sized targets and signs in', async ({ page, mock }) => {
    await mock.addUser(...ADMIN, 'admin');
    await page.goto(mock.url);
    await expect(page.locator('#login')).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(1);
    for (const sel of ['#login-user', '#login-password', '#login-submit']) {
      const box = await page.locator(sel).boundingBox();
      expect(box.height, sel).toBeGreaterThanOrEqual(44);
      expect(box.x, sel).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, sel).toBeLessThanOrEqual(375);
    }
    // 16px inputs: iOS won't zoom the page on focus
    expect(await page.locator('#login-user').evaluate(e => parseFloat(getComputedStyle(e).fontSize))).toBeGreaterThanOrEqual(16);
    await page.locator('#login-user').tap();
    await page.locator('#login-user').fill(ADMIN[0]);
    await page.locator('#login-password').fill(ADMIN[1]);
    await page.locator('#login-submit').tap();
    await expect(page.locator('#topbar')).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(1);
    await page.locator('#bottombar-more').tap(); // the account sits in the More drawer on a phone
    await expect(page.locator('#whoami .user-avatar')).toBeVisible();
  });

  test('account and user management fit the phone', async ({ page, mock }) => {
    await mock.addUser(...ADMIN, 'admin');
    await mock.addUser(...VIEW, 'viewer');
    await signInBrowser(page, mock, ...ADMIN);
    await openApp(page, mock);
    await page.locator('#bottombar-more').tap(); // on a phone the account sits in the More drawer
    await page.locator('#whoami').tap(); // the avatar opens the account
    await expect(page.locator('#my-account')).toBeVisible();
    await expect(page.locator('#user-list .user-row')).toHaveCount(2);
    expect(await overflow(page)).toBeLessThanOrEqual(1);
    const row = await page.locator('.user-row[data-user="vera"]').boundingBox();
    expect(row.x + row.width).toBeLessThanOrEqual(375);
    await page.locator('#settings-signout').tap();
    await expect(page.locator('#login')).toBeVisible();
  });

  test('read-only viewer on a phone: banner shown, no horizontal scroll', async ({ page, mock }) => {
    await mock.addUser(...ADMIN, 'admin');
    await mock.addUser(...VIEW, 'viewer');
    await signInBrowser(page, mock, ...VIEW);
    await openApp(page, mock);
    await expect(page.locator('#readonly-bar')).toBeVisible();
    for (const tab of ['Dashboard', 'Parameters', 'Settings'])  {
      await gotoTab(page, tab);
      expect(await overflow(page), tab).toBeLessThanOrEqual(1);
    }
  });
});
