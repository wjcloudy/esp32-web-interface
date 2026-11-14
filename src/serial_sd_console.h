#pragma once
// Included after CAN services and before the main serial command dispatcher.
static bool consoleLogAuto = true;
static bool consoleCsvActive = false;
static File consoleCsvFile;
static String consoleLogPath, consoleLogError;
static String consoleCsvNames[16];
static uint8_t consoleCsvCount = 0;
static uint32_t consoleCsvInterval = 1000, consoleCsvLast = 0, consoleCsvStart = 0;
static uint32_t consoleCsvRows = 0, consoleCsvErrors = 0, consoleCsvFlush = 0;
void binaryLoggingStart();
void binaryLoggingStop();
static bool consoleSdLoggerActive() { return consoleCsvActive || fastLoggingActive; }

static void consoleCsvStop() {
  if (consoleCsvFile) { consoleCsvFile.flush(); consoleCsvFile.close(); }
  consoleCsvActive = false;
}

static String consoleLogStatus() {
  return "{\"active\":" + String(consoleCsvActive || fastLoggingActive ? "true" : "false") +
    ",\"mode\":\"" + (consoleCsvActive ? String("can_csv") : fastLoggingActive ? String("uart_binary") : String("idle")) +
    "\",\"auto\":" + (consoleLogAuto ? "true" : "false") +
    ",\"path\":\"" + jsonEscape(consoleLogPath) + "\",\"rows\":" + String(consoleCsvRows) +
    ",\"read_errors\":" + String(consoleCsvErrors) + ",\"interval_ms\":" + String(consoleCsvInterval) +
    ",\"error\":\"" + jsonEscape(consoleLogError) + "\"}";
}

static String consoleSd(const serialcli::Words& w, bool& ok) {
  using namespace serialcli;
  if (w.is(1, "status") && w.count == 2) {
    ok = true;
    return "{\"supported\":" + String(SD_AVAILABLE ? "true" : "false") +
      ",\"enabled\":" + (sdEnabled ? "true" : "false") + ",\"mounted\":" + (haveSDCard ? "true" : "false") +
      ",\"init_done\":" + (sdInitDone ? "true" : "false") +
      ",\"total\":" + String((unsigned long long)(haveSDCard ? SD_MMC.totalBytes() : 0)) +
      ",\"used\":" + String((unsigned long long)(haveSDCard ? SD_MMC.usedBytes() : 0)) + "}";
  }
  uint32_t a, b;
  if (w.is(1, "mount") && w.count == 2) {
    if (!SD_AVAILABLE || !sdEnabled) return "enable SD in a supported build first";
    ok = startSdMount(); return ok ? "SD mount started; poll sd status" : "cannot start SD mount";
  }
  if (w.is(1, "unmount") && w.count == 2) {
    if (consoleSdLoggerActive() || sdInitRunning) return "stop logger / wait for SD init first";
    SD_MMC.end(); haveSDCard = false; sdInitDone = false; ok = true; return "SD unmounted";
  }
  if (w.is(1, "enable") && w.count == 3 && number(w.args[2], 1, a)) {
    if (!SD_AVAILABLE) return "SD disabled in this firmware build";
    if (consoleCsvActive || fastLoggingActive) return "stop logger first";
    sdEnabled = a; saveSettings(); ok = true;
    return "SD boot setting saved; use sd mount/unmount to apply now (does not format card)";
  }
  if (!haveSDCard) return "SD card not mounted; see sd status";
  if (w.is(1, "list") && (w.count == 2 || w.count == 4)) {
    a = 0; b = 16;
    if (w.count == 4 && (!number(w.args[2], 100000, a) || !number(w.args[3], 32, b) || !b)) return "invalid list offset/count";
    File root = SD_MMC.open("/");
    if (!root || !root.isDirectory()) return "cannot open SD root";
    String result = "{\"files\":["; uint32_t index = 0, count = 0; bool more = false;
    while (File f = root.openNextFile()) {
      if (index++ < a) { f.close(); continue; }
      if (count >= b) { more = true; f.close(); break; }
      if (count++) result += ',';
      String path = f.name(); if (!path.startsWith("/")) path = "/" + path;
      result += "{\"path\":\"" + jsonEscape(path) + "\",\"size\":" + String(f.size()) +
        ",\"directory\":" + (f.isDirectory() ? "true" : "false") + "}";
      f.close();
    }
    root.close(); ok = true;
    return result + "],\"next\":" + String(a + count) + ",\"more\":" + (more ? "true" : "false") + "}";
  }
  if ((w.is(1, "stat") && w.count == 3) || (w.is(1, "read") && w.count == 5)) {
    if (consoleCsvActive || fastLoggingActive) return "stop logger before reading files";
    if (!sdPath(w.args[2])) return "invalid SD file path";
    File f = SD_MMC.open(w.args[2], FILE_READ);
    if (!f || f.isDirectory()) return "SD file not found";
    uint32_t size = f.size();
    if (w.is(1, "stat")) {
      String result = "{\"size\":" + String(size) + ",\"modified\":" + String((unsigned long)f.getLastWrite()) + "}";
      f.close(); ok = true; return result;
    }
    if (!number(w.args[3], size, a) || !number(w.args[4], 1024, b) || !b || !f.seek(a)) {
      f.close(); return "invalid file offset/count";
    }
    uint8_t bytes[1024]; size_t wanted = b < size - a ? b : size - a;
    size_t n = f.read(bytes, wanted); f.close();
    if (n != wanted) return "SD short read";
    String hex; if (!hex.reserve(n * 2)) return "out of memory";
    for (size_t i = 0; i < n; ++i) { char pair[3]; snprintf(pair, sizeof(pair), "%02x", bytes[i]); hex += pair; }
    char crc[9]; snprintf(crc, sizeof(crc), "%08lx", (unsigned long)(crc32(0xffffffffU, bytes, n) ^ 0xffffffffU));
    ok = true;
    return "{\"offset\":" + String(a) + ",\"size\":" + String(size) + ",\"eof\":" +
      (a + n == size ? "true" : "false") + ",\"crc32\":\"" + crc + "\",\"hex\":\"" + hex + "\"}";
  }
  return "usage: sd status | enable 0/1 | mount | unmount | list [offset count] | stat PATH | read PATH OFFSET COUNT";
}

static String consoleLog(const serialcli::Words& w, bool& ok) {
  using namespace serialcli;
  if (w.is(1, "status") && w.count == 2) { ok = true; return consoleLogStatus(); }
  if (w.is(1, "stop") && w.count == 2) {
    consoleLogAuto = false; consoleCsvStop();
    if (fastLoggingActive) binaryLoggingStop();
    ok = !fastLoggingActive; return ok ? consoleLogStatus() : "UART logger stop not confirmed; retry log stop after checking target";
  }
  if (w.is(1, "auto") && w.count == 2) {
    if (consoleCsvActive || fastLoggingActive) return "stop logger first";
    consoleLogAuto = true; startLogAttempt = 0; ok = true; return consoleLogStatus();
  }
  if (!haveSDCard) return "SD card not mounted; see sd status";
  if (consoleCsvActive || fastLoggingActive) return "logger already active";
  if (w.is(1, "binary") && w.count == 2) {
    if (canMode) return "binary logging requires inverter UART mode";
    if (WiFi.softAPgetStationNum() || WiFi.status() == WL_CONNECTED) return "binary logger requires no WiFi clients (existing automatic logger policy)";
    consoleLogAuto = false; consoleLogError = ""; binaryLoggingStart();
    ok = fastLoggingActive; return ok ? consoleLogStatus() : "target did not start UART binary logging";
  }
  uint32_t interval;
  if (!w.is(1, "start") || w.count != 4 || !number(w.args[2], 60000, interval) || interval < 100)
    return "usage: log status | start INTERVAL_MS NAME[,NAME...] | binary | stop | auto";
  if (!canMode || !canDriverIsRunning()) return "CSV logger requires running CAN";
  if (!canParamCacheLoaded && !canDownloadParamCache()) return "parameter database download failed";
  String names = w.args[3]; uint8_t count = 0; int pos = 0;
  do {
    int comma = names.indexOf(',', pos);
    String name = comma < 0 ? names.substring(pos) : names.substring(pos, comma);
    if (!name.length() || count >= 16) return "expected 1..16 parameter names";
    for (size_t i = 0; i < name.length(); ++i)
      if (!isalnum((unsigned char)name[i]) && name[i] != '_') return "CSV names must be alphanumeric/underscore";
    float v;
    int id = canGetParamId(name);
    if (!canVirtualFind(name, &v) && (id < 0 || id > 65535)) return "unknown parameter: " + name;
    consoleCsvNames[count++] = name;
    if (comma < 0) break;
    pos = comma + 1;
  } while (true);
  if (SD_MMC.totalBytes() - SD_MMC.usedBytes() < 65536) return "SD free space below 64 KiB; no files were deleted";
  bool opened = false;
  for (uint32_t i = 0; i < 1000; ++i) {
    String path = "/can-" + String(millis()) + "-" + String(i) + ".csv";
    if (!SD_MMC.exists(path)) { consoleCsvFile = SD_MMC.open(path, FILE_WRITE); consoleLogPath = path; opened = bool(consoleCsvFile); break; }
  }
  if (!opened) return "cannot create CSV log";
  String header = "ms," + names + "\n";
  if (consoleCsvFile.print(header) != header.length()) { consoleCsvStop(); return "SD header write failed"; }
  consoleCsvFile.flush(); consoleCsvCount = count; consoleCsvInterval = interval;
  consoleCsvRows = consoleCsvErrors = 0; consoleLogError = "";
  consoleCsvStart = consoleCsvLast = consoleCsvFlush = millis();
  consoleLogAuto = false; consoleCsvActive = true; ok = true; return consoleLogStatus();
}

static void consoleCsvTick() {
  if (!consoleCsvActive || canFwBusy() || millis() - consoleCsvLast < consoleCsvInterval) return;
  consoleCsvLast = millis();
  if (!haveSDCard || SD_MMC.totalBytes() - SD_MMC.usedBytes() < 65536) {
    consoleLogError = "SD unavailable or free space below 64 KiB"; consoleCsvStop(); return;
  }
  String row;
  if (!row.reserve(512)) { consoleLogError = "out of memory"; consoleCsvStop(); return; }
  row = String(millis() - consoleCsvStart);
  for (uint8_t i = 0; i < consoleCsvCount; ++i) {
    float value;
    if (!canVirtualFind(consoleCsvNames[i], &value)) {
      int id = canGetParamId(consoleCsvNames[i]);
      CanSdoResult r = canSdoReadChecked(canNodeId, canParamIndex(id), canParamSubIndex(id));
      value = r.ok ? canDecodeValue(r.value) : NAN;
    }
    row += ',';
    if (isfinite(value)) row += String(value, 5);
    else { row += "nan"; ++consoleCsvErrors; }
  }
  row += '\n';
  if (consoleCsvFile.print(row) != row.length()) { consoleLogError = "SD row write failed"; consoleCsvStop(); return; }
  ++consoleCsvRows;
  if (millis() - consoleCsvFlush >= 1000) { consoleCsvFile.flush(); consoleCsvFlush = millis(); }
}
