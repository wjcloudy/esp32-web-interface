#include <unity.h>
#include <WString.h>
#include <map>
#include <memory>
#include <vector>
#include <cmath>
#include <cctype>
#include <cstdio>
#include "serial_cli.h"

struct Node { std::string path, bytes; bool directory = false; };
static std::map<std::string, std::shared_ptr<Node>> files;
static size_t maxWrite;
class File {
  std::shared_ptr<Node> node;
  size_t offset = 0, entry = 0;
public:
  File() = default;
  explicit File(std::shared_ptr<Node> n) : node(n) {}
  explicit operator bool() const { return bool(node); }
  bool isDirectory() const { return node && node->directory; }
  const char* name() const { return node->path.c_str(); }
  uint32_t size() const { return node ? node->bytes.size() : 0; }
  unsigned long getLastWrite() const { return 123; }
  void flush() {}
  void close() { node.reset(); }
  bool seek(uint32_t p) { offset = p; return p <= size(); }
  size_t read(uint8_t* out, size_t n) { n = std::min(n, node->bytes.size() - offset); memcpy(out, node->bytes.data() + offset, n); offset += n; return n; }
  size_t print(const String& s) { size_t n = std::min<size_t>(s.length(), maxWrite); node->bytes.append(s.c_str(), n); return n; }
  File openNextFile() {
    if (entry >= files.size()) return File();
    auto i = files.begin(); std::advance(i, entry++); return File(i->second);
  }
};
constexpr int FILE_READ = 0, FILE_WRITE = 1, SD_AVAILABLE = 1, WL_CONNECTED = 3;
static uint64_t freeBytes;
struct FakeSd {
  uint64_t totalBytes() const { return 64000000000ULL; }
  uint64_t usedBytes() const { return totalBytes() - freeBytes; }
  bool exists(const String& path) { return files.count(path.std()); }
  void end() {}
  File open(const String& path, int mode = FILE_READ) {
    if (path == "/") return File(std::make_shared<Node>(Node{"/", "", true}));
    auto i = files.find(path.std());
    if (i == files.end() && mode == FILE_WRITE) i = files.emplace(path.std(), std::make_shared<Node>(Node{path.std(), "", false})).first;
    return i == files.end() ? File() : File(i->second);
  }
} SD_MMC;
static bool haveSDCard, sdEnabled, sdInitDone, sdInitRunning, fastLoggingActive, canMode;
static int startLogAttempt;
static uint32_t clockMs;
uint32_t millis() { return clockMs; }
struct { int softAPgetStationNum() const { return 0; } int status() const { return WL_CONNECTED; } } WiFi;
static bool startSdMount() { return true; }
static void saveSettings() {}
static bool canDriverIsRunning() { return true; }
static bool canFwBusy() { return false; }
static bool canParamCacheLoaded;
static bool canDownloadParamCache() { return true; }
static uint8_t canNodeId = 33;
static String jsonEscape(const String& s) { return s; } // fixture paths contain no escapes
static bool canVirtualFind(const String&, float*) { return false; }
static int canGetParamId(const String& name) { return name == "version" ? 2001 : name == "canspeed" ? 1 : -1; }
static uint16_t canParamIndex(int id) { return 0x2100 | (id >> 8); }
static uint8_t canParamSubIndex(int id) { return id & 255; }
static bool readOk;
struct CanSdoResult { bool ok; int32_t value; };
static CanSdoResult canSdoReadChecked(uint8_t, uint16_t, uint8_t) { return {readOk, 128}; }
static float canDecodeValue(int32_t raw) { return raw / 32.0f; }
#include "serial_sd_console.h"
void binaryLoggingStart() { fastLoggingActive = true; }
void binaryLoggingStop() { fastLoggingActive = false; }

void setUp() {
  consoleCsvStop(); files.clear(); maxWrite = SIZE_MAX; freeBytes = 1000000;
  haveSDCard = sdEnabled = sdInitDone = canMode = readOk = canParamCacheLoaded = true;
  sdInitRunning = fastLoggingActive = false; consoleLogAuto = true;
  consoleLogError = consoleLogPath = ""; clockMs = 100;
}
void tearDown() { consoleCsvStop(); }
static String command(const char* input, bool& ok) {
  char line[1025]; strncpy(line, input, sizeof(line)); serialcli::Words words;
  TEST_ASSERT_TRUE(words.parse(line)); ok = false;
  return words.is(0, "sd") ? consoleSd(words, ok) : consoleLog(words, ok);
}
static void test_sd_read_bounds_crc_and_busy() {
  files["/a.bin"] = std::make_shared<Node>(Node{"/a.bin", "123456789", false}); bool ok;
  String result = command("sd read /a.bin 0 1024", ok);
  TEST_ASSERT_TRUE(ok); TEST_ASSERT_TRUE(result.indexOf("cbf43926") >= 0);
  TEST_ASSERT_TRUE(result.indexOf("313233343536373839") >= 0);
  TEST_ASSERT_TRUE(result.indexOf("\"eof\":true") >= 0);
  command("sd read /a.bin 10 1", ok); TEST_ASSERT_FALSE(ok);
  command("sd read /a.bin 0 1025", ok); TEST_ASSERT_FALSE(ok);
  command("sd read /../a.bin 0 1", ok); TEST_ASSERT_FALSE(ok);
  consoleCsvActive = true;
  command("sd read /a.bin 0 1", ok); TEST_ASSERT_FALSE(ok);
}
static void test_status_64bit_and_paginated_list() {
  bool ok; String status = command("sd status", ok);
  TEST_ASSERT_TRUE(ok); TEST_ASSERT_TRUE(status.indexOf("64000000000") >= 0);
  files["/a"] = std::make_shared<Node>(Node{"/a", "a", false});
  files["/b"] = std::make_shared<Node>(Node{"/b", "b", false});
  String first = command("sd list 0 1", ok); TEST_ASSERT_TRUE(ok);
  TEST_ASSERT_TRUE(first.indexOf("/a") >= 0); TEST_ASSERT_TRUE(first.indexOf("\"more\":true") >= 0);
  String last = command("sd list 1 1", ok); TEST_ASSERT_TRUE(last.indexOf("/b") >= 0);
  TEST_ASSERT_TRUE(last.indexOf("\"more\":false") >= 0);
}
static void test_can_csv_records_strict_values_and_stops() {
  bool ok; command("log start 100 version,canspeed", ok); TEST_ASSERT_TRUE(ok);
  std::string path = consoleLogPath.std();
  clockMs += 100; consoleCsvTick();
  TEST_ASSERT_EQUAL_STRING("ms,version,canspeed\n100,4.00000,4.00000\n", files[path]->bytes.c_str());
  TEST_ASSERT_EQUAL(1, consoleCsvRows);
  command("log stop", ok); TEST_ASSERT_TRUE(ok); TEST_ASSERT_FALSE(consoleCsvActive);
  clockMs += 100; consoleCsvTick(); TEST_ASSERT_EQUAL(1, consoleCsvRows);
  TEST_ASSERT_FALSE(consoleLogAuto);
  command("log auto", ok); TEST_ASSERT_TRUE(ok); TEST_ASSERT_TRUE(consoleLogAuto);
}
static void test_can_read_failure_is_nan_not_zero() {
  bool ok; command("log start 100 version", ok); TEST_ASSERT_TRUE(ok);
  readOk = false; clockMs += 100; consoleCsvTick();
  TEST_ASSERT_TRUE(files[consoleLogPath.std()]->bytes.find("100,nan\n") != std::string::npos);
  TEST_ASSERT_EQUAL(1, consoleCsvErrors);
}
static void test_low_space_and_write_failure_do_not_delete_files() {
  bool ok; files["/keep"] = std::make_shared<Node>(Node{"/keep", "original", false});
  freeBytes = 1; command("log start 100 version", ok); TEST_ASSERT_FALSE(ok);
  TEST_ASSERT_EQUAL(1, files.size());
  freeBytes = 1000000; command("log start 100 version", ok); TEST_ASSERT_TRUE(ok);
  maxWrite = 0; clockMs += 100; consoleCsvTick();
  TEST_ASSERT_FALSE(consoleCsvActive); TEST_ASSERT_TRUE(consoleLogError.indexOf("write failed") >= 0);
  TEST_ASSERT_EQUAL_STRING("original", files["/keep"]->bytes.c_str());
}
static void test_invalid_names_intervals_and_no_card() {
  bool ok;
  for (const char* cmd : {"log start 99 version", "log start 60001 version", "log start 100 version,", "log start 100 version,missing", "log start 100 =formula"}) {
    command(cmd, ok); TEST_ASSERT_FALSE(ok); TEST_ASSERT_FALSE(consoleCsvActive); TEST_ASSERT_TRUE(files.empty());
  }
  haveSDCard = false; command("log start 100 version", ok); TEST_ASSERT_FALSE(ok);
  command("sd list", ok); TEST_ASSERT_FALSE(ok);
}
int main() {
  UNITY_BEGIN();
  RUN_TEST(test_sd_read_bounds_crc_and_busy);
  RUN_TEST(test_status_64bit_and_paginated_list);
  RUN_TEST(test_can_csv_records_strict_values_and_stops);
  RUN_TEST(test_can_read_failure_is_nan_not_zero);
  RUN_TEST(test_low_space_and_write_failure_do_not_delete_files);
  RUN_TEST(test_invalid_names_intervals_and_no_card);
  return UNITY_END();
}
