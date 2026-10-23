// Pure request/reply logic shared by the firmware and the native unit tests
// (test/test_web_logic). Nothing here touches hardware, the web server or
// globals, so it builds on the host against a small Arduino String shim.
// Everything here parses untrusted input (HTTP query strings, upload
// headers, settings files), so keep it bounds-checked and side-effect free.
#pragma once

#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <initializer_list>
#include <WString.h>

namespace weblogic {

// Escape a value for embedding in a JSON string literal: quotes and
// backslashes are escaped, control characters are dropped.
inline String jsonEscape(const String& s)
{
  String out;
  out.reserve(s.length() + 4);
  for (size_t i = 0; i < s.length(); i++) {
    char c = s[i];
    if (c == '"' || c == '\\') { out += '\\'; out += c; }
    else if ((uint8_t)c >= 0x20) out += c;
  }
  return out;
}

// Index of the ']' closing the JSON array whose '[' is at `open` (or before
// it), skipping brackets inside strings. -1 if unterminated or `open` < 0.
inline int findArrayEnd(const String& json, int open)
{
  if (open < 0) return -1;
  bool inStr = false;
  int depth = 0;
  for (unsigned int i = open; i < json.length(); i++) {
    char c = json[i];
    if (inStr) {
      if (c == '\\') i++;          // skip escaped char
      else if (c == '"') inStr = false;
    } else if (c == '"') inStr = true;
    else if (c == '[') depth++;
    else if (c == ']' && --depth == 0) return i;
  }
  return -1;
}

// Value of `key` in the query string of an HTTP request line
// ("GET /stream?names=a,b&ms=100 HTTP/1.1"). Matches whole keys only, so
// "ms" never picks up "xms=". Empty if absent.
inline String queryParam(const String& reqLine, const char* key)
{
  int q = reqLine.indexOf('?');
  if (q < 0) return "";
  int end = reqLine.indexOf(' ', q);
  if (end < 0) end = reqLine.length();
  String pat = String(key) + "=";
  int i = q + 1;
  while (i < end) {
    if (reqLine.substring(i, i + pat.length()) == pat) {
      int s = i + pat.length();
      int e = s;
      while (e < end && reqLine[e] != '&') e++;
      return reqLine.substring(s, e);
    }
    int amp = reqLine.indexOf('&', i);
    if (amp < 0 || amp >= end) break;
    i = amp + 1;
  }
  return "";
}

// The SSE stream turns its names into a "get" terminal command, so only
// spot-value-name characters are allowed: anything else could smuggle a
// second command or framing onto the UART.
static const unsigned int SSE_NAMES_MAX = 120;
inline bool sseNamesValid(const String& names)
{
  if (names.length() == 0 || names.length() > SSE_NAMES_MAX) return false;
  for (unsigned int i = 0; i < names.length(); i++) {
    unsigned char ch = (unsigned char)names[i];
    bool ok = (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') ||
              ch == '_' || ch == ',' || ch == '.' || ch == '-';
    if (!ok) return false;
  }
  return true;
}

// SSE refresh interval: <50 ms (or junk) falls back to 100, capped at 5 s
inline int sseIntervalMs(int ms)
{
  if (ms < 50) return 100;
  if (ms > 5000) return 5000;
  return ms;
}

// SPIFFS paths are rooted; the UI sends bare names
inline String normalizeFsPath(const String& path)
{
  if (path.startsWith("/")) return path;
  return "/" + path;
}

// /cmd repeat count: unclamped values could block the single-threaded
// server for minutes and grow the reply until the heap dies
static const int CMD_REPEAT_MAX = 100;
inline int clampRepeat(int repeat)
{
  if (repeat < 0) return 0;
  if (repeat > CMD_REPEAT_MAX) return CMD_REPEAT_MAX;
  return repeat;
}

// GPIO numbers from settings: garbage would persist and break the link at
// every boot. Required pins fall back to the build default; optional pins
// (allowUnused) accept -1 for "not used" and fall back to it.
static const int GPIO_MAX = 48;
inline int sanitizePin(int pin, int fallback, bool allowUnused = false)
{
  if (allowUnused) return (pin < -1 || pin > GPIO_MAX) ? -1 : pin;
  return (pin < 0 || pin > GPIO_MAX) ? fallback : pin;
}

// Combined OTA image header: "OIWEBOTA" + uint32 LE firmware length +
// uint32 LE filesystem length
static const size_t OTA_HEADER_LEN = 16;
enum OtaHeaderResult { OTA_HDR_OK = 0, OTA_HDR_BAD_MAGIC, OTA_HDR_BAD_LENGTH };
inline OtaHeaderResult parseOtaHeader(const uint8_t* hdr, uint32_t& fwLen, uint32_t& fsLen)
{
  static const char magic[8] = {'O','I','W','E','B','O','T','A'};
  fwLen = fsLen = 0;
  if (memcmp(hdr, magic, 8) != 0) return OTA_HDR_BAD_MAGIC;
  fwLen = (uint32_t)hdr[8] | ((uint32_t)hdr[9] << 8) | ((uint32_t)hdr[10] << 16) | ((uint32_t)hdr[11] << 24);
  fsLen = (uint32_t)hdr[12] | ((uint32_t)hdr[13] << 8) | ((uint32_t)hdr[14] << 16) | ((uint32_t)hdr[15] << 24);
  if (fwLen == 0 || fsLen == 0) return OTA_HDR_BAD_LENGTH;
  return OTA_HDR_OK;
}

// Collect one terminal reply (plus `repeat` repetitions triggered with "!")
// from the inverter UART. Port provides:
//   int  readChunk(char* buf, size_t size, Tick firstByteTimeout)
//        — a chunk that starts within the timeout and ends on line silence;
//          <= 0 if nothing arrived
//   void triggerRepeat()  — send "!" and consume its echo
// The long timeout applies only while waiting for a reply (or repetition)
// to start; once bytes flow, the idle timeout ends it.
template <typename Port, typename Tick>
inline String readReply(Port& port, int repeat, Tick replyTimeout, Tick idleTimeout)
{
  String output;
  char buffer[255];
  int rpt = repeat;
  int len;
  Tick wait = replyTimeout;
  do {
    len = port.readChunk(buffer, sizeof(buffer), wait);
    if (len > 0) output.concat(buffer, len);
    wait = idleTimeout;
    if (rpt) {
      rpt--;
      port.triggerRepeat();
      wait = replyTimeout;
    }
  } while (len > 0);
  return output;
}

// ======================= Users & permissions =======================
// Who may do what. Roles follow homestead's viewer < operator < admin:
//   viewer   — read-only: values, parameters, plots, gauges, files list
//   operator — viewer + every write that drives the inverter: set/save/
//              start/stop, CAN mapping, layout and data files
//   admin    — operator + users, WiFi/device settings, firmware updates,
//              ESP reboot, and the web UI's own files
// With no users configured authentication is off and everything stays open
// (exactly the old behaviour); the firmware enforces this table, the UI
// only mirrors it.
enum Role : uint8_t { ROLE_NONE = 0, ROLE_VIEWER = 1, ROLE_OPERATOR = 2, ROLE_ADMIN = 3 };

// What a request needs. READ/WRITE/ADMIN line up with the roles' ranks.
// CMD and FILE are resolved per request (the terminal command, the file
// path), DENY is never allowed, not even to an admin.
enum Perm : uint8_t {
  PERM_PUBLIC = 0, PERM_READ = 1, PERM_WRITE = 2, PERM_ADMIN = 3,
  PERM_DENY = 4, PERM_CMD = 5, PERM_FILE = 6,
};

inline bool roleAllows(Role role, Perm need)
{
  if (need == PERM_PUBLIC) return true;
  if (need > PERM_ADMIN) return false; // DENY, or an unresolved CMD/FILE
  return (uint8_t)role >= (uint8_t)need;
}

inline const char* roleName(Role r)
{
  switch (r) {
    case ROLE_VIEWER: return "viewer";
    case ROLE_OPERATOR: return "operator";
    case ROLE_ADMIN: return "admin";
    default: return "none";
  }
}

inline Role roleFromName(const char* s)
{
  if (!s) return ROLE_NONE;
  if (strcmp(s, "viewer") == 0) return ROLE_VIEWER;
  if (strcmp(s, "operator") == 0) return ROLE_OPERATOR;
  if (strcmp(s, "admin") == 0) return ROLE_ADMIN;
  return ROLE_NONE;
}

// The role a permission level needs, for "needs operator" style replies
inline const char* permRoleName(Perm p)
{
  return p == PERM_READ ? "viewer" : p == PERM_WRITE ? "operator" : "admin";
}

// Request methods as the route table sees them (bit flags)
enum MethodBit : uint8_t { M_GET = 1, M_POST = 2, M_PUT = 4, M_DELETE = 8, M_OTHER = 16, M_ANY = 31 };

struct RouteRule { const char* path; uint8_t methods; Perm perm; };

// Every endpoint the firmware serves on port 80, and what it needs. The
// firmware registers handlers only through this table (route() refuses a
// path missing here), and tests/e2e/mock-contract.spec.mjs checks that the
// mock ESP enforces the same table. Anything not listed is a static file
// (staticPerm below).
static const RouteRule ROUTES[] = {
  // --- sign-in: public by necessity (the handlers do their own checks)
  { "/auth/state",          M_GET,           PERM_PUBLIC },
  { "/auth/login",          M_POST,          PERM_PUBLIC },
  { "/auth/logout",         M_POST,          PERM_PUBLIC },
  { "/auth/password",       M_POST,          PERM_READ },   // own password: any signed-in user
  { "/auth/stream-ticket",  M_GET,           PERM_READ },
  { "/auth/users",          M_GET | M_POST,  PERM_ADMIN },
  // --- terminal: classified per command (cmdPerm)
  { "/cmd",                 M_ANY,           PERM_CMD },
  // --- reads
  { "/list",                M_GET,           PERM_READ },
  { "/rtc/now",             M_GET,           PERM_READ },
  { "/sdcard/list",         M_GET,           PERM_READ },
  { "/espupdate-status",    M_GET,           PERM_READ },
  { "/wifi-status",         M_GET,           PERM_READ },
  { "/fwupdate-status",     M_ANY,           PERM_READ },
  { "/baud",                M_ANY,           PERM_READ },
  { "/version",             M_ANY,           PERM_READ },
  { "/otainfo",             M_ANY,           PERM_READ },
  { "/settings",            M_GET,           PERM_READ },
  { "/favorites.json",      M_ANY,           PERM_READ },
  { "/gauges.json",         M_ANY,           PERM_READ },
  { "/plots.json",          M_ANY,           PERM_READ },
  { "/virtualvals.json",    M_ANY,           PERM_READ },
  { "/edit",                M_GET,           PERM_READ },   // the editor page
  // --- operator: drive the inverter, its CAN bus and the data files
  { "/edit",                M_PUT | M_DELETE | M_POST, PERM_FILE }, // filePerm per path
  { "/rtc/set",             M_POST,          PERM_WRITE },
  { "/sdcard/deleteAll",    M_GET,           PERM_WRITE },
  { "/reset-inverter",      M_ANY,           PERM_WRITE },
  { "/can-send",            M_ANY,           PERM_WRITE },
  { "/can-scan",            M_ANY,           PERM_WRITE },
  { "/can-debug",           M_ANY,           PERM_WRITE },  // resets the device
  { "/set-can-node",        M_ANY,           PERM_WRITE },
  { "/virtual-reload",      M_ANY,           PERM_WRITE },
  // --- admin: the device itself
  { "/settings",            M_POST,          PERM_ADMIN },
  { "/wifi",                M_ANY,           PERM_ADMIN },
  { "/espupdate",           M_POST,          PERM_ADMIN },
  { "/espupdate-url",       M_POST,          PERM_ADMIN },
  { "/update",              M_GET | M_POST,  PERM_ADMIN },
  { "/fwupdate",            M_ANY,           PERM_ADMIN },
  { "/can-fwupdate",        M_ANY,           PERM_ADMIN },
  { "/reboot",              M_ANY,           PERM_ADMIN },
};
static const size_t ROUTE_COUNT = sizeof(ROUTES) / sizeof(ROUTES[0]);

// The rule for (method, path), or nullptr when no route serves it. Exact
// path match, like the WebServer's own handler lookup.
inline const RouteRule* findRoute(uint8_t method, const char* path)
{
  if (!path) return nullptr;
  for (size_t i = 0; i < ROUTE_COUNT; i++)
    if ((ROUTES[i].methods & method) && strcmp(ROUTES[i].path, path) == 0) return &ROUTES[i];
  return nullptr;
}

// True if any method of `path` is in the table (route registration check)
inline bool routeKnown(const char* path, uint8_t methods)
{
  if (!path) return false;
  uint8_t covered = 0;
  for (size_t i = 0; i < ROUTE_COUNT; i++)
    if (strcmp(ROUTES[i].path, path) == 0) covered |= ROUTES[i].methods;
  return (covered & methods) == methods;
}

inline bool endsWith(const char* s, size_t n, const char* suffix)
{
  size_t m = strlen(suffix);
  return n >= m && memcmp(s + n - m, suffix, m) == 0;
}

// The web UI's own files: public, so the sign-in page can load, and admin-
// only to replace (an operator who could rewrite app.js could act as any
// admin who next opens the page). A trailing ".gz" is ignored: the static
// handler prefers path + ".gz", so "/app.js.gz" IS app.js.
inline bool isUiAsset(const char* path)
{
  if (!path || path[0] != '/') return false;
  size_t n = strlen(path);
  if (endsWith(path, n, ".gz")) n -= 3;
  if (n == 1) return true; // "/" = index.html
  // The Parameters tab's database subscription is stored as a .js file but
  // is data (it holds an openinverter.org token), not part of the UI
  if (n == 16 && memcmp(path, "/subscription.js", 16) == 0) return false;
  // Pictures uploaded for image tiles ("/img-<name>.png") are layout data,
  // so an operator can add them. Raster formats only: a same-origin SVG can
  // run script, so "/img-x.svg" stays the UI's
  if (n > 5 && memcmp(path, "/img-", 5) == 0) {
    static const char* const img[] = { ".png", ".jpg", ".jpeg", ".webp", ".gif" };
    for (size_t i = 0; i < sizeof(img) / sizeof(img[0]); i++)
      if (n > 5 + strlen(img[i]) && endsWith(path, n, img[i])) return false; // a name, not just "/img-.png"
  }
  static const char* const exts[] = { ".html", ".htm", ".js", ".mjs", ".css", ".svg", ".png", ".ico",
                                      ".jpg", ".jpeg", ".gif", ".woff", ".woff2", ".webmanifest" };
  for (size_t i = 0; i < sizeof(exts) / sizeof(exts[0]); i++)
    if (endsWith(path, n, exts[i])) return true;
  return n == strlen("/manifest.json") && memcmp(path, "/manifest.json", n) == 0;
}

// Reading a file through the static handler (onNotFound): UI assets are
// public, everything else (layouts, logs, uploads, SD card) needs a viewer.
// ".." and control characters are refused outright.
inline Perm staticPerm(const char* path)
{
  if (!path || path[0] != '/') return PERM_DENY;
  for (const char* c = path; *c; c++) if ((uint8_t)*c < 0x20 || *c == '\\') return PERM_DENY;
  if (strstr(path, "..")) return PERM_DENY;
  return isUiAsset(path) ? PERM_PUBLIC : PERM_READ;
}

// Creating, overwriting or deleting a SPIFFS file (/edit): data files are
// an operator's, the UI's own files and the settings file an admin's.
inline Perm filePerm(const char* rawPath)
{
  if (!rawPath || !rawPath[0]) return PERM_WRITE; // handler answers BAD ARGS
  char path[72];
  size_t n = strlen(rawPath);
  if (n > sizeof(path) - 2) return PERM_ADMIN; // longer than SPIFFS allows: be strict
  path[0] = '/';
  memcpy(path + (rawPath[0] == '/' ? 0 : 1), rawPath, n + 1); // normalizeFsPath
  for (const char* c = path; *c; c++) if ((uint8_t)*c < 0x20) return PERM_DENY;
  if (isUiAsset(path)) return PERM_ADMIN;
  if (strcmp(path, "/settings.json") == 0 || strcmp(path, "/settings.json.gz") == 0) return PERM_ADMIN;
  return PERM_WRITE;
}

// A spot value / parameter name list as `get` takes it ("udc,tmphs")
inline bool cmdNamesValid(const char* s, size_t n)
{
  if (n == 0) return false;
  for (size_t i = 0; i < n; i++) {
    unsigned char ch = (unsigned char)s[i];
    bool ok = (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') ||
              ch == '_' || ch == ',' || ch == '.' || ch == '-';
    if (!ok) return false;
  }
  return true;
}

// Terminal commands (/cmd, UART and CAN mode alike) a viewer may run: an
// ALLOWLIST of reads, with their arguments checked too. Everything else —
// set, save, load, defaults, start, stop, reset, can tx/rx/rm/clear,
// fastuart, binarylogging, unknown commands, anything with a control
// character that could put a second command on the UART — needs an operator.
// Classify the string that will actually be executed (after truncation).
inline Perm cmdPerm(const char* cmd)
{
  if (!cmd) return PERM_WRITE;
  size_t n = strlen(cmd);
  if (n == 0) return PERM_WRITE;
  for (size_t i = 0; i < n; i++) {
    unsigned char ch = (unsigned char)cmd[i];
    if (ch < 0x20 || ch > 0x7e) return PERM_WRITE;
  }
  // Split "verb rest"; a single space separates the verb, no padding allowed
  const char* sp = strchr(cmd, ' ');
  size_t vlen = sp ? (size_t)(sp - cmd) : n;
  const char* rest = sp ? sp + 1 : cmd + n;
  size_t rlen = n - (rest - cmd);
  auto verbIs = [&](const char* v) { return strlen(v) == vlen && memcmp(cmd, v, vlen) == 0; };
  auto restIs = [&](const char* v) { return strlen(v) == rlen && memcmp(rest, v, rlen) == 0; };

  if (verbIs("json")) return (!sp || restIs("hidden")) ? PERM_READ : PERM_WRITE;
  if (verbIs("errors") || verbIs("serial") || verbIs("help")) return sp ? PERM_WRITE : PERM_READ;
  if (verbIs("get")) return (sp && cmdNamesValid(rest, rlen)) ? PERM_READ : PERM_WRITE;
  if (verbIs("stream")) {
    // stream <1..100> <names>: bounded, so a viewer can't tie up the UART
    if (!sp) return PERM_WRITE;
    const char* sp2 = (const char*)memchr(rest, ' ', rlen);
    if (!sp2) return PERM_WRITE;
    size_t nlen = sp2 - rest;
    if (nlen == 0 || nlen > 3) return PERM_WRITE;
    int count = 0;
    for (size_t i = 0; i < nlen; i++) {
      if (rest[i] < '0' || rest[i] > '9') return PERM_WRITE;
      count = count * 10 + (rest[i] - '0');
    }
    if (count < 1 || count > 100) return PERM_WRITE;
    return cmdNamesValid(sp2 + 1, rlen - nlen - 1) ? PERM_READ : PERM_WRITE;
  }
  if (verbIs("can")) return (restIs("list") || restIs("print")) ? PERM_READ : PERM_WRITE;
  return PERM_WRITE;
}

// The hostname part of an Origin ("http://host:port") or Host ("host:port")
// value, lower-cased into out. False if it doesn't parse.
inline bool hostPart(const char* v, char* out, size_t outSize)
{
  if (!v || !out || outSize < 2) return false;
  const char* s = strstr(v, "://");
  s = s ? s + 3 : v;
  size_t i = 0;
  if (*s == '[') { // IPv6 literal
    while (*s && *s != ']' && i < outSize - 2) out[i++] = *s++;
    if (*s != ']') return false;
    out[i++] = *s++;
  } else {
    while (*s && *s != ':' && *s != '/' && i < outSize - 1) {
      char c = *s++;
      out[i++] = (c >= 'A' && c <= 'Z') ? c + 32 : c;
    }
    if (*s && *s != ':' && *s != '/') return false; // too long
  }
  out[i] = 0;
  return i > 0;
}

// Non-empty, printable ASCII without spaces: safe to echo back into a
// response header (no CR/LF injection)
inline bool printableNoSpace(const char* s)
{
  if (!s || !*s) return false;
  for (; *s; s++) if ((uint8_t)*s <= 0x20 || (uint8_t)*s >= 0x7f) return false;
  return true;
}

// Same host, any port: an EventSource on the SSE port (81) comes from the
// page on port 80 of the same device
inline bool originHostMatches(const char* origin, const char* host)
{
  char a[72], b[72];
  if (!hostPart(origin, a, sizeof(a)) || !hostPart(host, b, sizeof(b))) return false;
  return strcmp(a, b) == 0;
}

// Cross-site request check for state-changing requests while sign-in is on
// (the session cookie is SameSite=Strict as well; this is the second lock,
// as homestead's X-Homestead-Auth header is). Passes when:
//   - the credential is a bearer token (never sent by a browser on its own);
//   - Origin, when present, is exactly this host (scheme + Host header);
//   - otherwise the UI's X-OI-Auth: 1 header (a cross-site form can't set
//     it, and cross-origin fetch would need a preflight we never approve),
//     or a Referer from this host.
inline bool csrfOk(bool bearer, const char* origin, const char* referer, const char* xAuth, const char* host)
{
  if (bearer) return true;
  if (!host || !host[0]) return false;
  char expect[96];
  if (origin && origin[0]) {
    for (const char* scheme : { "http://", "https://" }) {
      size_t sl = strlen(scheme), hl = strlen(host);
      if (sl + hl + 1 > sizeof(expect)) return false;
      memcpy(expect, scheme, sl);
      memcpy(expect + sl, host, hl + 1);
      if (strcmp(origin, expect) == 0) return true;
    }
    return false;
  }
  if (xAuth && strcmp(xAuth, "1") == 0) return true;
  if (referer && referer[0]) {
    for (const char* scheme : { "http://", "https://" }) {
      size_t sl = strlen(scheme), hl = strlen(host);
      if (sl + hl + 2 > sizeof(expect)) return false;
      memcpy(expect, scheme, sl);
      memcpy(expect + sl, host, hl);
      expect[sl + hl] = '/';
      expect[sl + hl + 1] = 0;
      if (strncmp(referer, expect, sl + hl + 1) == 0) return true;
    }
  }
  return false;
}

// ---- Config files kept across OTA updates ---------------------------------
// A web-interface OTA rewrites the whole SPIFFS partition, which used to wipe
// the device config with it (UART/CAN pins: the ESP then stopped talking to
// the inverter). These small files are mirrored into NVS, which OTA leaves
// alone, and written back at boot if missing. Large UI layouts don't fit
// NVS; the UI stashes and restores those around an update instead.
static const size_t CFG_MIRROR_MAX = 3800; // well under one NVS entry/page
struct CfgMirrorFile { const char* path; const char* nvsKey; };
static const CfgMirrorFile CFG_MIRRORED[] = {
  { "/settings.json", "settings" },
  { "/uiprefs.json", "uiprefs" },
};

// NVS key for a mirrored file, or nullptr if the path isn't mirrored.
// Accepts paths with or without the leading '/'.
inline const char* cfgNvsKey(const char* path)
{
  if (!path) return nullptr;
  for (const CfgMirrorFile& f : CFG_MIRRORED) {
    if (strcmp(path, f.path) == 0 || strcmp(path, f.path + 1) == 0) return f.nvsKey;
  }
  return nullptr;
}

enum CfgSyncAction { CFG_SYNC_NONE, CFG_SYNC_SAVE_TO_NVS, CFG_SYNC_RESTORE_FILE };

// Boot-time decision for one mirrored file. The file wins when present, so
// a backup restored through the Files tab (or an older firmware's file)
// becomes the kept copy; NVS only fills in a file the update erased.
inline CfgSyncAction cfgSyncAction(bool fileExists, size_t fileLen, bool nvsHas, bool sameAsNvs)
{
  if (fileExists) {
    if (fileLen == 0 || fileLen > CFG_MIRROR_MAX) return CFG_SYNC_NONE;
    return sameAsNvs ? CFG_SYNC_NONE : CFG_SYNC_SAVE_TO_NVS;
  }
  return nvsHas ? CFG_SYNC_RESTORE_FILE : CFG_SYNC_NONE;
}

} // namespace weblogic
