// Mock ESP32 web-interface backend for E2E tests.
//
// Serves the real frontend from data/ and implements the firmware's HTTP API
// (esp32-web-interface.ino) backed by a simulated inverter. Reply formats,
// status codes and argument handling follow the firmware handlers — when the
// firmware changes a reply, change it here too, or the E2E suite is testing
// the UI against a device that doesn't exist. Dependency-free (node:http) so
// `npm ci` stays small and fast in CI.
//
// Two transports, like the firmware:
//   UART mode  /cmd is forwarded to a simulated inverter terminal speaking
//              PROTOCOL.md (free-text replies, `get` = one value per line,
//              `&repeat=N` = N+1 sample groups, commands cut at 128 chars).
//   CAN mode   /cmd is answered by the firmware's own CAN command layer
//              (canExecuteCommand): tab-separated `get`, terse replies,
//              `can list` JSON, `json` carries "can_cache":true, no repeat.
//
// The SSE value stream lives on its OWN port (the firmware's raw-TCP
// listener on :81), advertised through /settings `sse_port`.
//
// Test introspection endpoints (not present on real hardware):
//   GET  /__test/commands        -> JSON array of every inverter command received
//   GET  /__test/state           -> full mock state dump
//   POST /__test/reset           -> restore pristine state
//   POST /__test/fw-status       -> body sets the /fwupdate-status reply (CAN OTA)
//   POST /__test/put-file?name=  -> seed a SPIFFS file (raw body)
//   GET  /__test/spot?name=&value= -> drive a spot value
//   POST /__test/otainfo         -> merge JSON body into the /otainfo reply
//                                   (its version is also what /version reports)
//   GET  /__test/set-arch?a=     -> reported board arch (blank = omit)
//   GET  /__test/add-value?name=&value=&unit= -> add a spot value
//   GET  /__test/can-cache?loaded=0|1 -> CAN param cache state (0 = device offline)
//   GET  /__test/sse?mode=on|off|404  -> SSE listener: normal / port closed / refuse
//   GET  /__test/add-user?name=&password=&role= -> create an account directly
//   GET  /__test/clock?advance=ms    -> move the mock's clock (session expiry)
//   GET  /__test/auth-reset          -> the BOOT-button / serial lockout recovery
//
// Users & sign-in (auth.mjs) follow the firmware: off with no users; with
// users every request passes the same permission table, sessions are
// HttpOnly SameSite=Strict cookies (or Bearer), state changes need the
// X-OI-Auth header or a same-host Origin, and /cmd answers without CORS.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URLSearchParams } from 'node:url';
import {
  createAuth, PERM, methodBit, findRoute, staticPerm, filePerm, cmdPerm, csrfOk, originHostMatches,
  cookieValue, bearerToken, PASSWORD_MIN, PASSWORD_MAX, USER_MAX, SESSION_REMEMBER_IDLE_MS,
} from './auth.mjs';

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');

const MIME = {
  '.html': 'text/html', '.htm': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
};

// Firmware limits (esp32-web-interface.ino)
const UART_CMD_MAX = 128;     // handleCommand: cmd.substring(0, cmdBufSize)
const CAN_CMD_MAX = 1024;     // handleCommand (CAN): substring(0, 1024)
const REPEAT_MAX = 100;       // handleCommand: repeat clamped to 0..100
const CAN_NODE_ID_MIN = 1, CAN_NODE_ID_MAX = 127;
const CAN_INDEX_MAP_RD = 0x3100, CAN_INDEX_MAP_RD_RX = 0x3180;

// Arduino String::toInt(): leading integer, 0 when there is none
const toInt = (s) => { const n = parseInt(s, 10); return isNaN(n) ? 0 : n; };
// Arduino String(float, 2)
const fmt2 = (v) => Number(v).toFixed(2);

// Representative inverter model (stm32-sine-like), matching the schema in
// PROTOCOL.md: parameters carry isparam/min/max/default/category, spot values
// don't. Enum-typed values encode their mapping in `unit`. Every entry has a
// param `id` (libopeninv's json does, and CAN mode can't read a value
// without one).
function freshInverterState() {
  return {
    params: {
      fweak:    { unit: 'Hz', value: 67.0, isparam: true, minimum: 0, maximum: 400, default: 67, category: 'Motor (sine)', i: 0, id: 1 },
      boost:    { unit: 'dig', value: 1700, isparam: true, minimum: 0, maximum: 37813, default: 1700, category: 'Motor (sine)', i: 1, id: 2 },
      polepairs:{ unit: '', value: 2, isparam: true, minimum: 1, maximum: 16, default: 2, category: 'Motor', i: 2, id: 3 },
      udcmin:   { unit: 'V', value: 450, isparam: true, minimum: 0, maximum: 1000, default: 450, category: 'Voltage', i: 3, id: 4 },
      udcmax:   { unit: 'V', value: 520, isparam: true, minimum: 0, maximum: 1000, default: 520, category: 'Voltage', i: 4, id: 5 },
      dirmode:  { unit: '0=Button, 1=Switch, 2=ButtonReversed, 3=SwitchReversed, 4=DefaultForward', value: 1, isparam: true, minimum: 0, maximum: 4, default: 1, category: 'Derate', i: 5, id: 6 },
      potmin:   { unit: 'dig', value: 0, isparam: true, minimum: 0, maximum: 4095, default: 0, category: 'Throttle', i: 6, id: 7 },
      potmax:   { unit: 'dig', value: 4095, isparam: true, minimum: 0, maximum: 4095, default: 4095, category: 'Throttle', i: 7, id: 8 },
      // RTC clock setting — always differs from default; preset capture must skip it
      Set_Hour: { unit: 'Hours', value: 9, isparam: true, minimum: 0, maximum: 23, default: 0, category: 'Clock', i: 8, id: 9 },
    },
    spot: {
      version: { unit: '4=5.27.R-sine', value: 4, isparam: false, id: 2000 },
      opmode:  { unit: '0=Off, 1=Run, 2=ManualRun, 3=Boost, 4=Buck, 5=Sine, 6=AcHeat, 7=Chademo', value: 0, isparam: false, id: 2001 },
      status:  { unit: '0=None, 1=UdcLow, 2=UdcHigh, 4=UdcBelowUdcSw, 8=UdcLim, 16=EmcyStop, 32=MProt, 64=PotPressed, 128=TmpHs, 256=WaitStart', value: 0, isparam: false, id: 2002 },
      lasterr: { unit: '0=NONE, 1=OVERCURRENT, 2=THROTTLE1', value: 0, isparam: false, id: 2003 },
      udc:     { unit: 'V', value: 398.5, isparam: false, id: 2004 },
      tmphs:   { unit: '°C', value: 31.2, isparam: false, id: 2005 },
      speed:   { unit: 'rpm', value: 0, isparam: false, id: 2006 },
      pot:     { unit: 'dig', value: 0, isparam: false, id: 2007 },
    },
  };
}

// Defaults of the firmware's settings globals (loadSettings with no file)
function freshSettings() {
  return {
    dev_name: '', txrx_swapped: false, uart_rx_pin: 1, uart_tx_pin: 3, ap_fallback: false,
    can_mode: false, can_node_id: 1, can_speed: 2, can_rx_pin: 4, can_tx_pin: 5,
    can_pwr_pin: -1, can_pwr_inv: false, can_en_pin: -1, can_en_inv: false, arch: 'esp32',
  };
}

export function createMockEsp({ port = 0, ssePort = 0 } = {}) {
  let inverter = freshInverterState();
  let files = new Map(); // SPIFFS stand-in: name (no leading '/') -> Buffer
  let commandLog = [];
  let settings = freshSettings();
  let canNodes = null; // the can_nodes array persisted in settings.json (raw JSON text)
  let canMap = [];     // CAN-mode mappings: { isrx, cobid, paramid, position, length, gain, offset }
  let canCacheLoaded = true;
  let fwStatus = { state: 0 }; // /fwupdate-status reply, scriptable via /__test/fw-status
  let otainfo = { version: 'v0.1-mock', repo: 'https://github.com/wjcloudy/esp32-web-interface', target: 'esp32' };
  let uartPages = 4; // pages reported for the UART-mode fwupdate flow
  let fwSteps = []; // every step passed to /fwupdate, in order
  let otaFlashes = 0; // web-interface OTA images accepted by /espupdate
  let wifi = { apSSID: 'inverter', staSSID: 'mocknet' }; // what WiFi.softAPSSID()/SSID() report
  let sseMode = 'on';
  let sseRes = null; // the one live stream (firmware: newest stream wins)
  let clockOffset = 0;
  const now = () => Date.now() + clockOffset;
  const auth = createAuth(now);

  const allValues = () => ({ ...inverter.params, ...inverter.spot });
  const findParamByName = (name) => allValues()[name];

  // Virtual spot values (CAN mode): ESP-side RX mappings from /virtualvals.json
  function virtualItems() {
    const f = files.get('virtualvals.json');
    if (!f) return [];
    try {
      const d = JSON.parse(f.toString());
      return Array.isArray(d.items) ? d.items.slice(0, 16) : [];
    } catch (e) { return []; }
  }

  // ---------------- UART: simulated inverter terminal (PROTOCOL.md) ----------------
  function uartCommand(cmd) {
    const [verb, ...rest] = cmd.split(' ');
    const args = rest.join(' ');
    switch (verb) {
      case 'json':
        return JSON.stringify(allValues());
      case 'set': {
        const sp = args.indexOf(' ');
        if (sp < 0) return 'Usage: set name value';
        const name = args.slice(0, sp);
        const value = parseFloat(args.slice(sp + 1));
        const p = inverter.params[name];
        if (!p) return 'Unknown parameter';
        if (isNaN(value) || value < p.minimum || value > p.maximum) return 'Value out of range';
        p.value = value;
        return 'Set OK';
      }
      case 'get':
        // One value per line, in request order
        return args.split(',').map(n => {
          const v = findParamByName(n.trim());
          return v === undefined ? 'Unknown parameter' : fmt2(v.value);
        }).join('\n') + '\n';
      case 'stream': {
        // stream <reps> <a,b,...> — one CSV line per repetition
        const [reps, names] = args.split(' ');
        const line = () => (names || '').split(',').map(n => {
          const v = findParamByName(n.trim());
          return v === undefined ? '0' : fmt2(v.value);
        }).join(',');
        return Array.from({ length: Math.min(parseInt(reps) || 1, 100) }, line).join('\n') + '\n';
      }
      case 'save': return 'Parameters saved';
      case 'load': return 'Parameters loaded';
      case 'defaults':
        for (const n in inverter.params) inverter.params[n].value = inverter.params[n].default;
        return 'Defaults restored';
      case 'errors': return 'No errors';
      case 'start': return 'Starting in mode ' + args;
      case 'stop': return 'Stopped';
      case 'reset': return 'Resetting';
      case 'fastuart': return 'OK fast uart on';
      default: return 'Unknown command: ' + verb;
    }
  }

  // ---------------- CAN: the firmware's canExecuteCommand() ----------------
  function canListJson() {
    // Firmware walks read indices per direction: one index per COB ID,
    // items at odd subindices (1, 3, 5 ...)
    const out = [];
    for (const isrx of [false, true]) {
      const ids = [...new Set(canMap.filter(m => m.isrx === isrx).map(m => m.cobid))];
      ids.forEach((cobid, msgIdx) => {
        const index = (isrx ? CAN_INDEX_MAP_RD_RX : CAN_INDEX_MAP_RD) + msgIdx;
        canMap.filter(m => m.isrx === isrx && m.cobid === cobid).forEach((m, itemIdx) => {
          out.push({
            isrx, id: cobid, paramid: m.paramid, position: m.position, length: m.length,
            gain: Number(m.gain.toFixed(3)), offset: m.offset, index, subindex: 1 + itemIdx * 2,
          });
        });
      });
    }
    return JSON.stringify(out);
  }

  function canCommand(cmd) {
    if (!canCacheLoaded) {
      // Cache not downloaded (device offline): minimal json, no can_cache flag
      if (cmd === 'json') return '{"status":{"value":0,"isparam":false,"unit":""},"opmode":{"value":0,"isparam":false,"unit":""}}';
    }
    if (cmd === 'json') {
      const obj = {};
      for (const [n, v] of Object.entries(allValues())) obj[n] = { ...v, value: Number(fmt2(v.value)) };
      for (const vi of virtualItems()) obj[vi.name] = { unit: String(vi.unit || ''), isparam: false, virtual: true, value: 0 };
      if (canCacheLoaded) obj.can_cache = true;
      return JSON.stringify(obj);
    }
    if (cmd.startsWith('get ')) {
      const names = cmd.slice(4).split(',');
      let result = '';
      names.slice(0, 128).forEach((raw, idx) => {
        const name = raw.trim();
        if (!name) return;
        const v = findParamByName(name);
        result += canCacheLoaded && v ? fmt2(v.value) : '0.00';
        if (idx < names.length - 1) result += '\t';
      });
      return result;
    }
    if (cmd.startsWith('set ')) {
      const rest = cmd.slice(4);
      const sp = rest.indexOf(' ');
      if (sp <= 0) return 'error';
      const name = rest.slice(0, sp);
      const value = parseFloat(rest.slice(sp + 1)) || 0; // String::toFloat
      const p = inverter.params[name];
      if (!p || !canCacheLoaded) return 'Unknown parameter';
      if (value < p.minimum || value > p.maximum) return 'Value out of range';
      p.value = value;
      return 'Set OK';
    }
    if (cmd === 'start 2' || cmd === 'start') return 'started';
    if (cmd === 'stop') return 'stopped';
    if (cmd === 'reset') return 'reset sent';
    if (cmd === 'save') return 'saved';
    if (cmd === 'load') return 'loaded';
    if (cmd === 'errors') return 'No errors logged.';
    if (cmd === 'fastuart') return 'ok';
    if (cmd.startsWith('can ')) {
      const rest = cmd.slice(4).trim();
      if (rest === 'clear') { canMap = []; return 'cleared'; }
      if (rest.startsWith('list')) return canListJson();
      if (rest.startsWith('rm ')) {
        const a = rest.slice(3).split(' ');
        if (a.length < 2) return 'error: usage: can rm index subindex';
        const index = toInt(a[0]), sub = toInt(a[1]);
        const entry = JSON.parse(canListJson()).find(m => m.index === index && m.subindex === sub);
        if (!entry) return 'error: remove failed';
        canMap = canMap.filter(m => !(m.isrx === entry.isrx && m.cobid === entry.id && m.paramid === entry.paramid && m.position === entry.position));
        return 'ok';
      }
      // can tx/rx name canid pos bits gain [offset]
      const usage = 'error: usage: can tx/rx name canid pos bits gain';
      const a = rest.split(' ');
      if (a.length < 2 || (a[0] !== 'tx' && a[0] !== 'rx')) return usage;
      if (a.length < 3) return 'error: missing arguments';
      if (a.length < 4) return 'error: missing canid';
      if (a.length < 5) return 'error: missing pos';
      const entry = findParamByName(a[1]);
      if (!entry) return 'error: unknown parameter';
      canMap.push({
        isrx: a[0] === 'rx', cobid: Number(a[2]) || 0, paramid: entry.id,
        position: toInt(a[3]), length: toInt(a[4]),
        gain: a[5] !== undefined ? (parseFloat(a[5]) || 0) : 1, offset: a[6] !== undefined ? toInt(a[6]) : 0,
      });
      return 'ok';
    }
    return 'unknown command';
  }

  // Minimal multipart/form-data parser: returns [{name, filename, data}]
  function parseMultipart(body, contentType) {
    const m = /boundary=(.+)$/.exec(contentType || '');
    if (!m) return [];
    const boundary = Buffer.from('--' + m[1]);
    const parts = [];
    let start = body.indexOf(boundary);
    while (start !== -1) {
      const next = body.indexOf(boundary, start + boundary.length);
      if (next === -1) break;
      const segment = body.subarray(start + boundary.length + 2, next - 2); // trim CRLFs
      const headerEnd = segment.indexOf('\r\n\r\n');
      if (headerEnd !== -1) {
        const headers = segment.subarray(0, headerEnd).toString();
        const nameM = /name="([^"]*)"/.exec(headers);
        const fileM = /filename="([^"]*)"/.exec(headers);
        parts.push({
          name: nameM ? nameM[1] : '',
          filename: fileM ? fileM[1] : null,
          data: segment.subarray(headerEnd + 4),
        });
      }
      start = next;
    }
    return parts;
  }

  function sendStatic(res, urlPath) {
    let rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\//, '');
    if (rel.includes('..')) { res.writeHead(400); res.end(); return true; }
    const abs = path.join(DATA_DIR, rel);
    const type = MIME[path.extname(rel)] || 'application/octet-stream';
    // Explicit Content-Length (not chunked) so many concurrent keep-alive
    // requests for the vendor scripts can't misframe under parallel test load
    // — a truncated preact-hooks.umd.js would leave `preactHooks` undefined.
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      const buf = fs.readFileSync(abs);
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length });
      res.end(buf);
      return true;
    }
    if (fs.existsSync(abs + '.gz')) { // gz-only assets, served like the ESP does
      const buf = fs.readFileSync(abs + '.gz');
      res.writeHead(200, { 'Content-Type': type, 'Content-Encoding': 'gzip', 'Content-Length': buf.length });
      res.end(buf);
      return true;
    }
    return false;
  }

  // handleFileRead(): an uploaded SPIFFS file, else the data/ image
  function fileRead(res, urlPath) {
    const uploaded = files.get(urlPath.replace(/^\//, ''));
    if (uploaded !== undefined) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(urlPath)] || 'text/plain', 'Content-Length': uploaded.length });
      res.end(uploaded);
      return true;
    }
    return sendStatic(res, urlPath);
  }

  const dataFileText = (name) => {
    try { return fs.readFileSync(path.join(DATA_DIR, name), 'utf8'); } catch (e) { return ''; }
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const q = url.searchParams;
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      // WebServer: a urlencoded body's fields join the query arguments
      if ((req.headers['content-type'] || '').startsWith('application/x-www-form-urlencoded')) {
        for (const [k, v] of new URLSearchParams(body.toString())) q.append(k, v);
      }
      // Firmware sends CORS only on /cmd and only with sign-in off; the mock
      // has always sent it everywhere with sign-in off (harmless for tests)
      const send = (code, s, type = 'text/plain', extra = {}) => {
        res.writeHead(code, { 'Content-Type': type, ...(auth.enabled() ? {} : { 'Access-Control-Allow-Origin': '*' }), ...extra });
        res.end(s);
      };
      const text = (s, type = 'text/plain') => send(200, s, type);
      const json = (o, type = 'application/json') => text(typeof o === 'string' ? o : JSON.stringify(o), type);
      // server.arg(0): the firmware's file handlers take the FIRST argument, whatever its name
      const firstArg = () => { for (const [, v] of q) return v; return null; };
      // Accept SPIFFS paths with or without the leading '/'
      const fileKey = (s) => String(s).replace(/^\/+/, '');

      // --- test introspection ---
      if (p === '/__test/commands') return json(commandLog);
      if (p === '/__test/state') return json({ inverter, files: [...files.keys()], settings, canNodes, canMap, commandLog, fwSteps, otaFlashes, wifi, sseOpen: sseRes !== null,
        users: auth.users().map(u => ({ name: u.name, role: u.role })), sessions: auth.sessionCount(), otaRunning: !auth.enabled() });
      if (p === '/__test/add-user') {
        const err = auth.add(q.get('name'), q.get('password'), q.get('role') || 'viewer');
        return err ? send(400, err) : text('ok');
      }
      if (p === '/__test/clock') { clockOffset += toInt(q.get('advance')); return text(String(clockOffset)); }
      if (p === '/__test/auth-reset') { auth.clear(); return text('ok'); }
      if (p === '/__test/reset') {
        auth.clear(); clockOffset = 0;
        inverter = freshInverterState(); files = new Map(); commandLog = []; fwSteps = []; otaFlashes = 0;
        settings = freshSettings(); canNodes = null; wifi = { apSSID: 'inverter', staSSID: 'mocknet' }; canMap = []; canCacheLoaded = true; sseMode = 'on';
        fwStatus = { state: 0 };
        return text('reset');
      }
      if (p === '/__test/fw-status') { fwStatus = JSON.parse(body.toString() || '{}'); return text('ok'); }
      if (p === '/__test/put-file') { // seed a SPIFFS file directly (raw body)
        files.set(fileKey(q.get('name') || 'file'), body);
        return text('ok');
      }
      if (p === '/__test/spot') { // drive a spot value from a test
        const sv = inverter.spot[q.get('name')];
        if (sv) sv.value = parseFloat(q.get('value'));
        return text(sv ? 'ok' : 'unknown');
      }
      if (p === '/__test/add-value') { // add a spot value (e.g. long names for 128-char limits)
        const name = q.get('name');
        if (!name) return send(400, 'name required');
        const ids = Object.values(allValues()).map(v => v.id || 0);
        inverter.spot[name] = { unit: q.get('unit') || '', value: parseFloat(q.get('value') || '0'), isparam: false, id: Math.max(...ids) + 1 };
        return text('ok');
      }
      if (p === '/__test/otainfo') { // override the board target etc.
        Object.assign(otainfo, JSON.parse(body.toString() || '{}'));
        return text('ok');
      }
      if (p === '/__test/set-arch') { // set the reported board arch, or omit it (blank)
        const a = q.get('a');
        if (a) settings.arch = a; else delete settings.arch;
        return text('ok');
      }
      if (p === '/__test/can-cache') { canCacheLoaded = q.get('loaded') !== '0'; return text('ok'); }
      if (p === '/__test/sse') {
        const mode = q.get('mode') || 'on';
        if (!['on', 'off', '404'].includes(mode)) return send(400, 'bad mode');
        sseMode = mode;
        if (mode !== 'on' && sseRes) { sseRes.destroy(); sseRes = null; }
        return text('ok');
      }

      // --- the firmware's router: every request passes the permission check ---
      const mb = methodBit(req.method);
      let slot = -1, bearer = false, me = null;
      if (auth.enabled()) {
        let tok = bearerToken(req.headers.authorization);
        bearer = !!tok;
        if (!tok) tok = cookieValue(req.headers.cookie, 'oisess');
        const sl = tok ? auth.findSession(tok) : -1;
        if (sl >= 0) {
          const ss = auth.session(sl);
          const ui = auth.find(ss.user);
          if (ui < 0 || auth.users()[ui].gen !== ss.userGen) auth.revoke(sl);
          else { slot = sl; me = auth.users()[ui]; }
        }
      }
      const role = !auth.enabled() ? 'admin' : (me ? me.role : 'none');
      const csrf = () => !auth.enabled() || csrfOk(bearer, req.headers.origin, req.headers.referer, req.headers['x-oi-auth'], req.headers.host);
      const refuse = (code, error, need) => {
        res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(need ? { error, need } : { error }));
      };
      // 0 = allowed, else the refusal was sent (authCheck)
      const check = (need) => {
        if (need === PERM.DENY) { send(404, 'FileNotFound'); return 404; }
        if (!auth.enabled() || need === PERM.PUBLIC) return 0;
        if (slot < 0) { refuse(401, 'sign-in required'); return 401; }
        if ((({ viewer: 1, operator: 2, admin: 3 })[role] || 0) < need) { refuse(403, 'your account cannot do this', auth.permRoleName(need)); return 403; }
        if (need >= PERM.WRITE && !csrf()) { refuse(403, 'cross-site request refused'); return 403; }
        return 0;
      };
      const rule = findRoute(mb, p);
      let need = rule ? rule[2] : staticPerm(p);
      if (need === PERM.CMD) need = cmdPerm((q.get('cmd') || '').slice(0, settings.can_mode ? CAN_CMD_MAX : UART_CMD_MAX));
      let uploads = null;
      if (need === PERM.FILE) {
        need = PERM.WRITE;
        if (mb === 2) {
          // Uploads are checked per file, at UPLOAD_FILE_START: allowed files
          // are written, the reply is the first refusal
          uploads = parseMultipart(body, req.headers['content-type']).filter(pt => pt.filename);
        } else {
          const fa = firstArg();
          if (fa !== null) need = Math.max(need, filePerm(fa));
        }
      }
      if (uploads) {
        let refusedNeed = null;
        for (const part of uploads) {
          const pn = Math.max(PERM.WRITE, filePerm(part.filename));
          if (!auth.enabled() || (slot >= 0 && (({ viewer: 1, operator: 2, admin: 3 })[role] || 0) >= pn && pn !== PERM.DENY && (pn < PERM.WRITE || csrf()))) part.allowed = true;
          else if (refusedNeed === null) refusedNeed = pn;
        }
        if (refusedNeed !== null) {
          for (const part of uploads) if (part.allowed) files.set(fileKey(part.filename), part.data);
          return check(refusedNeed);
        }
      }
      if (check(need)) return;
      // No route serves this method+path: the static file handler
      if (!rule) {
        if (fileRead(res, p)) return;
        return send(404, 'FileNotFound', 'text/plain', { Refresh: '6; url=/update' });
      }

      // --- sign-in endpoints ---
      const setCookie = (token, remember) => 'oisess=' + token + '; Path=/; HttpOnly; SameSite=Strict' + (remember ? '; Max-Age=' + SESSION_REMEMBER_IDLE_MS / 1000 : '');
      const startSession = (u, remember, extra) => {
        const { slot: s2, token } = auth.createSession(u.name, u.gen, remember);
        slot = s2; me = u;
        extra['Set-Cookie'] = setCookie(token, remember);
        if (q.get('token') === '1') extra['X-OI-Token'] = token;
      };
      const ok = (o, extra = {}) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra }); res.end(JSON.stringify(o)); };
      const ipOf = req.socket.remoteAddress || '';
      if (p === '/auth/state') {
        const o = { enabled: auth.enabled() };
        if (auth.enabled() && slot >= 0) Object.assign(o, { user: me.name, role: me.role, remember: auth.session(slot).remember });
        else if (!auth.enabled()) Object.assign(o, { user: null, role: 'admin' });
        else Object.assign(o, { user: null, role: null });
        o.password_min = PASSWORD_MIN;
        return ok(o);
      }
      if (p === '/auth/login') {
        if (!auth.enabled()) return refuse(400, 'sign-in is off: no users are set up');
        if (!csrf()) return refuse(403, 'cross-site request refused');
        const name = (q.get('user') || '').slice(0, 40).trim().toLowerCase();
        const pw = (q.get('password') || '').slice(0, PASSWORD_MAX + 1);
        const wait = auth.allowed(ipOf, name);
        if (wait) { res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(wait) }); return res.end('{"error":"too many attempts, wait a few minutes"}'); }
        const i = auth.verify(name, pw);
        if (i < 0) { auth.failure(ipOf, name); return refuse(401, 'incorrect user name or password'); }
        auth.success(ipOf);
        const extra = {};
        const u = auth.users()[i];
        startSession(u, q.get('remember') === '1', extra);
        return ok({ ok: true, user: { name: u.name, role: u.role } }, extra);
      }
      if (p === '/auth/logout') {
        if (!csrf()) return refuse(403, 'cross-site request refused');
        if (slot >= 0) auth.revoke(slot);
        return ok({ ok: true }, { 'Set-Cookie': 'oisess=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' });
      }
      if (p === '/auth/password') {
        if (!auth.enabled() || slot < 0) return refuse(400, 'sign-in is off');
        if (!csrf()) return refuse(403, 'cross-site request refused');
        const wait = auth.allowed(ipOf, me.name);
        if (wait) { res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(wait) }); return res.end('{"error":"too many attempts, wait a few minutes"}'); }
        if (auth.verify(me.name, (q.get('old') || '').slice(0, PASSWORD_MAX + 1)) < 0) { auth.failure(ipOf, me.name); return refuse(403, 'current password is incorrect'); }
        const remember = auth.session(slot).remember;
        const err = auth.setPassword(me.name, q.get('new') || '');
        if (err) return refuse(400, err);
        auth.revokeUser(me.name);
        const extra = {};
        startSession(auth.users()[auth.find(me.name)], remember, extra);
        return ok({ ok: true }, extra);
      }
      if (p === '/auth/users') {
        if (req.method !== 'POST') return ok({ enabled: auth.enabled(), me: me ? me.name : null, max: USER_MAX, users: auth.users().map(u => ({ name: u.name, role: u.role })) });
        if (!csrf()) return refuse(403, 'cross-site request refused');
        const op = q.get('op'), name = (q.get('user') || '').slice(0, 40).trim().toLowerCase(), r = q.get('role') || '';
        const actor = me ? me.name : null;
        const wasEnabled = auth.enabled();
        let err;
        if (op === 'add') err = !wasEnabled && r !== 'admin' ? 'the first user must be an admin' : auth.add(name, q.get('password') || '', r);
        else if (op === 'remove') { err = auth.remove(name, actor); if (!err) auth.revokeUser(name); }
        else if (op === 'role') { err = auth.setRole(name, r, actor); if (!err) auth.revokeUser(name); }
        else if (op === 'password') { err = auth.setPassword(name, q.get('password') || ''); if (!err) auth.revokeUser(name); }
        else return refuse(400, 'op must be add, remove, role or password');
        if (err) return refuse(auth.resultStatus(err), err);
        const extra = {};
        if (!wasEnabled && auth.enabled()) {
          auth.revokeAll();
          if (sseRes) { sseRes.destroy(); sseRes = null; }
          startSession(auth.users()[auth.find(name)], false, extra);
        } else if (actor && (op === 'password' || op === 'role') && name === actor) {
          const mi = auth.find(actor);
          if (mi >= 0) startSession(auth.users()[mi], false, extra);
        }
        return ok({ ok: true }, extra);
      }
      if (p === '/auth/stream-ticket') {
        if (!auth.enabled()) return ok({ ticket: '' });
        const t = auth.issueTicket(slot);
        return t ? ok({ ticket: t }) : refuse(401, 'sign-in required');
      }
      if (p === '/update') {
        if (req.method === 'GET') return text('<form method="POST" enctype="multipart/form-data"><input type="file" name="firmware"></form>', 'text/html');
        return text('Update error: mock flashes nothing', 'text/html');
      }

      // --- firmware API ---
      if (p === '/cmd') {
        if (!q.has('cmd')) return send(500, 'BAD ARGS');
        if (settings.can_mode) {
          // CAN mode ignores &repeat: one sample group per request
          const cmd = q.get('cmd').slice(0, CAN_CMD_MAX);
          commandLog.push(cmd);
          return text(canCommand(cmd), 'text/json');
        }
        const cmd = q.get('cmd').slice(0, UART_CMD_MAX);
        let repeat = q.has('repeat') ? toInt(q.get('repeat')) : 0;
        repeat = Math.max(0, Math.min(REPEAT_MAX, repeat));
        // The inverter repeats the last command on each '!': N+1 replies
        commandLog.push(cmd);
        let out = uartCommand(cmd);
        for (let i = 0; i < repeat; i++) out += uartCommand(cmd);
        return text(out, 'text/json');
      }

      if (p === '/edit') {
        if (req.method === 'GET') { // load editor
          if (!fileRead(res, '/edit.htm')) send(404, 'FileNotFound');
          return;
        }
        if (req.method === 'POST') { // multipart upload, stored under the part's filename
          for (const part of uploads || []) files.set(fileKey(part.filename), part.data);
          return text('');
        }
        if (req.method === 'PUT' || req.method === 'DELETE') { // handleFileCreate / handleFileDelete
          const arg = firstArg();
          if (arg === null) return send(500, 'BAD ARGS');
          if (arg === '/') return send(500, 'BAD PATH');
          const key = fileKey(arg);
          if (req.method === 'PUT') {
            if (files.has(key)) return send(500, 'FILE EXISTS');
            files.set(key, Buffer.alloc(0));
            return text('');
          }
          if (!files.has(key)) return send(404, 'FileNotFound');
          files.delete(key);
          return text('');
        }
      }
      if (p === '/list' && req.method === 'GET') {
        return json([...files.keys()].map(name => ({ type: 'file', name })), 'text/json');
      }

      // UI layout files: stored file, else firmware defaults
      const layoutDefaults = {
        '/favorites.json': '{"p":[],"s":[]}',
        '/gauges.json': '{"items":[]}',
        '/plots.json': '{"plots":[]}',
        '/virtualvals.json': '{"items":[]}',
      };
      if (p in layoutDefaults) {
        const f = files.get(p.slice(1));
        return json(f ? f.toString() : layoutDefaults[p]);
      }

      if (p === '/settings') {
        // handleSettings: ONE setting group per request, first match wins
        const ok = () => text('{"result":"ok"}', 'text/json');
        const mayWrite = req.method === 'POST' || !auth.enabled();
        if (mayWrite && q.has('txrx_swap')) {
          settings.txrx_swapped = q.get('txrx_swap') === '1';
          settings.uart_tx_pin = settings.txrx_swapped ? 3 : 1;
          settings.uart_rx_pin = settings.txrx_swapped ? 1 : 3;
          return ok();
        }
        if (mayWrite && q.has('reset_settings')) {
          // cfgResetAll(): device config back to defaults (file + NVS copy),
          // users/Wi-Fi/layouts untouched; the device then reboots
          settings = freshSettings(); canNodes = null;
          files.delete('settings.json'); files.delete('uiprefs.json');
          return text('{"result":"ok","rebooting":true}', 'text/json');
        }
        if (mayWrite && q.has('dev_name')) { settings.dev_name = q.get('dev_name').slice(0, 32); return ok(); }
        if (mayWrite && q.has('ap_fallback')) { settings.ap_fallback = q.get('ap_fallback') === '1'; return ok(); }
        if (mayWrite && q.has('can_mode')) {
          const s = settings;
          s.can_mode = q.get('can_mode') === '1';
          for (const k of ['can_node_id', 'can_speed', 'can_rx_pin', 'can_tx_pin', 'uart_rx_pin', 'uart_tx_pin'])
            if (q.has(k)) s[k] = toInt(q.get(k));
          // Optional transceiver enable pins: blank string → -1 (unused)
          for (const k of ['can_pwr_pin', 'can_en_pin'])
            if (q.has(k)) { const v = q.get(k); s[k] = v === '' ? -1 : toInt(v); }
          for (const k of ['can_pwr_inv', 'can_en_inv'])
            if (q.has(k)) s[k] = q.get(k) === '1';
          // Firmware validation/clamping
          if (s.uart_rx_pin < 0 || s.uart_rx_pin > 48) s.uart_rx_pin = 3;
          if (s.uart_tx_pin < 0 || s.uart_tx_pin > 48) s.uart_tx_pin = 1;
          if (s.can_rx_pin < 0 || s.can_rx_pin > 48) s.can_rx_pin = 4;
          if (s.can_tx_pin < 0 || s.can_tx_pin > 48) s.can_tx_pin = 5;
          if (s.can_pwr_pin < -1 || s.can_pwr_pin > 48) s.can_pwr_pin = -1;
          if (s.can_en_pin < -1 || s.can_en_pin > 48) s.can_en_pin = -1;
          s.can_node_id = Math.max(CAN_NODE_ID_MIN, Math.min(CAN_NODE_ID_MAX, s.can_node_id));
          if (s.can_speed < 0 || s.can_speed > 2) s.can_speed = 2;
          if (q.has('can_nodes')) canNodes = q.get('can_nodes');
          return ok();
        }
        // GET: the firmware's hand-built JSON (sse_port = the separate SSE listener)
        let out = JSON.stringify({ ...settings, sse_port: sseServer.address() ? sseServer.address().port : 0 });
        if (canNodes !== null) {
          try { JSON.parse(canNodes); out = out.slice(0, -1) + ',"can_nodes":' + canNodes + '}'; } catch (e) { /* unparseable: firmware would splice garbage */ }
        }
        return text(out, 'text/json');
      }
      if (p === '/wifi') {
        // handleWifi: AP change, station change, or the templated wifi.html
        if (q.has('apSSID') && q.has('apPW')) {
          const pw = q.get('apPW');
          if (pw.length > 0 && pw.length < 8)
            return send(400, 'AP update failed — password must be 8+ characters (or empty for an open AP)', 'text/html');
          wifi.apSSID = q.get('apSSID');
          return text(dataFileText('wifi-updated.html'), 'text/html');
        }
        if (q.has('staSSID') && q.has('staPW')) {
          wifi.staSSID = q.get('staSSID');
          return text(dataFileText('wifi-updated.html'), 'text/html');
        }
        const html = dataFileText('wifi.html')
          .replaceAll('%staSSID%', wifi.staSSID).replaceAll('%apSSID%', wifi.apSSID)
          .replaceAll('%staIP%', '192.168.1.42');
        return text(html, 'text/html');
      }
      if (p === '/wifi-status') return json({
        sta_connected: true, rssi: -58, ssid: 'mocknet', ip: '192.168.1.42',
        ap_active: !settings.ap_fallback, ap_clients: 0, ap_fallback: settings.ap_fallback,
      }, 'text/json');
      if (p === '/version') return text(otainfo.version); // both are WEB_VERSION on the device
      if (p === '/otainfo') return json(otainfo);
      if (p === '/fwupdate-status') return json(fwStatus);
      if (p === '/fwupdate') {
        const step = parseInt(q.get('step'));
        fwSteps.push(step);
        if (step === -1 && settings.can_mode) { fwStatus = { state: 1 }; return json({ message: 'started' }); }
        return json({ message: 'ok', pages: uartPages });
      }
      if (p === '/set-can-node') {
        if (q.has('id')) settings.can_node_id = Math.max(CAN_NODE_ID_MIN, Math.min(CAN_NODE_ID_MAX, toInt(q.get('id'))));
        return text('{"nodeId":' + settings.can_node_id + '}', 'text/json');
      }
      if (p === '/can-send') {
        if (!q.has('canId')) return send(400, '{"error":"Missing canId"}', 'text/json');
        const canId = parseInt(q.get('canId'), 16) || 0;
        const data = (q.get('data') || '').split(/[ ,]+/).filter(Boolean).slice(0, 8);
        // No CAN mode → the TWAI driver is stopped and the send fails
        const ok = settings.can_mode;
        if (ok) commandLog.push('can-send ' + q.get('canId') + ' ' + q.get('data'));
        return text(JSON.stringify({ status: ok ? 'sent' : 'failed', canId, len: data.length }), 'text/json');
      }
      if (p === '/can-scan') {
        if (!settings.can_mode) return send(400, '{"error":"CAN mode not enabled"}', 'text/json');
        return text('[{"nodeId":1,"serial":3405691582}]', 'text/json');
      }
      if (p === '/espupdate' && req.method === 'POST') {
        // A combined OTA image rewrites the whole SPIFFS partition. The
        // firmware keeps settings.json/uiprefs.json in NVS and writes them
        // back at boot (cfgBootSync), so those survive; everything else the
        // user saved is gone. (This mock's settings live in memory, so they
        // survive too, matching the device.)
        const kept = new Map();
        for (const name of ['settings.json', 'uiprefs.json']) if (files.has(name)) kept.set(name, files.get(name));
        files = kept;
        otaFlashes++;
        // The device then reboots: its session table is in RAM, so everyone
        // is signed out (accounts are in NVS and stay)
        auth.revokeAll();
        return json({ ok: true });
      }
      if (p === '/reboot') return text('Rebooting...');
      if (p === '/reset-inverter') return text('Inverter reset sent');
      if (p === '/virtual-reload') return json({ count: virtualItems().length });
      if (p === '/baud') return text('921600');

      // A table route the mock doesn't implement (rtc, sdcard, can-debug ...)
      send(404, 'FileNotFound', 'text/plain', { Refresh: '6; url=/update' });
    });
  });

  // ---------------- SSE value stream (firmware: raw-TCP listener on :81) ----------------
  const sseServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const names = url.searchParams.get('names') || '';
    // Firmware: spot value names only ([A-Za-z0-9_,.-], 1..120 chars), else 404
    const namesOk = names.length > 0 && names.length <= 120 && /^[A-Za-z0-9_,.-]+$/.test(names);
    if (sseMode === '404' || req.method !== 'GET' || url.pathname !== '/stream' || !namesOk) {
      res.writeHead(404, { Connection: 'close' });
      return res.end();
    }
    let streamAuth = null;
    if (auth.enabled()) {
      streamAuth = auth.redeemTicket(url.searchParams.get('t') || '');
      if (!streamAuth) { res.writeHead(401, { Connection: 'close' }); return res.end(); }
    }
    let ms = toInt(url.searchParams.get('ms'));
    if (ms < 50) ms = 100;
    if (ms > 5000) ms = 5000;
    if (sseRes) { sseRes.destroy(); sseRes = null; } // newest stream wins
    commandLog.push('stream ' + names);
    const origin = req.headers.origin || '';
    const cors = !auth.enabled() ? { 'Access-Control-Allow-Origin': '*' }
      : (origin && /^[\x21-\x7e]+$/.test(origin) && originHostMatches(origin, req.headers.host) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {});
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
      'Connection': 'keep-alive', ...cors,
    });

    res.write('retry: 1000\n\n');
    sseRes = res;
    const tick = () => {
      // Sign-in on: the stream ends with its session (sseTick's alive check)
      if (auth.enabled() && (!streamAuth || !auth.alive(streamAuth.slot, streamAuth.serial))) { res.destroy(); return; }
      // Same reply the firmware forwards: CAN = tab-separated, UART = the
      // inverter's per-line 'get' output; CR/LF flattened to spaces
      const out = settings.can_mode ? canCommand('get ' + names) : uartCommand('get ' + names);
      if (!out) return;
      res.write('data: ' + out.replace(/[\r\n]/g, ' ') + '\n\n');
    };
    tick();
    const timer = setInterval(tick, ms);
    // req 'close' fires as soon as the (empty) body is consumed — the
    // response is what stays open until the client disconnects
    res.on('close', () => { clearInterval(timer); if (sseRes === res) sseRes = null; });
  });

  const close = async () => {
    for (const s of [server, sseServer]) {
      s.closeAllConnections?.(); // an open SSE stream would otherwise hold the server up
      await new Promise(r => s.close(() => r()));
    }
  };

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    sseServer.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      sseServer.listen(ssePort, '127.0.0.1', () => {
        // 'off' = nothing listening on the advertised port (connection refused)
        const origEmit = sseServer.emit.bind(sseServer);
        sseServer.emit = (ev, ...a) => {
          if (ev === 'connection' && sseMode === 'off') { a[0].destroy(); return true; }
          return origEmit(ev, ...a);
        };
        resolve({
          server, sseServer, close,
          port: server.address().port, ssePort: sseServer.address().port,
          url: `http://127.0.0.1:${server.address().port}`,
        });
      });
    });
  });
}

// CLI: `npm run mock` for manual poking
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { url, ssePort } = await createMockEsp({ port: 8765, ssePort: 8781 });
  console.log('Mock ESP running at ' + url + ' (SSE stream on :' + ssePort + ')');
}
