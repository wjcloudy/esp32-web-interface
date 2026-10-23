import { test, expect } from './fixtures.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROUTES, PERM, cmdPerm, staticPerm, filePerm } from '../mock-esp/auth.mjs';

// Contract tests for the mock ESP itself: the UI specs are only as good as
// the mock's fidelity to the firmware (esp32-web-interface.ino). Each case
// pins a reply format / status code the firmware produces, so a drifting
// mock fails here rather than silently validating the UI against a device
// that doesn't exist. No browser needed.

const get = (url) => fetch(url).then(async r => ({ status: r.status, body: await r.text(), type: r.headers.get('content-type') }));

// Read the first `n` SSE data lines from the stream port, then disconnect
function readSse(port, query, n = 1) {
  return new Promise((resolveP, reject) => {
    let done = false;
    const resolve = (v) => { done = true; resolveP(v); };
    const req = http.get({ host: '127.0.0.1', port, path: '/stream?' + query }, res => {
      if (res.statusCode !== 200) { res.resume(); resolve({ status: res.statusCode, lines: [] }); return; }
      let buf = '';
      const lines = [];
      res.setEncoding('utf8');
      res.on('data', chunk => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const ev = buf.slice(0, i); buf = buf.slice(i + 2);
          if (ev.startsWith('data: ')) lines.push(ev.slice(6));
          if (lines.length >= n) { req.destroy(); resolve({ status: 200, lines, headers: res.headers }); return; }
        }
      });
    });
    req.on('error', e => { if (!done) reject(e); }); // our own destroy() after resolving is fine
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('SSE timeout')); });
  });
}

test.describe('Mock ESP contract: /cmd (UART)', () => {
  test('missing cmd is a 500 BAD ARGS', async ({ mock }) => {
    const r = await get(mock.url + '/cmd');
    expect(r).toMatchObject({ status: 500, body: 'BAD ARGS' });
  });

  test('json returns the full schema as text/json', async ({ mock }) => {
    const r = await get(mock.url + '/cmd?cmd=json');
    expect(r.type).toContain('text/json');
    const j = JSON.parse(r.body);
    expect(j.fweak).toMatchObject({ isparam: true, value: 67, minimum: 0, maximum: 400, id: 1 });
    expect(j.udc).toMatchObject({ isparam: false, value: 398.5 });
    expect(j.can_cache).toBeUndefined();
  });

  test('get a,b&repeat=N returns N+1 sample groups, one value per line', async ({ mock }) => {
    const r = await get(mock.url + '/cmd?cmd=' + encodeURIComponent('get udc,tmphs') + '&repeat=3');
    const vals = r.body.match(/[-\d.]+/g);
    expect(vals).toHaveLength(8);
    expect(vals).toEqual(Array(4).fill(['398.50', '31.20']).flat());
  });

  test('repeat is clamped to 100 (101 groups)', async ({ mock }) => {
    const r = await get(mock.url + '/cmd?cmd=' + encodeURIComponent('get udc') + '&repeat=5000');
    expect(r.body.match(/[-\d.]+/g)).toHaveLength(101);
  });

  test('commands are cut at the 128-char UART terminal buffer', async ({ mock }) => {
    const names = Array.from({ length: 40 }, () => 'udc'); // 4 + 40*4-1 = 163 chars
    await get(mock.url + '/cmd?cmd=' + encodeURIComponent('get ' + names.join(',')));
    const [logged] = (await mock.commands()).slice(-1);
    expect(logged).toHaveLength(128);
  });

  test('set validates range and name; save/errors reply in free text', async ({ mock }) => {
    expect((await get(mock.url + '/cmd?cmd=' + encodeURIComponent('set fweak 42'))).body).toBe('Set OK');
    expect((await get(mock.url + '/cmd?cmd=' + encodeURIComponent('set fweak 9999'))).body).toBe('Value out of range');
    expect((await get(mock.url + '/cmd?cmd=' + encodeURIComponent('set nope 1'))).body).toBe('Unknown parameter');
    expect((await get(mock.url + '/cmd?cmd=save')).body).toBe('Parameters saved');
    expect((await get(mock.url + '/cmd?cmd=errors')).body).toBe('No errors');
    expect((await mock.state()).inverter.params.fweak.value).toBe(42);
  });
});

test.describe('Mock ESP contract: /cmd (CAN mode)', () => {
  test.beforeEach(async ({ mock }) => { await mock.enableCan(); });

  test('json carries ids, values and the can_cache flag', async ({ mock }) => {
    const j = JSON.parse((await get(mock.url + '/cmd?cmd=json')).body);
    expect(j.can_cache).toBe(true);
    expect(j.fweak).toMatchObject({ id: 1, value: 67 });
  });

  test('offline device (no param cache): minimal json without can_cache', async ({ mock }) => {
    await fetch(mock.url + '/__test/can-cache?loaded=0');
    const j = JSON.parse((await get(mock.url + '/cmd?cmd=json')).body);
    expect(Object.keys(j).sort()).toEqual(['opmode', 'status']);
  });

  test('get is tab-separated, one group, and ignores repeat', async ({ mock }) => {
    const r = await get(mock.url + '/cmd?cmd=' + encodeURIComponent('get udc,tmphs,bogus') + '&repeat=5');
    expect(r.body).toBe('398.50\t31.20\t0.00');
  });

  test('set / save / errors / unknown use the CAN layer replies', async ({ mock }) => {
    expect((await get(mock.url + '/cmd?cmd=' + encodeURIComponent('set fweak 50'))).body).toBe('Set OK');
    expect((await get(mock.url + '/cmd?cmd=' + encodeURIComponent('set fweak -1'))).body).toBe('Value out of range');
    expect((await get(mock.url + '/cmd?cmd=save')).body).toBe('saved');
    expect((await get(mock.url + '/cmd?cmd=errors')).body).toBe('No errors logged.');
    expect((await get(mock.url + '/cmd?cmd=defaults')).body).toBe('unknown command');
  });

  test('can tx / list / rm / clear round-trip', async ({ mock }) => {
    const cmd = (c) => get(mock.url + '/cmd?cmd=' + encodeURIComponent(c)).then(r => r.body);
    expect(await cmd('can tx udc 257 0 16 0.5')).toBe('ok');
    expect(await cmd('can tx tmphs 257 16 8 1')).toBe('ok');
    expect(await cmd('can rx pot 0x200 0 12 1')).toBe('ok');
    expect(await cmd('can tx nope 1 0 8 1')).toBe('error: unknown parameter');
    expect(await cmd('can tx udc')).toBe('error: missing arguments');
    let list = JSON.parse(await cmd('can list'));
    expect(list).toEqual([
      { isrx: false, id: 257, paramid: 2004, position: 0, length: 16, gain: 0.5, offset: 0, index: 0x3100, subindex: 1 },
      { isrx: false, id: 257, paramid: 2005, position: 16, length: 8, gain: 1, offset: 0, index: 0x3100, subindex: 3 },
      { isrx: true, id: 512, paramid: 2007, position: 0, length: 12, gain: 1, offset: 0, index: 0x3180, subindex: 1 },
    ]);
    expect(await cmd('can rm 12544 3')).toBe('ok');
    list = JSON.parse(await cmd('can list'));
    expect(list.map(m => m.paramid)).toEqual([2004, 2007]);
    expect(await cmd('can clear')).toBe('cleared');
    expect(await cmd('can list')).toBe('[]');
  });
});

test.describe('Mock ESP contract: files', () => {
  test('/edit DELETE accepts names with or without a leading slash', async ({ mock }) => {
    await mock.putFile('a.txt', 'a');
    await mock.putFile('b.txt', 'b');
    expect((await fetch(mock.url + '/edit?f=a.txt', { method: 'DELETE' })).status).toBe(200);
    expect((await fetch(mock.url + '/edit?f=%2Fb.txt', { method: 'DELETE' })).status).toBe(200);
    expect((await mock.state()).files).toEqual([]);
  });

  test('/edit DELETE/PUT error codes follow the firmware', async ({ mock }) => {
    const del = (qs) => fetch(mock.url + '/edit' + qs, { method: 'DELETE' }).then(async r => [r.status, await r.text()]);
    expect(await del('')).toEqual([500, 'BAD ARGS']);
    expect(await del('?f=%2F')).toEqual([500, 'BAD PATH']);
    expect(await del('?f=missing.txt')).toEqual([404, 'FileNotFound']);
    const put = (qs) => fetch(mock.url + '/edit' + qs, { method: 'PUT' }).then(async r => [r.status, await r.text()]);
    expect(await put('?f=new.txt')).toEqual([200, '']);
    expect(await put('?f=%2Fnew.txt')).toEqual([500, 'FILE EXISTS']);
    expect((await mock.state()).files).toEqual(['new.txt']);
  });

  test('/edit POST stores the upload; /list lists it; GET serves it', async ({ mock }) => {
    const fd = new FormData();
    fd.append('updatefile', new Blob(['hello']), 'note.txt');
    expect((await fetch(mock.url + '/edit', { method: 'POST', body: fd })).status).toBe(200);
    const list = await fetch(mock.url + '/list').then(r => r.json());
    expect(list).toEqual([{ type: 'file', name: 'note.txt' }]);
    expect(await fetch(mock.url + '/note.txt').then(r => r.text())).toBe('hello');
    // /edit GET is the (absent) editor page
    expect((await fetch(mock.url + '/edit')).status).toBe(404);
  });

  test('unknown paths 404 with the firmware\'s redirect hint', async ({ mock }) => {
    const r = await fetch(mock.url + '/nope.bin');
    expect(r.status).toBe(404);
    expect(r.headers.get('refresh')).toBe('6; url=/update');
  });
});

test.describe('Mock ESP contract: settings & wifi', () => {
  test('/settings applies ONE group per request (first match wins)', async ({ mock }) => {
    await fetch(mock.url + '/settings?dev_name=Rig&ap_fallback=1', { method: 'POST' });
    const s = await fetch(mock.url + '/settings').then(r => r.json());
    expect(s).toMatchObject({ dev_name: 'Rig', ap_fallback: false });
    expect(s.sse_port).toBe(mock.ssePort);
    expect(s.sse_port).not.toBe(Number(new URL(mock.url).port));
  });

  test('/settings clamps CAN/UART values and persists can_nodes', async ({ mock }) => {
    const nodes = JSON.stringify([{ nodeId: 3, name: 'rear', default: true }]);
    await fetch(mock.url + '/settings?can_mode=1&can_node_id=500&can_speed=9&can_rx_pin=99&uart_tx_pin=-4&can_pwr_pin=&can_nodes=' + encodeURIComponent(nodes), { method: 'POST' });
    const s = await fetch(mock.url + '/settings').then(r => r.json());
    expect(s).toMatchObject({ can_mode: true, can_node_id: 127, can_speed: 2, can_rx_pin: 4, uart_tx_pin: 1, can_pwr_pin: -1 });
    expect(s.can_nodes).toEqual([{ nodeId: 3, name: 'rear', default: true }]);
  });

  test('/wifi serves the templated page and rejects a short AP password', async ({ mock }) => {
    const page = await get(mock.url + '/wifi');
    expect(page.body).toMatch(/id="staSSID"[^>]*value="mocknet"/);
    expect(page.body).not.toContain('%');
    expect((await get(mock.url + '/wifi?apSSID=inv&apPW=short')).status).toBe(400);
    expect((await get(mock.url + '/wifi?apSSID=inv&apPW=longenough')).status).toBe(200);
    expect((await get(mock.url + '/wifi?apSSID=inv&apPW=')).status).toBe(200); // open AP
  });

  test('/can-send fails (not 4xx) when the CAN driver is down; /set-can-node clamps', async ({ mock }) => {
    expect(await fetch(mock.url + '/can-send?canId=180&data=01').then(r => r.json())).toMatchObject({ status: 'failed' });
    await mock.enableCan();
    expect(await fetch(mock.url + '/can-send?canId=180&data=01,02').then(r => r.json())).toEqual({ status: 'sent', canId: 0x180, len: 2 });
    expect(await fetch(mock.url + '/set-can-node?id=0').then(r => r.json())).toEqual({ nodeId: 1 });
  });
});

test.describe('Mock ESP contract: SSE stream (separate port)', () => {
  test('streams UART get replies with newlines flattened', async ({ mock }) => {
    const r = await readSse(mock.ssePort, 'names=udc,tmphs&ms=50', 2);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('text/event-stream');
    expect(r.lines[0]).toBe('398.50 31.20 ');
    expect(await mock.commands()).toContain('stream udc,tmphs');
  });

  test('streams tab-separated values in CAN mode', async ({ mock }) => {
    await mock.enableCan();
    const r = await readSse(mock.ssePort, 'names=udc,tmphs&ms=50');
    expect(r.lines[0]).toBe('398.50\t31.20');
  });

  test('refuses names outside [A-Za-z0-9_,.-] and the main port has no stream', async ({ mock }) => {
    expect((await readSse(mock.ssePort, 'names=' + encodeURIComponent('udc;reset'))).status).toBe(404);
    expect((await readSse(mock.ssePort, 'ms=100')).status).toBe(404);
    expect((await fetch(mock.url + '/stream?names=udc')).status).toBe(404);
  });

  test('sse mode hooks: 404 refuses, off drops the connection', async ({ mock }) => {
    await mock.setSse('404');
    expect((await readSse(mock.ssePort, 'names=udc')).status).toBe(404);
    await mock.setSse('off');
    await expect(readSse(mock.ssePort, 'names=udc')).rejects.toThrow();
  });
});

// The users/permissions model: the mock's tables must BE the firmware's.
// ROUTES is read straight out of src/web_logic.h; the classification
// vectors mirror test/test_web_auth (the firmware's native tests).
test.describe('Mock ESP contract: permission model matches the firmware', () => {
  const webLogic = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'web_logic.h'), 'utf8');

  test('route table is identical to weblogic::ROUTES', () => {
    const block = webLogic.slice(webLogic.indexOf('static const RouteRule ROUTES[]'), webLogic.indexOf('static const size_t ROUTE_COUNT'));
    const bits = { M_GET: 1, M_POST: 2, M_PUT: 4, M_DELETE: 8, M_OTHER: 16, M_ANY: 31 };
    const fw = [...block.matchAll(/\{\s*"([^"]+)",\s*([A-Z_| ]+?),\s*PERM_([A-Z]+)\s*\}/g)].map(m => [
      m[1], m[2].split('|').map(s => bits[s.trim()]).reduce((a, b) => a | b, 0), PERM[m[3]],
    ]);
    expect(fw.length).toBeGreaterThan(30);
    expect(ROUTES).toEqual(fw);
  });

  test('terminal command allowlist', () => {
    for (const c of ['json', 'json hidden', 'errors', 'serial', 'help', 'get udc', 'get udc,tmphs,v_x', 'stream 10 udc,tmphs', 'stream 100 udc', 'can list', 'can print'])
      expect(cmdPerm(c), c).toBe(PERM.READ);
    for (const c of ['set fweak 50', 'save', 'load', 'defaults', 'start 2', 'stop', 'reset', 'fastuart', 'binarylogging 1',
                     'can tx udc 0x100 0 16 1', 'can clear', 'can listx', 'get udc\nsave', 'get udc;save', 'get ', 'json  ',
                     ' json', 'stream 0 udc', 'stream 101 udc', 'get é', ''])
      expect(cmdPerm(c), JSON.stringify(c)).toBe(PERM.WRITE);
  });

  test('static and file classification', () => {
    for (const p of ['/', '/app.js', '/app.js.gz', '/manifest.json', '/wifi.html']) expect(staticPerm(p), p).toBe(PERM.PUBLIC);
    for (const p of ['/settings.json', '/presets.json', '/subscription.js', '/x.bin', '/img-logo.png', '/img-a.png.gz']) expect(staticPerm(p), p).toBe(PERM.READ);
    for (const p of ['/../x', 'app.js', '/a\\b']) expect(staticPerm(p), p).toBe(PERM.DENY);
    for (const p of ['favorites.json', 'subscription.js', '/x.bin', 'img-logo.png', '/img-car.jpg', '/img-a.webp', '/img-a.gif']) expect(filePerm(p), p).toBe(PERM.WRITE);
    // image-tile uploads: only raster pictures under the img- prefix are data
    for (const p of ['app.js', '/index.html', 'app.js.gz', 'settings.json', '/', '/img-x.svg', '/img-x.js', '/img-.png', '/logo.png', '/x/img-a.png'])
      expect(filePerm(p), p).toBe(PERM.ADMIN);
  });

  test('auth replies: 401/403 JSON with the needed role; cookie attributes', async ({ mock }) => {
    await mock.addUser('admin', 'admin-pass-1', 'admin');
    await mock.addUser('vera', 'viewer-pass', 'viewer');
    const r401 = await mock.call('/cmd?cmd=json');
    expect(r401.status).toBe(401);
    expect(JSON.parse(r401.text)).toEqual({ error: 'sign-in required' });
    const s = await mock.signIn('vera', 'viewer-pass');
    expect(s.setCookie).toMatch(/^oisess=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Strict$/);
    const r403 = await mock.call('/reboot', { cookie: s.cookie });
    expect(JSON.parse(r403.text)).toEqual({ error: 'your account cannot do this', need: 'admin' });
    const st = JSON.parse((await mock.call('/auth/state', { cookie: s.cookie })).text);
    expect(st).toEqual({ enabled: true, user: 'vera', role: 'viewer', remember: false, password_min: 8 });
    expect(JSON.parse((await mock.call('/auth/state')).text)).toEqual({ enabled: true, user: null, role: null, password_min: 8 });
  });
});
