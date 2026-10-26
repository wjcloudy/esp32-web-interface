// Demo transport: the ESP32's HTTP API and SSE value stream, answered inside
// the browser, so the real web interface (data/) runs as a static site with
// no device behind it. Loaded by the demo build (demo/build.mjs) before any
// app script; the firmware image never contains it.
//
// It follows the firmware the way the E2E mock does (tests/mock-esp/server.mjs):
//   UART mode  /cmd speaks the inverter terminal (PROTOCOL.md): `get` = one
//              value per line, `&repeat=N` = N+1 sample groups
//   CAN mode   (?can=1 on the demo URL) tab-separated `get`, `can list` JSON,
//              "can_cache":true in json
// Values come from demo/demo-data.js, a pure function of time, so a frozen
// clock gives repeatable pictures.
//
// Nothing leaves the page: writes live in memory and a reload starts the
// demo afresh. Flashing, rebooting and downloads only say they are a demo.
(function () {
  'use strict';
  const D = window.OI_DEMO_DATA;
  if (!D) return;

  const query = new URLSearchParams(location.search);
  // Where the site is served from (GitHub Pages puts it under /<repo>/): the
  // app asks for its files at the root, as on the ESP
  const BASE = location.pathname.replace(/[^/]*$/, '');
  const realFetch = window.fetch.bind(window);
  const t0 = Date.now();
  const simNow = () => (Date.now() - t0) / 1000;

  // ---------------- device state (in memory: a reload resets it) ----------------
  const params = {};
  let id = 1;
  for (const [name, [category, unit, value, minimum, maximum, def]] of Object.entries(D.PARAMS)) {
    params[name] = { unit, value, isparam: true, minimum, maximum, default: def, category, i: id - 1, id: id++ };
  }
  const spotIds = {};
  id = 2000;
  for (const name of Object.keys(D.SPOT)) spotIds[name] = id++;

  const files = new Map(); // SPIFFS stand-in: name -> text
  for (const [name, content] of Object.entries(D.FILES)) files.set(name, JSON.stringify(content));
  const settings = {
    dev_name: D.deviceName, txrx_swapped: false, uart_rx_pin: 1, uart_tx_pin: 3, ap_fallback: false,
    can_mode: query.get('can') === '1', can_node_id: 1, can_speed: 2, can_rx_pin: 4, can_tx_pin: 5,
    can_pwr_pin: -1, can_pwr_inv: false, can_en_pin: -1, can_en_inv: false, arch: 'esp32',
  };
  let canNodes = settings.can_mode ? [{ nodeId: 1, serial: 3405691582, name: 'VCU', default: true }] : null;
  let canMap = D.CAN_MAP.map(m => ({ ...m }));

  // The bundled sample gauge pages are the demo's saved layout
  const gaugesReady = realFetch(BASE + 'gauges-sample.json')
    .then(r => r.ok ? r.text() : null)
    .then(t => { if (t && !files.has('gauges.json')) files.set('gauges.json', t); })
    .catch(() => {});

  // ---------------- simulated inverter ----------------
  // dt: a burst's later samples come from slightly later in the drive
  const allValues = (dt = 0) => {
    const sim = D.simulate(simNow() + dt);
    const out = {};
    for (const n in params) out[n] = params[n];
    for (const n in D.SPOT) out[n] = { unit: D.SPOT[n], value: sim[n] !== undefined ? sim[n] : 0, isparam: false, id: spotIds[n] };
    return out;
  };
  const fmt2 = (v) => Number(v).toFixed(2);
  const virtualItems = () => {
    try { const d = JSON.parse(files.get('virtualvals.json') || '{}'); return Array.isArray(d.items) ? d.items.slice(0, 16) : []; } catch (e) { return []; }
  };

  function uartCommand(cmd, dt = 0) {
    const [verb, ...rest] = cmd.split(' ');
    const args = rest.join(' ');
    switch (verb) {
      case 'json': return JSON.stringify(allValues());
      case 'get': {
        const v = allValues(dt);
        return args.split(',').map(n => v[n.trim()] === undefined ? 'Unknown parameter' : fmt2(v[n.trim()].value)).join('\n') + '\n';
      }
      case 'stream': {
        // stream <n> <a,b,...>: n CSV rows sampled back-to-back, as the
        // inverter's terminal does (a row every ~0.6 ms at 921600 baud)
        const sp = args.indexOf(' ');
        const reps = Math.max(1, Math.min(500, parseInt(args) || 1));
        const names = sp > 0 ? args.slice(sp + 1).split(',').map(n => n.trim()) : [];
        if (!names.length) return 'Usage: stream n val1,val2...\n';
        let out = '';
        for (let i = 0; i < reps; i++) {
          const v = allValues(dt + i * 0.0006);
          out += names.map(n => v[n] === undefined ? '0.00' : fmt2(v[n].value)).join(',') + '\n';
        }
        return out;
      }
      case 'set': return setParam(args);
      case 'save': return 'Parameters saved';
      case 'load': return 'Parameters loaded';
      case 'defaults':
        for (const n in params) params[n].value = params[n].default;
        return 'Defaults restored';
      case 'errors': return 'No errors';
      case 'start': return 'Demo: the simulated inverter is already running';
      case 'stop': return 'Demo: the simulated inverter keeps running';
      case 'reset': return 'Demo: nothing to reset';
      case 'fastuart': return 'OK fast uart on';
      default: return 'Unknown command: ' + verb;
    }
  }

  function setParam(args) {
    const sp = args.indexOf(' ');
    if (sp <= 0) return 'Usage: set name value';
    const p = params[args.slice(0, sp)];
    const value = parseFloat(args.slice(sp + 1));
    if (!p) return 'Unknown parameter';
    if (isNaN(value) || value < p.minimum || value > p.maximum) return 'Value out of range';
    p.value = value;
    return 'Set OK';
  }

  function canListJson() {
    const v = allValues();
    const out = [];
    for (const isrx of [false, true]) {
      const ids = [...new Set(canMap.filter(m => m.isrx === isrx).map(m => m.cobid))];
      ids.forEach((cobid, msgIdx) => {
        canMap.filter(m => m.isrx === isrx && m.cobid === cobid).forEach((m, itemIdx) => {
          out.push({
            isrx, id: cobid, paramid: v[m.name] ? v[m.name].id : 0, position: m.position, length: m.length,
            gain: Number(m.gain.toFixed(3)), offset: m.offset, index: (isrx ? 0x3180 : 0x3100) + msgIdx, subindex: 1 + itemIdx * 2,
          });
        });
      });
    }
    return JSON.stringify(out);
  }

  function canCommand(cmd) {
    if (cmd === 'json') {
      const obj = {};
      for (const [n, v] of Object.entries(allValues())) obj[n] = { ...v, value: Number(fmt2(v.value)) };
      for (const vi of virtualItems()) obj[vi.name] = { unit: String(vi.unit || ''), isparam: false, virtual: true, value: 0 };
      obj.can_cache = true;
      return JSON.stringify(obj);
    }
    if (cmd.startsWith('get ')) {
      const v = allValues();
      return cmd.slice(4).split(',').map(n => v[n.trim()] ? fmt2(v[n.trim()].value) : '0.00').join('\t');
    }
    if (cmd.startsWith('set ')) return setParam(cmd.slice(4));
    if (cmd === 'save') return 'saved';
    if (cmd === 'load') return 'loaded';
    if (cmd === 'errors') return 'No errors logged.';
    if (cmd.startsWith('can ')) {
      const rest = cmd.slice(4).trim();
      if (rest === 'clear') { canMap = []; return 'cleared'; }
      if (rest.startsWith('list')) return canListJson();
      if (rest.startsWith('rm ')) {
        const [index, sub] = rest.slice(3).split(' ').map(Number);
        const e = JSON.parse(canListJson()).find(m => m.index === index && m.subindex === sub);
        if (!e) return 'error: remove failed';
        canMap = canMap.filter(m => !(m.isrx === e.isrx && m.cobid === e.id && m.position === e.position));
        return 'ok';
      }
      const a = rest.split(' ');
      if (a.length < 5 || (a[0] !== 'tx' && a[0] !== 'rx')) return 'error: usage: can tx/rx name canid pos bits gain';
      if (!allValues()[a[1]]) return 'error: unknown parameter';
      canMap.push({ isrx: a[0] === 'rx', cobid: Number(a[2]) || 0, name: a[1], position: parseInt(a[3]) || 0,
        length: parseInt(a[4]) || 0, gain: a[5] !== undefined ? (parseFloat(a[5]) || 0) : 1, offset: parseInt(a[6]) || 0 });
      return 'ok';
    }
    if (/^(start|stop|reset)/.test(cmd)) return 'Demo: the simulated inverter ignores ' + cmd.split(' ')[0];
    return 'unknown command';
  }

  // ---------------- replies ----------------
  // Bodies resolve as microtasks (not through the network stack), so under a
  // paused test clock every poll lands before the next timer fires
  function reply(body, status = 200, type = 'text/plain') {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    const res = new Response(text, { status, headers: { 'Content-Type': type } });
    res.text = () => Promise.resolve(text);
    res.json = () => Promise.resolve().then(() => JSON.parse(text));
    return res;
  }
  const DEMO_NO = 'Demo mode: there is no real device here, so nothing was changed';
  // The app does not always show a failed update's message, so the banner says it
  let noticeTimer;
  function notice(what) {
    const bar = document.getElementById('oi-demo-banner');
    if (!bar) return;
    const msg = bar.querySelector('.oi-demo-notice') || bar.appendChild(document.createElement('div'));
    msg.className = 'oi-demo-notice';
    msg.textContent = 'Demo mode: ' + what + ' - there is no real device here.';
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => msg.remove(), 8000);
  }

  // The device path a same-origin URL names, with or without the site's base
  const appPath = (u) => u.pathname.startsWith(BASE) ? '/' + u.pathname.slice(BASE.length) : u.pathname;

  // Pictures the site ships for image tiles: /list offers them to pick,
  // the static host serves them. Uploading images is not part of the demo
  const SITE_IMAGES = ['example-badge.png', 'example-vehicle.webp'];
  const isImageUpload = (body) => body instanceof FormData && [...body.values()].some(v =>
    v && typeof v === 'object' && (/^image\//.test(v.type) || /\.(png|jpe?g|webp|gif|svg)$/i.test(v.name || '')));

  async function readUploads(body) {
    if (!(body instanceof FormData)) return;
    for (const [, v] of body.entries()) {
      if (v && typeof v === 'object' && v.name) files.set(v.name.replace(/^\/+/, ''), await v.text());
    }
  }

  function settingsReply(q) {
    const ok = () => reply('{"result":"ok"}', 200, 'text/json');
    const s = settings;
    if (q.has('txrx_swap')) { s.txrx_swapped = q.get('txrx_swap') === '1'; return ok(); }
    if (q.has('dev_name')) { s.dev_name = q.get('dev_name').slice(0, 32); return ok(); }
    if (q.has('ap_fallback')) { s.ap_fallback = q.get('ap_fallback') === '1'; return ok(); }
    if (q.has('sd_enabled')) return ok();
    if (q.has('can_mode')) {
      s.can_mode = q.get('can_mode') === '1';
      for (const k of ['can_node_id', 'can_speed', 'can_rx_pin', 'can_tx_pin', 'uart_rx_pin', 'uart_tx_pin'])
        if (q.has(k)) s[k] = parseInt(q.get(k)) || 0;
      for (const k of ['can_pwr_pin', 'can_en_pin']) if (q.has(k)) s[k] = q.get(k) === '' ? -1 : parseInt(q.get(k));
      for (const k of ['can_pwr_inv', 'can_en_inv']) if (q.has(k)) s[k] = q.get(k) === '1';
      if (q.has('can_nodes')) { try { canNodes = JSON.parse(q.get('can_nodes')); } catch (e) {} }
      return ok();
    }
    const out = { ...s, sse_port: 81 };
    if (canNodes) out.can_nodes = canNodes;
    return reply(out, 200, 'text/json');
  }

  async function device(u, init) {
    const p = appPath(u);
    const q = u.searchParams;
    const method = ((init && init.method) || 'GET').toUpperCase();
    switch (p) {
      case '/cmd': {
        const cmd = q.get('cmd') || '';
        if (settings.can_mode) return reply(canCommand(cmd.slice(0, 1024)), 200, 'text/json');
        const c = cmd.slice(0, 128);
        const repeat = Math.max(0, Math.min(100, parseInt(q.get('repeat')) || 0));
        let out = uartCommand(c);
        for (let i = 1; i <= repeat; i++) out += uartCommand(c, i * 0.02);
        return reply(out, 200, 'text/json');
      }
      case '/settings': return settingsReply(q);
      case '/version': return reply(D.webVersion);
      case '/otainfo': return reply({ version: D.webVersion, repo: D.repo, target: settings.arch });
      case '/list': return reply([...new Set([...files.keys(), ...SITE_IMAGES])].map(name => ({ type: 'file', name })), 200, 'text/json');
      // What the firmware image ships (fs_stage.py writes it on a device):
      // here, the bundled pictures, sizes unknown
      case '/fs-manifest.json': return reply({ v: 2, files: Object.fromEntries(SITE_IMAGES.map(n => [n, null])) }, 200, 'application/json');
      case '/edit':
        if (method === 'POST' && isImageUpload(init && init.body)) {
          notice('no image was uploaded');
          return reply(DEMO_NO + ' (images cannot be uploaded here; pick one of the bundled ones)', 400);
        }
        if (method === 'POST') { await readUploads(init && init.body); return reply(''); }
        if (method === 'DELETE') { files.delete(String(q.get('f') || '').replace(/^\/+/, '')); return reply(''); }
        if (method === 'PUT') { files.set(String(q.get('f') || '').replace(/^\/+/, ''), ''); return reply(''); }
        return reply('Demo: no file editor', 404);
      case '/wifi': {
        if (q.has('apSSID') || q.has('staSSID')) return reply('<p>' + DEMO_NO + '.</p>', 200, 'text/html');
        const page = await (await realFetch(BASE + 'wifi.html')).text();
        return reply(page.replaceAll('%staSSID%', D.wifi.staSSID).replaceAll('%apSSID%', D.wifi.apSSID)
          .replaceAll('%staIP%', D.wifi.ip), 200, 'text/html');
      }
      case '/wifi-status': return reply({ sta_connected: true, rssi: D.wifi.rssi, ssid: D.wifi.staSSID, ip: D.wifi.ip,
        ap_active: !settings.ap_fallback, ap_clients: 0, ap_fallback: settings.ap_fallback }, 200, 'text/json');
      case '/set-can-node':
        if (q.has('id')) settings.can_node_id = parseInt(q.get('id')) || 1;
        return reply('{"nodeId":' + settings.can_node_id + '}', 200, 'text/json');
      case '/can-scan':
        if (!settings.can_mode) return reply('{"error":"CAN mode not enabled"}', 400, 'text/json');
        return reply('[{"nodeId":1,"serial":3405691582}]', 200, 'text/json');
      case '/can-send':
        return reply({ status: settings.can_mode ? 'sent' : 'failed', canId: parseInt(q.get('canId'), 16) || 0, len: 0 }, 200, 'text/json');
      case '/virtual-reload': return reply({ count: virtualItems().length });
      case '/baud': return reply('921600');
      // Firmware updates, reboots: harmless, and they say why
      case '/fwupdate': notice('no inverter firmware was flashed'); return reply({ message: DEMO_NO + ' (no inverter firmware is flashed)' }, 400);
      case '/fwupdate-status': return reply({ state: 0 });
      case '/espupdate-url': notice('no image was downloaded or flashed'); return reply({ ok: false, message: DEMO_NO + ' (no image is downloaded or flashed)' });
      case '/espupdate-status': return reply({ state: 0 });
      case '/reboot': notice('nothing was rebooted'); return reply('Demo: nothing to reboot');
      case '/reset-inverter': notice('nothing was reset'); return reply('Demo: nothing to reset');
      // Users & sign-in: the demo runs with sign-in off (no users), like a
      // fresh device; Settings → Users & Access shows the setup card, but no
      // account is ever created
      case '/auth/state': return reply({ enabled: false, user: null, role: 'admin', password_min: 8 });
      case '/auth/users':
        if (method === 'POST') { notice('no account was created'); return reply({ error: DEMO_NO + ' (no account is created)' }, 400); }
        return reply({ enabled: false, me: null, max: 8, users: [] });
      case '/auth/stream-ticket': return reply({ ticket: '' });
      case '/auth/login': case '/auth/logout': case '/auth/password':
        return reply({ error: DEMO_NO + ' (sign-in is off in the demo)' }, 400);
    }
    if (p === '/gauges.json') await gaugesReady;
    const name = p.replace(/^\/+/, '');
    if (files.has(name)) return reply(files.get(name), 200, 'application/json');
    const layoutDefaults = { 'favorites.json': '{"p":[],"s":[]}', 'gauges.json': '{"items":[]}', 'plots.json': '{"plots":[]}', 'virtualvals.json': '{"items":[]}' };
    if (layoutDefaults[name]) return reply(layoutDefaults[name], 200, 'application/json');
    // Other JSON files are the device's settings files (uiprefs.json ...): not stored yet
    if (name.endsWith('.json') && name !== 'gauges-sample.json') return reply('FileNotFound', 404);
    return null; // not the device's: a file of the site itself
  }

  // Stand-ins for the GitHub API, so the Update tab works offline and the
  // pictures do not change with each real release
  function github(u) {
    const m = /^\/repos\/([^/]+)\/([^/]+)\/releases(\/latest)?$/.exec(u.pathname);
    if (u.hostname !== 'api.github.com' || !m) return reply({ message: 'Demo: not available' }, 404, 'application/json');
    const base = 'https://github.com/' + m[1] + '/' + m[2] + '/releases/download/';
    const rels = m[2] === 'stm32-sine'
      ? [{ tag_name: 'v5.35.R', assets: [{ name: 'stm32_sine.bin' }, { name: 'stm32_foc.bin' }] }]
      : D.releases.map(tag => ({ tag_name: tag, assets: ['esp32', 'esp32s3'].flatMap(chip =>
          [chip + '_' + tag + '-ota.bin', chip + '_' + tag + '-0x000.bin'].map(n => ({ name: n }))) }));
    for (const r of rels) for (const a of r.assets) a.browser_download_url = base + r.tag_name + '/' + a.name;
    return reply(m[3] ? rels[0] : rels, 200, 'application/json');
  }

  window.fetch = async function (input, init) {
    const u = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (u.origin === location.origin) {
      const res = await device(u, init);
      if (res) return res;
      return realFetch(BASE + appPath(u).slice(1) + u.search, init);
    }
    if (u.hostname === 'api.github.com') return github(u);
    // Release downloads, the openinverter.org parameter database: not from a demo
    return reply(DEMO_NO, 503);
  };

  // SSE value stream (the firmware's listener on :81)
  class DemoEventSource {
    constructor(url) {
      const u = new URL(url, location.href);
      this.url = url;
      this.readyState = 1;
      this.onmessage = null;
      this.onerror = null;
      this.onopen = null;
      this._listeners = [];
      const names = u.searchParams.get('names') || '';
      let ms = parseInt(u.searchParams.get('ms')) || 100;
      ms = Math.max(50, Math.min(5000, ms));
      const tick = () => {
        const out = settings.can_mode ? canCommand('get ' + names) : uartCommand('get ' + names);
        const ev = { data: out.replace(/[\r\n]/g, ' ') };
        if (this.onmessage) this.onmessage(ev);
        this._listeners.forEach(f => f(ev));
      };
      this._first = setTimeout(tick, 0);
      this._timer = setInterval(tick, ms);
    }
    addEventListener(type, f) { if (type === 'message') this._listeners.push(f); }
    removeEventListener(type, f) { this._listeners = this._listeners.filter(x => x !== f); }
    close() { this.readyState = 2; clearTimeout(this._first); clearInterval(this._timer); }
  }
  window.EventSource = DemoEventSource;

  // The ESP OTA upload (the app's only XMLHttpRequest): shows progress, flashes nothing
  class DemoXHR {
    constructor() { this.upload = {}; this.status = 0; this.responseText = ''; this.readyState = 0; }
    open(method, url) { this._url = url; this.readyState = 1; }
    setRequestHeader() {}
    abort() {}
    send() {
      let pct = 0;
      const step = () => {
        pct += 25;
        if (this.upload.onprogress) this.upload.onprogress({ lengthComputable: true, loaded: pct, total: 100 });
        if (pct < 100) { setTimeout(step, 150); return; }
        this.status = 200;
        this.readyState = 4;
        this.responseText = JSON.stringify({ ok: false, message: DEMO_NO + ' (no image is flashed)' });
        notice('the uploaded image was not flashed');
        if (this.onload) this.onload();
      };
      setTimeout(step, 150);
    }
  }
  window.XMLHttpRequest = DemoXHR;

  // No service worker: the demo is a page, not an installable app
  try {
    if (navigator.serviceWorker) {
      Object.defineProperty(navigator.serviceWorker, 'register', { configurable: true, value: () => Promise.reject(new Error('demo')) });
    }
  } catch (e) {}

  // Links into the device's own pages (/remote.html ...) live under BASE here
  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a[href^="/"]') : null;
    if (a && !a.getAttribute('href').startsWith('//')) a.setAttribute('href', BASE + a.getAttribute('href').slice(1));
  }, true);

  // Say so on every page
  const banner = () => {
    if (document.getElementById('oi-demo-banner')) return;
    const bar = document.createElement('div');
    bar.id = 'oi-demo-banner';
    bar.setAttribute('role', 'note');
    bar.innerHTML = '<b>Live demo</b> · a simulated inverter, not a real device. Nothing is saved: reload to start again. ' +
      '<a href="flash/">Install on your ESP32</a>' +
      ' · <a href="https://github.com/wjcloudy/esp32-web-interface" target="_blank" rel="noopener">GitHub</a>';
    document.documentElement.appendChild(bar);
    // The app's fixed chrome starts below the banner, however many lines it wraps to
    const fit = () => document.documentElement.style.setProperty('--oi-demo-h', bar.offsetHeight + 'px');
    fit();
    if (window.ResizeObserver) new ResizeObserver(fit).observe(bar);
  };
  if (document.body) banner(); else document.addEventListener('DOMContentLoaded', banner);

  window.OI_DEMO = { files, params, settings, simNow };
})();
