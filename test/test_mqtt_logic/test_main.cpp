// Native unit tests for src/mqtt_logic.h: input cleaning, `get` batching and
// matching the inverter's reply to the requested names (pio test -e native;
// CI also runs them under ASan + UBSan).
#include <unity.h>
#include <string>
#include <vector>

#include "mqtt_logic.h"

using namespace mqttlogic;

static void assertStr(const char* expected, const String& actual)
{
  TEST_ASSERT_EQUAL_STRING(expected, actual.c_str());
}

static std::vector<String> names(std::initializer_list<const char*> l)
{
  std::vector<String> v;
  for (const char* s : l) v.push_back(String(s));
  return v;
}

void setUp() {}
void tearDown() {}

// ---- sanitizeNames --------------------------------------------------------

void test_names_separators_become_single_commas()
{
  assertStr("udc,tmphs,speed", sanitizeNames(" udc, tmphs;\n speed ,,"));
  assertStr("udc,tmphs", sanitizeNames("udc\ttmphs"));
  assertStr("", sanitizeNames(" , ;"));
}

void test_names_drop_topic_wildcards_and_levels()
{
  // '+', '#' and '/' would change the topic, so they are not name characters
  assertStr("udc,tmphs", sanitizeNames("u+dc,tmp#hs/"));
  assertStr("opmode.x,a-b_c", sanitizeNames("opmode.x a-b_c"));
}

void test_names_deduplicated()
{
  assertStr("udc,tmphs", sanitizeNames("udc,tmphs,udc,udc"));
}

void test_names_capped_at_a_whole_name()
{
  std::string in;
  for (int i = 0; i < 200; i++) in += "value" + std::to_string(i) + ",";
  String out = sanitizeNames(String(in));
  TEST_ASSERT_TRUE(out.length() <= NAMES_MAX);
  TEST_ASSERT_TRUE(out.length() > NAMES_MAX - 12);
  TEST_ASSERT_TRUE(out[out.length() - 1] != ',');
  // the last entry is one of the inputs, not a cut-off fragment
  int last = -1;
  for (unsigned int i = 0; i < out.length(); i++) if (out[i] == ',') last = (int)i;
  String tail = out.substring(last + 1);
  TEST_ASSERT_TRUE(tail.startsWith("value"));
  TEST_ASSERT_TRUE(in.find(std::string(tail.c_str()) + ",") != std::string::npos);
}

// ---- sanitizePrefix / tokens ----------------------------------------------

void test_prefix_strips_wildcards_spaces_and_edge_slashes()
{
  assertStr("home/inverter", sanitizePrefix("/home/inverter/"));
  assertStr("home/inv", sanitizePrefix("home/ in+v#\x01"));
  assertStr("", sanitizePrefix("///"));
}

void test_prefix_capped()
{
  std::string in(100, 'a');
  TEST_ASSERT_EQUAL(PREFIX_MAX, sanitizePrefix(String(in)).length());
}

void test_token_keeps_printable_without_spaces()
{
  assertStr("broker.lan", sanitizeToken(" broker.lan \r\n", HOST_MAX));
  assertStr("abc", sanitizeToken("abcdef", 3));
}

void test_secret_keeps_spaces_drops_control_characters()
{
  assertStr("s3cret pass", sanitizeSecret("s3cret pass\r\n"));
  std::string in(100, 'x');
  TEST_ASSERT_EQUAL(PASS_MAX, sanitizeSecret(String(in)).length());
}

void test_clamps()
{
  TEST_ASSERT_EQUAL(1, clampInterval(0));
  TEST_ASSERT_EQUAL(1, clampInterval(-5));
  TEST_ASSERT_EQUAL(30, clampInterval(30));
  TEST_ASSERT_EQUAL(3600, clampInterval(99999));
  TEST_ASSERT_EQUAL(1883, clampPort(0));
  TEST_ASSERT_EQUAL(1883, clampPort(70000));
  TEST_ASSERT_EQUAL(8883, clampPort(8883));
}

// ---- mdnsName -------------------------------------------------------------

void test_mdns_name()
{
  assertStr("homeassistant", mdnsName("homeassistant.local"));
  assertStr("ha", mdnsName("ha.LOCAL"));
  assertStr("", mdnsName(".local"));
  assertStr("", mdnsName("broker.lan"));
  assertStr("", mdnsName("192.168.1.5"));
}

// ---- batching -------------------------------------------------------------

void test_split_names()
{
  std::vector<String> v = splitNames("udc,,tmphs,");
  TEST_ASSERT_EQUAL(2, v.size());
  assertStr("udc", v[0]);
  assertStr("tmphs", v[1]);
  TEST_ASSERT_EQUAL(0, splitNames("").size());
}

void test_batches_stay_within_the_command_limit()
{
  std::vector<String> in;
  for (int i = 0; i < 60; i++) in.push_back(String(("name_" + std::to_string(i)).c_str()));
  std::vector<std::vector<String>> b = batchNames(in);
  TEST_ASSERT_TRUE(b.size() > 1);
  size_t total = 0;
  for (const auto& batch : b) {
    String cmd = "get ";
    cmd += joinNames(batch);
    TEST_ASSERT_TRUE(cmd.length() <= GET_CMD_MAX);
    total += batch.size();
  }
  TEST_ASSERT_EQUAL(in.size(), total); // nothing lost, order kept
  assertStr("name_0", b[0][0]);
}

void test_oversized_name_is_dropped()
{
  std::string big(GET_CMD_MAX, 'a');
  std::vector<std::vector<String>> b = batchNames(names({ "udc", big.c_str(), "tmphs" }));
  TEST_ASSERT_EQUAL(1, b.size());
  TEST_ASSERT_EQUAL(2, b[0].size());
}

// ---- reply matching -------------------------------------------------------

void test_reply_lines_pair_with_names()
{
  MatchResult r = matchUartReply(names({ "udc", "tmphs", "speed" }), "398.50\r\n31.20\r\n-12\r\n");
  TEST_ASSERT_TRUE(r.aligned);
  TEST_ASSERT_EQUAL(3, r.values.size());
  assertStr("udc", r.values[0].name);
  assertStr("398.50", r.values[0].value);
  assertStr("-12", r.values[2].value);
  TEST_ASSERT_EQUAL(0, r.unknown.size());
}

void test_unknown_name_costs_only_its_own_value()
{
  MatchResult r = matchUartReply(names({ "udc", "nosuch", "tmphs" }),
                                 "398.50\r\nUnknown parameter nosuch\r\n31.20\r\n");
  TEST_ASSERT_TRUE(r.aligned);
  TEST_ASSERT_EQUAL(2, r.values.size());
  assertStr("udc", r.values[0].name);
  assertStr("tmphs", r.values[1].name);
  assertStr("31.20", r.values[1].value);
  TEST_ASSERT_EQUAL(1, r.unknown.size());
  assertStr("nosuch", r.unknown[0]);
}

void test_mismatched_reply_is_not_trusted()
{
  // A truncated reply would shift values onto the wrong names
  MatchResult r = matchUartReply(names({ "udc", "tmphs", "speed" }), "398.50\r\n31.20\r\n");
  TEST_ASSERT_FALSE(r.aligned);
  TEST_ASSERT_EQUAL(0, r.values.size());
  TEST_ASSERT_FALSE(matchUartReply(names({ "udc" }), "").aligned);
}

void test_blank_lines_and_padding_ignored()
{
  MatchResult r = matchUartReply(names({ "udc", "tmphs" }), "\r\n  398.5 \r\n\r\n\t31\n");
  TEST_ASSERT_TRUE(r.aligned);
  TEST_ASSERT_EQUAL(2, r.values.size());
  assertStr("398.5", r.values[0].value);
  assertStr("31", r.values[1].value);
}

void test_is_number()
{
  TEST_ASSERT_TRUE(isNumber("0"));
  TEST_ASSERT_TRUE(isNumber("-1.25"));
  TEST_ASSERT_TRUE(isNumber("1e3"));
  TEST_ASSERT_FALSE(isNumber(""));
  TEST_ASSERT_FALSE(isNumber("1.2abc"));
  TEST_ASSERT_FALSE(isNumber("Unknown"));
  TEST_ASSERT_FALSE(isNumber("nan"));
  TEST_ASSERT_FALSE(isNumber("inf"));
}

// ---- settings.json fields -------------------------------------------------

void test_json_fields()
{
  String j = "{\"dev_name\":\"x\",\"mqtt_enabled\":true,\"mqtt_host\":\"b\\\"r\\\\k\",\"mqtt_port\":8883,"
             "\"mqtt_retain\":false,\"mqtt_interval\":\"oops\"}";
  TEST_ASSERT_TRUE(jsonBool(j, "mqtt_enabled"));
  TEST_ASSERT_FALSE(jsonBool(j, "mqtt_retain"));
  assertStr("b\"r\\k", jsonStr(j, "mqtt_host"));
  assertStr("", jsonStr(j, "mqtt_user"));
  TEST_ASSERT_EQUAL(8883, jsonNum(j, "mqtt_port", 1883));
  TEST_ASSERT_EQUAL(5, jsonNum(j, "mqtt_interval", 5)); // not a number
  TEST_ASSERT_EQUAL(5, jsonNum(j, "absent", 5));
}

void test_value_topic()
{
  assertStr("openinverter/inverter/udc", valueTopic("openinverter/inverter", "udc"));
}

// Fuzz: arbitrary bytes through every parser must not crash (ASan/UBSan in CI)
void test_fuzz_parsers()
{
  unsigned int seed = 12345;
  for (int iter = 0; iter < 2000; iter++) {
    std::string s;
    int len = (int)((seed = seed * 1103515245u + 12345u) >> 16) % 300;
    for (int i = 0; i < len; i++) s += (char)(((seed = seed * 1103515245u + 12345u) >> 16) & 0xFF);
    String in(s);
    sanitizeNames(in);
    sanitizePrefix(in);
    sanitizeToken(in, HOST_MAX);
    sanitizeSecret(in);
    mdnsName(in);
    batchNames(splitNames(in));
    matchUartReply(names({ "a", "b" }), in);
    jsonStr(in, "mqtt_host");
    jsonNum(in, "mqtt_port", 1);
  }
  TEST_PASS();
}

int main(int, char**)
{
  UNITY_BEGIN();
  RUN_TEST(test_names_separators_become_single_commas);
  RUN_TEST(test_names_drop_topic_wildcards_and_levels);
  RUN_TEST(test_names_deduplicated);
  RUN_TEST(test_names_capped_at_a_whole_name);
  RUN_TEST(test_prefix_strips_wildcards_spaces_and_edge_slashes);
  RUN_TEST(test_prefix_capped);
  RUN_TEST(test_token_keeps_printable_without_spaces);
  RUN_TEST(test_secret_keeps_spaces_drops_control_characters);
  RUN_TEST(test_clamps);
  RUN_TEST(test_mdns_name);
  RUN_TEST(test_split_names);
  RUN_TEST(test_batches_stay_within_the_command_limit);
  RUN_TEST(test_oversized_name_is_dropped);
  RUN_TEST(test_reply_lines_pair_with_names);
  RUN_TEST(test_unknown_name_costs_only_its_own_value);
  RUN_TEST(test_mismatched_reply_is_not_trusted);
  RUN_TEST(test_blank_lines_and_padding_ignored);
  RUN_TEST(test_is_number);
  RUN_TEST(test_json_fields);
  RUN_TEST(test_value_topic);
  RUN_TEST(test_fuzz_parsers);
  return UNITY_END();
}
