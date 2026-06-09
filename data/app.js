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
      .then(r => r.json())
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
    return r.text();
  },

  async uploadFile(formData) {
    const r = await fetch('/edit', { method: 'POST', body: formData });
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
    return r.json();
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
  autoReload: true,
  refreshRate: 3000,
  paramFavorites: [],
  spotFavorites: [],
  showFavoritesOnly: true, // 5000, 3000, 1000
  fileList: [],
  categoryVisible: {},
  fetching: false,
  commError: false,
  failedFetchCount: 0,
  navbarBig: true,
  fps: 0,
  rightPanelOpen: true,
  logging: false,
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
      return { ...state, params, spotValues, status, opmode, lasterr, udc, tmphs,
        firmwareVersion: version, categoryVisible: cv, fetchAge: 0,
        failedFetchCount: 0, commError: false, fetching: false };
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
      return { ...state, failedFetchCount: fc, commError: fc >= 2, fetching: false };
    case 'SET_ACTIVE_TAB':
      return { ...state, activeTab: action.payload };
    case 'SET_AUTO_RELOAD':
      return { ...state, autoReload: action.payload };
    case 'SET_FILE_LIST':
      return { ...state, fileList: action.payload };
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

const Modal = ({ id, size, title, children, onClose }) => html`
  <div id="${id}-modal-overlay" class="modal-overlay" style="display:block">
    <div class="${size === 'large' ? 'large-modal-container' : size === 'can-mapping' ? 'can-mapping-modal-container' : 'small-modal-container'}">
      ${title && html`<div id="large-modal-header-div"><h2>${title}</h2><span class="modal-close" onclick=${onClose}>×</span></div>`}
      <div class="modal-content">${children}</div>
    </div>
  </div>
`;

// ==================== Navbar ====================

const tabs = [
  { id: 'dashboard', label: 'Dashboard', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>' },
  { id: 'parameters', label: 'Parameters', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><circle cx="4" cy="12" r="2"/><circle cx="12" cy="10" r="2"/><circle cx="20" cy="14" r="2"/></svg>' },
  { id: 'spotvalues', label: 'Spot Values', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>' },
  { id: 'plot', label: 'Plot', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>' },
  { id: 'gauges', label: 'Gauges', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 20a8 8 0 0116 0"/><line x1="12" y1="20" x2="8.5" y2="8.5"/><circle cx="12" cy="20" r="1.5"/></svg>' },
  { id: 'logger', label: 'Data Logger', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>' },
  { id: 'canmapping', label: 'CAN Mapping', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>' },
  { id: 'files', label: 'Files', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>' },
  { id: 'update', label: 'Update', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>' },
  { id: 'settings', label: 'Settings', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 1a2 2 0 012 2v1.1a7 7 0 012.4 1l.8-.8a2 2 0 012.8 2.8l-.8.8a7 7 0 011 2.4H21a2 2 0 010 4h-1.1a7 7 0 01-1 2.4l.8.8a2 2 0 01-2.8 2.8l-.8-.8a7 7 0 01-2.4 1V21a2 2 0 01-4 0v-1.1a7 7 0 01-2.4-1l-.8.8a2 2 0 01-2.8-2.8l.8-.8a7 7 0 01-1-2.4H3a2 2 0 010-4h1.1a7 7 0 011-2.4l-.8-.8a2 2 0 012.8-2.8l.8.8a7 7 0 012.4-1V3a2 2 0 012-2z"/></svg>' },
  { id: 'support', label: 'Support', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3"/><circle cx="12" cy="17" r="0.5" fill="currentColor" stroke="none"/></svg>' },
];

const Navbar = () => {
  const { state, dispatch } = useContext(Store);
  const active = state.activeTab;

  return html`
    <aside id="navbar">
      <div id="logo">
        <img src="logo.png" onclick=${() => dispatch({ type: 'TOGGLE_NAVBAR' })} />
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
        </select>
      </div>
      <div id="data-age" style="display:flex;align-items:center;gap:6px">
        ${state.fetching && !state.logging && html`<div class="css-spinner"></div>`}
        <span style="flex:1;text-align:center">${state.fetchAge}s ago</span>
      </div>
      <div class="control" style="margin-top:4px;justify-content:center">
        <label class="switch" style=${{ opacity: state.logging ? '0.4' : '1', pointerEvents: state.logging ? 'none' : 'auto' }}>
          <input type="checkbox" checked=${state.autoReload} disabled=${state.logging} onchange=${e => dispatch({ type: 'SET_AUTO_RELOAD', payload: e.target.checked })} />
          <span class="slider"></span>
        </label>
        <span style=${{ opacity: state.logging ? '0.5' : '1' }}>Auto ${state.logging ? '(paused)' : ''}</span>
      </div>
      ${!state.autoReload && !state.logging && html`
        <div style="text-align:center;padding:4px 0 0">
          <button onclick=${() => { dispatch({ type: 'SET_FETCHING' }); api.getJSON('json').then(json => dispatch({ type: 'SET_PARAMS', payload: json })).catch(() => {}); }} style="font-size:.7rem;padding:4px 12px">Refresh now</button>
        </div>
      `}
      ${state.logging && html`<div style="text-align:center;padding:4px 0 0"><span style="background:var(--accent);color:#fff;padding:2px 8px;border-radius:10px;font-size:.65rem;font-weight:600;letter-spacing:.03em">⚡ FAST</span></div>`}
    </aside>
  `;
};

// ==================== Dashboard ====================

const Dashboard = () => {
  const { state, dispatch } = useContext(Store);
  const [cmd, setCmd] = useState('');
  const [cmdOutput, setCmdOutput] = useState('');

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
        <button onclick=${() => api.getText('start 2').then(r => dispatch({ type: 'SET_MESSAGES', payload: r }))}>Start inverter in manual mode</button>
        <button onclick=${() => api.getText('stop').then(r => dispatch({ type: 'SET_MESSAGES', payload: r }))}>Stop inverter</button>
      </div>
      <div class="main-left">
        <h2>Dashboard</h2>
        <div id="top-row" class="dash-row">
          <div id="top-left" class="dash-box">
            ${state.status ? html`
              <table><tbody>
                <tr><td>Status</td><td>${state.status}</td></tr>
                <tr><td>Opmode</td><td>${state.opmode}</td></tr>
                <tr><td>Last error</td><td>${state.lasterr}</td></tr>
                <tr><td>Battery voltage</td><td>${state.udc}</td></tr>
                <tr><td>Inverter temp</td><td>${state.tmphs}</td></tr>
              </tbody></table>
            ` : html`<${Spinner} />`}
          </div>
          <div id="top-right" class="dash-box">
            <h3>Inverter messages</h3>
            <pre><div>${state.messages}</div></pre>
          </div>
        </div>
        <div id="bottom-row">
          <div id="bottom-left" class="dash-box">
            <h3>Command</h3>
            <div id="commandoutput">${cmdOutput}</div>
            <div style="display:flex;gap:6px;margin-top:8px">
              <input type="text" id="commandinput" value=${cmd} oninput=${e => setCmd(e.target.value)} onkeyup=${e => e.keyCode === 13 && send()} style="flex:1" />
              <button onclick=${send} style="padding:8px 18px;font-weight:600">Send</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
};

// ==================== Parameters ====================

const Parameters = () => {
  const { state, dispatch } = useContext(Store);
  const [editing, setEditing] = useState(null);
  const [editValue, setEditValue] = useState('');
  const [subToken, setSubToken] = useState('');
  const [showSubscribe, setShowSubscribe] = useState(false);

  if (!state.params) return html`<div class="tabdiv main-content" style="display:flex"><p>Loading...</p></div>`;

  const hasFavs = state.paramFavorites.length > 0;
  const showFavs = state.showFavoritesOnly && hasFavs;

  const cats = {};
  for (const name in state.params) {
    const p = state.params[name];
    if (showFavs && !state.paramFavorites.includes(name)) continue;
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
        <h3 class="underline">Save & Load</h3>
        <button onclick=${() => api.getText('save').then(r => alert(r || 'Parameters saved'))}>Save parameters to flash</button>
        <button onclick=${() => api.getText('load')}>Restore parameters from flash</button>
        ${hasFavs && html`<button onclick=${() => dispatch({ type: 'TOGGLE_FAVORITES_ONLY' })}>
          ${showFavs ? '★ Show all' : '☆ Favorites only'}
        </button>`}
        <a download="params.json" href=${'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(state.params, null, 2))}><button>Download parameters file</button></a>
        <form id="paramform" enctype="multipart/form-data" action="edit" method="POST" onsubmit=${async e => { e.preventDefault(); await api.uploadFile(new FormData(e.target)); }}>
          <input id="paramfile" name="paramfile" type="file" hidden onchange=${e => e.target.form.requestSubmit()} />
          <label class="butt" for="paramfile">Load parameters from file</label>
        </form>
        <h3 class="underline">Parameter Database</h3>
        <button onclick=${submitToDatabase}>Submit parameters to database</button>
        <button onclick=${() => setShowSubscribe(true)}>Subscribe to parameter set</button>
        <button onclick=${stopSubscription}>Stop subscription</button>
        <h3 class="underline">Misc</h3>
        <a href="/syncofs.html" target="_blank"><button>Launch syncofs tuner</button></a>
        <a href="https://openinverter.org/wiki/Parameters" target="_blank"><button>Parameter reference</button></a>
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
              ${state.categoryVisible[cat] !== false && cats[cat].map(p => html`
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
  const wrapRef = useRef(null);
  const fetchRef = useRef(null);

  if (!state.spotValues) return html`<div class="tabdiv main-content" style="display:flex"><p>Loading...</p></div>`;

  const all = Object.values(state.spotValues);
  const term = search.toLowerCase();
  const hasFavs = (state.spotFavorites || []).length > 0;
  const showFavs = state.showFavoritesOnly && hasFavs;

  // High-perf fetch loop when in favorites-only mode
  useEffect(() => {
    if (!showFavs) {
      dispatch({ type: 'SET_LOGGING', payload: false });
      setFastVals({});
      return;
    }
    const names = state.spotFavorites;
    if (names.length === 0) return;

    dispatch({ type: 'SET_LOGGING', payload: true });
    let active = true;
    const interval = 100;

    const fetchLoop = async () => {
      if (!active) return;
      const t0 = performance.now();
      try {
        const text = await api.getText('get ' + names.join(','));
        if (!active) return;
        const vals = text.match(/[\-\d\.]+/g) || [];
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
  }, [showFavs, state.spotFavorites]);

  // Search always searches all items, then favorites filter applies
  let filtered = term ? all.filter(v => v.name.toLowerCase().includes(term)) : all;
  if (showFavs) filtered = filtered.filter(v => state.spotFavorites.includes(v.name));
  const isFav = (name) => (state.spotFavorites || []).includes(name);
  // Use fast value if available, otherwise store value
  const getDisplay = (v) => {
    if (showFavs && fastVals[v.name] !== undefined) return fastVals[v.name];
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
        <button onclick=${() => dispatch({ type: 'TOGGLE_FAVORITES_ONLY' })} style="width:100%;font-size:.75rem">
          ${showFavs ? '★ Show all' : '☆ Favorites only'}
        </button>
      </div>
      <div class="main-left">
        <h2>Spot Values</h2>
        <div id="spotValuesWrap" ref=${wrapRef} class="fullheight ${multiCol ? 'multi-col' : ''}" style="overflow-y:auto">
        <table id="spotValues" style="width:auto;table-layout:auto">
          <thead><tr><th style="width:32px"></th><th>Name</th><th style="width:100px;min-width:100px">Value</th><th style="width:60px;min-width:60px">Unit</th></tr></thead>
          <tbody>
            ${filtered.map(v => html`
              <tr key=${v.name}>
                <td style="width:28px;text-align:center;padding:2px">
                  <button onclick=${() => dispatch({ type: 'TOGGLE_SPOT_FAV', payload: v.name })}
                    style="background:none;border:none;cursor:pointer;font-size:1rem;padding:0;color:${isFav(v.name)?'var(--amber)':'var(--text3)'}">
                    ${isFav(v.name) ? '★' : '☆'}
                  </button>
                </td><td>${v.name}</td><td>${getDisplay(v)}</td><td>${v.unit && v.unit.indexOf('=') === -1 ? v.unit : ''}</td></tr>
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
  const { state } = useContext(Store);
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
    const fd = new FormData();
    fd.append('update-firmware-file', file);
    await api.uploadFile(fd);
    setUpdateMsg('Installing firmware...');
    const doStep = async (step) => {
      try {
        const result = await api.runUpdateStep(step, '/' + file.name);
        const pct = Math.round(100 * (step + 1) / result.pages);
        setProgress(pct);
        if (step + 1 < result.pages) setTimeout(() => doStep(step + 1), 50);
        else {
          setUpdateMsg('Update Done!');
          api.deleteFile('/' + file.name);
          setTimeout(() => setUpdating(false), 3000);
        }
      } catch (e) {
        setUpdateMsg('Error: ' + e.message);
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
      const doStep = async (step) => {
        const result = await api.runUpdateStep(step, '/stm32.bin');
        setProgress(Math.round(100 * (step + 1) / result.pages));
        if (step + 1 < result.pages) setTimeout(() => doStep(step + 1), 50);
        else { setUpdateMsg('Done!'); api.deleteFile('/stm32.bin'); setTimeout(() => setUpdating(false), 3000); }
      };
      doStep(-1);
    } catch (e) { setOtaMsg('Error: ' + e.message); }
  };

  const uploadWebFile = async () => {
    const file = webFileRef.current?.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('updatefile', file);
    await api.uploadFile(fd);
    alert('File uploaded');
    dispatch({ type: 'SET_FILE_LIST', payload: await api.getFileList() });
  };

  return html`
    <div id="update" class="tabdiv main-content" style="display:flex">
      <div class="main-right">
        <h3 class="underline">Firmware</h3>
        <form id="upload-firmware-form" enctype="multipart/form-data">
          <input id="update-firmware-file" name="update-firmware-file" type="file" ref=${fileRef} hidden />
          <label class="butt" for="update-firmware-file" onclick=${() => fileRef.current?.click()}>Install firmware from file</label>
          <button onclick=${installFirmware} style="display:none" id="firmware-go"></button>
        </form>
        <div>
          <button onclick=${loadReleases}>Load OTA releases</button>
          ${releases.length > 0 && html`
            <select id="ota-release">
              ${releases.map(r => html`<option value=${r.url}>${r.name}</option>`)}
            </select>
            <button onclick=${() => { const s = document.getElementById('ota-release'); if (s) installOTA(s.value); }}>OTA Install</button>
          `}
          <p>${otaMsg}</p>
        </div>
        <h3 class="underline">Web Interface</h3>
        <form id="uploadform" enctype="multipart/form-data">
          <input id="updatefile" name="updatefile" type="file" ref=${webFileRef} hidden />
          <label class="butt" for="updatefile" onclick=${() => webFileRef.current?.click()}>Upload file</label>
          <button onclick=${uploadWebFile} style="display:none"></button>
        </form>
        ${updating && html`
          <div id="progress" class="graph">
            <div id="upload-firmware-bar" style=${{ width: progress + '%' }}>
              <p>${progress}% ${updateMsg}</p>
            </div>
          </div>
        `}
      </div>
      <div class="main-left">
        <h2>Update</h2>
        <p>On this page you can apply software updates to your OpenInverter system.</p>
        <h3>OpenInverter Board Firmware</h3>
        <p>Use the <b>Install firmware from file</b> button to flash stm32_sine.bin or stm32_foc.bin.</p>
        <p>Use <b>Load OTA releases</b> to fetch and install firmware directly from GitHub.</p>
        <h3>Web Interface</h3>
        <p>Upload individual web interface files using the <b>Upload file</b> button.</p>
      </div>
    </div>
  `;
};

// ==================== Plot ====================

const colours = ['rgb(255,99,132)','rgb(54,162,235)','rgb(255,159,64)','rgb(153,102,255)','rgb(255,205,86)','rgb(75,192,192)'];

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
  const [search, setSearch] = useState('');
  const filtered = search ? spotNames.filter(n => n.toLowerCase().includes(search.toLowerCase())) : spotNames;

  return html`
    <div style="position:relative;flex:1">
      <div onclick=${() => setOpen(!open)} style="padding:3px 6px;border:1px solid var(--border2);border-radius:var(--radius-xs);font-size:.7rem;cursor:pointer;background:var(--surface);min-width:80px">
        ${value || 'Select...'}
      </div>
      ${open && html`
        <div style="position:absolute;top:100%;left:0;z-index:10;background:var(--surface);border:1px solid var(--border2);border-radius:var(--radius-xs);max-height:200px;overflow-y:auto;min-width:150px;box-shadow:var(--shadow)">
          <input type="text" placeholder="Search..." value=${search} oninput=${e => setSearch(e.target.value)}
            style="width:100%;padding:4px 6px;font-size:.7rem;border:none;border-bottom:1px solid var(--border2)" autofocus />
          ${filtered.map(n => html`
            <div class="hover-row" onclick=${() => { onChange(n); setOpen(false); setSearch(''); }}
              style="padding:3px 8px;font-size:.7rem;cursor:pointer">${n}</div>
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
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px">
          <button onclick=${addPlot}>+ Add plot</button>
          <button onclick=${() => { savePlots(); setEditing(false); }}>Save & Done</button>
        </div>

        ${plots.map(p => html`
          <div key=${p.id} style="margin-bottom:8px;padding:8px;background:var(--surface2);border-radius:var(--radius-xs)">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
              <span style="font-weight:600;font-size:.8rem">Plot ${p.id}</span>
              <span onclick=${() => removePlot(p.id)} style="cursor:pointer;color:var(--red);font-weight:700;font-size:1rem">×</span>
            </div>
            <div style="margin-bottom:4px">
              <button onclick=${() => addItem(p.id)} style="font-size:.7rem;padding:2px 8px">+ Field</button>
            </div>
            ${p.items.map((item, i) => html`
              <div key=${i} style="display:flex;gap:3px;align-items:center;margin-bottom:2px">
                <${FieldPicker} value=${item.name} spotNames=${spotNames} onChange=${name => updateItem(p.id, i, 'name', name)} />
                <select value=${item.axis || 'left'} onchange=${e => updateItem(p.id, i, 'axis', e.target.value)} style="width:3.2em;font-size:.65rem;padding:1px 2px;border-radius:var(--radius-xs)">
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
            <button onclick=${togglePlotting} style=${{ background: plotting ? 'var(--red)' : 'var(--green)', color: '#fff', borderColor: 'transparent', fontWeight: 600, fontSize: '.8rem', padding: '4px 14px' }}>
              ${plotting ? '⏹ Stop' : '▶ Start'}
            </button>
            ${!editing && html`<button onclick=${() => { if (plotting) setPlotting(false); setEditing(true); }} style="font-size:.75rem;padding:4px 12px">✎ Edit Layout</button>`}
          </div>
        </div>
        ${plots.map(p => html`
          <${PlotChart} key=${p.id} plot=${p} pushValue=${plotting ? getValue : null} maxValues=${maxValues} />
        `)}
        ${plots.length === 0 && !editing && html`<p style="color:var(--text3);text-align:center;padding:2rem 0">Click ✎ Edit Layout to add a plot.</p>`}
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
        ${!state.logging ? html`<button onclick=${startLog}>Start logging</button>`
          : html`<button onclick=${stopLog}>Stop logging</button>`}
        <button onclick=${() => {
          const blob = new Blob([logText], { type: 'text/plain' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'log_' + new Date().toISOString().slice(0,19).replace(/:/g,'-') + '.txt';
          a.click();
        }}>Save as...</button>
        <h3 class="underline">Configure Logger</h3>
        <label>Samples per line: <input type="number" value=${samples} oninput=${e => setSamples(e.target.value)} style="width:5em" /></label>
        ${logItems.map((item, i) => html`
          <div class="logger-field" key=${i} style="display:flex;gap:4px;align-items:center;margin-bottom:4px">
            <${FieldPicker} value=${item.name || ''} spotNames=${spotNames} onChange=${name => updateItem(i, 'name', name)} />
            ${!state.logging && html`<span onclick=${() => setLogItems(logItems.filter((_, j) => j !== i))} style="cursor:pointer;color:var(--red);font-weight:700;font-size:.9rem;padding:0 4px;line-height:1">×</span>`}
          </div>
        `)}
        ${!state.logging && html`<button onclick=${() => setLogItems([...logItems, { name: '' }])}>Add field to log</button>`}
      </div>
      <div class="main-left">
        <h2>Data Logger ${state.logging ? '(recording...)' : ''}</h2>
        <textarea id="data-logger-text-area" rows="50" ref=${textRef} value=${logText} readonly></textarea>
      </div>
    </div>
  `;
};

// ==================== CAN Mapping ====================

const CanMapping = () => {
  const { state } = useContext(Store);
  const [mappings, setMappings] = useState([]);
  const spotNames = state.spotValues ? Object.keys(state.spotValues) : [];

  return html`
    <div id="canmapping" class="tabdiv main-content" style="display:flex">
      <div class="main-right">
        <h3 class="underline">Actions</h3>
        <button onclick=${() => setMappings([...mappings, { name: '', txrx: 'tx', canid: 0, pos: 0, bits: 8, gain: 1 }])}>Add new mapping</button>
        <button onclick=${() => api.getText('can clear').then(() => setMappings([]))}>Remove all mappings</button>
          <button onclick=${async () => {
            for (const m of mappings) {
              if (!m.name) continue;
              const cmd = 'can ' + m.txrx + ' ' + m.name + ' ' + Number(m.canid||0) + ' ' + Number(m.pos||0) + ' ' + Number(m.bits||8) + ' ' + Number(m.gain||1);
              await api.getText(cmd);
            }
            const r = await api.getText('save');
            alert(r || 'Mappings saved');
          }}>Save mappings to flash</button>
      </div>
      <div class="main-left">
        <h2>CAN Mapping</h2>
        <p>Configure CAN mapping settings for your OpenInverter board.</p>
        <h3 class="underline">Existing CAN Mappings</h3>
        <table>
          <thead><tr><th>Spot Value</th><th>TX/RX</th><th>CAN ID</th><th>Offset</th><th>Length</th><th>Gain</th><th></th></tr></thead>
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
                <td><input type="number" value=${m.canid} oninput=${e => { const nm = [...mappings]; nm[i].canid = e.target.value; setMappings(nm); }} style="width:5em" /></td>
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
          <label class="butt" for="updatefile2">Upload file</label>
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

const Settings = () => {
  const [txrxSwapped, setTxrxSwapped] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [theme, setThemeState] = useState(getTheme);
  const [apSSID, setApSSID] = useState('');
  const [apPW, setApPW] = useState('');
  const [staSSID, setStaSSID] = useState('');
  const [staPW, setStaPW] = useState('');
  const [staIP, setStaIP] = useState('');
  const [wifiMsg, setWifiMsg] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/settings');
        if (r.ok) {
          const data = await r.json();
          setTxrxSwapped(data.txrx_swapped !== false);
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
            class="styled">
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </div>

        <div class="dash-box" style="margin-bottom:1rem">
          <h3>UART Configuration</h3>
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:.5rem">
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
      <a href="/remote.html" target="_blank"><button>Start remote support session</button></a>
    </div>
    <div class="main-left">
      <h2>Support</h2>
      <p>Get support from the community on the <a href="https://openinverter.org">OpenInverter Forum</a>.</p>
      <p>Paid support is also available. See details <a href="https://openinverter.org/docs/index.html%3Fen_consulting,35.html">here</a>.</p>
      <p style="font-size:.8rem;color:var(--text2)">Remote support opens in a new tab. Your device must be connected to both the inverter and the internet.</p>
    </div>
  </div>
`;

// ==================== Gauges ====================

// Mini line chart for gauge line mode — value and unit passed as props
const GaugeLine = ({ name, min, max, value, unit }) => {
  const canvasRef = useRef(null);
  const chartRef = useRef(null);
  const MAX_POINTS = 20;

  useEffect(() => {
    if (canvasRef.current && !chartRef.current && typeof Chart !== 'undefined') {
      const yMin = min != null ? min : 0;
      const yMax = max != null && max !== 0 ? max : 100;
      chartRef.current = new Chart(canvasRef.current, {
        type: 'line', data: { datasets: [{ label: name, data: [], borderColor: colours[1], backgroundColor: colours[1] + '22', fill: true, pointRadius: 0, tension: 0.3 }] },
        options: {
          animation: false, parsing: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { type: 'linear', display: true, ticks: { maxTicksLimit: 4, font: { size: 9 } }, grid: { display: false } },
            y: { type: 'linear', display: true, min: yMin, max: yMax, ticks: { font: { size: 9 } } }
          }
        }
      });
    }
  }, []);

  useEffect(() => {
    if (!chartRef.current) return;
    const chart = chartRef.current;
    chart.options.scales.y.min = min != null ? min : 0;
    chart.options.scales.y.max = (max != null && max !== 0) ? max : 100;
    chart.update('none');
  }, [min, max]);

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
    <div style="width:250px">
      <canvas ref=${canvasRef} width="250" height="200" style="width:250px;height:200px"></canvas>
      <div style="font-size:1.4rem;font-weight:700;color:var(--accent);line-height:1.2;margin-top:2px">
        ${value != null ? value.toFixed(1) : '—'}
        ${unit && html`<span style="font-size:.7rem;font-weight:500;color:var(--text2)"> ${unit}</span>`}
      </div>
    </div>
  `;
};

// Resolve a CSS variable to its computed color, with fallback
function getCSSColor(varname, fallback) {
  try {
    const val = getComputedStyle(document.documentElement).getPropertyValue(varname).trim();
    return val || fallback;
  } catch (e) { return fallback; }
}

const gaugeId = (id) => 'gauge-' + id;

const Gauges = () => {
  const { state, dispatch } = useContext(Store);
  const [gaugeItems, setGaugeItems] = useState([]);
  const [lineVals, setLineVals] = useState({});
  const [editing, setEditing] = useState(false);
  const gaugeRefs = useRef({});
  const createdRef = useRef({});
  const fetchRef = useRef(null);
  const nextId = useRef(1);

  const colors = useRef({
    text: '#1a1d23', text2: '#5f6672', accent: '#2563eb', red: '#dc2626',
    surface: '#ffffff', bg: '#f0f2f5',
  });

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
        }
      } catch (e) { /* no saved layout */ }
    })();
    // Fetch spot values once for the picker (before high-perf loop pauses main refresh)
    api.getJSON('json').then(json => {
      dispatch({ type: 'SET_PARAMS', payload: json });
    }).catch(() => {});
    // Resolve actual theme colors
    colors.current.text = getCSSColor('--text', '#1a1d23');
    colors.current.text2 = getCSSColor('--text2', '#5f6672');
    colors.current.accent = getCSSColor('--accent', '#2563eb');
    colors.current.red = getCSSColor('--red', '#dc2626');
    colors.current.surface = getCSSColor('--surface', '#ffffff');
    colors.current.bg = getCSSColor('--bg', '#f0f2f5');
  }, []);

  const saveLayout = async (items) => {
    try {
      const json = JSON.stringify({ items });
      const blob = new Blob([json], { type: 'application/json' });
      const fd = new FormData();
      fd.append('updatefile', blob, 'gauges.json');
      await fetch('/edit', { method: 'POST', body: fd });
    } catch (e) { /* ignore */ }
  };

  const addGauge = () => {
    setGaugeItems([...gaugeItems, { id: nextId.current++, name: '', min: 0, max: 100, type: 'radial' }]);
  };

  const removeGauge = (id) => {
    setGaugeItems(gaugeItems.filter(g => g.id !== id));
    if (gaugeRefs.current[id]) { gaugeRefs.current[id] = null; }
    delete createdRef.current[id];
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
    // Clear refs on type or name change so gauge is recreated with new settings
    if (field === 'type' || field === 'name') {
      if (gaugeRefs.current[id]) { gaugeRefs.current[id] = null; }
      delete createdRef.current[id];
    }
  };

  // Helper to get spot value for a name (from params or spotValues)
  const getValue = useCallback((name) => {
    if (!state.spotValues) return null;
    const sv = state.spotValues[name];
    if (sv) return { value: parseFloat(sv.value), unit: sv.unit || '' };
    if (state.params && state.params[name]) {
      const pv = parseFloat(state.params[name].value);
      return { value: isNaN(pv) ? null : pv, unit: state.params[name].unit || '' };
    }
    return null;
  }, [state.spotValues, state.params]);

  // Create gauge instances after DOM is ready
  useEffect(() => {
    if (gaugeItems.length === 0) return;

    // Delay to ensure canvas elements are in the DOM
    const timer = setTimeout(() => {
      gaugeItems.forEach(g => {
        const cid = gaugeId(g.id);
        const canvas = document.getElementById(cid);
        if (!canvas) return;
        if (createdRef.current[g.id]) return;

        const valInfo = getValue(g.name);
        const val = valInfo ? valInfo.value : 0;
        const min = (g.min != null && g.min !== 0) ? g.min : 0;
        const max = (g.max != null && g.max !== 100) ? g.max : Math.max(100, Math.ceil(val * 1.2));

        const c = colors.current;
        try {
          const gauge = new RadialGauge({
            renderTo: canvas,
            title: '',
            width: 250, height: 250,
            minValue: min,
            maxValue: max,
            majorTicks: calcTicks(min, max),
            highlights: [],
            value: val,
            valueInt: 1, valueDec: 1,
            units: (valInfo && valInfo.unit && valInfo.unit.indexOf('=') === -1) ? valInfo.unit : '',
            animation: true,
            animationDuration: 400,
            colorPlate: 'transparent',
            colorMajorTicks: c.text2,
            colorMinorTicks: c.text2,
            colorTitle: c.text,
            colorUnits: c.text2,
            colorNumbers: c.text2,
            colorNeedle: c.accent,
            colorNeedleEnd: c.accent,
            colorValueText: c.accent,
            colorValueBoxBackground: 'transparent',
            colorValueBoxRect: 'transparent',
            colorValueBoxRectEnd: 'transparent',
            colorValueBoxShadow: 'transparent',
            valueBox: true,
            valueBoxStroke: 0,
            valueText: '',
            needle: true,
            needleShadow: false,
            needleType: 'arrow',
            needleStart: 15,
            needleEnd: 75,
            needleWidth: 3,
            borderOuterWidth: 0,
            borderMiddleWidth: 0,
            borderInnerWidth: 0,
            borderShadowWidth: 0,
            colorBorderOuter: 'transparent',
            colorBorderMiddle: 'transparent',
            colorBorderInner: 'transparent',
            colorBorderShadow: 'transparent',
            colorBarStroke: c.text3 || c.text2,
            colorBar: c.surface3 || c.surface2,
            colorBarProgress: c.accent,
            colorBarShadow: 'transparent',
            barWidth: 8,
            barStrokeWidth: 1,
            barProgress: true,
            barShadow: false,
            fontNumbersSize: 14,
            fontNumbersWeight: 'normal',
            fontValueSize: 26,
          });
          gauge.draw();
          gaugeRefs.current[g.id] = gauge;
          createdRef.current[g.id] = true;
        } catch (e) { console.log('Gauge create error', g.name, e); }
      });
    }, 50);
    return () => clearTimeout(timer);
  }, [gaugeItems]);

  // Gauge values now come from high-perf get command (see fetchLoop below)

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
        gaugeItems.forEach((g, i) => {
          const val = parseFloat(vals[i]);
          if (isNaN(val)) return;
          if (g.type === 'line') {
            setLineVals(prev => ({ ...prev, [g.id]: val }));
          } else {
            const gauge = gaugeRefs.current[g.id];
            if (gauge) {
              gauge.value = val;
              // Force value box text to update immediately (not just on animation tick)
              if (gauge.options) gauge.options.valueText = val.toFixed(1);
            }
          }
        });
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

  // Update gauge min/max when config changes
  useEffect(() => {
    gaugeItems.forEach(g => {
      const gauge = gaugeRefs.current[g.id];
      if (!gauge) return;
      if (g.min != null && gauge.options.minValue !== g.min) {
        gauge.options.minValue = g.min;
        gauge.options.majorTicks = calcTicks(g.min, gauge.options.maxValue);
      }
      if (g.max != null && gauge.options.maxValue !== g.max) {
        gauge.options.maxValue = g.max;
        gauge.options.majorTicks = calcTicks(gauge.options.minValue, g.max);
      }
    });
  }, [gaugeItems]);

  // Smooth animation tick (updates needle position and value box at ~60fps)
  useEffect(() => {
    let rafId;
    const tick = () => {
      gaugeItems.forEach(g => {
        const gauge = gaugeRefs.current[g.id];
        if (gauge) {
          try { gauge.update(); } catch (e) { /* ignore */ }
        }
      });
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [gaugeItems]);

  const spotNames = state.spotValues ? Object.keys(state.spotValues) : [];

  return html`
    <div id="gauges" class="tabdiv main-content" style="display:flex">
      ${editing && html`
      <div class="main-right">
        <h3 class="underline">Edit Gauges</h3>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:4px">
          <button onclick=${addGauge}>+ Add Gauge</button>
          <button onclick=${() => { saveLayout(gaugeItems); setEditing(false); }}>Save & Done</button>
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
              <div style="display:flex;gap:4px;align-items:center;margin-bottom:3px">
                <select value=${g.type || 'radial'} onchange=${e => updateGaugeConfig(g.id, 'type', e.target.value)} style="font-size:.65rem;padding:1px 3px;width:5em">
                  <option value="radial">Radial</option>
                  <option value="line">Line</option>
                </select>
                <label style="white-space:nowrap;font-size:.7rem">Min</label>
                <input type="number" value=${g.min} oninput=${e => updateGaugeConfig(g.id, 'min', parseFloat(e.target.value) || 0)}
                  style="width:100%;padding:2px 4px;font-size:.7rem" step="any" />
                <label style="white-space:nowrap;font-size:.7rem">Max</label>
                <input type="number" value=${g.max} oninput=${e => updateGaugeConfig(g.id, 'max', parseFloat(e.target.value) || 0)}
                  style="width:100%;padding:2px 4px;font-size:.7rem" step="any" />
              </div>
            </div>
          `)}
        `}
      </div>
      `}
      <div class="main-left">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.5rem">
          <h2 style="margin:0">Gauges</h2>
          ${!editing && html`<button onclick=${() => setEditing(true)} style="font-size:.75rem;padding:4px 12px">✎ Edit Layout</button>`}
        </div>
        ${gaugeItems.length === 0 && !editing && html`<p style="color:var(--text3);font-size:.85rem;text-align:center;padding:2rem 0">Click ✎ Edit Layout to add a gauge.</p>`}
        <div id="gauge-container" style="display:flex;flex-wrap:wrap;gap:1.5rem;justify-content:center;align-items:flex-start">
          ${gaugeItems.map(g => html`
            <div class="gauge-wrapper" style="text-align:center" key="${g.id}">
              <div style="font-weight:600;font-size:.9rem;margin-bottom:4px">${g.name || '—'}</div>
              ${(g.type === 'line')
                ? html`<${GaugeLine} name=${g.name} min=${g.min} max=${g.max} value=${lineVals[g.id]} unit=${(state.spotValues && state.spotValues[g.name] && state.spotValues[g.name].unit && state.spotValues[g.name].unit.indexOf('=') === -1) ? state.spotValues[g.name].unit : ''} />`
                : html`
                  <canvas id="${gaugeId(g.id)}" width="250" height="250"></canvas>
                `}
            </div>
          `)}
        </div>
      </div>
    </div>

  `;
};

function calcTicks(min, max) {
  const N = 6;
  const ticks = [min];
  const dist = (max - min) / N;
  let tick = min;
  for (let i = 0; i < N; i++) {
    tick += dist;
    ticks.push(Math.round(tick));
  }
  return ticks;
}

// ==================== App ====================

const App = () => {
  const [state, dispatch] = useReducer(reducer, initialState);
  const store = useMemo(() => ({ state, dispatch }), [state]);

  // Unified data fetching — respects refreshRate setting
  useEffect(() => {
    let running = true;
    const rate = state.refreshRate; // 0 = max speed (continuous), else ms interval

    const fetchOnce = async () => {
      if (document.hidden || !state.autoReload || state.logging) return;
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

    if (rate === 0) {
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
  }, [state.autoReload, state.refreshRate, state.logging]);

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
