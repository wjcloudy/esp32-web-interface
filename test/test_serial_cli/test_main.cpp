#include <unity.h>
#include <deque>
#include <vector>
#include <cstring>
#include "serial_cli.h"
// Compile the actual protocol implementation against a simulated CAN driver.
#include "../../src/can_protocol.cpp"

static uint32_t clockMs;
static bool sendOk;
static unsigned sends;
static std::deque<twai_message_t> pending;
static std::vector<twai_message_t> replies;
static twai_message_t sent;
uint32_t millis() { return clockMs; }
void delay(uint32_t ms) { clockMs += ms; }
bool canDriverSend(uint32_t id, const uint8_t* data, uint8_t len) {
  ++sends;
  sent.identifier = id; sent.data_length_code = len; memcpy(sent.data, data, len);
  for (const auto& f : replies) pending.push_back(f);
  replies.clear();
  return sendOk;
}
bool canDriverReceive(twai_message_t* f) {
  if (pending.empty()) return false;
  *f = pending.front(); pending.pop_front(); return true;
}
void setUp() { clockMs = 0; sendOk = true; sends = 0; pending.clear(); replies.clear(); sent = {}; }
void tearDown() {}
static twai_message_t response(uint8_t cmd, uint32_t value = 0) {
  twai_message_t f; f.identifier = 0x585; f.data_length_code = 8;
  f.data[0] = cmd; f.data[1] = 0x34; f.data[2] = 0x21; f.data[3] = 7;
  memcpy(f.data + 4, &value, 4); return f;
}

static void test_lines() {
  serialcli::LineBuffer b;
  for (size_t i = 0; i < serialcli::MAX_LINE; ++i) TEST_ASSERT_EQUAL(b.NONE, b.push('x'));
  TEST_ASSERT_EQUAL(b.READY, b.push('\r'));
  TEST_ASSERT_EQUAL(serialcli::MAX_LINE, strlen(b.data));
  TEST_ASSERT_EQUAL(b.NONE, b.push('\n'));
  // An overlong line with a valid destructive suffix is discarded in full.
  for (size_t i = 0; i < serialcli::MAX_LINE + 20; ++i) b.push('x');
  for (char c : "auth reset") if (c) b.push(c);
  TEST_ASSERT_EQUAL(b.REJECTED, b.push('\n'));
  for (char c : "help") if (c) b.push(c);
  TEST_ASSERT_EQUAL(b.READY, b.push('\n'));
  TEST_ASSERT_EQUAL_STRING("help", b.data);
  b.push('a'); b.push(0); b.push('b');
  TEST_ASSERT_EQUAL(b.REJECTED, b.push('\n'));
  b.push('a'); b.push('\b'); b.push('b'); b.push('\n');
  TEST_ASSERT_EQUAL_STRING("b", b.data);
}
static void test_framing() {
  char line[] = "  @oi 4294967295  set\tudcmin 12.5  ";
  serialcli::Words w;
  TEST_ASSERT_TRUE(w.parse(line));
  TEST_ASSERT_EQUAL_UINT32(UINT32_MAX, w.id);
  TEST_ASSERT_EQUAL(3, w.count);
  TEST_ASSERT_TRUE(w.is(0, "set"));
  TEST_ASSERT_EQUAL_STRING("12.5", w.args[2]);
  char bad[] = "@oi -1 stop"; serialcli::Words b;
  TEST_ASSERT_FALSE(b.parse(bad));
  char many[] = "a b c d e f g h i j k l m"; serialcli::Words m;
  TEST_ASSERT_FALSE(m.parse(many));
}
static void test_numbers() {
  uint32_t n; int32_t v;
  TEST_ASSERT_TRUE(serialcli::number("010", 127, n)); TEST_ASSERT_EQUAL(10, n);
  TEST_ASSERT_TRUE(serialcli::number("0x7f", 127, n)); TEST_ASSERT_EQUAL(127, n);
  for (const char* s : {"-1", "+1", "1x", "128", "0x", "", "42949672960"})
    TEST_ASSERT_FALSE(serialcli::number(s, 127, n));
  TEST_ASSERT_TRUE(serialcli::integer("-2147483648", INT32_MIN, INT32_MAX, v)); TEST_ASSERT_EQUAL_INT32(INT32_MIN, v);
  TEST_ASSERT_FALSE(serialcli::integer("2147483648", INT32_MIN, INT32_MAX, v));
  TEST_ASSERT_TRUE(serialcli::fixed32("-12.5", v)); TEST_ASSERT_EQUAL_INT32(-400, v);
  TEST_ASSERT_TRUE(serialcli::fixed32("67108863.96875", v)); TEST_ASSERT_EQUAL_INT32(INT32_MAX, v);
  TEST_ASSERT_TRUE(serialcli::fixed32("-67108864", v)); TEST_ASSERT_EQUAL_INT32(INT32_MIN, v);
  for (const char* s : {"NaN", "inf", "1abc", "1e999", "67108864", "-67108865", ""})
    TEST_ASSERT_FALSE(serialcli::fixed32(s, v));
}
static void test_hex_and_crc() {
  uint8_t bytes[3]; size_t n;
  TEST_ASSERT_TRUE(serialcli::hexBytes("00aAFF", bytes, 3, n)); TEST_ASSERT_EQUAL(3, n);
  TEST_ASSERT_EQUAL_HEX8(0xaa, bytes[1]);
  TEST_ASSERT_FALSE(serialcli::hexBytes("0", bytes, 3, n));
  TEST_ASSERT_FALSE(serialcli::hexBytes("gg", bytes, 3, n));
  TEST_ASSERT_FALSE(serialcli::hexBytes("00000000", bytes, 3, n));
  const uint8_t text[] = "123456789";
  auto crc = serialcli::crc32(0xffffffffU, text, 4);
  crc = serialcli::crc32(crc, text + 4, 5) ^ 0xffffffffU;
  TEST_ASSERT_EQUAL_HEX32(0xcbf43926, crc);
}
static void test_sdo_read_matching() {
  pending.push_back(response(0x43, 999)); // stale frame must not win
  auto f = response(0x43, 99); f.identifier = 0x586; replies.push_back(f);
  f = response(0x43, 99); f.data[3] = 8; replies.push_back(f);
  f = response(0x43, 99); f.extd = true; replies.push_back(f);
  f = response(0x43, 99); f.rtr = true; replies.push_back(f);
  replies.push_back(response(0x43, static_cast<uint32_t>(-400)));
  auto r = canSdoReadChecked(5, 0x2134, 7);
  TEST_ASSERT_TRUE(r.ok); TEST_ASSERT_EQUAL_INT32(-400, r.value);
  TEST_ASSERT_EQUAL(4, r.size); TEST_ASSERT_EQUAL_HEX32(0x605, sent.identifier);
  TEST_ASSERT_EQUAL_HEX8(0x40, sent.data[0]);
}
static void test_sdo_widths() {
  for (unsigned n = 1; n <= 4; ++n) {
    replies.push_back(response(0x43 | ((4 - n) << 2), 0x12345678));
    auto r = canSdoReadChecked(5, 0x2134, 7);
    TEST_ASSERT_TRUE(r.ok); TEST_ASSERT_EQUAL(n, r.size);
    uint32_t mask = n == 4 ? UINT32_MAX : (1U << (n * 8)) - 1;
    TEST_ASSERT_EQUAL_HEX32(0x12345678 & mask, r.value);
  }
}
static void test_sdo_write_ack_matching() {
  auto f = response(0x60); f.data[1] = 0x35; replies.push_back(f);
  replies.push_back(response(0x60));
  auto r = canSdoWriteConfirmed(5, 0x2134, 7, -400);
  TEST_ASSERT_TRUE(r.ok); TEST_ASSERT_EQUAL_HEX8(0x23, sent.data[0]);
  int32_t value; memcpy(&value, sent.data + 4, 4); TEST_ASSERT_EQUAL_INT32(-400, value);
}
static void test_sdo_failures() {
  replies.push_back(response(0x80, 0x06090030));
  auto r = canSdoWriteConfirmed(5, 0x2134, 7, 10);
  TEST_ASSERT_FALSE(r.ok); TEST_ASSERT_EQUAL_HEX32(0x06090030, r.abortCode);
  TEST_ASSERT_EQUAL_STRING("sdo_abort", r.error);
  auto f = response(0x43); f.data_length_code = 4; replies.push_back(f);
  r = canSdoReadChecked(5, 0x2134, 7); TEST_ASSERT_FALSE(r.ok);
  TEST_ASSERT_EQUAL_STRING("bad_response", r.error);
  replies.push_back(response(0x60));
  r = canSdoReadChecked(5, 0x2134, 7); TEST_ASSERT_FALSE(r.ok);
  clockMs = UINT32_MAX - 10;
  r = canSdoReadChecked(5, 0x2134, 7, 25); TEST_ASSERT_FALSE(r.ok);
  TEST_ASSERT_EQUAL_STRING("timeout", r.error); TEST_ASSERT_EQUAL(14, clockMs);
  sendOk = false;
  r = canSdoWriteConfirmed(5, 0x2134, 7, 0); TEST_ASSERT_FALSE(r.ok);
  TEST_ASSERT_EQUAL_STRING("send_failed", r.error);
  unsigned before = sends;
  r = canSdoReadChecked(0, 0x2134, 7); TEST_ASSERT_FALSE(r.ok);
  TEST_ASSERT_EQUAL(before, sends);
}
int main() {
  UNITY_BEGIN();
  RUN_TEST(test_lines); RUN_TEST(test_framing); RUN_TEST(test_numbers); RUN_TEST(test_hex_and_crc);
  RUN_TEST(test_sdo_read_matching); RUN_TEST(test_sdo_widths); RUN_TEST(test_sdo_write_ack_matching); RUN_TEST(test_sdo_failures);
  return UNITY_END();
}
