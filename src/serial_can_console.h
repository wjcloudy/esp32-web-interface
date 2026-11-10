#pragma once
// Included by the sketch after its shared CAN/settings/update services.
#include "serial_cli.h"

static void consoleReply(uint32_t id, bool ok, const String& result) {
  DBG_OUTPUT_PORT.printf("@oi {\"id\":%lu,\"ok\":%s,\"result\":\"",
                         (unsigned long)id, ok ? "true" : "false");
  for (size_t i = 0; i < result.length(); ++i) {
    unsigned char c = result[i];
    switch (c) {
      case '"': DBG_OUTPUT_PORT.print("\\\""); break;
      case '\\': DBG_OUTPUT_PORT.print("\\\\"); break;
      case '\n': DBG_OUTPUT_PORT.print("\\n"); break;
      case '\r': DBG_OUTPUT_PORT.print("\\r"); break;
      case '\t': DBG_OUTPUT_PORT.print("\\t"); break;
      default:
        if (c < 32) DBG_OUTPUT_PORT.printf("\\u%04x", (unsigned)c);
        else DBG_OUTPUT_PORT.write(c);
    }
  }
  DBG_OUTPUT_PORT.println("\"}");
}

static String consoleSdo(const CanSdoResult& r, bool& ok) {
  ok = r.ok;
  if (!ok) return String(r.error) + (r.abortCode ? " 0x" + String(r.abortCode, HEX) : "");
  return "{\"raw\":" + String(r.value) + ",\"size\":" + String(r.size) + "}";
}

static bool consolePin(int pin, bool output, bool optional = false) {
  if (optional && pin == -1) return true;
  if (pin < 0 || pin > 48 || !GPIO_IS_VALID_GPIO(pin) ||
      (output && !GPIO_IS_VALID_OUTPUT_GPIO(pin))) return false;
#if defined(CONFIG_IDF_TARGET_ESP32)
  if (pin >= 6 && pin <= 11) return false; // attached flash
  if ((const void*)&DBG_OUTPUT_PORT == (const void*)&Serial && (pin == 1 || pin == 3)) return false;
#endif
  return true;
}

static bool consoleStartBus(int speed, int tx, int rx) {
  applyCanEnablePins();
  if (!canDriverInitForDevice(canNodeId, (CanSpeed)speed, tx, rx)) {
    if (canMode) canDriverInitForDevice(canNodeId, (CanSpeed)canSpeed, canTxPin, canRxPin);
    return false;
  }
  canMode = true; canSpeed = speed; canTxPin = tx; canRxPin = rx;
  canParamCacheLoaded = false; canParamJson = "";
  saveSettings();
  return true;
}

static File consoleUpload;
static uint32_t consoleUploadSize = 0, consoleUploadBytes = 0;
static uint32_t consoleUploadCrc = 0xffffffffU, consoleExpectedCrc = 0;
static uint32_t consoleUploadTouched = 0;
static const char* const CONSOLE_PART = "/cli-firmware.part";
static const char* const CONSOLE_FIRMWARE = "/cli-firmware.bin";

static void consoleAbortUpload() {
  if (consoleUpload) consoleUpload.close();
  SPIFFS.remove(CONSOLE_PART);
  consoleUploadBytes = consoleUploadSize = 0;
}

static String consoleFile(const serialcli::Words& w, bool& ok) {
  using namespace serialcli;
  uint32_t size, crc;
  if (w.is(1, "begin") && w.count == 4 && number(w.args[2], 255 * 1024, size) && size &&
      number(w.args[3], UINT32_MAX, crc)) {
    consoleAbortUpload();
    if (SPIFFS.totalBytes() - SPIFFS.usedBytes() < size + 8192) return "insufficient filesystem space";
    consoleUpload = SPIFFS.open(CONSOLE_PART, "w");
    if (!consoleUpload) return "cannot open staging file";
    consoleUploadSize = size; consoleExpectedCrc = crc; consoleUploadCrc = 0xffffffffU;
    consoleUploadTouched = millis(); ok = true; return "ready";
  }
  if (w.is(1, "abort") && w.count == 2) { consoleAbortUpload(); ok = true; return "aborted"; }
  if (!consoleUpload) return "no upload active (file begin SIZE CRC32)";
  if (w.is(1, "chunk") && w.count == 3) {
    uint8_t bytes[256]; size_t length;
    if (!hexBytes(w.args[2], bytes, sizeof(bytes), length) || !length) return "invalid hex chunk (1..256 bytes)";
    if (consoleUploadBytes + length > consoleUploadSize) return "upload exceeds declared size";
    if (consoleUpload.write(bytes, length) != length) { consoleAbortUpload(); return "file write failed"; }
    consoleUploadCrc = crc32(consoleUploadCrc, bytes, length);
    consoleUploadBytes += length; consoleUploadTouched = millis();
    ok = true; return String(consoleUploadBytes);
  }
  if (w.is(1, "finish") && w.count == 2) {
    if (consoleUploadBytes != consoleUploadSize || (consoleUploadCrc ^ 0xffffffffU) != consoleExpectedCrc) {
      consoleAbortUpload(); return "upload length/CRC32 mismatch";
    }
    consoleUpload.close();
    SPIFFS.remove(CONSOLE_FIRMWARE);
    if (!SPIFFS.rename(CONSOLE_PART, CONSOLE_FIRMWARE)) return "cannot finalize firmware file";
    ok = true; return CONSOLE_FIRMWARE;
  }
  return "usage: file begin SIZE CRC32 | file chunk HEX | file finish | file abort";
}

static String consoleRun(const serialcli::Words& w, bool& ok) {
  using namespace serialcli;
  ok = false;
  uint32_t a = 0, b = 0;
  int32_t value = 0;
  if (w.is(0, "help") && w.count == 1) {
    ok = true;
    return "help; status; bus <125|250|500> [tx rx]; transceiver <pwr|-1> <invert0/1> <en|-1> <invert0/1>; "
           "node <1..127>; scan [first last]; db [refresh]; json; get <name[,name...]>; set <name> <value>; "
           "sdo read <index> <sub>; sdo write <index> <sub> <int32|0xuint32>; "
           "start [2]; stop; reset; save; load; defaults; errors; "
           "can list; can clear; can rm <index> <sub>; can tx/rx <name> <id> <bit> <signed-length> [gain [offset]]; "
           "send <id> [hexbytes]; sniff <1..8000ms>; debug reset; "
           "file begin <size> <crc32>; file chunk <hex>; file finish; file abort; "
           "flash [SPIFFS-path]; flash-status; auth reset";
  }
  if (w.is(0, "status") && w.count == 1) {
    ok = true;
    return "{\"version\":\"" + String(WEB_VERSION) + "\",\"can_mode\":" + (canMode ? "true" : "false") +
      ",\"running\":" + (canDriverIsRunning() ? "true" : "false") + ",\"node\":" + String(canNodeId) +
      ",\"kbps\":" + String(canSpeed == 0 ? 125 : canSpeed == 1 ? 250 : 500) +
      ",\"tx\":" + String(canTxPin) + ",\"rx\":" + String(canRxPin) +
      ",\"wifi_ip\":\"" + WiFi.localIP().toString() + "\",\"cache\":" + (canParamCacheLoaded ? "true" : "false") + "}";
  }
  if (w.is(0, "flash-status") && w.count == 1) {
    ok = true;
    String msg = (canFwState == CANFW_DONE || canFwState == CANFW_ERROR) ? canFwMsg : "";
    return "{\"state\":" + String(canFwState) + ",\"page\":" + String(canFwPage) +
      ",\"pages\":" + String(canFwPages) + ",\"message\":\"" + jsonEscape(msg) + "\"}";
  }
  if (canFwBusy()) return "CAN firmware update in progress";
  if (w.is(0, "file")) return consoleFile(w, ok);
  if (w.is(0, "auth") && w.is(1, "reset") && w.count == 2) {
    if (authEnabled()) { consoleReply(w.id, true, "resetting users and rebooting"); authRecoveryReset("serial"); }
    ok = true; return "Auth: no users, nothing to reset";
  }
  if (w.is(0, "bus") && (w.count == 2 || w.count == 4)) {
    if (!number(w.args[1], 500, a) || (a != 125 && a != 250 && a != 500)) return "rate must be 125, 250 or 500";
    int tx = canTxPin, rx = canRxPin;
    uint32_t t, r;
    if (w.count == 4) {
      if (!number(w.args[2], 48, t) || !number(w.args[3], 48, r)) return "invalid pins";
      tx = t; rx = r;
    }
    if (!consolePin(tx, true) || !consolePin(rx, false) || tx == rx ||
        tx == canPwrPin || tx == canEnPin || rx == canPwrPin || rx == canEnPin) return "invalid or conflicting CAN pins";
    if (!consoleStartBus(a == 125 ? 0 : a == 250 ? 1 : 2, tx, rx)) return "CAN driver init failed";
    ok = true; return "CAN enabled; settings saved";
  }
  if (w.is(0, "transceiver") && w.count == 5) {
    int32_t pwr, en;
    if (!integer(w.args[1], -1, 48, pwr) || !number(w.args[2], 1, a) ||
        !integer(w.args[3], -1, 48, en) || !number(w.args[4], 1, b) ||
        !consolePin(pwr, true, true) || !consolePin(en, true, true) ||
        (pwr >= 0 && (pwr == canTxPin || pwr == canRxPin || pwr == en)) ||
        (en >= 0 && (en == canTxPin || en == canRxPin))) return "invalid transceiver pins/polarity";
    // Release previous control outputs before changing the assignment.
    if (canPwrPin >= 0) pinMode(canPwrPin, INPUT);
    if (canEnPin >= 0) pinMode(canEnPin, INPUT);
    canPwrPin = pwr; canPwrInv = a; canEnPin = en; canEnInv = b;
    applyCanEnablePins(); saveSettings(); ok = true; return "transceiver settings saved";
  }
  if (w.is(0, "node") && w.count == 2) {
    if (!number(w.args[1], 127, a) || !a) return "node must be 1..127";
    canNodeId = a; canParamCacheLoaded = false; canParamJson = "";
    saveSettings(); ok = true; return "active node selected (saved GUI boot-default still takes precedence)";
  }
  if (!canMode || !canDriverIsRunning()) return "CAN not running; use bus <125|250|500> [tx rx]";
  if (w.is(0, "flash") && w.count <= 2) {
    if (consoleUpload) return "finish or abort the active upload first";
    String path = w.count == 2 ? w.args[1] : CONSOLE_FIRMWARE;
    if (!path.startsWith("/") || path.endsWith(".part")) return "expected a completed SPIFFS firmware path";
    String error;
    if (!startCanFwUpdate(path, error)) return error;
    ok = true; return "CAN firmware update started; poll flash-status";
  }
  if (w.is(0, "sdo") && ((w.is(1, "read") && w.count == 4) || (w.is(1, "write") && w.count == 5))) {
    if (!number(w.args[2], 65535, a) || !number(w.args[3], 255, b)) return "invalid index/subindex";
    if (w.is(1, "read")) return consoleSdo(canSdoReadChecked(canNodeId, a, b), ok);
    uint32_t bits;
    if (number(w.args[4], UINT32_MAX, bits)) memcpy(&value, &bits, 4);
    else if (!integer(w.args[4], INT32_MIN, INT32_MAX, value)) return "invalid 32-bit raw value";
    return consoleSdo(canSdoWriteConfirmed(canNodeId, a, b, value), ok);
  }
  if (w.is(0, "scan") && (w.count == 1 || w.count == 3)) {
    a = 1; b = 127;
    if (w.count == 3 && (!number(w.args[1], 127, a) || !number(w.args[2], 127, b) || !a || a > b)) return "invalid scan range";
    String nodes = "[";
    for (uint32_t n = a; n <= b; ++n) {
      CanSdoResult r = canSdoReadChecked(n, CAN_INDEX_SERIAL, 0, 40);
      if (r.ok) {
        if (nodes.length() > 1) nodes += ',';
        nodes += "{\"nodeId\":" + String(n) + ",\"serial\":" + String(r.value) + "}";
      }
      delay(1);
    }
    ok = true; return nodes + "]";
  }
  if (w.is(0, "send") && (w.count == 2 || w.count == 3)) {
    uint8_t bytes[8]; size_t length = 0;
    if (!number(w.args[1], 0x1fffffff, a) ||
        (w.count == 3 && !hexBytes(w.args[2], bytes, sizeof(bytes), length))) return "invalid CAN ID/hex payload (0..8 bytes)";
    ok = canRawSend(a, bytes, length);
    return ok ? "queued (CAN TX queue; no receiver acknowledgement implied)" : "send_failed";
  }
  if ((w.is(0, "sniff") && w.count == 2) || (w.is(0, "debug") && w.is(1, "reset") && w.count == 2)) {
    bool reset = w.is(0, "debug");
    if (!reset && (!number(w.args[1], 8000, a) || !a)) return "sniff duration must be 1..8000ms";
    if (reset) { a = 8000; if (!canSdoWrite(canNodeId, CAN_INDEX_COMMANDS, CAN_CMD_RESET, 1)) return "reset send_failed"; }
    uint32_t start = millis(); unsigned count = 0; String frames = "[";
    while (millis() - start < a && count < 40) {
      twai_message_t f;
      if (!canDriverReceive(&f)) { delay(1); continue; }
      if (count++) frames += ',';
      frames += "{\"id\":" + String(f.identifier) + ",\"ext\":" + (f.extd ? "true" : "false") +
        ",\"rtr\":" + (f.rtr ? "true" : "false") + ",\"data\":\"";
      for (int i = 0; !f.rtr && i < f.data_length_code && i < 8; ++i) {
        char hex[3]; snprintf(hex, sizeof(hex), "%02x", f.data[i]); frames += hex;
      }
      frames += "\"}";
    }
    ok = true; return frames + "]";
  }
  // These commands don't need the metadata database, and success requires
  // the target's SDO confirmation rather than just queuing the CAN frame.
  const char* names[] = {"save", "load", "reset", "defaults", "start", "stop"};
  for (uint8_t i = 0; i < 6; ++i) {
    if (!w.is(0, names[i])) continue;
    if (w.count != 1 && !(i == CAN_CMD_START && w.count == 2 && w.is(1, "2"))) return "unexpected command arguments";
    return consoleSdo(canSdoWriteConfirmed(canNodeId, CAN_INDEX_COMMANDS, i, i == CAN_CMD_RESET ? 1 : 0), ok);
  }
  bool db = w.is(0, "db") && (w.count == 1 || (w.count == 2 && w.is(1, "refresh")));
  bool get = w.is(0, "get") && w.count == 2;
  bool set = w.is(0, "set") && w.count == 3;
  bool json = w.is(0, "json") && w.count == 1;
  bool errors = w.is(0, "errors") && w.count == 1;
  bool mapping = w.is(0, "can");
  if (!db && !get && !set && !json && !errors && !mapping) return "unknown command or invalid arguments; use help";
  if (set && !fixed32(w.args[2], value)) return "invalid/out-of-range fixed-point value";
  // Validate mapping writes before the shared web command translator's
  // permissive toInt/toFloat conversions can turn a typo into a write.
  if (mapping) {
    bool valid = ((w.is(1, "list") || w.is(1, "clear")) && w.count == 2);
    if (w.is(1, "rm") && w.count == 4) {
      valid = number(w.args[2], 0x31ff, a) && a >= 0x3100 &&
        number(w.args[3], 99, b) && b >= 1 && (b & 1);
      // Existing translator expects decimal for rm.
    }
    if ((w.is(1, "tx") || w.is(1, "rx")) && w.count >= 6 && w.count <= 8) {
      int32_t bits, offset = 0; double gain = 1;
      valid = number(w.args[3], 0x7ff, a) && number(w.args[4], 63, b) &&
        integer(w.args[5], -32, 32, bits) && bits &&
        b + (bits < 0 ? -bits : bits) <= 64 && (w.count < 7 || real(w.args[6], gain)) &&
        gain * 1000 >= -8388608 && gain * 1000 <= 8388607;
      if (w.count == 8) valid = valid && integer(w.args[7], -128, 127, offset);
    }
    if (!valid) return "invalid mapping command; use help";
  }
  if ((db && w.count == 2) || !canParamCacheLoaded) {
    canParamCacheLoaded = false; canParamJson = "";
    if (!canDownloadParamCache()) return "parameter database download failed";
  }
  if (db) { ok = true; return canParamJson; }
  if (get) {
    String result = "{"; String list = w.args[1]; unsigned count = 0;
    int pos = 0;
    do {
      int comma = list.indexOf(',', pos);
      String name = comma < 0 ? list.substring(pos) : list.substring(pos, comma);
      if (!name.length() || ++count > 128) return "invalid parameter list";
      float v;
      if (!canVirtualFind(name, &v)) {
        int id = canGetParamId(name);
        if (id < 0 || id > 65535) return "unknown/invalid parameter: " + name;
        CanSdoResult r = canSdoReadChecked(canNodeId, canParamIndex(id), canParamSubIndex(id));
        if (!r.ok) return name + ": " + consoleSdo(r, ok);
        v = canDecodeValue(r.value);
      }
      if (!isfinite(v)) return "no value received: " + name;
      if (count > 1) result += ',';
      result += "\"" + jsonEscape(name) + "\":" + String(v, 5);
      if (comma < 0) break;
      pos = comma + 1;
    } while (true);
    ok = true; return result + "}";
  }
  if (set) {
    int id = canGetParamId(w.args[1]);
    if (id < 0 || id > 65535) return "unknown/invalid parameter";
    return consoleSdo(canSdoWriteConfirmed(canNodeId, canParamIndex(id), canParamSubIndex(id), value), ok);
  }
  String command;
  for (size_t i = 0; i < w.count; ++i) {
    if (i) command += ' ';
    if (mapping && w.is(1, "rm") && i >= 2) {
      uint32_t n; number(w.args[i], 65535, n); command += String(n);
    } else if (mapping && (w.is(1, "tx") || w.is(1, "rx")) && (i == 3 || i == 4)) {
      uint32_t n; number(w.args[i], 65535, n); command += String(n);
    } else if (mapping && (w.is(1, "tx") || w.is(1, "rx")) && (i == 5 || i == 7)) {
      int32_t n; integer(w.args[i], -128, 127, n); command += String(n);
    } else command += w.args[i];
  }
  String result = canExecuteCommand(command, 0);
  ok = !result.startsWith("error") && result != "unknown command";
  return result;
}

static void serialCanConsoleTick() {
  static serialcli::LineBuffer line;
  if (consoleUpload && millis() - consoleUploadTouched > 60000) consoleAbortUpload();
  for (unsigned i = 0; i < 128 && DBG_OUTPUT_PORT.available(); ++i) {
    auto event = line.push(DBG_OUTPUT_PORT.read());
    if (event == serialcli::LineBuffer::REJECTED) {
      consoleReply(0, false, "invalid/overlong line (max 1024 bytes)");
      return;
    }
    if (event != serialcli::LineBuffer::READY) continue;
    serialcli::Words words;
    if (!words.parse(line.data)) consoleReply(words.id, false, "invalid request");
    else { bool ok; String result = consoleRun(words, ok); consoleReply(words.id, ok, result); }
    return; // one command per loop; HTTP/SSE still get their turn
  }
}
