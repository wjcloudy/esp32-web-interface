// Native unit tests for the users/permissions logic: the endpoint and
// terminal-command classification in src/web_logic.h, and the accounts,
// hashing, sessions and rate limiter in src/web_auth.h. Built on the host
// (pio test -e native); CI also runs them under ASan + UBSan (native_asan),
// which is what makes the fuzz loops at the bottom meaningful.
#include <unity.h>
#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

#include "web_auth.h"

using namespace weblogic;

void setUp() {}
void tearDown() {}

// Deterministic "random" bytes for the stores under test
static uint32_t g_seed = 1;
static void testRng(uint8_t* buf, size_t len)
{
  for (size_t i = 0; i < len; i++) { g_seed = g_seed * 1103515245u + 12345u; buf[i] = (uint8_t)(g_seed >> 16); }
}

static std::string hex(const uint8_t* b, size_t n)
{
  char out[256];
  toHex(b, n, out);
  return out;
}

// ---- SHA-256 / HMAC / PBKDF2 test vectors -----------------------------------

void test_sha256_vectors()
{
  uint8_t d[32];
  Sha256 s;
  s.init(); s.finish(d);
  TEST_ASSERT_EQUAL_STRING("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", hex(d, 32).c_str());
  s.init(); s.update((const uint8_t*)"abc", 3); s.finish(d);
  TEST_ASSERT_EQUAL_STRING("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", hex(d, 32).c_str());
  // Two-block message (FIPS 180-2)
  const char* m = "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq";
  s.init(); s.update((const uint8_t*)m, strlen(m)); s.finish(d);
  TEST_ASSERT_EQUAL_STRING("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1", hex(d, 32).c_str());
  // Byte-at-a-time feeding gives the same digest
  s.init(); for (size_t i = 0; i < strlen(m); i++) s.update((const uint8_t*)m + i, 1); s.finish(d);
  TEST_ASSERT_EQUAL_STRING("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1", hex(d, 32).c_str());
}

void test_hmac_rfc4231_case2()
{
  HmacSha256 h;
  h.init((const uint8_t*)"Jefe", 4);
  uint8_t d[32];
  const char* msg = "what do ya want for nothing?";
  h.mac((const uint8_t*)msg, strlen(msg), d);
  TEST_ASSERT_EQUAL_STRING("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843", hex(d, 32).c_str());
}

void test_pbkdf2_sha256_vectors()
{
  uint8_t d[40];
  pbkdf2Sha256((const uint8_t*)"password", 8, (const uint8_t*)"salt", 4, 1, d, 32);
  TEST_ASSERT_EQUAL_STRING("120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b", hex(d, 32).c_str());
  pbkdf2Sha256((const uint8_t*)"password", 8, (const uint8_t*)"salt", 4, 2, d, 32);
  TEST_ASSERT_EQUAL_STRING("ae4d0c95af6b46d32d0adff928f06dd02a303f8ef3c251dfd6e2d85a95474c43", hex(d, 32).c_str());
  pbkdf2Sha256((const uint8_t*)"password", 8, (const uint8_t*)"salt", 4, 4096, d, 32);
  TEST_ASSERT_EQUAL_STRING("c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a", hex(d, 32).c_str());
  // Output longer than one block
  const char* pw = "passwordPASSWORDpassword";
  const char* salt = "saltSALTsaltSALTsaltSALTsaltSALTsalt";
  pbkdf2Sha256((const uint8_t*)pw, strlen(pw), (const uint8_t*)salt, strlen(salt), 4096, d, 40);
  TEST_ASSERT_EQUAL_STRING("348c89dbcbd32b2f32d814b8116e84cf2b17347ebc1800181c4e2a1fb8dd53e1c635518c7dac47e9", hex(d, 40).c_str());
}

// ---- helpers ------------------------------------------------------------------

void test_ctEqual_and_hex()
{
  uint8_t a[4] = { 1, 2, 3, 4 }, b[4] = { 1, 2, 3, 4 }, c[4] = { 1, 2, 3, 5 };
  TEST_ASSERT_TRUE(ctEqual(a, b, 4));
  TEST_ASSERT_FALSE(ctEqual(a, c, 4));
  uint8_t out[4];
  TEST_ASSERT_TRUE(fromHex("010203ff", 8, out, 4));
  TEST_ASSERT_EQUAL_UINT8(0xff, out[3]);
  TEST_ASSERT_TRUE(fromHex("010203FF", 8, out, 4));
  TEST_ASSERT_FALSE(fromHex("010203f", 7, out, 4));
  TEST_ASSERT_FALSE(fromHex("010203fg", 8, out, 4));
  TEST_ASSERT_FALSE(fromHex(nullptr, 0, out, 4));
}

void test_cookieValue()
{
  char v[80];
  TEST_ASSERT_TRUE(cookieValue("oisess=abc", "oisess", v, sizeof(v)));
  TEST_ASSERT_EQUAL_STRING("abc", v);
  TEST_ASSERT_TRUE(cookieValue("a=1; oisess=xyz ; b=2", "oisess", v, sizeof(v)));
  TEST_ASSERT_EQUAL_STRING("xyz", v);
  // Whole names only
  TEST_ASSERT_FALSE(cookieValue("xoisess=1; oisessx=2", "oisess", v, sizeof(v)));
  TEST_ASSERT_FALSE(cookieValue("", "oisess", v, sizeof(v)));
  TEST_ASSERT_FALSE(cookieValue(nullptr, "oisess", v, sizeof(v)));
  // Too long for the buffer: refused, not truncated
  TEST_ASSERT_FALSE(cookieValue("oisess=0123456789", "oisess", v, 5));
  TEST_ASSERT_TRUE(cookieValue("oisess=", "oisess", v, sizeof(v)));
  TEST_ASSERT_EQUAL_STRING("", v);
}

void test_bearerToken()
{
  char v[80];
  TEST_ASSERT_TRUE(bearerToken("Bearer abc123", v, sizeof(v)));
  TEST_ASSERT_EQUAL_STRING("abc123", v);
  TEST_ASSERT_FALSE(bearerToken("Basic YWJj", v, sizeof(v)));
  TEST_ASSERT_FALSE(bearerToken("Bearer ", v, sizeof(v)));
  TEST_ASSERT_FALSE(bearerToken("", v, sizeof(v)));
  TEST_ASSERT_FALSE(bearerToken("Bearer 0123456789", v, 5));
}

void test_name_and_password_rules()
{
  TEST_ASSERT_TRUE(userNameValid("admin"));
  TEST_ASSERT_TRUE(userNameValid("a.b_c-1"));
  TEST_ASSERT_FALSE(userNameValid(""));
  TEST_ASSERT_FALSE(userNameValid("Admin"));     // lower-cased by the caller
  TEST_ASSERT_FALSE(userNameValid("a b"));
  TEST_ASSERT_FALSE(userNameValid("a\nb"));
  TEST_ASSERT_FALSE(userNameValid("abcdefghijabcdefghijabcdefghijabc")); // 33
  TEST_ASSERT_TRUE(passwordValid("12345678"));
  TEST_ASSERT_TRUE(passwordValid("pässwörd ok"));
  TEST_ASSERT_FALSE(passwordValid("1234567"));
  TEST_ASSERT_FALSE(passwordValid("12345678\n"));
  TEST_ASSERT_FALSE(passwordValid(std::string(65, 'x').c_str()));
  TEST_ASSERT_FALSE(passwordValid(nullptr));
}

// ---- user store -----------------------------------------------------------------

static UserStore freshStore()
{
  UserStore s;
  s.iterations = 3; // test-only: the firmware uses AUTH_PBKDF2_ITERATIONS
  s.rng = testRng;
  return s;
}

void test_users_first_must_be_admin()
{
  UserStore s = freshStore();
  TEST_ASSERT_EQUAL_INT(USER_FIRST_MUST_BE_ADMIN, s.add("bob", "password1", ROLE_VIEWER));
  TEST_ASSERT_EQUAL_INT(USER_OK, s.add("alice", "password1", ROLE_ADMIN));
  TEST_ASSERT_EQUAL_INT(USER_OK, s.add("bob", "password2", ROLE_VIEWER));
  TEST_ASSERT_EQUAL_INT(USER_EXISTS, s.add("bob", "password2", ROLE_VIEWER));
  TEST_ASSERT_EQUAL_INT(USER_BAD_NAME, s.add("Bad Name", "password2", ROLE_VIEWER));
  TEST_ASSERT_EQUAL_INT(USER_BAD_PASSWORD, s.add("carol", "short", ROLE_VIEWER));
  TEST_ASSERT_EQUAL_INT(USER_BAD_ROLE, s.add("carol", "password3", ROLE_NONE));
  TEST_ASSERT_EQUAL_UINT(2, s.count);
}

void test_users_verify_and_salt()
{
  UserStore s = freshStore();
  s.add("alice", "password1", ROLE_ADMIN);
  s.add("bob", "password1", ROLE_OPERATOR);
  TEST_ASSERT_EQUAL_INT(0, s.verify("alice", "password1"));
  TEST_ASSERT_EQUAL_INT(1, s.verify("bob", "password1"));
  TEST_ASSERT_EQUAL_INT(-1, s.verify("alice", "password2"));
  TEST_ASSERT_EQUAL_INT(-1, s.verify("nobody", "password1"));
  TEST_ASSERT_EQUAL_INT(-1, s.verify("alice", ""));
  TEST_ASSERT_EQUAL_INT(-1, s.verify("alice", nullptr));
  // Same password, different salts -> different hashes; nothing stores plaintext
  TEST_ASSERT_FALSE(ctEqual(s.users[0].salt, s.users[1].salt, SALT_LEN));
  TEST_ASSERT_FALSE(ctEqual(s.users[0].hash, s.users[1].hash, HASH_LEN));
  char buf[2048];
  s.serialize(buf, sizeof(buf));
  TEST_ASSERT_NULL(strstr(buf, "password1"));
}

void test_users_last_admin_and_self_protection()
{
  UserStore s = freshStore();
  s.add("alice", "password1", ROLE_ADMIN);
  s.add("bob", "password1", ROLE_OPERATOR);
  TEST_ASSERT_EQUAL_INT(USER_LAST_ADMIN, s.remove("alice", "bob"));
  TEST_ASSERT_EQUAL_INT(USER_SELF, s.remove("alice", "alice"));
  TEST_ASSERT_EQUAL_INT(USER_LAST_ADMIN, s.setRole("alice", ROLE_VIEWER, nullptr));
  TEST_ASSERT_EQUAL_INT(USER_SELF, s.setRole("bob", ROLE_ADMIN, "bob"));
  TEST_ASSERT_EQUAL_INT(USER_OK, s.setRole("bob", ROLE_ADMIN, "alice"));
  TEST_ASSERT_EQUAL_INT(USER_OK, s.setRole("alice", ROLE_VIEWER, "bob")); // a second admin exists now
  TEST_ASSERT_EQUAL_INT(USER_NOT_FOUND, s.remove("carol", "bob"));
  TEST_ASSERT_EQUAL_INT(USER_OK, s.remove("alice", "bob"));
  TEST_ASSERT_EQUAL_UINT(1, s.count);
  TEST_ASSERT_EQUAL_STRING("bob", s.users[0].name);
}

void test_users_changes_bump_generation()
{
  UserStore s = freshStore();
  s.add("alice", "password1", ROLE_ADMIN);
  s.add("bob", "password1", ROLE_VIEWER);
  uint32_t g = s.users[1].gen;
  s.setRole("bob", ROLE_OPERATOR, "alice");
  TEST_ASSERT_EQUAL_UINT32(g + 1, s.users[1].gen);
  s.setRole("bob", ROLE_OPERATOR, "alice"); // no change, no bump
  TEST_ASSERT_EQUAL_UINT32(g + 1, s.users[1].gen);
  TEST_ASSERT_EQUAL_INT(USER_OK, s.setPassword("bob", "newpassword"));
  TEST_ASSERT_EQUAL_UINT32(g + 2, s.users[1].gen);
  TEST_ASSERT_EQUAL_INT(-1, s.verify("bob", "password1"));
  TEST_ASSERT_EQUAL_INT(1, s.verify("bob", "newpassword"));
  TEST_ASSERT_EQUAL_INT(USER_BAD_PASSWORD, s.setPassword("bob", "x"));
}

void test_users_full()
{
  UserStore s = freshStore();
  char name[8];
  for (size_t i = 0; i < USER_MAX; i++) {
    snprintf(name, sizeof(name), "u%u", (unsigned)i);
    TEST_ASSERT_EQUAL_INT(USER_OK, s.add(name, "password1", ROLE_ADMIN));
  }
  TEST_ASSERT_EQUAL_INT(USER_FULL, s.add("extra", "password1", ROLE_VIEWER));
}

void test_users_serialize_roundtrip()
{
  UserStore s = freshStore();
  s.add("alice", "password1", ROLE_ADMIN);
  s.add("bob", "password2", ROLE_VIEWER);
  s.setPassword("bob", "password3");
  std::vector<char> buf(s.serializedSize() + 1);
  size_t n = s.serialize(buf.data(), buf.size());
  UserStore t = freshStore();
  TEST_ASSERT_TRUE(t.parse(buf.data(), n));
  TEST_ASSERT_EQUAL_UINT(2, t.count);
  TEST_ASSERT_EQUAL_INT(ROLE_VIEWER, t.users[1].role);
  TEST_ASSERT_EQUAL_UINT32(s.users[1].gen, t.users[1].gen);
  TEST_ASSERT_EQUAL_INT(0, t.verify("alice", "password1"));
  TEST_ASSERT_EQUAL_INT(1, t.verify("bob", "password3"));
}

void test_users_parse_skips_bad_lines()
{
  const char* salt = "00112233445566778899aabbccddeeff";
  const char* hash = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
  std::string good = std::string("alice admin 5 ") + salt + " " + hash + " 3";
  std::string text = "v1\n" + good + "\n" +
    "bob superuser 5 " + salt + " " + hash + " 1\n" +              // bad role
    "carol viewer 0 " + salt + " " + hash + " 1\n" +               // bad iterations
    "dave viewer 5 " + std::string(salt).substr(2) + " " + hash + " 1\n" + // short salt
    "Eve viewer 5 " + salt + " " + hash + " 1\n" +                 // bad name
    "frank viewer 5 " + salt + " " + hash + " 1 extra\n" +         // extra field
    good + "\n" +                                                  // duplicate
    "gina operator 5 " + salt + " " + hash + " 7";                 // no trailing newline
  UserStore s = freshStore();
  TEST_ASSERT_TRUE(s.parse(text.c_str(), text.size()));
  TEST_ASSERT_EQUAL_UINT(2, s.count);
  TEST_ASSERT_EQUAL_STRING("alice", s.users[0].name);
  TEST_ASSERT_EQUAL_STRING("gina", s.users[1].name);
  TEST_ASSERT_EQUAL_UINT32(7, s.users[1].gen);
  TEST_ASSERT_FALSE(s.parse("v2\n", 3));
  TEST_ASSERT_EQUAL_UINT(0, s.count);
  TEST_ASSERT_FALSE(s.parse(nullptr, 0));
}

// ---- sessions ---------------------------------------------------------------------

static SessionTable freshSessions()
{
  SessionTable t;
  t.rng = testRng;
  return t;
}

void test_sessions_create_find_revoke()
{
  SessionTable t = freshSessions();
  char tok[TOKEN_LEN * 2 + 1], tok2[TOKEN_LEN * 2 + 1];
  int a = t.create("alice", 1, false, 1000, tok);
  int b = t.create("bob", 1, false, 1000, tok2);
  TEST_ASSERT_EQUAL_UINT(64, strlen(tok));
  TEST_ASSERT_NOT_EQUAL(a, b);
  TEST_ASSERT_EQUAL_INT(a, t.find(tok, 2000));
  TEST_ASSERT_EQUAL_INT(b, t.find(tok2, 2000));
  // Flip one hex digit: no match
  std::string bad = tok; bad[10] = bad[10] == '0' ? '1' : '0';
  TEST_ASSERT_EQUAL_INT(-1, t.find(bad.c_str(), 2000));
  TEST_ASSERT_EQUAL_INT(-1, t.find("", 2000));
  TEST_ASSERT_EQUAL_INT(-1, t.find("zz", 2000));
  TEST_ASSERT_EQUAL_INT(-1, t.find(nullptr, 2000));
  // An all-zero token never matches an empty slot
  TEST_ASSERT_EQUAL_INT(-1, t.find(std::string(64, '0').c_str(), 2000));
  t.revokeUser("alice");
  TEST_ASSERT_EQUAL_INT(-1, t.find(tok, 2000));
  TEST_ASSERT_EQUAL_INT(b, t.find(tok2, 2000));
  t.revoke(b);
  TEST_ASSERT_EQUAL_INT(-1, t.find(tok2, 2000));
}

void test_sessions_idle_and_absolute_expiry()
{
  SessionTable t = freshSessions();
  char tok[65], rem[65];
  t.create("alice", 1, false, 0, tok);
  t.create("bob", 1, true, 0, rem);
  // Use keeps an ordinary session alive past the idle window...
  uint64_t now = 0;
  for (int i = 0; i < 5; i++) { now += SESSION_IDLE_MS - 1000; TEST_ASSERT_TRUE(t.find(tok, now) >= 0); }
  // ...but not idleness
  TEST_ASSERT_EQUAL_INT(-1, t.find(tok, now + SESSION_IDLE_MS + 1));
  // "Keep me signed in" survives a long idle gap, yet not the absolute limit
  TEST_ASSERT_TRUE(t.find(rem, 2 * SESSION_IDLE_MS) >= 0);
  uint64_t n2 = 2 * SESSION_IDLE_MS;
  while (n2 + SESSION_REMEMBER_IDLE_MS / 2 < SESSION_ABSOLUTE_MS) { n2 += SESSION_REMEMBER_IDLE_MS / 2; TEST_ASSERT_TRUE(t.find(rem, n2) >= 0); }
  TEST_ASSERT_EQUAL_INT(-1, t.find(rem, SESSION_ABSOLUTE_MS + 1));
}

void test_sessions_evict_least_recently_used()
{
  SessionTable t = freshSessions();
  char toks[SESSION_MAX][65], extra[65];
  for (size_t i = 0; i < SESSION_MAX; i++) t.create("u", 1, false, 100 + i, toks[i]);
  t.find(toks[0], 500); // the oldest is used again: slot 1 is now least recent
  t.create("v", 1, false, 600, extra);
  TEST_ASSERT_TRUE(t.find(toks[0], 700) >= 0);
  TEST_ASSERT_EQUAL_INT(-1, t.find(toks[1], 700));
  TEST_ASSERT_TRUE(t.find(extra, 700) >= 0);
}

void test_stream_tickets()
{
  SessionTable t = freshSessions();
  char tok[65], tk[TICKET_LEN * 2 + 1];
  int s = t.create("alice", 1, false, 0, tok);
  uint32_t serial = 0;
  TEST_ASSERT_TRUE(t.issueTicket(s, 0, tk));
  TEST_ASSERT_EQUAL_INT(s, t.redeemTicket(tk, 10, &serial));
  TEST_ASSERT_TRUE(t.alive(s, serial, 10));
  TEST_ASSERT_EQUAL_INT(-1, t.redeemTicket(tk, 10, nullptr)); // one use only
  // Expired ticket
  t.issueTicket(s, 0, tk);
  TEST_ASSERT_EQUAL_INT(-1, t.redeemTicket(tk, TICKET_MS + 1, nullptr));
  // Ticket of a revoked session; and the stream's alive() check fails too
  t.issueTicket(s, 0, tk);
  t.revoke(s);
  TEST_ASSERT_EQUAL_INT(-1, t.redeemTicket(tk, 1, nullptr));
  TEST_ASSERT_FALSE(t.alive(s, serial, 1));
  // A new session in the same slot is not the old one
  int s2 = t.create("bob", 1, false, 2, tok);
  TEST_ASSERT_EQUAL_INT(s, s2);
  TEST_ASSERT_FALSE(t.alive(s2, serial, 3));
  TEST_ASSERT_FALSE(t.issueTicket(-1, 0, tk));
  TEST_ASSERT_EQUAL_INT(-1, t.redeemTicket("00", 0, nullptr));
}

// ---- rate limiter ----------------------------------------------------------------------

void test_limiter_per_ip()
{
  LoginLimiter l;
  uint32_t wait = 0;
  for (int i = 0; i < LIMIT_PER_IP; i++) {
    TEST_ASSERT_TRUE(l.allowed(1, "alice", 1000, &wait));
    l.failure(1, "alice", 1000);
  }
  TEST_ASSERT_FALSE(l.allowed(1, "bob", 2000, &wait));
  TEST_ASSERT_TRUE(wait > 0 && wait <= LIMIT_WINDOW_MS / 1000);
  TEST_ASSERT_TRUE(l.allowed(2, "bob", 2000, &wait));                 // another address
  TEST_ASSERT_TRUE(l.allowed(1, "bob", 1000 + LIMIT_WINDOW_MS, &wait)); // window over
}

void test_limiter_per_user_across_addresses()
{
  LoginLimiter l;
  uint32_t wait;
  for (int i = 0; i < LIMIT_PER_USER; i++) l.failure(100 + i, "alice", 0);
  TEST_ASSERT_FALSE(l.allowed(999, "alice", 10, &wait));
  TEST_ASSERT_TRUE(l.allowed(999, "bob", 10, &wait));
}

void test_limiter_global_cap_and_success()
{
  LoginLimiter l;
  uint32_t wait;
  for (int i = 0; i < LIMIT_PER_IP - 1; i++) l.failure(7, "x", 0);
  l.success(7, 1);
  TEST_ASSERT_TRUE(l.allowed(7, "y", 2, &wait));
  for (int i = 0; i < LIMIT_GLOBAL; i++) {
    char n[8]; snprintf(n, sizeof(n), "n%d", i);
    l.failure(1000 + i, n, 5);
  }
  TEST_ASSERT_FALSE(l.allowed(55555, "fresh", 6, &wait));
  TEST_ASSERT_TRUE(l.allowed(55555, "fresh", 5 + LIMIT_WINDOW_MS, &wait));
}

// ---- classification: roles, routes, files, commands ------------------------------------

void test_roleAllows()
{
  TEST_ASSERT_TRUE(roleAllows(ROLE_NONE, PERM_PUBLIC));
  TEST_ASSERT_FALSE(roleAllows(ROLE_NONE, PERM_READ));
  TEST_ASSERT_TRUE(roleAllows(ROLE_VIEWER, PERM_READ));
  TEST_ASSERT_FALSE(roleAllows(ROLE_VIEWER, PERM_WRITE));
  TEST_ASSERT_TRUE(roleAllows(ROLE_OPERATOR, PERM_WRITE));
  TEST_ASSERT_FALSE(roleAllows(ROLE_OPERATOR, PERM_ADMIN));
  TEST_ASSERT_TRUE(roleAllows(ROLE_ADMIN, PERM_ADMIN));
  TEST_ASSERT_FALSE(roleAllows(ROLE_ADMIN, PERM_DENY));
  TEST_ASSERT_FALSE(roleAllows(ROLE_ADMIN, PERM_CMD));  // must be resolved first
  TEST_ASSERT_FALSE(roleAllows(ROLE_ADMIN, PERM_FILE));
  TEST_ASSERT_EQUAL_INT(ROLE_OPERATOR, roleFromName("operator"));
  TEST_ASSERT_EQUAL_INT(ROLE_NONE, roleFromName("root"));
  TEST_ASSERT_EQUAL_STRING("admin", roleName(ROLE_ADMIN));
}

static Perm permOf(uint8_t m, const char* path)
{
  const RouteRule* r = findRoute(m, path);
  return r ? r->perm : (Perm)255;
}

void test_route_table()
{
  // Every endpoint the firmware serves, with what it needs
  TEST_ASSERT_EQUAL_INT(PERM_PUBLIC, permOf(M_GET, "/auth/state"));
  TEST_ASSERT_EQUAL_INT(PERM_PUBLIC, permOf(M_POST, "/auth/login"));
  TEST_ASSERT_EQUAL_INT(PERM_READ, permOf(M_POST, "/auth/password"));
  TEST_ASSERT_EQUAL_INT(PERM_ADMIN, permOf(M_POST, "/auth/users"));
  TEST_ASSERT_EQUAL_INT(PERM_ADMIN, permOf(M_GET, "/auth/users"));
  TEST_ASSERT_EQUAL_INT(PERM_CMD, permOf(M_GET, "/cmd"));
  TEST_ASSERT_EQUAL_INT(PERM_CMD, permOf(M_POST, "/cmd"));
  TEST_ASSERT_EQUAL_INT(PERM_READ, permOf(M_GET, "/settings"));
  TEST_ASSERT_EQUAL_INT(PERM_ADMIN, permOf(M_POST, "/settings"));
  TEST_ASSERT_EQUAL_INT(PERM_READ, permOf(M_GET, "/edit"));
  TEST_ASSERT_EQUAL_INT(PERM_FILE, permOf(M_POST, "/edit"));
  TEST_ASSERT_EQUAL_INT(PERM_FILE, permOf(M_PUT, "/edit"));
  TEST_ASSERT_EQUAL_INT(PERM_FILE, permOf(M_DELETE, "/edit"));
  for (const char* p : { "/rtc/set", "/reset-inverter", "/can-send", "/can-scan", "/can-debug", "/set-can-node", "/virtual-reload" })
    TEST_ASSERT_EQUAL_INT_MESSAGE(PERM_WRITE, permOf(p[1] == 'r' && p[2] == 't' ? M_POST : M_GET, p), p);
  TEST_ASSERT_EQUAL_INT(PERM_WRITE, permOf(M_GET, "/sdcard/deleteAll"));
  for (const char* p : { "/wifi", "/fwupdate", "/can-fwupdate", "/reboot" })
    TEST_ASSERT_EQUAL_INT_MESSAGE(PERM_ADMIN, permOf(M_GET, p), p);
  for (const char* p : { "/espupdate", "/espupdate-url", "/update" })
    TEST_ASSERT_EQUAL_INT_MESSAGE(PERM_ADMIN, permOf(M_POST, p), p);
  for (const char* p : { "/list", "/rtc/now", "/sdcard/list", "/espupdate-status", "/wifi-status", "/fwupdate-status",
                         "/baud", "/version", "/otainfo", "/favorites.json", "/gauges.json", "/plots.json", "/virtualvals.json" })
    TEST_ASSERT_EQUAL_INT_MESSAGE(PERM_READ, permOf(M_GET, p), p);
  // Method not served / exact paths only
  TEST_ASSERT_NULL(findRoute(M_GET, "/rtc/set"));
  TEST_ASSERT_NULL(findRoute(M_GET, "/cmd/"));
  TEST_ASSERT_NULL(findRoute(M_GET, "/CMD"));
  TEST_ASSERT_NULL(findRoute(M_GET, nullptr));
  TEST_ASSERT_TRUE(routeKnown("/edit", M_GET | M_POST | M_PUT | M_DELETE));
  TEST_ASSERT_FALSE(routeKnown("/edit", M_OTHER));
  TEST_ASSERT_FALSE(routeKnown("/new-endpoint", M_GET));
}

void test_route_table_invariants()
{
  for (size_t i = 0; i < ROUTE_COUNT; i++) {
    const RouteRule& r = ROUTES[i];
    TEST_ASSERT_EQUAL_CHAR('/', r.path[0]);
    TEST_ASSERT_NOT_EQUAL(0, r.methods);
    TEST_ASSERT_TRUE(r.perm != PERM_DENY);
    // No (path, method) pair is listed twice — the first would silently win
    for (size_t j = i + 1; j < ROUTE_COUNT; j++)
      if (strcmp(r.path, ROUTES[j].path) == 0) TEST_ASSERT_EQUAL_UINT8_MESSAGE(0, r.methods & ROUTES[j].methods, r.path);
    // Only sign-in itself is public
    if (r.perm == PERM_PUBLIC) TEST_ASSERT_EQUAL_INT_MESSAGE(0, strncmp(r.path, "/auth/", 6), r.path);
  }
}

void test_staticPerm()
{
  for (const char* p : { "/", "/index.html", "/app.js", "/app.js.gz", "/style.css", "/favicon.svg", "/icon-180.png",
                         "/manifest.json", "/wifi.html", "/sw.js", "/docstrings.js" })
    TEST_ASSERT_EQUAL_INT_MESSAGE(PERM_PUBLIC, staticPerm(p), p);
  for (const char* p : { "/settings.json", "/presets.json", "/paramlog.json", "/uiprefs.json", "/firmware.bin",
                         "/0000000001.bin", "/gauges-sample.json", "/notes.txt", "/manifest.json.bak", "/subscription.js",
                         "/img-logo.png", "/img-car.jpg", "/img-a.jpeg", "/img-a.webp", "/img-a.gif", "/img-a.png.gz" })
    TEST_ASSERT_EQUAL_INT_MESSAGE(PERM_READ, staticPerm(p), p);
  for (const char* p : { "", "app.js", "/../x", "/a\\b", "/a\nb" })
    TEST_ASSERT_EQUAL_INT_MESSAGE(PERM_DENY, staticPerm(p), p);
  TEST_ASSERT_EQUAL_INT(PERM_DENY, staticPerm(nullptr));
}

void test_filePerm()
{
  for (const char* p : { "favorites.json", "/gauges.json", "presets.json", "paramlog.json", "uiprefs.json",
                         "/stm32_sine.bin", "virtualvals.json", "subscription.js", "/subscription.js.gz",
                         "img-logo.png", "/img-car.jpg", "/img-a.webp", "/img-a.gif" })
    TEST_ASSERT_EQUAL_INT_MESSAGE(PERM_WRITE, filePerm(p), p);
  // An operator must not be able to replace the UI (stored script against
  // the next admin) or the settings file
  for (const char* p : { "app.js", "/app.js.gz", "index.html", "/", "style.css", "sw.js", "manifest.json",
                         "settings.json", "/settings.json.gz", "/x/subscription.js",
                         // only raster pictures under the img- prefix are data
                         "/img-x.svg", "/img-x.js", "/img-.png", "/logo.png", "/x/img-a.png", "icon-180.png" })
    TEST_ASSERT_EQUAL_INT_MESSAGE(PERM_ADMIN, filePerm(p), p);
  TEST_ASSERT_EQUAL_INT(PERM_ADMIN, filePerm(std::string(100, 'a').c_str()));
  TEST_ASSERT_EQUAL_INT(PERM_DENY, filePerm("a\nb"));
  TEST_ASSERT_EQUAL_INT(PERM_WRITE, filePerm(""));
}

void test_cmdPerm_viewer_allowlist()
{
  for (const char* c : { "json", "json hidden", "errors", "serial", "help", "get udc", "get udc,tmphs,v_x",
                         "get a.b-c_d", "stream 10 udc,tmphs", "stream 100 udc", "can list", "can print" })
    TEST_ASSERT_EQUAL_INT_MESSAGE(PERM_READ, cmdPerm(c), c);
}

void test_cmdPerm_everything_else_needs_operator()
{
  for (const char* c : { "set fweak 50", "save", "load", "defaults", "start", "start 2", "stop", "reset",
                         "fastuart", "binarylogging 1", "flag fweak 1", "can tx udc 0x100 0 16 1", "can rx x 1 2 3 4",
                         "can rm 12544 1", "can clear", "can listx", "can list 1", "unknown", "",
                         // smuggling a second command or framing onto the UART
                         "get udc\nsave", "get udc\rsave", "json\n", "get udc;save", "get udc save", "get ",
                         "get", "json  ", " json", "json extra", "errors now", "stream", "stream 10",
                         "stream 0 udc", "stream 101 udc", "stream 1000 udc", "stream x udc", "stream 10 ",
                         "get \xc3\xa9", "get udc\x7f" })
    TEST_ASSERT_EQUAL_INT_MESSAGE(PERM_WRITE, cmdPerm(c), c);
  TEST_ASSERT_EQUAL_INT(PERM_WRITE, cmdPerm(nullptr));
}

void test_originHostMatches()
{
  TEST_ASSERT_TRUE(originHostMatches("http://192.168.4.1", "192.168.4.1:81"));
  TEST_ASSERT_TRUE(originHostMatches("http://Inverter.local:80", "inverter.local:81"));
  TEST_ASSERT_TRUE(originHostMatches("http://[fe80::1]:80", "[fe80::1]:81"));
  TEST_ASSERT_FALSE(originHostMatches("http://evil.example", "192.168.4.1:81"));
  TEST_ASSERT_FALSE(originHostMatches("http://192.168.4.10", "192.168.4.1:81"));
  TEST_ASSERT_FALSE(originHostMatches("null", "192.168.4.1"));
  TEST_ASSERT_FALSE(originHostMatches("", "192.168.4.1"));
  TEST_ASSERT_FALSE(originHostMatches(nullptr, "x"));
  // Only header-safe values are ever echoed back (Access-Control-Allow-Origin)
  TEST_ASSERT_TRUE(printableNoSpace("http://192.168.4.1"));
  TEST_ASSERT_FALSE(printableNoSpace("http://a\r\nSet-Cookie: x"));
  TEST_ASSERT_FALSE(printableNoSpace("http://a b"));
  TEST_ASSERT_FALSE(printableNoSpace(""));
  TEST_ASSERT_FALSE(printableNoSpace(nullptr));
}

void test_csrfOk()
{
  const char* host = "192.168.4.1";
  TEST_ASSERT_TRUE(csrfOk(false, "http://192.168.4.1", "", "", host));
  TEST_ASSERT_FALSE(csrfOk(false, "http://evil.example", "", "1", host)); // Origin wins
  TEST_ASSERT_FALSE(csrfOk(false, "http://192.168.4.1:8080", "", "1", host));
  TEST_ASSERT_FALSE(csrfOk(false, "null", "", "1", host));
  TEST_ASSERT_TRUE(csrfOk(false, "", "", "1", host));
  TEST_ASSERT_TRUE(csrfOk(false, nullptr, "http://192.168.4.1/#settings", nullptr, host));
  TEST_ASSERT_FALSE(csrfOk(false, "", "http://192.168.4.1.evil.example/", "", host));
  TEST_ASSERT_FALSE(csrfOk(false, "", "", "", host));
  TEST_ASSERT_FALSE(csrfOk(false, "", "", "0", host));
  TEST_ASSERT_TRUE(csrfOk(true, "http://evil.example", "", "", host)); // bearer: not ambient
  TEST_ASSERT_FALSE(csrfOk(false, "http://x", "", "1", ""));
  TEST_ASSERT_TRUE(csrfOk(false, "http://localhost:8765", "", "", "localhost:8765"));
}

// ---- fuzz: every parser above on random input -------------------------------------------

static uint32_t g_fz = 0x2545F491u;
static uint32_t frnd() { g_fz ^= g_fz << 13; g_fz ^= g_fz >> 17; g_fz ^= g_fz << 5; return g_fz; }

static std::string fuzzString(size_t maxLen)
{
  static const char* pieces[] = { "get ", "json", "set ", "stream ", "can ", "list", " ", ",", "\n", "\r",
                                  "udc", "hidden", "/", "..", ".gz", ".js", "=", ";", "oisess=", "Bearer ",
                                  "http://", "v1\n", "admin ", "viewer ", "0123456789abcdef", "\x7f", "\xff", ":" };
  std::string s;
  size_t len = frnd() % maxLen;
  while (s.size() < len) {
    if (frnd() % 3 == 0) s += (char)(frnd() & 0xff);
    else s += pieces[frnd() % (sizeof(pieces) / sizeof(pieces[0]))];
  }
  s.erase(std::remove(s.begin(), s.end(), '\0'), s.end());
  return s;
}

void test_fuzz_auth_parsers()
{
  char buf[128];
  for (int iter = 0; iter < 30000; iter++) {
    std::string s = fuzzString(200);
    const char* c = s.c_str();
    Perm p = cmdPerm(c);
    TEST_ASSERT_TRUE(p == PERM_READ || p == PERM_WRITE);
    if (p == PERM_READ) {
      for (unsigned char ch : s) TEST_ASSERT_TRUE(ch >= 0x20 && ch <= 0x7e);
      TEST_ASSERT_NULL(strchr(c, ';'));
    }
    Perm sp = staticPerm(c);
    TEST_ASSERT_TRUE(sp == PERM_PUBLIC || sp == PERM_READ || sp == PERM_DENY);
    if (sp != PERM_DENY) TEST_ASSERT_NULL(strstr(c, ".."));
    Perm fp = filePerm(c);
    TEST_ASSERT_TRUE(fp == PERM_WRITE || fp == PERM_ADMIN || fp == PERM_DENY);
    if (cookieValue(c, "oisess", buf, sizeof(buf))) TEST_ASSERT_TRUE(strlen(buf) < sizeof(buf));
    if (bearerToken(c, buf, sizeof(buf))) TEST_ASSERT_TRUE(strlen(buf) > 0 && strlen(buf) < sizeof(buf));
    hostPart(c, buf, sizeof(buf));
    originHostMatches(c, c);
    csrfOk(false, c, c, c, c);
    findRoute((uint8_t)(frnd() & M_ANY), c);
    uint8_t out[16];
    fromHex(c, s.size(), out, sizeof(out));
  }
}

void test_fuzz_user_store_parse()
{
  UserStore base = freshStore();
  base.add("alice", "password1", ROLE_ADMIN);
  base.add("bob", "password2", ROLE_VIEWER);
  std::vector<char> good(base.serializedSize() + 1);
  size_t n = base.serialize(good.data(), good.size());
  for (int iter = 0; iter < 5000; iter++) {
    std::string s(good.data(), n);
    // Mutate: flip, delete or insert bytes, or append fuzz
    int muts = 1 + frnd() % 6;
    for (int m = 0; m < muts && !s.empty(); m++) {
      size_t at = frnd() % s.size();
      switch (frnd() % 4) {
        case 0: s[at] = (char)(frnd() & 0xff); break;
        case 1: s.erase(at, 1 + frnd() % 8); break;
        case 2: s.insert(at, 1, (char)(frnd() & 0xff)); break;
        default: s += fuzzString(80); break;
      }
    }
    UserStore t = freshStore();
    t.parse(s.data(), s.size());
    TEST_ASSERT_TRUE(t.count <= USER_MAX);
    for (size_t i = 0; i < t.count; i++) {
      TEST_ASSERT_TRUE(userNameValid(t.users[i].name));
      TEST_ASSERT_TRUE(t.users[i].role >= ROLE_VIEWER && t.users[i].role <= ROLE_ADMIN);
      TEST_ASSERT_TRUE(t.users[i].iterations >= KDF_ITER_MIN && t.users[i].iterations <= KDF_ITER_MAX);
      for (size_t j = i + 1; j < t.count; j++) TEST_ASSERT_NOT_EQUAL(0, strcmp(t.users[i].name, t.users[j].name));
    }
    // Whatever survived re-serializes into something that parses identically
    std::vector<char> again(t.serializedSize() + 1);
    size_t m2 = t.serialize(again.data(), again.size());
    UserStore u = freshStore();
    TEST_ASSERT_TRUE(u.parse(again.data(), m2));
    TEST_ASSERT_EQUAL_UINT(t.count, u.count);
  }
}

void test_fuzz_sessions_and_limiter()
{
  SessionTable t = freshSessions();
  LoginLimiter l;
  char tok[65], tk[33];
  std::vector<std::string> live;
  uint64_t now = 0;
  for (int iter = 0; iter < 20000; iter++) {
    now += frnd() % (SESSION_IDLE_MS / 50);
    switch (frnd() % 6) {
      case 0: t.create(frnd() % 2 ? "a" : "b", 1, frnd() % 2, now, tok); live.push_back(tok); break;
      case 1: if (!live.empty()) { int s = t.find(live[frnd() % live.size()].c_str(), now); TEST_ASSERT_TRUE(s >= -1 && s < (int)SESSION_MAX); } break;
      case 2: t.revoke((int)(frnd() % (SESSION_MAX + 2)) - 1); break;
      case 3: { int s = (int)(frnd() % SESSION_MAX); if (t.issueTicket(s, now, tk)) { int r = t.redeemTicket(tk, now + frnd() % (2 * TICKET_MS), nullptr); TEST_ASSERT_TRUE(r == -1 || r == s); } break; }
      case 4: t.find(fuzzString(70).c_str(), now); t.redeemTicket(fuzzString(40).c_str(), now, nullptr); break;
      default: { uint32_t w; char nm[4] = { (char)('a' + frnd() % 3), 0 }; if (l.allowed(frnd() % 20, nm, now, &w)) l.failure(frnd() % 20, nm, now); else TEST_ASSERT_TRUE(w > 0 && w <= LIMIT_WINDOW_MS / 1000); break; }
    }
    if (live.size() > 64) live.erase(live.begin());
  }
}

int main(int, char**)
{
  UNITY_BEGIN();
  RUN_TEST(test_sha256_vectors);
  RUN_TEST(test_hmac_rfc4231_case2);
  RUN_TEST(test_pbkdf2_sha256_vectors);
  RUN_TEST(test_ctEqual_and_hex);
  RUN_TEST(test_cookieValue);
  RUN_TEST(test_bearerToken);
  RUN_TEST(test_name_and_password_rules);
  RUN_TEST(test_users_first_must_be_admin);
  RUN_TEST(test_users_verify_and_salt);
  RUN_TEST(test_users_last_admin_and_self_protection);
  RUN_TEST(test_users_changes_bump_generation);
  RUN_TEST(test_users_full);
  RUN_TEST(test_users_serialize_roundtrip);
  RUN_TEST(test_users_parse_skips_bad_lines);
  RUN_TEST(test_sessions_create_find_revoke);
  RUN_TEST(test_sessions_idle_and_absolute_expiry);
  RUN_TEST(test_sessions_evict_least_recently_used);
  RUN_TEST(test_stream_tickets);
  RUN_TEST(test_limiter_per_ip);
  RUN_TEST(test_limiter_per_user_across_addresses);
  RUN_TEST(test_limiter_global_cap_and_success);
  RUN_TEST(test_roleAllows);
  RUN_TEST(test_route_table);
  RUN_TEST(test_route_table_invariants);
  RUN_TEST(test_staticPerm);
  RUN_TEST(test_filePerm);
  RUN_TEST(test_cmdPerm_viewer_allowlist);
  RUN_TEST(test_cmdPerm_everything_else_needs_operator);
  RUN_TEST(test_originHostMatches);
  RUN_TEST(test_csrfOk);
  RUN_TEST(test_fuzz_auth_parsers);
  RUN_TEST(test_fuzz_user_store_parse);
  RUN_TEST(test_fuzz_sessions_and_limiter);
  return UNITY_END();
}
