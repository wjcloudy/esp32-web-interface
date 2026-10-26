import { test, expect, openApp } from './fixtures.mjs';

// The Dashboard's "Start inverter in manual mode" button. Sine firmware:
// `start 2`. The FOC build has no start command, so the button falls back to
// its manualstart parameter, which LATCHES until every interlock passes: if
// the start doesn't happen within a few seconds it is cleared again, so the
// inverter can't start by itself later. Stop clears it too.

const startBtn = (page) => page.locator('#dashboard button', { hasText: 'Start inverter in manual mode' });
// Start asks first: confirm in the dialog
const start = async (page) => { await startBtn(page).click(); await page.locator('#start-confirm').click(); };
const stopBtn = (page) => page.locator('#dashboard button', { hasText: 'Stop inverter' });
// The start/stop commands only: the Dashboard's own polls (get opmode,...) interleave
const plotCmds = async (mock) => (await mock.commands()).filter(c => /^(start 2|stop|set manualstart [01])$/.test(c));
const opmode = async (mock) => (await mock.state()).inverter.spot.opmode.value;
const manualstart = async (mock) => (await mock.state()).inverter.params.manualstart.value;

test.describe('Start button', () => {
  test('asks first: Cancel sends nothing', async ({ page, mock }) => {
    await openApp(page, mock);
    await startBtn(page).click();
    await expect(page.locator('#start-inverter-modal-overlay')).toContainText('Are you sure you want to start the inverter in manual mode?');
    await page.locator('#start-inverter-modal-overlay button', { hasText: 'Cancel' }).click();
    await expect(page.locator('#start-inverter-modal-overlay')).toHaveCount(0);
    await page.waitForTimeout(500);
    expect((await mock.commands()).some(c => c.startsWith('start') || c.startsWith('set manualstart'))).toBe(false);
  });

  test('sine firmware: start 2, and nothing else', async ({ page, mock }) => {
    await openApp(page, mock);
    await start(page);
    await expect.poll(() => mock.commands()).toContain('start 2');
    await page.waitForTimeout(500);
    expect((await mock.commands()).some(c => c.startsWith('set manualstart'))).toBe(false);
  });

  test('FOC firmware: falls back to manualstart, and the inverter starts in Run', async ({ page, mock }) => {
    await fetch(mock.url + '/__test/foc');
    await openApp(page, mock);
    await start(page);
    await expect.poll(() => opmode(mock)).toBe(1);
    const cmds = await plotCmds(mock);
    expect(cmds.indexOf('start 2')).toBeLessThan(cmds.indexOf('set manualstart 1'));
    // It started, so manualstart is back to 0 (the firmware clears it)
    expect(await manualstart(mock)).toBe(0);
  });

  test('FOC firmware: a start an interlock holds back is disarmed, not left latched', async ({ page, mock }) => {
    await fetch(mock.url + '/__test/foc?blocked=1');
    await openApp(page, mock);
    await start(page);
    await expect.poll(() => mock.commands()).toContain('set manualstart 1');
    expect(await manualstart(mock)).toBe(1); // armed while it waits
    // A few seconds without starting: cleared again, and it says why
    await expect.poll(() => mock.commands(), { timeout: 8000 }).toContain('set manualstart 0');
    expect(await manualstart(mock)).toBe(0);
    expect(await opmode(mock)).toBe(0);
  });

  test('a page closed while a start is pending still clears manualstart on its way out', async ({ page, mock }) => {
    await fetch(mock.url + '/__test/foc?blocked=1');
    await openApp(page, mock);
    await start(page);
    await expect.poll(() => mock.commands()).toContain('set manualstart 1');
    // Leave well inside the ~3 s check: with the page gone its own timeout
    // never runs, so only the exit clear can reset it (the browser delivers
    // that keepalive request in its own time)
    await page.goto('about:blank');
    await expect.poll(() => manualstart(mock), { timeout: 6000 }).toBe(0);
    expect(await opmode(mock)).toBe(0);
  });

  test('a clear the device never answers is retried, then raised as an alert', async ({ page, mock }) => {
    await fetch(mock.url + '/__test/foc?blocked=1');
    await openApp(page, mock);
    // Every attempt to clear is lost on the way (EMI on the Wi-Fi)
    let attempts = 0;
    await page.route(u => new URL(u).searchParams.get('cmd') === 'set manualstart 0', r => { attempts++; r.abort(); });
    const alerted = new Promise(res => page.once('dialog', d => { res(d.message()); d.accept(); }));
    await start(page);
    expect(await alerted).toContain('manualstart could not be cleared');
    expect(attempts).toBe(3);
  });

  test('Stop clears manualstart even when this page never set it', async ({ page, mock }) => {
    // Armed from somewhere else (another browser, the terminal), held by an interlock
    await fetch(mock.url + '/__test/foc?blocked=1');
    await fetch(mock.url + '/cmd?cmd=' + encodeURIComponent('set manualstart 1'), { headers: { 'X-OI-Auth': '1' } });
    expect(await manualstart(mock)).toBe(1);
    await openApp(page, mock);
    await stopBtn(page).click();
    await expect.poll(() => manualstart(mock)).toBe(0);
  });

  test('sine firmware: Stop\'s clear gets "Unknown parameter" and stays quiet', async ({ page, mock }) => {
    let dialogs = 0;
    page.on('dialog', d => { dialogs++; d.accept(); });
    await openApp(page, mock);
    await stopBtn(page).click();
    await expect.poll(async () => (await plotCmds(mock)).slice(-2)).toEqual(['stop', 'set manualstart 0']);
    await page.waitForTimeout(1000);
    expect((await mock.commands()).filter(c => c === 'set manualstart 0')).toHaveLength(1); // answered: no retry
    expect(dialogs).toBe(0);
  });

  test('FOC firmware: Stop also clears manualstart', async ({ page, mock }) => {
    await fetch(mock.url + '/__test/foc');
    await openApp(page, mock);
    await start(page);
    await expect.poll(() => opmode(mock)).toBe(1);
    await stopBtn(page).click();
    await expect.poll(async () => (await plotCmds(mock)).slice(-2)).toEqual(['stop', 'set manualstart 0']);
  });
});
