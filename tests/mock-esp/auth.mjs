// The firmware's users/permissions model for the mock ESP: a line-for-line
// port of src/web_logic.h (route table, cmdPerm, staticPerm, filePerm,
// csrfOk) and src/web_auth.h (accounts, sessions, stream tickets, sign-in
// limiter). tests/e2e/mock-contract.spec.mjs parses ROUTES out of
// web_logic.h and fails if this table drifts from it.
import crypto from 'node:crypto';

export const PERM = { PUBLIC: 0, READ: 1, WRITE: 2, ADMIN: 3, DENY: 4, CMD: 5, FILE: 6 };
export const ROLE = { none: 0, viewer: 1, operator: 2, admin: 3 };
const PERM_ROLE = { 1: 'viewer', 2: 'operator', 3: 'admin' };

const M = { GET: 1, POST: 2, PUT: 4, DELETE: 8, OTHER: 16, ANY: 31 };
export const methodBit = (m) => M[m] && m !== 'ANY' && m !== 'OTHER' ? M[m] : M.OTHER;

// [path, methods, perm] — same order and content as weblogic::ROUTES
export const ROUTES = [
  ['/auth/state', M.GET, PERM.PUBLIC],
  ['/auth/login', M.POST, PERM.PUBLIC],
  ['/auth/logout', M.POST, PERM.PUBLIC],
  ['/auth/password', M.POST, PERM.READ],
  ['/auth/stream-ticket', M.GET, PERM.READ],
  ['/auth/users', M.GET | M.POST, PERM.ADMIN],
  ['/cmd', M.ANY, PERM.CMD],
  ['/list', M.GET, PERM.READ],
  ['/rtc/now', M.GET, PERM.READ],
  ['/sdcard/list', M.GET, PERM.READ],
  ['/espupdate-status', M.GET, PERM.READ],
  ['/wifi-status', M.GET, PERM.READ],
  ['/fwupdate-status', M.ANY, PERM.READ],
  ['/baud', M.ANY, PERM.READ],
  ['/version', M.ANY, PERM.READ],
  ['/otainfo', M.ANY, PERM.READ],
  ['/settings', M.GET, PERM.READ],
  ['/favorites.json', M.ANY, PERM.READ],
  ['/gauges.json', M.ANY, PERM.READ],
  ['/plots.json', M.ANY, PERM.READ],
  ['/virtualvals.json', M.ANY, PERM.READ],
  ['/edit', M.GET, PERM.READ],
  ['/edit', M.PUT | M.DELETE | M.POST, PERM.FILE],
  ['/rtc/set', M.POST, PERM.WRITE],
  ['/sdcard/deleteAll', M.GET, PERM.WRITE],
  ['/reset-inverter', M.ANY, PERM.WRITE],
  ['/can-send', M.ANY, PERM.WRITE],
  ['/can-scan', M.ANY, PERM.WRITE],
  ['/can-debug', M.ANY, PERM.WRITE],
  ['/set-can-node', M.ANY, PERM.WRITE],
  ['/virtual-reload', M.ANY, PERM.WRITE],
  ['/settings', M.POST, PERM.ADMIN],
  ['/wifi', M.ANY, PERM.ADMIN],
  ['/espupdate', M.POST, PERM.ADMIN],
  ['/espupdate-url', M.POST, PERM.ADMIN],
  ['/update', M.GET | M.POST, PERM.ADMIN],
  ['/fwupdate', M.ANY, PERM.ADMIN],
  ['/can-fwupdate', M.ANY, PERM.ADMIN],
  ['/reboot', M.ANY, PERM.ADMIN],
];
export const METHOD_BITS = M;

export function findRoute(mb, path) {
  return ROUTES.find(([p, m]) => (m & mb) && p === path) || null;
}

// Any byte below 0x20 (the C side's `(uint8_t)c < 0x20` loops)
const hasCtl = (s) => { for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) < 0x20) return true; return false; };

const UI_EXTS = ['.html', '.htm', '.js', '.mjs', '.css', '.svg', '.png', '.ico', '.jpg', '.jpeg', '.gif', '.woff', '.woff2', '.webmanifest'];
export function isUiAsset(path) {
  if (typeof path !== 'string' || path[0] !== '/') return false;
  let p = path.endsWith('.gz') ? path.slice(0, -3) : path;
  if (p.length === 1) return true;
  if (p === '/subscription.js') return false;
  if (/^\/img-.+\.(png|jpe?g|webp|gif)$/.test(p)) return false; // image-tile uploads are data
  return UI_EXTS.some(e => p.endsWith(e)) || p === '/manifest.json';
}

export function staticPerm(path) {
  if (typeof path !== 'string' || path[0] !== '/') return PERM.DENY;
  if (hasCtl(path) || path.includes('\\') || path.includes('..')) return PERM.DENY;
  return isUiAsset(path) ? PERM.PUBLIC : PERM.READ;
}

export function filePerm(raw) {
  if (!raw) return PERM.WRITE;
  if (raw.length > 70) return PERM.ADMIN;
  const p = raw[0] === '/' ? raw : '/' + raw;
  if (hasCtl(p)) return PERM.DENY;
  if (isUiAsset(p)) return PERM.ADMIN;
  if (p === '/settings.json' || p === '/settings.json.gz') return PERM.ADMIN;
  return PERM.WRITE;
}

const NAMES_RE = /^[A-Za-z0-9_,.-]+$/;
export function cmdPerm(cmd) {
  if (typeof cmd !== 'string' || !cmd.length) return PERM.WRITE;
  if (/[^\x20-\x7e]/.test(cmd)) return PERM.WRITE;
  const sp = cmd.indexOf(' ');
  const verb = sp < 0 ? cmd : cmd.slice(0, sp);
  const rest = sp < 0 ? null : cmd.slice(sp + 1);
  switch (verb) {
    case 'json': return rest === null || rest === 'hidden' ? PERM.READ : PERM.WRITE;
    case 'errors': case 'serial': case 'help': return rest === null ? PERM.READ : PERM.WRITE;
    case 'get': return rest !== null && NAMES_RE.test(rest) ? PERM.READ : PERM.WRITE;
    case 'stream': {
      if (rest === null) return PERM.WRITE;
      const sp2 = rest.indexOf(' ');
      if (sp2 < 0) return PERM.WRITE;
      const n = rest.slice(0, sp2);
      if (!/^[0-9]{1,3}$/.test(n) || +n < 1 || +n > 100) return PERM.WRITE;
      return NAMES_RE.test(rest.slice(sp2 + 1)) ? PERM.READ : PERM.WRITE;
    }
    case 'can': return rest === 'list' || rest === 'print' ? PERM.READ : PERM.WRITE;
    default: return PERM.WRITE;
  }
}

function hostPart(v) {
  if (typeof v !== 'string' || !v) return null;
  let s = v.includes('://') ? v.slice(v.indexOf('://') + 3) : v;
  if (s[0] === '[') { const e = s.indexOf(']'); return e > 0 ? s.slice(0, e + 1) : null; }
  const m = /^[^:/]*/.exec(s)[0];
  return m ? m.toLowerCase() : null;
}
export function originHostMatches(origin, host) {
  const a = hostPart(origin), b = hostPart(host);
  return !!a && !!b && a === b;
}

export function csrfOk(bearer, origin, referer, xAuth, host) {
  if (bearer) return true;
  if (!host) return false;
  if (origin) return origin === 'http://' + host || origin === 'https://' + host;
  if (xAuth === '1') return true;
  if (referer) return referer.startsWith('http://' + host + '/') || referer.startsWith('https://' + host + '/');
  return false;
}

// ---------------------------------------------------------------- accounts etc.
export const PASSWORD_MIN = 8, PASSWORD_MAX = 64, USER_MAX = 8;
export const SESSION_MAX = 8;
export const SESSION_IDLE_MS = 12 * 3600e3, SESSION_REMEMBER_IDLE_MS = 30 * 24 * 3600e3, SESSION_ABSOLUTE_MS = 30 * 24 * 3600e3;
export const TICKET_MS = 30e3;
export const LIMIT_WINDOW_MS = 5 * 60e3, LIMIT_PER_IP = 6, LIMIT_PER_USER = 10, LIMIT_GLOBAL = 30;
const ITERATIONS = 50; // the device uses 10000; the mock only needs a real KDF, not a slow one

const userNameValid = (s) => typeof s === 'string' && /^[a-z0-9._-]{1,32}$/.test(s);
const passwordValid = (s) => typeof s === 'string' && Buffer.byteLength(s) >= PASSWORD_MIN && Buffer.byteLength(s) <= PASSWORD_MAX && !hasCtl(s) && !s.includes('\x7f');

const RESULT = {
  BAD_NAME: 'user name must be 1-32 characters: a-z 0-9 . _ -',
  BAD_PASSWORD: 'password must be 8-64 characters',
  BAD_ROLE: 'role must be viewer, operator or admin',
  EXISTS: 'that user already exists',
  FULL: 'no room for more users (8 at most)',
  NOT_FOUND: 'no such user',
  LAST_ADMIN: 'the last admin cannot be removed or demoted',
  SELF: 'you cannot remove or demote your own account',
  FIRST_ADMIN: 'the first user must be an admin',
};
export const RESULT_TEXT = RESULT;
const RESULT_STATUS = (r) => r === RESULT.NOT_FOUND ? 404 : r === RESULT.EXISTS ? 409 : 400;

export function createAuth(now = () => Date.now()) {
  let users = [];      // { name, role, salt, hash, gen }
  let sessions = [];   // SESSION_MAX slots: null | { token, user, userGen, serial, remember, created, lastUsed }
  let tickets = [];    // { ticket, slot, serial, expires }
  let nextSerial = 1;
  let ips = new Map(), names = new Map(), global = { fails: 0, start: 0 };

  const enabled = () => users.length > 0;
  const kdf = (pw, salt) => crypto.pbkdf2Sync(Buffer.from(pw || '', 'utf8').subarray(0, PASSWORD_MAX), salt, ITERATIONS, 32, 'sha256');
  const find = (name) => users.findIndex(u => u.name === name);
  const adminCount = () => users.filter(u => u.role === 'admin').length;

  function setPw(u, pw) { u.salt = crypto.randomBytes(16); u.hash = kdf(pw, u.salt); }
  function add(name, pw, role) {
    if (!userNameValid(name)) return RESULT.BAD_NAME;
    if (!passwordValid(pw)) return RESULT.BAD_PASSWORD;
    if (!ROLE[role]) return RESULT.BAD_ROLE;
    if (!users.length && role !== 'admin') return RESULT.FIRST_ADMIN;
    if (find(name) >= 0) return RESULT.EXISTS;
    if (users.length >= USER_MAX) return RESULT.FULL;
    const u = { name, role, gen: 1 };
    setPw(u, pw);
    users.push(u);
    return null;
  }
  function remove(name, actor) {
    const i = find(name);
    if (i < 0) return RESULT.NOT_FOUND;
    if (actor && actor === name) return RESULT.SELF;
    if (users[i].role === 'admin' && adminCount() === 1) return RESULT.LAST_ADMIN;
    users.splice(i, 1);
    return null;
  }
  function setRole(name, role, actor) {
    const i = find(name);
    if (i < 0) return RESULT.NOT_FOUND;
    if (!ROLE[role]) return RESULT.BAD_ROLE;
    if (users[i].role === role) return null;
    if (actor && actor === name) return RESULT.SELF;
    if (users[i].role === 'admin' && adminCount() === 1) return RESULT.LAST_ADMIN;
    users[i].role = role; users[i].gen++;
    return null;
  }
  function setPassword(name, pw) {
    const i = find(name);
    if (i < 0) return RESULT.NOT_FOUND;
    if (!passwordValid(pw)) return RESULT.BAD_PASSWORD;
    setPw(users[i], pw); users[i].gen++;
    return null;
  }
  function verify(name, pw) {
    const i = find(name);
    const calc = kdf(pw, i >= 0 ? users[i].salt : Buffer.alloc(16));
    return i >= 0 && crypto.timingSafeEqual(calc, users[i].hash) ? i : -1;
  }

  // sessions
  const expired = (s, t) => t - s.lastUsed > (s.remember ? SESSION_REMEMBER_IDLE_MS : SESSION_IDLE_MS) || t - s.created > SESSION_ABSOLUTE_MS;
  function revoke(slot) {
    if (slot < 0 || slot >= SESSION_MAX) return;
    sessions[slot] = null;
    tickets = tickets.filter(t => t.slot !== slot);
  }
  function createSession(user, userGen, remember) {
    const t = now();
    let slot = -1;
    for (let i = 0; i < SESSION_MAX; i++) if (!sessions[i] || expired(sessions[i], t)) { slot = i; break; }
    if (slot < 0) { slot = 0; for (let i = 1; i < SESSION_MAX; i++) if (sessions[i].lastUsed < sessions[slot].lastUsed) slot = i; }
    revoke(slot);
    const token = crypto.randomBytes(32).toString('hex');
    sessions[slot] = { token, user, userGen, serial: nextSerial++, remember, created: t, lastUsed: t };
    return { slot, token };
  }
  function findSession(token, touch = true) {
    if (typeof token !== 'string' || !/^[0-9a-fA-F]{64}$/.test(token)) return -1;
    const want = Buffer.from(token.toLowerCase(), 'hex');
    let hit = -1;
    for (let i = 0; i < SESSION_MAX; i++) {
      const s = sessions[i];
      if (s && crypto.timingSafeEqual(want, Buffer.from(s.token, 'hex')) && hit < 0) hit = i;
    }
    if (hit < 0) return -1;
    if (expired(sessions[hit], now())) { revoke(hit); return -1; }
    if (touch) sessions[hit].lastUsed = now();
    return hit;
  }
  const revokeUser = (name) => { for (let i = 0; i < SESSION_MAX; i++) if (sessions[i] && sessions[i].user === name) revoke(i); };
  const alive = (slot, serial) => !!(sessions[slot] && sessions[slot].serial === serial && !expired(sessions[slot], now()));

  function issueTicket(slot) {
    if (!sessions[slot]) return null;
    tickets = tickets.filter(t => t.expires > now()).slice(-3);
    const ticket = crypto.randomBytes(16).toString('hex');
    tickets.push({ ticket, slot, serial: sessions[slot].serial, expires: now() + TICKET_MS });
    return ticket;
  }
  function redeemTicket(ticket) {
    const i = tickets.findIndex(t => t.ticket === ticket);
    if (i < 0) return null;
    const [t] = tickets.splice(i, 1);
    if (now() > t.expires || !alive(t.slot, t.serial)) return null;
    return { slot: t.slot, serial: t.serial };
  }

  // limiter (failures per fixed window)
  function slotOf(map, key, create) {
    const t = now();
    for (const [k, v] of map) if (t - v.start >= LIMIT_WINDOW_MS) map.delete(k);
    let s = map.get(key);
    if (!s && create) {
      if (map.size >= 8) { let oldest = null; for (const [k, v] of map) if (!oldest || v.start < map.get(oldest).start) oldest = k; map.delete(oldest); }
      s = { fails: 0, start: t }; map.set(key, s);
    }
    return s;
  }
  function allowed(ip, name) {
    const t = now();
    let wait = 0;
    if (global.fails && t - global.start >= LIMIT_WINDOW_MS) global.fails = 0;
    if (global.fails >= LIMIT_GLOBAL) wait = Math.ceil((LIMIT_WINDOW_MS - (t - global.start)) / 1000);
    const a = slotOf(ips, ip, false), b = slotOf(names, name, false);
    if (a && a.fails >= LIMIT_PER_IP) wait = Math.max(wait, Math.ceil((LIMIT_WINDOW_MS - (t - a.start)) / 1000));
    if (b && b.fails >= LIMIT_PER_USER) wait = Math.max(wait, Math.ceil((LIMIT_WINDOW_MS - (t - b.start)) / 1000));
    return wait;
  }
  function failure(ip, name) {
    if (!global.fails) global.start = now();
    global.fails++;
    slotOf(ips, ip, true).fails++;
    slotOf(names, name, true).fails++;
  }
  const success = (ip) => ips.delete(ip);

  return {
    enabled, users: () => users, find, add, remove, setRole, setPassword, verify,
    createSession, findSession, revoke, revokeUser, revokeAll: () => { for (let i = 0; i < SESSION_MAX; i++) revoke(i); },
    session: (slot) => sessions[slot], alive, issueTicket, redeemTicket,
    allowed, failure, success,
    resultStatus: RESULT_STATUS,
    clear: () => { users = []; sessions = []; tickets = []; ips = new Map(); names = new Map(); global = { fails: 0, start: 0 }; },
    sessionCount: () => sessions.filter(Boolean).length,
    permRoleName: (p) => PERM_ROLE[p] || 'admin',
  };
}

// Cookie / bearer parsing as web_auth.h does it
export function cookieValue(header, name) {
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const t = part.replace(/^[ \t]+/, '');
    if (t.startsWith(name + '=')) return t.slice(name.length + 1).replace(/[ \t]+$/, '');
  }
  return null;
}
export function bearerToken(header) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  const t = header.slice(7).trim();
  return t || null;
}
