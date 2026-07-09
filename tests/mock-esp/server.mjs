// Mock ESP32 web-interface backend for E2E tests.
//
// Serves the real frontend from data/ and implements the firmware's HTTP API
// (esp32-web-interface.ino) backed by a simulated inverter that speaks the
// serial protocol documented in PROTOCOL.md. Dependency-free (node:http) so
// `npm ci` stays small and fast in CI.
//
// Test introspection endpoints (not present on real hardware):
//   GET  /__test/commands   -> JSON array of every inverter command received
//   GET  /__test/state      -> full mock state dump
//   POST /__test/reset      -> restore pristine state
//   POST /__test/fw-status  -> body sets the /fwupdate-status reply (CAN OTA)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
};

// Representative inverter model (stm32-sine-like), matching the schema in
// PROTOCOL.md: parameters carry isparam/min/max/default/category, spot values
// don't. Enum-typed values encode their mapping in `unit`.
function freshInverterState() {
  return {
    params: {
      fweak:    { unit: 'Hz', value: 67.0, isparam: true, minimum: 0, maximum: 400, default: 67, category: 'Motor (sine)', i: 0 },
      boost:    { unit: 'dig', value: 1700, isparam: true, minimum: 0, maximum: 37813, default: 1700, category: 'Motor (sine)', i: 1 },
      polepairs:{ unit: '', value: 2, isparam: true, minimum: 1, maximum: 16, default: 2, category: 'Motor', i: 2 },
      udcmin:   { unit: 'V', value: 450, isparam: true, minimum: 0, maximum: 1000, default: 450, category: 'Voltage', i: 3 },
      udcmax:   { unit: 'V', value: 520, isparam: true, minimum: 0, maximum: 1000, default: 520, category: 'Voltage', i: 4 },
      dirmode:  { unit: '0=Button, 1=Switch, 2=ButtonReversed, 3=SwitchReversed, 4=DefaultForward', value: 1, isparam: true, minimum: 0, maximum: 4, default: 1, category: 'Derate', i: 5 },
      potmin:   { unit: 'dig', value: 0, isparam: true, minimum: 0, maximum: 4095, default: 0, category: 'Throttle', i: 6 },
      potmax:   { unit: 'dig', value: 4095, isparam: true, minimum: 0, maximum: 4095, default: 4095, category: 'Throttle', i: 7 },
    },
    spot: {
      version: { unit: '4=5.27.R-sine', value: 4, isparam: false },
      opmode:  { unit: '0=Off, 1=Run, 2=ManualRun, 3=Boost, 4=Buck, 5=Sine, 6=AcHeat, 7=Chademo', value: 0, isparam: false },
      status:  { unit: '0=None, 1=UdcLow, 2=UdcHigh, 4=UdcBelowUdcSw, 8=UdcLim, 16=EmcyStop, 32=MProt, 64=PotPressed, 128=TmpHs, 256=WaitStart', value: 0, isparam: false },
      lasterr: { unit: '0=NONE, 1=OVERCURRENT, 2=THROTTLE1', value: 0, isparam: false },
      udc:     { unit: 'V', value: 398.5, isparam: false },
      tmphs:   { unit: '°C', value: 31.2, isparam: false },
      speed:   { unit: 'rpm', value: 0, isparam: false },
      pot:     { unit: 'dig', value: 0, isparam: false },
    },
  };
}

export function createMockEsp({ port = 0 } = {}) {
  let inverter = freshInverterState();
  let files = new Map(); // SPIFFS stand-in: name -> Buffer
  let commandLog = [];
  let settings = { txrx_swapped: false, can_mode: false, can_node_id: 1, can_speed: 2, can_rx_pin: 4, can_tx_pin: 5 };
  let fwStatus = { state: 0 }; // /fwupdate-status reply, scriptable via /__test/fw-status
  let uartPages = 4; // pages reported for the UART-mode fwupdate flow
  let fwSteps = []; // every step passed to /fwupdate, in order

  const allValues = () => ({ ...inverter.params, ...inverter.spot });

  // Simulated inverter terminal: free-text replies per PROTOCOL.md
  function runCommand(cmd) {
    commandLog.push(cmd);
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
        return args.split(',').map(n => {
          const v = allValues()[n.trim()];
          return v === undefined ? 'Unknown parameter' : Number(v.value).toFixed(2);
        }).join('\n') + '\n';
      case 'stream': {
        // stream <reps> <a,b,...> — one CSV line per repetition
        const [reps, names] = args.split(' ');
        const line = () => names.split(',').map(n => {
          const v = allValues()[n.trim()];
          return v === undefined ? '0' : Number(v.value).toFixed(2);
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
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      res.writeHead(200, { 'Content-Type': type });
      res.end(fs.readFileSync(abs));
      return true;
    }
    if (fs.existsSync(abs + '.gz')) { // gz-only assets, served like the ESP does
      res.writeHead(200, { 'Content-Type': type, 'Content-Encoding': 'gzip' });
      res.end(fs.readFileSync(abs + '.gz'));
      return true;
    }
    return false;
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const text = (s, type = 'text/plain') => { res.writeHead(200, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' }); res.end(s); };
      const json = (o) => text(typeof o === 'string' ? o : JSON.stringify(o), 'application/json');

      // --- test introspection ---
      if (p === '/__test/commands') return json(commandLog);
      if (p === '/__test/state') return json({ inverter, files: [...files.keys()], settings, commandLog, fwSteps });
      if (p === '/__test/reset') {
        inverter = freshInverterState(); files = new Map(); commandLog = []; fwSteps = [];
        settings = { txrx_swapped: false, can_mode: false, can_node_id: 1, can_speed: 2, can_rx_pin: 4, can_tx_pin: 5 };
        fwStatus = { state: 0 };
        return text('reset');
      }
      if (p === '/__test/fw-status') { fwStatus = JSON.parse(body.toString() || '{}'); return text('ok'); }
      if (p === '/__test/put-file') { // seed a SPIFFS file directly (raw body)
        files.set((url.searchParams.get('name') || 'file').replace(/^\//, ''), body);
        return text('ok');
      }
      if (p === '/__test/spot') { // drive a spot value from a test
        const sv = inverter.spot[url.searchParams.get('name')];
        if (sv) sv.value = parseFloat(url.searchParams.get('value'));
        return text(sv ? 'ok' : 'unknown');
      }

      // --- firmware API ---
      if (p === '/cmd') {
        const cmd = url.searchParams.get('cmd');
        if (cmd === null) { res.writeHead(500); return res.end('BAD ARGS'); }
        let out = runCommand(cmd);
        let repeat = parseInt(url.searchParams.get('repeat') || '0');
        while (repeat-- > 0) out += runCommand(cmd);
        return text(out, 'text/json');
      }
      if (p === '/edit' && req.method === 'POST') {
        for (const part of parseMultipart(body, req.headers['content-type'])) {
          if (part.filename) files.set(part.filename.replace(/^\//, ''), part.data);
        }
        return text('');
      }
      if (p === '/edit' && req.method === 'DELETE') {
        files.delete((url.searchParams.get('f') || '').replace(/^\//, ''));
        return text('');
      }
      if (p === '/list') return json([...files.keys()].map(name => ({ type: 'file', name })));

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
        if ([...url.searchParams.keys()].length > 0) {
          if (url.searchParams.has('txrx_swap')) settings.txrx_swapped = url.searchParams.get('txrx_swap') === '1';
          if (url.searchParams.has('can_mode')) settings.can_mode = url.searchParams.get('can_mode') === '1';
          for (const k of ['can_node_id', 'can_speed', 'can_rx_pin', 'can_tx_pin'])
            if (url.searchParams.has(k)) settings[k] = parseInt(url.searchParams.get(k));
          return text('{"result":"ok"}', 'text/json');
        }
        return json(settings);
      }
      if (p === '/wifi') return text('<h2>WiFi Settings</h2><form id="mock-wifi"><input name="ssid" value="mocknet" /></form>', 'text/html');
      if (p === '/version') return text('vMOCK');
      if (p === '/otainfo') return json({ version: 'vMOCK', repo: 'https://github.com/wjcloudy/esp32-web-interface', target: 'esp32_wemos' });
      if (p === '/fwupdate-status') return json(fwStatus);
      if (p === '/fwupdate') {
        const step = parseInt(url.searchParams.get('step'));
        fwSteps.push(step);
        if (step === -1 && settings.can_mode) { fwStatus = { state: 1 }; return json({ message: 'started' }); }
        return json({ message: 'ok', pages: uartPages });
      }
      if (p === '/set-can-node') return text('ok');
      if (p === '/can-scan') {
        if (!settings.can_mode) { res.writeHead(400, { 'Content-Type': 'text/json' }); return res.end('{"error":"CAN mode not enabled"}'); }
        return json([{ nodeId: 1, serial: 'CAFEBABE' }]);
      }
      if (p === '/reboot') return text('Rebooting...');
      if (p === '/reset-inverter') return text('Inverter reset sent');
      if (p === '/virtual-reload') return text('ok');
      if (p === '/baud') return text('921600');

      // --- static frontend (uploaded files shadow nothing; data/ is truth) ---
      if (req.method === 'GET' && sendStatic(res, p)) return;
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('FileNotFound');
    });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

// CLI: `npm run mock` for manual poking
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { url } = await createMockEsp({ port: 8765 });
  console.log('Mock ESP running at ' + url);
}
