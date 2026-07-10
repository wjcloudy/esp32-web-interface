// app.js — Preact + HTM OpenInverter Web Interface
// Replaces: ui.js, inverter.js, plot.js, log.js, wifi.js, modal.js, index.js, docstrings.js

const { h, render, createContext } = preact;
const { useState, useEffect, useLayoutEffect, useReducer, useContext, useRef, useMemo } = preactHooks;
const html = htm.bind(h);

// ==================== API ====================
const api = {
  _cache: {},
  _pending: {},
  
  async getJSON(cmd) {
    if (this._pending[cmd]) return this._pending[cmd];
    this._pending[cmd] = fetch('/cmd?cmd=' + encodeURIComponent(cmd))
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(data => { this._pending[cmd] = null; return data; })
      .catch(e => { this._pending[cmd] = null; throw e; });
    return this._pending[cmd];
  },

  async getText(cmd, repeat, timeoutMs) {
    let url = '/cmd?cmd=' + encodeURIComponent(cmd);
    if (repeat) url += '&repeat=' + repeat;
    const opts = {};
    let timer;
    if (timeoutMs) {
      const ac = new AbortController();
      opts.signal = ac.signal;
      timer = setTimeout(() => ac.abort(), timeoutMs);
    }
    try {
      const r = await fetch(url, opts);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.text();
    } finally {
      if (timer) clearTimeout(timer);
    }
  },

  // Fetch many spot values with the command split into <=120-char chunks —
  // the inverter's UART terminal buffer truncates commands beyond 128 chars,
  // which would silently mis-map values onto the wrong names.
  async getValuesChunked(names) {
    const chunks = [];
    let cur = [], len = 4; // 'get '
    for (const n of names) {
      if (cur.length && len + n.length + 1 > 120) { chunks.push(cur); cur = []; len = 4; }
      cur.push(n); len += n.length + 1;
    }
    if (cur.length) chunks.push(cur);
    const out = {};
    for (const c of chunks) {
      const text = await this.getText('get ' + c.join(','));
      const vals = text.match(/[\-\d\.]+/g) || [];
      if (vals.length !== c.length) throw new Error('count mismatch');
      c.forEach((n, i) => { out[n] = parseFloat(vals[i]); });
    }
    return out;
  },

  // Set a parameter and interpret the inverter's free-text reply: returns
  // { ok, reply }. Both backends reply with recognisable failure text
  // ("Value out of range", "Unknown parameter", CAN-mode "Set failed") that
  // callers previously ignored, showing rejected values as applied.
  async setParam(name, value) {
    const reply = (await this.getText('set ' + name + ' ' + value)).trim();
    const ok = !/out of range|unknown param|set failed|error/i.test(reply);
    return { ok, reply };
  },

  async uploadFile(formData) {
    const r = await fetch('/edit', { method: 'POST', body: formData });
    if (!r.ok) throw new Error('Upload failed (HTTP ' + r.status + ')');
    return r.text();
  },

  async deleteFile(filename) {
    await fetch('/edit?f=' + encodeURIComponent(filename), { method: 'DELETE' });
  },

  async getFileList() {
    const r = await fetch('/list');
    return r.json();
  },

  async getWiFiTab() {
    const r = await fetch('/wifi');
    return r.text();
  },

  async fetchGithubReleases() {
    const r = await fetch('https://api.github.com/repos/jsphuebner/stm32-sine/releases');
    return r.json();
  },

  // Build info from the firmware: which repo it was built from and its OTA
  // target, so the GitHub update UI defaults to the right place and image.
  async getOtaInfo() {
    try { const r = await fetch('/otainfo'); if (r.ok) return await r.json(); } catch (e) {}
    return { version: '', repo: '', target: 'esp32_wemos' };
  },

  async fetchReleasesFor(owner, repo) {
    const r = await fetch('https://api.github.com/repos/' + owner + '/' + repo + '/releases');
    if (!r.ok) throw new Error('GitHub API HTTP ' + r.status);
    return r.json();
  },

  async runUpdateStep(step, file) {
    const r = await fetch('/fwupdate?step=' + step + '&file=' + encodeURIComponent(file));
    const json = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(json.message || 'Update step failed (HTTP ' + r.status + ')');
    return json;
  },

  // CAN mode: the firmware flashes in one continuous background task on the
  // ESP (the bootloader tolerates no gaps between frames); poll for progress.
  async runCanUpdate(file, onProgress) {
    const start = await fetch('/fwupdate?step=-1&file=' + encodeURIComponent(file));
    const sj = await start.json().catch(() => ({}));
    if (!start.ok) throw new Error(sj.message || 'Could not start update');
    let failures = 0; // consecutive status-poll failures — bail instead of looping forever
    while (true) {
      await new Promise(res => setTimeout(res, 400));
      let st;
      try {
        const r = await fetch('/fwupdate-status');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        st = await r.json();
        failures = 0;
      } catch (e) {
        if (++failures >= 25) throw new Error('Lost contact with the device during the update'); // ~10s
        continue;
      }
      if (st.state === 1) onProgress(0, 'Waiting for bootloader — power-cycle the device if this hangs');
      else if (st.state === 2) onProgress(Math.round(100 * st.page / (st.pages || 1)), 'Flashing page ' + st.page + ' / ' + st.pages);
      else if (st.state === 3) { onProgress(100, 'Update complete'); return; }
      else if (st.state === 4) throw new Error(st.message || 'Update failed');
      else return; // idle — task ended unexpectedly
    }
  },

  async loadFavorites() {
    try {
      const r = await fetch('/favorites.json');
      if (!r.ok) return { params: [], spots: [] };
      const data = await r.json();
      return { params: data.p || [], spots: data.s || [] };
    } catch (e) { return { params: [], spots: [] }; }
  },

  // Debounced: rapid toggles collapse into one write of the LATEST lists —
  // two overlapping uploads could otherwise finish out of order and persist
  // the stale one
  saveFavorites(paramFavs, spotFavs) {
    this._favData = { p: paramFavs || [], s: spotFavs || [] };
    clearTimeout(this._favTimer);
    this._favTimer = setTimeout(async () => {
      try {
        const blob = new Blob([JSON.stringify(this._favData)], { type: 'application/json' });
        const fd = new FormData();
        fd.append('updatefile', blob, 'favorites.json');
        await fetch('/edit', { method: 'POST', body: fd });
      } catch(e) { console.log('Save favorites failed', e); }
    }, 400);
  }
};

// ==================== Store ====================
const Store = createContext({});

// Parse enum string like "0=None, 1=UdcLow, 2=UdcHigh" into {0:"None", 1:"UdcLow", 2:"UdcHigh"}
function parseEnums(unit) {
  if (!unit || typeof unit !== 'string') return null;
  const re = /(\-?\d+)=([a-zA-Z0-9_\-\.]+)[,\s]{0,2}|([a-zA-Z0-9_\-\.]+)[,\s]{1,2}/g;
  const enums = {};
  let m;
  while ((m = re.exec(unit)) !== null) {
    if (m[1] !== undefined) enums[m[1]] = m[2];
  }
  return Object.keys(enums).length > 0 ? enums : null;
}

// URL breadcrumbs: every tab is bookmarkable as #tab, and the gauges tab
// nests its page as #gauges/<page name> — so a browser favourite can open a
// particular inverter view directly. (Must match the navbar tabs list, which
// is declared later in the file.)
const VALID_TABS = ['dashboard', 'parameters', 'spotvalues', 'plot', 'gauges', 'logger', 'canmapping', 'files', 'update', 'settings', 'support'];
function parseHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  const tab = decodeURIComponent(parts[0] || '');
  let sub = '';
  try { sub = decodeURIComponent(parts.slice(1).join('/')); } catch (e) {}
  return { tab: VALID_TABS.includes(tab) ? tab : null, sub };
}

const initialState = {
  params: null,
  spotValues: null,
  messages: '',
  status: null, opmode: null, lasterr: null, udc: null, tmphs: null,
  firmwareVersion: '',
  fetchAge: 0,
  activeTab: parseHash().tab || 'dashboard',
  refreshRate: 3000, // -1 = off, else ms interval
  paramFavorites: [],
  spotFavorites: [],
  showFavoritesOnly: true,
  fileList: [],
  categoryVisible: {},
  fetching: false,
  commError: false,
  failedFetchCount: 0,
  navbarBig: true,
  fps: 0,
  rightPanelOpen: true,
  logging: false,
  cmdBusy: false, // a terminal command is in flight (drives the CMD badge)
  canMode: false,
  canNodeId: 1,
  canNodes: [],
  canActiveNodeId: 1,
  canConnected: false,
  webVersion: '',
  updateTag: null, // newest GitHub release tag, when newer than webVersion
  history: {}, // recent numeric samples for dashboard sparklines
};

// Friendly display names for common spot values on the dashboard hero card
const DASH_METRIC_LABELS = {
  udc: 'Battery voltage', idc: 'Battery current', tmphs: 'Inverter temp',
  tmpm: 'Motor temp', speed: 'Motor speed', pot: 'Throttle',
};

// Spot values shown as dashboard hero metrics (max 5, configured in Settings)
function getDashMetrics() {
  try {
    const v = JSON.parse(localStorage.getItem('dashMetrics') || 'null');
    if (Array.isArray(v) && v.length) return v.filter(Boolean).slice(0, 5);
  } catch (e) {}
  return ['udc', 'tmphs'];
}

function reducer(state, action) {
  switch (action.type) {
    case 'SET_PARAMS': {
      const p = action.payload;
      const params = {}, spotValues = {};
      // Extract dashboard status fields directly, resolving enums
      const getVal = (name) => {
        const v = p[name];
        if (!v) return null;
        const enums = parseEnums(v.unit);
        if (enums && enums[v.value] !== undefined) return enums[v.value];
        // Bitmask enum (e.g. status, canio)
        if (enums && v.value > 0) {
          const active = [];
          for (const k in enums) if (v.value & parseInt(k)) active.push(enums[k]);
          if (active.length > 0) return active.join(' | ');
        }
        return v.value;
      };
      const status = getVal('status'); const opmode = getVal('opmode');
      const lasterr = getVal('lasterr'); const udc = getVal('udc'); const tmphs = getVal('tmphs');
      // Version: resolve enum if present (matches original paramsCache.get behavior)
      let version = '';
      if (p['version']) {
        const venums = parseEnums(p['version'].unit);
        if (venums && venums[p['version'].value]) {
          version = venums[p['version'].value];
        } else {
          version = p['version'].value;
        }
      }

      for (const name in p) {
        const v = p[name];
        const enums = parseEnums(v.unit);
        if (v.isparam) {
          let display = v.value;
          if (enums) {
            if (enums[v.value]) display = enums[v.value];
            else { const a = []; for (const k in enums) if (v.value & k) a.push(enums[k]); display = a.join('|'); }
          }
          params[name] = { ...v, display, enums };
        } else {
          let display = v.value;
          if (enums) {
            if (enums[v.value]) display = enums[v.value];
            else { const a = []; for (const k in enums) if (v.value & k) a.push(enums[k]); display = a.join('|'); }
          }
          spotValues[name] = { ...v, display, enums, name };
        }
      }
      const cv = { ...state.categoryVisible };
      for (const name in params) {
        const cat = params[name].category;
        if (cat && !(cat in cv)) cv[cat] = true;
      }
      // Sparkline history: keep the last 60 numeric samples of key telemetry
      // (udc/tmphs feed the hero card fallbacks; dash metrics are configurable)
      const hist = { ...state.history };
      for (const k of new Set(['udc', 'tmphs', ...getDashMetrics()])) {
        const raw = p[k] ? parseFloat(p[k].value) : NaN;
        if (!isNaN(raw)) hist[k] = [...(hist[k] || []).slice(-59), raw];
      }
      return { ...state, params, spotValues, status, opmode, lasterr, udc, tmphs,
        firmwareVersion: version, categoryVisible: cv, fetchAge: 0, history: hist,
        failedFetchCount: 0, commError: false, fetching: false,
        canConnected: state.canMode ? (action.payload.can_cache === true) : false };
    }

    case 'SET_FPS':
      return { ...state, fps: action.payload };
    case 'SET_REFRESH_RATE':
      return { ...state, refreshRate: action.payload };
    case 'TOGGLE_PARAM_FAV': {
      const pf = state.paramFavorites.includes(action.payload)
        ? state.paramFavorites.filter(n => n !== action.payload)
        : [...state.paramFavorites, action.payload];
      api.saveFavorites(pf, state.spotFavorites);
      return { ...state, paramFavorites: pf };
    }
    case 'TOGGLE_SPOT_FAV': {
      const sf = state.spotFavorites.includes(action.payload)
        ? state.spotFavorites.filter(n => n !== action.payload)
        : [...state.spotFavorites, action.payload];
      api.saveFavorites(state.paramFavorites, sf);
      return { ...state, spotFavorites: sf };
    }
    case 'SET_FAVORITES':
      return { ...state, paramFavorites: action.payload.params, spotFavorites: action.payload.spots };
    case 'TOGGLE_FAVORITES_ONLY':
      return { ...state, showFavoritesOnly: !state.showFavoritesOnly };
    case 'TOGGLE_RIGHT_PANEL':
      return { ...state, rightPanelOpen: !state.rightPanelOpen };
    case 'SET_LOGGING':
      return { ...state, logging: action.payload };
    case 'SET_CMD_BUSY':
      return { ...state, cmdBusy: action.payload };
    case 'SET_MESSAGES':
      return { ...state, messages: action.payload };
    case 'FETCH_ERROR':
      const fc = state.failedFetchCount + 1;
      return { ...state, failedFetchCount: fc, commError: fc >= 2, fetching: false,
               canConnected: state.canMode ? (fc < 2 && state.canConnected) : false };
    case 'SET_ACTIVE_TAB':
      return { ...state, activeTab: action.payload };
    case 'SET_UPDATE_TAG':
      return { ...state, updateTag: action.payload };
    case 'SET_FILE_LIST':
      return { ...state, fileList: action.payload };
    case 'SET_ALL_CATEGORIES': {
      const cva = {};
      for (const name in (state.params || {})) {
        const c = state.params[name].category || 'General';
        cva[c] = action.payload;
      }
      return { ...state, categoryVisible: cva };
    }
    case 'TOGGLE_CATEGORY':
      const cv2 = { ...state.categoryVisible };
      cv2[action.payload] = !cv2[action.payload];
      return { ...state, categoryVisible: cv2 };
    case 'SET_FETCHING':
      return { ...state, fetching: true };
    case 'TICK_AGE':
      return { ...state, fetchAge: state.fetchAge + 1 };

    case 'TOGGLE_NAVBAR':
      return { ...state, navbarBig: !state.navbarBig };
    case 'SET_CAN_CONFIG':
      return { ...state, canMode: action.payload.canMode, canNodeId: action.payload.canNodeId };
    case 'SET_CAN_NODE':
      return { ...state, canActiveNodeId: action.payload };
    case 'SET_CAN_NODES':
      return { ...state, canNodes: action.payload };
    case 'ADD_CAN_NODE': {
      const exists = state.canNodes.find(n => n.nodeId === action.payload.nodeId);
      if (exists) return { ...state, canNodes: state.canNodes.map(n => n.nodeId === action.payload.nodeId ? { ...n, ...action.payload, default: n.default } : n) };
      // The first node added becomes the boot default
      const isDefault = !state.canNodes.some(n => n.default);
      return { ...state, canNodes: [...state.canNodes, { ...action.payload, default: isDefault }] };
    }
    case 'REMOVE_CAN_NODE': {
      let nodes = state.canNodes.filter(n => n.nodeId !== action.payload);
      // Keep exactly one default: promote the first remaining node if needed
      if (nodes.length && !nodes.some(n => n.default)) nodes = nodes.map((n, i) => i === 0 ? { ...n, default: true } : n);
      return { ...state, canNodes: nodes };
    }
    case 'SET_DEFAULT_NODE':
      return { ...state, canNodes: state.canNodes.map(n => ({ ...n, default: n.nodeId === action.payload })) };
    case 'SET_WEB_VERSION':
      return { ...state, webVersion: action.payload };
    case 'SET_CAN_CONNECTED':
      return { ...state, canConnected: action.payload };
    case 'SET_PARAM_VALUE':
      const np = { ...state.params };
      if (np[action.name]) np[action.name] = { ...np[action.name], value: action.value };
      return { ...state, params: np };
    default:
      return state;
  }
}

// ==================== Utility Components ====================

const Spinner = () => html`<div class="css-spinner"></div>`;

const Modal = ({ id, size, title, children, onClose }) => {
  const elRef = useRef(null);
  if (!elRef.current) {
    const el = document.createElement('div');
    el.id = id + '-modal-root';
    document.body.appendChild(el);
    elRef.current = el;
  }
  // Tear the root down only on unmount — recreating it per render flickers
  useEffect(() => () => {
    if (elRef.current) { preact.render(null, elRef.current); document.body.removeChild(elRef.current); elRef.current = null; }
  }, []);
  preact.render(html`
    <div id="${id}-modal-overlay" class="modal-overlay" style="display:flex">
      <div class="${size === 'large' ? 'large-modal-container' : size === 'can-mapping' ? 'can-mapping-modal-container' : 'small-modal-container'}">
        ${title && html`<div id="large-modal-header-div"><h2>${title}</h2><span class="modal-close" onclick=${onClose}>×</span></div>`}
        <div class="modal-content">${children}</div>
      </div>
    </div>
  `, elRef.current);
  return null;
};

// Tiny inline sparkline from an array of numbers
const Sparkline = ({ data, width = 90, height = 24 }) => {
  if (!data || data.length < 2) return null;
  const min = Math.min(...data), max = Math.max(...data);
  const span = (max - min) || 1;
  const pts = data.map((v, i) =>
    ((i / (data.length - 1)) * width).toFixed(1) + ',' +
    (height - 2 - ((v - min) / span) * (height - 4)).toFixed(1)
  ).join(' ');
  return html`<svg class="spark" width=${width} height=${height} viewBox=${'0 0 ' + width + ' ' + height}><polyline points=${pts} /></svg>`;
};

// Small stroke icons for buttons — same visual language as the nav icons
const ICONS = {
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  rotate: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
  power: '<path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  edit: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  refresh: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
  undo: '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>',
  send: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
  external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
  cloud: '<polyline points="8 17 12 21 16 17"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.88 18.09A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.29"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  rss: '<path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/>',
  chevron: '<polyline points="6 9 12 15 18 9"/>',
  expand: '<polyline points="7 6 12 11 17 6"/><polyline points="7 13 12 18 17 13"/>',
  collapse: '<polyline points="17 11 12 6 7 11"/><polyline points="17 18 12 13 7 18"/>',
  life: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/><line x1="4.93" y1="4.93" x2="9.17" y2="9.17"/><line x1="14.83" y1="14.83" x2="19.07" y2="19.07"/><line x1="14.83" y1="9.17" x2="19.07" y2="4.93"/><line x1="4.93" y1="19.07" x2="9.17" y2="14.83"/>',
};
const Icon = ({ n, size = 13 }) => html`<span class="btn-ic" dangerouslySetInnerHTML=${{
  __html: '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + (ICONS[n] || '') + '</svg>'
}}></span>`;

// Station signal strength as bars + dBm (usual WiFi quality bands)
const WifiSignal = ({ rssi }) => {
  const level = rssi >= -55 ? 4 : rssi >= -65 ? 3 : rssi >= -75 ? 2 : 1;
  const label = ['Weak', 'Fair', 'Good', 'Excellent'][level - 1];
  return html`<span id="wifi-signal" class="wifi-bars" title=${rssi + ' dBm'}>
    ${[1, 2, 3, 4].map(i => html`<i key=${i} class=${i <= level ? 'on' : ''} style=${'height:' + (3 + i * 3) + 'px'}></i>`)}
    <span class="wifi-dbm">${rssi} dBm · ${label}</span>
  </span>`;
};

// Labeled switch row for action panels
const ToggleRow = ({ label, checked, onChange, disabled }) => html`
  <label class="toggle-row ${disabled ? 'disabled' : ''}">
    <span class="toggle-label">${label}</span>
    <span class="switch sm">
      <input type="checkbox" checked=${checked} disabled=${disabled} onchange=${e => onChange(e.target.checked)} />
      <span class="slider"></span>
    </span>
  </label>`;

// Map an opmode enum string to a display tone
const opmodeTone = (op) => {
  const s = String(op == null ? '' : op).toLowerCase();
  if (s.includes('pchfail')) return 'danger';
  if (s.includes('precharge')) return 'info';
  if (s.includes('run') || s.includes('charge')) return 'active';
  if (s.includes('preheat')) return 'warn';
  if (s.includes('off')) return 'muted';
  return 'info';
};

const OPMODE_FRIENDLY = {
  'Off': 'Inverter idle', 'Run': 'Running', 'Precharge': 'Precharging',
  'PchFail': 'Precharge failed', 'Charge': 'Charging', 'Preheat': 'Preheating',
};

// Resolve an enum value to its display label (handles bitmask enums)
const enumLabel = (enums, val) => {
  if (!enums || val == null) return null;
  const k = Math.round(val);
  if (enums[k] !== undefined) return enums[k];
  const a = [];
  for (const key in enums) if (k & parseInt(key)) a.push(enums[key]);
  return a.length ? a.join('|') : String(k);
};

const fmtNum = (v, dec = 1) => {
  const n = parseFloat(v);
  return isNaN(n) ? '—' : n.toFixed(dec);
};

// ==================== Navbar ====================

const tabs = [
  { id: 'dashboard', label: 'Dashboard', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>' },
  { id: 'parameters', label: 'Parameters', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><circle cx="4" cy="12" r="2"/><circle cx="12" cy="10" r="2"/><circle cx="20" cy="14" r="2"/></svg>' },
  { id: 'spotvalues', label: 'Spot Values', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>' },
  { id: 'plot', label: 'Plot', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>' },
  { id: 'gauges', label: 'Gauges', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 14l4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/></svg>' },
  { id: 'logger', label: 'Data Logger', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>' },
  { id: 'canmapping', label: 'CAN Mapping', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>' },
  { id: 'files', label: 'Files', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>' },
  { id: 'update', label: 'Update', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>' },
  { id: 'settings', label: 'Settings', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 1a2 2 0 012 2v1.1a7 7 0 012.4 1l.8-.8a2 2 0 012.8 2.8l-.8.8a7 7 0 011 2.4H21a2 2 0 010 4h-1.1a7 7 0 01-1 2.4l.8.8a2 2 0 01-2.8 2.8l-.8-.8a7 7 0 01-2.4 1V21a2 2 0 01-4 0v-1.1a7 7 0 01-2.4-1l-.8.8a2 2 0 01-2.8-2.8l.8-.8a7 7 0 01-1-2.4H3a2 2 0 010-4h1.1a7 7 0 011-2.4l-.8-.8a2 2 0 012.8-2.8l.8.8a7 7 0 012.4-1V3a2 2 0 012-2z"/></svg>' },
  { id: 'support', label: 'Support', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>' },
];

const Navbar = () => {
  const { state, dispatch } = useContext(Store);
  const active = state.activeTab;

  return html`
    <aside id="navbar">
      <div id="logo">
        <svg viewBox="0 0 48 48" onclick=${() => dispatch({ type: 'TOGGLE_NAVBAR' })} title="Toggle navigation">
          <defs>
            <linearGradient id="logo-ring" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color="#d4d4d4" />
              <stop offset="100%" stop-color="#636363" />
            </linearGradient>
            <clipPath id="logo-clip"><circle cx="24" cy="24" r="19.6" /></clipPath>
          </defs>
          <circle cx="24" cy="24" r="21.4" fill="none" stroke="url(#logo-ring)" stroke-width="2.4" />
          <g clip-path="url(#logo-clip)" fill="none" stroke-width="2.4" stroke-linecap="round">
            <path stroke="#5b9dff" opacity=".95" d="M-30 24 C -24 11, -18 11, -12 24 C -6 37, 0 37, 6 24 C 12 11, 18 11, 24 24 C 30 37, 36 37, 42 24 C 48 11, 54 11, 60 24" />
            <path stroke="#ffcf54" opacity=".95" transform="translate(12 0)" d="M-30 24 C -24 11, -18 11, -12 24 C -6 37, 0 37, 6 24 C 12 11, 18 11, 24 24 C 30 37, 36 37, 42 24 C 48 11, 54 11, 60 24" />
            <path stroke="#ff6b6b" opacity=".95" transform="translate(24 0)" d="M-30 24 C -24 11, -18 11, -12 24 C -6 37, 0 37, 6 24 C 12 11, 18 11, 24 24 C 30 37, 36 37, 42 24 C 48 11, 54 11, 60 24" />
          </g>
        </svg>
      </div>
      ${tabs.map(t => html`
        <div class="tablink ${active === t.id ? 'active' : ''}" onclick=${() => dispatch({ type: 'SET_ACTIVE_TAB', payload: t.id })}>
          <span class="tab-icon" dangerouslySetInnerHTML=${{ __html: t.icon }}></span>
          <span class="navbar-text">${t.label}</span>
        </div>
      `)}
      <div id="version">
        ${state.firmwareVersion && html`F/W: ${state.firmwareVersion}<br/>`}Web: ${state.webVersion || '—'}
      </div>
      ${(() => {
        // Badge only when BOTH versions parse and the release is truly newer —
        // a dev build ahead of the latest release stays quiet
        const latest = parseVer(state.updateTag), cur = parseVer(state.webVersion);
        return latest && cur && verNewer(latest, cur) && html`
          <div id="update-badge" class="update-badge" title="A newer web interface release is available on GitHub — open the Update tab">
            <span onclick=${() => dispatch({ type: 'SET_ACTIVE_TAB', payload: 'update' })}>▲ ${state.updateTag} available</span>
            <button title="Hide for this version" onclick=${() => {
              try { localStorage.setItem('updateDismissedTag', state.updateTag); } catch (e) {}
              dispatch({ type: 'SET_UPDATE_TAG', payload: null });
            }}>×</button>
          </div>`;
      })()}
      <div class="control" style="flex-direction:column;align-items:flex-start;gap:2px">
        <span style="font-size:.65rem;text-transform:uppercase;letter-spacing:.05em">Refresh</span>
        <select value=${state.refreshRate} onchange=${e => dispatch({ type: 'SET_REFRESH_RATE', payload: parseInt(e.target.value) })} style="width:100%;font-size:.7rem;padding:4px 6px">
          <option value="5000">5s</option>
          <option value="3000">3s</option>
          <option value="1000">1s</option>
          <option value="-1">Off</option>
        </select>
      </div>
      <div id="data-age" class=${state.fetching && !state.logging ? 'fetching' : ''} style="display:flex;align-items:center;gap:6px">
        ${state.cmdBusy
          ? html`<span style="flex:1;text-align:center"><span class="fast-badge">CMD</span></span>`
          : state.logging
          ? html`<span style="flex:1;text-align:center"><span class="fast-badge">⚡ FAST</span></span>`
          : html`<span style="flex:1;text-align:center">${state.fetchAge}s ago</span>`}
      </div>
      ${state.refreshRate === -1 && !state.logging && html`
        <div style="text-align:center;padding:4px 0 0">
          <button onclick=${() => { dispatch({ type: 'SET_FETCHING' }); api.getJSON('json').then(json => dispatch({ type: 'SET_PARAMS', payload: json })).catch(() => dispatch({ type: 'FETCH_ERROR' })); }} style="font-size:.7rem;padding:4px 12px"><${Icon} n="refresh" />Refresh now</button>
        </div>
      `}
      ${state.canMode && html`
        <div class="control" style="flex-direction:column;align-items:flex-start;gap:2px">
          <span style="font-size:.65rem;text-transform:uppercase;letter-spacing:.05em">CAN Device</span>
          <div class="can-node-select">
            <select value=${state.canActiveNodeId} onchange=${e => {
              const id = parseInt(e.target.value);
              dispatch({ type: 'SET_CAN_NODE', payload: id });
              fetch('/set-can-node?id=' + id);
            }}
              style="width:100%;font-size:.7rem;padding:4px 6px">
              ${state.canNodes.length > 0
                ? state.canNodes.map(d => html`<option value=${d.nodeId}>Node #${d.nodeId}${d.name ? ' ' + d.name : ''}${d.serial ? ' (s/n ' + d.serial + ')' : ''}</option>`)
                : html`<option value=${state.canActiveNodeId}>Node #${state.canActiveNodeId}</option>`}
            </select>
            <span class="can-node-short">#${state.canActiveNodeId}</span>
          </div>
        </div>
      `}
      ${(() => {
        const ok = state.canMode ? state.canConnected : (!state.commError && state.status != null);
        const label = state.canMode ? 'CAN #' + state.canActiveNodeId : 'UART';
        return html`<div style="text-align:center;padding:4px 0 0"><span style="background:${ok ? 'var(--green)' : 'var(--red)'};color:${ok ? '#06301d' : '#fff'};padding:2px 8px;border-radius:10px;font-size:.65rem;font-weight:700;letter-spacing:.03em">${label}</span></div>`;
      })()}
    </aside>
  `;
};

// ==================== Dashboard ====================

const Dashboard = () => {
  const { state, dispatch } = useContext(Store);
  const [cmd, setCmd] = useState('');
  const [cmdOutput, setCmdOutput] = useState('');
  const [confirmAction, setConfirmAction] = useState(null); // 'inverter' | 'esp32'
  const [canId, setCanId] = useState('0x180');
  const [canData, setCanData] = useState('00 00 00 00 00 00 00 00');

  const send = async () => {
    const c = cmd.trim();
    if (!c) return;
    setCmdOutput(o => o + '> ' + c + '\n'); // echo the outgoing command
    setCmd('');
    dispatch({ type: 'SET_LOGGING', payload: true }); // pause the json poll so it can't contend for the single UART
    dispatch({ type: 'SET_CMD_BUSY', payload: true }); // show the CMD badge while the command runs
    try {
      // Generous timeout: a silent inverter returns empty in ~0.2s (firmware
      // self-times-out the UART), so this only catches a hung ESP/connection —
      // and it must comfortably clear a large/slow response like 'json' (~4s).
      const reply = await api.getText(c, 0, 15000);
      const text = reply.replace(/\s+$/, ''); // drop trailing whitespace/newlines
      setCmdOutput(o => o + (text ? text : '(no response)') + '\n');
    } catch (e) {
      const msg = (e && e.name === 'AbortError') ? 'timed out — no response' : (e.message || 'request failed');
      setCmdOutput(o => o + 'error: ' + msg + '\n');
    } finally {
      dispatch({ type: 'SET_LOGGING', payload: false });
      dispatch({ type: 'SET_CMD_BUSY', payload: false });
    }
  };

  return html`
    <div id="dashboard" class="tabdiv main-content" style="display:flex">
      <div class="main-right">
        <h3 class="underline">Actions</h3>
        <button onclick=${() => api.getText('start 2').then(r => dispatch({ type: 'SET_MESSAGES', payload: r }))}><${Icon} n="play" />Start inverter in manual mode</button>
        <button onclick=${() => api.getText('stop').then(r => dispatch({ type: 'SET_MESSAGES', payload: r }))}><${Icon} n="stop" />Stop inverter</button>
        <h3 class="underline">Reset</h3>
        <button onclick=${() => setConfirmAction('inverter')}><${Icon} n="rotate" />Reboot Inverter</button>
        <button onclick=${() => setConfirmAction('esp32')}><${Icon} n="power" />Reboot ESP32</button>
      </div>
      <div class="main-left">
        <h2>Dashboard</h2>
        <div id="top-row" class="dash-row">
          <div id="top-left" class="dash-box hero-card" style="flex:1.4">
            ${state.status != null ? (() => {
              const offline = state.commError || (state.canMode && !state.canConnected);
              const tone = offline ? 'danger' : opmodeTone(state.opmode);
              const friendly = offline ? 'No connection to inverter'
                : (OPMODE_FRIENDLY[state.opmode] || String(state.opmode == null ? '—' : state.opmode));
              const hasErr = state.lasterr && String(state.lasterr) !== 'NONE' && String(state.lasterr) !== '0';
              return html`
                <div class="hero-top">
                  <span class="pill ${tone}"><span class="dot"></span>${offline ? 'Offline' : state.opmode}</span>
                  ${hasErr && html`<span class="pill warn">⚠ ${state.lasterr}</span>`}
                  ${state.canMode
                    ? html`<span class="pill ${state.canConnected ? 'info' : 'danger'}">CAN #${state.canActiveNodeId}</span>`
                    : html`<span class="pill ${offline ? 'danger' : 'info'}">UART</span>`}
                </div>
                <div class="hero-state">${friendly}</div>
                <p class="hero-sub">Status: ${state.status}</p>
                <div class="hero-metrics">
                  ${getDashMetrics().map((name, idx) => {
                    const sv = state.spotValues && state.spotValues[name];
                    const unit = (sv && sv.unit && sv.unit.indexOf('=') === -1) ? sv.unit : '';
                    const label = DASH_METRIC_LABELS[name] || name;
                    const disp = !sv ? '—' : (sv.enums ? String(sv.display) : fmtNum(sv.value));
                    return html`
                    <div class="metric ${idx === 1 ? 'tone-active' : ''}" key=${name}>
                      <span class="metric-label">${label}</span>
                      <span class="metric-value">${disp}${unit && html`<span class="metric-unit">${unit}</span>`}</span>
                      <${Sparkline} data=${state.history[name]} />
                    </div>`;
                  })}
                  ${state.firmwareVersion && html`
                    <div class="metric">
                      <span class="metric-label">Firmware</span>
                      <span class="metric-value" style="font-size:1.05rem;line-height:1.4;margin-top:6px">${state.firmwareVersion}</span>
                    </div>
                  `}
                </div>
              `;
            })() : html`<${Spinner} />`}
          </div>
          <div id="top-right" class="dash-box">
            <h3>Inverter messages</h3>
            <pre><div>${state.messages}</div></pre>
          </div>
        </div>
        <div class="dash-row">
          <div class="dash-box" style="flex:1">
            <h3>Command</h3>
            <div id="commandoutput">${cmdOutput}</div>
            <div style="display:flex;gap:6px;margin-top:8px">
              <input type="text" id="commandinput" value=${cmd} oninput=${e => setCmd(e.target.value)} onkeyup=${e => e.keyCode === 13 && send()} style="flex:1" />
              <button onclick=${send} style="padding:8px 18px;font-weight:600"><${Icon} n="send" />Send</button>
            </div>
          </div>
        </div>
        ${state.canMode && html`
        <div class="dash-row">
          <div class="dash-box" style="flex:1">
            <h3>CAN Message</h3>
            <div style="display:flex;gap:8px;align-items:flex-end">
              <label style="font-size:.75rem;flex:1">CAN ID (hex)
                <input type="text" value=${canId} oninput=${e => setCanId(e.target.value)} style="width:100%;font-size:.75rem;padding:4px 6px;font-family:var(--mono)" />
              </label>
              <label style="font-size:.75rem;flex:2">Data bytes (hex, space/comma separated)
                <input type="text" value=${canData} oninput=${e => setCanData(e.target.value)} style="width:100%;font-size:.75rem;padding:4px 6px;font-family:var(--mono)" />
              </label>
              <button onclick=${async () => {
                const r = await fetch('/can-send?canId=' + encodeURIComponent(canId) + '&data=' + encodeURIComponent(canData));
                const json = await r.json();
                setCmdOutput(o => o + 'CAN: ' + JSON.stringify(json) + '\n');
              }} style="font-size:.75rem;padding:6px 14px;white-space:nowrap"><${Icon} n="send" />Send</button>
            </div>
          </div>
        </div>
        `}
      </div>
    </div>
    ${confirmAction && html`
      <${Modal} id="reset-modal" title=${confirmAction === 'inverter' ? 'Reset inverter' : 'Reboot ESP32'} onClose=${() => setConfirmAction(null)}>
        <p>${confirmAction === 'inverter'
          ? 'This will send a reset command to the inverter (STM32). The inverter will reboot. The web interface will remain accessible.'
          : 'This will reboot the ESP32 itself. You will temporarily lose connection to the web interface.'}</p>
        <div style="display:flex;gap:8px;margin-top:1rem">
          <button onclick=${() => setConfirmAction(null)}>Cancel</button>
          <button onclick=${async () => {
            setConfirmAction(null);
            if (confirmAction === 'inverter') {
              await fetch('/reset-inverter');
            } else {
              await fetch('/reboot');
            }
          }} style="background:var(--red);color:#fff;border-color:transparent">Confirm</button>
        </div>
      </${Modal}>
    `}
  `;
};

// ==================== Parameters ====================

const Parameters = () => {
  const { state, dispatch } = useContext(Store);
  const [editing, setEditing] = useState(null);
  const [editValue, setEditValue] = useState('');
  const [subToken, setSubToken] = useState('');
  const [showSubscribe, setShowSubscribe] = useState(false);
  const [search, setSearch] = useState('');
  const [actionsOpen, setActionsOpen] = useState(false); // responsive-only expander
  const [applying, setApplying] = useState(false); // loading a parameter set from file
  const [applyPct, setApplyPct] = useState(0);
  const [applyMsg, setApplyMsg] = useState('');

  if (!state.params) return html`<div class="tabdiv main-content" style="display:flex"><p>Loading...</p></div>`;

  const hasFavs = state.paramFavorites.length > 0;
  const showFavs = state.showFavoritesOnly && hasFavs;

  const term = search.trim().toLowerCase();
  const cats = {};
  for (const name in state.params) {
    const p = state.params[name];
    if (showFavs && !state.paramFavorites.includes(name)) continue;
    if (term && !name.toLowerCase().includes(term)) continue;
    const cat = p.category || 'General';
    if (!cats[cat]) cats[cat] = [];
    cats[cat].push({ name, ...p });
  }

  const saveParam = async (name, value) => {
    const { ok, reply } = await api.setParam(name, value);
    if (!ok) { alert(name + ': ' + reply); setEditing(null); return; } // rejected — keep the old value
    const num = parseFloat(value);
    dispatch({ type: 'SET_PARAM_VALUE', name, value: isNaN(num) ? value : num });
    setEditing(null);
  };

  // Submit params to the online Parameter Database
  const submitToDatabase = () => {
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = 'https://openinverter.org/parameters/';
    form.target = '_blank';
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = 'parameters_json';
    input.value = JSON.stringify(state.params);
    form.appendChild(input);
    document.body.appendChild(form);
    form.submit();
    document.body.removeChild(form);
  };

  // Subscribe to parameter set
  const doSubscribe = async () => {
    if (!subToken.trim()) return;
    try {
      const r = await fetch('https://openinverter.org/parameters/api.php?token=' + encodeURIComponent(subToken.trim()));
      if (!r.ok) { alert('Failed to fetch parameter set'); return; }
      const params = await r.json();
      // Save subscription token
      const subsJS = "subscription = { 'timestamp': '" + Date.now() + "', 'token': '" + subToken.trim() + "' };";
      const blob = new Blob([subsJS], { type: 'text/javascript' });
      const fd = new FormData();
      fd.append('updatefile', blob, 'subscription.js');
      await fetch('/edit', { method: 'POST', body: fd });
      // Apply parameters, reporting any the inverter rejects
      const rejected = [];
      for (const name in params) {
        if (params[name] && params[name].value !== undefined) {
          const res = await api.setParam(name, params[name].value);
          if (!res.ok) rejected.push(name);
        }
      }
      alert('Subscribed and parameters applied!' + (rejected.length ? '\nRejected: ' + rejected.join(', ') : ''));
      setShowSubscribe(false);
      // Refresh
      const json = await api.getJSON('json');
      dispatch({ type: 'SET_PARAMS', payload: json });
    } catch (e) { alert('Subscription failed: ' + e.message); }
  };

  // Stop subscription
  const stopSubscription = async () => {
    try {
      await fetch('/edit?f=subscription.js', { method: 'DELETE' });
      alert('Subscription stopped.');
    } catch (e) { alert('Failed to stop subscription'); }
  };

  // Load a parameter set from a JSON file and push each value to the inverter.
  // Nothing is stored on the ESP — the values are applied live (same as a
  // database subscription), so the user should Save to flash afterwards to
  // keep them across a reboot. Accepts both the exported nested format
  // ({name:{value,...}}) and a flat name->value map.
  const loadParamsFromFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // allow re-selecting the same file later
    if (!file || applying) return;
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch (err) { alert('Could not read parameter file: ' + err.message); return; }
    const entries = [];
    for (const name in parsed) {
      const v = parsed[name];
      const value = (v !== null && typeof v === 'object') ? v.value : v;
      if (value === undefined || value === null || value === '') continue;
      entries.push([name, value]);
    }
    if (!entries.length) { alert('No parameters found in that file'); return; }
    const total = entries.length;
    if (!confirm('Apply ' + total + ' parameter' + (total === 1 ? '' : 's') + ' to the inverter?')) return;
    // Each 'set' is a serial round-trip, so applying a full set takes a while —
    // drive the same progress bar the firmware upload uses so it isn't a
    // silent wait.
    setApplying(true); setApplyPct(0); setApplyMsg('Applying parameters...');
    let ok = 0; const failed = [];
    try {
      for (let i = 0; i < total; i++) {
        const [name, value] = entries[i];
        setApplyMsg('Setting ' + name + ' (' + (i + 1) + ' / ' + total + ')');
        try {
          const res = await api.setParam(name, value);
          if (res.ok) ok++;
          else failed.push(name + ' (' + res.reply + ')');
        } catch (err) { failed.push(name); }
        setApplyPct(Math.round(100 * (i + 1) / total));
      }
      setApplyMsg('Refreshing...');
      try { dispatch({ type: 'SET_PARAMS', payload: await api.getJSON('json') }); } catch (err) {}
      setApplyMsg('Applied ' + ok + ' of ' + total);
    } finally {
      setApplying(false);
    }
    alert('Applied ' + ok + ' of ' + total + ' parameters.' +
      (failed.length ? '\nFailed: ' + failed.join(', ') : '') +
      '\n\nUse "Save parameters to flash" to keep these after a reboot.');
  };

  return html`
    <div id="parameters" class="tabdiv main-content" style="display:flex">
      <div class="main-right">
        <h3 class="underline">Filter</h3>
        <input type="text" placeholder="Search parameters..." value=${search}
          oninput=${e => setSearch(e.target.value)} style="width:100%;margin-bottom:.25rem" />
        <div style="display:flex;flex-wrap:wrap;gap:6px;width:100%;align-items:stretch">
          <button onclick=${() => dispatch({ type: 'SET_ALL_CATEGORIES', payload: true })} style="flex:0 0 auto;width:auto;min-width:0;padding:5px 8px;justify-content:center"><${Icon} n="expand" />Expand</button>
          <button onclick=${() => dispatch({ type: 'SET_ALL_CATEGORIES', payload: false })} style="flex:0 0 auto;width:auto;min-width:0;padding:5px 8px;justify-content:center"><${Icon} n="collapse" />Collapse</button>
          ${hasFavs && html`<div style="flex:1 1 140px;min-width:140px;display:flex"><${ToggleRow} label="★ Favorites only" checked=${showFavs}
            onChange=${() => dispatch({ type: 'TOGGLE_FAVORITES_ONLY' })} /></div>`}
        </div>
        <button class="actions-expander" onclick=${() => setActionsOpen(!actionsOpen)}>
          <span class="btn-ic" style=${'transition:transform .18s;transform:rotate(' + (actionsOpen ? 180 : 0) + 'deg)'}><${Icon} n="chevron" /></span>
          Actions
        </button>
        <div class="collapsible-actions ${actionsOpen ? 'open' : ''}">
        <h3 class="underline">Save & Load</h3>
        <button onclick=${() => api.getText('save').then(r => alert(r || 'Parameters saved'))}><${Icon} n="save" />Save parameters to flash</button>
        <button onclick=${() => api.getText('load')}><${Icon} n="undo" />Restore parameters from flash</button>
        <a download="params.json" href=${'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(state.params, null, 2))}><button><${Icon} n="download" />Download parameters file</button></a>
        ${/* No accept filter: Android pickers report .json as octet-stream/plain and grey it out; we validate JSON in loadParamsFromFile instead. */ ''}
        <input id="paramfile" type="file" hidden onchange=${loadParamsFromFile} />
        <label class="butt" for="paramfile"><${Icon} n="upload" />Load parameters from file</label>
        ${applying && html`
          <div id="progress" class="graph">
            <div id="bar" style=${{ width: applyPct + '%' }}></div>
            <p id="progress-label">${applyPct}%</p>
          </div>
          <p id="progress-msg">${applyMsg}</p>
        `}
        <h3 class="underline">Parameter Database</h3>
        <button onclick=${submitToDatabase}><${Icon} n="cloud" />Submit parameters</button>
        <button onclick=${() => setShowSubscribe(true)}><${Icon} n="rss" />Subscribe to parameter set</button>
        <button onclick=${stopSubscription}><${Icon} n="x" />Stop subscription</button>
        <h3 class="underline">Misc</h3>
        <a href="/syncofs.html" target="_blank"><button><${Icon} n="external" />Launch syncofs tuner</button></a>
        <a href="https://openinverter.org/wiki/Parameters" target="_blank"><button><${Icon} n="book" />Parameter reference</button></a>
        </div>
      </div>
      <div class="main-left">
        <h2>Parameters</h2>
        <table id="params" class="fullheight" style="width:auto;table-layout:auto">
          <thead><tr><th></th><th>I</th><th>Name</th><th>Value</th><th>Unit</th><th>Min</th><th>Max</th><th>Default</th></tr></thead>
          <tbody id="paramBody">
            ${Object.keys(cats).map(cat => html`
              <tr><td colspan="8">
                <button style="background:none;border:none;font-weight:bold" onclick=${() => dispatch({ type: 'TOGGLE_CATEGORY', payload: cat })}>
                  ${state.categoryVisible[cat] ? '-' : '+'} ${cat}
                </button>
              </td></tr>
              ${(term.length > 0 || state.categoryVisible[cat] !== false) && cats[cat].map(p => html`
                <tr key=${p.name}>
                  <td style="cursor:pointer;width:24px;text-align:center;font-size:1.1rem;color:${state.paramFavorites.includes(p.name)?'var(--amber)':'var(--text3)'}"
                    onclick=${() => dispatch({ type: 'TOGGLE_PARAM_FAV', payload: p.name })}>
                    ${state.paramFavorites.includes(p.name) ? '★' : '☆'}
                  </td>
                  <td>${p.i !== undefined ? p.i : '-'}</td>
                  <td><div class="tooltip">${p.name}<span class="tooltiptext ${docstrings.get(p.name) ? '' : 'tooltiptext-empty'}">${docstrings.get(p.name) || 'No description available.'}</span></div></td>
                  <td>
                    ${editing === p.name ? html`
                      <input type="number" min=${p.minimum} max=${p.maximum} step="0.05" value=${editValue} 
                        oninput=${e => setEditValue(e.target.value)}
                        onblur=${() => saveParam(p.name, editValue)}
                        onkeyup=${e => e.keyCode === 13 && saveParam(p.name, editValue)}
                        autofocus />
                    ` : p.enums ? html`
                      <select class="styled" value=${String(p.value)} onchange=${e => saveParam(p.name, e.target.value)}>
                        ${Object.keys(p.enums).map(k => html`<option value=${k}>${p.enums[k]}</option>`)}
                      </select>
                    ` : html`
                      <span onclick=${() => { setEditing(p.name); setEditValue(p.value); }} style="cursor:pointer">${p.value}</span>
                    `}
                  </td>
                  <td>${p.unit && p.unit.indexOf('=') === -1 ? p.unit : ''}</td>
                  <td>${p.minimum}</td>
                  <td>${p.maximum}</td>
                  <td>${p.default}</td>
                </tr>
              `)}
            `)}
          </tbody>
        </table>
      </div>
    </div>
    ${showSubscribe && html`
      <${Modal} id="subscribe-modal" title="Subscribe to parameter set" onClose=${() => setShowSubscribe(false)}>
        <p style="font-size:.85rem">The Parameter Database lets OpenInverter community members share parameter settings. Browse it <a href="https://openinverter.org/parameters/" target="_blank">here</a>.</p>
        <p style="font-size:.85rem">Enter a subscription token to automatically sync your inverter's settings with a parameter set from the database.</p>
        <p style="font-size:.8rem;color:var(--text2)">Note: your inverter needs internet access for this feature.</p>
        <div style="display:flex;gap:8px;align-items:center;margin-top:.5rem">
          <input type="text" placeholder="Subscription token" value=${subToken} oninput=${e => setSubToken(e.target.value)} style="flex:1" />
          <button onclick=${doSubscribe}>Subscribe</button>
        </div>
      </${Modal}>
    `}
  `;
};

// ==================== Spot Values ====================

const SpotValues = () => {
  const { state, dispatch } = useContext(Store);
  const [search, setSearch] = useState('');
  const [fastVals, setFastVals] = useState({});
  const [multiCol, setMultiCol] = useState(false);
  const [sparks, setSparks] = useState(() => { try { return localStorage.getItem('spotSparks') === '1'; } catch (e) { return false; } });
  const wrapRef = useRef(null);
  const fetchRef = useRef(null);
  // Per-name value history for sparklines. Lives in a ref (no re-render cost),
  // arrays mutated in place and capped; identity guard = one pass per data arrival.
  const histRef = useRef({ _src: null });

  if (!state.spotValues) return html`<div class="tabdiv main-content" style="display:flex"><p>Loading...</p></div>`;

  if (sparks) {
    const src = (state.logging && Object.keys(fastVals).length) ? fastVals : state.spotValues;
    if (src && histRef.current._src !== src) {
      histRef.current._src = src;
      const H = histRef.current;
      for (const name in src) {
        const raw = src === fastVals ? src[name] : parseFloat(src[name].value);
        if (typeof raw !== 'number' || isNaN(raw)) continue;
        const arr = H[name] || (H[name] = []);
        arr.push(raw);
        if (arr.length > 40) arr.shift();
      }
    }
  }

  const all = Object.values(state.spotValues);
  const term = search.toLowerCase();
  const hasFavs = (state.spotFavorites || []).length > 0;
  const showFavs = state.showFavoritesOnly && hasFavs;

  // The inverter's UART terminal truncates commands at 128 chars — when the
  // favourites no longer fit a single 'get', skip fast mode and keep normal
  // json polling (CAN mode allows long commands)
  const fastCmdLen = 4 + (state.spotFavorites || []).join(',').length;
  const fastModeOk = state.canMode || fastCmdLen <= 128;

  // High-perf fetch loop when in favorites-only mode
  useEffect(() => {
    if (!showFavs || !fastModeOk) {
      dispatch({ type: 'SET_LOGGING', payload: false });
      setFastVals({});
      return;
    }
    const names = state.spotFavorites.slice(); // freeze this loop's list
    if (names.length === 0) return;

    dispatch({ type: 'SET_LOGGING', payload: true });
    setFastVals({}); // drop values from a previous favourites list immediately
    let active = true;
    const interval = 100;

    const fetchLoop = async () => {
      if (!active) return;
      const t0 = performance.now();
      try {
        const text = await api.getText('get ' + names.join(','));
        if (!active) return;
        const vals = text.match(/[\-\d\.]+/g) || [];
        // A count mismatch means the response can't be trusted positionally
        if (vals.length !== names.length) throw new Error('count mismatch');
        const next = {};
        names.forEach((name, i) => {
          const val = parseFloat(vals[i]);
          if (!isNaN(val)) next[name] = val;
        });
        setFastVals(next);
      } catch (e) { /* ignore */ }
      if (active) {
        const elapsed = performance.now() - t0;
        fetchRef.current = setTimeout(fetchLoop, Math.max(0, interval - elapsed));
      }
    };

    fetchRef.current = setTimeout(fetchLoop, 0);
    return () => {
      active = false;
      dispatch({ type: 'SET_LOGGING', payload: false });
      if (fetchRef.current) { clearTimeout(fetchRef.current); fetchRef.current = null; }
    };
  }, [showFavs, state.spotFavorites, fastModeOk]);

  // Search always searches all items, then favorites filter applies
  let filtered = term ? all.filter(v => v.name.toLowerCase().includes(term)) : all;
  if (showFavs) filtered = filtered.filter(v => state.spotFavorites.includes(v.name));
  const isFav = (name) => (state.spotFavorites || []).includes(name);
  // Use fast value if available, otherwise store value (with enum resolution)
  const getDisplay = (v) => {
    // Entries without a param id (e.g. serial) can't be read by the fast
    // 'get' loop — always show their static value. Virtual values are
    // id-less but served live by the firmware.
    if (showFavs && fastVals[v.name] !== undefined && (v.id !== undefined || v.virtual)) {
      const val = fastVals[v.name];
      if (v.enums) {
        if (v.enums[val] !== undefined) return v.enums[val];
        const a = []; for (const k in v.enums) if (val & parseInt(k)) a.push(v.enums[k]);
        if (a.length > 0) return a.join('|');
      }
      return val;
    }
    return v.display;
  };

  // Tooltip text for a spot value. Virtual values are CAN-RX mappings, so we
  // point the user at the CAN Mapping page rather than a static docstring.
  const svTip = (v) => v.virtual
    ? 'Virtual spot value, mapped from a received CAN frame. Edit it on the CAN Mapping page.'
    : (docstrings.get(v.name) || 'No description available.');
  const svTipEmpty = (v) => !v.virtual && !docstrings.get(v.name);

  // Enable multi-column only if table content overflows available height
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const check = () => {
      const table = el.querySelector('table');
      if (!table) return;
      const availH = window.innerHeight - el.getBoundingClientRect().top - 40;
      setMultiCol(table.scrollHeight > availH);
    };
    check();
    // Re-check when filtered items change
    const ro = new ResizeObserver(check);
    const table = el.querySelector('table');
    if (table) ro.observe(table);
    return () => ro.disconnect();
  }, [filtered]);

  // Tooltips sit above the name by default; for items near the top of the
  // scroll area (the top row of each column in multi-column layout) that would
  // clip, so flip those below on hover when there isn't room above.
  const flipTipIfClipped = (e) => {
    const wrap = wrapRef.current;
    const tip = e.target.closest && e.target.closest('.tooltip');
    if (!wrap || !tip) return;
    const txt = tip.querySelector('.tooltiptext');
    if (!txt) return;
    const roomAbove = tip.getBoundingClientRect().top - wrap.getBoundingClientRect().top;
    tip.classList.toggle('tip-below', roomAbove < txt.offsetHeight + 10);
  };

  return html`
    <div id="spotvalues" class="tabdiv main-content" style="display:flex">
      <div class="main-right">
        <h3 class="underline">Filter</h3>
        <input type="text" placeholder="Search spot values..." value=${search}
          oninput=${e => setSearch(e.target.value)}
          style="width:100%;margin-bottom:.25rem" />
        <p class="sv-count" style="font-size:.75rem;color:var(--text3);margin:0 0 .25rem">${filtered.length} of ${all.length} items</p>
        <h3 class="underline sv-view-head">View</h3>
        <${ToggleRow} label="★ Favorites only" checked=${showFavs} disabled=${!hasFavs}
          onChange=${() => dispatch({ type: 'TOGGLE_FAVORITES_ONLY' })} />
        <${ToggleRow} label="Sparklines" checked=${sparks}
          onChange=${on => { setSparks(on); try { localStorage.setItem('spotSparks', on ? '1' : '0'); } catch (e) {} }} />
        ${showFavs && !fastModeOk && html`
          <p style="font-size:.72rem;color:var(--amber);margin:.25rem 0 0">
            Fast mode off — too many favourites for the UART command limit; values update at the normal refresh rate.
          </p>
        `}
      </div>
      <div class="main-left">
        <h2>Spot Values</h2>
        <div id="spotValuesWrap" ref=${wrapRef} class="fullheight ${multiCol ? 'multi-col' : ''}" style="overflow-y:auto" onmouseover=${flipTipIfClipped}>
        <table id="spotValues" style="width:auto;table-layout:auto">
          <thead><tr><th class="h-fav" style="width:32px"></th><th>Name</th><th class="h-val" style="width:100px;min-width:100px">Value</th>${sparks && html`<th class="h-spark" style="width:76px">Trend</th>`}<th class="h-unit" style="width:44px;min-width:44px">Unit</th></tr></thead>
          <tbody>
            ${filtered.map(v => html`
              <tr key=${v.name}>
                <td style="width:28px;text-align:center;padding:2px">
                  <button onclick=${() => dispatch({ type: 'TOGGLE_SPOT_FAV', payload: v.name })}
                    style="background:none;border:none;cursor:pointer;font-size:1rem;padding:0;color:${isFav(v.name)?'var(--amber)':'var(--text3)'}">
                    ${isFav(v.name) ? '★' : '☆'}
                  </button>
                </td><td class="sv-name"><div class="tooltip">${v.name}<span class="tooltiptext ${svTipEmpty(v) ? 'tooltiptext-empty' : ''}">${svTip(v)}</span></div></td><td class="sv-val">${getDisplay(v)}</td>${sparks && html`<td class="sv-spark">${!v.enums && html`<${Sparkline} data=${histRef.current[v.name]} width=${64} height=${16} />`}</td>`}<td class="sv-unit">${v.unit && v.unit.indexOf('=') === -1 ? v.unit : ''}</td></tr>
            `)}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  `;
};

// Export the web interface configuration (favourites, gauges, plots, virtual
// values, UI prefs) as one JSON bundle. Shared by the Settings and Update tabs.
const exportUiSettings = async () => {
  const grab = (url) => fetch(url).then(r => r.json()).catch(() => null);
  const [favorites, gauges, plots, virtualvals] = await Promise.all([grab('/favorites.json'), grab('/gauges.json'), grab('/plots.json'), grab('/virtualvals.json')]);
  const prefs = {};
  try {
    ['theme', 'accentColor', 'spotSparks', 'keepAwake', 'dashMetrics'].forEach(k => {
      const v = localStorage.getItem(k);
      if (v != null) prefs[k] = v;
    });
  } catch (e) {}
  const bundle = { type: 'openinverter-ui-settings', version: 1, exported: new Date().toISOString(), favorites, gauges, plots, virtualvals, prefs };
  const a = document.createElement('a');
  a.href = 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(bundle, null, 2));
  a.download = 'ui-settings.json';
  a.click();
};

// ==================== Update ====================

const Update = () => {
  const { state, dispatch } = useContext(Store);
  const [updating, setUpdating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [updateMsg, setUpdateMsg] = useState('');
  const [releases, setReleases] = useState([]);
  const [otaMsg, setOtaMsg] = useState('');
  // Update-from-GitHub state for the web interface OTA
  const [otaTarget, setOtaTarget] = useState('esp32_wemos');
  const [ghUrl, setGhUrl] = useState('');
  const [ghReleases, setGhReleases] = useState([]); // [{tag, assets:[{name,url}]}]
  const [ghTag, setGhTag] = useState('');
  const [ghAssetUrl, setGhAssetUrl] = useState('');
  const [ghMsg, setGhMsg] = useState('');
  const fileRef = useRef(null);
  const webFileRef = useRef(null);
  const espOtaRef = useRef(null);
  // Daily new-release check master switch ("Get releases" IS the manual check)
  const [autoChk, setAutoChk] = useState(getUpdateCheckAuto);
  // The daily check flagged a release newer than the running version
  const updateNewer = (() => {
    const latest = parseVer(state.updateTag), cur = parseVer(state.webVersion);
    return !!(latest && cur && verNewer(latest, cur));
  })();

  // Default the GitHub URL to the repo this firmware was built from. When a
  // newer release is known (the navbar badge brought the user here), load
  // its release list straight away — once per page load, not per tab visit.
  useEffect(() => {
    api.getOtaInfo().then(info => {
      setOtaTarget(info.target || 'esp32_wemos');
      const repo = info.repo || 'https://github.com/wjcloudy/esp32-web-interface';
      setGhUrl(repo);
      if (updateNewer && !Update._autoLoaded) {
        Update._autoLoaded = true;
        getGhReleases(repo);
      }
    });
  }, []);

  // The OTA asset matching this board, e.g. esp32_wemos_<ver>-ota.bin (matched on
  // the '<target>_' prefix so the two targets never cross-match). undefined if none.
  const matchTargetAsset = (assets) => assets.find(a => a.name.startsWith(otaTarget + '_'));

  // Default-select the matching image; if none matches, fall back to the first
  // but warn so the user picks a target deliberately (any asset is still selectable).
  const applyAssetDefault = (assets) => {
    const match = matchTargetAsset(assets);
    setGhAssetUrl((match || assets[0]).url);
    setGhMsg(match ? '' : 'No image matches this board (' + otaTarget + ') — choose a target manually below');
  };

  const getGhReleases = async (urlArg) => {
    const m = (typeof urlArg === 'string' ? urlArg : ghUrl).match(/github\.com[/:]([^/]+)\/([^/.\s]+)/);
    if (!m) { setGhMsg('Enter a github.com repository URL'); return; }
    setGhMsg('Loading releases...');
    setGhReleases([]); setGhTag(''); setGhAssetUrl('');
    try {
      const rels = await api.fetchReleasesFor(m[1], m[2]);
      const list = (rels || []).map(r => ({
        tag: r.tag_name,
        assets: (r.assets || []).filter(a => a.name.endsWith('-ota.bin')).map(a => ({ name: a.name, url: a.browser_download_url })),
      })).filter(r => r.assets.length);
      setGhReleases(list);
      if (!list.length) { setGhMsg('No OTA images (*-ota.bin) found in this repo\'s releases'); return; }
      setGhTag(list[0].tag);
      applyAssetDefault(list[0].assets);
    } catch (e) { setGhMsg('Failed: ' + e.message); }
  };

  const onGhTag = (tag) => {
    setGhTag(tag);
    const rel = ghReleases.find(r => r.tag === tag);
    if (rel) applyAssetDefault(rel.assets);
  };

  // The device downloads and flashes the image itself — the browser can't fetch
  // GitHub release assets (the download redirects to a host with no CORS headers).
  const installFromGithub = async () => {
    if (!ghAssetUrl) return;
    const name = ghAssetUrl.split('/').pop();
    if (!confirm('Download and install "' + name + '"?\n\nThis erases saved settings and favourites (the whole filesystem is replaced) — export them first if you want to keep them.\n\nThe device will reboot when done.')) return;
    setGhMsg('');
    setUpdating(true); setProgress(0); setUpdateMsg('Device is downloading ' + name + ' — do not power off.');
    dispatch({ type: 'SET_LOGGING', payload: true });
    try {
      const r = await fetch('/espupdate-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'url=' + encodeURIComponent(ghAssetUrl),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.message || ('HTTP ' + r.status));
      // The download/flash runs in the background on the device; poll for progress.
      let fails = 0, lastPct = 0;
      while (true) {
        await new Promise(res => setTimeout(res, 500));
        let st;
        try { st = await (await fetch('/espupdate-status')).json(); fails = 0; }
        catch (e) {
          if (++fails > 4) {
            // Silence only means "rebooting after success" if the flash was
            // essentially done — losing WiFi at 3% is a failure, not a reboot
            if (lastPct >= 95) { setProgress(100); setUpdateMsg('Flashed — rebooting, reloading shortly...'); setTimeout(() => location.reload(), 7000); return; }
            throw new Error('Lost contact with the device at ' + lastPct + '% — check it and retry');
          }
          continue;
        }
        if (st.state === 2) { setProgress(100); setUpdateMsg('Flashed — rebooting, reloading shortly...'); setTimeout(() => location.reload(), 7000); return; }
        if (st.state === 3) throw new Error(st.message || 'Update failed');
        lastPct = st.pct || 0;
        setProgress(lastPct);
        setUpdateMsg('Downloading & flashing... ' + lastPct + '%');
      }
    } catch (e) {
      setUpdateMsg('Error: ' + e.message);
      setUpdating(false);
      dispatch({ type: 'SET_LOGGING', payload: false });
    }
  };

  const installFirmware = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    if (!file.name.endsWith('.bin')) { alert('Use .bin file'); return; }
    setUpdating(true); setProgress(0); setUpdateMsg('Uploading...');
    // Pause json polling — its UART/CAN traffic would corrupt the bootloader transfer
    dispatch({ type: 'SET_LOGGING', payload: true });
    try {
      const fd = new FormData();
      fd.append('update-firmware-file', file);
      await api.uploadFile(fd);
    } catch (e) {
      // Failed upload must release the polling pause or the whole app stalls
      setUpdateMsg('Error: upload failed — ' + e.message);
      dispatch({ type: 'SET_LOGGING', payload: false });
      setTimeout(() => setUpdating(false), 4000);
      return;
    }
    if (fileRef.current) fileRef.current.value = ''; // allow re-selecting the same file
    setUpdateMsg('Installing firmware...');

    if (state.canMode) {
      // One continuous background transfer on the ESP, polled for progress
      try {
        await api.runCanUpdate('/' + file.name, (pct, msg) => { setProgress(pct); setUpdateMsg(msg); });
        setUpdateMsg('Update Done!');
        api.deleteFile('/' + file.name);
      } catch (e) {
        setUpdateMsg('Error: ' + e.message);
      }
      setTimeout(() => setUpdating(false), 3000);
      dispatch({ type: 'SET_LOGGING', payload: false });
      return;
    }

    const doStep = async (step) => {
      try {
        const result = await api.runUpdateStep(step, '/' + file.name);
        if (!(result.pages > 0)) throw new Error(result.message || 'Device reported no page count');
        const pct = Math.round(100 * (step + 1) / result.pages);
        setProgress(pct);
        if (step + 1 < result.pages) setTimeout(() => doStep(step + 1), 50);
        else {
          setUpdateMsg('Update Done!');
          api.deleteFile('/' + file.name);
          dispatch({ type: 'SET_LOGGING', payload: false });
          setTimeout(() => setUpdating(false), 3000);
        }
      } catch (e) {
        setUpdateMsg('Error: ' + e.message);
        dispatch({ type: 'SET_LOGGING', payload: false });
      }
    };
    doStep(-1);
  };

  const loadReleases = async () => {
    try {
      const rels = await api.fetchGithubReleases();
      const list = [];
      for (const r of rels) {
        for (const a of r.assets) {
          if (a.name.endsWith('.bin')) list.push({ name: r.tag_name + ' : ' + a.name, url: a.browser_download_url });
        }
      }
      setReleases(list);
    } catch (e) { setOtaMsg('Failed to load releases'); }
  };

  const installOTA = async (url) => {
    setOtaMsg('Downloading...');
    try {
      // Guard against an error page being flashed as firmware
      const resp = await fetch(url);
      if (!resp.ok) throw new Error('Download failed (HTTP ' + resp.status + ')');
      const blob = await resp.blob();
      setOtaMsg('Uploading...');
      const fd = new FormData();
      fd.append('updatefile', blob, 'stm32.bin');
      await api.uploadFile(fd);
      setOtaMsg('Flashing...');
      setUpdating(true); setProgress(0); setUpdateMsg('Installing...');
      // Pause json polling — its UART/CAN traffic would corrupt the bootloader transfer
      dispatch({ type: 'SET_LOGGING', payload: true });

      if (state.canMode) {
        try {
          await api.runCanUpdate('/stm32.bin', (pct, msg) => { setProgress(pct); setUpdateMsg(msg); });
          setUpdateMsg('Done!');
          api.deleteFile('/stm32.bin');
        } catch (e) {
          setUpdateMsg('Error: ' + e.message);
        }
        setTimeout(() => setUpdating(false), 3000);
        dispatch({ type: 'SET_LOGGING', payload: false });
        return;
      }

      const doStep = async (step) => {
        try {
          const result = await api.runUpdateStep(step, '/stm32.bin');
          if (!(result.pages > 0)) throw new Error(result.message || 'Device reported no page count');
          setProgress(Math.round(100 * (step + 1) / result.pages));
          if (step + 1 < result.pages) setTimeout(() => doStep(step + 1), 50);
          else {
            setUpdateMsg('Done!');
            api.deleteFile('/stm32.bin');
            dispatch({ type: 'SET_LOGGING', payload: false });
            setTimeout(() => setUpdating(false), 3000);
          }
        } catch (e) {
          setUpdateMsg('Error: ' + e.message);
          dispatch({ type: 'SET_LOGGING', payload: false });
        }
      };
      doStep(-1);
    } catch (e) { setOtaMsg('Error: ' + e.message); dispatch({ type: 'SET_LOGGING', payload: false }); }
  };

  const uploadWebFile = async () => {
    const file = webFileRef.current?.files?.[0];
    if (!file) return;
    try {
      const fd = new FormData();
      fd.append('updatefile', file);
      await api.uploadFile(fd);
      if (webFileRef.current) webFileRef.current.value = '';
      alert('File uploaded');
      dispatch({ type: 'SET_FILE_LIST', payload: await api.getFileList() });
    } catch (e) { alert('Upload failed: ' + e.message); }
  };

  // OTA-flash the web interface from a combined image (firmware + filesystem in
  // one file). Uses XHR so we get real upload progress; the device reboots when
  // done. The firmware and UI are always flashed together so they stay in sync.
  const flashEsp = (file) => new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/espupdate');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) setProgress(Math.round(100 * e.loaded / e.total)); };
    xhr.onload = () => {
      let ok = xhr.status === 200;
      try { ok = JSON.parse(xhr.responseText).ok; } catch (err) {}
      if (ok) resolve();
      else { let m = ''; try { m = JSON.parse(xhr.responseText).message; } catch (err) {} reject(new Error(m || ('HTTP ' + xhr.status))); }
    };
    // The ESP reboots and drops the connection right after a successful flash,
    // which can surface as an error — but onload usually fires first.
    xhr.onerror = () => reject(new Error('Connection lost during upload'));
    const fd = new FormData();
    fd.append('espfile', file, file.name);
    xhr.send(fd);
  });

  const installEsp = async () => {
    const file = espOtaRef.current?.files?.[0];
    if (espOtaRef.current) espOtaRef.current.value = ''; // allow re-selecting the same file
    if (!file) return;
    if (!file.name.endsWith('-ota.bin')) {
      alert('That does not look like an OTA image.\nExpected a combined "*-ota.bin" file, e.g. ' + otaTarget + '_<version>-ota.bin.\n(The full-flash "*-0x000.bin" image cannot be flashed over the air.)');
      return;
    }
    const wrongBoard = !file.name.startsWith(otaTarget + '_');
    const warn = wrongBoard ? '\n\nWARNING: this image is not built for this board (' + otaTarget + ').' : '';
    if (!confirm('Update the web interface from "' + file.name + '"?' + warn + '\n\nThis erases saved settings and favourites (the whole filesystem is replaced) — export them first if you want to keep them.\n\nThe device will reboot when done.')) return;
    setUpdating(true); setProgress(0); setUpdateMsg('Uploading OTA image...');
    dispatch({ type: 'SET_LOGGING', payload: true }); // pause polling so it doesn't compete with the upload
    try {
      await flashEsp(file);
      setProgress(100);
      setUpdateMsg('Flashed — rebooting, reloading shortly...');
      setTimeout(() => location.reload(), 7000);
    } catch (e) {
      setUpdateMsg('Error: ' + e.message);
      dispatch({ type: 'SET_LOGGING', payload: false });
      setTimeout(() => setUpdating(false), 4000);
    }
  };

  return html`
    <div id="update" class="tabdiv main-content" style="display:flex">
      <div class="main-right">
        <h3 class="underline">Inverter/VCU Firmware</h3>
        <form id="upload-firmware-form" enctype="multipart/form-data">
          <input id="update-firmware-file" name="update-firmware-file" type="file" accept=".bin" ref=${fileRef} hidden onchange=${installFirmware} />
          <label class="butt" for="update-firmware-file"><${Icon} n="upload" />Install firmware from file</label>
        </form>
        <div>
          <button onclick=${loadReleases}><${Icon} n="cloud" />Load OTA releases</button>
          ${releases.length > 0 && html`
            <select id="ota-release">
              ${releases.map(r => html`<option value=${r.url}>${r.name}</option>`)}
            </select>
            <button onclick=${() => { const s = document.getElementById('ota-release'); if (s) installOTA(s.value); }}><${Icon} n="download" />OTA Install</button>
          `}
          <p>${otaMsg}</p>
        </div>
        <h3 class="underline">Web Interface</h3>
        ${updateNewer && html`
          <p id="update-newer-note" style="color:var(--accent);font-size:.78rem;font-weight:600;margin:0 0 .25rem">▲ Newer release available: ${state.updateTag}</p>
          <div class="flex-break"></div>
        `}
        <button onclick=${exportUiSettings} title="Updating erases saved settings — back them up first"><${Icon} n="download" />Export settings (backup)</button>
        <div class="flex-break"></div>
        <input type="text" value=${ghUrl} oninput=${e => setGhUrl(e.target.value)}
          placeholder="https://github.com/owner/repo" style="width:100%;margin-bottom:.25rem;font-size:.8rem" />
        <button onclick=${getGhReleases}><${Icon} n="cloud" />Get releases</button>
        <div class="flex-break"></div>
        ${ghReleases.length > 0 && html`
          <select class="styled" value=${ghTag} onchange=${e => onGhTag(e.target.value)} style="width:100%;margin-top:.25rem">
            ${ghReleases.map(r => html`<option value=${r.tag}>${r.tag}</option>`)}
          </select>
          <select class="styled" value=${ghAssetUrl} onchange=${e => setGhAssetUrl(e.target.value)} style="width:100%;margin-top:.25rem">
            ${(ghReleases.find(r => r.tag === ghTag)?.assets || []).map(a => html`<option value=${a.url}>${a.name}${a.name.startsWith(otaTarget + '_') ? ' (this board)' : ''}</option>`)}
          </select>
          <button onclick=${installFromGithub} style="margin-top:.25rem"><${Icon} n="download" />Download & install</button>
          <div class="flex-break"></div>
        `}
        ${ghMsg && html`<p style="font-size:.8rem;margin:.25rem 0 0">${ghMsg}</p>`}
        <form enctype="multipart/form-data">
          <input id="esp-ota-file" type="file" accept=".bin" ref=${espOtaRef} hidden onchange=${installEsp} />
          <label class="butt" for="esp-ota-file"><${Icon} n="upload" />Install OTA image from file</label>
        </form>
        <form id="uploadform" enctype="multipart/form-data">
          <input id="updatefile" name="updatefile" type="file" ref=${webFileRef} hidden onchange=${uploadWebFile} />
          <label class="butt" for="updatefile"><${Icon} n="upload" />Upload single file</label>
        </form>
        <div class="flex-break"></div>
        <${ToggleRow} label="Daily update check" checked=${autoChk}
          onChange=${v => { setAutoChk(v); setUpdateCheckAuto(v); }} />
        ${updating && html`
          <div id="progress" class="graph">
            <div id="upload-firmware-bar" style=${{ width: progress + '%' }}></div>
            <p id="progress-label">${progress}%</p>
          </div>
          <p id="progress-msg">${updateMsg}</p>
        `}
      </div>
      <div class="main-left">
        <h2>Update</h2>
        <p>On this page you can apply software updates to your OpenInverter system.</p>
        <div class="dash-box compact" style="margin-bottom:1rem">
          <h3>Inverter / VCU Firmware</h3>
          <p>Updates the firmware on the <b>inverter or VCU board itself</b> (stm32_sine, stm32_foc, ZombieVerter…) — not this web interface.</p>
          <p>Use <b>Install firmware from file</b> to flash a .bin from your computer, or <b>Load OTA releases</b> to fetch official stm32-sine releases from GitHub.</p>
          <p style="font-size:.8rem;color:var(--text3);margin:0">${state.canMode ? 'Updates are sent over the CAN bus — the device needs the CAN-capable bootloader.' : 'Updates are sent over the serial connection to the inverter.'}</p>
        </div>
        <div class="dash-box compact">
          <h3>Web Interface</h3>
          <p>Updates <b>this ESP32 module</b> — the combined <code>*-ota.bin</code> image carries the ESP32 firmware and the web pages together so they can't drift out of sync.</p>
          <p>A daily check flags newer releases with a badge in the sidebar (toggle it off with <b>Daily update check</b>). When one is available its release list loads automatically; otherwise <b>Get releases</b> lists them from the GitHub repo above (pre-filled with the repo this build came from). The image for your board is selected by default — then <b>Download & install</b>, or use <b>Install OTA image from file</b> to flash one you built locally.</p>
          <p>Use <b>Upload single file</b> for individual file tweaks.</p>
          <p><b>Updating erases your saved settings and favourites</b> — the whole filesystem is replaced. Use <b>Export settings (backup)</b> first, then restore them from Settings afterwards.</p>
          <p style="font-size:.8rem;color:var(--text3);margin:0">The bootloader and partition table aren't touched, so a bad image stays recoverable over USB. The web interface reboots and the page reloads when done.</p>
        </div>
      </div>
    </div>
  `;
};

// ==================== Plot ====================

const colours = ['#4cc9f0','#54e6a4','#ffb454','#ff6b6b','#b78cff','#5b9dff'];

// Theme Chart.js to the design tokens (resolved once at load)
if (typeof Chart !== 'undefined') {
  const cv = (n, f) => { try { const v = getComputedStyle(document.documentElement).getPropertyValue(n).trim(); return v || f; } catch (e) { return f; } };
  Chart.defaults.font.family = cv('--font', 'system-ui, sans-serif');
  Chart.defaults.font.size = 11;
  Chart.defaults.color = cv('--text2', '#9aa3b2');
  Chart.defaults.borderColor = 'rgba(127,146,167,.16)';
  Chart.defaults.elements.line.borderWidth = 2;
  Chart.defaults.elements.line.tension = 0.25;
  Chart.defaults.elements.point.radius = 0;
  Chart.defaults.elements.point.hitRadius = 8;
  const tt = Chart.defaults.plugins.tooltip;
  tt.backgroundColor = cv('--surface3', '#1c2430');
  tt.titleColor = cv('--text', '#e8ecf1');
  tt.bodyColor = cv('--text2', '#9aa3b2');
  tt.borderColor = cv('--border2', 'rgba(255,255,255,.11)');
  tt.borderWidth = 1;
  tt.cornerRadius = 8;
  tt.padding = 10;
}

// Simple chart renderer — just a canvas, no controls
// Renders one plot. Samples arrive via `queueRef` (an array of name->value
// maps) and `sampleTick` bumps once per fetch — pushing is driven by actual
// data arrival, not render identity, so unrelated app re-renders (e.g. the
// 1 Hz age ticker) can no longer inject duplicate points.
const PlotChart = ({ plot, queueRef, sampleTick, maxValues }) => {
  const canvasRef = useRef(null);
  const chartRef = useRef(null);
  const timeRef = useRef(0);
  const { items } = plot;

  useEffect(() => {
    if (canvasRef.current && !chartRef.current && typeof Chart !== 'undefined') {
      chartRef.current = new Chart(canvasRef.current, {
        type: 'line', data: { datasets: [] },
        options: {
          animation: false, parsing: false,
          plugins: { legend: { labels: { boxWidth: 12, font: { size: 11 }, usePointStyle: true } } },
          scales: {
            x: { type: 'linear', display: true, ticks: { maxTicksLimit: 6, font: { size: 10 } }, grid: { display: false } },
            left: { type: 'linear', display: true, position: 'left', ticks: { font: { size: 10 } } },
            right: { type: 'linear', display: true, position: 'right', grid: { drawOnChartArea: false }, ticks: { font: { size: 10 } } }
          }
        }
      });
    }
    // Destroy on unmount — Chart.js keeps a registry entry + ResizeObserver
    // per instance, so tab switches leaked charts before
    return () => { if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null; } };
  }, []);

  useEffect(() => {
    if (!chartRef.current) return;
    const chart = chartRef.current;
    const active = items.filter(p => p.name);
    chart.data.datasets = active.map((p, idx) => ({
      label: p.name, data: [],
      borderColor: colours[idx % colours.length],
      backgroundColor: colours[idx % colours.length],
      fill: false, pointRadius: 0, yAxisID: p.axis || 'left',
    }));
    timeRef.current = 0;
    chart.update('none');
  }, [items]);

  useEffect(() => {
    if (!queueRef || !chartRef.current) return;
    const chart = chartRef.current;
    const active = items.filter(p => p.name);
    if (active.length === 0 || chart.data.datasets.length !== active.length) return;
    // Drain every queued sample — with Burst > 1 several arrive per fetch
    for (const sample of queueRef.current) {
      const t = timeRef.current++;
      active.forEach((p, si) => {
        const val = sample[p.name];
        if (val != null && !isNaN(val) && chart.data.datasets[si]) {
          chart.data.datasets[si].data.push({ x: t, y: val });
          while (chart.data.datasets[si].data.length > maxValues) chart.data.datasets[si].data.shift();
        }
      });
    }
    chart.update('none');
  }, [sampleTick]);

  return html`<div style="margin-bottom:1.5rem"><canvas ref=${canvasRef} width="100%" height="40" style="width:100%;max-height:300px"></canvas></div>`;
};

// Searchable field picker
const FieldPicker = ({ value, spotNames, onChange }) => {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const [search, setSearch] = useState('');
  const triggerRef = useRef(null);
  const filtered = search ? spotNames.filter(n => n.toLowerCase().includes(search.toLowerCase())) : spotNames;

  const toggle = () => {
    // Flip the list upward when there's no room below the trigger
    if (!open && triggerRef.current) {
      const r = triggerRef.current.getBoundingClientRect();
      setUp(window.innerHeight - r.bottom < 290);
    }
    setOpen(!open);
  };

  return html`
    <div style="position:relative;flex:1">
      <div ref=${triggerRef} onclick=${toggle} style="padding:6px 10px;border:1px solid var(--border2);border-radius:var(--radius-xs);font-size:.82rem;cursor:pointer;background:var(--surface);min-width:120px;color:${value ? 'var(--text)' : 'var(--text3)'}">
        ${value || 'Select...'}
      </div>
      ${open && html`
        <div style="position:absolute;${up ? 'bottom:100%;' : 'top:100%;'}left:0;z-index:10;background:var(--surface);border:1px solid var(--border2);border-radius:var(--radius-xs);max-height:240px;overflow-y:auto;min-width:210px;box-shadow:var(--shadow)">
          <input type="text" placeholder="Search..." value=${search} oninput=${e => setSearch(e.target.value)}
            style="width:100%;padding:7px 10px;font-size:.82rem;border:none;border-bottom:1px solid var(--border2);border-radius:0" autofocus />
          ${filtered.map(n => html`
            <div class="hover-row" onclick=${() => { onChange(n); setOpen(false); setSearch(''); }}
              style="padding:6px 10px;font-size:.82rem;cursor:pointer">${n}</div>
          `)}
        </div>
      `}
    </div>
  `;
};

const Plot = () => {
  const { state, dispatch } = useContext(Store);
  const [plots, setPlots] = useState([]);
  const [plotting, setPlotting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [maxValues, setMaxValues] = useState(500);
  const [burstLength, setBurstLength] = useState(5);
  const [sampleTick, setSampleTick] = useState(0); // bumps once per fetch of new samples
  const valsRef = useRef({});
  const queueRef = useRef([]); // samples pending chart draw (several per fetch with Burst)
  const nextId = useRef(1);
  const fetchRef = useRef(null);

  useEffect(() => {
    dispatch({ type: 'SET_LOGGING', payload: true });
    api.getJSON('json').then(json => dispatch({ type: 'SET_PARAMS', payload: json })).catch(() => {});
    return () => dispatch({ type: 'SET_LOGGING', payload: false });
  }, []);

  // Single combined fetch when plotting
  useEffect(() => {
    if (!plotting) return;
    const allNames = [...new Set(plots.flatMap(p => p.items.filter(i => i.name).map(i => i.name)))];
    if (allNames.length === 0) return;

    let running = true;
    const combined = allNames.join(',');

    // Long name lists overflow the inverter's 128-char UART command buffer —
    // fall back to chunked single samples (no burst) rather than truncating
    const chunked = !state.canMode && ('get ' + combined).length > 128;

    const loop = async () => {
      if (!running) return;
      try {
        if (chunked) {
          const sample = await api.getValuesChunked(allNames);
          if (!running) return;
          queueRef.current = [sample];
          valsRef.current = sample;
          setSampleTick(t => t + 1);
        } else {
          const text = await api.getText('get ' + combined, burstLength);
          if (!running) return;
          const vals = text.match(/[\-\d\.]+/g) || [];
          // Only accept whole sample groups: an error reply (or a truncated
          // one) would otherwise shift values onto the wrong series
          const groups = Math.floor(vals.length / allNames.length);
          if (groups > 0 && vals.length === groups * allNames.length) {
            queueRef.current = [];
            for (let gIdx = 0; gIdx < groups; gIdx++) {
              const sample = {};
              allNames.forEach((name, i) => { sample[name] = parseFloat(vals[gIdx * allNames.length + i]); });
              queueRef.current.push(sample);
            }
            valsRef.current = queueRef.current[groups - 1]; // latest, for live readouts
            setSampleTick(t => t + 1);
          }
        }
      } catch (e) { /* ignore */ }
      if (running) fetchRef.current = setTimeout(loop, 100);
    };

    fetchRef.current = setTimeout(loop, 0);
    return () => { running = false; if (fetchRef.current) clearTimeout(fetchRef.current); };
  }, [plotting, plots]);


  const addPlot = () => {
    setPlots([...plots, { id: nextId.current++, items: [] }]);
  };
  const removePlot = (id) => {
    setPlots(plots.filter(p => p.id !== id));
  };
  const addItem = (id) => {
    setPlots(plots.map(p => p.id === id ? { ...p, items: [...p.items, { name: '', axis: 'left' }] } : p));
  };
  const updateItem = (plotId, idx, field, value) => {
    setPlots(plots.map(p => {
      if (p.id !== plotId) return p;
      const ni = [...p.items]; ni[idx] = { ...ni[idx], [field]: value };
      return { ...p, items: ni };
    }));
  };
  const removeItem = (plotId, idx) => {
    setPlots(plots.map(p => p.id === plotId ? { ...p, items: p.items.filter((_, j) => j !== idx) } : p));
  };

  const togglePlotting = () => {
    if (plotting) {
      setPlotting(false);
    } else {
      // Check at least one plot has fields
      if (!plots.some(p => p.items.some(i => i.name))) return;
      setPlotting(true);
    }
  };

  const spotNames = state.spotValues ? Object.keys(state.spotValues) : [];

  const loadPlots = async () => {
    try {
      const r = await fetch('/plots.json');
      if (r.ok) {
        const data = await r.json();
        if (data.plots && Array.isArray(data.plots)) {
          const items = data.plots.map(p => ({ ...p, id: p.id || nextId.current++ }));
          setPlots(items);
          setMaxValues(data.maxValues || 500);
          setBurstLength(data.burstLength || 5);
          if (items.length > 0) nextId.current = Math.max(...items.map(p => p.id)) + 1;
        }
      }
    } catch (e) { /* ignore */ }
  };

  const savePlots = async () => {
    try {
      const json = JSON.stringify({ plots, maxValues, burstLength });
      const blob = new Blob([json], { type: 'application/json' });
      const fd = new FormData();
      fd.append('updatefile', blob, 'plots.json');
      await fetch('/edit', { method: 'POST', body: fd });
    } catch (e) { /* ignore */ }
  };

  useEffect(() => { loadPlots(); }, []);

  return html`
    <div id="plot" class="tabdiv main-content" style="display:flex">
      ${editing && html`
      <div class="main-right">
        <h3 class="underline">Edit Plots</h3>
        <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:8px">
          <div style="display:flex;gap:6px;align-items:center">
            <label style="font-size:.8rem;font-weight:500">Points</label>
            <input type="number" value=${maxValues} oninput=${e => setMaxValues(parseInt(e.target.value)||100)} style="width:5em;font-size:.8rem;padding:4px 6px" />
            <label style="font-size:.8rem;font-weight:500">Burst</label>
            <input type="number" value=${burstLength} oninput=${e => setBurstLength(parseInt(e.target.value)||1)} style="width:4em;font-size:.8rem;padding:4px 6px" />
          </div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">
          <button onclick=${addPlot}><${Icon} n="plus" />Add plot</button>
          <button onclick=${() => { savePlots(); setEditing(false); }}><${Icon} n="check" />Save & Done</button>
        </div>

        ${plots.length > 0 && html`<h3>Active (${plots.length})</h3>`}
        ${plots.map(p => html`
          <div key=${p.id} style="margin-bottom:8px;padding:8px;background:var(--surface2);border-radius:var(--radius-xs)">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
              <span style="font-weight:600;font-size:.8rem">Plot ${p.id}</span>
              <span onclick=${() => removePlot(p.id)} style="cursor:pointer;color:var(--red);font-weight:700;font-size:1rem">×</span>
            </div>
            <div style="margin-bottom:4px">
              <button onclick=${() => addItem(p.id)} style="font-size:.7rem;padding:2px 8px"><${Icon} n="plus" size=${11} />Field</button>
            </div>
            ${p.items.map((item, i) => html`
              <div key=${i} style="display:flex;gap:3px;align-items:center;margin-bottom:2px">
                <${FieldPicker} value=${item.name} spotNames=${spotNames} onChange=${name => updateItem(p.id, i, 'name', name)} />
                <select value=${item.axis || 'left'} onchange=${e => updateItem(p.id, i, 'axis', e.target.value)} title="Y axis" style="width:4.4em;font-size:.78rem;padding:5px 4px;border-radius:var(--radius-xs)">
                  <option value="left">L</option>
                  <option value="right">R</option>
                </select>
                <span onclick=${() => removeItem(p.id, i)} style="cursor:pointer;color:var(--red);font-size:.8rem;line-height:1">×</span>
              </div>
            `)}
          </div>
        `)}
      </div>
      `}
      <div class="main-left">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.5rem;flex-wrap:wrap;gap:6px">
          <h2 style="margin:0">Plot</h2>
          <div style="display:flex;gap:6px;align-items:center">
            <button onclick=${togglePlotting} style=${{ background: plotting ? 'var(--red)' : 'var(--green)', color: plotting ? '#fff' : '#06301d', borderColor: 'transparent', fontWeight: 600, fontSize: '.8rem', padding: '4px 14px' }}>
              ${plotting ? html`<${Icon} n="stop" />` : html`<${Icon} n="play" />`}${plotting ? 'Stop' : 'Start'}
            </button>
            ${!editing && html`<button onclick=${() => { if (plotting) setPlotting(false); setEditing(true); }} style="font-size:.75rem;padding:4px 12px"><${Icon} n="edit" />Edit Layout</button>`}
          </div>
        </div>
        ${plots.map(p => html`
          <${PlotChart} key=${p.id} plot=${p} queueRef=${plotting ? queueRef : null} sampleTick=${sampleTick} maxValues=${maxValues} />
        `)}
        ${plots.length === 0 && !editing && html`<p style="color:var(--text3);text-align:center;padding:2rem 0">Click Edit Layout to add a plot.</p>`}
      </div>
    </div>
  `;
};

// ==================== Logger ====================

const Logger = () => {
  const { state, dispatch } = useContext(Store);
  const [logItems, setLogItems] = useState([]);
  const [samples, setSamples] = useState(500);
  const [logText, setLogText] = useState('');
  const textRef = useRef(null);
  const loggingRef = useRef(false);

  const spotNames = state.spotValues ? Object.keys(state.spotValues) : [];
  const updateItem = (i, field, value) => {
    const ni = [...logItems];
    ni[i] = { ...ni[i], [field]: value };
    setLogItems(ni);
  };

  // Logging loop
  useEffect(() => {
    if (!state.logging) { loggingRef.current = false; return; }
    const names = logItems.filter(i => i.name).map(i => i.name);
    if (names.length === 0) return;

    loggingRef.current = true;
    const maxLines = Math.min(5000, Math.max(50, parseInt(samples) || 500));
    let errs = 0; // consecutive failures — tolerate blips, stop when persistent
    (async function loop() {
      while (loggingRef.current) {
        try {
          // Chunked: long field lists exceed the inverter's 128-char UART
          // command buffer; garbled/mismatched replies throw instead of
          // silently shifting columns
          const out = await api.getValuesChunked(names);
          if (!loggingRef.current) break;
          errs = 0;
          const line = names.map(n => out[n]).join('\t');
          setLogText(prev => {
            const next = prev + line + '\n';
            const lines = next.split('\n');
            if (lines.length > maxLines) lines.splice(0, lines.length - maxLines);
            return lines.join('\n');
          });
          // Auto-scroll
          if (textRef.current) {
            textRef.current.scrollTop = textRef.current.scrollHeight;
          }
        } catch (e) {
          if (++errs < 5) continue; // transient blip — keep logging
          if (loggingRef.current) setLogText(p => p + 'Error: ' + e.message + ' — logging stopped\n');
          // Release the app-wide polling pause, or the whole UI stays stale
          // while the Recording pill misleadingly stays lit
          dispatch({ type: 'SET_LOGGING', payload: false });
          break;
        }
      }
    })();
    return () => { loggingRef.current = false; dispatch({ type: 'SET_LOGGING', payload: false }); };
  }, [state.logging, logItems]);

  const startLog = () => {
    const names = logItems.filter(i => i.name).map(i => i.name);
    if (names.length === 0) { alert('Add at least one field to log'); return; }
    setLogText(names.join('\t') + '\n');
    dispatch({ type: 'SET_LOGGING', payload: true });
  };

  const stopLog = () => dispatch({ type: 'SET_LOGGING', payload: false });

  return html`
    <div id="logger" class="tabdiv main-content" style="display:flex">
      <div class="main-right">
        <h3 class="underline">Actions</h3>
        ${!state.logging ? html`<button onclick=${startLog}><${Icon} n="play" />Start logging</button>`
          : html`<button onclick=${stopLog}><${Icon} n="stop" />Stop logging</button>`}
        <button onclick=${() => {
          const blob = new Blob([logText], { type: 'text/plain' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'log_' + new Date().toISOString().slice(0,19).replace(/:/g,'-') + '.txt';
          a.click();
        }}><${Icon} n="download" />Save as...</button>
        <h3 class="underline">Configure Logger</h3>
        <label>Max lines kept: <input type="number" min="50" max="5000" value=${samples} oninput=${e => setSamples(e.target.value)} style="width:5em" /></label>
        ${logItems.map((item, i) => html`
          <div class="logger-field" key=${i} style="display:flex;gap:4px;align-items:center;margin-bottom:4px">
            <${FieldPicker} value=${item.name || ''} spotNames=${spotNames} onChange=${name => updateItem(i, 'name', name)} />
            ${!state.logging && html`<span onclick=${() => setLogItems(logItems.filter((_, j) => j !== i))} style="cursor:pointer;color:var(--red);font-weight:700;font-size:.9rem;padding:0 4px;line-height:1">×</span>`}
          </div>
        `)}
        ${!state.logging && html`<button onclick=${() => setLogItems([...logItems, { name: '' }])}><${Icon} n="plus" />Add field to log</button>`}
      </div>
      <div class="main-left">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:.75rem">
          <h2 style="margin:0">Data Logger</h2>
          ${state.logging && html`<span class="pill active"><span class="dot"></span>Recording</span>`}
        </div>
        <div class="dash-box compact">
          <textarea id="data-logger-text-area" rows="50" ref=${textRef} value=${logText} readonly></textarea>
        </div>
      </div>
    </div>
  `;
};

// ==================== CAN Mapping ====================

const CanMapping = () => {
  const { state } = useContext(Store);
  const [mappings, setMappings] = useState([]);   // new rows being edited
  const [existing, setExisting] = useState([]);   // mappings read from the device
  const [loading, setLoading] = useState(false);
  const [virtuals, setVirtuals] = useState([]);   // ESP-side virtual spot values
  const [virtMsg, setVirtMsg] = useState('');
  // Inverter mappings can only reference the device's own values — exclude
  // ESP-side virtuals (identified by the firmware's virtual flag, not name)
  const spotNames = state.spotValues ? Object.keys(state.spotValues).filter(n => !state.spotValues[n].virtual) : [];

  // paramid -> name lookup from the loaded parameter database
  const idToName = {};
  for (const src of [state.params || {}, state.spotValues || {}]) {
    for (const n in src) if (src[n].id) idToName[src[n].id] = n;
  }

  const loadMappings = async () => {
    if (!state.canMode) return;
    setLoading(true);
    try {
      const text = await api.getText('can list');
      setExisting(JSON.parse(text));
    } catch (e) { setExisting([]); }
    setLoading(false);
  };

  useEffect(() => { loadMappings(); }, [state.canMode]);

  // Virtual spot values: ESP-side CAN RX mappings stored in /virtualvals.json
  useEffect(() => {
    if (!state.canMode) return;
    fetch('/virtualvals.json').then(r => r.json()).then(d => {
      if (d.items && Array.isArray(d.items)) {
        setVirtuals(d.items.map(it => ({
          ...it,
          name: String(it.name || '').replace(/^v_/, ''),
          // show CAN ids the way people write them
          id: it.id != null ? '0x' + Number(it.id).toString(16).toUpperCase() : '',
        })));
      }
    }).catch(() => {});
  }, [state.canMode]);

  const saveVirtuals = async () => {
    const items = [];
    for (const v of virtuals) {
      const suffix = String(v.name || '').trim().replace(/^v_+/, '').replace(/[^a-zA-Z0-9_]/g, '');
      if (!suffix) continue;
      const id = Number(String(v.id == null ? '' : v.id).trim() || 0);
      if (isNaN(id) || id <= 0 || id > 0x1FFFFFFF) { alert('v_' + suffix + ': invalid CAN ID — use decimal (592) or hex (0x250)'); return; }
      items.push({
        name: 'v_' + suffix,
        unit: String(v.unit || '').slice(0, 10),
        id: id,
        pos: Math.min(63, Math.max(0, Number(v.pos) || 0)),
        len: Math.min(32, Math.max(1, Number(v.len) || 8)),
        gain: Number(v.gain) || 1,
        offset: Number(v.offset) || 0,
        signed: !!v.signed,
      });
    }
    if (items.length > 16) { alert('Maximum 16 virtual values'); return; }
    const fd = new FormData();
    fd.append('updatefile', new Blob([JSON.stringify({ items })], { type: 'application/json' }), 'virtualvals.json');
    await fetch('/edit', { method: 'POST', body: fd });
    const r = await fetch('/virtual-reload').then(x => x.json()).catch(() => ({}));
    setVirtMsg((r.count != null ? r.count : items.length) + ' virtual value(s) active');
    setTimeout(() => setVirtMsg(''), 3000);
  };

  const saveMappings = async () => {
    for (const m of mappings) {
      if (!m.name) continue;
      // CAN id accepts decimal (592) or hex (0x250)
      const cid = Number(String(m.canid == null ? '' : m.canid).trim() || 0);
      if (isNaN(cid) || cid < 0 || cid > 0x1FFFFFFF) { alert(m.name + ': invalid CAN ID "' + m.canid + '" — use decimal (592) or hex (0x250)'); return; }
      const cmd = 'can ' + m.txrx + ' ' + m.name + ' ' + cid + ' ' + Number(m.pos||0) + ' ' + Number(m.bits||8) + ' ' + Number(m.gain||1);
      const r = await api.getText(cmd);
      if (r.indexOf('error') === 0) { alert(m.name + ': ' + r); return; }
    }
    const r = await api.getText('save');
    alert(r || 'Mappings saved');
    setMappings([]);
    loadMappings();
  };

  return html`
    <div id="canmapping" class="tabdiv main-content" style="display:flex">
      <div class="main-right">
        <h3 class="underline">Actions</h3>
        <button onclick=${() => setMappings([...mappings, { name: '', txrx: 'tx', canid: 0, pos: 0, bits: 8, gain: 1 }])}><${Icon} n="plus" />Add new mapping</button>
        <button onclick=${saveMappings}><${Icon} n="save" />Save mappings to flash</button>
        ${state.canMode && html`<button onclick=${loadMappings}><${Icon} n="refresh" />Reload from device</button>`}
        <button onclick=${async () => {
          if (!confirm('Remove ALL CAN mappings from the device?')) return;
          await api.getText('can clear');
          await api.getText('save');
          setMappings([]);
          loadMappings();
        }} style="color:var(--red)"><${Icon} n="trash" />Remove all mappings</button>
      </div>
      <div class="main-left">
        <h2>CAN Mapping</h2>
        <p>Configure CAN mapping settings for your OpenInverter board.</p>
        ${state.canMode && (() => {
          const removeMap = async (m) => {
            await api.getText('can rm ' + m.index + ' ' + m.subindex);
            await api.getText('save');
            loadMappings();
          };
          const mapTable = (list) => html`
            <table style="width:auto;table-layout:auto;margin-bottom:1rem">
              <thead><tr><th style="min-width:110px">Parameter</th><th>CAN ID</th><th>Offset</th><th>Length</th><th>Gain</th><th>Bias</th><th></th></tr></thead>
              <tbody>
                ${list.map(m => html`
                  <tr key=${'e' + m.index + '-' + m.subindex}>
                    <td style="font-weight:500">${idToName[m.paramid] || ('#' + m.paramid)}</td>
                    <td style="font-family:var(--num)">0x${Number(m.id).toString(16).toUpperCase()}</td>
                    <td>${m.position}</td>
                    <td>${m.length}</td>
                    <td>${m.gain}</td>
                    <td>${m.offset}</td>
                    <td><button onclick=${() => removeMap(m)} style="padding:2px 6px;font-size:.7rem;color:var(--red)">✕</button></td>
                  </tr>
                `)}
              </tbody>
            </table>`;
          const txMaps = existing.filter(m => !m.isrx);
          const rxMaps = existing.filter(m => m.isrx);
          return html`
            <h3 class="underline">Mappings on device ${loading ? '(loading...)' : ''}</h3>
            ${existing.length === 0 && !loading && html`<p style="color:var(--text3)">No mappings configured on the device.</p>`}
            ${txMaps.length > 0 && html`
              <h3 style="margin-top:.75rem">Transmit (TX)</h3>
              ${mapTable(txMaps)}
            `}
            ${rxMaps.length > 0 && html`
              <h3 style="margin-top:.75rem">Receive (RX)</h3>
              ${mapTable(rxMaps)}
            `}
          `;
        })()}
        <h3 class="underline">New mappings</h3>
        <table style="width:auto;table-layout:auto">
          <thead><tr><th style="min-width:110px">Spot Value</th><th>TX/RX</th><th style="min-width:60px">CAN ID</th><th style="min-width:50px">Offset</th><th style="min-width:50px">Length</th><th style="min-width:50px">Gain</th><th></th></tr></thead>
          <tbody>
            ${mappings.map((m, i) => html`
              <tr key=${i}>
                <td><select value=${m.name} onchange=${e => { const nm = [...mappings]; nm[i].name = e.target.value; setMappings(nm); }} style="width:100%">
                  <option value="">Select...</option>
                  ${spotNames.map(n => html`<option value=${n}>${n}</option>`)}
                </select></td>
                <td><select value=${m.txrx} onchange=${e => { const nm = [...mappings]; nm[i].txrx = e.target.value; setMappings(nm); }}>
                  <option value="tx">TX</option><option value="rx">RX</option>
                </select></td>
                <td><input type="text" value=${m.canid} placeholder="0x250" oninput=${e => { const nm = [...mappings]; nm[i].canid = e.target.value; setMappings(nm); }} style="width:6em;font-family:var(--num)" /></td>
                <td><input type="number" value=${m.pos} oninput=${e => { const nm = [...mappings]; nm[i].pos = e.target.value; setMappings(nm); }} style="width:4em" /></td>
                <td><input type="number" value=${m.bits} oninput=${e => { const nm = [...mappings]; nm[i].bits = e.target.value; setMappings(nm); }} style="width:4em" /></td>
                <td><input type="number" value=${m.gain} oninput=${e => { const nm = [...mappings]; nm[i].gain = e.target.value; setMappings(nm); }} style="width:4em" /></td>
                <td><button onclick=${() => setMappings(mappings.filter((_, j) => j !== i))} style="padding:2px 6px;font-size:.7rem">✕</button></td>
              </tr>
            `)}
          </tbody>
        </table>
        ${state.canMode && html`
          <h3 class="underline">Virtual spot values</h3>
          <p style="color:var(--text2);font-size:.78rem;margin:0 0 .5rem">
            Capture values directly from CAN frames on this interface — no inverter mapping needed.
            They appear as <b>v_</b>-prefixed spot values usable in gauges, plots and the logger,
            and are included in the Settings export. Max 16.
          </p>
          ${virtuals.length > 0 && html`
            <table style="width:auto;table-layout:auto;margin-bottom:.5rem">
              <thead><tr><th>Name</th><th>CAN ID</th><th>Start bit</th><th>Bits</th><th>Gain</th><th>Offset</th><th>Unit</th><th>Signed</th><th></th></tr></thead>
              <tbody>
                ${virtuals.map((v, i) => html`
                  <tr key=${'v' + i}>
                    <td><div style="display:flex;align-items:center">
                      <span style="color:var(--text3);font-family:var(--num)">v_</span>
                      <input type="text" value=${v.name} oninput=${e => { const nv = [...virtuals]; nv[i].name = e.target.value; setVirtuals(nv); }} style="width:7em;font-family:var(--num)" />
                    </div></td>
                    <td><input type="text" value=${v.id} placeholder="0x250" oninput=${e => { const nv = [...virtuals]; nv[i].id = e.target.value; setVirtuals(nv); }} style="width:6em;font-family:var(--num)" /></td>
                    <td><input type="number" min="0" max="63" value=${v.pos} oninput=${e => { const nv = [...virtuals]; nv[i].pos = e.target.value; setVirtuals(nv); }} style="width:4em" /></td>
                    <td><input type="number" min="1" max="32" value=${v.len} oninput=${e => { const nv = [...virtuals]; nv[i].len = e.target.value; setVirtuals(nv); }} style="width:4em" /></td>
                    <td><input type="number" step="any" value=${v.gain} oninput=${e => { const nv = [...virtuals]; nv[i].gain = e.target.value; setVirtuals(nv); }} style="width:4.5em" /></td>
                    <td><input type="number" step="any" value=${v.offset} oninput=${e => { const nv = [...virtuals]; nv[i].offset = e.target.value; setVirtuals(nv); }} style="width:4.5em" /></td>
                    <td><input type="text" value=${v.unit || ''} oninput=${e => { const nv = [...virtuals]; nv[i].unit = e.target.value; setVirtuals(nv); }} style="width:3.5em" /></td>
                    <td style="text-align:center"><input type="checkbox" checked=${!!v.signed} onchange=${e => { const nv = [...virtuals]; nv[i].signed = e.target.checked; setVirtuals(nv); }} /></td>
                    <td><button onclick=${() => setVirtuals(virtuals.filter((_, j) => j !== i))} style="padding:2px 6px;font-size:.7rem;color:var(--red)">✕</button></td>
                  </tr>
                `)}
              </tbody>
            </table>
          `}
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:1rem">
            <button onclick=${() => virtuals.length < 16 && setVirtuals([...virtuals, { name: '', id: '', pos: 0, len: 16, gain: 1, offset: 0, unit: '', signed: false }])} style="width:auto"><${Icon} n="plus" />Add virtual value</button>
            <button onclick=${saveVirtuals} style="width:auto"><${Icon} n="save" />Save virtual values</button>
            ${virtMsg && html`<span style="font-size:.78rem;color:var(--green)">${virtMsg}</span>`}
          </div>
        `}
      </div>
    </div>
  `;
};

// ==================== Files ====================

const Files = () => {
  const { state, dispatch } = useContext(Store);
  return html`
    <div id="files" class="tabdiv main-content" style="display:flex">
      <div class="main-right">
        <h3 class="underline">Actions</h3>
        <form enctype="multipart/form-data">
          <input id="updatefile2" name="updatefile" type="file" hidden onchange=${async e => {
            const fd = new FormData(e.target.form);
            await api.uploadFile(fd);
            dispatch({ type: 'SET_FILE_LIST', payload: await api.getFileList() });
          }} />
          <label class="butt" for="updatefile2"><${Icon} n="upload" />Upload file</label>
        </form>
      </div>
      <div class="main-left">
        <h2>Files</h2>
        <table>
          <thead><tr><th>Name</th><th>Size</th><th>Actions</th></tr></thead>
          <tbody>
            ${state.fileList.map(f => html`
              <tr key=${f.name}>
                <td>${f.name}</td>
                <td>${f.size}</td>
                <td><button onclick=${async () => { await api.deleteFile(f.name); dispatch({ type: 'SET_FILE_LIST', payload: await api.getFileList() }); }}>Delete</button></td>
              </tr>
            `)}
          </tbody>
        </table>
      </div>
    </div>
  `;
};

// ==================== Settings ====================

// Theme helper (guarded: blocked site-data makes localStorage THROW, and this
// runs at module scope — an unguarded call would blank the whole app)
function getTheme() { try { return localStorage.getItem('theme') || 'system'; } catch (e) { return 'system'; } }
function setTheme(theme) {
  try { localStorage.setItem('theme', theme); } catch (e) {}
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
}
// Apply saved theme on load
(function() {
  const t = getTheme();
  if (t !== 'system') document.documentElement.setAttribute('data-theme', t);
})();

// PWA: register the (no-op) service worker where the origin allows it —
// HTTPS, localhost, or an origin whitelisted via chrome://flags. Enables
// the browser install prompt; inert on plain http.
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Accent colour: overrides --accent/--accent2/--accent-glow across both themes
const ACCENT_PRESETS = ['#4cc9f0', '#54e6a4', '#b78cff', '#ffb454', '#5b9dff', '#ff6b8b'];
function applyAccent(hex) {
  const root = document.documentElement;
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) {
    ['--accent', '--accent2', '--accent-glow'].forEach(p => root.style.removeProperty(p));
    return;
  }
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  root.style.setProperty('--accent', hex);
  root.style.setProperty('--accent2', 'rgb(' + Math.round(r * .82) + ',' + Math.round(g * .82) + ',' + Math.round(b * .82) + ')');
  root.style.setProperty('--accent-glow', 'rgba(' + r + ',' + g + ',' + b + ',.14)');
}
function getAccent() { try { return localStorage.getItem('accentColor') || ''; } catch (e) { return ''; } }
// Apply saved accent on load
applyAccent(getAccent());

// Theme + accent also live on the ESP (uiprefs.json) so the look follows the
// device across browsers, like gauge layouts do. localStorage acts as a
// fast-start cache (no flash of the wrong theme); the device file wins.
fetch('/uiprefs.json').then(r => r.ok ? r.json() : null).then(p => {
  if (!p) return;
  if (p.theme && p.theme !== getTheme()) setTheme(p.theme);
  if ('accentColor' in p && (p.accentColor || '') !== getAccent()) {
    applyAccent(p.accentColor || '');
    try {
      if (p.accentColor) localStorage.setItem('accentColor', p.accentColor);
      else localStorage.removeItem('accentColor');
    } catch (e) {}
  }
  if (Array.isArray(p.dashMetrics)) {
    try {
      if (p.dashMetrics.length) localStorage.setItem('dashMetrics', JSON.stringify(p.dashMetrics.slice(0, 5)));
      else localStorage.removeItem('dashMetrics');
    } catch (e) {}
  }
  if (typeof p.updateCheck === 'boolean') {
    try { localStorage.setItem('updateCheckAuto', p.updateCheck ? '1' : '0'); } catch (e) {}
  }
}).catch(() => {});

// Debounced (the colour picker fires per mouse-move) write-back to the ESP
let _uiPrefsTimer;
function saveUiPrefsToDevice() {
  clearTimeout(_uiPrefsTimer);
  _uiPrefsTimer = setTimeout(() => {
    const blob = new Blob([JSON.stringify({ theme: getTheme(), accentColor: getAccent() || '', dashMetrics: getDashMetrics(), updateCheck: getUpdateCheckAuto() })], { type: 'application/json' });
    const fd = new FormData();
    fd.append('updatefile', blob, 'uiprefs.json');
    fetch('/edit', { method: 'POST', body: fd }).catch(() => {});
  }, 600);
}

// ==================== Update availability check ====================
// Browser-side, once-a-day check of the GitHub Releases API for a newer web
// interface release (the ESP itself often has no internet in AP mode; the
// phone/laptop viewing the page usually does, and api.github.com sends
// CORS *). The repo comes from /otainfo, so forks check their own releases.
//
// The API response is UNTRUSTED input: only tag_name is used, and only when
// it is strictly version-shaped — anything else is discarded before it can
// reach storage or the DOM (which only ever renders it as escaped text).
// Every failure path (offline, rate-limited, blocked, bad JSON) is silent.

const VERSION_TAG_RE = /^v\d+\.\d+(\.\d+)?$/;
function parseVer(s) {
  const m = /^v(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(s || '').trim());
  return m ? [+m[1], +m[2], +(m[3] || 0)] : null;
}
function verNewer(a, b) { // a > b, component-wise
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
function getUpdateCheckAuto() { try { return localStorage.getItem('updateCheckAuto') !== '0'; } catch (e) { return true; } }
function setUpdateCheckAuto(on) {
  try { localStorage.setItem('updateCheckAuto', on ? '1' : '0'); } catch (e) {}
  saveUiPrefsToDevice();
}

async function checkLatestRelease(force) {
  const now = Date.now();
  let cache = null;
  try { cache = JSON.parse(localStorage.getItem('updateCheck') || 'null'); } catch (e) {}
  // Successful checks hold for a day; failures back off an hour, so a flaky
  // connection can't turn every page load into an API request
  if (!force && cache && typeof cache.checkedAt === 'number' &&
      now - cache.checkedAt < (cache.ok ? 24 * 3600e3 : 3600e3)) {
    return (cache.ok && VERSION_TAG_RE.test(cache.tag || '')) ? cache.tag : null;
  }
  let tag = null, ok = false;
  try {
    const info = await api.getOtaInfo();
    const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(info.repo || '');
    if (m) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      const r = await fetch('https://api.github.com/repos/' + m[1] + '/' + m[2] + '/releases/latest',
        { signal: ctrl.signal, headers: { Accept: 'application/vnd.github+json' } });
      clearTimeout(t);
      if (r.ok) {
        const j = await r.json();
        if (j && VERSION_TAG_RE.test(j.tag_name || '')) { tag = j.tag_name; ok = true; }
      }
    }
  } catch (e) { /* offline / CORS / rate-limited — stay silent */ }
  try { localStorage.setItem('updateCheck', JSON.stringify({ tag, ok, checkedAt: now })); } catch (e) {}
  return tag;
}

// Keep-awake: stop the screen sleeping while the interface is open. Uses the
// Screen Wake Lock API where available (secure contexts) and falls back to a
// hidden looping video, so it also works over plain http on the ESP. (NoSleep.js)
let _noSleep = null;
try { if (typeof NoSleep !== 'undefined') _noSleep = new NoSleep(); } catch (e) {}
function getKeepAwake() { try { return localStorage.getItem('keepAwake') === '1'; } catch (e) { return false; } }
function setKeepAwake(on) {
  try { localStorage.setItem('keepAwake', on ? '1' : '0'); } catch (e) {}
  if (!_noSleep) return;
  if (on) _noSleep.enable().catch(() => {}); else _noSleep.disable();
}
// If it was left on, re-arm on the first user gesture (enabling the video
// fallback needs one), since there's no gesture on page load.
if (_noSleep && getKeepAwake()) {
  const arm = () => {
    _noSleep.enable().catch(() => {});
    ['click', 'touchstart', 'keydown'].forEach(ev => document.removeEventListener(ev, arm));
  };
  ['click', 'touchstart', 'keydown'].forEach(ev => document.addEventListener(ev, arm));
}

const Settings = () => {
  const { state, dispatch } = useContext(Store);
  const [txrxSwapped, setTxrxSwapped] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [theme, setThemeState] = useState(getTheme);
  const [accent, setAccentState] = useState(getAccent);
  const [keepAwake, setKeepAwakeState] = useState(getKeepAwake);
  const pickAccent = (hex) => {
    setAccentState(hex || '');
    applyAccent(hex);
    try { hex ? localStorage.setItem('accentColor', hex) : localStorage.removeItem('accentColor'); } catch (e) {}
    saveUiPrefsToDevice();
  };

  // Dashboard hero metrics: five slots, empty = unused (at least slot 1 kept)
  const [dashMetrics, setDashMetrics] = useState(() => {
    const m = getDashMetrics();
    while (m.length < 5) m.push('');
    return m;
  });
  const updateDashMetric = (i, name) => {
    const next = [...dashMetrics];
    next[i] = name;
    setDashMetrics(next);
    const chosen = next.filter(Boolean).slice(0, 5);
    try {
      if (chosen.length) localStorage.setItem('dashMetrics', JSON.stringify(chosen));
      else localStorage.removeItem('dashMetrics'); // back to the udc/tmphs default
    } catch (e) {}
    saveUiPrefsToDevice();
  };

  // Import a previously exported web interface configuration bundle
  const importUiSettings = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const bundle = JSON.parse(await file.text());
      if (bundle.type !== 'openinverter-ui-settings') { alert('Not a UI settings export file'); return; }
      const up = async (name, data) => {
        const fd = new FormData();
        fd.append('updatefile', new Blob([JSON.stringify(data)], { type: 'application/json' }), name);
        await fetch('/edit', { method: 'POST', body: fd });
      };
      if (bundle.favorites) await up('favorites.json', bundle.favorites);
      if (bundle.gauges) await up('gauges.json', bundle.gauges);
      if (bundle.plots) await up('plots.json', bundle.plots);
      if (bundle.virtualvals) { await up('virtualvals.json', bundle.virtualvals); fetch('/virtual-reload').catch(() => {}); }
      try { for (const k in (bundle.prefs || {})) localStorage.setItem(k, bundle.prefs[k]); } catch (err) {}
      // Theme/accent/dashboard metrics also live on the device — restore
      // uiprefs.json so the imported look applies in every browser
      if (bundle.prefs && (bundle.prefs.theme || bundle.prefs.accentColor || bundle.prefs.dashMetrics)) {
        let dm = [];
        try { dm = JSON.parse(bundle.prefs.dashMetrics || '[]'); } catch (err) {}
        await up('uiprefs.json', { theme: bundle.prefs.theme || 'system', accentColor: bundle.prefs.accentColor || '', dashMetrics: dm });
      }
      alert('Settings imported — reloading');
      location.reload();
    } catch (err) { alert('Import failed: ' + err.message); }
  };
  const [apSSID, setApSSID] = useState('');
  const [apPW, setApPW] = useState('');
  const [staSSID, setStaSSID] = useState('');
  const [staPW, setStaPW] = useState('');
  const [staIP, setStaIP] = useState('');
  const [wifiMsg, setWifiMsg] = useState('');
  const [wifiStatus, setWifiStatus] = useState(null); // live /wifi-status (rssi etc.)
  const [apFb, setApFb] = useState(false); // AP broadcasts only as fallback

  // Live link state for the WiFi card — refreshed while Settings is open so
  // the signal reading tracks antenna position/moving the device around
  useEffect(() => {
    let alive = true;
    const load = () => fetch('/wifi-status').then(r => r.ok ? r.json() : null)
      .then(s => { if (alive && s) setWifiStatus(s); }).catch(() => {});
    load();
    const t = setInterval(load, 5000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  // Sub-tab (Device & Connection / Web Interface) — deep-linkable as
  // #settings/device or #settings/web, restored when returning via back
  const [subTab, setSubTab] = useState(() => (parseHash().sub === 'web' ? 'web' : 'device'));
  const pickSubTab = (s) => {
    setSubTab(s);
    if (/^#settings(\/|$)/.test(location.hash)) history.replaceState(null, '', '#settings/' + s);
  };
  const [canMode, setCanMode] = useState(false);
  const [canNodeId, setCanNodeId] = useState(1);
  const [canSpeed, setCanSpeed] = useState(2);
  const [canRxPin, setCanRxPin] = useState(4);
  const [canTxPin, setCanTxPin] = useState(5);
  // Interface settings as persisted on the device — drives the unsaved-change
  // hint and gates scanning (a scan runs on the SAVED config, not the form)
  const [savedCan, setSavedCan] = useState({ mode: false, speed: 2, rx: 4, tx: 5 });
  const [scanState, setScanState] = useState(''); // '' | 'scanning' | result message

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/settings');
        if (r.ok) {
          const data = await r.json();
          setTxrxSwapped(data.txrx_swapped !== false);
          setApFb(data.ap_fallback === true);
          setCanMode(data.can_mode === true);
          if (data.can_node_id) setCanNodeId(data.can_node_id);
          if (data.can_speed !== undefined) setCanSpeed(data.can_speed);
          if (data.can_rx_pin) setCanRxPin(data.can_rx_pin);
          if (data.can_tx_pin) setCanTxPin(data.can_tx_pin);
          setSavedCan({
            mode: data.can_mode === true,
            speed: data.can_speed !== undefined ? data.can_speed : 2,
            rx: data.can_rx_pin || 4, tx: data.can_tx_pin || 5,
          });
        }
      } catch (e) { /* use default */ }
      // Load WiFi info
      try {
        const r = await fetch('/wifi');
        if (r.ok) {
          const html = await r.text();
          // Parse SSIDs from the HTML (simple string extraction)
          const apMatch = html.match(/id="apSSID"[^>]*value="([^"]*)"/);
          const staMatch = html.match(/id="staSSID"[^>]*value="([^"]*)"/);
          const ipMatch = html.match(/Current IP Address: ([^<]*)/);
          if (apMatch) setApSSID(apMatch[1]);
          if (staMatch) setStaSSID(staMatch[1]);
          if (ipMatch) setStaIP(ipMatch[1].trim());
        }
      } catch (e) { /* ignore */ }
      setLoading(false);
    })();
  }, []);

  const toggleTxRx = async (val) => {
    setTxrxSwapped(val);
    setSaving(true);
    try {
      await fetch('/settings?txrx_swap=' + (val ? '1' : '0'), { method: 'POST' });
      setTimeout(() => setSaving(false), 2000);
    } catch (e) { setTxrxSwapped(!val); setSaving(false); }
  };

  // The default-flagged node is what the device should boot on / return to
  const defaultNodeId = () => {
    const def = state.canNodes.find(n => n.default);
    return def ? def.nodeId : canNodeId;
  };

  const saveWiFi = async (type) => {
    setWifiMsg('Saving...');
    try {
      const params = new URLSearchParams();
      if (type === 'ap') { params.set('apSSID', apSSID); params.set('apPW', apPW); }
      else { params.set('staSSID', staSSID); params.set('staPW', staPW); }
      await fetch('/wifi?' + params.toString(), { method: 'POST' });
      setWifiMsg(type === 'ap' ? 'AP settings saved' : 'Station settings saved');
      setTimeout(() => setWifiMsg(''), 3000);
    } catch (e) { setWifiMsg('Save failed'); }
  };

  // Unsaved interface changes: mode always counts; speed/pins only matter in
  // CAN mode. Scanning is only meaningful once the device runs the saved
  // CAN config, so the Scan button stays disabled until then.
  const canDirty = canMode !== savedCan.mode ||
    (canMode && (canSpeed !== savedCan.speed || canRxPin !== savedCan.rx || canTxPin !== savedCan.tx));
  const scanReady = savedCan.mode && !canDirty;

  if (loading) return html`<div class="tabdiv main-content" style="display:flex"><p>Loading...</p></div>`;

  return html`
    <div id="settings" class="tabdiv main-content" style="display:flex">
      <div class="main-left">
        <h2>Settings</h2>
        <div id="settings-subtabs" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:.75rem">
          <button class="page-pill ${subTab === 'device' ? 'active' : ''}" onclick=${() => pickSubTab('device')}>Device & Connection</button>
          <button class="page-pill ${subTab === 'web' ? 'active' : ''}" onclick=${() => pickSubTab('web')}>Web Interface</button>
        </div>
        <div class="settings-grid">
        ${subTab === 'device' && html`

        <div class="dash-box compact">
          <h3>Data Interface</h3>
          <p style="color:var(--text2);font-size:.8rem;margin:0 0 .5rem">How this module talks to the inverter.</p>
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:.5rem">
            <div class="seg" id="iface-seg">
              <button class=${!canMode ? 'sel' : ''} onclick=${() => setCanMode(false)}>UART (Serial)</button>
              <button class=${canMode ? 'sel' : ''} onclick=${() => setCanMode(true)}>CAN Bus</button>
            </div>
            <button id="iface-save" onclick=${async () => {
              setSaving(true);
              try {
                const bootNode = defaultNodeId();
                const params = new URLSearchParams();
                params.set('can_mode', canMode ? '1' : '0');
                params.set('can_node_id', bootNode);
                params.set('can_speed', canSpeed);
                params.set('can_rx_pin', canRxPin);
                params.set('can_tx_pin', canTxPin);
                params.set('can_nodes', JSON.stringify(state.canNodes));
                await fetch('/settings?' + params.toString(), { method: 'POST' });
                dispatch({ type: 'SET_CAN_CONFIG', payload: { canMode, canNodeId: bootNode } });
                if (canMode) dispatch({ type: 'SET_CAN_NODE', payload: bootNode });
                setSavedCan({ mode: canMode, speed: canSpeed, rx: canRxPin, tx: canTxPin });
                setTimeout(() => setSaving(false), 2000);
              } catch (e) { setSaving(false); }
            }} style="font-size:.75rem;padding:4px 14px;margin-left:auto;${canDirty ? 'border-color:var(--amber);color:var(--amber)' : ''}" disabled=${saving}><${Icon} n="save" />${saving ? 'Saving...' : 'Save'}</button>
          </div>
          ${canDirty && html`
            <p style="color:var(--amber);font-size:.78rem;margin:0 0 .5rem">
              Unsaved changes — press <b>Save</b> to apply${canMode ? '. Scanning stays disabled until then' : ''}.
            </p>
          `}

          ${!canMode && html`
            <p class="settings-subhead">UART</p>
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:.25rem">
              <label class="switch">
                <input type="checkbox" checked=${txrxSwapped} onchange=${e => toggleTxRx(e.target.checked)} disabled=${saving} />
                <span class="slider"></span>
              </label>
              <span style="font-weight:600">Swap TX/RX Pins</span>
              ${saving && html`<span style="color:var(--accent);font-size:.75rem">Reinitializing UART...</span>`}
            </div>
            <p style="color:var(--text2);font-size:.8rem;margin:0">
              TX/RX are swapped on Wemos boards used with OpenInverter / ZombieVerter VCU boards.
              ${txrxSwapped ? 'Currently using TX=3, RX=1 (swapped).' : 'Currently using TX=1, RX=3 (normal).'}
            </p>
          `}

          ${canMode && html`
            <p class="settings-subhead">CAN Bus</p>
            <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:.25rem;align-items:center">
              <label style="font-size:.75rem">Speed <select value=${canSpeed} onchange=${e => setCanSpeed(parseInt(e.target.value))} class="styled" style="font-size:.7rem">
                  <option value="0">125k</option>
                  <option value="1">250k</option>
                  <option value="2">500k</option>
                </select>
              </label>
              <label style="font-size:.75rem">RX Pin <input type="number" value=${canRxPin} oninput=${e => setCanRxPin(parseInt(e.target.value)||4)} style="width:4em;padding:2px 4px" /></label>
              <label style="font-size:.75rem">TX Pin <input type="number" value=${canTxPin} oninput=${e => setCanTxPin(parseInt(e.target.value)||5)} style="width:4em;padding:2px 4px" /></label>
            </div>
            <p style="color:var(--text2);font-size:.8rem;margin:0 0 .75rem">Speed and pins apply to all devices on the bus. Default: GPIO4 (RX), GPIO5 (TX).</p>

            <p class="settings-subhead">CAN Devices</p>
            <p style="color:var(--text2);font-size:.78rem;margin:0 0 .5rem">
              Found nodes are stored with the next <b>Save</b>; the <b>default</b> node is selected at boot.
            </p>
            <div style="display:flex;gap:6px;margin-bottom:.5rem">
              <button id="can-scan-btn" onclick=${async () => {
                setScanState('scanning');
                try {
                  const r = await fetch('/can-scan');
                  const devices = await r.json();
                  if (devices.length > 0) {
                    devices.forEach(d => dispatch({ type: 'ADD_CAN_NODE', payload: d }));
                    dispatch({ type: 'SET_CAN_NODE', payload: devices[0].nodeId });
                    fetch('/set-can-node?id=' + devices[0].nodeId);
                  }
                  setScanState(devices.length ? 'Found ' + devices.length + ' device(s)' : 'No devices found');
                } catch (e) {
                  setScanState('Scan failed');
                }
                setTimeout(() => setScanState(''), 2500);
              }} disabled=${scanState === 'scanning' || !scanReady}
                title=${scanReady ? 'Scan the bus for OpenInverter nodes' : 'Save the CAN interface settings first'}
                style="font-size:.75rem;padding:4px 12px">
                ${scanState === 'scanning' ? 'Scanning…' : scanState || html`
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                  Scan for devices`}
              </button>
              <button onclick=${() => {
                const id = parseInt(prompt('Enter node ID (1-127):', '1'));
                if (id >= 1 && id <= 127) dispatch({ type: 'ADD_CAN_NODE', payload: { nodeId: id, name: '' } });
              }} style="font-size:.75rem;padding:4px 12px"><${Icon} n="plus" />Add node</button>
            </div>
            ${state.canNodes.length > 0 && html`
              <div style="display:flex;flex-direction:column;gap:3px">
                ${state.canNodes.map(n => html`
                  <div onclick=${() => {
                    dispatch({ type: 'SET_CAN_NODE', payload: n.nodeId });
                    fetch('/set-can-node?id=' + n.nodeId);
                  }} style="display:flex;align-items:center;gap:8px;padding:3px 6px;cursor:pointer;background:${n.nodeId === state.canActiveNodeId ? 'var(--accent-glow)' : 'var(--surface2)'};border-radius:var(--radius-xs);font-size:.75rem">
                    <span style="font-weight:600;min-width:60px">Node #${n.nodeId}${n.nodeId === state.canActiveNodeId ? ' ●' : ''}</span>
                    ${n.serial ? html`<span style="color:var(--text3);font-size:.7rem">s/n ${n.serial}</span>` : null}
                    ${n.default
                      ? html`<span class="pill info" style="font-size:.55rem;padding:1px 8px;margin-left:auto">default</span>`
                      : html`<button onclick=${e => { e.stopPropagation(); dispatch({ type: 'SET_DEFAULT_NODE', payload: n.nodeId }); }}
                          style="font-size:.6rem;padding:1px 6px;margin-left:auto" title="Boot with this node selected">set default</button>`}
                    <button onclick=${e => { e.stopPropagation(); dispatch({ type: 'REMOVE_CAN_NODE', payload: n.nodeId }); }} style="font-size:.65rem;padding:2px 6px;color:var(--red)">×</button>
                  </div>
                `)}
              </div>
            `}
            ${state.canNodes.length === 0 && html`<p style="color:var(--text3);font-size:.75rem">No devices configured. Scan the bus or add a node manually.</p>`}
          `}
        </div>

        <div class="dash-box compact">
          <h3>WiFi</h3>
          ${wifiStatus && wifiStatus.sta_connected ? html`
            <p style="color:var(--text2);font-size:.8rem;margin:0 0 .5rem;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              <span>Connected to <b>${wifiStatus.ssid}</b>${wifiStatus.ip ? ' — ' + wifiStatus.ip : ''}</span>
              <${WifiSignal} rssi=${wifiStatus.rssi} />
            </p>
          ` : html`
            <p style="color:var(--text2);font-size:.8rem;margin:0 0 .5rem">${staIP ? 'Current IP: ' + staIP : 'Access point and network settings.'}</p>
          `}
          ${/* data-lpignore/data-1p-ignore: these are device-config fields,
              not login credentials — password-manager overlays also render
              in the wrong place inside this CSS multi-column layout
              (offset positions report pre-fragmentation coordinates) */ ''}
          <p class="settings-subhead">Access Point — created by this module</p>
          <div style="display:flex;flex-direction:column;gap:6px;max-width:350px;margin-bottom:.85rem">
            <label style="font-size:.8rem">SSID: <input type="text" value=${apSSID} oninput=${e => setApSSID(e.target.value)} style="width:100%" autocomplete="off" data-lpignore="true" data-1p-ignore /></label>
            <label style="font-size:.8rem">Password: <input type="text" value=${apPW} oninput=${e => setApPW(e.target.value)} style="width:100%" minlength="8" autocomplete="off" data-lpignore="true" data-1p-ignore /></label>
            <button onclick=${() => saveWiFi('ap')} style="align-self:flex-start;font-size:.75rem;padding:4px 12px"><${Icon} n="save" />Save AP settings</button>
          </div>
          <p class="settings-subhead">Station — join an existing network</p>
          <div style="display:flex;flex-direction:column;gap:6px;max-width:350px">
            <label style="font-size:.8rem">Network SSID: <input type="text" value=${staSSID} oninput=${e => setStaSSID(e.target.value)} style="width:100%" autocomplete="off" data-lpignore="true" data-1p-ignore /></label>
            <label style="font-size:.8rem">Password: <input type="text" value=${staPW} oninput=${e => setStaPW(e.target.value)} style="width:100%" autocomplete="off" data-lpignore="true" data-1p-ignore /></label>
            <button onclick=${() => saveWiFi('sta')} style="align-self:flex-start;font-size:.75rem;padding:4px 12px"><${Icon} n="save" />Save station settings</button>
          </div>
          ${wifiMsg && html`<p style="color:var(--accent);font-size:.78rem;font-weight:600;margin:.5rem 0 0">${wifiMsg}</p>`}
          <p class="settings-subhead">Access Point Fallback</p>
          <${ToggleRow} label="Access point only as fallback" checked=${apFb}
            onChange=${v => { setApFb(v); fetch('/settings?ap_fallback=' + (v ? '1' : '0'), { method: 'POST' }).catch(() => {}); }} />
          <p style="font-size:.72rem;color:var(--text3);margin:.35rem 0 0">
            Stops the access point broadcasting while the station connection is up, and brings it
            back automatically if that connection drops. Anyone already connected through the AP
            is never kicked. ${wifiStatus && html`<b>AP is ${wifiStatus.ap_active ? 'broadcasting' + (wifiStatus.ap_clients ? ' (' + wifiStatus.ap_clients + ' client' + (wifiStatus.ap_clients > 1 ? 's' : '') + ')' : '') : 'off — fallback armed'}.</b>`}
          </p>
        </div>

        `}
        ${subTab === 'web' && html`

        <div class="dash-box compact">
          <h3>Appearance & Display</h3>
          <p style="font-size:.8rem;margin:0 0 .35rem">Choose appearance — System follows your device setting.</p>
          <select value=${theme} onchange=${e => { const v = e.target.value; setThemeState(v); setTheme(v); saveUiPrefsToDevice(); }}
            class="styled" style="align-self:flex-start;width:auto;min-width:160px">
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
          <p style="font-size:.8rem;margin:1rem 0 .35rem">Accent colour</p>
          <div class="accent-swatches">
            <button class="swatch reset ${!accent ? 'sel' : ''}" title="Default" onclick=${() => pickAccent('')}><${Icon} n="undo" size=${12} /></button>
            ${ACCENT_PRESETS.map(c => html`
              <button class="swatch ${accent === c ? 'sel' : ''}" style=${{ background: c }} title=${c} onclick=${() => pickAccent(c)}></button>
            `)}
            <input type="color" value=${accent || '#4cc9f0'} oninput=${e => pickAccent(e.target.value)} title="Custom colour" />
          </div>
          <p style="font-size:.8rem;margin:1rem 0 .35rem">Display</p>
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:.25rem">
            <label class="switch">
              <input type="checkbox" checked=${keepAwake} onchange=${e => { setKeepAwakeState(e.target.checked); setKeepAwake(e.target.checked); }} />
              <span class="slider"></span>
            </label>
            <span style="font-weight:600">Keep screen awake</span>
          </div>
          <p style="font-size:.72rem;color:var(--text3);margin:.35rem 0 0">Stops the screen sleeping while this page is open.</p>
        </div>

        <div class="dash-box compact">
          <h3>Dashboard</h3>
          <p style="font-size:.8rem;margin:0 0 .5rem">Choose up to 5 spot values to show on the dashboard hero card. Leave a slot empty to hide it.</p>
          <div style="display:flex;flex-wrap:wrap;gap:8px">
            ${dashMetrics.map((name, i) => html`
              <select class="styled" value=${name} onchange=${e => updateDashMetric(i, e.target.value)}
                style="width:auto;min-width:130px;font-size:.8rem" title=${'Dashboard value ' + (i + 1)}>
                <option value="">— none —</option>
                ${Object.keys(state.spotValues || {}).sort().map(n => html`<option value=${n}>${n}${DASH_METRIC_LABELS[n] ? ' (' + DASH_METRIC_LABELS[n] + ')' : ''}</option>`)}
              </select>
            `)}
          </div>
          ${!dashMetrics.filter(Boolean).length && html`<p style="font-size:.72rem;color:var(--text3);margin:.35rem 0 0">Nothing selected — the default (udc, tmphs) is shown.</p>`}
        </div>

        <div class="dash-box compact">
          <h3>Backup & Restore</h3>
          <p style="font-size:.8rem;margin:0 0 .5rem">Back up or restore favourites, gauge and plot layouts, and UI preferences as a single file.</p>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button onclick=${exportUiSettings} style="width:auto"><${Icon} n="download" />Export settings</button>
            <input id="ui-settings-import" type="file" hidden onchange=${importUiSettings} />
            <label class="butt" for="ui-settings-import" style="width:auto"><${Icon} n="upload" />Import settings</label>
          </div>
        </div>

        `}
        </div>
      </div>
    </div>
  `;
};

// ==================== Support ====================

const Support = () => html`
  <div id="support" class="tabdiv main-content" style="display:flex">
    <div class="main-right">
      <h3 class="underline">Actions</h3>
      <a href="/remote.html" target="_blank"><button><${Icon} n="life" />Start remote support session</button></a>
    </div>
    <div class="main-left">
      <h2>Support</h2>
      <div class="dash-box compact" style="margin-bottom:1rem">
        <h3>Community</h3>
        <p style="margin:0">Get support from the community on the <a href="https://openinverter.org">OpenInverter Forum</a> —
        the best place for configuration questions, parameter advice and troubleshooting.</p>
      </div>
      <div class="dash-box compact" style="margin-bottom:1rem">
        <h3>Paid Support</h3>
        <p style="margin:0">Professional consulting is also available — see the
        <a href="https://openinverter.org/docs/index.html%3Fen_consulting,35.html">details here</a>.</p>
      </div>
      <div class="dash-box compact">
        <h3>Remote Support</h3>
        <p style="margin:0">A remote session opens in a new tab and lets a helper access your inverter through this device.
        Your device must be connected to both the inverter and the internet.</p>
      </div>
    </div>
  </div>
`;

// ==================== Gauges ====================

// Mini line chart for gauge line mode — value and unit passed as props
// Rectangular live line gauge. Sized by w/h (any aspect — tiles can be long
// and flat); the Chart.js chart is resized in place so live resizing never
// remounts it (which would drop the accumulated history). `points` sets the
// visible history length and `sampleMs` how often a sample is taken from the
// ~100ms stream — together they control the scroll rate/time window.
const GaugeLine = ({ name, min, max, value, unit, color, enums, w = 230, h = 175, points = 20, sampleMs = 100, decimals = 1 }) => {
  const canvasRef = useRef(null);
  const chartRef = useRef(null);
  const lastSampleRef = useRef(0);
  const valueH = Math.max(22, Math.round(Math.min(w, h) * 0.16)); // value strip below the chart
  const chartW = Math.max(30, w), chartH = Math.max(24, h - valueH);

  useEffect(() => {
    if (canvasRef.current && !chartRef.current && typeof Chart !== 'undefined') {
      const yMin = min != null ? min : 0;
      const yMax = max != null && max !== 0 ? max : 4000;
      const col = color || colours[0];
      chartRef.current = new Chart(canvasRef.current, {
        type: 'line', data: { datasets: [{ label: name, data: [], borderColor: col, backgroundColor: col + '22', fill: true, pointRadius: 0, tension: 0.3 }] },
        options: {
          animation: false, parsing: false,
          responsive: false, // sized explicitly via chart.resize below
          maintainAspectRatio: false, // tiles can be any shape — never snap back to 2:1
          plugins: { legend: { display: false } },
          scales: {
            x: { type: 'linear', display: false },
            y: { type: 'linear', display: true, min: yMin, max: yMax,
                 ticks: { font: { size: 9 }, stepSize: ((yMax - yMin) / 2) || 1, maxTicksLimit: 3 } }
          }
        }
      });
      chartRef.current.resize(chartW, chartH); // size to the tile immediately
    }
    return () => { if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null; } };
  }, []);

  // Track the tile as it is resized — live, without recreating the chart.
  // Chart.js owns the canvas w/h (it isn't in the vdom), so Preact re-renders
  // can't fight the DPR-scaled bitmap.
  useEffect(() => {
    if (chartRef.current) chartRef.current.resize(chartW, chartH);
  }, [chartW, chartH]);

  useEffect(() => {
    if (!chartRef.current) return;
    const chart = chartRef.current;
    const yMin = min != null ? min : 0;
    const yMax = (max != null && max !== 0) ? max : 4000;
    chart.options.scales.y.min = yMin;
    chart.options.scales.y.max = yMax;
    chart.options.scales.y.ticks.stepSize = ((yMax - yMin) / 2) || 1;
    const col = color || colours[0];
    if (chart.data.datasets[0]) {
      chart.data.datasets[0].borderColor = col;
      chart.data.datasets[0].backgroundColor = col + '22';
    }
    chart.update('none');
  }, [min, max, color]);

  // Shrinking the history trims the tail immediately
  useEffect(() => {
    const chart = chartRef.current;
    const ds = chart && chart.data.datasets[0];
    if (!ds || ds.data.length <= points) return;
    ds.data.splice(0, ds.data.length - points);
    ds.data.forEach((pt, i) => { pt.x = i; });
    chart.update('none');
  }, [points]);

  useEffect(() => {
    if (value == null || isNaN(value) || !chartRef.current) return;
    const now = performance.now();
    if (now - lastSampleRef.current < sampleMs) return; // decimate to the sample rate
    lastSampleRef.current = now;
    const chart = chartRef.current;
    const ds = chart.data.datasets[0];
    if (!ds) return;
    ds.data.push({ x: ds.data.length, y: value });
    while (ds.data.length > points) ds.data.shift();
    // Renumber x values so they remain contiguous from 0
    ds.data.forEach((pt, i) => { pt.x = i; });
    chart.update('none');
  }, [value]);

  return html`
    <div style=${'width:' + w + 'px;height:' + h + 'px;display:flex;flex-direction:column;align-items:center;overflow:hidden'}>
      <canvas ref=${canvasRef}></canvas>
      <div class="g-val" style=${'font-size:' + Math.max(0.8, Math.min(w, h) / 230 * 1.6).toFixed(2) + 'rem;margin-top:2px;line-height:1'}>
        ${value != null ? (enums ? String(Math.round(value)) : value.toFixed(decimals)) : '—'}
        ${enums
          ? (value != null && html`<span class="g-unit g-enum" style="display:inline;margin-left:6px">${enumLabel(enums, value)}</span>`)
          : (unit && html`<span class="g-unit" style="display:inline;margin-left:4px">${unit}</span>`)}
      </div>
    </div>
  `;
};

// Rotate a hex colour's hue by deg, keeping saturation/lightness —
// custom gauge gradients sweep hue like the default cyan->green one
const hueShift = (hex, deg) => {
  const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0, sat = 0;
  const l = (max + min) / 2;
  if (d) {
    sat = l > .5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return 'hsl(' + Math.round((h + deg + 360) % 360) + ',' + Math.round(sat * 100) + '%,' + Math.round(l * 100) + '%)';
};

// Modern SVG arc gauge — 270° sweep, gradient stroke, mono numerals.
// Pure render: value changes animate via CSS transition on the dash array.
// A custom colour keeps the gradient look, centered on the chosen colour.
const SvgGauge = ({ id, value, min = 0, max = 100, unit, color, enums, px, decimals = 1 }) => {
  const size = px || 230, c = size / 2, r = Math.round(size * 0.4);
  const sw = Math.max(8, Math.round(size * 0.057));
  const SWEEP = 270; // degrees, gap centered at the bottom
  const v = (value == null || isNaN(value)) ? null : value;
  const span = (max - min) || 1;
  const frac = v == null ? 0 : Math.min(1, Math.max(0, (v - min) / span));
  const circ = 2 * Math.PI * r;
  const arc = circ * SWEEP / 360;
  const grad = 'ggrad' + id;
  const custom = color && /^#[0-9a-fA-F]{6}$/.test(color);
  const stroke = 'url(#' + grad + ')';
  return html`
    <div class="svg-gauge" style=${'width:' + size + 'px;height:' + size + 'px'}>
      <svg width=${size} height=${size} viewBox=${'0 0 ' + size + ' ' + size}>
        <defs>
          <linearGradient id=${grad} x1="0" y1="1" x2="1" y2="0">
            ${custom ? html`
              <stop offset="0%" stop-color=${hueShift(color, 21)} />
              <stop offset="50%" stop-color=${color} />
              <stop offset="100%" stop-color=${hueShift(color, -21)} />
            ` : html`
              <stop offset="0%" stop-color="#4cc9f0" />
              <stop offset="100%" stop-color="#54e6a4" />
            `}
          </linearGradient>
        </defs>
        <g transform=${'rotate(135 ' + c + ' ' + c + ')'}>
          <circle class="g-track" cx=${c} cy=${c} r=${r} stroke-dasharray=${arc + ' ' + circ} style=${'stroke-width:' + sw + 'px'} />
          <circle class="g-value ${frac >= 0.92 ? 'over' : ''}" cx=${c} cy=${c} r=${r}
            stroke=${stroke} opacity=${frac > 0.004 ? 1 : 0}
            stroke-dasharray=${(arc * frac) + ' ' + circ} style=${'stroke-width:' + sw + 'px'} />
        </g>
      </svg>
      <div class="g-center">
        <div class="g-val" style=${'font-size:' + (size / 230 * 2.1).toFixed(2) + 'rem'}>${v == null ? '—' : (enums ? String(Math.round(v)) : v.toFixed(decimals))}</div>
        ${enums
          ? (v != null && html`<div class="g-unit g-enum">${enumLabel(enums, v)}</div>`)
          : (unit && html`<div class="g-unit">${unit}</div>`)}
      </div>
      ${size >= 90 && html`
        <div class="g-min" style=${'left:' + Math.round(size * 0.174) + 'px;bottom:' + Math.round(size * 0.072) + 'px;font-size:' + Math.max(0.68, size / 230 * 0.68).toFixed(2) + 'rem'}>${min}</div>
        <div class="g-max" style=${'right:' + Math.round(size * 0.174) + 'px;bottom:' + Math.round(size * 0.072) + 'px;font-size:' + Math.max(0.68, size / 230 * 0.68).toFixed(2) + 'rem'}>${max}</div>
      `}
    </div>`;
};

// ==================== Gauges (grid dashboard) ====================
// Named pages of freely draggable/resizable tiles on a GridStack grid
// (vendored, MIT). The column count is fixed at 10 so a layout is one
// coordinate space on every device — it scales rather than reflows, and a
// page laid out on the desktop looks the same on a phone. 10 columns (not
// 12) keeps cells big enough that a phone-width grid stays readable.
// gauges.json v3: { v: 3, autoPage, pages: [{ id, name, cond?, items:
// [{ id, name, type, color, min, max, invert?, x, y, w, h }] }] }. cond
// ({ name, min?, max?, invert }) drives conditional page display — an
// inclusive value range with open ends, outside-the-range when inverted;
// autoPage is its master switch. v2 (same shape, 12-column coordinates) is
// rescaled; v1 ({ items, size }) migrates transparently; the settings export
// bundle carries the file wholesale.

const GRID_COLS = 10;
const V1_SPAN = { xs: 2, sm: 2, md: 3, lg: 4 }; // legacy fixed sizes -> tile span (10-col)

// Per-type tile rules: indicators and text tiles can go down to 1 cell;
// dials/lamps stay square, line charts and text strips can be any shape
const tileFloor = (type) => (type === 'indicator' || type === 'text') ? 1 : 2;
const tileFreeform = (type) => type === 'line' || type === 'text';

// A page condition ({ name, min, max, invert }) matches while the value sits
// inside min..max INCLUSIVE — so equality is min = max (opmode 3..3 matches
// only 3, not 2 or 4). A blank/missing bound is open-ended (min 500 alone =
// "500 and above"); invert matches outside the range (0..0 inverted = "any
// non-zero"). Used by conditional page display.
const condMatch = (cond, val) => {
  if (val == null || isNaN(val)) return false;
  const lo = (cond.min == null || isNaN(cond.min)) ? -Infinity : cond.min;
  const hi = (cond.max == null || isNaN(cond.max)) ? Infinity : cond.max;
  const inside = val >= lo && val <= hi;
  return cond.invert ? !inside : inside;
};

function migrateGauges(data) {
  if (data && Array.isArray(data.pages)) {
    // v2 layouts were authored on a 12-column grid — rescale to 8 columns
    const scale = (data.v >= 3) ? 1 : GRID_COLS / 12;
    const pages = data.pages
      .map((p, pi) => ({
        id: p.id || pi + 1,
        name: p.name || 'Page ' + (pi + 1),
        cond: (p.cond && p.cond.name) ? p.cond : undefined,
        items: (Array.isArray(p.items) ? p.items : []).map(g => {
          const type = g.type || 'radial';
          const floor = tileFloor(type);
          let w = Math.max(floor, Math.round((g.w || 3) * scale));
          let h = Math.max(floor, Math.round((g.h || 3) * scale));
          if (!tileFreeform(type)) w = h = Math.min(w, h); // dials/lamps are square
          let x = Math.round((g.x || 0) * scale), y = Math.round((g.y || 0) * scale);
          x = Math.max(0, Math.min(x, GRID_COLS - w)); // keep on the grid
          return { type: 'radial', ...g, x, y, w, h };
        }),
      }));
    return pages.length ? pages : [{ id: 1, name: 'Main', items: [] }];
  }
  // v1: single page; flow the old fixed-size list onto the grid
  const v1 = (data && Array.isArray(data.items)) ? data.items : [];
  const items = v1.map((g, i) => {
    const base = typeof g === 'string' ? { name: g, min: 0, max: 100 } : g;
    const span = V1_SPAN[base.size || (data && data.size)] || 2;
    const perRow = Math.max(1, Math.floor(GRID_COLS / span));
    const { size, ...rest } = base;
    return {
      type: 'radial', min: 0, max: 4000, ...rest,
      x: (i % perRow) * span, y: Math.floor(i / perRow) * span, w: span, h: span,
    };
  });
  return [{ id: 1, name: 'Main', items }];
}

// Indicator lamp for On/Off and 0/1 values: min/max describe the value's
// range (like every other gauge type) and the lamp switches at the midpoint —
// lit in the gauge colour above it, dim below. Min 0 / Max 1 switches at 0.5.
// invert flips the lamp (lit while the value is OFF/below the midpoint) —
// the caption still names the value's real state.
const IndicatorLamp = ({ value, min, max, color, enums, invert, px }) => {
  const v = (value == null || isNaN(value)) ? null : value;
  const lo = (min == null) ? 0 : min;
  const hi = (max == null) ? lo : max;
  const rawOn = v != null && v >= (lo + hi) / 2;
  const on = invert ? (v != null && !rawOn) : rawOn;
  const col = (color && /^#[0-9a-fA-F]{6}$/.test(color)) ? color : 'var(--accent)';
  const d = Math.round(px * 0.52);
  const label = v == null ? '—' : (enums ? enumLabel(enums, v) : (rawOn ? 'ON' : 'OFF'));
  return html`
    <div class="ind-wrap" style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:${Math.round(px * 0.06)}px">
      <div class="ind-lamp ${on ? 'on' : ''}" style=${{
        width: d + 'px', height: d + 'px', borderRadius: '50%',
        background: on ? col : 'var(--surface)',
        border: '2px solid ' + (on ? col : 'var(--border2)'),
        boxShadow: on ? ('0 0 ' + Math.round(px * 0.16) + 'px ' + col) : 'none',
        transition: 'background .15s, box-shadow .15s',
      }}></div>
      ${px >= 40 && html`<div class="g-unit" style=${'font-size:' + Math.max(0.7, px / 230 * 1.0).toFixed(2) + 'rem'}>${label}</div>`}
    </div>`;
};

// Plain text tile: the live value as large text (with unit / enum label),
// or fixed caption text when "Static text" is set — handy for labelling
// dashboard sections.
const TextTile = ({ value, unit, enums, text, decimals, w, h }) => {
  const isStatic = !!(text && String(text).trim());
  let disp;
  if (isStatic) disp = String(text).trim();
  else {
    const v = (value == null || isNaN(value)) ? null : value;
    disp = v == null ? '—' : (enums ? String(enumLabel(enums, v)) : v.toFixed(decimals));
  }
  // Fit by height, shrinking for long strings so they stay on the tile
  const fs = Math.max(11, Math.min(Math.round(h * 0.5), Math.round((w * 1.5) / Math.max(2, disp.length))));
  return html`
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;max-width:100%;overflow:hidden">
      <div class="g-val" style=${'font-size:' + fs + 'px;line-height:1.15;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%'}>${disp}</div>
      ${!isStatic && unit && html`<div class="g-unit" style=${'font-size:' + Math.max(10, Math.round(fs * 0.38)) + 'px'}>${unit}</div>`}
    </div>`;
};

// Fills the tile under the name label and measures itself with a
// ResizeObserver, so gauges rescale live while a tile is being resized
// (GridStack changes the DOM size continuously during the drag).
const GaugeTileBody = ({ g, title, value, unit, enums }) => {
  const ref = useRef(null);
  const [dim, setDim] = useState({ w: 0, h: 0 });
  // Layout effect: measure before first paint so a freshly mounted page
  // renders at full size in one frame instead of zooming in from nothing
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth, h = el.clientHeight;
      setDim(d => (d.w !== w || d.h !== h) ? { w, h } : d);
      // Tiny tiles (1x1 on a phone) hide the resize grip — it would cover
      // the whole tile and swallow the tap-to-configure gesture. Their size
      // is set from the settings modal instead.
      const item = el.closest('.grid-stack-item');
      if (item) {
        const r = item.getBoundingClientRect();
        item.classList.toggle('tile-tiny', Math.min(r.width, r.height) < 48);
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const { w, h } = dim;
  // Small tiles (1x1, or 2x2 on a phone) drop the name row so the gauge
  // itself always gets the space — the tile's title attribute still names it.
  // Unnamed tiles (static text captions) don't render the placeholder dash.
  const showName = h >= 48 && title !== '—';
  const nameH = showName ? Math.min(20, Math.round(h * 0.16)) : 0;
  const gh = h - nameH - 2;
  return html`
    <div ref=${ref} style="flex:1;width:100%;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:center;overflow:hidden">
      ${showName && html`<div class="gauge-tile-name" style=${'font-size:' + Math.min(13, Math.max(9, Math.round(nameH * 0.7))) + 'px;line-height:' + nameH + 'px;margin:0'}>${title}</div>`}
      ${w > 12 && gh > 12 && ((g.type === 'line')
        ? html`<${GaugeLine} key=${g.id} name=${g.name} min=${g.min} max=${g.max} value=${value} unit=${unit} color=${g.color || ''} enums=${enums}
            points=${g.points || 20} sampleMs=${g.sampleMs || 100} decimals=${g.decimals != null ? g.decimals : 1}
            w=${w - 4} h=${gh - 2} />`
        : (g.type === 'indicator')
        ? html`<${IndicatorLamp} value=${value} min=${g.min} max=${g.max} color=${g.color || ''} enums=${enums}
            invert=${!!g.invert} px=${Math.max(14, Math.min(w, gh) - 4)} />`
        : (g.type === 'text')
        ? html`<${TextTile} value=${value} unit=${unit} enums=${enums} text=${g.text || ''}
            decimals=${g.decimals != null ? g.decimals : 1} w=${w - 6} h=${gh - 4} />`
        : html`<${SvgGauge} id=${g.id} value=${value} unit=${unit} color=${g.color || ''} enums=${enums}
            px=${Math.max(40, Math.min(w, gh) - 4)} decimals=${g.decimals != null ? g.decimals : 1}
            min=${g.min != null ? g.min : 0} max=${(g.max == null || g.max === 0) ? 4000 : g.max} />`)}
    </div>`;
};

const Gauges = () => {
  const { state, dispatch } = useContext(Store);
  const [pages, setPages] = useState([{ id: 1, name: 'Main', items: [] }]);
  const [activePage, setActivePage] = useState(1);
  const [lineVals, setLineVals] = useState({});
  const [editing, setEditing] = useState(false);
  const [configId, setConfigId] = useState(null); // gauge whose settings modal is open
  const [autoPage, setAutoPage] = useState(true); // conditional page display armed
  const [loaded, setLoaded] = useState(false); // gauges.json fetch settled
  // Deep-link target, captured at first render — effects rewrite the hash
  // before the async layout fetch reads it
  const initialSubRef = useRef(parseHash().sub);
  const fetchRef = useRef(null);
  const nextId = useRef(1);
  const gridRef = useRef(null);  // .grid-stack DOM node
  const gridApi = useRef(null);  // GridStack instance
  const dragBusyRef = useRef(false); // true during (and briefly after) a drag/resize
  const lastHitRef = useRef(null); // page whose condition matched last tick
  const activeRef = useRef(activePage);
  activeRef.current = activePage;

  const page = pages.find(p => p.id === activePage) || pages[0];
  const items = page.items;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const editingRef = useRef(editing);
  editingRef.current = editing;

  // Keep the URL in step with the visible page (#gauges/<name>) so it can be
  // bookmarked; replaceState so flipping pages doesn't spam browser history.
  // Waits for the layout fetch so it can't clobber a deep link with the
  // placeholder page, and so it runs again once the real pages are in.
  useEffect(() => {
    if (!loaded) return;
    if (!/^#gauges(\/|$)/.test(location.hash)) return;
    history.replaceState(null, '', '#gauges/' + encodeURIComponent(page.name));
  }, [loaded, activePage, page.name]);
  useEffect(() => {
    const onHash = () => {
      const { tab, sub } = parseHash();
      if (tab !== 'gauges' || !sub) return;
      const want = sub.trim().toLowerCase();
      const p = pagesRef.current.find(x =>
        String(x.id) === want || String(x.name).trim().toLowerCase() === want);
      if (p && p.id !== activeRef.current) setActivePage(p.id);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Load saved layout (migrating v1 if needed) and fetch spot names for the picker
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/gauges.json');
        if (r.ok) {
          const data = await r.json();
          const migrated = migrateGauges(data);
          let maxId = 0;
          migrated.forEach(p => p.items.forEach(g => { if (typeof g.id === 'number' && g.id > maxId) maxId = g.id; }));
          migrated.forEach(p => p.items.forEach(g => { if (!g.id) g.id = ++maxId; }));
          nextId.current = maxId + 1;
          setPages(migrated);
          // Deep link: #gauges/<page name> (or page id) opens that page —
          // lets a browser favourite target e.g. the Driving layout directly
          const want = initialSubRef.current.trim().toLowerCase();
          const linked = want && migrated.find(p =>
            String(p.id) === want || String(p.name).trim().toLowerCase() === want);
          setActivePage((linked || migrated[0]).id);
          if (data && data.autoPage === false) setAutoPage(false);
        }
      } catch (e) { /* no saved layout */ }
      setLoaded(true);
      api.getJSON('json').then(json => dispatch({ type: 'SET_PARAMS', payload: json })).catch(() => {});
    })();
  }, []);

  const persist = async (nextPages, auto = autoPage) => {
    try {
      const blob = new Blob([JSON.stringify({ v: 3, autoPage: auto, pages: nextPages })], { type: 'application/json' });
      const fd = new FormData();
      fd.append('updatefile', blob, 'gauges.json');
      await fetch('/edit', { method: 'POST', body: fd });
    } catch (e) { /* ignore */ }
  };

  const setPageItems = (pageId, updater) =>
    setPages(ps => ps.map(p => p.id !== pageId ? p : { ...p, items: updater(p.items) }));

  // GridStack owns tile geometry while mounted; re-init on page switch,
  // edit toggle or add/remove, and mirror every 'change' back into state so
  // Save & Done persists exactly what's on screen.
  useLayoutEffect(() => {
    const el = gridRef.current;
    if (!el || typeof GridStack === 'undefined') return;
    // Layout effect + correct initial cellHeight + animation off during init:
    // a page switch paints fully laid out in one frame instead of zooming in.
    // Animation comes back for the nice drag/drop transitions.
    const grid = GridStack.init({
      column: GRID_COLS,
      cellHeight: Math.max(1, Math.round(el.clientWidth / GRID_COLS)),
      margin: 4,
      float: true,
      animate: false,
      staticGrid: !editing,
      alwaysShowResizeHandle: 'mobile',
    }, el);
    gridApi.current = grid;
    requestAnimationFrame(() => { if (gridApi.current === grid) grid.setAnimation(true); });
    const squareCells = () => {
      const w = el.clientWidth / GRID_COLS;
      if (w > 0) grid.cellHeight(Math.round(w));
    };
    const ro = new ResizeObserver(squareCells);
    ro.observe(el);
    // gridstack strips gs-min-* attributes on first parse, so re-inits would
    // lose them — enforce minimums at engine level instead (1x1 for
    // indicator lamps, 2x2 for everything else)
    const minFor = (id) => {
      const g = itemsRef.current.find(x => String(x.id) === String(id));
      return g ? tileFloor(g.type) : 2;
    };
    grid.batchUpdate();
    grid.getGridItems().forEach(el => {
      const m = minFor((el.gridstackNode || {}).id);
      grid.update(el, { minW: m, minH: m });
    });
    grid.batchUpdate(false);
    const onChange = () => {
      // save() omits default values (x/y 0, w/h 1) — normalise so state (and
      // the gs- attributes Preact renders) never go undefined or below min
      const layout = grid.save(false) || [];
      setPageItems(activeRef.current, prev => prev.map(g => {
        const l = layout.find(w => String(w.id) === String(g.id));
        if (!l) return g;
        const floor = tileFloor(g.type);
        return { ...g, x: l.x || 0, y: l.y || 0, w: Math.max(floor, l.w || 1), h: Math.max(floor, l.h || 1) };
      }));
    };
    grid.on('change', onChange);
    // Tap-vs-drag: a drag or resize still fires a click on mouseup, which
    // would pop the config modal right after every move — suppress it briefly
    grid.on('dragstart', () => { dragBusyRef.current = true; });
    grid.on('dragstop', () => { setTimeout(() => { dragBusyRef.current = false; }, 150); });
    // After a resize: enforce the 2x2 minimum (interactive resizes can slip
    // past engine minW) and keep dial-type gauges square — snap to the nearer
    // square, growing if the drag grew the tile, shrinking otherwise
    const prevDim = { w: 0, h: 0 };
    grid.on('resizestart', (e, el) => {
      dragBusyRef.current = true;
      const n = el.gridstackNode || {};
      prevDim.w = n.w || 0; prevDim.h = n.h || 0;
    });
    grid.on('resizestop', (e, el) => {
      setTimeout(() => { dragBusyRef.current = false; }, 150);
      const n = el.gridstackNode;
      if (!n) return;
      const g = itemsRef.current.find(x => String(x.id) === String(n.id));
      const floor = g ? tileFloor(g.type) : 2;
      let w = Math.max(floor, n.w || 1), h = Math.max(floor, n.h || 1);
      if (g && !tileFreeform(g.type)) {
        const grew = (n.w || 1) * (n.h || 1) >= prevDim.w * prevDim.h;
        w = h = grew ? Math.max(w, h) : Math.min(w, h);
      }
      if (n.w !== w || n.h !== h) grid.update(el, { w, h });
    });
    return () => { ro.disconnect(); grid.destroy(false); gridApi.current = null; };
    // types join: a type switch (e.g. radial -> indicator) changes the
    // engine minimums, so re-init to reapply them
  }, [activePage, items.length, editing, pages.length, items.map(g => g.type).join()]);

  const addGauge = () => {
    const id = nextId.current++;
    setPageItems(activePage, prev => {
      // Append below current content (float:true keeps y values literal)
      const y = prev.reduce((m, g) => Math.max(m, (g.y || 0) + (g.h || 3)), 0);
      return [...prev, { id, name: '', min: 0, max: 4000, type: 'radial', x: 0, y, w: 3, h: 3 }];
    });
    setConfigId(id); // open its settings straight away
  };

  const removeGauge = (id) => {
    if (configId === id) setConfigId(null);
    setPageItems(activePage, prev => prev.filter(g => g.id !== id));
  };

  // Resize a tile from its settings modal — the only way to grow/shrink
  // tiny tiles on a phone, where the corner grip is hidden. The rendered
  // size is driven by gridstack's inline style, so the ENGINE update is what
  // actually resizes the tile; its 'change' event then syncs state. The
  // element is found via gridstack's own node list (it strips gs-* attrs
  // after parsing, so a DOM attribute query is unreliable).
  const setGaugeSize = (id, wIn, hIn) => {
    const g = items.find(x => x.id === id);
    if (!g) return;
    const floor = tileFloor(g.type);
    let w = Math.max(floor, Math.min(GRID_COLS, Math.round(wIn) || floor));
    let h = Math.max(floor, Math.min(GRID_COLS, Math.round(hIn) || floor));
    if (!tileFreeform(g.type)) h = w;
    const engine = gridApi.current;
    const node = engine && engine.engine && engine.engine.nodes.find(n => String(n.id) === String(id));
    if (node && node.el) {
      engine.update(node.el, { w, h }); // fires 'change' -> onChange persists
    } else {
      // No live grid (shouldn't happen in edit mode) — persist directly
      setPageItems(activePage, prev => prev.map(x => x.id !== id ? x : { ...x, w, h }));
    }
  };

  // Copy a gauge's full config (value, type, colour, range, size) into a new
  // tile appended below the current content
  const duplicateGauge = (id) => {
    setPageItems(activePage, prev => {
      const src = prev.find(g => g.id === id);
      if (!src) return prev;
      const y = prev.reduce((m, g) => Math.max(m, (g.y || 0) + (g.h || 3)), 0);
      return [...prev, { ...src, id: nextId.current++, x: 0, y }];
    });
  };

  const updateGaugeConfig = (id, field, value) =>
    setPageItems(activePage, prev => prev.map(g => g.id !== id ? g : { ...g, [field]: value }));

  // --- pages ---
  const addPage = () => {
    const name = (prompt('Page name (e.g. Driving, Debug)') || '').trim();
    if (!name) return;
    const id = Math.max(0, ...pages.map(p => p.id)) + 1;
    setPages([...pages, { id, name, items: [] }]);
    setActivePage(id);
  };
  const renamePage = () => {
    const name = (prompt('Rename page', page.name) || '').trim();
    if (!name) return;
    setPages(pages.map(p => p.id !== activePage ? p : { ...p, name }));
  };
  const deletePage = () => {
    if (pages.length <= 1) { alert('At least one page is required.'); return; }
    if (!confirm('Delete page "' + page.name + '" and its ' + items.length + ' gauge(s)?')) return;
    const next = pages.filter(p => p.id !== activePage);
    setPages(next);
    setActivePage(next[0].id);
  };
  // Conditional page display config: each page may carry one condition
  // Defaults apply only on creation — a cleared Min/Max must STAY blank
  // (blank = open-ended), not snap back to a default
  const updatePageCond = (field, value) =>
    setPages(ps => ps.map(p => p.id !== activePage ? p : {
      ...p, cond: { ...(p.cond || { name: '', min: 1, max: 1 }), [field]: value },
    }));
  const clearPageCond = () =>
    setPages(ps => ps.map(p => p.id !== activePage ? p : { ...p, cond: undefined }));

  // High-rate spot value fetching for the active page (pauses main json refresh)
  useEffect(() => {
    // Pause streaming while the settings modal is open: its constant
    // re-renders otherwise revert an in-progress edit of a controlled input
    // (type a value, a stream tick lands, the field snaps back).
    // Page-condition values ride along in the same fetch (deduplicated) so
    // conditional page display sees them even from a page with no gauges.
    const condNames = (autoPage && !configId)
      ? pages.map(p => p.cond && p.cond.name).filter(Boolean) : [];
    const names = configId ? []
      : [...new Set([...items.map(g => g.name).filter(Boolean), ...condNames])];
    if (names.length === 0) {
      dispatch({ type: 'SET_LOGGING', payload: false });
      return;
    }
    dispatch({ type: 'SET_LOGGING', payload: true });
    let active = true;
    const interval = 100; // ms between fetches
    const fetchLoop = async () => {
      if (!active) return;
      const t0 = performance.now();
      try {
        const text = await api.getText('get ' + names.join(','));
        if (!active) return;
        const vals = text.match(/[\-\d\.]+/g) || [];
        // Positional mapping is only safe when counts line up — an error reply
        // (e.g. one bad name) would shift every gauge onto its neighbour's value
        if (vals.length !== names.length) return;
        const byName = {};
        names.forEach((n, i) => { byName[n] = parseFloat(vals[i]); });
        const next = {};
        items.forEach(g => {
          if (g.name && !isNaN(byName[g.name])) next[g.id] = byName[g.name];
        });
        setLineVals(prev => ({ ...prev, ...next }));
        // Conditional page display: when a page's condition STARTS matching,
        // switch to it. A persisting match doesn't re-trigger, so the user can
        // still browse away; when nothing matches the current page stays.
        if (autoPage && !editingRef.current) {
          const hit = pagesRef.current.find(p => p.cond && p.cond.name && condMatch(p.cond, byName[p.cond.name]));
          const hitId = hit ? hit.id : null;
          if (hitId !== lastHitRef.current) {
            lastHitRef.current = hitId;
            if (hitId != null && hitId !== activeRef.current) setActivePage(hitId);
          }
        }
      } catch (e) { /* ignore */ }
      if (active) {
        const elapsed = performance.now() - t0;
        fetchRef.current = setTimeout(fetchLoop, Math.max(0, interval - elapsed));
      }
    };
    fetchRef.current = setTimeout(fetchLoop, 0);
    return () => {
      active = false;
      dispatch({ type: 'SET_LOGGING', payload: false });
      if (fetchRef.current) { clearTimeout(fetchRef.current); fetchRef.current = null; }
    };
  }, [items, configId, autoPage, pages.map(p => (p.cond && p.cond.name) || '').join()]);

  const spotNames = state.spotValues ? Object.keys(state.spotValues) : [];

  return html`
    <div id="gauges" class="tabdiv main-content ${editing ? 'gauges-editing' : ''}" style="display:flex">
      ${editing && html`
      <div class="main-right">
        <h3 class="underline">Edit Gauges</h3>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:4px">
          <button onclick=${addGauge}><${Icon} n="plus" />Add Gauge</button>
          <button onclick=${() => { persist(pages); setEditing(false); }}><${Icon} n="check" />Save & Done</button>
        </div>
        <p style="font-size:.72rem;color:var(--text3);margin:.25rem 0 .5rem">Drag tiles to move them; drag a tile's corner to resize.</p>
        <h3 class="underline">Page: ${page.name}</h3>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px">
          <button onclick=${addPage} style="font-size:.75rem;padding:4px 10px"><${Icon} n="plus" />New page</button>
          <button onclick=${renamePage} style="font-size:.75rem;padding:4px 10px"><${Icon} n="edit" />Rename</button>
          <button onclick=${deletePage} style="font-size:.75rem;padding:4px 10px;color:var(--red)"><${Icon} n="x" />Delete</button>
        </div>
        <h3 class="underline">Page condition</h3>
        ${page.cond ? html`
          <div id="page-cond" style="display:flex;flex-direction:column;gap:6px;font-size:.8rem">
            <div style="display:flex;gap:8px;align-items:center">
              <label style="width:3.5em">Value</label>
              <${FieldPicker} value=${page.cond.name || ''} spotNames=${spotNames} onChange=${n => updatePageCond('name', n)} />
            </div>
            <div style="display:flex;gap:8px;align-items:center">
              <label style="width:3.5em">Min</label>
              <input type="number" value=${page.cond.min != null ? page.cond.min : ''} step="any" placeholder="any" style="width:5em;padding:4px 6px"
                oninput=${e => { const n = parseFloat(e.target.value); updatePageCond('min', isNaN(n) ? undefined : n); }} />
              <label>Max</label>
              <input type="number" value=${page.cond.max != null ? page.cond.max : ''} step="any" placeholder="any" style="width:5em;padding:4px 6px"
                oninput=${e => { const n = parseFloat(e.target.value); updatePageCond('max', isNaN(n) ? undefined : n); }} />
            </div>
            <label style="display:flex;gap:8px;align-items:center;cursor:pointer">
              <span style="width:3.5em">Invert</span>
              <input type="checkbox" checked=${!!page.cond.invert} onchange=${e => updatePageCond('invert', e.target.checked)} style="width:auto" />
              <span style="font-size:.72rem;color:var(--text3)">show while OUTSIDE the range</span>
            </label>
            <button onclick=${clearPageCond} style="font-size:.72rem;padding:3px 10px;width:auto;align-self:flex-start;color:var(--red)"><${Icon} n="x" size=${11} />Remove condition</button>
            <p style="font-size:.72rem;color:var(--text3);margin:0">Shows this page while the value is between Min and Max (inclusive). Equal-to is Min = Max — e.g. opmode 3 to 3. Leave Min or Max blank for no lower/upper limit. The Auto toggle above the grid arms it.</p>
          </div>
        ` : html`
          <button onclick=${() => updatePageCond('name', '')} style="font-size:.75rem;padding:4px 10px;width:auto"><${Icon} n="plus" />Add condition</button>
          <p style="font-size:.72rem;color:var(--text3);margin:.25rem 0 0">A condition switches to this page automatically while a value is in range — e.g. opmode 3 to 3, or lasterr 0 to 0 inverted (any error).</p>
        `}
        <p style="font-size:.72rem;color:var(--text3);margin:.25rem 0 0">Tap a tile to configure its value, type, colour and range — or to duplicate or remove it.</p>
      </div>
      `}
      <div class="main-left">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.5rem;gap:8px;flex-wrap:wrap">
          <h2 style="margin:0">Gauges</h2>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            ${pages.some(p => p.cond && p.cond.name) && html`
              <label class="toggle-row" id="auto-pages" style="width:auto;padding:4px 10px;font-size:.72rem" title="Conditional page display: switch pages automatically when a page condition matches">
                <span class="toggle-label">Auto pages</span>
                <span class="switch sm">
                  <input type="checkbox" checked=${autoPage} onchange=${e => {
                    const v = e.target.checked;
                    setAutoPage(v);
                    lastHitRef.current = null; // re-arm: a live match fires immediately
                    persist(pages, v);
                  }} />
                  <span class="slider"></span>
                </span>
              </label>`}
            ${!editing && html`<button onclick=${() => setEditing(true)} style="font-size:.75rem;padding:4px 12px"><${Icon} n="edit" />Edit Layout</button>`}
          </div>
        </div>
        <div id="gauge-pages" style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:.6rem">
          ${pages.map(p => html`
            <button key=${p.id} class="page-pill ${p.id === activePage ? 'active' : ''}" onclick=${() => setActivePage(p.id)}>${p.name}</button>
          `)}
          ${editing && html`<button class="page-pill" title="Add page" onclick=${addPage}>+</button>`}
        </div>
        ${items.length === 0 && !editing && html`<p style="color:var(--text3);font-size:.85rem;text-align:center;padding:2rem 0">Click Edit Layout to add a gauge.</p>`}
        <div class="grid-stack" ref=${gridRef} key=${'page-' + activePage}>
          ${items.map(g => {
            const sv = state.spotValues && state.spotValues[g.name];
            const unit = (sv && sv.unit && sv.unit.indexOf('=') === -1) ? sv.unit : '';
            const enums = (sv && sv.enums) || null;
            return html`
            <div class="grid-stack-item" key=${g.id} gs-id=${g.id} gs-x=${g.x} gs-y=${g.y} gs-w=${g.w} gs-h=${g.h}>
              ${/* In edit mode a tap opens the tile's settings (no overlay
                  buttons — on a 1x1 mobile tile they'd all overlap the
                  resize handle); drags are filtered by dragBusyRef */ ''}
              <div class="grid-stack-item-content gauge-tile" title=${g.label || g.name || ''}
                onclick=${editing ? (() => { if (!dragBusyRef.current) setConfigId(g.id); }) : undefined}>
                ${/* 'tap to set up' only for truly unconfigured tiles — a
                    static-text tile is fully configured without a value or
                    label (its body IS the text, no name row needed) */ ''}
                <${GaugeTileBody} g=${g} title=${g.label || g.name || (editing && !(g.type === 'text' && g.text && String(g.text).trim()) ? 'tap to set up' : '—')} value=${lineVals[g.id]} unit=${unit} enums=${enums} />
              </div>
            </div>`;
          })}
        </div>
      </div>
      ${(() => {
        const cfg = items.find(g => g.id === configId);
        return cfg && html`
          <${Modal} id="gauge-config" title="Gauge settings" onClose=${() => setConfigId(null)}>
            <div style="display:flex;flex-direction:column;gap:10px;font-size:.85rem">
              <div style="display:flex;gap:8px;align-items:center">
                <label style="width:4.5em">Value</label>
                <${FieldPicker} value=${cfg.name} spotNames=${spotNames} onChange=${name => updateGaugeConfig(cfg.id, 'name', name)} />
              </div>
              <div style="display:flex;gap:8px;align-items:center">
                <label style="width:4.5em">Label</label>
                <input type="text" value=${cfg.label || ''} placeholder="(shows the value name)" maxlength="24"
                  oninput=${e => updateGaugeConfig(cfg.id, 'label', e.target.value)} style="flex:1;padding:5px 8px" />
              </div>
              <div style="display:flex;gap:8px;align-items:center">
                <label style="width:4.5em">Type</label>
                <select value=${cfg.type || 'radial'} onchange=${e => {
                  const t = e.target.value;
                  updateGaugeConfig(cfg.id, 'type', t);
                  // 0/1 flags are the common indicator case — default to a 0..1 range (switches at 0.5)
                  if (t === 'indicator' && cfg.min === 0 && cfg.max === 4000) {
                    updateGaugeConfig(cfg.id, 'max', 1);
                  }
                }} style="width:auto;min-width:9.5em;padding:5px 30px 5px 8px">
                  <option value="radial">Radial</option>
                  <option value="line">Line</option>
                  <option value="indicator">Indicator</option>
                  <option value="text">Text</option>
                </select>
                <label style="margin-left:8px">Colour</label>
                <input type="color" value=${cfg.color || '#4cc9f0'} oninput=${e => updateGaugeConfig(cfg.id, 'color', e.target.value)}
                  style="width:34px;height:28px;padding:0;border:1px solid var(--border2);border-radius:6px;background:none;cursor:pointer" />
                ${cfg.color && html`<button onclick=${() => updateGaugeConfig(cfg.id, 'color', '')} style="font-size:.65rem;padding:2px 8px;width:auto" title="Reset to theme gradient"><${Icon} n="undo" size=${11} /></button>`}
              </div>
              ${cfg.type !== 'text' && html`<div style="display:flex;gap:8px;align-items:center">
                <label style="width:4.5em">Min</label>
                <input type="number" value=${cfg.min} oninput=${e => updateGaugeConfig(cfg.id, 'min', parseFloat(e.target.value) || 0)} style="width:6em;padding:5px 6px" step="any" />
                <label>Max</label>
                <input type="number" value=${cfg.max} oninput=${e => updateGaugeConfig(cfg.id, 'max', parseFloat(e.target.value) || 0)} style="width:6em;padding:5px 6px" step="any" />
              </div>`}
              ${cfg.type === 'text' && html`
                <div style="display:flex;gap:8px;align-items:center">
                  <label style="width:4.5em">Text</label>
                  <input type="text" value=${cfg.text || ''} placeholder="(empty = show the live value)" maxlength="40"
                    oninput=${e => updateGaugeConfig(cfg.id, 'text', e.target.value)} style="flex:1;padding:5px 8px" />
                </div>
                <p style="font-size:.72rem;color:var(--text3);margin:0">Leave Text empty to show the selected value as large text; set it for a static caption (section headers etc.).</p>
              `}
              ${cfg.type !== 'indicator' && html`<div style="display:flex;gap:8px;align-items:center">
                <label style="width:4.5em">Decimals</label>
                <select value=${String(cfg.decimals != null ? cfg.decimals : 1)} onchange=${e => updateGaugeConfig(cfg.id, 'decimals', parseInt(e.target.value))}
                  style="width:auto;min-width:5em;padding:5px 30px 5px 8px">
                  <option value="0">0</option>
                  <option value="1">1</option>
                  <option value="2">2</option>
                  <option value="3">3</option>
                </select>
              </div>`}
              ${cfg.type === 'indicator' && html`
                <label style="display:flex;gap:8px;align-items:center;cursor:pointer">
                  <span style="width:4.5em">Invert</span>
                  <input type="checkbox" checked=${!!cfg.invert} onchange=${e => updateGaugeConfig(cfg.id, 'invert', e.target.checked)} style="width:auto" />
                  <span style="font-size:.72rem;color:var(--text3)">lamp lit while the value is OFF</span>
                </label>
                <p style="font-size:.72rem;color:var(--text3);margin:0">The lamp lights in the chosen colour when the value rises past the midpoint between Min and Max — e.g. Min 0 / Max 1 switches at 0.5.</p>`}
              <div style="display:flex;gap:8px;align-items:center">
                <label style="width:4.5em">Size</label>
                ${tileFreeform(cfg.type) ? html`
                  <input type="number" min=${tileFloor(cfg.type)} max=${GRID_COLS} value=${cfg.w} title="Width (cells)"
                    onchange=${e => setGaugeSize(cfg.id, parseInt(e.target.value), cfg.h)} style="width:5em;padding:5px 6px" />
                  <label>×</label>
                  <input type="number" min=${tileFloor(cfg.type)} max=${GRID_COLS} value=${cfg.h} title="Height (cells)"
                    onchange=${e => setGaugeSize(cfg.id, cfg.w, parseInt(e.target.value))} style="width:5em;padding:5px 6px" />
                ` : html`
                  <input type="number" min=${tileFloor(cfg.type)} max=${GRID_COLS} value=${cfg.w} title="Size (cells, square)"
                    onchange=${e => setGaugeSize(cfg.id, parseInt(e.target.value), parseInt(e.target.value))} style="width:5em;padding:5px 6px" />
                  <span style="font-size:.72rem;color:var(--text3)">cells (of ${GRID_COLS})</span>
                `}
              </div>
              ${cfg.type === 'line' && html`
                <div style="display:flex;gap:8px;align-items:center">
                  <label style="width:4.5em">Points</label>
                  <input type="number" min="5" max="500" value=${cfg.points || 20}
                    oninput=${e => updateGaugeConfig(cfg.id, 'points', Math.max(5, Math.min(500, parseInt(e.target.value) || 20)))}
                    style="width:6em;padding:5px 6px" />
                  <label>Sample</label>
                  <select value=${String(cfg.sampleMs || 100)} onchange=${e => updateGaugeConfig(cfg.id, 'sampleMs', parseInt(e.target.value))}
                    style="width:auto;min-width:7em;padding:5px 30px 5px 8px">
                    <option value="100">100 ms</option>
                    <option value="250">250 ms</option>
                    <option value="500">500 ms</option>
                    <option value="1000">1 s</option>
                    <option value="2000">2 s</option>
                    <option value="5000">5 s</option>
                  </select>
                </div>
                <p style="font-size:.72rem;color:var(--text3);margin:0">Time window ≈ Points × Sample — e.g. 60 points at 1 s shows the last minute. Faster sampling scrolls faster.</p>
              `}
              <div style="display:flex;gap:8px;margin-top:4px;flex-wrap:wrap">
                <button onclick=${() => setConfigId(null)} style="width:auto"><${Icon} n="check" />Done</button>
                <button onclick=${() => { duplicateGauge(cfg.id); setConfigId(null); }} style="width:auto">⧉ Duplicate</button>
                <button onclick=${() => removeGauge(cfg.id)} style="width:auto;color:var(--red)"><${Icon} n="x" />Remove</button>
              </div>
            </div>
          </${Modal}>`;
      })()}
    </div>
  `;
};

// ==================== App ====================

const App = () => {
  const [state, dispatch] = useReducer(reducer, initialState);
  const store = useMemo(() => ({ state, dispatch }), [state]);
  // The poll effect below only re-runs on rate/logging changes, so it must
  // read the current tab through a ref — a closure would go stale and keep
  // fetching (or stop fetching) 'errors' for whichever tab was active when
  // the effect last ran
  const activeTabRef = useRef(state.activeTab);
  activeTabRef.current = state.activeTab;

  // URL breadcrumbs: reflect the active tab into the hash (so the current
  // view can be bookmarked) and follow hash changes (back/forward buttons,
  // or opening a bookmark while the app is already loaded)
  useEffect(() => {
    const onHash = () => {
      const { tab } = parseHash();
      if (tab && tab !== activeTabRef.current) dispatch({ type: 'SET_ACTIVE_TAB', payload: tab });
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    const cur = parseHash();
    if (cur.tab !== state.activeTab) {
      // Tab switches make history entries (back button walks tabs); the very
      // first paint just normalises the empty hash without adding one
      if (cur.tab) location.hash = '#' + state.activeTab;
      else history.replaceState(null, '', '#' + state.activeTab);
    }
  }, [state.activeTab]);

  // Load CAN settings on mount
  useEffect(() => {
    fetch('/version').then(r => r.text()).then(v => dispatch({ type: 'SET_WEB_VERSION', payload: v.trim() })).catch(() => {});
    fetch('/settings').then(r => r.json()).then(data => {
      const mode = data.can_mode === true;
      const nodeId = data.can_node_id || 1;
      dispatch({ type: 'SET_CAN_CONFIG', payload: { canMode: mode, canNodeId: nodeId } });
      if (mode) dispatch({ type: 'SET_CAN_NODE', payload: nodeId });
      if (data.can_nodes) dispatch({ type: 'SET_CAN_NODES', payload: data.can_nodes });
    }).catch(() => {});
  }, []);

  // Once-a-day new-release check (disableable on the Update tab). Silent on
  // every failure; a per-version dismiss suppresses the badge until the next
  // release comes out.
  useEffect(() => {
    if (!getUpdateCheckAuto()) return;
    checkLatestRelease(false).then(tag => {
      let dismissed = null;
      try { dismissed = localStorage.getItem('updateDismissedTag'); } catch (e) {}
      if (tag && tag !== dismissed) dispatch({ type: 'SET_UPDATE_TAG', payload: tag });
    }).catch(() => {});
  }, []);

  // Unified data fetching — respects refreshRate setting
  useEffect(() => {
    let running = true;
    const rate = state.refreshRate; // -1 = off, 0 = max speed (continuous), else ms interval

    // Returns true if it actually polled, false if paused (hidden / off /
    // favourites streaming holds `logging`). Callers must yield when it's
    // false so the loop never busy-spins.
    const fetchOnce = async () => {
      if (document.hidden || state.refreshRate === -1 || state.logging) return false;
      dispatch({ type: 'SET_FETCHING' });
      try {
        const json = await api.getJSON('json');
        if (!running) return true;
        dispatch({ type: 'SET_PARAMS', payload: json });
        if (activeTabRef.current === 'dashboard') {
          api.getText('errors').then(r => dispatch({ type: 'SET_MESSAGES', payload: r })).catch(() => {});
        }
      } catch (e) {
        if (running) dispatch({ type: 'FETCH_ERROR' });
      }
      return true;
    };

    // FPS counter
    let tickTimes = [];
    const updateFPS = () => {
      const now = performance.now();
      tickTimes.push(now);
      tickTimes = tickTimes.filter(t => now - t < 1000);
      dispatch({ type: 'SET_FPS', payload: tickTimes.length });
    };

    if (rate === -1) {
      // Refresh off — no polling loop
      return () => { running = false; };
    } else if (rate === 0) {
      (async function loop() {
        while (running) {
          const polled = await fetchOnce();
          if (polled) updateFPS();
          // Paused (tab hidden, or favourites streaming holds `logging`): yield a
          // macrotask instead of busy-spinning, which would starve setTimeout
          // callbacks like the favourites fetch loop.
          else await new Promise(r => setTimeout(r, 250));
        }
      })();
    } else {
      fetchOnce();
      let timer;
      (async function loop() {
        while (running) {
          await fetchOnce();
          updateFPS();
          if (!running) break;
          await new Promise(r => { timer = setTimeout(r, rate); });
        }
      })();
      return () => { running = false; if (timer) clearTimeout(timer); };
    }
    return () => { running = false; };
  }, [state.refreshRate, state.logging]);

  // Age ticker
  useEffect(() => {
    const tick = setInterval(() => dispatch({ type: 'TICK_AGE' }), 1000);
    return () => clearInterval(tick);
  }, []);

  // Load WiFi tab, file list, and favorites
  useEffect(() => {
    api.getFileList().then(list => dispatch({ type: 'SET_FILE_LIST', payload: list }));
    api.loadFavorites().then(favs => dispatch({ type: 'SET_FAVORITES', payload: favs }));
  }, []);

  const tab = state.activeTab;

  return html`
    <${Store.Provider} value=${store}>
      <div id="content">
        <${Navbar} />
        <div id="content-wrapper">
          <div id="content-wrapper-inner" data-panel="open">
            <div id="communication-error-bar" class="communication-error-bar" style=${{ display: state.commError ? 'block' : 'none' }}>
              <p>Communication problem between ESP and STM</p>
            </div>
            ${tab === 'dashboard' && html`<${Dashboard} />`}
            ${tab === 'update' && html`<${Update} />`}
            ${tab === 'parameters' && html`<${Parameters} />`}
            ${tab === 'spotvalues' && html`<${SpotValues} />`}
            ${tab === 'plot' && html`<${Plot} />`}
            ${tab === 'gauges' && html`<${Gauges} />`}
            ${tab === 'logger' && html`<${Logger} />`}
            ${tab === 'canmapping' && html`<${CanMapping} />`}
            ${tab === 'files' && html`<${Files} />`}
            ${tab === 'settings' && html`<${Settings} />`}
            ${tab === 'support' && html`<${Support} />`}
          </div>
        </div>
      </div>
    </${Store.Provider}>
  `;
};

// ==================== Mount ====================
render(html`<${App} />`, document.body);
