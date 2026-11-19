#include <unity.h>
#include <algorithm>
#include <deque>
#include <string>
#include <vector>
#include "can_transfer_sink.h"
#include "../../src/can_protocol.cpp"

static uint32_t clockMs;
static bool txOk;
static std::deque<twai_message_t> incoming, script;
static unsigned requests;
uint32_t millis() { return clockMs; }
void delay(uint32_t ms) { clockMs += ms; }
bool canDriverSend(uint32_t, const uint8_t*, uint8_t) {
  ++requests;
  if (!script.empty()) { incoming.push_back(script.front()); script.pop_front(); }
  return txOk;
}
bool canDriverReceive(twai_message_t* frame) {
  if (incoming.empty()) return false;
  *frame = incoming.front(); incoming.pop_front(); return true;
}
void setUp() { clockMs = 0; txOk = true; incoming.clear(); script.clear(); requests = 0; }
void tearDown() {}

struct ConstrainedText {
  std::string value;
  uint32_t allocationLimit = 49151;
  uint32_t reserved = 0, largestRequest = 0, reserves = 0;
  int writesLeft = -1;
  ConstrainedText& operator=(const char* s) { value = s; return *this; }
  size_t length() const { return value.size(); }
  bool reserve(uint32_t n) {
    largestRequest = std::max(largestRequest, n); ++reserves;
    if (n > allocationLimit) return false;
    reserved = n; value.reserve(n); return true;
  }
  bool concat(const char* data, unsigned n) {
    if (writesLeft == 0 || value.size() + n > reserved) return false;
    if (writesLeft > 0) --writesLeft;
    value.append(data, n); return true;
  }
};

static twai_message_t frame(uint8_t command) {
  twai_message_t f; f.identifier = 0x5a1; f.data_length_code = 8; f.data[0] = command;
  return f;
}
static void upload(const std::string& data, bool hint = true) {
  auto init = frame(hint ? 0x41 : 0x40);
  init.data[1] = 1; init.data[2] = 0x50;
  uint32_t size = data.size(); memcpy(init.data + 4, &size, 4);
  script.push_back(init);
  bool toggle = false;
  for (size_t pos = 0; pos < data.size(); pos += 7) {
    uint8_t n = std::min<size_t>(7, data.size() - pos);
    bool last = pos + n == data.size();
    auto segment = frame((toggle ? 0x10 : 0) | (last ? 1 | ((7 - n) << 1) : 0));
    memcpy(segment.data + 1, data.data() + pos, n); script.push_back(segment);
    toggle = !toggle;
  }
}
static uint32_t read(const CanSdoSink& sink, bool& complete, uint32_t limit = 49151) {
  return canSdoReadSegmentedTo(33, 0x5001, sink, limit, 5, &complete);
}

static void test_repeated_database_below_48k_allocation_threshold() {
  const std::string database = "{" + std::string(20500, 'x') + "}";
  for (int i = 0; i < 20; ++i) {
    ConstrainedText text; text.allocationLimit = 32768;
    CanTextSink<ConstrainedText> sink(text, 49151);
    upload(database); bool complete = false;
    TEST_ASSERT_EQUAL_UINT32(database.size(), read(sink.sink(), complete));
    TEST_ASSERT_TRUE(complete); TEST_ASSERT_EQUAL_STRING(database.c_str(), text.value.c_str());
    TEST_ASSERT_EQUAL_UINT32(database.size(), text.largestRequest);
    TEST_ASSERT_EQUAL_UINT32(1, text.reserves);
  }
}
static void test_unknown_size_grows_in_bounded_blocks() {
  const std::string database(20500, 'x');
  ConstrainedText text; text.allocationLimit = 32768;
  CanTextSink<ConstrainedText> sink(text, 49151);
  upload(database, false); bool complete;
  TEST_ASSERT_EQUAL_UINT32(database.size(), read(sink.sink(), complete));
  TEST_ASSERT_TRUE(complete); TEST_ASSERT_EQUAL_UINT32(21504, text.largestRequest);
  TEST_ASSERT_EQUAL_UINT32(21, text.reserves);
  TEST_ASSERT_EQUAL_STRING(database.c_str(), text.value.c_str());
}
static void test_large_database_and_maximum_size() {
  for (uint32_t size : {40000U, 49151U}) {
    ConstrainedText text; CanTextSink<ConstrainedText> sink(text, 49151);
    std::string data(size, 'x'); upload(data); bool complete;
    TEST_ASSERT_EQUAL_UINT32(size, read(sink.sink(), complete));
    TEST_ASSERT_TRUE(complete); TEST_ASSERT_EQUAL_STRING(data.c_str(), text.value.c_str());
  }
}
static void test_preview_only_retains_24_bytes() {
  std::string data = "{\"parameter\":{\"value\":1}," + std::string(40000, 'x');
  CanPreviewSink<24> preview; upload(data); bool complete;
  TEST_ASSERT_EQUAL_UINT32(data.size(), read(preview.sink(), complete));
  TEST_ASSERT_TRUE(complete); TEST_ASSERT_EQUAL_UINT32(24, preview.length);
  TEST_ASSERT_EQUAL_MEMORY(data.data(), preview.bytes, 24);
}
static void test_sink_reserve_and_append_failures_are_incomplete() {
  ConstrainedText text; text.allocationLimit = 10;
  CanTextSink<ConstrainedText> sink(text, 49151);
  upload(std::string(20, 'x')); bool complete = true;
  TEST_ASSERT_EQUAL_UINT32(0, read(sink.sink(), complete));
  TEST_ASSERT_FALSE(complete); TEST_ASSERT_EQUAL(9, canSegStatus.stage);
  script.clear(); text.allocationLimit = 49151; text.writesLeft = 1;
  upload(std::string(20, 'x'));
  TEST_ASSERT_EQUAL_UINT32(7, read(sink.sink(), complete));
  TEST_ASSERT_FALSE(complete); TEST_ASSERT_EQUAL(9, canSegStatus.stage);
}
static void test_truncated_last_segment_is_not_complete() {
  uint8_t guarded[10]; memset(guarded, 0xa5, sizeof(guarded));
  upload("123456789"); bool complete = true;
  TEST_ASSERT_EQUAL_UINT32(7, canSdoReadSegmented(33, 0x5001, guarded + 1, 8, 5, &complete));
  TEST_ASSERT_FALSE(complete); TEST_ASSERT_EQUAL(8, canSegStatus.stage);
  TEST_ASSERT_EQUAL_HEX8(0xa5, guarded[0]); TEST_ASSERT_EQUAL_HEX8(0xa5, guarded[9]);
  TEST_ASSERT_EQUAL_MEMORY("1234567", guarded + 1, 7);
}
static void test_timeout_toggle_and_abort() {
  upload("123456789"); script.pop_back();
  CanPreviewSink<24> sink; bool complete = true;
  TEST_ASSERT_EQUAL_UINT32(7, read(sink.sink(), complete));
  TEST_ASSERT_FALSE(complete); TEST_ASSERT_EQUAL(6, canSegStatus.stage);
  upload("123456789"); script.back().data[0] ^= 0x10;
  read(sink.sink(), complete); TEST_ASSERT_FALSE(complete); TEST_ASSERT_EQUAL(7, canSegStatus.stage);
  upload("123456789"); script.back().data[0] = 0x80;
  read(sink.sink(), complete); TEST_ASSERT_FALSE(complete); TEST_ASSERT_EQUAL(4, canSegStatus.stage);
}
static void test_expedited_and_buffer_wrapper() {
  auto init = frame(0x4b); init.data[1] = 1; init.data[2] = 0x50;
  init.data[4] = 'O'; init.data[5] = 'K'; script.push_back(init);
  uint8_t bytes[2]; bool complete;
  TEST_ASSERT_EQUAL_UINT32(2, canSdoReadSegmented(33, 0x5001, bytes, 2, 5, &complete));
  TEST_ASSERT_TRUE(complete); TEST_ASSERT_EQUAL_MEMORY("OK", bytes, 2);
  script.push_back(init);
  TEST_ASSERT_EQUAL_UINT32(0, canSdoReadSegmented(33, 0x5001, bytes, 1, 5, &complete));
  TEST_ASSERT_FALSE(complete); TEST_ASSERT_EQUAL(8, canSegStatus.stage);
}
int main() {
  UNITY_BEGIN();
  RUN_TEST(test_repeated_database_below_48k_allocation_threshold);
  RUN_TEST(test_unknown_size_grows_in_bounded_blocks);
  RUN_TEST(test_large_database_and_maximum_size);
  RUN_TEST(test_preview_only_retains_24_bytes);
  RUN_TEST(test_sink_reserve_and_append_failures_are_incomplete);
  RUN_TEST(test_truncated_last_segment_is_not_complete);
  RUN_TEST(test_timeout_toggle_and_abort);
  RUN_TEST(test_expedited_and_buffer_wrapper);
  return UNITY_END();
}
