// app.js — Preact + HTM OpenInverter Web Interface
// Replaces: ui.js, inverter.js, plot.js, log.js, wifi.js, modal.js, index.js, docstrings.js

const { h, render, createContext } = preact;
const { useState, useEffect, useReducer, useContext, useRef, useCallback, useMemo } = preactHooks;
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

  async getSpotValues(names) {
    if (!names || names.length === 0) return {};
    const cmd = 'get ' + names.join(',');
    const text = await this.getText(cmd);
    // Parse float values using exact regex from original codebase
    const re = /(\-{0,1}[0-9]+\.[0-9]*)/g;
    const vals = [];
    let m;
    while ((m = re.exec(text)) !== null) vals.push(parseFloat(m[1]));
    const result = {};
    names.forEach((name, i) => { result[name] = vals[i] !== undefined ? vals[i] : 0; });
    return result;
  },

  async getText(cmd, repeat) {
    let url = '/cmd?cmd=' + encodeURIComponent(cmd);
    if (repeat) url += '&repeat=' + repeat;
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.text();
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
    while (true) {
      await new Promise(res => setTimeout(res, 400));
      let st;
      try {
        const r = await fetch('/fwupdate-status');
        if (!r.ok) continue;
        st = await r.json();
      } catch (e) { continue; }
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

  async saveFavorites(paramFavs, spotFavs) {
    try {
      const json = JSON.stringify({ p: paramFavs || [], s: spotFavs || [] });
      const blob = new Blob([json], { type: 'application/json' });
      const fd = new FormData();
      fd.append('updatefile', blob, 'favorites.json');
      await fetch('/edit', { method: 'POST', body: fd });
    } catch(e) { console.log('Save favorites failed', e); }
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

const initialState = {
  params: null,
  spotValues: null,
  messages: '',
  status: null, opmode: null, lasterr: null, udc: null, tmphs: null,
  firmwareVersion: '',
  fetchAge: 0,
  activeTab: 'dashboard',
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
  canMode: false,
  canNodeId: 1,
  canNodes: [],
  canActiveNodeId: 1,
  canConnected: false,
  history: {}, // recent numeric samples for dashboard sparklines
};

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
      const hist = { ...state.history };
      for (const k of ['udc', 'tmphs']) {
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
    case 'SET_MESSAGES':
      return { ...state, messages: action.payload };
    case 'FETCH_ERROR':
      const fc = state.failedFetchCount + 1;
      return { ...state, failedFetchCount: fc, commError: fc >= 2, fetching: false,
               canConnected: state.canMode ? (fc < 2 && state.canConnected) : false };
    case 'SET_ACTIVE_TAB':
      return { ...state, activeTab: action.payload };
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
  expand: '<polyline points="7 6 12 11 17 6"/><polyline points="7 13 12 18 17 13"/>',
  collapse: '<polyline points="17 11 12 6 7 11"/><polyline points="17 18 12 13 7 18"/>',
  life: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/><line x1="4.93" y1="4.93" x2="9.17" y2="9.17"/><line x1="14.83" y1="14.83" x2="19.07" y2="19.07"/><line x1="14.83" y1="9.17" x2="19.07" y2="4.93"/><line x1="4.93" y1="19.07" x2="9.17" y2="14.83"/>',
};
const Icon = ({ n, size = 13 }) => html`<span class="btn-ic" dangerouslySetInnerHTML=${{
  __html: '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + (ICONS[n] || '') + '</svg>'
}}></span>`;

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
        ${state.firmwareVersion && html`F/W: ${state.firmwareVersion}<br/>`}Web: v4.0
      </div>
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
        ${state.logging
          ? html`<span style="flex:1;text-align:center"><span class="fast-badge">⚡ FAST</span></span>`
          : html`<span style="flex:1;text-align:center">${state.fetchAge}s ago</span>`}
      </div>
      ${state.refreshRate === -1 && !state.logging && html`
        <div style="text-align:center;padding:4px 0 0">
          <button onclick=${() => { dispatch({ type: 'SET_FETCHING' }); api.getJSON('json').then(json => dispatch({ type: 'SET_PARAMS', payload: json })).catch(() => {}); }} style="font-size:.7rem;padding:4px 12px"><${Icon} n="refresh" />Refresh now</button>
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
    if (!cmd.trim()) return;
    const reply = await api.getText(cmd);
    setCmdOutput(o => o + reply + '\n');
    setCmd('');
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
                  <div class="metric">
                    <span class="metric-label">Battery voltage</span>
                    <span class="metric-value">${fmtNum(state.udc)}<span class="metric-unit">V</span></span>
                    <${Sparkline} data=${state.history.udc} />
                  </div>
                  <div class="metric tone-active">
                    <span class="metric-label">Inverter temp</span>
                    <span class="metric-value">${fmtNum(state.tmphs)}<span class="metric-unit">°C</span></span>
                    <${Sparkline} data=${state.history.tmphs} />
                  </div>
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
    await api.getText('set ' + name + ' ' + value);
    dispatch({ type: 'SET_PARAM_VALUE', name, value });
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
      // Apply parameters
      for (const name in params) {
        if (params[name] && params[name].value !== undefined) {
          await api.getText('set ' + name + ' ' + params[name].value);
        }
      }
      alert('Subscribed and parameters applied!');
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

  return html`
    <div id="parameters" class="tabdiv main-content" style="display:flex">
      <div class="main-right">
        <h3 class="underline">Filter</h3>
        <input type="text" placeholder="Search parameters..." value=${search}
          oninput=${e => setSearch(e.target.value)} style="width:100%;margin-bottom:.25rem" />
        <div style="display:flex;gap:6px;width:100%">
          <button onclick=${() => dispatch({ type: 'SET_ALL_CATEGORIES', payload: true })} style="flex:1 1 0;width:auto;min-width:0;justify-content:center"><${Icon} n="expand" />Expand</button>
          <button onclick=${() => dispatch({ type: 'SET_ALL_CATEGORIES', payload: false })} style="flex:1 1 0;width:auto;min-width:0;justify-content:center"><${Icon} n="collapse" />Collapse</button>
        </div>
        <h3 class="underline">Save & Load</h3>
        <button onclick=${() => api.getText('save').then(r => alert(r || 'Parameters saved'))}><${Icon} n="save" />Save parameters to flash</button>
        <button onclick=${() => api.getText('load')}><${Icon} n="undo" />Restore parameters from flash</button>
        <a download="params.json" href=${'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(state.params, null, 2))}><button><${Icon} n="download" />Download parameters file</button></a>
        <form id="paramform" enctype="multipart/form-data" action="edit" method="POST" onsubmit=${async e => { e.preventDefault(); await api.uploadFile(new FormData(e.target)); }}>
          <input id="paramfile" name="paramfile" type="file" hidden onchange=${e => e.target.form.requestSubmit()} />
          <label class="butt" for="paramfile"><${Icon} n="upload" />Load parameters from file</label>
        </form>
        <h3 class="underline">Parameter Database</h3>
        <button onclick=${submitToDatabase}><${Icon} n="cloud" />Submit parameters</button>
        <button onclick=${() => setShowSubscribe(true)}><${Icon} n="rss" />Subscribe to parameter set</button>
        <button onclick=${stopSubscription}><${Icon} n="x" />Stop subscription</button>
        <h3 class="underline">Misc</h3>
        ${hasFavs && html`<${ToggleRow} label="★ Favorites only" checked=${showFavs}
          onChange=${() => dispatch({ type: 'TOGGLE_FAVORITES_ONLY' })} />`}
        <a href="/syncofs.html" target="_blank"><button><${Icon} n="external" />Launch syncofs tuner</button></a>
        <a href="https://openinverter.org/wiki/Parameters" target="_blank"><button><${Icon} n="book" />Parameter reference</button></a>
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
                  <td><div class="tooltip">${p.name}<span class="tooltiptext">${docstrings.get(p.name) || ''}</span></div></td>
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
    // 'get' loop — always show their static value
    if (showFavs && fastVals[v.name] !== undefined && v.id !== undefined) {
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

  return html`
    <div id="spotvalues" class="tabdiv main-content" style="display:flex">
      <div class="main-right">
        <h3 class="underline">Filter</h3>
        <input type="text" placeholder="Search spot values..." value=${search}
          oninput=${e => setSearch(e.target.value)}
          style="width:100%;margin-bottom:.25rem" />
        <p style="font-size:.75rem;color:var(--text3);margin-bottom:.25rem">${filtered.length} of ${all.length} items</p>
        <h3 class="underline" style="margin-top:1rem">View</h3>
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
        <div id="spotValuesWrap" ref=${wrapRef} class="fullheight ${multiCol ? 'multi-col' : ''}" style="overflow-y:auto">
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
                </td><td class="sv-name">${v.name}</td><td class="sv-val">${getDisplay(v)}</td>${sparks && html`<td class="sv-spark">${!v.enums && html`<${Sparkline} data=${histRef.current[v.name]} width=${64} height=${16} />`}</td>`}<td class="sv-unit">${v.unit && v.unit.indexOf('=') === -1 ? v.unit : ''}</td></tr>
            `)}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  `;
};

// ==================== Update ====================

const Update = () => {
  const { state, dispatch } = useContext(Store);
  const [updating, setUpdating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [updateMsg, setUpdateMsg] = useState('');
  const [releases, setReleases] = useState([]);
  const [otaMsg, setOtaMsg] = useState('');
  const fileRef = useRef(null);
  const webFileRef = useRef(null);

  const installFirmware = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    if (!file.name.endsWith('.bin')) { alert('Use .bin file'); return; }
    setUpdating(true); setProgress(0); setUpdateMsg('Uploading...');
    // Pause json polling — its UART/CAN traffic would corrupt the bootloader transfer
    dispatch({ type: 'SET_LOGGING', payload: true });
    const fd = new FormData();
    fd.append('update-firmware-file', file);
    await api.uploadFile(fd);
    if (fileRef.current) fileRef.current.value = ''; // allow re-selecting the same file
    setUpdateMsg('Installing firmware...');

    if (state.canMode) {
      // One continuous background transfer on the ESP, polled for progress
      try {
        await api.runCanUpdate('/' + file.name, (pct, msg) => { setProgress(pct); setUpdateMsg(msg); });
        setUpdateMsg('Update Done!');
        api.deleteFile('/' + file.name);
        setTimeout(() => setUpdating(false), 3000);
      } catch (e) {
        setUpdateMsg('Error: ' + e.message);
      }
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
      const blob = await fetch(url).then(r => r.blob());
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
          setTimeout(() => setUpdating(false), 3000);
        } catch (e) {
          setUpdateMsg('Error: ' + e.message);
        }
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
    const fd = new FormData();
    fd.append('updatefile', file);
    await api.uploadFile(fd);
    if (webFileRef.current) webFileRef.current.value = '';
    alert('File uploaded');
    dispatch({ type: 'SET_FILE_LIST', payload: await api.getFileList() });
  };

  return html`
    <div id="update" class="tabdiv main-content" style="display:flex">
      <div class="main-right">
        <h3 class="underline">Firmware</h3>
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
        <form id="uploadform" enctype="multipart/form-data">
          <input id="updatefile" name="updatefile" type="file" ref=${webFileRef} hidden onchange=${uploadWebFile} />
          <label class="butt" for="updatefile"><${Icon} n="upload" />Upload file</label>
        </form>
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
          <h3>OpenInverter Board Firmware</h3>
          <p>Use <b>Install firmware from file</b> to flash stm32_sine.bin or stm32_foc.bin from your computer.</p>
          <p>Use <b>Load OTA releases</b> to fetch and install firmware directly from GitHub.</p>
          <p style="font-size:.8rem;color:var(--text3);margin:0">${state.canMode ? 'Updates are sent over the CAN bus — the device needs the CAN-capable bootloader.' : 'Updates are sent over the serial connection to the inverter.'}</p>
        </div>
        <div class="dash-box compact">
          <h3>Web Interface</h3>
          <p style="margin:0">Upload individual web interface files using the <b>Upload file</b> button.</p>
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
const PlotChart = ({ plot, pushValue, maxValues }) => {
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
    if (!pushValue || !chartRef.current) return;
    const chart = chartRef.current;
    const active = items.filter(p => p.name);
    if (active.length === 0 || chart.data.datasets.length !== active.length) return;
    const t = timeRef.current++;
    active.forEach((p, si) => {
      const val = pushValue(p.name);
      if (val !== null && !isNaN(val) && chart.data.datasets[si]) {
        chart.data.datasets[si].data.push({ x: t, y: val });
        while (chart.data.datasets[si].data.length > maxValues) chart.data.datasets[si].data.shift();
      }
    });
    chart.update('none');
  }, [pushValue]);

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
  const [tick, setTick] = useState(0);
  const valsRef = useRef({});
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

    const loop = async () => {
      if (!running) return;
      try {
        const text = await api.getText('get ' + combined, burstLength);
        if (!running) return;
        const vals = text.match(/[\-\d\.]+/g) || [];
        const startIdx = Math.max(0, vals.length - allNames.length);
        allNames.forEach((name, i) => {
          const vi = startIdx + i;
          if (vi < vals.length) valsRef.current[name] = parseFloat(vals[vi]);
        });
        setTick(t => t + 1);
      } catch (e) { /* ignore */ }
      if (running) fetchRef.current = setTimeout(loop, 100);
    };

    fetchRef.current = setTimeout(loop, 0);
    return () => { running = false; if (fetchRef.current) clearTimeout(fetchRef.current); };
  }, [plotting, plots]);

  const getValue = (name) => valsRef.current[name] ?? null;

  const addPlot = () => {
    setPlots([...plots, { id: nextId.current++, items: [] }]);
  };
  const removePlot = (id) => {
    setPlots(plots.filter(p => p.id !== id));
  };
  const updatePlot = (id, field, value) => {
    setPlots(plots.map(p => p.id === id ? { ...p, [field]: value } : p));
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
          <${PlotChart} key=${p.id} plot=${p} pushValue=${plotting ? getValue : null} maxValues=${maxValues} />
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
    let count = 0;
    (async function loop() {
      while (loggingRef.current) {
        try {
          const cmd = 'get ' + names.join(',');
          const text = await api.getText(cmd);
          if (!loggingRef.current) break;
          const vals = text.match(/[\-\d\.]+/g) || [];
          const line = vals.join('\t');
          count++;
          setLogText(prev => {
            const next = prev + line + '\n';
            // Limit to ~500 lines to avoid memory issues
            const lines = next.split('\n');
            if (lines.length > 500) lines.splice(0, lines.length - 500);
            return lines.join('\n');
          });
          // Auto-scroll
          if (textRef.current) {
            textRef.current.scrollTop = textRef.current.scrollHeight;
          }
        } catch (e) {
          if (loggingRef.current) setLogText(p => p + 'Error: ' + e.message + '\n');
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
        <label>Samples per line: <input type="number" value=${samples} oninput=${e => setSamples(e.target.value)} style="width:5em" /></label>
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
  const spotNames = state.spotValues ? Object.keys(state.spotValues) : [];

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

// Theme helper
function getTheme() { return localStorage.getItem('theme') || 'system'; }
function setTheme(theme) {
  localStorage.setItem('theme', theme);
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

const Settings = () => {
  const { state, dispatch } = useContext(Store);
  const [txrxSwapped, setTxrxSwapped] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [theme, setThemeState] = useState(getTheme);
  const [accent, setAccentState] = useState(getAccent);
  const pickAccent = (hex) => {
    setAccentState(hex || '');
    applyAccent(hex);
    try { hex ? localStorage.setItem('accentColor', hex) : localStorage.removeItem('accentColor'); } catch (e) {}
  };

  // Export/import the web interface configuration (favourites, gauges,
  // plots, UI prefs) as one JSON bundle
  const exportUiSettings = async () => {
    const grab = (url) => fetch(url).then(r => r.json()).catch(() => null);
    const [favorites, gauges, plots] = await Promise.all([grab('/favorites.json'), grab('/gauges.json'), grab('/plots.json')]);
    const prefs = {};
    try {
      ['theme', 'accentColor', 'spotSparks'].forEach(k => {
        const v = localStorage.getItem(k);
        if (v != null) prefs[k] = v;
      });
    } catch (e) {}
    const bundle = { type: 'openinverter-ui-settings', version: 1, exported: new Date().toISOString(), favorites, gauges, plots, prefs };
    const a = document.createElement('a');
    a.href = 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(bundle, null, 2));
    a.download = 'ui-settings.json';
    a.click();
  };

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
      try { for (const k in (bundle.prefs || {})) localStorage.setItem(k, bundle.prefs[k]); } catch (err) {}
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
  const [canMode, setCanMode] = useState(false);
  const [canNodeId, setCanNodeId] = useState(1);
  const [canSpeed, setCanSpeed] = useState(2);
  const [canRxPin, setCanRxPin] = useState(4);
  const [canTxPin, setCanTxPin] = useState(5);
  const [savedCanMode, setSavedCanMode] = useState(false); // mode as persisted on the device
  const [scanState, setScanState] = useState(''); // '' | 'scanning' | result message

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/settings');
        if (r.ok) {
          const data = await r.json();
          setTxrxSwapped(data.txrx_swapped !== false);
          setCanMode(data.can_mode === true);
          setSavedCanMode(data.can_mode === true);
          if (data.can_node_id) setCanNodeId(data.can_node_id);
          if (data.can_speed !== undefined) setCanSpeed(data.can_speed);
          if (data.can_rx_pin) setCanRxPin(data.can_rx_pin);
          if (data.can_tx_pin) setCanTxPin(data.can_tx_pin);
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

  const saveCanSettings = async () => {
    setSaving(true);
    try {
      const bootNode = defaultNodeId();
      const params = new URLSearchParams();
      params.set('can_mode', canMode ? '1' : '0');
      params.set('can_node_id', bootNode);
      params.set('can_speed', canSpeed);
      params.set('can_rx_pin', canRxPin);
      params.set('can_tx_pin', canTxPin);
      await fetch('/settings?' + params.toString(), { method: 'POST' });
      dispatch({ type: 'SET_CAN_CONFIG', payload: { canMode, canNodeId: bootNode } });
      if (canMode) dispatch({ type: 'SET_CAN_NODE', payload: bootNode });
      setTimeout(() => setSaving(false), 2000);
    } catch (e) { setSaving(false); }
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

  if (loading) return html`<div class="tabdiv main-content" style="display:flex"><p>Loading...</p></div>`;

  return html`
    <div id="settings" class="tabdiv main-content" style="display:flex">
      <div class="main-left">
        <h2>Settings</h2>

        <div class="dash-box" style="margin-bottom:1rem">
          <h3>Theme</h3>
          <p style="font-size:.8rem;margin:0 0 .35rem">Choose appearance — System follows your device setting.</p>
          <select value=${theme} onchange=${e => { const v = e.target.value; setThemeState(v); setTheme(v); }}
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
        </div>

        <div class="dash-box compact" style="margin-bottom:1rem">
          <h3>Web Interface Settings</h3>
          <p style="font-size:.8rem;margin:0 0 .5rem">Back up or restore favourites, gauge and plot layouts, and UI preferences as a single file.</p>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button onclick=${exportUiSettings} style="width:auto"><${Icon} n="download" />Export settings</button>
            <input id="ui-settings-import" type="file" accept=".json" hidden onchange=${importUiSettings} />
            <label class="butt" for="ui-settings-import" style="width:auto"><${Icon} n="upload" />Import settings</label>
          </div>
        </div>

        <div class="dash-box" style="margin-bottom:1rem">
          <h3>Interface</h3>
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:.5rem">
            <label class="switch">
              <input type="checkbox" checked=${canMode} onchange=${e => setCanMode(e.target.checked)} />
              <span class="slider"></span>
            </label>
            <span style="font-weight:600">${canMode ? 'CAN Bus' : 'UART (Serial)'}</span>
            <button onclick=${async () => {
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
                setSavedCanMode(canMode);
                setTimeout(() => setSaving(false), 2000);
              } catch (e) { setSaving(false); }
            }} style="font-size:.75rem;padding:4px 12px;margin-left:auto;${canMode !== savedCanMode ? 'border-color:var(--amber);color:var(--amber)' : ''}" disabled=${saving}><${Icon} n="save" />${saving ? 'Saving...' : 'Save'}</button>
          </div>
          ${canMode !== savedCanMode && html`
            <p style="color:var(--amber);font-size:.78rem;margin:.25rem 0 0">
              Unsaved change — press <b>Save</b> to switch the interface to ${canMode ? 'CAN Bus' : 'UART'}${canMode ? ' before scanning for devices' : ''}.
            </p>
          `}

          ${!canMode && html`
            <h3 style="margin-top:.75rem">UART Configuration</h3>
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
            <h3 style="margin-top:.75rem">CAN Bus</h3>
            <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:.25rem;align-items:center">
              <label style="font-size:.75rem">Speed
                <select value=${canSpeed} onchange=${e => setCanSpeed(parseInt(e.target.value))} class="styled" style="font-size:.7rem">
                  <option value="0">125k</option>
                  <option value="1">250k</option>
                  <option value="2">500k</option>
                </select>
              </label>
              <label style="font-size:.75rem">RX Pin <input type="number" value=${canRxPin} oninput=${e => setCanRxPin(parseInt(e.target.value)||4)} style="width:4em;padding:2px 4px" /></label>
              <label style="font-size:.75rem">TX Pin <input type="number" value=${canTxPin} oninput=${e => setCanTxPin(parseInt(e.target.value)||5)} style="width:4em;padding:2px 4px" /></label>
            </div>
            <p style="color:var(--text2);font-size:.8rem;margin:0 0 .75rem">Speed and pins apply to all devices on the bus. Default: GPIO4 (RX), GPIO5 (TX).</p>

            <h3 style="margin-top:.75rem">CAN Devices</h3>
            <p style="color:var(--text2);font-size:.78rem;margin:0 0 .5rem">
              Setup: <b>1.</b> switch to CAN Bus → <b>2.</b> Save → <b>3.</b> Scan for devices.
              Found nodes are stored with the next Save; the <b>default</b> node is selected at boot.
            </p>
            ${!savedCanMode && html`<p style="color:var(--amber);font-size:.78rem;margin:0 0 .5rem">CAN mode isn't saved yet — scanning needs the saved interface to be CAN Bus.</p>`}
            <div style="display:flex;gap:6px;margin-bottom:.5rem">
              <button onclick=${async () => {
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
              }} disabled=${scanState === 'scanning'} style="font-size:.75rem;padding:4px 12px">
                ${scanState === 'scanning' ? 'Scanning…' : scanState || html`
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                  Scan for devices`}
              </button>
              <button onclick=${() => {
                const id = parseInt(prompt('Enter node ID (1-32):', '1'));
                if (id >= 1 && id <= 32) dispatch({ type: 'ADD_CAN_NODE', payload: { nodeId: id, name: '' } });
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

        <div class="dash-box" style="margin-bottom:1rem">
          <h3>WiFi Access Point</h3>
          <p style="color:var(--text2);font-size:.8rem;margin:0 0 .5rem">Configure the access point created by the inverter.</p>
          <div style="display:flex;flex-direction:column;gap:6px;max-width:350px">
            <label style="font-size:.8rem">SSID: <input type="text" value=${apSSID} oninput=${e => setApSSID(e.target.value)} style="width:100%" /></label>
            <label style="font-size:.8rem">Password: <input type="text" value=${apPW} oninput=${e => setApPW(e.target.value)} style="width:100%" minlength="8" /></label>
            <button onclick=${() => saveWiFi('ap')} style="align-self:flex-start">Save AP Settings</button>
          </div>
        </div>

        <div class="dash-box" style="margin-bottom:1rem">
          <h3>WiFi Station</h3>
          <p style="color:var(--text2);font-size:.8rem;margin:0 0 .5rem">Join an existing WiFi network. ${staIP && `Current IP: ${staIP}`}</p>
          <div style="display:flex;flex-direction:column;gap:6px;max-width:350px">
            <label style="font-size:.8rem">Network SSID: <input type="text" value=${staSSID} oninput=${e => setStaSSID(e.target.value)} style="width:100%" /></label>
            <label style="font-size:.8rem">Password: <input type="text" value=${staPW} oninput=${e => setStaPW(e.target.value)} style="width:100%" /></label>
            <button onclick=${() => saveWiFi('sta')} style="align-self:flex-start">Save Station Settings</button>
          </div>
        </div>

        ${wifiMsg && html`<p style="color:var(--accent);font-weight:600">${wifiMsg}</p>`}
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
const GaugeLine = ({ name, min, max, value, unit, color, enums, px = 230 }) => {
  const canvasRef = useRef(null);
  const chartRef = useRef(null);
  const MAX_POINTS = 20;
  const w = px, h = Math.round(px * 0.76); // chart fills the square; value sits right below

  useEffect(() => {
    if (canvasRef.current && !chartRef.current && typeof Chart !== 'undefined') {
      const yMin = min != null ? min : 0;
      const yMax = max != null && max !== 0 ? max : 4000;
      const col = color || colours[0];
      chartRef.current = new Chart(canvasRef.current, {
        type: 'line', data: { datasets: [{ label: name, data: [], borderColor: col, backgroundColor: col + '22', fill: true, pointRadius: 0, tension: 0.3 }] },
        options: {
          animation: false, parsing: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { type: 'linear', display: false },
            y: { type: 'linear', display: true, min: yMin, max: yMax,
                 ticks: { font: { size: 9 }, stepSize: ((yMax - yMin) / 2) || 1, maxTicksLimit: 3 } }
          }
        }
      });
    }
  }, []);

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

  useEffect(() => {
    if (value == null || isNaN(value) || !chartRef.current) return;
    const chart = chartRef.current;
    const ds = chart.data.datasets[0];
    if (!ds) return;
    ds.data.push({ x: ds.data.length, y: value });
    while (ds.data.length > MAX_POINTS) ds.data.shift();
    // Renumber x values so they remain contiguous from 0
    ds.data.forEach((pt, i) => { pt.x = i; });
    chart.update('none');
  }, [value]);

  return html`
    <div style=${'width:' + w + 'px;height:' + px + 'px;display:flex;flex-direction:column'}>
      <canvas ref=${canvasRef} width=${w} height=${h} style=${'width:' + w + 'px;height:' + h + 'px'}></canvas>
      <div class="g-val" style=${'font-size:' + (px / 230 * 1.6).toFixed(2) + 'rem;margin-top:2px'}>
        ${value != null ? (enums ? String(Math.round(value)) : value.toFixed(1)) : '—'}
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
const SvgGauge = ({ id, value, min = 0, max = 100, unit, color, enums, px }) => {
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
        <div class="g-val" style=${'font-size:' + (size / 230 * 2.1).toFixed(2) + 'rem'}>${v == null ? '—' : (enums ? String(Math.round(v)) : v.toFixed(1))}</div>
        ${enums
          ? (v != null && html`<div class="g-unit g-enum">${enumLabel(enums, v)}</div>`)
          : (unit && html`<div class="g-unit">${unit}</div>`)}
      </div>
      <div class="g-min" style=${'left:' + Math.round(size * 0.174) + 'px;bottom:' + Math.round(size * 0.072) + 'px;font-size:' + Math.max(0.68, size / 230 * 0.68).toFixed(2) + 'rem'}>${min}</div>
      <div class="g-max" style=${'right:' + Math.round(size * 0.174) + 'px;bottom:' + Math.round(size * 0.072) + 'px;font-size:' + Math.max(0.68, size / 230 * 0.68).toFixed(2) + 'rem'}>${max}</div>
    </div>`;
};

const Gauges = () => {
  const { state, dispatch } = useContext(Store);
  const [gaugeItems, setGaugeItems] = useState([]);
  const [lineVals, setLineVals] = useState({});
  const [editing, setEditing] = useState(false);
  const [gaugeSize, setGaugeSize] = useState('md'); // sm | md | lg
  const fetchRef = useRef(null);
  const nextId = useRef(1);

  // Load saved layout and fetch initial spot values for the picker
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/gauges.json');
        if (r.ok) {
          const data = await r.json();
          if (data.items && Array.isArray(data.items)) {
            const items = data.items.map(g => {
              if (typeof g === 'string') return { id: nextId.current++, name: g, min: 0, max: 100, type: 'radial' };
              if (!g.id) return { id: nextId.current++, ...g, type: g.type || 'radial' };
              if (g.id >= nextId.current) nextId.current = g.id + 1;
              return { ...g, type: g.type || 'radial' };
            });
            setGaugeItems(items);
          }
          if (['xs', 'sm', 'md', 'lg'].includes(data.size)) setGaugeSize(data.size);
        }
      } catch (e) { /* no saved layout */ }
    })();
    // Fetch spot values once for the picker (before high-perf loop pauses main refresh)
    api.getJSON('json').then(json => {
      dispatch({ type: 'SET_PARAMS', payload: json });
    }).catch(() => {});
  }, []);

  const saveLayout = async (items, size) => {
    try {
      const json = JSON.stringify({ items, size: size || gaugeSize });
      const blob = new Blob([json], { type: 'application/json' });
      const fd = new FormData();
      fd.append('updatefile', blob, 'gauges.json');
      await fetch('/edit', { method: 'POST', body: fd });
    } catch (e) { /* ignore */ }
  };

  const addGauge = () => {
    setGaugeItems([...gaugeItems, { id: nextId.current++, name: '', min: 0, max: 4000, type: 'radial' }]);
  };

  const removeGauge = (id) => {
    setGaugeItems(gaugeItems.filter(g => g.id !== id));
  };

  const moveGauge = (fromIdx, toIdx) => {
    if (fromIdx === toIdx) return;
    const next = [...gaugeItems];
    const [item] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, item);
    setGaugeItems(next);
  };

  // Drag state for reordering
  const dragIdx = useRef(-1);
  const [dragOverIdx, setDragOverIdx] = useState(-1);
  const [dragId, setDragId] = useState(null); // which gauge id is being dragged

  const updateGaugeConfig = (id, field, value) => {
    setGaugeItems(gaugeItems.map(g => g.id !== id ? g : { ...g, [field]: value }));
  };

  // High-perf spot value fetching (pauses main json refresh while on gauges page)
  // Uses a single 'get' command for all gauge names — one call, all values returned
  useEffect(() => {
    const names = gaugeItems.map(g => g.name).filter(Boolean);
    
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
        const next = {};
        gaugeItems.forEach((g, i) => {
          const val = parseFloat(vals[i]);
          if (!isNaN(val)) next[g.id] = val;
        });
        setLineVals(prev => ({ ...prev, ...next }));
      } catch (e) { /* ignore */ }
      // Schedule next fetch — respects actual response time to avoid pileup
      if (active) {
        const elapsed = performance.now() - t0;
        const delay = Math.max(0, interval - elapsed);
        fetchRef.current = setTimeout(fetchLoop, delay);
      }
    };
    
    fetchRef.current = setTimeout(fetchLoop, 0); // immediate first fetch

    return () => {
      active = false;
      dispatch({ type: 'SET_LOGGING', payload: false });
      if (fetchRef.current) { clearTimeout(fetchRef.current); fetchRef.current = null; }
    };
  }, [gaugeItems]);

  const spotNames = state.spotValues ? Object.keys(state.spotValues) : [];

  return html`
    <div id="gauges" class="tabdiv main-content" style="display:flex">
      ${editing && html`
      <div class="main-right">
        <h3 class="underline">Edit Gauges</h3>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:4px">
          <button onclick=${addGauge}><${Icon} n="plus" />Add Gauge</button>
          <button onclick=${() => { saveLayout(gaugeItems); setEditing(false); }}><${Icon} n="check" />Save & Done</button>
        </div>
        ${gaugeItems.length > 0 && html`
          <h3>Active (${gaugeItems.length})</h3>
          ${gaugeItems.map((g, i) => html`
            <div
              ondragover=${e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dragOverIdx !== i) setDragOverIdx(i); }}
              ondragleave=${e => { if (dragOverIdx === i) setDragOverIdx(-1); }}
              ondrop=${e => { e.preventDefault(); const from = dragIdx.current; if (from !== i && from >= 0) moveGauge(from, i); setDragOverIdx(-1); setDragId(null); }}
              style="margin-bottom:10px;padding:6px 8px;background:var(--surface2);border-radius:var(--radius-xs);font-size:.78rem;${dragOverIdx === i ? 'border-top:2px solid var(--accent);' : ''}${dragId === g.id ? 'opacity:0.4' : ''}">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
                <span draggable="true"
                  ondragstart=${e => { dragIdx.current = i; setDragId(g.id); e.dataTransfer.effectAllowed = 'move'; }}
                  ondragend=${e => { setDragOverIdx(-1); dragIdx.current = -1; setDragId(null); }}
                  style="cursor:grab;color:var(--text3);font-size:.9rem;user-select:none;padding-right:4px" title="Drag to reorder">⋮⋮</span>
                <${FieldPicker} value=${g.name} spotNames=${spotNames} onChange=${name => updateGaugeConfig(g.id, 'name', name)} />
                <span onclick=${() => removeGauge(g.id)} style="cursor:pointer;color:var(--red);font-weight:700;padding:0 4px" title="Remove">×</span>
              </div>
              <div style="display:flex;gap:6px;align-items:center;margin-bottom:4px">
                <select value=${g.type || 'radial'} onchange=${e => updateGaugeConfig(g.id, 'type', e.target.value)} style="font-size:.78rem;padding:4px 6px;width:6em">
                  <option value="radial">Radial</option>
                  <option value="line">Line</option>
                </select>
                <input type="color" value=${g.color || '#4cc9f0'} oninput=${e => updateGaugeConfig(g.id, 'color', e.target.value)}
                  title="Gauge colour"
                  style="width:30px;height:26px;padding:0;border:1px solid var(--border2);border-radius:6px;background:none;cursor:pointer" />
                ${g.color && html`<button onclick=${() => updateGaugeConfig(g.id, 'color', '')} style="font-size:.65rem;padding:2px 8px" title="Reset to theme gradient"><${Icon} n="undo" size=${11} /></button>`}
              </div>
              <div style="display:flex;gap:6px;align-items:center">
                <label style="white-space:nowrap;font-size:.72rem">Min</label>
                <input type="number" value=${g.min} oninput=${e => updateGaugeConfig(g.id, 'min', parseFloat(e.target.value) || 0)}
                  style="width:4.2em;flex:1;padding:4px 5px;font-size:.78rem" step="any" />
                <label style="white-space:nowrap;font-size:.72rem">Max</label>
                <input type="number" value=${g.max} oninput=${e => updateGaugeConfig(g.id, 'max', parseFloat(e.target.value) || 0)}
                  style="width:4.2em;flex:1;padding:4px 5px;font-size:.78rem" step="any" />
              </div>
            </div>
          `)}
        `}
      </div>
      `}
      <div class="main-left">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.5rem">
          <h2 style="margin:0">Gauges</h2>
          <div style="display:flex;gap:6px;align-items:center">
            <select value=${gaugeSize} title="Gauge size"
              onchange=${e => { const v = e.target.value; setGaugeSize(v); saveLayout(gaugeItems, v); }}
              style="font-size:.72rem;padding:4px 26px 4px 8px">
              <option value="xs">Very small</option>
              <option value="sm">Small</option>
              <option value="md">Medium</option>
              <option value="lg">Large</option>
            </select>
            ${!editing && html`<button onclick=${() => setEditing(true)} style="font-size:.75rem;padding:4px 12px"><${Icon} n="edit" />Edit Layout</button>`}
          </div>
        </div>
        ${gaugeItems.length === 0 && !editing && html`<p style="color:var(--text3);font-size:.85rem;text-align:center;padding:2rem 0">Click Edit Layout to add a gauge.</p>`}
        <div id="gauge-container" style="display:flex;flex-wrap:wrap;gap:1.5rem;justify-content:center;align-items:flex-start">
          ${gaugeItems.map(g => {
            const sv = state.spotValues && state.spotValues[g.name];
            const unit = (sv && sv.unit && sv.unit.indexOf('=') === -1) ? sv.unit : '';
            const enums = (sv && sv.enums) || null;
            return html`
            <div class="gauge-wrapper" style="text-align:center" key="${g.id}">
              <div style="font-weight:600;font-size:.9rem;margin-bottom:4px">${g.name || '—'}</div>
              ${(g.type === 'line')
                ? html`<${GaugeLine} key=${g.id + '-' + gaugeSize} name=${g.name} min=${g.min} max=${g.max} value=${lineVals[g.id]} unit=${unit} color=${g.color || ''} enums=${enums}
                    px=${gaugeSize === 'xs' ? 130 : gaugeSize === 'sm' ? 170 : gaugeSize === 'lg' ? 300 : 230} />`
                : html`<${SvgGauge} id=${g.id} value=${lineVals[g.id]} unit=${unit} color=${g.color || ''} enums=${enums}
                    px=${gaugeSize === 'xs' ? 130 : gaugeSize === 'sm' ? 170 : gaugeSize === 'lg' ? 300 : 230}
                    min=${g.min != null ? g.min : 0} max=${(g.max == null || g.max === 0) ? 4000 : g.max} />`}
            </div>
          `; })}
        </div>
      </div>
    </div>

  `;
};

// ==================== App ====================

const App = () => {
  const [state, dispatch] = useReducer(reducer, initialState);
  const store = useMemo(() => ({ state, dispatch }), [state]);

  // Load CAN settings on mount
  useEffect(() => {
    fetch('/settings').then(r => r.json()).then(data => {
      const mode = data.can_mode === true;
      const nodeId = data.can_node_id || 1;
      dispatch({ type: 'SET_CAN_CONFIG', payload: { canMode: mode, canNodeId: nodeId } });
      if (mode) dispatch({ type: 'SET_CAN_NODE', payload: nodeId });
      if (data.can_nodes) dispatch({ type: 'SET_CAN_NODES', payload: data.can_nodes });
    }).catch(() => {});
  }, []);

  // Unified data fetching — respects refreshRate setting
  useEffect(() => {
    let running = true;
    const rate = state.refreshRate; // -1 = off, 0 = max speed (continuous), else ms interval

    const fetchOnce = async () => {
      if (document.hidden || state.refreshRate === -1 || state.logging) return;
      dispatch({ type: 'SET_FETCHING' });
      try {
        const json = await api.getJSON('json');
        if (!running) return;
        dispatch({ type: 'SET_PARAMS', payload: json });
        if (state.activeTab === 'dashboard') {
          api.getText('errors').then(r => dispatch({ type: 'SET_MESSAGES', payload: r }));
        }
      } catch (e) {
        if (running) dispatch({ type: 'FETCH_ERROR' });
      }
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
          await fetchOnce();
          updateFPS();
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

  // Reset age on data fetch
  useEffect(() => { if (state.fetchAge === 0) {} }, [state.params]);

  const tab = state.activeTab;

  return html`
    <${Store.Provider} value=${{ state, dispatch }}>
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
