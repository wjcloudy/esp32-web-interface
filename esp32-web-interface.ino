/* 
  FSWebServer - Example WebServer with SPIFFS backend for esp8266
  Copyright (c) 2015 Hristo Gochkov. All rights reserved.
  This file is part of the ESP8266WebServer library for Arduino environment.
 
  This library is free software; you can redistribute it and/or
  modify it under the terms of the GNU Lesser General Public
  License as published by the Free Software Foundation; either
  version 2.1 of the License, or (at your option) any later version.
  This library is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
  Lesser General Public License for more details.
  You should have received a copy of the GNU Lesser General Public
  License along with this library; if not, write to the Free Software
  Foundation, Inc., 51 Franklin St, Fifth Floor, Boston, MA  02110-1301  USA
  
  upload the contents of the data folder with MkSPIFFS Tool ("ESP8266 Sketch Data Upload" in Tools menu in Arduino IDE)
  or you can upload the contents of a folder if you CD in that folder and run the following command:
  for file in `ls -A1`; do curl -F "file=@$PWD/$file" esp8266fs.local/edit; done
  
  access the sample web page at http://esp8266fs.local
  edit the page by going to http://esp8266fs.local/edit
*/
/*
 * This file is part of the esp8266 web interface
 *
 * Copyright (C) 2018 Johannes Huebner <dev@johanneshuebner.com>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 */
#include <WiFi.h>
#include <WiFiClient.h>
#include <WebServer.h>
#include <HTTPUpdateServer.h>
#include <ESPmDNS.h>
#include <ArduinoOTA.h>
#include <FS.h>
#include <Ticker.h>

#include <SD_MMC.h>
#include "RTClib.h"
#include <ESP32Time.h>
#include <time.h>
#include "driver/uart.h"
#include "src/can_driver.h"
#include "src/can_protocol.h"

#ifndef DBG_OUTPUT_PORT
#define DBG_OUTPUT_PORT Serial2
#endif
#define INVERTER_PORT UART_NUM_0
#define INVERTER_RX 1 //3 - Swapped for Wemos board onto Zombie and other OI boards
#define INVERTER_TX 3 //1 - Swapped for Wemos board onto Zombie and other OI boards
#define UART_TIMEOUT (100 / portTICK_PERIOD_MS)
#define UART_MESSBUF_SIZE 100
#ifndef LED_BUILTIN
#define LED_BUILTIN 2 //clashes with SDIO, need to change to suit hardware and uncomment lines
#endif

#define RESERVED_SD_SPACE 2000000000
#define SDIO_BUFFER_SIZE 16384
#define FLUSH_WRITES 60 //flush file every 60 blocks

#define MAX_SD_FILES 200

#define LOG_DELAY_VAL 10000

//HardwareSerial Inverter(INVERTER_PORT);

const char* host = "inverter";
bool fastUart = false;
bool fastUartAvailable = true;
bool txrxSwapped = true; // default: swapped for Wemos/OI/Zombie boards
bool canMode = false; // true = CAN bus mode, false = UART mode
int canNodeId = 1;
int canSpeed = 2; // 0=125k, 1=250k, 2=500k
int canRxPin = CAN_RX_PIN;
int canTxPin = CAN_TX_PIN;
char uartMessBuff[UART_MESSBUF_SIZE];

// CAN parameter cache (downloaded from device via segmented SDO)
String canParamJson = "";
bool canParamCacheLoaded = false;

// Look up parameter ID by name from cached JSON
// JSON format: {"name":{"id":12,"unit":"V",...},"name2":{...}}
static int canGetParamId(const String& name) {
  if (!canParamCacheLoaded) return -1;
  String search = "\"" + name + "\"";
  int pos = canParamJson.indexOf(search);
  if (pos < 0) return -1;
  // Find "id": after the name
  int idPos = canParamJson.indexOf("\"id\"", pos);
  if (idPos < 0) return -1;
  idPos = canParamJson.indexOf(':', idPos) + 1;
  while (idPos < canParamJson.length() && (canParamJson[idPos] == ' ' || canParamJson[idPos] == '\t')) idPos++;
  return canParamJson.substring(idPos).toInt();
}

// Download parameter database from device via segmented SDO
static bool canDownloadParamCache() {
  if (!canMode || !canDriverIsRunning()) return false;
  DBG_OUTPUT_PORT.println("CAN: downloading parameter database...");

  // Allocate buffer for JSON string (ZombieVerter-class param databases run >32KB)
  const uint32_t bufSize = 49152;
  uint8_t* buf = (uint8_t*)malloc(bufSize);
  if (!buf) return false;

  // A single lost segment truncates the transfer, so retry the whole download
  // and only cache transfers that finished with the device's last-segment flag.
  // (A retry after a truncated attempt may resume mid-transfer on the device
  // side — the sanity check below rejects that and the next attempt is fresh.)
  for (int attempt = 1; attempt <= 3; attempt++) {
    memset(buf, 0, bufSize);
    bool complete = false;
    uint32_t bytesRead = canSdoReadSegmented(canNodeId, CAN_INDEX_JSON, buf, bufSize - 1, 100, &complete);

    // Sanity check: a real param database is a non-trivial JSON object
    uint32_t end = bytesRead;
    while (end > 0 && (buf[end - 1] == 0 || isspace(buf[end - 1]))) end--;
    bool looksValid = end > 64 && buf[0] == '{' && buf[end - 1] == '}';

    if (bytesRead > 0 && complete && looksValid) {
      buf[bytesRead] = 0;
      canParamJson = String((char*)buf);
      canParamCacheLoaded = true;
      DBG_OUTPUT_PORT.printf("CAN: downloaded %u bytes of parameter data (attempt %d)\n", bytesRead, attempt);
      free(buf);
      return true;
    }
    DBG_OUTPUT_PORT.printf("CAN: parameter download incomplete (%u bytes, attempt %d)\n", bytesRead, attempt);
    delay(50);
  }

  free(buf);
  DBG_OUTPUT_PORT.println("CAN: parameter download failed");
  return false;
}

// Build the full json response: walk the cached param database, read each
// entry's live value via SDO and splice it in, preserving all metadata
// (category, minimum, maximum, default, unit, isparam, ...) for the UI.
static float canReadParamValue(int paramId);
static String canBuildJsonWithValues() {
  const int len = canParamJson.length();
  String result;
  result.reserve(len + 2048);

  int i = canParamJson.indexOf('{');
  if (i < 0) return "{\"can_cache\":true}";
  result += '{';
  i++;
  bool firstEntry = true;
  int failedReads = 0;
  int successReads = 0;
  bool skipReads = false; // set when the device looks offline — avoids 240 timeouts

  while (i < len) {
    // Next top-level key
    int keyStart = canParamJson.indexOf('"', i);
    if (keyStart < 0) break;
    int keyEnd = canParamJson.indexOf('"', keyStart + 1);
    if (keyEnd < 0) break;
    String name = canParamJson.substring(keyStart + 1, keyEnd);

    // Entry object bounds (track nesting and strings to find matching brace)
    int objStart = canParamJson.indexOf('{', keyEnd);
    if (objStart < 0) break;
    int depth = 1, j = objStart + 1;
    bool inStr = false;
    while (j < len && depth > 0) {
      char c = canParamJson[j];
      if (inStr) {
        if (c == '\\') j++;
        else if (c == '"') inStr = false;
      }
      else if (c == '"') inStr = true;
      else if (c == '{') depth++;
      else if (c == '}') depth--;
      j++;
    }
    if (depth != 0) break;
    String entry = canParamJson.substring(objStart, j);

    // Read live value over CAN and replace (or insert) the "value" field
    int idPos = entry.indexOf("\"id\":");
    if (idPos >= 0) {
      int paramId = entry.substring(idPos + 5).toInt();
      if (paramId > 0 && !skipReads) {
        float val = canReadParamValue(paramId);
        if (!isnan(val)) {
          successReads++;
          String valStr = String(val, 2);
          int vPos = entry.indexOf("\"value\":");
          if (vPos >= 0) {
            int vStart = vPos + 8;
            int vEnd = vStart;
            while (vEnd < (int)entry.length() && entry[vEnd] != ',' && entry[vEnd] != '}') vEnd++;
            entry = entry.substring(0, vStart) + valStr + entry.substring(vEnd);
          } else {
            entry = "{\"value\":" + valStr + "," + entry.substring(1);
          }
        } else {
          failedReads++;
          if (failedReads >= 8 && successReads == 0) skipReads = true;
        }
      }
    }

    if (!firstEntry) result += ',';
    result += '"' + name + "\":" + entry;
    firstEntry = false;
    i = j;
  }

  // Only claim a live connection if the reads mostly succeeded — otherwise
  // the UI would show stale cached values as if they were current
  if (failedReads < 5) {
    if (!firstEntry) result += ',';
    result += "\"can_cache\":true}";
  } else {
    result += '}';
  }
  return result;
}

// Read a single parameter value via SDO (returns NaN on failure)
static float canReadParamValue(int paramId) {
  if (!canMode || paramId < 0) return NAN;

  uint16_t index = canParamIndex(paramId);
  uint8_t subIndex = canParamSubIndex(paramId);

  // Drain stale frames so a leftover response can't be mismatched to this read
  twai_message_t resp;
  while (canDriverReceive(&resp)) {}

  if (!canSdoRead(canNodeId, index, subIndex)) return NAN;

  if (!canReceiveForNode(canNodeId, &resp, 20)) return NAN;

  uint16_t rIndex;
  uint8_t rSubIndex;
  int32_t raw;
  if (!canSdoParseResponse(&resp, NULL, &rIndex, &rSubIndex, &raw)) return NAN;
  if (rIndex != index || rSubIndex != subIndex) return NAN;

  return canDecodeValue(raw);
}

WebServer server(80);
HTTPUpdateServer updater;
//holds the current upload
File fsUploadFile;
Ticker sta_tick;

//SWD over ESP8266
/*
  https://github.com/scanlime/esp8266-arm-swd
*/
#include <StreamString.h>

RTC_PCF8523 ext_rtc;
ESP32Time int_rtc;
bool haveRTC = false;
bool haveSDCard = false;
bool fastLoggingEnabled = true;
bool fastLoggingActive = false;
uint8_t SDIObuffer[SDIO_BUFFER_SIZE];
uint16_t indexSDIObuffer = 0;
uint16_t blockCountSD = 0;
File dataFile;
int startLogAttempt = 0;

bool createNextSDFile()
{
  char filename[50];

  uint32_t nextFileIndex = deleteOldest(RESERVED_SD_SPACE);

  if(haveRTC)
    nextFileIndex = 0; //have a date so restart index from 0 (still needed in case serial stream fails to start)

  do
  {
    if(haveRTC)
      snprintf(filename, 50, "/%d-%02d-%02d-%02d-%02d-%02d_%d.bin", int_rtc.getYear(), int_rtc.getMonth(), int_rtc.getDay(), int_rtc.getHour(), int_rtc.getMinute(), int_rtc.getSecond(), nextFileIndex++);
    else
      snprintf(filename, 50, "/%010d.bin", nextFileIndex++);
  }
  while(SD_MMC.exists(filename));
      
  dataFile = SD_MMC.open(filename, FILE_WRITE);
  if (dataFile) 
  {
    dataFile.flush(); //make sure FAT updated for debugging purposes
    DBG_OUTPUT_PORT.println("Created file: " + String(filename)); 
    return true;
  }
  else
    return false;
}

uint32_t deleteOldest(uint64_t spaceRequired)
{
  time_t oldestTime = 0;
  File root, file;
  String oldestFileName;
  uint64_t spaceRem;
  time_t t;
  uint32_t nextIndex = 0;
  uint32_t fileCount = 0;
  
  spaceRem = SD_MMC.totalBytes() - SD_MMC.usedBytes();

  DBG_OUTPUT_PORT.println("Space Required = " + formatBytes(spaceRequired));
  DBG_OUTPUT_PORT.println("Space Remaining = " + formatBytes(spaceRem));
  
  do
  {
    root = SD_MMC.open("/");
    
    oldestTime = 0;
    fileCount = 0;
    while(file = root.openNextFile())
    {
      if(haveRTC)
        t = file.getLastWrite();
      else
      {
        String fname = file.name();
        fname.remove(0,1); //lose starting /
        t = fname.toInt()+1; //make sure 0 special case isnt used
        if(t > nextIndex)
          nextIndex = t;
      }
      if(!file.isDirectory())
      {
        fileCount++;
        if((oldestTime==0) || (t<oldestTime))
        {
          oldestTime = t;
          oldestFileName = "/";
          oldestFileName += file.name();
        }
      }
      file.close();
    }  
    root.close();

    if((spaceRem < spaceRequired) || (fileCount >= MAX_SD_FILES))
    {
      if(oldestFileName.length() > 0)
      {
        
        if(SD_MMC.remove(oldestFileName))
          DBG_OUTPUT_PORT.println("Deleted file: " + oldestFileName);
        else
          DBG_OUTPUT_PORT.println("Couldn't delete: " + oldestFileName);
      }
      else
      {
        DBG_OUTPUT_PORT.println("No files found, can't free space");
        break;//no files so can do no more
      }
    }

    spaceRem = SD_MMC.totalBytes() - SD_MMC.usedBytes();
  } while((spaceRem < spaceRequired) || (fileCount >= MAX_SD_FILES));


  return(nextIndex);
}

//format bytes
String formatBytes(uint64_t bytes){
  if (bytes < 1024){
    return String(bytes)+"B";
  } else if(bytes < (1024 * 1024)){
    return String(bytes/1024.0)+"KB";
  } else if(bytes < (1024 * 1024 * 1024)){
    return String(bytes/1024.0/1024.0)+"MB";
  } else {
    return String(bytes/1024.0/1024.0/1024.0)+"GB";
  }
}

String getContentType(String filename){
  if(server.hasArg("download")) return "application/octet-stream";
  else if(filename.endsWith(".bin")) return "application/octet-stream";
  else if(filename.endsWith(".htm")) return "text/html";
  else if(filename.endsWith(".html")) return "text/html";
  else if(filename.endsWith(".css")) return "text/css";
  else if(filename.endsWith(".js")) return "application/javascript";
  else if(filename.endsWith(".png")) return "image/png";
  else if(filename.endsWith(".gif")) return "image/gif";
  else if(filename.endsWith(".jpg")) return "image/jpeg";
  else if(filename.endsWith(".ico")) return "image/x-icon";
  else if(filename.endsWith(".xml")) return "text/xml";
  else if(filename.endsWith(".pdf")) return "application/x-pdf";
  else if(filename.endsWith(".zip")) return "application/x-zip";
  else if(filename.endsWith(".gz")) return "application/x-gzip";
  return "text/plain";
}

bool handleFileRead(String path){
  //DBG_OUTPUT_PORT.println("handleFileRead: " + path);
  // Strip query string (e.g. /ui.js?v=2 -> /ui.js)
  int qs = path.indexOf('?');
  if (qs >= 0) path = path.substring(0, qs);
  if(path.endsWith("/")) path += "index.html";
  String contentType = getContentType(path);
  // Decide cacheability from the requested path (before the .gz fallback):
  // long-cache images/fonts, always revalidate code so UI updates take effect
  bool longCache = path.endsWith(".png") || path.endsWith(".gif") ||
                   path.endsWith(".jpg") || path.endsWith(".ico") ||
                   path.endsWith(".woff2") || path.endsWith(".svg");
  String pathWithGz = path + ".gz";
  if(SPIFFS.exists(pathWithGz) || SPIFFS.exists(path)){
    if(SPIFFS.exists(pathWithGz))
      path += ".gz";
    File file = SPIFFS.open(path, "r");

    server.sendHeader("Cache-Control", longCache ? "public, max-age=86400" : "no-cache");

    size_t sent = server.streamFile(file, contentType);
    file.close();
    return true;
  }
  //try download from the sdcard
  if (haveSDCard) {
    DBG_OUTPUT_PORT.print("handleFileRead Trying SD Card: ");
    DBG_OUTPUT_PORT.println(path);
    DBG_OUTPUT_PORT.print("SD_MMC.exists: ");
    DBG_OUTPUT_PORT.println(SD_MMC.exists( path));

    if (SD_MMC.exists(path)) {
      File file = SD_MMC.open(path, "r");
      size_t sent = server.streamFile(file, contentType);
      file.close();
    return true;
    }
  }
  return false;
}

void handleFileUpload(){
  if(server.uri() != "/edit") return;
  HTTPUpload& upload = server.upload();
  if(upload.status == UPLOAD_FILE_START){
    String filename = upload.filename;
    if(!filename.startsWith("/")) filename = "/"+filename;
    //DBG_OUTPUT_PORT.print("handleFileUpload Name: "); DBG_OUTPUT_PORT.println(filename);
    fsUploadFile = SPIFFS.open(filename, "w");
    if (!fsUploadFile) {
      DBG_OUTPUT_PORT.println("ERROR: SPIFFS open failed for " + filename + " - filesystem may be full or fragmented");
    }
    filename = String();
  } else if(upload.status == UPLOAD_FILE_WRITE){
    //DBG_OUTPUT_PORT.print("handleFileUpload Data: "); DBG_OUTPUT_PORT.println(upload.currentSize);
    if(fsUploadFile)
      fsUploadFile.write(upload.buf, upload.currentSize);
  } else if(upload.status == UPLOAD_FILE_END){
    if(fsUploadFile) {
      fsUploadFile.close();
      DBG_OUTPUT_PORT.println("Upload complete: " + upload.filename + " (" + String(upload.totalSize) + " bytes)");
    } else {
      DBG_OUTPUT_PORT.println("ERROR: Upload failed - file was not written (SPIFFS open failed)");
    }
  }
}

void handleFileDelete(){
  if(server.args() == 0) return server.send(500, "text/plain", "BAD ARGS");
  String path = server.arg(0);
  //DBG_OUTPUT_PORT.println("handleFileDelete: " + path);
  if(path == "/")
    return server.send(500, "text/plain", "BAD PATH");
  if(!SPIFFS.exists(path))
    return server.send(404, "text/plain", "FileNotFound");
  SPIFFS.remove(path);
  server.send(200, "text/plain", "");
  path = String();
}

void handleFileCreate(){
  if(server.args() == 0)
    return server.send(500, "text/plain", "BAD ARGS");
  String path = server.arg(0);
  //DBG_OUTPUT_PORT.println("handleFileCreate: " + path);
  if(path == "/")
    return server.send(500, "text/plain", "BAD PATH");
  if(SPIFFS.exists(path))
    return server.send(500, "text/plain", "FILE EXISTS");
  File file = SPIFFS.open(path, "w");
  if(file)
    file.close();
  else
    return server.send(500, "text/plain", "CREATE FAILED");
  server.send(200, "text/plain", "");
  path = String();
}

void handleRTCNow() {
  String output = "{ \"now\":\"";
  if (haveRTC) {
    DateTime t = ext_rtc.now();
    output += t.timestamp();
  } else {
    output += "NO RTC";
  }
  output += "\"}";
  server.send(200, "text/json", output);
}

void handleRTCSet() {

 if (server.hasArg("timestamp")) {
    String timestamp = server.arg("timestamp");
    server.send(200, "text/json", "{\"result\":\"" + timestamp + "\"}");
    DateTime now = DateTime(timestamp.toInt());
    ext_rtc.adjust(now);
    int_rtc.setTime(now.unixtime());  
    handleRTCNow();
 } else {
    server.send(500, "text/json", "{\"result\":\"timestamp missing\"}");

 }
}
void handleSdCardDeleteAll() {
    if (haveSDCard) {
      File root, file;
      if (haveSDCard) {
        root = SD_MMC.open("/");
        while(file = root.openNextFile())
        { 
          String filename = file.name();
          if(SD_MMC.remove("/" + filename))
            DBG_OUTPUT_PORT.println("Deleted file: " + filename);
          else
            DBG_OUTPUT_PORT.println("Couldn't delete: " + filename);
          }
      }
    }

    server.send(200, "text/json", "{\"result\": \"done\"}");

}
void handleSdCardList() {
  
  if (!haveSDCard) {
    server.send(200, "text/json", "{\"error\": \"No SD Card\"}");
    return;
  }
  File root = SD_MMC.open("/");
  if(!root){
    server.send(200, "text/json", "{\"error\": \"Failed to open directory\"}");
    return;
  }
  if(!root.isDirectory()){
    server.send(200, "text/json", "{\"error\": \"Root is not a directory\"}");
    return;
  }
  File sdFile = root.openNextFile();
  String output = "[";
  int count = 0;
  while(sdFile && count < 200){
    if (output != "[") output += ',';
    output += "\"";
    output += String(sdFile.name());
    output += "\"";
    sdFile = root.openNextFile();

    count++;
  }
  output += "]";
  server.send(200, "text/json", output);
  return;
}

void handleFileList() {
  String path = "/";
  if(server.hasArg("dir"))
    path = server.arg("dir");
  //DBG_OUTPUT_PORT.println("handleFileList: " + path);
  File root = SPIFFS.open(path);
  String output = "[";

  if(!root){
    //DBG_OUTPUT_PORT.print("- failed to open directory");
    return;
  }

  File file = root.openNextFile();
  while(file){
    if (output != "[") output += ',';
    bool isDir = false;
    output += "{\"type\":\"";
    output += file.isDirectory()?"dir":"file";
    output += "\",\"name\":\"";
    output += String(file.name());
    output += "\"}";
    file = root.openNextFile();
  }
  
  output += "]";
  server.send(200, "text/json", output);
}

// static void sendCommand(String cmd)
// {
//   DBG_OUTPUT_PORT.println("Sending '" + cmd + "' to inverter");
//   Inverter.print("\n");
//   delay(1);
//   while(Inverter.available())
//     Inverter.read(); //flush all previous output
//   Inverter.print(cmd);
//   Inverter.print("\n");
//   Inverter.readStringUntil('\n'); //consume echo  
// }

void uart_readUntill(char val)
{
  int retVal;
  do
  {
    retVal = uart_read_bytes(INVERTER_PORT, uartMessBuff, 1, UART_TIMEOUT);
  }
  while((retVal>0) && (uartMessBuff[0] != val));
}

bool uart_readStartsWith(const char *val)
{
  bool retVal = false;
  int rxBytes = uart_read_bytes(INVERTER_PORT, uartMessBuff, strnlen(val,UART_MESSBUF_SIZE), UART_TIMEOUT);
  if(rxBytes >= strnlen(val,UART_MESSBUF_SIZE))
  {
    if(strncmp(val, uartMessBuff, strnlen(val,UART_MESSBUF_SIZE))==0)
      retVal = true;
    uartMessBuff[rxBytes] = 0;
    DBG_OUTPUT_PORT.println(uartMessBuff);
  }
  return retVal;
}



static void initUART(bool reinit = false)
{
  if (reinit) {
    // Just swap the pins — no need to delete/reinstall driver
    uart_set_pin(INVERTER_PORT,
      txrxSwapped ? INVERTER_TX : INVERTER_RX,
      txrxSwapped ? INVERTER_RX : INVERTER_TX,
      UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE);
    DBG_OUTPUT_PORT.println(txrxSwapped ? "UART: swapped mode (TX=3, RX=1)" : "UART: normal mode (TX=1, RX=3)");
    return;
  }
  
  uart_config_t uart_config = {
        .baud_rate = 115200,
        .data_bits = UART_DATA_8_BITS,
        .parity    = UART_PARITY_DISABLE,
        .stop_bits = UART_STOP_BITS_1,
        .flow_ctrl = UART_HW_FLOWCTRL_DISABLE};

  uart_param_config(INVERTER_PORT, &uart_config);
  
  if (txrxSwapped)
  {
    uart_set_pin(INVERTER_PORT, INVERTER_TX, INVERTER_RX, UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE);
    DBG_OUTPUT_PORT.println("UART: swapped mode (TX=3, RX=1)");
  }
  else
  {
    uart_set_pin(INVERTER_PORT, INVERTER_RX, INVERTER_TX, UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE);
    DBG_OUTPUT_PORT.println("UART: normal mode (TX=1, RX=3)");
  }
  
  uart_driver_install(INVERTER_PORT, SDIO_BUFFER_SIZE * 3, 0, 0, NULL, 0);
  delay(100);
}

static void sendCommand(String cmd)
{
  DBG_OUTPUT_PORT.println("Sending '" + cmd + "' to inverter");
  //Inverter.print("\n");
  uart_write_bytes(INVERTER_PORT, "\n", 1);
  delay(1);
  //while(Inverter.available())
  //  Inverter.read(); //flush all previous output
  uart_flush(INVERTER_PORT);
  //Inverter.print(cmd);
  uart_write_bytes(INVERTER_PORT, cmd.c_str(), cmd.length());
  //Inverter.print("\n");
  uart_write_bytes(INVERTER_PORT, "\n", 1);
  //Inverter.readStringUntil('\n'); //consume echo  
  uart_readUntill('\n');
}

// CAN command handler — routes OpenInverter commands over CAN bus
static String canExecuteCommand(const String& cmdStr, int repeat);
static void handleCanCommand(const String& cmd) {
  String result = canExecuteCommand(cmd, 0);
  server.sendHeader("Access-Control-Allow-Origin","*");
  server.send(200, "text/json", result);
}

static void handleCommand() {
  const int cmdBufSize = 128;
  if(!server.hasArg("cmd")) {server.send(500, "text/plain", "BAD ARGS"); return;}

  String cmd = server.arg("cmd").substring(0, cmdBufSize);

  // Route through CAN if in CAN mode
  if (canMode) {
    handleCanCommand(cmd);
    return;
  }

  int repeat = 0;
  char buffer[255];
  size_t len = 0;
  String output;

  if (server.hasArg("repeat"))
    repeat = server.arg("repeat").toInt();

  if (!fastUart && fastUartAvailable)
  {
    sendCommand("fastuart");
    uart_set_baudrate(INVERTER_PORT, 921600);
    fastUart = true;
  }

  sendCommand(cmd);
  do {
    memset(buffer,0,sizeof(buffer));
    //len = Inverter.readBytes(buffer, sizeof(buffer) - 1);
    len = uart_read_bytes(INVERTER_PORT, buffer, sizeof(buffer), UART_TIMEOUT);
    if(len > 0) output.concat(buffer, len);// += buffer;

    if (repeat)
    {
      repeat--;
      //Inverter.print("!");
      uart_write_bytes(INVERTER_PORT, "!", 1);
      //Inverter.readBytes(buffer, 1); //consume "!"
      uart_read_bytes(INVERTER_PORT, buffer, 1, UART_TIMEOUT);
    }
  } while (len > 0);
  DBG_OUTPUT_PORT.println(output);
  server.sendHeader("Access-Control-Allow-Origin","*");
  server.send(200, "text/json", output);
}

// SDO read with abort detection and index verification (for walking mapping/error tables)
static bool canSdoReadEntry(uint16_t index, uint8_t subIndex, int32_t* value) {
  twai_message_t resp;
  while (canDriverReceive(&resp)) {} // drain stale frames

  if (!canSdoRead(canNodeId, index, subIndex)) return false;
  if (!canReceiveForNode(canNodeId, &resp, 50)) return false;
  if (resp.data[0] == SDO_ABORT) return false;

  uint16_t rIndex;
  uint8_t rSubIndex;
  if (!canSdoParseResponse(&resp, NULL, &rIndex, &rSubIndex, value)) return false;
  return rIndex == index && rSubIndex == subIndex;
}

// SDO write that waits for and verifies the confirmation
// Returns 0 on success, the SDO abort code on rejection, -1 on comm failure
static int32_t canSdoWriteChecked(uint16_t index, uint8_t subIndex, int32_t value) {
  twai_message_t resp;
  while (canDriverReceive(&resp)) {} // drain stale frames

  if (!canSdoWrite(canNodeId, index, subIndex, value)) return -1;
  if (!canReceiveForNode(canNodeId, &resp, 200)) return -1;
  if (resp.data[0] == SDO_WRITE_RESPONSE) return 0;
  if (resp.data[0] == SDO_ABORT) {
    int32_t code;
    memcpy(&code, &resp.data[4], 4);
    return code ? code : -1;
  }
  return -1;
}

// Translate an error/enum value to its name using a unit string like "0=None, 1=UdcLow"
static String canLookupEnum(const String& unitStr, uint32_t value) {
  String key = String(value) + "=";
  int pos = -1;
  if (unitStr.startsWith(key)) pos = key.length();
  else {
    int i = unitStr.indexOf("," + key);
    if (i >= 0) pos = i + 1 + key.length();
    else {
      i = unitStr.indexOf(", " + key);
      if (i >= 0) pos = i + 2 + key.length();
    }
  }
  if (pos < 0) return String(value);
  int end = unitStr.indexOf(',', pos);
  if (end < 0) end = unitStr.length();
  String name = unitStr.substring(pos, end);
  name.trim();
  return name.length() ? name : String(value);
}

// Extract a parameter's unit string from the cached JSON
static String canGetParamUnit(const String& name) {
  int entry = canParamJson.indexOf("\"" + name + "\"");
  if (entry < 0) return "";
  int unitPos = canParamJson.indexOf("\"unit\":\"", entry);
  if (unitPos < 0) return "";
  unitPos += 8;
  int unitEnd = canParamJson.indexOf('"', unitPos);
  if (unitEnd < 0) return "";
  return canParamJson.substring(unitPos, unitEnd);
}

// CAN command execution — parses OpenInverter text commands and translates to CAN SDO
static String canExecuteCommand(const String& cmdStr, int repeat) {
  String result;

  // Auto-download parameter cache on first json call
  if (!canParamCacheLoaded) {
    canDownloadParamCache();
  }

  // Handle "json" — full parameter dump: cached metadata + live SDO values
  if (cmdStr == "json") {
    if (canParamCacheLoaded)
      return canBuildJsonWithValues();

    // Cache not loaded yet — return minimal response (no can_cache flag,
    // so the UI shows the device as disconnected)
    result = "{\"status\":{\"value\":0,\"isparam\":false,\"unit\":\"\"}";
    result += ",\"opmode\":{\"value\":0,\"isparam\":false,\"unit\":\"\"}}";
    return result;
  }

  // Handle "get param1,param2,..." — individual SDO reads (optimized for speed)
  if (cmdStr.startsWith("get ")) {
    String names = cmdStr.substring(4);
    result = "";
    int commaIdx = 0;
    int count = 0;
    while (commaIdx >= 0 && count < 50) {
      int nextComma = names.indexOf(',', commaIdx);
      String name;
      if (nextComma >= 0) {
        name = names.substring(commaIdx, nextComma);
        commaIdx = nextComma + 1;
      } else {
        name = names.substring(commaIdx);
        commaIdx = -1;
      }
      name.trim();
      if (name.length() > 0) {
        int paramId = canGetParamId(name);
        float val = (paramId >= 0) ? canReadParamValue(paramId) : NAN;
        result += (isnan(val) ? "0.00" : String(val, 2));
        if (commaIdx >= 0) result += "\t";
        count++;
      }
    }
    return result;
  }

  // Handle "set name value"
  if (cmdStr.startsWith("set ")) {
    String rest = cmdStr.substring(4);
    int spaceIdx = rest.indexOf(' ');
    if (spaceIdx > 0) {
      String name = rest.substring(0, spaceIdx);
      float val = rest.substring(spaceIdx + 1).toFloat();
      int paramId = canGetParamId(name);
      if (paramId < 0) return "Unknown parameter";

      int32_t err = canSdoWriteChecked(canParamIndex(paramId), canParamSubIndex(paramId), canEncodeValue(val));
      if (err == 0) return "Set OK";
      if (err == (int32_t)SDO_ERR_RANGE) return "Value out of range";
      return "Set failed";
    }
    return "error";
  }

  // Handle simple commands
  if (cmdStr == "start 2" || cmdStr == "start") {
    canSdoCommand(canNodeId, CAN_CMD_START);
    return "started";
  }
  if (cmdStr == "stop") {
    canSdoCommand(canNodeId, CAN_CMD_STOP);
    return "stopped";
  }
  if (cmdStr == "reset") {
    canSdoWrite(canNodeId, CAN_INDEX_COMMANDS, CAN_CMD_RESET, 1);
    return "reset sent";
  }
  if (cmdStr == "save") {
    canSdoCommand(canNodeId, CAN_CMD_SAVE);
    return "saved";
  }
  if (cmdStr == "load") {
    canSdoCommand(canNodeId, CAN_CMD_LOAD);
    return "loaded";
  }
  if (cmdStr == "errors") {
    // Walk the error log: timestamps at 0x5004, codes at 0x5003, one pair
    // per subindex until the device aborts or the timestamp is zero
    String unitStr = canGetParamUnit("lasterr");
    result = "";
    for (int i = 0; i < 100; i++) {
      int32_t errTime, errNum;
      if (!canSdoReadEntry(CAN_INDEX_ERROR_TIME, i, &errTime)) break;
      if (errTime == 0) break;
      if (!canSdoReadEntry(CAN_INDEX_ERRORS, i, &errNum)) break;
      result += "[" + String(errTime) + "]: " + canLookupEnum(unitStr, (uint32_t)errNum) + "\r\n";
    }
    return result;
  }
  if (cmdStr == "fastuart") {
    return "ok";
  }
  if (cmdStr.startsWith("can ")) {
    String rest = cmdStr.substring(4);
    rest.trim();

    if (rest == "clear") {
      // Device command 6 clears all mappings
      if (canSdoWriteChecked(CAN_INDEX_COMMANDS, CAN_CMD_CLEAR_MAP, 0) == 0) return "cleared";
      return "error: clear failed";
    }

    if (rest == "list" || rest.startsWith("list")) {
      // Walk the read indices: each message holds sub0 = COB ID, then item
      // pairs (paramid/pos/len, gain/offset) until the device aborts
      result = "[";
      bool first = true;
      for (int dir = 0; dir < 2; dir++) {
        uint16_t index = dir ? CAN_INDEX_MAP_RD_RX : CAN_INDEX_MAP_RD;
        while (true) {
          int32_t cobid;
          if (!canSdoReadEntry(index, 0, &cobid)) break; // no more messages
          int sub = 1;
          bool gotItem = false;
          while (sub < 100) {
            int32_t posLen, gainOfs;
            if (!canSdoReadEntry(index, sub, &posLen)) break;       // no more items
            if (!canSdoReadEntry(index, sub + 1, &gainOfs)) break;
            uint16_t paramid = posLen & 0xFFFF;
            int pos = (posLen >> 16) & 0xFF;
            int len = (int8_t)((posLen >> 24) & 0xFF);
            // gain: signed 24-bit fixed point (x1000); offset: signed byte
            int32_t gainFp = ((gainOfs & 0xFFFFFF) << 8) >> 8;
            float gain = gainFp / 1000.0f;
            int offset = (int8_t)((gainOfs >> 24) & 0xFF);

            if (!first) result += ",";
            result += "{\"isrx\":" + String(dir ? "true" : "false") +
                      ",\"id\":" + String(cobid) +
                      ",\"paramid\":" + String(paramid) +
                      ",\"position\":" + String(pos) +
                      ",\"length\":" + String(len) +
                      ",\"gain\":" + String(gain, 3) +
                      ",\"offset\":" + String(offset) +
                      ",\"index\":" + String(index) +
                      ",\"subindex\":" + String(sub) + "}";
            first = false;
            gotItem = true;
            sub += 2;
          }
          if (!gotItem) break; // empty message — stop walking this direction
          index++;
        }
      }
      result += "]";
      return result;
    }

    if (rest.startsWith("rm ")) {
      // can rm <index> <subindex> — write 0 to a read-index entry to remove it
      String args = rest.substring(3);
      int sp = args.indexOf(' ');
      if (sp < 0) return "error: usage: can rm index subindex";
      uint16_t index = args.substring(0, sp).toInt();
      uint8_t sub = args.substring(sp + 1).toInt();
      if (canSdoWriteChecked(index, sub, 0) == 0) return "ok";
      return "error: remove failed";
    }

    // can tx/rx name canid pos bits gain [offset]
    int space1 = rest.indexOf(' ');
    if (space1 < 0) return "error: usage: can tx/rx name canid pos bits gain";
    String type = rest.substring(0, space1);
    if (type != "tx" && type != "rx") return "error: usage: can tx/rx name canid pos bits gain";
    bool isTx = (type == "tx");

    String args = rest.substring(space1 + 1);
    int space2 = args.indexOf(' ');
    if (space2 < 0) return "error: missing arguments";
    String name = args.substring(0, space2);

    args = args.substring(space2 + 1);
    int space3 = args.indexOf(' ');
    if (space3 < 0) return "error: missing canid";
    // base 0: decimal by default, hex with 0x prefix
    uint32_t canId = strtoul(args.substring(0, space3).c_str(), NULL, 0);

    args = args.substring(space3 + 1);
    int space4 = args.indexOf(' ');
    if (space4 < 0) return "error: missing pos";
    int pos = args.substring(0, space4).toInt();

    args = args.substring(space4 + 1);
    int space5 = args.indexOf(' ');
    int bits = (space5 >= 0) ? args.substring(0, space5).toInt() : args.toInt();
    float gain = 1;
    int offset = 0;
    if (space5 >= 0) {
      args = args.substring(space5 + 1);
      int space6 = args.indexOf(' ');
      gain = (space6 >= 0) ? args.substring(0, space6).toFloat() : args.toFloat();
      if (space6 >= 0) offset = args.substring(space6 + 1).toInt();
    }

    int paramId = canGetParamId(name);
    if (paramId < 0) return "error: unknown parameter";

    // Three-stage add: COB ID, then param/pos/len, then gain/offset
    uint16_t mapIndex = isTx ? CAN_INDEX_MAP_TX : CAN_INDEX_MAP_RX;
    if (canSdoWriteChecked(mapIndex, 0, canId) != 0) return "error: COB ID rejected";
    if (canSdoWriteChecked(mapIndex, 1, (uint32_t)paramId | ((uint32_t)(pos & 0xFF) << 16) | ((uint32_t)(bits & 0xFF) << 24)) != 0)
      return "error: position/length rejected";
    if (canSdoWriteChecked(mapIndex, 2, ((int32_t)(gain * 1000) & 0xFFFFFF) | ((uint32_t)(offset & 0xFF) << 24)) != 0)
      return "error: gain/offset rejected";
    return "ok";
  }

  return "unknown command";
}

static uint32_t crc32_word(uint32_t Crc, uint32_t Data)
{
  int i;

  Crc = Crc ^ Data;

  for(i=0; i<32; i++)
    if (Crc & 0x80000000)
      Crc = (Crc << 1) ^ 0x04C11DB7; // Polynomial used in STM32
    else
      Crc = (Crc << 1);

  return(Crc);
}

static uint32_t crc32(uint32_t* data, uint32_t len, uint32_t crc)
{
   for (uint32_t i = 0; i < len; i++)
      crc = crc32_word(crc, data[i]);
   return crc;
}


// Wait for a frame from the CAN bootloader (0x7DE), skipping other traffic
static bool canWaitBootFrame(twai_message_t* f, uint32_t timeoutMs)
{
  uint32_t start = millis();
  while (millis() - start < timeoutMs) {
    if (canDriverReceive(f) && f->identifier == CAN_BOOTLOADER_RESP) return true;
    delay(1);
  }
  return false;
}

// Send the next 8 bytes of the firmware file (0xFF padded) and fold them
// into the running page CRC (STM32 hardware CRC32, two words per chunk)
static void canSendBootChunk(File& file, size_t pos, size_t fileSize, uint32_t* crc)
{
  uint8_t buf[8];
  size_t n = 0;
  if (pos < fileSize) {
    file.seek(pos);
    n = file.read(buf, 8);
  }
  while (n < 8) buf[n++] = 0xFF;
  *crc = crc32_word(*crc, *(uint32_t*)&buf[0]);
  *crc = crc32_word(*crc, *(uint32_t*)&buf[4]);
  canDriverSend(CAN_BOOTLOADER_CMD, buf, 8);
}

// CAN bootloader firmware update — OpenInverter CAN bootloader protocol.
// The bootloader drives the transfer over 0x7DE; the host answers on 0x7DD:
//   0x33 magic after reset -> reflect device ID to enter update mode
//   'S' -> send page count (1 byte)
//   'P' -> send next 8 bytes of page data
//   'C' -> send page CRC32; reply 'P' = ok (and requests next page's data),
//          'E' = CRC error (resend page), 'D' = done
// Mapped to HTTP steps: -1 = reset + handshake (consumes the first 'P'),
// 0..pages-1 = transfer one 1KB page each.
static void handleCanFwUpdate()
{
  if (!canMode) { server.send(400, "text/plain", "CAN mode required"); return; }
  if(!server.hasArg("step") || !server.hasArg("file")) { server.send(500, "text/plain", "BAD ARGS"); return; }

  const size_t PAGE_SIZE = 1024;
  int step = server.arg("step").toInt();
  File file = SPIFFS.open(server.arg("file"), "r");
  if (!file) { server.send(500, "text/json", "{\"message\":\"Failed to open file\"}"); return; }

  size_t fileSize = file.size();
  if (fileSize == 0) {
    file.close();
    server.send(500, "text/json", "{\"message\":\"Firmware file is empty\"}");
    return;
  }
  uint16_t pages = (fileSize + PAGE_SIZE - 1) / PAGE_SIZE;
  twai_message_t frame;

  if (step == -1) {
    // Reset the device and catch the bootloader magic
    while (canDriverReceive(&frame)) {} // drain stale frames
    canSdoWrite(canNodeId, CAN_INDEX_COMMANDS, CAN_CMD_RESET, 1);

    bool gotMagic = false;
    uint32_t start = millis();
    while (millis() - start < 10000) {
      if (canDriverReceive(&frame) && frame.identifier == CAN_BOOTLOADER_RESP && frame.data[0] == 0x33) {
        gotMagic = true;
        break;
      }
      delay(1);
    }
    if (!gotMagic) {
      file.close();
      server.send(500, "text/json", "{\"message\":\"No bootloader magic after reset\"}");
      return;
    }

    // Reflect the device ID back to enter update mode
    uint8_t id[4] = {frame.data[4], frame.data[5], frame.data[6], frame.data[7]};
    bool oldBootloader = frame.data[1] < 1;
    canDriverSend(CAN_BOOTLOADER_CMD, id, 4);
    if (oldBootloader) delay(100); // bootloader with timing quirk

    // Wait for size request, answer with the page count
    if (!canWaitBootFrame(&frame, 5000) || frame.data[0] != 'S') {
      file.close();
      server.send(500, "text/json", "{\"message\":\"Bootloader did not request size\"}");
      return;
    }
    uint8_t pageCount = pages;
    canDriverSend(CAN_BOOTLOADER_CMD, &pageCount, 1);

    // Consume the first page-data request so step 0 starts by sending data
    if (!canWaitBootFrame(&frame, 15000) || frame.data[0] != 'P') {
      file.close();
      server.send(500, "text/json", "{\"message\":\"Bootloader did not request data\"}");
      return;
    }

    file.close();
    DBG_OUTPUT_PORT.printf("CAN fwupdate: bootloader ready, %d pages\n", pages);
    server.send(200, "text/json", "{\"pages\":" + String(pages) + ",\"message\":\"Bootloader ready\"}");
    return;
  }

  if (step >= 0 && step < pages) {
    // Transfer one page: the previous step consumed this page's first 'P',
    // so send the first chunk immediately, then answer further requests
    for (int attempt = 0; attempt < 3; attempt++) {
      uint32_t crc = 0xFFFFFFFF;
      size_t pos = (size_t)step * PAGE_SIZE;
      bool crcSent = false;
      bool timeout = false;
      bool pageOk = false;

      canSendBootChunk(file, pos, fileSize, &crc);
      pos += 8;

      while (!pageOk && !timeout) {
        if (!canWaitBootFrame(&frame, 5000)) { timeout = true; break; }
        uint8_t c = frame.data[0];

        if (!crcSent && c == 'P') {            // next chunk request
          canSendBootChunk(file, pos, fileSize, &crc);
          pos += 8;
        }
        else if (!crcSent && c == 'C') {       // CRC request
          uint8_t crcBytes[4] = {(uint8_t)crc, (uint8_t)(crc >> 8), (uint8_t)(crc >> 16), (uint8_t)(crc >> 24)};
          canDriverSend(CAN_BOOTLOADER_CMD, crcBytes, 4);
          crcSent = true;
        }
        else if (crcSent && (c == 'P' || c == 'D')) { // page accepted ('P' doubles as next page's first request)
          pageOk = true;
        }
        else if (crcSent && c == 'E') {        // CRC error — resend this page
          break;
        }
      }

      if (pageOk) {
        file.close();
        server.send(200, "text/json", "{\"pages\":" + String(pages) + ",\"message\":\"Page " + String(step) + " written\"}");
        return;
      }
      if (timeout) {
        file.close();
        server.send(500, "text/json", "{\"message\":\"Bootloader timeout at page " + String(step) + "\"}");
        return;
      }
      // 'E' received: bootloader will re-request the page with a fresh 'P'
      if (!canWaitBootFrame(&frame, 5000) || frame.data[0] != 'P') {
        file.close();
        server.send(500, "text/json", "{\"message\":\"Bootloader lost sync after CRC error\"}");
        return;
      }
      DBG_OUTPUT_PORT.printf("CAN fwupdate: CRC error on page %d, retrying\n", step);
    }
    file.close();
    server.send(500, "text/json", "{\"message\":\"Page " + String(step) + " failed after retries\"}");
    return;
  }

  file.close();
  server.send(200, "text/json", "{\"pages\":" + String(pages) + "}");
}

static void handleUpdate()
{
  // Route to the CAN bootloader flow when in CAN mode
  if (canMode) { handleCanFwUpdate(); return; }

  if(!server.hasArg("step") || !server.hasArg("file")) {server.send(500, "text/plain", "BAD ARGS"); return;}
  size_t PAGE_SIZE_BYTES = 1024;
  int step = server.arg("step").toInt();
  File file = SPIFFS.open(server.arg("file"), "r");

  // Check if file was opened successfully
  if (!file) {
    server.send(500, "text/json", "{ \"message\": \"Failed to open firmware file\" }");
    return;
  }

  size_t fileSize = file.size();
  if (fileSize == 0) {
    file.close();
    server.send(500, "text/json", "{ \"message\": \"Firmware file is empty\" }");
    return;
  }

  String message;

  if (server.hasArg("pagesize"))
  {
    PAGE_SIZE_BYTES = server.arg("pagesize").toInt();
    // Clamp: buffer below lives on the stack and the bootloader uses 1KB pages
    if (PAGE_SIZE_BYTES < 256 || PAGE_SIZE_BYTES > 1024) PAGE_SIZE_BYTES = 1024;
  }

  // Note: the bootloader receives the page count as a single byte, so files
  // larger than 255 pages cannot be transferred with this protocol
  uint16_t pages = (uint16_t)((fileSize + PAGE_SIZE_BYTES - 1) / PAGE_SIZE_BYTES);

  // Timeout/retry helper macro for bootloader handshake loops
  #define HANDSHAKE_TIMEOUT 100  // ~10 seconds (100 * 100ms)

  if (step == -1)
  {
    char c = 0;
    uint16_t retries = 0;
    sendCommand("reset");

    if (fastUart)
    {
      uart_set_baudrate(INVERTER_PORT, 115200);
      fastUart = false;
      fastUartAvailable = true; //retry after reboot
    }
    do {
      uart_read_bytes(INVERTER_PORT, &c, 1, UART_TIMEOUT);
      if (++retries > HANDSHAKE_TIMEOUT) {
        file.close();
        server.send(500, "text/json", "{ \"message\": \"Bootloader handshake timeout waiting for S/2\" }");
        return;
      }
    } while (c != 'S' && c != '2');

    if (c == '2') //version 2 bootloader
    {
      c = 0xAA;
      uart_write_bytes(INVERTER_PORT, &c, 1);
      retries = 0;
      do {
        uart_read_bytes(INVERTER_PORT, &c, 1, UART_TIMEOUT);
        if (++retries > HANDSHAKE_TIMEOUT) {
          file.close();
          server.send(500, "text/json", "{ \"message\": \"Bootloader v2 handshake timeout\" }");
          return;
        }
      } while (c != 'S');
    }
    
    uart_write_bytes(INVERTER_PORT, &pages, 1);
    retries = 0;
    do {
      uart_read_bytes(INVERTER_PORT, &c, 1, UART_TIMEOUT);
      if (++retries > HANDSHAKE_TIMEOUT) {
        file.close();
        server.send(500, "text/json", "{ \"message\": \"Bootloader handshake timeout waiting for P\" }");
        return;
      }
    } while (c != 'P');
    message = "reset";
  }
  else
  {
    bool repeat = true;
    file.seek(step * PAGE_SIZE_BYTES);
    char buffer[PAGE_SIZE_BYTES];
    size_t bytesRead = file.readBytes(buffer, sizeof(buffer));

    while (bytesRead < PAGE_SIZE_BYTES)
      buffer[bytesRead++] = 0xff;
    
    uint32_t crc = crc32((uint32_t*)buffer, PAGE_SIZE_BYTES / 4, 0xffffffff);

    uint16_t pageRetries = 0;
    #define PAGE_RETRY_MAX 10

    while (repeat)
    {
      uart_write_bytes(INVERTER_PORT, buffer, sizeof(buffer));
      char res = 0;
      uint16_t readRetries = 0;
      while(uart_read_bytes(INVERTER_PORT, &res, 1, UART_TIMEOUT)<=0) {
        if (++readRetries > HANDSHAKE_TIMEOUT) {
          file.close();
          server.send(500, "text/json", "{ \"message\": \"Page write timeout: no response from bootloader\" }");
          return;
        }
      }

      if ('C' == res) {
        uart_write_bytes(INVERTER_PORT, (char*)&crc, sizeof(uint32_t));
        readRetries = 0;
        while(uart_read_bytes(INVERTER_PORT, &res, 1, UART_TIMEOUT)<=0) {
          if (++readRetries > HANDSHAKE_TIMEOUT) {
            file.close();
            server.send(500, "text/json", "{ \"message\": \"CRC check timeout\" }");
            return;
          }
        }
      }

      switch (res) {
        case 'D':
          message = "Update Done";
          repeat = false;
          fastUartAvailable = true;
          break;
        case 'E':
          readRetries = 0;
          do {
            uart_read_bytes(INVERTER_PORT, uartMessBuff, 1, UART_TIMEOUT);
            if (++readRetries > HANDSHAKE_TIMEOUT) {
              file.close();
              server.send(500, "text/json", "{ \"message\": \"Flash error timeout\" }");
              return;
            }
          } while (uartMessBuff[0] != 'T');
          pageRetries++;
          if (pageRetries >= PAGE_RETRY_MAX) {
            repeat = false;
            message = "Page write failed after max retries";
          }
          break;
        case 'P':
          message = "Page write success";
          repeat = false;
          break;
        default:
        case 'T':
          break;
      }
    }
  }
  server.send(200, "text/json", "{ \"message\": \"" + message + "\", \"pages\": " + pages + " }");
  file.close();
}

static void handleWifi()
{
  bool updated = true;
  if(server.hasArg("apSSID") && server.hasArg("apPW")) 
  {
    WiFi.softAP(server.arg("apSSID").c_str(), server.arg("apPW").c_str());
  }
  else if(server.hasArg("staSSID") && server.hasArg("staPW")) 
  {
    WiFi.mode(WIFI_AP_STA);
    WiFi.begin(server.arg("staSSID").c_str(), server.arg("staPW").c_str());
  }
  else
  {
    File file = SPIFFS.open("/wifi.html", "r");
    String html = file.readString();
    file.close();
    html.replace("%staSSID%", WiFi.SSID());
    html.replace("%apSSID%", WiFi.softAPSSID());
    html.replace("%staIP%", WiFi.localIP().toString());
    server.send(200, "text/html", html);
    updated = false;
  }

  if (updated)
  {
    File file = SPIFFS.open("/wifi-updated.html", "r");
    size_t sent = server.streamFile(file, getContentType("wifi-updated.html"));
    file.close();    
  }
}

static void handleBaud()
{
  if (fastUart)
    server.send(200, "text/html", "fastUart on");
  else
    server.send(200, "text/html", "fastUart off");
}

// Read the saved can_nodes array out of settings.json (returns "[]" if absent)
static String readSavedCanNodes()
{
  String nodes = "[]";
  if (SPIFFS.exists("/settings.json")) {
    File f = SPIFFS.open("/settings.json", "r");
    if (f) {
      String json = f.readString();
      f.close();
      int s = json.indexOf("\"can_nodes\":[");
      if (s >= 0) {
        int e = json.indexOf(']', s);
        if (e >= 0) nodes = json.substring(s + 12, e + 1);
      }
    }
  }
  return nodes;
}

static void saveSettings(const String& canNodesJson)
{
  File f = SPIFFS.open("/settings.json", "w");
  if (f) {
    f.printf("{\"txrx_swapped\":%s,\"can_mode\":%s,\"can_node_id\":%d,\"can_speed\":%d,\"can_rx_pin\":%d,\"can_tx_pin\":%d,\"can_nodes\":%s}",
             txrxSwapped ? "true" : "false",
             canMode ? "true" : "false",
             canNodeId, canSpeed, canRxPin, canTxPin,
             canNodesJson.c_str());
    f.close();
  }
}

// Preserve the saved node list when writing other settings
static void saveSettings() { saveSettings(readSavedCanNodes()); }

static void loadSettings()
{
  if (SPIFFS.exists("/settings.json")) {
    File f = SPIFFS.open("/settings.json", "r");
    if (f) {
      String json = f.readString();
      f.close();
      txrxSwapped = json.indexOf("\"txrx_swapped\":false") < 0;

      canMode = json.indexOf("\"can_mode\":true") >= 0;

      int ni = json.indexOf("\"can_node_id\":");
      if (ni >= 0) canNodeId = json.substring(ni + 14).toInt();
      // Prefer the node flagged as default in the saved node list (set by the UI)
      int ns = json.indexOf("\"can_nodes\":[");
      if (ns >= 0) {
        int ne = json.indexOf(']', ns);
        if (ne > ns) {
          String nodes = json.substring(ns, ne);
          int dp = nodes.indexOf("\"default\":true");
          if (dp >= 0) {
            int os = nodes.lastIndexOf('{', dp);
            int oe = nodes.indexOf('}', os);
            int ip = nodes.indexOf("\"nodeId\":", os);
            if (os >= 0 && ip > os && (oe < 0 || ip < oe)) canNodeId = nodes.substring(ip + 9).toInt();
          }
        }
      }
      int sp = json.indexOf("\"can_speed\":");
      if (sp >= 0) canSpeed = json.substring(sp + 12).toInt();
      int rp = json.indexOf("\"can_rx_pin\":");
      if (rp >= 0) canRxPin = json.substring(rp + 13).toInt();
      int tp = json.indexOf("\"can_tx_pin\":");
      if (tp >= 0) canTxPin = json.substring(tp + 13).toInt();

      if (canNodeId < 1) canNodeId = 1;
      if (canNodeId > 32) canNodeId = 32;
      if (canSpeed < 0 || canSpeed > 2) canSpeed = 2;
    }
  }
}

static void handleSettings()
{
  if (server.hasArg("txrx_swap")) {
    txrxSwapped = (server.arg("txrx_swap") == "1");
    saveSettings();
    initUART(true);
    server.send(200, "text/json", "{\"result\":\"ok\"}");
  } else if (server.hasArg("can_mode")) {
    canMode = (server.arg("can_mode") == "1");
    if (server.hasArg("can_node_id")) canNodeId = server.arg("can_node_id").toInt();
    if (server.hasArg("can_speed")) canSpeed = server.arg("can_speed").toInt();
    if (server.hasArg("can_rx_pin")) canRxPin = server.arg("can_rx_pin").toInt();
    if (server.hasArg("can_tx_pin")) canTxPin = server.arg("can_tx_pin").toInt();
    if (canNodeId < 1) canNodeId = 1;
    if (canNodeId > 32) canNodeId = 32;
    if (canSpeed < 0 || canSpeed > 2) canSpeed = 2;

    // Save can_nodes JSON array if provided, otherwise keep the stored list
    String canNodesJson = server.hasArg("can_nodes") ? server.arg("can_nodes")
                                                     : readSavedCanNodes();
    saveSettings(canNodesJson);

    // Restart CAN if enabling — filter on the active node, and drop the
    // param cache so it reloads (node/speed/pins may have changed)
    if (canMode) {
      CanSpeed speed = (canSpeed == 0) ? CAN_125K : (canSpeed == 1) ? CAN_250K : CAN_500K;
      canDriverStop();
      canDriverInitForDevice(canNodeId, speed, canTxPin, canRxPin);
      canParamCacheLoaded = false;
      canParamJson = "";
    } else {
      canDriverStop();
    }
    server.send(200, "text/json", "{\"result\":\"ok\"}");
  } else {
    String json = "{\"txrx_swapped\":";
    json += txrxSwapped ? "true" : "false";
    json += ",\"can_mode\":";
    json += canMode ? "true" : "false";
    json += ",\"can_node_id\":";
    json += canNodeId;
    json += ",\"can_speed\":";
    json += canSpeed;
    json += ",\"can_rx_pin\":";
    json += canRxPin;
    json += ",\"can_tx_pin\":";
    json += canTxPin;
    // Return can_nodes from settings file if present
    if (SPIFFS.exists("/settings.json")) {
      File f = SPIFFS.open("/settings.json", "r");
      if (f) {
        String settingsJson = f.readString();
        f.close();
        int nodesStart = settingsJson.indexOf("\"can_nodes\":[");
        if (nodesStart >= 0) {
          int nodesEnd = settingsJson.indexOf(']', nodesStart);
          if (nodesEnd >= 0) {
            json += ",\"can_nodes\":" + settingsJson.substring(nodesStart + 12, nodesEnd + 1);
          }
        }
      }
    }
    json += "}";
    server.send(200, "text/json", json);
  }
}

void staCheck(){
  sta_tick.detach();
  if(!(uint32_t)WiFi.localIP()){
    WiFi.mode(WIFI_AP); //disable station mode
  }
}

void setup(void){
  DBG_OUTPUT_PORT.begin(115200);
  //Inverter.setRxBufferSize(50000);
  //Inverter.begin(115200, SERIAL_8N1, INVERTER_RX, INVERTER_TX);
  //Need to use low level Espressif IDF API instead of Serial to get high enough data rates
  
  // Initialize SPIFFS early so we can load settings before UART init
  SPIFFS.begin();
  loadSettings();
  initUART(); 
  

  //check for external RTC and if present use to initialise on-chip RTC
  if (ext_rtc.begin())
  {
    haveRTC = true;
    DBG_OUTPUT_PORT.println("External RTC found");  
    if (! ext_rtc.initialized() || ext_rtc.lostPower()) 
    {
      DBG_OUTPUT_PORT.println("RTC is NOT initialized, setting to build time");
      ext_rtc.adjust(DateTime(F(__DATE__), F(__TIME__)));
    }

    ext_rtc.start();
    DateTime now = ext_rtc.now();
    int_rtc.setTime(now.unixtime());  
  }
  else
    DBG_OUTPUT_PORT.println("No RTC found, defaulting to sequential file names"); 

#ifndef S3_SKIP_SD_MMC
  //initialise SD card in SDIO mode with timeout (SD_MMC.begin blocks without card)
  {
    TaskHandle_t sdTask = NULL;
    bool sdDone = false;
    xTaskCreate([](void* param) {
      bool* done = (bool*)param;
      if (SD_MMC.begin("/sdcard", true, false, 40000, 5U)) {
        *done = true;
      }
      vTaskDelete(NULL);
    }, "sdinit", 4096, &sdDone, 1, &sdTask);
    
    // Wait up to 1 second for SD card init
    for (int i = 0; i < 10 && !sdDone; i++) {
      delay(100);
    }
    if (sdTask) vTaskDelete(sdTask);
    
    if (sdDone) {
      haveSDCard = true;
      DBG_OUTPUT_PORT.println("Started SD_MMC");
    } else {
      haveSDCard = false;
      DBG_OUTPUT_PORT.println("SD_MMC timed out or no card");
    }
  }
#endif

  //SPIFFS already started above (before UART init to load settings)

  // CAN bus initialization (if enabled) — filter on the saved active node
  if (canMode) {
    CanSpeed speed = (canSpeed == 0) ? CAN_125K : (canSpeed == 1) ? CAN_250K : CAN_500K;
    if (canDriverInitForDevice(canNodeId, speed, canTxPin, canRxPin)) {
      DBG_OUTPUT_PORT.printf("CAN bus started (node %d, %dkbps, RX=%d TX=%d)\n",
                             canNodeId, (canSpeed == 0 ? 125 : canSpeed == 1 ? 250 : 500),
                             canRxPin, canTxPin);
    } else {
      DBG_OUTPUT_PORT.println("CAN bus init failed");
      canMode = false;
    }
  }

  //WIFI INIT
  #ifdef WIFI_IS_OFF_AT_BOOT
    enableWiFiAtBootTime();
  #endif
  WiFi.mode(WIFI_AP_STA);
  //WiFi.setPhyMode(WIFI_PHY_MODE_11B);
  WiFi.setSleep(false);
  WiFi.setTxPower(WIFI_POWER_19_5dBm);//25); //dbm
  WiFi.begin();
  sta_tick.attach(10, staCheck);
  
  MDNS.begin(host);

  updater.setup(&server);
  
  //SERVER INIT
  ArduinoOTA.setHostname(host);
  ArduinoOTA.begin();
  //list directory
  server.on("/list", HTTP_GET, handleFileList);

  server.on("/rtc/now", HTTP_GET, handleRTCNow);
  server.on("/rtc/set", HTTP_POST, handleRTCSet);
  server.on("/sdcard/list", HTTP_GET, handleSdCardList);
  server.on("/sdcard/deleteAll", HTTP_GET, handleSdCardDeleteAll);

  //load editor
  server.on("/edit", HTTP_GET, [](){
    if(!handleFileRead("/edit.htm")) server.send(404, "text/plain", "FileNotFound");
  });
  //create file
  server.on("/edit", HTTP_PUT, handleFileCreate);
  //delete file
  server.on("/edit", HTTP_DELETE, handleFileDelete);
  //first callback is called after the request has ended with all parsed arguments
  //second callback handles file uploads at that location
  server.on("/edit", HTTP_POST, [](){ server.send(200, "text/plain", ""); }, handleFileUpload);

  server.on("/wifi", handleWifi);
  server.on("/cmd", handleCommand);
  server.on("/fwupdate", handleUpdate);
  server.on("/can-fwupdate", handleCanFwUpdate);
  server.on("/baud", handleBaud);
  server.on("/settings", HTTP_GET, handleSettings);
  server.on("/settings", HTTP_POST, handleSettings);
  server.on("/version", [](){ server.send(200, "text/plain", "4.0"); });
  server.on("/reboot", [](){ server.send(200, "text/plain", "Rebooting..."); ESP.restart(); });
  server.on("/reset-inverter", [](){
    server.send(200, "text/plain", "Inverter reset sent");
    if (canMode) {
      // SDO reset command (same as the firmware update flow uses)
      canSdoWrite(canNodeId, CAN_INDEX_COMMANDS, CAN_CMD_RESET, 1);
      return;
    }
    sendCommand("reset");
    // Reset UART state so baud rate renegotiates after inverter reboot
    if (fastUart) {
      uart_set_baudrate(INVERTER_PORT, 115200);
      fastUart = false;
      fastUartAvailable = true;
    }
  });
  server.on("/can-send", [](){
    if (!server.hasArg("canId")) {
      server.send(400, "text/json", "{\"error\":\"Missing canId\"}");
      return;
    }
    uint32_t canId = strtoul(server.arg("canId").c_str(), NULL, 16);
    uint8_t data[8] = {0};
    uint8_t len = 0;
    if (server.hasArg("data")) {
      String dataStr = server.arg("data");
      // Parse comma or space-separated hex bytes
      int idx = 0;
      while (idx < dataStr.length() && len < 8) {
        // Skip commas and spaces
        while (idx < dataStr.length() && (dataStr[idx] == ',' || dataStr[idx] == ' ')) idx++;
        if (idx >= dataStr.length()) break;
        String byteStr;
        while (idx < dataStr.length() && dataStr[idx] != ',' && dataStr[idx] != ' ') {
          byteStr += dataStr[idx++];
        }
        data[len++] = strtoul(byteStr.c_str(), NULL, 16);
      }
    }
    bool ok = canDriverSend(canId, data, len);
    String resp = "{\"status\":\"";
    resp += ok ? "sent" : "failed";
    resp += "\",\"canId\":";
    resp += canId;
    resp += ",\"len\":";
    resp += len;
    resp += "}";
    server.send(200, "text/json", resp);
  });
  server.on("/can-scan", [](){
    if (!canMode) {
      server.send(400, "text/json", "{\"error\":\"CAN mode not enabled\"}");
      return;
    }
    String result = "[";
    bool first = true;
    CanSpeed speed = (canSpeed == 0) ? CAN_125K : (canSpeed == 1) ? CAN_250K : CAN_500K;
    // Scan node IDs 1-32 by reading serial number
    for (int nid = 1; nid <= 32; nid++) {
      // Switch to narrow filter for this node to avoid noise
      canDriverInitForDevice(nid, speed, canTxPin, canRxPin);

      // Try to read serial number (index 0x5000, subIndex 0)
      if (canSdoRead(nid, CAN_INDEX_SERIAL, 0)) {
        twai_message_t resp;
        if (canReceiveForNode(nid, &resp, 100)) {
          int32_t serial = 0;
          uint8_t rNodeId;
          if (canSdoParseResponse(&resp, &rNodeId, NULL, NULL, &serial)) {
            if (!first) result += ",";
            result += "{\"nodeId\":" + String(nid) + ",\"serial\":" + String(serial) + "}";
            first = false;
          }
        }
      }
      delay(5); // Small delay between nodes
    }
    result += "]";
    // Return to scanning mode
    canDriverInitScan(speed, canTxPin, canRxPin);
    server.send(200, "text/json", result);
  });
  server.on("/can-debug", [](){
    // ?reset=1: reset the device and capture all frames seen on the bus for 8s
    // (diagnoses whether a CAN bootloader announces itself after reset)
    if (server.hasArg("reset")) {
      CanSpeed speed = (canSpeed == 0) ? CAN_125K : (canSpeed == 1) ? CAN_250K : CAN_500K;
      canDriverInitAcceptAll(speed, canTxPin, canRxPin); // see ALL bus traffic
      twai_message_t frame;
      while (canDriverReceive(&frame)) {} // drain
      canSdoWrite(canNodeId, CAN_INDEX_COMMANDS, CAN_CMD_RESET, 1);

      String r = "{\"frames\":[";
      int count = 0;
      uint32_t start = millis();
      while (millis() - start < 8000 && count < 40) {
        if (canDriverReceive(&frame)) {
          if (count) r += ',';
          r += "{\"t\":" + String(millis() - start) + ",\"id\":\"0x" + String(frame.identifier, HEX) + "\",\"data\":\"";
          for (int i = 0; i < frame.data_length_code; i++) {
            char hex[4]; sprintf(hex, "%02X ", frame.data[i]); r += hex;
          }
          r += "\"}";
          count++;
        } else {
          delay(1);
        }
      }
      twai_status_info_t st;
      twai_get_status_info(&st);
      r += "],\"count\":" + String(count) + ",\"twai_state\":" + String(st.state) +
           ",\"rx_errors\":" + String(st.rx_error_counter) + ",\"tx_errors\":" + String(st.tx_error_counter) + "}";
      canDriverInitForDevice(canNodeId, speed, canTxPin, canRxPin); // restore device filter
      server.send(200, "text/json", r);
      return;
    }
    // Run a single segmented download attempt and report where it ended up
    const uint32_t bufSize = 49152;
    uint8_t* buf = (uint8_t*)malloc(bufSize);
    if (!buf) { server.send(500, "text/json", "{\"error\":\"oom\"}"); return; }
    bool complete = false;
    uint32_t t0 = millis();
    uint32_t bytesRead = canSdoReadSegmented(canNodeId, CAN_INDEX_JSON, buf, bufSize - 1, 100, &complete);
    uint32_t elapsed = millis() - t0;
    String head = "";
    for (uint32_t i = 0; i < 24 && i < bytesRead; i++) {
      char c = (char)buf[i];
      if (c == '"' || c == '\\') head += '\\';
      head += (c >= 32 && c < 127) ? c : '.';
    }
    free(buf);
    String r = "{\"nodeId\":" + String(canNodeId) +
               ",\"bytes\":" + String(bytesRead) +
               ",\"complete\":" + (complete ? "true" : "false") +
               ",\"stage\":" + String(canSegStatus.stage) +
               ",\"cmd\":" + String(canSegStatus.cmd) +
               ",\"ms\":" + String(elapsed) +
               ",\"head\":\"" + head + "\"}";
    server.send(200, "text/json", r);
  });
  server.on("/set-can-node", [](){
    if (server.hasArg("id")) {
      canNodeId = server.arg("id").toInt();
      if (canNodeId < 1) canNodeId = 1;
      if (canNodeId > 32) canNodeId = 32;
      // Clear parameter cache so it reloads for the new device
      canParamCacheLoaded = false;
      canParamJson = "";
      // Switch to device-specific filter
      CanSpeed speed = (canSpeed == 0) ? CAN_125K : (canSpeed == 1) ? CAN_250K : CAN_500K;
      canDriverInitForDevice(canNodeId, speed, canTxPin, canRxPin);
      // Persist the selection so reboots and settings saves keep this node
      saveSettings();
    }
    server.send(200, "text/json", "{\"nodeId\":" + String(canNodeId) + "}");
  });
  
  //called when the url is not defined here
  //use it to load content from SPIFFS
  server.onNotFound([](){
    if(!handleFileRead(server.uri()))
    {
      server.sendHeader("Refresh", "6; url=/update");
      server.send(404, "text/plain", "FileNotFound");
    }
  });

  server.begin();
  server.client().setNoDelay(1);

  MDNS.addService("http", "tcp", 80);
}

void binaryLoggingStart()
{
  if(createNextSDFile())
  {
    sendCommand(""); //flush out buffer in case just had power up
    delay(10);
    sendCommand("binarylogging 1"); //send start logging command to inverter
    delayMicroseconds(200);
    if (uart_readStartsWith("OK"))
    {
      uart_set_baudrate(INVERTER_PORT, 2250000);
      fastLoggingActive = true;
      DBG_OUTPUT_PORT.println("Binary logging started");
    }
    else //no response - in case it did actually switch but we missed response send the turn off command
    {
      dataFile.close();
      uart_set_baudrate(INVERTER_PORT, 2250000);
      uart_write_bytes(INVERTER_PORT, "\n", 1);
      delay(1);
      uart_write_bytes(INVERTER_PORT, "binarylogging 0", strnlen("binarylogging 0", UART_MESSBUF_SIZE));
      uart_write_bytes(INVERTER_PORT, "\n", 1);
      uart_wait_tx_done(INVERTER_PORT, UART_TIMEOUT);
      uart_set_baudrate(INVERTER_PORT, 115200);
    }
    delay(10);
    uart_flush(INVERTER_PORT);
  }
}

void binaryLoggingStop()
{
  uart_write_bytes(INVERTER_PORT, "\n", 1);
  delay(1);
  uart_write_bytes(INVERTER_PORT, "binarylogging 0", strnlen("binarylogging 0", UART_MESSBUF_SIZE));
  uart_write_bytes(INVERTER_PORT, "\n", 1);
  uart_wait_tx_done(INVERTER_PORT, UART_TIMEOUT);
  uart_set_baudrate(INVERTER_PORT, 115200);
  delay(100);
  uart_flush(INVERTER_PORT);
  //data should now have stopped so send command again and check response
  sendCommand("binarylogging 0");
  if (uart_readStartsWith("OK"))
  {
    uart_set_baudrate(INVERTER_PORT, 115200);
    fastUart = false;
    fastLoggingActive = false;
    dataFile.flush(); //make sure up to date
    dataFile.close();
    DBG_OUTPUT_PORT.println("Binary logging terminated");
  }
  else
  { //assume still logging so try again next time round
    uart_set_baudrate(INVERTER_PORT, 2250000);
  }
  delay(10);
  uart_flush(INVERTER_PORT);
}

 
void loop(void){
  // note: ArduinoOTA.handle() calls MDNS.update();
  server.handleClient();
  ArduinoOTA.handle();

  if((WiFi.softAPgetStationNum() > 0) || (WiFi.status() == WL_CONNECTED))
  { //have connections so stop logging
    startLogAttempt=0; //restart log attempts when next disconnected
    if(fastLoggingActive) //was it active last pass
      binaryLoggingStop();
  }
  else
  { //no connections so log
    if(fastLoggingActive) //already active, just carry on writing data
    {
      int spaceAvail = SDIO_BUFFER_SIZE - indexSDIObuffer;
      int bytesRead = uart_read_bytes(INVERTER_PORT, &SDIObuffer[indexSDIObuffer], spaceAvail, UART_TIMEOUT);
      if(bytesRead > 0)
      {
        indexSDIObuffer += bytesRead;
        if(indexSDIObuffer >= SDIO_BUFFER_SIZE)
        {
          dataFile.write(SDIObuffer, SDIO_BUFFER_SIZE);
          indexSDIObuffer = 0;
          blockCountSD++;
          if(blockCountSD >= FLUSH_WRITES)
          {
            blockCountSD = 0;
            dataFile.flush();
          }
        }
      }
    }
    else //not active so start
    {
      if(haveSDCard && fastLoggingEnabled && (startLogAttempt < 3) && (millis() > LOG_DELAY_VAL))
      {
        startLogAttempt++;
        binaryLoggingStart();
      }
    }
  }
}
