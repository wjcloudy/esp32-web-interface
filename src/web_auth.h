// User accounts, password hashing, sessions and the sign-in rate limiter.
// Pure logic like web_logic.h: no hardware, no globals, no web server —
// time comes in as a millisecond counter and randomness through a fill
// function, so the native tests (test/test_web_auth) drive it directly.
//
// Design (after homestead's homestead_auth.py, scaled to an ESP32):
//  * Passwords: PBKDF2-HMAC-SHA256, 16-byte random salt per user, iteration
//    count stored per user (so the default can change without breaking old
//    hashes). Plaintext is never stored. Verification always runs the full
//    KDF, also for unknown names, so timing doesn't reveal which names exist.
//  * Sessions: 32 random bytes (hardware RNG on the device), kept in RAM.
//    A reboot signs everyone out. Idle and absolute expiry; each session
//    remembers the user's generation number, which every password or role
//    change and every removal bumps — so those end the user's sessions at
//    once. The role is read from the user table on every request, never
//    from the session.
//  * Sign-in attempts: limited per client address, per user name and
//    globally (each attempt costs a few hundred ms of the single-threaded
//    server, so the global cap also bounds that).
#pragma once

#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include "web_logic.h"

namespace weblogic {

// ---------------------------------------------------------------- SHA-256
struct Sha256 {
  uint32_t h[8];
  uint8_t buf[64];
  uint64_t total;
  size_t used;

  static uint32_t rotr(uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }

  void init()
  {
    static const uint32_t iv[8] = { 0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                                    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19 };
    memcpy(h, iv, sizeof(h));
    total = 0;
    used = 0;
  }

  void block(const uint8_t* p)
  {
    static const uint32_t k[64] = {
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2 };
    uint32_t w[64];
    for (int i = 0; i < 16; i++)
      w[i] = ((uint32_t)p[i * 4] << 24) | ((uint32_t)p[i * 4 + 1] << 16) | ((uint32_t)p[i * 4 + 2] << 8) | p[i * 4 + 3];
    for (int i = 16; i < 64; i++) {
      uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
      uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (int i = 0; i < 64; i++) {
      uint32_t S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      uint32_t ch = (e & f) ^ (~e & g);
      uint32_t t1 = hh + S1 + ch + k[i] + w[i];
      uint32_t S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      uint32_t mj = (a & b) ^ (a & c) ^ (b & c);
      uint32_t t2 = S0 + mj;
      hh = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }

  void update(const uint8_t* data, size_t len)
  {
    total += len;
    while (len) {
      size_t take = 64 - used < len ? 64 - used : len;
      memcpy(buf + used, data, take);
      used += take; data += take; len -= take;
      if (used == 64) { block(buf); used = 0; }
    }
  }

  void finish(uint8_t out[32])
  {
    uint64_t bits = total * 8;
    uint8_t pad = 0x80;
    update(&pad, 1);
    uint8_t zero = 0;
    while (used != 56) update(&zero, 1);
    uint8_t len[8];
    for (int i = 0; i < 8; i++) len[i] = (uint8_t)(bits >> (56 - 8 * i));
    update(len, 8);
    for (int i = 0; i < 8; i++) {
      out[i * 4] = (uint8_t)(h[i] >> 24); out[i * 4 + 1] = (uint8_t)(h[i] >> 16);
      out[i * 4 + 2] = (uint8_t)(h[i] >> 8); out[i * 4 + 3] = (uint8_t)h[i];
    }
  }
};

// HMAC-SHA256 with the key's inner/outer states precomputed, so each PBKDF2
// iteration costs two compressions instead of four
struct HmacSha256 {
  Sha256 inner, outer;

  void init(const uint8_t* key, size_t keyLen)
  {
    uint8_t k[64];
    memset(k, 0, sizeof(k));
    if (keyLen > 64) { Sha256 s; s.init(); s.update(key, keyLen); s.finish(k); }
    else memcpy(k, key, keyLen);
    uint8_t pad[64];
    for (int i = 0; i < 64; i++) pad[i] = k[i] ^ 0x36;
    inner.init(); inner.update(pad, 64);
    for (int i = 0; i < 64; i++) pad[i] = k[i] ^ 0x5c;
    outer.init(); outer.update(pad, 64);
    memset(k, 0, sizeof(k));
  }

  // MAC of one message using the precomputed key states
  void mac(const uint8_t* msg, size_t len, uint8_t out[32]) const
  {
    Sha256 i = inner; i.update(msg, len);
    uint8_t ih[32]; i.finish(ih);
    Sha256 o = outer; o.update(ih, 32); o.finish(out);
  }
};

// PBKDF2-HMAC-SHA256 (RFC 8018) producing outLen bytes (any length)
inline void pbkdf2Sha256(const uint8_t* pw, size_t pwLen, const uint8_t* salt, size_t saltLen,
                         uint32_t iterations, uint8_t* out, size_t outLen)
{
  HmacSha256 prf;
  prf.init(pw, pwLen);
  uint8_t msg[64 + 4];
  if (saltLen > 64) saltLen = 64; // our salts are 16 bytes; cap keeps msg on the stack
  memcpy(msg, salt, saltLen);
  for (uint32_t blockNo = 1; outLen; blockNo++) {
    msg[saltLen] = (uint8_t)(blockNo >> 24); msg[saltLen + 1] = (uint8_t)(blockNo >> 16);
    msg[saltLen + 2] = (uint8_t)(blockNo >> 8); msg[saltLen + 3] = (uint8_t)blockNo;
    uint8_t u[32], t[32];
    prf.mac(msg, saltLen + 4, u);
    memcpy(t, u, 32);
    for (uint32_t i = 1; i < iterations; i++) {
      prf.mac(u, 32, u);
      for (int j = 0; j < 32; j++) t[j] ^= u[j];
    }
    size_t take = outLen < 32 ? outLen : 32;
    memcpy(out, t, take);
    out += take; outLen -= take;
  }
}

// --------------------------------------------------------------- helpers
// Compare without an early exit, so timing says nothing about where the
// first difference is
inline bool ctEqual(const uint8_t* a, const uint8_t* b, size_t n)
{
  uint8_t d = 0;
  for (size_t i = 0; i < n; i++) d |= a[i] ^ b[i];
  return d == 0;
}

inline void toHex(const uint8_t* in, size_t n, char* out)
{
  static const char* digits = "0123456789abcdef";
  for (size_t i = 0; i < n; i++) { out[i * 2] = digits[in[i] >> 4]; out[i * 2 + 1] = digits[in[i] & 15]; }
  out[n * 2] = 0;
}

inline int hexNibble(char c)
{
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

// Exactly n bytes of hex (2n chars, then end or a non-hex terminator)
inline bool fromHex(const char* s, size_t sLen, uint8_t* out, size_t n)
{
  if (!s || sLen != n * 2) return false;
  for (size_t i = 0; i < n; i++) {
    int hi = hexNibble(s[i * 2]), lo = hexNibble(s[i * 2 + 1]);
    if (hi < 0 || lo < 0) return false;
    out[i] = (uint8_t)((hi << 4) | lo);
  }
  return true;
}

// Value of cookie `name` in a Cookie header ("a=1; oisess=abc; b=2") into
// out; false if absent or longer than out
inline bool cookieValue(const char* header, const char* name, char* out, size_t outSize)
{
  if (!header || !name || !out || outSize == 0) return false;
  size_t nl = strlen(name);
  const char* p = header;
  while (*p) {
    while (*p == ' ' || *p == '\t' || *p == ';') p++;
    const char* start = p;
    while (*p && *p != ';') p++;
    size_t len = p - start;
    if (len > nl && memcmp(start, name, nl) == 0 && start[nl] == '=') {
      size_t vl = len - nl - 1;
      while (vl && (start[nl + 1 + vl - 1] == ' ' || start[nl + 1 + vl - 1] == '\t')) vl--;
      if (vl >= outSize) return false;
      memcpy(out, start + nl + 1, vl);
      out[vl] = 0;
      return true;
    }
  }
  return false;
}

// The token of an "Authorization: Bearer <token>" header into out
inline bool bearerToken(const char* header, char* out, size_t outSize)
{
  if (!header || !out || outSize == 0) return false;
  static const char pfx[] = "Bearer ";
  if (strncmp(header, pfx, sizeof(pfx) - 1) != 0) return false;
  const char* t = header + sizeof(pfx) - 1;
  while (*t == ' ') t++;
  size_t n = strlen(t);
  while (n && t[n - 1] == ' ') n--;
  if (n == 0 || n >= outSize) return false;
  memcpy(out, t, n);
  out[n] = 0;
  return true;
}

// User names: 1-32 of a-z 0-9 . _ - (lower-cased by the caller; no spaces
// or separators, so the stored line format can't be broken)
static const size_t USER_NAME_MAX = 32;
inline bool userNameValid(const char* s)
{
  if (!s) return false;
  size_t n = strlen(s);
  if (n == 0 || n > USER_NAME_MAX) return false;
  for (size_t i = 0; i < n; i++) {
    char c = s[i];
    bool ok = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-';
    if (!ok) return false;
  }
  return true;
}

// Passwords: 8-64 bytes, no control characters (any other byte is fine,
// UTF-8 included). Homestead asks for 10; 8 is the floor that stays usable
// on a phone keyboard in a garage — admins can of course pick longer ones.
static const size_t PASSWORD_MIN = 8, PASSWORD_MAX = 64;
inline bool passwordValid(const char* s)
{
  if (!s) return false;
  size_t n = strlen(s);
  if (n < PASSWORD_MIN || n > PASSWORD_MAX) return false;
  for (size_t i = 0; i < n; i++) if ((uint8_t)s[i] < 0x20 || (uint8_t)s[i] == 0x7f) return false;
  return true;
}

typedef void (*RandomFill)(uint8_t* buf, size_t len);

// ----------------------------------------------------------------- users
static const size_t USER_MAX = 8;
static const size_t SALT_LEN = 16, HASH_LEN = 32;
static const uint32_t KDF_ITER_MIN = 1, KDF_ITER_MAX = 1000000;

struct User {
  char name[USER_NAME_MAX + 1];
  Role role;
  uint32_t iterations;
  uint8_t salt[SALT_LEN];
  uint8_t hash[HASH_LEN];
  uint32_t gen; // bumped on every password/role change: ends that user's sessions
};

enum UserResult {
  USER_OK = 0, USER_BAD_NAME, USER_BAD_PASSWORD, USER_BAD_ROLE, USER_EXISTS, USER_FULL,
  USER_NOT_FOUND, USER_LAST_ADMIN, USER_SELF, USER_FIRST_MUST_BE_ADMIN,
};

inline const char* userResultText(UserResult r)
{
  switch (r) {
    case USER_OK: return "ok";
    case USER_BAD_NAME: return "user name must be 1-32 characters: a-z 0-9 . _ -";
    case USER_BAD_PASSWORD: return "password must be 8-64 characters";
    case USER_BAD_ROLE: return "role must be viewer, operator or admin";
    case USER_EXISTS: return "that user already exists";
    case USER_FULL: return "no room for more users (8 at most)";
    case USER_NOT_FOUND: return "no such user";
    case USER_LAST_ADMIN: return "the last admin cannot be removed or demoted";
    case USER_SELF: return "you cannot remove or demote your own account";
    case USER_FIRST_MUST_BE_ADMIN: return "the first user must be an admin";
  }
  return "error";
}

struct UserStore {
  User users[USER_MAX];
  size_t count = 0;
  uint32_t iterations = 10000; // for new hashes; see AUTH_PBKDF2_ITERATIONS in the firmware
  RandomFill rng = nullptr;

  int find(const char* name) const
  {
    if (!name) return -1;
    for (size_t i = 0; i < count; i++) if (strcmp(users[i].name, name) == 0) return (int)i;
    return -1;
  }

  size_t adminCount() const
  {
    size_t n = 0;
    for (size_t i = 0; i < count; i++) if (users[i].role == ROLE_ADMIN) n++;
    return n;
  }

  void setPasswordOf(User& u, const char* pw)
  {
    u.iterations = iterations;
    rng(u.salt, SALT_LEN);
    pbkdf2Sha256((const uint8_t*)pw, strlen(pw), u.salt, SALT_LEN, u.iterations, u.hash, HASH_LEN);
  }

  UserResult add(const char* name, const char* pw, Role role)
  {
    if (!userNameValid(name)) return USER_BAD_NAME;
    if (!passwordValid(pw)) return USER_BAD_PASSWORD;
    if (role < ROLE_VIEWER || role > ROLE_ADMIN) return USER_BAD_ROLE;
    if (count == 0 && role != ROLE_ADMIN) return USER_FIRST_MUST_BE_ADMIN;
    if (find(name) >= 0) return USER_EXISTS;
    if (count >= USER_MAX) return USER_FULL;
    User& u = users[count];
    memset(&u, 0, sizeof(u));
    strncpy(u.name, name, USER_NAME_MAX);
    u.role = role;
    u.gen = 1;
    setPasswordOf(u, pw);
    count++;
    return USER_OK;
  }

  // `actor` is who asks (nullptr for the recovery path / tests)
  UserResult remove(const char* name, const char* actor)
  {
    int i = find(name);
    if (i < 0) return USER_NOT_FOUND;
    if (actor && strcmp(actor, name) == 0) return USER_SELF;
    if (users[i].role == ROLE_ADMIN && adminCount() == 1) return USER_LAST_ADMIN;
    for (size_t j = i; j + 1 < count; j++) users[j] = users[j + 1];
    count--;
    memset(&users[count], 0, sizeof(User));
    return USER_OK;
  }

  // Every account gone (hashes wiped too): sign-in off, as on a fresh
  // device. For the recovery paths and an admin's "turn off sign-in"; the
  // caller checks who may do it.
  void clear()
  {
    memset(users, 0, sizeof(users));
    count = 0;
  }

  UserResult setRole(const char* name, Role role, const char* actor)
  {
    int i = find(name);
    if (i < 0) return USER_NOT_FOUND;
    if (role < ROLE_VIEWER || role > ROLE_ADMIN) return USER_BAD_ROLE;
    if (users[i].role == role) return USER_OK;
    if (actor && strcmp(actor, name) == 0) return USER_SELF;
    if (users[i].role == ROLE_ADMIN && adminCount() == 1) return USER_LAST_ADMIN;
    users[i].role = role;
    users[i].gen++;
    return USER_OK;
  }

  UserResult setPassword(const char* name, const char* pw)
  {
    int i = find(name);
    if (i < 0) return USER_NOT_FOUND;
    if (!passwordValid(pw)) return USER_BAD_PASSWORD;
    setPasswordOf(users[i], pw);
    users[i].gen++;
    return USER_OK;
  }

  // Full KDF even for unknown names (against a fixed dummy salt) so a
  // wrong name costs the same time as a wrong password. Index or -1.
  int verify(const char* name, const char* pw) const
  {
    static const uint8_t dummySalt[SALT_LEN] = { 0 };
    int i = find(name);
    const uint8_t* salt = i >= 0 ? users[i].salt : dummySalt;
    uint32_t iter = i >= 0 ? users[i].iterations : iterations;
    uint8_t calc[HASH_LEN];
    size_t pwLen = pw ? strlen(pw) : 0;
    if (pwLen > PASSWORD_MAX) pwLen = PASSWORD_MAX; // bound the work an attacker can ask for
    pbkdf2Sha256((const uint8_t*)(pw ? pw : ""), pwLen, salt, SALT_LEN, iter, calc, HASH_LEN);
    bool ok = i >= 0 && ctEqual(calc, users[i].hash, HASH_LEN);
    return ok ? i : -1;
  }

  // Stored form (NVS string, never served over HTTP): a version line, then
  // one line per user: name role iterations salthex hashhex gen
  size_t serializedSize() const { return 4 + count * 200; }

  // Writes into out (outSize >= serializedSize()); returns length
  size_t serialize(char* out, size_t outSize) const
  {
    size_t n = 0;
    auto put = [&](const char* s) { size_t l = strlen(s); if (n + l < outSize) { memcpy(out + n, s, l); n += l; } };
    put("v1\n");
    for (size_t i = 0; i < count; i++) {
      const User& u = users[i];
      char num[16], hex[HASH_LEN * 2 + 1];
      put(u.name); put(" "); put(roleName(u.role)); put(" ");
      snprintfU(num, u.iterations); put(num); put(" ");
      toHex(u.salt, SALT_LEN, hex); put(hex); put(" ");
      toHex(u.hash, HASH_LEN, hex); put(hex); put(" ");
      snprintfU(num, u.gen); put(num); put("\n");
    }
    if (n < outSize) out[n] = 0;
    return n;
  }

  static void snprintfU(char* out, uint32_t v)
  {
    char tmp[12];
    int i = 0;
    do { tmp[i++] = (char)('0' + v % 10); v /= 10; } while (v);
    for (int j = 0; j < i; j++) out[j] = tmp[i - 1 - j];
    out[i] = 0;
  }

  // Parse the stored form; invalid lines are skipped (a corrupt record must
  // not take the other accounts with it), duplicates keep the first.
  // Returns false only if the header is wrong.
  bool parse(const char* s, size_t len)
  {
    count = 0;
    if (!s || len < 3 || memcmp(s, "v1\n", 3) != 0) return false;
    size_t p = 3;
    while (p < len && count < USER_MAX) {
      size_t e = p;
      while (e < len && s[e] != '\n') e++;
      parseLine(s + p, e - p);
      p = e + 1;
    }
    return true;
  }

  void parseLine(const char* s, size_t len)
  {
    // Split into exactly 6 space-separated fields
    const char* f[6];
    size_t fl[6];
    size_t nf = 0, i = 0;
    while (i < len && nf < 6) {
      size_t st = i;
      while (i < len && s[i] != ' ') i++;
      f[nf] = s + st; fl[nf] = i - st; nf++;
      if (i < len) i++; // skip the space
    }
    if (nf != 6 || i < len) return;
    User u;
    memset(&u, 0, sizeof(u));
    if (fl[0] == 0 || fl[0] > USER_NAME_MAX) return;
    memcpy(u.name, f[0], fl[0]);
    if (!userNameValid(u.name) || find(u.name) >= 0) return;
    char role[12];
    if (fl[1] >= sizeof(role)) return;
    memcpy(role, f[1], fl[1]); role[fl[1]] = 0;
    u.role = roleFromName(role);
    if (u.role == ROLE_NONE) return;
    uint64_t it = 0;
    if (fl[2] == 0 || fl[2] > 7) return;
    for (size_t k = 0; k < fl[2]; k++) { if (f[2][k] < '0' || f[2][k] > '9') return; it = it * 10 + (f[2][k] - '0'); }
    if (it < KDF_ITER_MIN || it > KDF_ITER_MAX) return;
    u.iterations = (uint32_t)it;
    if (!fromHex(f[3], fl[3], u.salt, SALT_LEN)) return;
    if (!fromHex(f[4], fl[4], u.hash, HASH_LEN)) return;
    uint64_t g = 0;
    if (fl[5] == 0 || fl[5] > 10) return;
    for (size_t k = 0; k < fl[5]; k++) { if (f[5][k] < '0' || f[5][k] > '9') return; g = g * 10 + (f[5][k] - '0'); }
    if (g > 0xffffffffULL) return;
    u.gen = (uint32_t)g;
    users[count++] = u;
  }
};

// -------------------------------------------------------------- sessions
static const size_t SESSION_MAX = 8;
static const size_t TOKEN_LEN = 32;          // bytes; 64 hex chars on the wire
static const size_t TICKET_LEN = 16;         // SSE stream tickets
static const uint64_t SESSION_IDLE_MS = 12ULL * 3600 * 1000;           // homestead: 12 h
static const uint64_t SESSION_REMEMBER_IDLE_MS = 30ULL * 24 * 3600 * 1000; // "keep me signed in": 30 days
static const uint64_t SESSION_ABSOLUTE_MS = 30ULL * 24 * 3600 * 1000;  // never longer than 30 days
static const uint64_t TICKET_MS = 30ULL * 1000;

struct Session {
  bool used;
  uint8_t token[TOKEN_LEN];
  char user[USER_NAME_MAX + 1];
  uint32_t userGen;   // the user's gen when signed in
  uint32_t serial;    // distinguishes reuses of the slot
  bool remember;
  uint64_t created, lastUsed;
};

struct StreamTicket {
  bool used;
  uint8_t ticket[TICKET_LEN];
  int session;
  uint32_t serial;
  uint64_t expires;
};

struct SessionTable {
  Session s[SESSION_MAX];
  StreamTicket tickets[4];
  uint32_t nextSerial = 1;
  RandomFill rng = nullptr;

  SessionTable() { memset(s, 0, sizeof(s)); memset(tickets, 0, sizeof(tickets)); }

  static uint64_t idleLimit(const Session& x) { return x.remember ? SESSION_REMEMBER_IDLE_MS : SESSION_IDLE_MS; }

  bool expired(const Session& x, uint64_t now) const
  {
    return now - x.lastUsed > idleLimit(x) || now - x.created > SESSION_ABSOLUTE_MS;
  }

  // New session; the token (hex) goes to tokenHex (>= 65 chars). Evicts the
  // least recently used session when full. Returns the slot.
  int create(const char* user, uint32_t userGen, bool remember, uint64_t now, char* tokenHex)
  {
    int slot = -1;
    for (size_t i = 0; i < SESSION_MAX; i++) {
      if (!s[i].used || expired(s[i], now)) { slot = (int)i; break; }
    }
    if (slot < 0) {
      slot = 0;
      for (size_t i = 1; i < SESSION_MAX; i++) if (s[i].lastUsed < s[slot].lastUsed) slot = (int)i;
    }
    revoke(slot);
    Session& x = s[slot];
    x.used = true;
    rng(x.token, TOKEN_LEN);
    strncpy(x.user, user, USER_NAME_MAX);
    x.user[USER_NAME_MAX] = 0;
    x.userGen = userGen;
    x.serial = nextSerial++;
    x.remember = remember;
    x.created = x.lastUsed = now;
    toHex(x.token, TOKEN_LEN, tokenHex);
    return slot;
  }

  // Slot of a live session for this token, or -1. Every slot is compared
  // (constant time); a hit refreshes the idle clock if `touch`.
  int find(const char* tokenHex, uint64_t now, bool touch = true)
  {
    uint8_t tok[TOKEN_LEN];
    if (!tokenHex || !fromHex(tokenHex, strlen(tokenHex), tok, TOKEN_LEN)) return -1;
    int hit = -1;
    for (size_t i = 0; i < SESSION_MAX; i++) {
      bool eq = ctEqual(tok, s[i].token, TOKEN_LEN);
      if (eq && s[i].used && hit < 0) hit = (int)i;
    }
    if (hit < 0) return -1;
    if (expired(s[hit], now)) { revoke(hit); return -1; }
    if (touch) s[hit].lastUsed = now;
    return hit;
  }

  void revoke(int slot)
  {
    if (slot < 0 || slot >= (int)SESSION_MAX) return;
    memset(&s[slot], 0, sizeof(Session));
    for (auto& t : tickets) if (t.used && t.session == slot) memset(&t, 0, sizeof(t));
  }

  void revokeUser(const char* user)
  {
    for (size_t i = 0; i < SESSION_MAX; i++) if (s[i].used && strcmp(s[i].user, user) == 0) revoke((int)i);
  }

  void revokeAll() { for (size_t i = 0; i < SESSION_MAX; i++) revoke((int)i); }

  // Still the same, unexpired session? (long-lived SSE streams check this)
  bool alive(int slot, uint32_t serial, uint64_t now) const
  {
    if (slot < 0 || slot >= (int)SESSION_MAX) return false;
    const Session& x = s[slot];
    return x.used && x.serial == serial && !expired(x, now);
  }

  // One-time, short-lived ticket naming a session, for the SSE stream on
  // the other port (EventSource can't carry the cookie there without CORS
  // credentials, and a URL token that outlives its use would be a leak)
  bool issueTicket(int slot, uint64_t now, char* hexOut)
  {
    if (slot < 0 || slot >= (int)SESSION_MAX || !s[slot].used) return false;
    size_t pick = 0;
    for (size_t i = 0; i < 4; i++) {
      if (!tickets[i].used || now > tickets[i].expires) { pick = i; break; }
      if (tickets[i].expires < tickets[pick].expires) pick = i;
    }
    StreamTicket& t = tickets[pick];
    t.used = true;
    rng(t.ticket, TICKET_LEN);
    t.session = slot;
    t.serial = s[slot].serial;
    t.expires = now + TICKET_MS;
    toHex(t.ticket, TICKET_LEN, hexOut);
    return true;
  }

  // Slot the ticket names, consuming it; -1 if unknown/expired/stale
  int redeemTicket(const char* hex, uint64_t now, uint32_t* serialOut)
  {
    uint8_t tk[TICKET_LEN];
    if (!hex || !fromHex(hex, strlen(hex), tk, TICKET_LEN)) return -1;
    int hit = -1;
    for (size_t i = 0; i < 4; i++) {
      bool eq = ctEqual(tk, tickets[i].ticket, TICKET_LEN);
      if (eq && tickets[i].used && hit < 0) hit = (int)i;
    }
    if (hit < 0) return -1;
    StreamTicket t = tickets[hit];
    memset(&tickets[hit], 0, sizeof(StreamTicket));
    if (now > t.expires || !alive(t.session, t.serial, now)) return -1;
    if (serialOut) *serialOut = t.serial;
    return t.session;
  }
};

// ------------------------------------------------------- sign-in limiter
// Failed attempts counted in a fixed window. Homestead allows 8 per address
// and 20 per account in 5 minutes; an ESP pays ~0.3 s of its only server
// thread per attempt, so this is tighter and also capped overall.
static const uint32_t LIMIT_WINDOW_MS = 5UL * 60 * 1000;
static const uint8_t LIMIT_PER_IP = 6, LIMIT_PER_USER = 10, LIMIT_GLOBAL = 30;

struct LoginLimiter {
  struct Slot { uint32_t key; uint8_t fails; uint64_t start; bool used; };
  Slot ips[8], names[8];
  uint8_t globalFails = 0;
  uint64_t globalStart = 0;

  LoginLimiter() { memset(ips, 0, sizeof(ips)); memset(names, 0, sizeof(names)); }

  static uint32_t nameKey(const char* name)
  {
    uint32_t h = 2166136261u; // FNV-1a
    for (const char* c = name ? name : ""; *c; c++) { h ^= (uint8_t)*c; h *= 16777619u; }
    return h;
  }

  static Slot* lookup(Slot* tab, size_t n, uint32_t key, uint64_t now, bool create)
  {
    Slot* oldest = &tab[0];
    for (size_t i = 0; i < n; i++) {
      if (tab[i].used && now - tab[i].start >= LIMIT_WINDOW_MS) tab[i].used = false; // window over
      if (tab[i].used && tab[i].key == key) return &tab[i];
    }
    if (!create) return nullptr;
    for (size_t i = 0; i < n; i++) {
      if (!tab[i].used) { tab[i] = { key, 0, now, true }; return &tab[i]; }
      if (tab[i].start < oldest->start) oldest = &tab[i];
    }
    *oldest = { key, 0, now, true }; // full: forget the oldest (the global cap still holds)
    return oldest;
  }

  static uint32_t remaining(const Slot* s, uint64_t now)
  {
    uint64_t left = LIMIT_WINDOW_MS - (now - s->start);
    return (uint32_t)((left + 999) / 1000);
  }

  // May this attempt run? If not, retryAfter (seconds) says when.
  bool allowed(uint32_t ip, const char* name, uint64_t now, uint32_t* retryAfter)
  {
    uint32_t wait = 0;
    if (globalFails && now - globalStart >= LIMIT_WINDOW_MS) globalFails = 0;
    if (globalFails >= LIMIT_GLOBAL) {
      uint64_t left = LIMIT_WINDOW_MS - (now - globalStart);
      wait = (uint32_t)((left + 999) / 1000);
    }
    Slot* a = lookup(ips, 8, ip, now, false);
    if (a && a->fails >= LIMIT_PER_IP) { uint32_t w = remaining(a, now); if (w > wait) wait = w; }
    Slot* b = lookup(names, 8, nameKey(name), now, false);
    if (b && b->fails >= LIMIT_PER_USER) { uint32_t w = remaining(b, now); if (w > wait) wait = w; }
    if (retryAfter) *retryAfter = wait;
    return wait == 0;
  }

  void failure(uint32_t ip, const char* name, uint64_t now)
  {
    if (globalFails == 0) globalStart = now;
    if (globalFails < 255) globalFails++;
    Slot* a = lookup(ips, 8, ip, now, true);
    if (a->fails < 255) a->fails++;
    Slot* b = lookup(names, 8, nameKey(name), now, true);
    if (b->fails < 255) b->fails++;
  }

  // A good password clears that address's count (not the name's: an
  // attacker guessing someone else's password shouldn't be helped by
  // signing in with their own)
  void success(uint32_t ip, uint64_t now)
  {
    Slot* a = lookup(ips, 8, ip, now, false);
    if (a) a->used = false;
  }
};

} // namespace weblogic
