import { test, expect } from './fixtures.mjs';
import http from 'node:http';
import { ROUTES, PERM, METHOD_BITS as M } from '../mock-esp/auth.mjs';

// Users & permissions at the HTTP level — what a script (or an attacker
// who skips the UI) gets. The UI only mirrors this; the device is the
// enforcement point, and the mock enforces the firmware's model.

const ADMIN = ['admin', 'admin-pass-1'];
const OPER = ['oscar', 'operator-pass'];
const VIEW = ['vera', 'viewer-pass'];

async function withUsers(mock) {
  await mock.addUser(...ADMIN, 'admin');
  await mock.addUser(...OPER, 'operator');
  await mock.addUser(...VIEW, 'viewer');
  return {
    admin: (await mock.signIn(...ADMIN)).cookie,
    oper: (await mock.signIn(...OPER)).cookie,
    view: (await mock.signIn(...VIEW)).cookie,
  };
}

// One concrete request per table route that needs more than a viewer
const methodFor = (bits) => (bits & M.GET) ? 'GET' : (bits & M.POST) ? 'POST' : (bits & M.PUT) ? 'PUT' : 'DELETE';
const writeRoutes = ROUTES.filter(([, , perm]) => perm === PERM.WRITE || perm === PERM.ADMIN);

// Terminal commands that change something (UART and CAN mode alike)
const WRITE_CMDS = ['set fweak 50', 'save', 'load', 'defaults', 'start 2', 'stop', 'reset', 'fastuart',
  'can clear', 'can tx udc 0x100 0 16 1', 'can rm 12544 1', 'get udc\nsave', 'json extra', 'unknowncmd'];
const READ_CMDS = ['json', 'get udc,tmphs', 'errors', 'stream 3 udc', 'can list'];

function sseStatus(port, query) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/stream?' + query }, res => {
      resolve({ status: res.statusCode, headers: res.headers, res, req });
      if (res.statusCode !== 200) res.resume();
    });
    req.on('error', reject);
  });
}

test.describe('No users: sign-in is off and everything behaves as before', () => {
  test('state says off; reads, writes and CORS work without credentials', async ({ mock }) => {
    const st = JSON.parse((await mock.call('/auth/state')).text);
    expect(st).toMatchObject({ enabled: false, user: null, role: 'admin' });
    const r = await mock.call('/cmd?cmd=' + encodeURIComponent('set fweak 42'), { csrf: false });
    expect(r.text).toBe('Set OK');
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    expect((await mock.call('/settings?dev_name=Landy', { method: 'POST', csrf: false })).status).toBe(200);
    expect((await mock.call('/reboot', { csrf: false })).status).toBe(200);
    expect((await mock.state()).settings.dev_name).toBe('Landy');
    // The SSE stream needs no ticket
    const s = await sseStatus(mock.ssePort, 'names=udc');
    expect(s.status).toBe(200);
    expect(s.headers['access-control-allow-origin']).toBe('*');
    s.req.destroy();
    // Signing in makes no sense yet
    expect((await mock.signIn('x', 'whatever1')).status).toBe(400);
    expect((await mock.state()).otaRunning).toBe(true);
  });

  test('the first user must be an admin; creating it signs its creator in and turns enforcement on', async ({ mock }) => {
    let r = await mock.call('/auth/users', { method: 'POST', form: { op: 'add', user: 'bob', password: 'password1', role: 'viewer' } });
    expect(r.status).toBe(400);
    expect(r.text).toContain('first user must be an admin');
    r = await mock.call('/auth/users', { method: 'POST', form: { op: 'add', user: 'Admin', password: 'admin-pass-1', role: 'admin' } });
    expect(r.status).toBe(200);
    const cookie = r.headers.get('set-cookie');
    expect(cookie).toMatch(/^oisess=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Strict$/);
    // Names are stored lower-case
    expect((await mock.state()).users).toEqual([{ name: 'admin', role: 'admin' }]);
    expect((await mock.call('/cmd?cmd=json')).status).toBe(401);
    const st = JSON.parse((await mock.call('/auth/state', { cookie: cookie.split(';')[0] })).text);
    expect(st).toMatchObject({ enabled: true, user: 'admin', role: 'admin' });
    expect((await mock.state()).otaRunning).toBe(false); // ArduinoOTA stops with sign-in on
  });
});

test.describe('Sign-in on: every entry point', () => {
  test('without a session: UI files public, everything else 401', async ({ mock }) => {
    await mock.addUser(...ADMIN, 'admin');
    await mock.putFile('presets.json', '{"v":1,"presets":[]}');
    for (const p of ['/', '/index.html', '/app.js', '/style.css', '/manifest.json', '/favicon.svg'])
      expect((await mock.call(p)).status, p).toBe(200);
    for (const p of ['/cmd?cmd=json', '/settings', '/list', '/favorites.json', '/presets.json', '/version', '/wifi-status',
                     '/auth/users', '/auth/stream-ticket', '/gauges-sample.json', '/uiprefs.json'])
      expect((await mock.call(p)).status, p).toBe(401);
    expect((await mock.call('/auth/state')).status).toBe(200);
    // A bogus or truncated cookie is no session
    expect((await mock.call('/cmd?cmd=json', { cookie: 'oisess=' + '0'.repeat(64) })).status).toBe(401);
    expect((await mock.call('/cmd?cmd=json', { cookie: 'oisess=abc' })).status).toBe(401);
  });

  test('a viewer reads everything but is refused every write path, with nothing changed', async ({ mock }) => {
    const { view } = await withUsers(mock);
    for (const p of ['/settings', '/list', '/favorites.json', '/version', '/wifi-status', '/otainfo', '/fwupdate-status', '/auth/stream-ticket'])
      expect((await mock.call(p, { cookie: view })).status, p).toBe(200);
    for (const c of READ_CMDS)
      expect((await mock.call('/cmd?cmd=' + encodeURIComponent(c), { cookie: view })).status, c).toBe(200);
    for (const c of WRITE_CMDS) {
      const r = await mock.call('/cmd?cmd=' + encodeURIComponent(c), { cookie: view });
      expect(r.status, c).toBe(403);
      expect(JSON.parse(r.text).need).toBe('operator');
    }
    // POST works the same as GET for /cmd
    expect((await mock.call('/cmd', { method: 'POST', cookie: view, form: { cmd: 'save' } })).status).toBe(403);
    for (const [path, bits, perm] of writeRoutes) {
      const r = await mock.call(path, { method: methodFor(bits), cookie: view });
      expect(r.status, path).toBe(403);
      expect(JSON.parse(r.text).need, path).toBe(perm === PERM.ADMIN ? 'admin' : 'operator');
    }
    for (const method of ['PUT', 'DELETE'])
      expect((await mock.call('/edit?f=favorites.json', { method, cookie: view })).status, method).toBe(403);
    const fd = new FormData();
    fd.append('updatefile', new Blob(['{"p":["x"],"s":[]}']), 'favorites.json');
    expect((await mock.call('/edit', { method: 'POST', cookie: view, body: fd })).status).toBe(403);
    // GET /settings with change arguments (the old UI style) only reads
    expect((await mock.call('/settings?dev_name=Hacked', { cookie: view })).status).toBe(200);
    const st = await mock.state();
    expect(st.settings.dev_name).toBe('');
    expect(st.files).not.toContain('favorites.json');
    expect(st.inverter.params.fweak.value).toBe(67);
    expect(st.commandLog.filter(c => WRITE_CMDS.includes(c))).toEqual([]);
  });

  test('an operator drives the inverter but not the device; UI files and settings.json are admin-only', async ({ mock }) => {
    const { oper } = await withUsers(mock);
    for (const c of WRITE_CMDS.slice(0, 8))
      expect((await mock.call('/cmd?cmd=' + encodeURIComponent(c), { cookie: oper })).status, c).toBe(200);
    for (const [path, bits, perm] of writeRoutes) {
      const r = await mock.call(path, { method: methodFor(bits), cookie: oper });
      if (perm === PERM.ADMIN) expect(r.status, path).toBe(403);
      else expect([401, 403], path).not.toContain(r.status);
    }
    const up = (name) => { const fd = new FormData(); fd.append('updatefile', new Blob(['x']), name); return fd; };
    expect((await mock.call('/edit', { method: 'POST', cookie: oper, body: up('favorites.json') })).status).toBe(200);
    for (const name of ['app.js', 'index.html', 'app.js.gz', 'settings.json']) {
      const r = await mock.call('/edit', { method: 'POST', cookie: oper, body: up(name) });
      expect(r.status, name).toBe(403);
      expect(JSON.parse(r.text).need).toBe('admin');
    }
    expect((await mock.call('/edit?f=app.js', { method: 'DELETE', cookie: oper })).status).toBe(403);
    const files = (await mock.state()).files;
    expect(files).toContain('favorites.json');
    expect(files).not.toContain('app.js');
    expect((await mock.call('/auth/users', { cookie: oper })).status).toBe(403);
  });

  test('an admin can do everything, including the UI files', async ({ mock }) => {
    let { admin } = await withUsers(mock);
    for (const [path, bits] of writeRoutes) {
      const r = await mock.call(path, { method: methodFor(bits), cookie: admin });
      expect([401, 403], path).not.toContain(r.status);
      // A web-interface update reboots the device, signing everyone out
      if ((await mock.state()).sessions === 0) admin = (await mock.signIn(...ADMIN)).cookie;
    }
    const fd = new FormData();
    fd.append('updatefile', new Blob(['// custom']), 'custom.js');
    expect((await mock.call('/edit', { method: 'POST', cookie: admin, body: fd })).status).toBe(200);
    expect((await mock.call('/settings?dev_name=Landy', { method: 'POST', cookie: admin })).status).toBe(200);
    expect((await mock.state()).settings.dev_name).toBe('Landy');
  });

  test('scripts can use a bearer token instead of the cookie', async ({ mock }) => {
    await mock.addUser(...ADMIN, 'admin');
    const { token } = await mock.signIn(...ADMIN, { token: '1' });
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    // No X-OI-Auth needed: a bearer token is never sent by a browser on its own
    const r = await mock.call('/cmd?cmd=' + encodeURIComponent('set fweak 55'), { bearer: token, csrf: false });
    expect(r.text).toBe('Set OK');
    // The browser UI never asks, so the token isn't readable by page scripts
    expect((await mock.signIn(...ADMIN)).token).toBeNull();
  });
});

test.describe('Sessions', () => {
  test('logout ends the session', async ({ mock }) => {
    const { view } = await withUsers(mock);
    const r = await mock.call('/auth/logout', { method: 'POST', cookie: view });
    expect(r.status).toBe(200);
    expect(r.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await mock.call('/cmd?cmd=json', { cookie: view })).status).toBe(401);
  });

  test('idle and absolute expiry; "keep me signed in" lasts longer', async ({ mock }) => {
    await mock.addUser(...ADMIN, 'admin');
    const plain = (await mock.signIn(...ADMIN)).cookie;
    const kept = await mock.signIn(...ADMIN, { remember: '1' });
    expect(kept.setCookie).toContain('Max-Age=2592000');
    await mock.advanceClock(11 * 3600e3);
    expect((await mock.call('/cmd?cmd=json', { cookie: plain })).status).toBe(200); // use restarts the idle clock
    await mock.advanceClock(13 * 3600e3);
    expect((await mock.call('/cmd?cmd=json', { cookie: plain })).status).toBe(401);
    expect((await mock.call('/cmd?cmd=json', { cookie: kept.cookie })).status).toBe(200);
    await mock.advanceClock(31 * 24 * 3600e3);
    expect((await mock.call('/cmd?cmd=json', { cookie: kept.cookie })).status).toBe(401);
  });

  test('a role change, password reset or removal ends that user\'s sessions', async ({ mock }) => {
    const { admin, view, oper } = await withUsers(mock);
    const post = (form) => mock.call('/auth/users', { method: 'POST', cookie: admin, form });
    expect((await post({ op: 'role', user: 'vera', role: 'operator' })).status).toBe(200);
    expect((await mock.call('/cmd?cmd=json', { cookie: view })).status).toBe(401);
    const vera = (await mock.signIn(...VIEW)).cookie; // and the new role applies
    expect((await mock.call('/cmd?cmd=save', { cookie: vera })).status).toBe(200);
    expect((await post({ op: 'password', user: 'vera', password: 'brand-new-pw' })).status).toBe(200);
    expect((await mock.call('/cmd?cmd=json', { cookie: vera })).status).toBe(401);
    expect((await mock.signIn(...VIEW)).status).toBe(401);
    expect((await mock.signIn('vera', 'brand-new-pw')).status).toBe(200);
    expect((await post({ op: 'remove', user: 'oscar' })).status).toBe(200);
    expect((await mock.call('/cmd?cmd=json', { cookie: oper })).status).toBe(401);
    expect((await mock.signIn(...OPER)).status).toBe(401);
  });

  test('user management rules: last admin, own account, duplicates, validation', async ({ mock }) => {
    const { admin } = await withUsers(mock);
    const post = (form) => mock.call('/auth/users', { method: 'POST', cookie: admin, form });
    let r = await post({ op: 'remove', user: 'admin' });
    expect(r.status).toBe(400);
    expect(r.text).toContain('your own account');
    expect((await post({ op: 'role', user: 'admin', role: 'viewer' })).status).toBe(400);
    expect((await post({ op: 'add', user: 'vera', password: 'password1', role: 'viewer' })).status).toBe(409);
    expect((await post({ op: 'add', user: 'Bad Name', password: 'password1', role: 'viewer' })).status).toBe(400);
    expect((await post({ op: 'add', user: 'newbie', password: 'short', role: 'viewer' })).status).toBe(400);
    expect((await post({ op: 'add', user: 'newbie', password: 'password1', role: 'root' })).status).toBe(400);
    expect((await post({ op: 'remove', user: 'ghost' })).status).toBe(404);
    // A second admin may demote the first; then the last one is protected
    await post({ op: 'role', user: 'oscar', role: 'admin' });
    const oscar = (await mock.signIn(...OPER)).cookie;
    expect((await mock.call('/auth/users', { method: 'POST', cookie: oscar, form: { op: 'role', user: 'admin', role: 'viewer' } })).status).toBe(200);
    r = await mock.call('/auth/users', { method: 'POST', cookie: oscar, form: { op: 'remove', user: 'oscar' } });
    expect(r.status).toBe(400);
    const list = JSON.parse((await mock.call('/auth/users', { cookie: oscar })).text);
    expect(list.users.map(u => u.role)).toEqual(['viewer', 'admin', 'viewer']);
    expect(JSON.stringify(list)).not.toMatch(/hash|salt|password/);
  });

  test('changing your own password needs the current one and keeps this session', async ({ mock }) => {
    const { view } = await withUsers(mock);
    let r = await mock.call('/auth/password', { method: 'POST', cookie: view, form: { old: 'wrong-pass', new: 'another-pass' } });
    expect(r.status).toBe(403);
    r = await mock.call('/auth/password', { method: 'POST', cookie: view, form: { old: VIEW[1], new: 'another-pass' } });
    expect(r.status).toBe(200);
    const fresh = r.headers.get('set-cookie').split(';')[0];
    expect((await mock.call('/cmd?cmd=json', { cookie: view })).status).toBe(401);
    expect((await mock.call('/cmd?cmd=json', { cookie: fresh })).status).toBe(200);
  });
});

test.describe('Brute force and cross-site requests', () => {
  test('sign-in attempts are rate limited per address, with Retry-After', async ({ mock }) => {
    await mock.addUser(...ADMIN, 'admin');
    for (let i = 0; i < 6; i++) expect((await mock.signIn('admin', 'nope-nope-' + i)).status).toBe(401);
    const blocked = await mock.signIn(...ADMIN);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.retryAfter)).toBeGreaterThan(0);
    // Unknown names count against the address too
    for (let i = 0; i < 3; i++) expect((await mock.signIn('nobody-' + i, 'whatever-1')).status).toBe(429);
    await mock.advanceClock(5 * 60e3 + 1000);
    expect((await mock.signIn(...ADMIN)).status).toBe(200);
  });

  test('state changes need the UI header or a same-host Origin; foreign origins are refused', async ({ mock }) => {
    const { admin } = await withUsers(mock);
    const set = (opts) => mock.call('/cmd?cmd=' + encodeURIComponent('set fweak 51'), { cookie: admin, ...opts });
    expect((await set({ csrf: false })).status).toBe(403);
    expect((await set({ csrf: false, headers: { Origin: 'http://evil.example' } })).status).toBe(403);
    expect((await set({ headers: { Origin: 'http://evil.example' } })).status).toBe(403); // Origin wins over the header
    expect((await set({ csrf: false, headers: { Referer: 'http://evil.example/x' } })).status).toBe(403);
    const host = new URL(mock.url).host;
    expect((await set({ csrf: false, headers: { Origin: 'http://' + host } })).status).toBe(200);
    expect((await set({ csrf: false, headers: { Referer: 'http://' + host + '/#parameters' } })).status).toBe(200);
    expect((await set({})).status).toBe(200);
    // Reads aren't state changes: no header needed, but no CORS either
    const r = await mock.call('/cmd?cmd=json', { cookie: admin, csrf: false });
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
    // Sign-in itself refuses a foreign Origin
    const login = await mock.call('/auth/login', { method: 'POST', csrf: false, headers: { Origin: 'http://evil.example' }, form: { user: ADMIN[0], password: ADMIN[1] } });
    expect(login.status).toBe(403);
  });
});

test.describe('SSE stream with sign-in on', () => {
  test('needs a one-time ticket; reflects only a same-host origin; ends with the session', async ({ mock }) => {
    const { view } = await withUsers(mock);
    expect((await sseStatus(mock.ssePort, 'names=udc')).status).toBe(401);
    expect((await sseStatus(mock.ssePort, 'names=udc&t=' + '0'.repeat(32))).status).toBe(401);
    const ticket = JSON.parse((await mock.call('/auth/stream-ticket', { cookie: view })).text).ticket;
    expect(ticket).toMatch(/^[0-9a-f]{32}$/);
    const ok = await sseStatus(mock.ssePort, 'names=udc&t=' + ticket);
    expect(ok.status).toBe(200);
    expect(ok.headers['access-control-allow-origin']).toBeUndefined(); // no Origin sent: no CORS
    expect((await sseStatus(mock.ssePort, 'names=udc&t=' + ticket)).status).toBe(401); // used up
    const closed = new Promise(res => ok.res.on('close', res));
    await mock.call('/auth/logout', { method: 'POST', cookie: view });
    await closed; // the stream stops with its session
    const t2 = JSON.parse((await mock.call('/auth/stream-ticket', { cookie: (await mock.signIn(...VIEW)).cookie })).text).ticket;
    const cors = await new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: mock.ssePort, path: '/stream?names=udc&t=' + t2, headers: { Origin: 'http://127.0.0.1:1234' } }, res => { resolve(res.headers); req.destroy(); });
      req.on('error', () => {});
      setTimeout(() => reject(new Error('timeout')), 3000);
    });
    expect(cors['access-control-allow-origin']).toBe('http://127.0.0.1:1234');
  });

  test('recovery (BOOT button / serial) deletes every user and turns sign-in off', async ({ mock }) => {
    const { admin } = await withUsers(mock);
    await mock.call('/__test/auth-reset');
    expect(JSON.parse((await mock.call('/auth/state')).text).enabled).toBe(false);
    expect((await mock.call('/cmd?cmd=json', { cookie: admin })).status).toBe(200); // open again, as a fresh device
  });
});
