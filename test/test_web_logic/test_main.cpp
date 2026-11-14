// Native unit tests for src/web_logic.h — the firmware's pure request/reply
// logic, built on the host (pio test -e native). CI also runs these under
// AddressSanitizer + UndefinedBehaviorSanitizer (env native_asan), which is
// what makes the fuzz loops at the bottom meaningful.
#include <unity.h>
#include <climits>
#include <cstdint>
#include <string>
#include <vector>

#include "web_logic.h"

using namespace weblogic;

static void assertStr(const char* expected, const String& actual)
{
  TEST_ASSERT_EQUAL_STRING(expected, actual.c_str());
}

void setUp() {}
void tearDown() {}

// ---- jsonEscape -----------------------------------------------------------

void test_jsonEscape_plain_text_unchanged()
{
  assertStr("Landy 2", jsonEscape("Landy 2"));
  assertStr("", jsonEscape(""));
}

void test_jsonEscape_escapes_quotes_and_backslashes()
{
  assertStr("a\\\"b\\\\c", jsonEscape("a\"b\\c"));
}

void test_jsonEscape_drops_control_characters()
{
  // A raw newline or NUL-adjacent control byte would break the JSON reply
  assertStr("abc", jsonEscape("a\nb\r\tc\x01"));
}

void test_jsonEscape_keeps_utf8()
{
  assertStr("caf\xc3\xa9", jsonEscape("caf\xc3\xa9"));
}

// ---- findArrayEnd ---------------------------------------------------------

void test_findArrayEnd_simple_and_nested()
{
  String j = "{\"a\":[1,[2,3],4],\"b\":2}";
  int open = j.indexOf('[');
  TEST_ASSERT_EQUAL_INT(15, findArrayEnd(j, open));
}

void test_findArrayEnd_ignores_brackets_in_strings()
{
  String j = "[\"]\",\"[\\\"]\"]";
  TEST_ASSERT_EQUAL_INT((int)j.length() - 1, findArrayEnd(j, 0));
}

void test_findArrayEnd_unterminated_or_bad_start()
{
  TEST_ASSERT_EQUAL_INT(-1, findArrayEnd("[1,2", 0));
  TEST_ASSERT_EQUAL_INT(-1, findArrayEnd("[1]", -1));
  TEST_ASSERT_EQUAL_INT(-1, findArrayEnd("[1]", 99));
  // Escape as the very last byte must not read past the end
  TEST_ASSERT_EQUAL_INT(-1, findArrayEnd("[\"\\", 0));
}

// ---- queryParam -----------------------------------------------------------

void test_queryParam_reads_values()
{
  String r = "GET /stream?names=udc,idc&ms=200 HTTP/1.1\r";
  assertStr("udc,idc", queryParam(r, "names"));
  assertStr("200", queryParam(r, "ms"));
}

void test_queryParam_missing_key_or_query()
{
  assertStr("", queryParam("GET /stream?names=a HTTP/1.1", "ms"));
  assertStr("", queryParam("GET /stream HTTP/1.1", "names"));
  assertStr("", queryParam("", "names"));
}

void test_queryParam_matches_whole_keys_only()
{
  // The old indexOf("ms=") picked up "xms=" — a crafted query could set
  // the interval through a different parameter
  assertStr("7", queryParam("GET /stream?xms=5&ms=7 HTTP/1.1", "ms"));
  assertStr("", queryParam("GET /stream?xms=5 HTTP/1.1", "ms"));
  String r = "GET /stream?othernames=x&names=a HTTP/1.1";
  assertStr("a", queryParam(r, "names"));
  assertStr("x", queryParam(r, "othernames"));
}

void test_queryParam_ignores_path_and_stops_at_space()
{
  assertStr("2", queryParam("GET /ms=1?ms=2 HTTP/1.1", "ms"));
  assertStr("", queryParam("GET /stream?ms= HTTP/1.1", "ms"));
  // Without a version the value runs to the end of the line (\r included),
  // which sseNamesValid then refuses
  assertStr("a\r", queryParam("GET /stream?names=a\r", "names"));
}

// ---- SSE input validation -------------------------------------------------

void test_sseNamesValid_accepts_spot_value_names()
{
  TEST_ASSERT_TRUE(sseNamesValid("udc"));
  TEST_ASSERT_TRUE(sseNamesValid("udc,idc,tmp_hs,amp.1,x-y"));
}

void test_sseNamesValid_rejects_command_smuggling()
{
  // Each of these could append a second terminal command or break framing
  const char* bad[] = { "", "udc idc", "udc;reset", "udc\r", "udc\nset x 1", "udc&ms=1",
                        "udc%0a", "udc!", "udc\"", "set fweak 1", "caf\xc3\xa9" };
  for (const char* b : bad) TEST_ASSERT_FALSE_MESSAGE(sseNamesValid(b), b);
}

void test_sseNamesValid_length_limit()
{
  std::string ok(SSE_NAMES_MAX, 'a');
  std::string tooLong(SSE_NAMES_MAX + 1, 'a');
  TEST_ASSERT_TRUE(sseNamesValid(String(ok)));
  TEST_ASSERT_FALSE(sseNamesValid(String(tooLong)));
}

void test_sseIntervalMs_clamps()
{
  TEST_ASSERT_EQUAL_INT(100, sseIntervalMs(0));      // junk/absent toInt()
  TEST_ASSERT_EQUAL_INT(100, sseIntervalMs(-5));
  TEST_ASSERT_EQUAL_INT(100, sseIntervalMs(49));
  TEST_ASSERT_EQUAL_INT(50, sseIntervalMs(50));
  TEST_ASSERT_EQUAL_INT(5000, sseIntervalMs(5000));
  TEST_ASSERT_EQUAL_INT(5000, sseIntervalMs(INT_MAX));
}

// ---- /edit, /cmd, /settings inputs ----------------------------------------

void test_normalizeFsPath()
{
  assertStr("/a.json", normalizeFsPath("a.json"));
  assertStr("/a.json", normalizeFsPath("/a.json"));
  assertStr("/", normalizeFsPath(""));  // handlers refuse "/" as BAD PATH
}

void test_clampRepeat()
{
  TEST_ASSERT_EQUAL_INT(0, clampRepeat(-1));
  TEST_ASSERT_EQUAL_INT(0, clampRepeat(INT_MIN));
  TEST_ASSERT_EQUAL_INT(10, clampRepeat(10));
  TEST_ASSERT_EQUAL_INT(CMD_REPEAT_MAX, clampRepeat(CMD_REPEAT_MAX + 1));
  TEST_ASSERT_EQUAL_INT(CMD_REPEAT_MAX, clampRepeat(INT_MAX));
}

void test_sanitizePin_required()
{
  TEST_ASSERT_EQUAL_INT(0, sanitizePin(0, 3));
  TEST_ASSERT_EQUAL_INT(48, sanitizePin(48, 3));
  TEST_ASSERT_EQUAL_INT(3, sanitizePin(49, 3));
  TEST_ASSERT_EQUAL_INT(3, sanitizePin(-1, 3));
  TEST_ASSERT_EQUAL_INT(3, sanitizePin(INT_MIN, 3));
}

void test_sanitizePin_optional()
{
  TEST_ASSERT_EQUAL_INT(-1, sanitizePin(-1, -1, true));
  TEST_ASSERT_EQUAL_INT(16, sanitizePin(16, -1, true));
  TEST_ASSERT_EQUAL_INT(-1, sanitizePin(-2, -1, true));
  TEST_ASSERT_EQUAL_INT(-1, sanitizePin(49, -1, true));
}

// ---- OTA header -----------------------------------------------------------

static void makeHeader(uint8_t* h, uint32_t fw, uint32_t fs)
{
  memcpy(h, "OIWEBOTA", 8);
  for (int i = 0; i < 4; i++) { h[8 + i] = (fw >> (8 * i)) & 0xff; h[12 + i] = (fs >> (8 * i)) & 0xff; }
}

void test_parseOtaHeader_valid_little_endian()
{
  uint8_t h[OTA_HEADER_LEN];
  uint32_t fw, fs;
  makeHeader(h, 0x00123456, 0x00170000);
  TEST_ASSERT_EQUAL_INT(OTA_HDR_OK, parseOtaHeader(h, fw, fs));
  TEST_ASSERT_EQUAL_HEX32(0x00123456, fw);
  TEST_ASSERT_EQUAL_HEX32(0x00170000, fs);
}

void test_parseOtaHeader_high_bit_lengths_do_not_sign_extend()
{
  uint8_t h[OTA_HEADER_LEN];
  uint32_t fw, fs;
  makeHeader(h, 0xFFFFFFFF, 0x80808080);
  TEST_ASSERT_EQUAL_INT(OTA_HDR_OK, parseOtaHeader(h, fw, fs));
  TEST_ASSERT_EQUAL_HEX32(0xFFFFFFFF, fw);
  TEST_ASSERT_EQUAL_HEX32(0x80808080, fs);
}

void test_parseOtaHeader_rejects_bad_images()
{
  uint8_t h[OTA_HEADER_LEN];
  uint32_t fw, fs;
  makeHeader(h, 100, 100);
  h[0] = 'X';
  TEST_ASSERT_EQUAL_INT(OTA_HDR_BAD_MAGIC, parseOtaHeader(h, fw, fs));
  makeHeader(h, 0, 100);
  TEST_ASSERT_EQUAL_INT(OTA_HDR_BAD_LENGTH, parseOtaHeader(h, fw, fs));
  makeHeader(h, 100, 0);
  TEST_ASSERT_EQUAL_INT(OTA_HDR_BAD_LENGTH, parseOtaHeader(h, fw, fs));
}

// ---- readReply (UART reply framing) ---------------------------------------

// Scripted inverter: each readChunk() returns the next script entry
// ("" = silence → 0, "\x01ERR" = driver error → -1) and records the timeout
// it was asked to wait.
struct FakePort {
  std::vector<std::string> script;
  size_t next = 0;
  std::vector<int> waits;
  int repeats = 0;

  int readChunk(char* buf, size_t size, int timeout) {
    waits.push_back(timeout);
    if (next >= script.size()) return 0;
    const std::string& s = script[next++];
    if (s == "\x01" "ERR") return -1;
    size_t n = s.size() < size ? s.size() : size;
    memcpy(buf, s.data(), n);
    return (int)n;
  }
  void triggerRepeat() { repeats++; }
};

static const int LONG = 100, IDLE = 10;

void test_readReply_multi_chunk_reply_ends_on_silence()
{
  FakePort p;
  p.script = { "1.5\r\n2.", "5\r\n", "" };
  assertStr("1.5\r\n2.5\r\n", readReply(p, 0, LONG, IDLE));
  // Only the first read may wait the long timeout — the old code paid it
  // at the end of every reply
  int expected[] = { LONG, IDLE, IDLE };
  TEST_ASSERT_EQUAL_INT(3, (int)p.waits.size());
  TEST_ASSERT_EQUAL_INT_ARRAY(expected, p.waits.data(), 3);
}

void test_readReply_silent_inverter()
{
  FakePort p;
  assertStr("", readReply(p, 0, LONG, IDLE));
  TEST_ASSERT_EQUAL_INT(1, (int)p.waits.size());
  TEST_ASSERT_EQUAL_INT(LONG, p.waits[0]);
}

void test_readReply_repeat_collects_each_sample()
{
  FakePort p;
  p.script = { "1\r\n", "2\r\n", "3\r\n", "" };
  assertStr("1\r\n2\r\n3\r\n", readReply(p, 2, LONG, IDLE));
  TEST_ASSERT_EQUAL_INT(2, p.repeats);
  // Each repetition gets the long wait to start; the end only an idle one
  int expected[] = { LONG, LONG, LONG, IDLE };
  TEST_ASSERT_EQUAL_INT(4, (int)p.waits.size());
  TEST_ASSERT_EQUAL_INT_ARRAY(expected, p.waits.data(), 4);
}

void test_readReply_stops_when_repeats_go_unanswered()
{
  FakePort p;
  p.script = { "1\r\n", "" };
  assertStr("1\r\n", readReply(p, 100, LONG, IDLE));
  TEST_ASSERT_EQUAL_INT(2, p.repeats);  // no runaway loop on a dead link
}

void test_readReply_driver_error_ends_reply()
{
  FakePort p;
  p.script = { "ok", "\x01" "ERR", "never read" };
  assertStr("ok", readReply(p, 0, LONG, IDLE));
}

void test_readReply_oversized_chunk_is_bounded()
{
  FakePort p;
  p.script = { std::string(1000, 'x'), "" };
  String out = readReply(p, 0, LONG, IDLE);
  TEST_ASSERT_EQUAL_INT(255, (int)out.length());  // buffer-sized, no overflow
}

// ---- fuzz (deterministic) -------------------------------------------------
// Random byte strings through every parser. Assertions check invariants;
// the sanitizer build turns any out-of-bounds access or UB into a failure.

static uint32_t rngState = 0x12345678;
static uint32_t rnd() { rngState ^= rngState << 13; rngState ^= rngState >> 17; rngState ^= rngState << 5; return rngState; }

static String randomString(size_t maxLen)
{
  static const char interesting[] = "[]\"\\?&= ,._-/\r\n";
  std::string s;
  size_t n = rnd() % (maxLen + 1);
  for (size_t i = 0; i < n; i++) {
    uint32_t r = rnd();
    s += (r & 1) ? interesting[(r >> 1) % (sizeof(interesting) - 1)] : (char)(r >> 8);
  }
  return String(s);
}

void test_fuzz_parsers_hold_invariants()
{
  for (int iter = 0; iter < 20000; iter++) {
    String in = randomString(300);

    String esc = jsonEscape(in);
    for (unsigned int i = 0; i < esc.length(); i++) {
      TEST_ASSERT_TRUE((uint8_t)esc[i] >= 0x20);
      if (esc[i] == '\\') { i++; TEST_ASSERT_TRUE(esc[i] == '"' || esc[i] == '\\'); }
      else TEST_ASSERT_TRUE(esc[i] != '"');
    }

    int start = (int)(rnd() % (in.length() + 2)) - 1;
    int end = findArrayEnd(in, start);
    if (end >= 0) {
      TEST_ASSERT_TRUE(end < (int)in.length());
      TEST_ASSERT_EQUAL_CHAR(']', in[end]);
    }

    String v = queryParam("GET /s?" + in + " HTTP/1.1", "names");
    TEST_ASSERT_TRUE(v.indexOf('&') < 0 && v.indexOf(' ') < 0);

    if (sseNamesValid(in)) {
      TEST_ASSERT_TRUE(in.length() > 0 && in.length() <= SSE_NAMES_MAX);
      TEST_ASSERT_TRUE(in.indexOf(' ') < 0 && in.indexOf('\r') < 0 && in.indexOf('\n') < 0);
    }

    TEST_ASSERT_TRUE(normalizeFsPath(in).startsWith("/"));

    int pin = (int)rnd();
    int sp = sanitizePin(pin, 3);
    TEST_ASSERT_TRUE(sp >= 0 && sp <= GPIO_MAX);
    int op = sanitizePin(pin, -1, true);
    TEST_ASSERT_TRUE(op >= -1 && op <= GPIO_MAX);
    int rp = clampRepeat(pin);
    TEST_ASSERT_TRUE(rp >= 0 && rp <= CMD_REPEAT_MAX);

    uint8_t hdr[OTA_HEADER_LEN];
    for (size_t i = 0; i < OTA_HEADER_LEN; i++) hdr[i] = (uint8_t)rnd();
    if (iter & 1) memcpy(hdr, "OIWEBOTA", 8);
    uint32_t fw, fs;
    if (parseOtaHeader(hdr, fw, fs) == OTA_HDR_OK) TEST_ASSERT_TRUE(fw > 0 && fs > 0);
  }
}

void test_fuzz_readReply_terminates_and_bounds_output()
{
  for (int iter = 0; iter < 2000; iter++) {
    FakePort p;
    size_t chunks = rnd() % 8;
    for (size_t c = 0; c < chunks; c++) {
      uint32_t r = rnd() % 10;
      if (r == 0) p.script.push_back("");
      else if (r == 1) p.script.push_back("\x01" "ERR");
      else p.script.push_back(std::string(rnd() % 600, 'v'));
    }
    int repeat = (int)(rnd() % (CMD_REPEAT_MAX + 1));
    String out = readReply(p, repeat, LONG, IDLE);
    // One read per script entry at most, plus the final silent one
    TEST_ASSERT_TRUE(p.waits.size() <= p.script.size() + 1);
    TEST_ASSERT_TRUE(out.length() <= 255 * p.script.size());
    TEST_ASSERT_TRUE(p.repeats <= repeat);
  }
}

// ---- config kept across OTA -----------------------------------------------

void test_cfgNvsKey_only_for_mirrored_files()
{
  TEST_ASSERT_EQUAL_STRING("settings", cfgNvsKey("/settings.json"));
  TEST_ASSERT_EQUAL_STRING("settings", cfgNvsKey("settings.json"));   // upload names have no '/'
  TEST_ASSERT_EQUAL_STRING("uiprefs", cfgNvsKey("/uiprefs.json"));
  TEST_ASSERT_NULL(cfgNvsKey("/gauges.json"));                         // layouts: too big, UI handles them
  TEST_ASSERT_NULL(cfgNvsKey("/settings.json.bak"));
  TEST_ASSERT_NULL(cfgNvsKey("//settings.json"));
  TEST_ASSERT_NULL(cfgNvsKey(""));
  TEST_ASSERT_NULL(cfgNvsKey(nullptr));
  for (const CfgMirrorFile& f : CFG_MIRRORED) TEST_ASSERT_TRUE(strlen(f.nvsKey) <= 15); // NVS key limit
}

void test_cfgSyncAction_restores_what_an_update_erased()
{
  // After OTA: file gone, copy in NVS -> write it back
  TEST_ASSERT_EQUAL_INT(CFG_SYNC_RESTORE_FILE, cfgSyncAction(false, 0, true, false));
  // Never saved anywhere -> nothing to do (defaults apply)
  TEST_ASSERT_EQUAL_INT(CFG_SYNC_NONE, cfgSyncAction(false, 0, false, false));
}

void test_cfgSyncAction_file_wins_when_present()
{
  // First boot on this firmware (settings from older firmware) or a backup
  // restored through the Files tab -> it becomes the kept copy
  TEST_ASSERT_EQUAL_INT(CFG_SYNC_SAVE_TO_NVS, cfgSyncAction(true, 200, false, false));
  TEST_ASSERT_EQUAL_INT(CFG_SYNC_SAVE_TO_NVS, cfgSyncAction(true, 200, true, false));
  TEST_ASSERT_EQUAL_INT(CFG_SYNC_NONE, cfgSyncAction(true, 200, true, true));
  // Empty or oversized files are never mirrored (or allowed to clobber NVS)
  TEST_ASSERT_EQUAL_INT(CFG_SYNC_NONE, cfgSyncAction(true, 0, true, false));
  TEST_ASSERT_EQUAL_INT(CFG_SYNC_NONE, cfgSyncAction(true, CFG_MIRROR_MAX + 1, true, false));
  TEST_ASSERT_EQUAL_INT(CFG_SYNC_SAVE_TO_NVS, cfgSyncAction(true, CFG_MIRROR_MAX, false, false));
}

void test_parseHttpUrl_release_and_cdn_urls()
{
  HttpUrl u;
  TEST_ASSERT_TRUE(parseHttpUrl("https://github.com/wjcloudy/esp32-web-interface/releases/download/v4.28/esp32_v4.28-ota.bin", u));
  TEST_ASSERT_TRUE(u.https);
  TEST_ASSERT_EQUAL_STRING("github.com", u.host.c_str());
  TEST_ASSERT_EQUAL_UINT16(443, u.port);
  TEST_ASSERT_EQUAL_STRING("/wjcloudy/esp32-web-interface/releases/download/v4.28/esp32_v4.28-ota.bin", u.path.c_str());
  // The CDN redirect carries a long signed query string
  std::string sig(900, 'a');
  TEST_ASSERT_TRUE(parseHttpUrl(String(("https://release-assets.githubusercontent.com/x/1?sp=r&sig=" + sig).c_str()), u));
  TEST_ASSERT_EQUAL_STRING("release-assets.githubusercontent.com", u.host.c_str());
  TEST_ASSERT_EQUAL_UINT32(strlen("/x/1?sp=r&sig=") + 900, u.path.length());
}

void test_parseHttpUrl_ports_and_bare_hosts()
{
  HttpUrl u;
  TEST_ASSERT_TRUE(parseHttpUrl("http://192.168.1.10:8080/fw.bin", u));
  TEST_ASSERT_FALSE(u.https);
  TEST_ASSERT_EQUAL_STRING("192.168.1.10", u.host.c_str());
  TEST_ASSERT_EQUAL_UINT16(8080, u.port);
  TEST_ASSERT_EQUAL_STRING("192.168.1.10:8080", httpHostHeader(u).c_str());
  TEST_ASSERT_TRUE(parseHttpUrl("http://nas", u));
  TEST_ASSERT_EQUAL_UINT16(80, u.port);
  TEST_ASSERT_EQUAL_STRING("/", u.path.c_str());
  TEST_ASSERT_EQUAL_STRING("nas", httpHostHeader(u).c_str());
  TEST_ASSERT_TRUE(parseHttpUrl("https://nas?f=1", u));
  TEST_ASSERT_EQUAL_STRING("/?f=1", u.path.c_str());
}

void test_parseHttpUrl_rejects_what_it_cannot_request()
{
  HttpUrl u;
  const char* bad[] = {
    "ftp://host/x", "https://", "https:///x", "https://user:pw@host/x", "https://[::1]/x",
    "https://host:/x", "https://host:0/x", "https://host:65536/x", "https://host:80a/x",
    "https://host/a b", "https://host/x\r\nInjected: 1", "https://ho st/x", "HTTPS://host/x",
  };
  for (const char* s : bad) TEST_ASSERT_FALSE_MESSAGE(parseHttpUrl(s, u), s);
}

void test_resolveRedirect_forms()
{
  HttpUrl from;
  TEST_ASSERT_TRUE(parseHttpUrl("https://github.com/a/b", from));
  String next;
  TEST_ASSERT_TRUE(resolveRedirect(from, "https://cdn.example/x?y=1", next));
  TEST_ASSERT_EQUAL_STRING("https://cdn.example/x?y=1", next.c_str());
  TEST_ASSERT_TRUE(resolveRedirect(from, "//cdn.example/x", next));
  TEST_ASSERT_EQUAL_STRING("https://cdn.example/x", next.c_str());
  TEST_ASSERT_TRUE(resolveRedirect(from, "/other", next));
  TEST_ASSERT_EQUAL_STRING("https://github.com/other", next.c_str());
  TEST_ASSERT_TRUE(parseHttpUrl("http://nas:8080/a", from));
  TEST_ASSERT_TRUE(resolveRedirect(from, "/b", next));
  TEST_ASSERT_EQUAL_STRING("http://nas:8080/b", next.c_str());
  TEST_ASSERT_FALSE(resolveRedirect(from, "b", next));
  TEST_ASSERT_FALSE(resolveRedirect(from, "", next));
  TEST_ASSERT_TRUE(httpIsRedirect(302) && httpIsRedirect(301) && httpIsRedirect(307) && httpIsRedirect(308));
  TEST_ASSERT_FALSE(httpIsRedirect(200) || httpIsRedirect(304) || httpIsRedirect(404));
}

void test_http_status_and_headers()
{
  TEST_ASSERT_EQUAL_INT(200, httpStatusCode("HTTP/1.1 200 OK\r"));
  TEST_ASSERT_EQUAL_INT(302, httpStatusCode("HTTP/1.0 302 Found"));
  TEST_ASSERT_EQUAL_INT(204, httpStatusCode("HTTP/1.1 204"));
  TEST_ASSERT_EQUAL_INT(-1, httpStatusCode("HTTP/2 200"));
  TEST_ASSERT_EQUAL_INT(-1, httpStatusCode("HTTP/1.1 2000 OK"));
  TEST_ASSERT_EQUAL_INT(-1, httpStatusCode("HTTP/1.1 20x OK"));
  TEST_ASSERT_EQUAL_INT(-1, httpStatusCode(""));
  String v;
  TEST_ASSERT_TRUE(httpHeader("location:  https://x/y \r", "Location", v));
  TEST_ASSERT_EQUAL_STRING("https://x/y", v.c_str());
  TEST_ASSERT_TRUE(httpHeader("Content-Length: 1234\r", "content-length", v));
  TEST_ASSERT_EQUAL_INT32(1234, httpContentLength(v));
  TEST_ASSERT_FALSE(httpHeader("Content-Length-X: 1\r", "Content-Length", v));
  TEST_ASSERT_FALSE(httpHeader("Content-Lengt: 1\r", "Content-Length", v));
  TEST_ASSERT_TRUE(httpHeader("Location:\r", "Location", v));
  TEST_ASSERT_EQUAL_STRING("", v.c_str());
  TEST_ASSERT_EQUAL_INT32(-1, httpContentLength(""));
  TEST_ASSERT_EQUAL_INT32(-1, httpContentLength("12a"));
  TEST_ASSERT_EQUAL_INT32(-1, httpContentLength("-5"));
  TEST_ASSERT_EQUAL_INT32(-1, httpContentLength("9999999999"));
  TEST_ASSERT_EQUAL_INT32(999999999, httpContentLength("999999999"));
}

int main(int, char**)
{
  UNITY_BEGIN();
  RUN_TEST(test_jsonEscape_plain_text_unchanged);
  RUN_TEST(test_jsonEscape_escapes_quotes_and_backslashes);
  RUN_TEST(test_jsonEscape_drops_control_characters);
  RUN_TEST(test_jsonEscape_keeps_utf8);
  RUN_TEST(test_findArrayEnd_simple_and_nested);
  RUN_TEST(test_findArrayEnd_ignores_brackets_in_strings);
  RUN_TEST(test_findArrayEnd_unterminated_or_bad_start);
  RUN_TEST(test_queryParam_reads_values);
  RUN_TEST(test_queryParam_missing_key_or_query);
  RUN_TEST(test_queryParam_matches_whole_keys_only);
  RUN_TEST(test_queryParam_ignores_path_and_stops_at_space);
  RUN_TEST(test_sseNamesValid_accepts_spot_value_names);
  RUN_TEST(test_sseNamesValid_rejects_command_smuggling);
  RUN_TEST(test_sseNamesValid_length_limit);
  RUN_TEST(test_sseIntervalMs_clamps);
  RUN_TEST(test_normalizeFsPath);
  RUN_TEST(test_clampRepeat);
  RUN_TEST(test_sanitizePin_required);
  RUN_TEST(test_sanitizePin_optional);
  RUN_TEST(test_parseOtaHeader_valid_little_endian);
  RUN_TEST(test_parseOtaHeader_high_bit_lengths_do_not_sign_extend);
  RUN_TEST(test_parseOtaHeader_rejects_bad_images);
  RUN_TEST(test_readReply_multi_chunk_reply_ends_on_silence);
  RUN_TEST(test_readReply_silent_inverter);
  RUN_TEST(test_readReply_repeat_collects_each_sample);
  RUN_TEST(test_readReply_stops_when_repeats_go_unanswered);
  RUN_TEST(test_readReply_driver_error_ends_reply);
  RUN_TEST(test_readReply_oversized_chunk_is_bounded);
  RUN_TEST(test_fuzz_parsers_hold_invariants);
  RUN_TEST(test_fuzz_readReply_terminates_and_bounds_output);
  RUN_TEST(test_cfgNvsKey_only_for_mirrored_files);
  RUN_TEST(test_cfgSyncAction_restores_what_an_update_erased);
  RUN_TEST(test_cfgSyncAction_file_wins_when_present);
  RUN_TEST(test_parseHttpUrl_release_and_cdn_urls);
  RUN_TEST(test_parseHttpUrl_ports_and_bare_hosts);
  RUN_TEST(test_parseHttpUrl_rejects_what_it_cannot_request);
  RUN_TEST(test_resolveRedirect_forms);
  RUN_TEST(test_http_status_and_headers);
  return UNITY_END();
}
