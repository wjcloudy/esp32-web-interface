#pragma once
// Pure MQTT helpers: input cleaning, `get` batching and reply matching.
// No Arduino or network calls, so they build on the host against
// test/support's String shim (test/test_mqtt_logic).
#include <stdint.h>
#include <WString.h>
#include <math.h>
#include <stdlib.h>
#include <vector>

namespace mqttlogic {

static const unsigned int HOST_MAX = 64;
static const unsigned int USER_MAX = 64;
static const unsigned int PASS_MAX = 64;
static const unsigned int CLIENT_ID_MAX = 64;
static const unsigned int PREFIX_MAX = 64;
static const unsigned int NAMES_MAX = 480;
static const unsigned int INTERVAL_MIN = 1;
static const unsigned int INTERVAL_MAX = 3600;
// The inverter's terminal truncates commands beyond 128 chars, so keep each
// "get <names>" well inside that (the web UI uses the same limit)
static const unsigned int GET_CMD_MAX = 120;

inline bool isNameChar(char ch)
{
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') ||
         ch == '_' || ch == '.' || ch == '-';
}

// Keep characters valid in a spot value name (which are also safe as a topic
// level: no '+', '#' or '/'). Commas, spaces, semicolons and newlines become
// single commas; duplicate names are dropped; at most NAMES_MAX characters,
// cut at a whole name.
inline String sanitizeNames(const String& in)
{
  std::vector<String> seen;
  String out, cur;
  for (unsigned int i = 0; i <= in.length(); i++) {
    char ch = i < in.length() ? in[i] : ',';
    if (isNameChar(ch)) { cur += ch; continue; }
    if (ch != ',' && ch != ' ' && ch != ';' && ch != '\n' && ch != '\r' && ch != '\t') continue;
    if (!cur.length()) continue;
    bool dup = false;
    for (const String& s : seen) if (s == cur) { dup = true; break; }
    if (!dup && out.length() + (out.length() ? 1 : 0) + cur.length() <= NAMES_MAX) {
      if (out.length()) out += ',';
      out += cur;
      seen.push_back(cur);
    }
    cur = String();
  }
  return out;
}

// A publish topic prefix: printable ASCII without wildcards ('+', '#') or a
// trailing '/', at most PREFIX_MAX characters
inline String sanitizePrefix(const String& in)
{
  String out;
  for (unsigned int i = 0; i < in.length() && out.length() < PREFIX_MAX; i++) {
    char ch = in[i];
    if (ch == '+' || ch == '#' || (unsigned char)ch < 0x21 || (unsigned char)ch > 0x7e) continue;
    out += ch;
  }
  while (out.length() && out[out.length() - 1] == '/') out = out.substring(0, out.length() - 1);
  while (out.length() && out[0] == '/') out = out.substring(1);
  return out;
}

// Printable ASCII without spaces (host names, client IDs, user names)
inline String sanitizeToken(const String& in, unsigned int maxLen)
{
  String out;
  for (unsigned int i = 0; i < in.length() && out.length() < maxLen; i++) {
    char ch = in[i];
    if ((unsigned char)ch > 0x20 && (unsigned char)ch < 0x7f) out += ch;
  }
  return out;
}

// Any byte but control characters (passwords may contain spaces)
inline String sanitizeSecret(const String& in)
{
  String out;
  for (unsigned int i = 0; i < in.length() && out.length() < PASS_MAX; i++)
    if ((unsigned char)in[i] >= 0x20 && in[i] != 0x7f) out += in[i];
  return out;
}

inline unsigned int clampInterval(long v)
{
  return v < (long)INTERVAL_MIN ? INTERVAL_MIN : v > (long)INTERVAL_MAX ? INTERVAL_MAX : (unsigned int)v;
}

inline uint16_t clampPort(long v) { return (v > 0 && v < 65536) ? (uint16_t)v : 1883; }

// "homeassistant.local" → "homeassistant" (mDNS names never resolve through
// ordinary DNS); "" when the host isn't a .local name
inline String mdnsName(const String& host)
{
  static const char suffix[] = ".local";
  const unsigned int n = host.length(), m = sizeof(suffix) - 1;
  if (n <= m) return String();
  for (unsigned int i = 0; i < m; i++) {
    char ch = host[n - m + i];
    if (ch >= 'A' && ch <= 'Z') ch += 'a' - 'A';
    if (ch != suffix[i]) return String();
  }
  return host.substring(0, n - m);
}

inline std::vector<String> splitNames(const String& names)
{
  std::vector<String> out;
  String cur;
  for (unsigned int i = 0; i <= names.length(); i++) {
    char ch = i < names.length() ? names[i] : ',';
    if (ch == ',') { if (cur.length()) out.push_back(cur); cur = String(); }
    else cur += ch;
  }
  return out;
}

// Group names into batches whose "get a,b,c" stays within GET_CMD_MAX. A
// single name too long for a command on its own is dropped.
inline std::vector<std::vector<String>> batchNames(const std::vector<String>& names)
{
  std::vector<std::vector<String>> out;
  std::vector<String> cur;
  unsigned int len = 4; // "get "
  for (const String& n : names) {
    if (4 + n.length() > GET_CMD_MAX) continue;
    unsigned int add = n.length() + (cur.empty() ? 0 : 1);
    if (!cur.empty() && len + add > GET_CMD_MAX) { out.push_back(cur); cur.clear(); len = 4; add = n.length(); }
    cur.push_back(n);
    len += add;
  }
  if (!cur.empty()) out.push_back(cur);
  return out;
}

inline String joinNames(const std::vector<String>& names)
{
  String s;
  for (size_t i = 0; i < names.size(); i++) { if (i) s += ','; s += names[i]; }
  return s;
}

// A whole token that strtod accepts in full as a finite number (rejects
// "Unknown", "1.2abc", "", "nan", "inf")
inline bool isNumber(const String& t)
{
  if (!t.length()) return false;
  const char* s = t.c_str();
  char* end = nullptr;
  double v = strtod(s, &end);
  return end != s && *end == 0 && isfinite(v);
}

struct NamedValue { String name; String value; };

struct MatchResult {
  std::vector<NamedValue> values; // numeric replies, in request order
  std::vector<String> unknown;    // names whose reply line wasn't a number
  bool aligned = false;           // reply line count matched the request
};

// The inverter's UART answers "get a,b,c" with one line per name, in order:
// the value, or an error such as "Unknown parameter b". Pair each line with
// its name, so one bad name costs only its own value. If the line count
// doesn't match (a truncated or garbled reply), nothing is trusted.
inline MatchResult matchUartReply(const std::vector<String>& names, const String& reply)
{
  MatchResult r;
  std::vector<String> lines;
  String cur;
  for (unsigned int i = 0; i <= reply.length(); i++) {
    char ch = i < reply.length() ? reply[i] : '\n';
    if (ch == '\n') {
      // trim spaces, tabs and the CR of "\r\n"
      unsigned int a = 0, b = cur.length();
      while (a < b && (cur[a] == ' ' || cur[a] == '\t' || cur[a] == '\r')) a++;
      while (b > a && (cur[b - 1] == ' ' || cur[b - 1] == '\t' || cur[b - 1] == '\r')) b--;
      if (b > a) lines.push_back(cur.substring(a, b));
      cur = String();
    } else cur += ch;
  }
  if (lines.size() != names.size()) return r;
  r.aligned = true;
  for (size_t k = 0; k < names.size(); k++) {
    if (isNumber(lines[k])) r.values.push_back({ names[k], lines[k] });
    else r.unknown.push_back(names[k]);
  }
  return r;
}

// ---- settings.json fields (flat keys, as saveSettings writes them) ----

// Value of a quoted string field, honouring backslash escapes; "" if absent
inline String jsonStr(const String& json, const char* key)
{
  String pat = "\""; pat += key; pat += "\":\"";
  int i = json.indexOf(pat);
  if (i < 0) return String();
  String out;
  for (unsigned int p = i + pat.length(); p < json.length(); p++) {
    char ch = json[p];
    if (ch == '\\' && p + 1 < json.length()) {
      char e = json[++p];
      out += e == 'n' ? '\n' : e == 't' ? '\t' : e == 'r' ? '\r' : e;
    } else if (ch == '"') break;
    else out += ch;
  }
  return out;
}

inline long jsonNum(const String& json, const char* key, long def)
{
  String pat = "\""; pat += key; pat += "\":";
  int i = json.indexOf(pat);
  if (i < 0) return def;
  String rest = json.substring(i + pat.length());
  if (!rest.length() || !(rest[0] == '-' || (rest[0] >= '0' && rest[0] <= '9'))) return def;
  return rest.toInt();
}

inline bool jsonBool(const String& json, const char* key)
{
  String pat = "\""; pat += key; pat += "\":true";
  return json.indexOf(pat) >= 0;
}

// Topic for one value: "<prefix>/<name>"
inline String valueTopic(const String& prefix, const String& name) { String t = prefix; t += '/'; t += name; return t; }

} // namespace mqttlogic
