#include "mqtt_publisher.h"
#include <WiFi.h>
#include <WiFiClient.h>
#include <ESPmDNS.h>
#include <PubSubClient.h>
#include <Preferences.h>
#include "web_logic.h"

MqttPublisher mqttPublisher;

using mqttlogic::NamedValue;
using weblogic::jsonEscape;

static const uint32_t RECONNECT_MIN_MS = 5000;
static const uint32_t RECONNECT_MAX_MS = 60000;
static const uint32_t MDNS_TIMEOUT_MS = 2000;
static const char* NVS_NS = "oimqtt";

// ---- State shared by the HTTP handlers, the main loop and the task ----
// Everything below is guarded by `mtx`. The network objects are used only
// by the task.
static SemaphoreHandle_t mtx = nullptr;
static MqttConfig cfg;
static uint32_t cfgGen = 0;          // bumped on every config change
static String hostName = "inverter";
static TaskHandle_t task = nullptr;

static bool stConnected = false;
static int stState = -1;             // PubSubClient state()
static String stError;
static uint32_t stPublished = 0;
static uint32_t stConnects = 0;
static uint32_t stLastPublishMs = 0; // millis() of the last published round, 0 = none
static std::vector<String> stUnknown;

// One round of values waiting for the task
static std::vector<NamedValue> pending;
static bool pendingReady = false;
static uint32_t lastRoundMs = 0;
static bool roundStarted = false;

struct Lock {
  Lock() { xSemaphoreTake(mtx, portMAX_DELAY); }
  ~Lock() { xSemaphoreGive(mtx); }
};

static void ensureMutex()
{
  if (!mtx) mtx = xSemaphoreCreateMutex(); // first call is in setup(), before the task exists
}

static MqttConfig cleaned(const MqttConfig& in)
{
  MqttConfig c = in;
  c.host = mqttlogic::sanitizeToken(in.host, mqttlogic::HOST_MAX);
  c.port = mqttlogic::clampPort(in.port);
  c.user = mqttlogic::sanitizeToken(in.user, mqttlogic::USER_MAX);
  c.pass = mqttlogic::sanitizeSecret(in.pass);
  c.clientId = mqttlogic::sanitizeToken(in.clientId, mqttlogic::CLIENT_ID_MAX);
  c.prefix = mqttlogic::sanitizePrefix(in.prefix);
  c.names = mqttlogic::sanitizeNames(in.names);
  c.intervalSec = mqttlogic::clampInterval(in.intervalSec);
  return c;
}

// ---- Settings ----

void MqttPublisher::loadSettings(const String& json)
{
  ensureMutex();
  MqttConfig c;
  c.enabled = mqttlogic::jsonBool(json, "mqtt_enabled");
  c.host = mqttlogic::jsonStr(json, "mqtt_host");
  c.port = mqttlogic::clampPort(mqttlogic::jsonNum(json, "mqtt_port", 1883));
  c.user = mqttlogic::jsonStr(json, "mqtt_user");
  c.clientId = mqttlogic::jsonStr(json, "mqtt_client_id");
  c.prefix = mqttlogic::jsonStr(json, "mqtt_prefix");
  c.names = mqttlogic::jsonStr(json, "mqtt_names");
  c.intervalSec = mqttlogic::clampInterval(mqttlogic::jsonNum(json, "mqtt_interval", 5));
  c.retain = mqttlogic::jsonBool(json, "mqtt_retain");
  Preferences p;
  if (p.begin(NVS_NS, true)) { c.pass = p.getString("pass", ""); p.end(); }
  Lock l;
  cfg = cleaned(c);
  cfgGen++;
}

void MqttPublisher::begin(const String& hn)
{
  ensureMutex();
  {
    Lock l;
    if (hn.length()) hostName = hn;
  }
  ensureTask();
}

MqttConfig MqttPublisher::config() const
{
  Lock l;
  return cfg;
}

void MqttPublisher::setConfig(const MqttConfig& in)
{
  MqttConfig c = cleaned(in);
  bool passChanged;
  {
    Lock l;
    passChanged = c.pass != cfg.pass;
    cfg = c;
    cfgGen++;
    stError = "";
    stUnknown.clear();
    pending.clear();
    pendingReady = false;
    roundStarted = false;
  }
  if (passChanged) {
    Preferences p;
    if (p.begin(NVS_NS, false)) {
      if (c.pass.length()) p.putString("pass", c.pass);
      else p.remove("pass");
      p.end();
    }
  }
  if (c.enabled) ensureTask();
}

void MqttPublisher::reset()
{
  Preferences p;
  if (p.begin(NVS_NS, false)) { p.clear(); p.end(); }
  Lock l;
  cfg = MqttConfig();
  cfgGen++;
}

String MqttPublisher::settingsFields() const
{
  MqttConfig c = config();
  String j = ",\"mqtt_enabled\":";
  j += c.enabled ? "true" : "false";
  j += ",\"mqtt_host\":\"" + jsonEscape(c.host) + "\"";
  j += ",\"mqtt_port\":" + String(c.port);
  j += ",\"mqtt_user\":\"" + jsonEscape(c.user) + "\"";
  j += ",\"mqtt_client_id\":\"" + jsonEscape(c.clientId) + "\"";
  j += ",\"mqtt_prefix\":\"" + jsonEscape(c.prefix) + "\"";
  j += ",\"mqtt_names\":\"" + jsonEscape(c.names) + "\"";
  j += ",\"mqtt_interval\":" + String(c.intervalSec);
  j += ",\"mqtt_retain\":";
  j += c.retain ? "true" : "false";
  return j;
}

String MqttPublisher::autoClientId() const
{
  // Hostname plus the chip's MAC tail: two boards both called "inverter"
  // would otherwise keep kicking each other off the broker
  uint64_t mac = ESP.getEfuseMac();
  char tail[8];
  snprintf(tail, sizeof(tail), "-%06x", (unsigned)((mac >> 24) & 0xFFFFFF));
  return hostName + tail;
}

String MqttPublisher::effectivePrefix(const MqttConfig& c) const
{
  return c.prefix.length() ? c.prefix : String("openinverter/") + hostName;
}

String MqttPublisher::effectiveClientId(const MqttConfig& c) const
{
  return c.clientId.length() ? c.clientId : autoClientId();
}

String MqttPublisher::configJson() const
{
  Lock l;
  String j = "{\"enabled\":";
  j += cfg.enabled ? "true" : "false";
  j += ",\"host\":\"" + jsonEscape(cfg.host) + "\"";
  j += ",\"port\":" + String(cfg.port);
  j += ",\"user\":\"" + jsonEscape(cfg.user) + "\"";
  j += ",\"pass_set\":";
  j += cfg.pass.length() ? "true" : "false";
  j += ",\"client_id\":\"" + jsonEscape(cfg.clientId) + "\"";
  j += ",\"prefix\":\"" + jsonEscape(cfg.prefix) + "\"";
  j += ",\"names\":\"" + jsonEscape(cfg.names) + "\"";
  j += ",\"interval\":" + String(cfg.intervalSec);
  j += ",\"retain\":";
  j += cfg.retain ? "true" : "false";
  j += ",\"default_prefix\":\"" + jsonEscape(String("openinverter/") + hostName) + "\"";
  j += ",\"default_client_id\":\"" + jsonEscape(autoClientId()) + "\"";
  j += "}";
  return j;
}

static const char* stateText(int st)
{
  switch (st) {
    case -4: return "connection timeout";
    case -3: return "connection lost";
    case -2: return "connect failed (broker unreachable?)";
    case -1: return "disconnected";
    case 0:  return "connected";
    case 1:  return "broker rejected protocol version";
    case 2:  return "broker rejected client id";
    case 3:  return "broker unavailable";
    case 4:  return "bad username or password";
    case 5:  return "not authorised";
    default: return "error";
  }
}

String MqttPublisher::statusJson() const
{
  Lock l;
  String j = "{\"enabled\":";
  j += cfg.enabled ? "true" : "false";
  j += ",\"connected\":";
  j += stConnected ? "true" : "false";
  j += ",\"state\":\"";
  j += stateText(stState);
  j += "\",\"last_error\":\"" + jsonEscape(stError) + "\"";
  j += ",\"prefix\":\"" + jsonEscape(effectivePrefix(cfg)) + "\"";
  j += ",\"publish_count\":" + String(stPublished);
  j += ",\"connect_count\":" + String(stConnects);
  j += ",\"last_publish_age\":";
  j += stLastPublishMs ? String((millis() - stLastPublishMs) / 1000) : String("null");
  j += ",\"unknown\":[";
  for (size_t i = 0; i < stUnknown.size(); i++) {
    if (i) j += ',';
    j += "\"" + jsonEscape(stUnknown[i]) + "\"";
  }
  j += "]}";
  return j;
}

// ---- Main loop side ----

bool MqttPublisher::roundDue(uint32_t now)
{
  if (!mtx) return false;
  Lock l;
  if (!cfg.enabled || !stConnected || !cfg.names.length()) return false;
  if (pendingReady) return false; // the task hasn't taken the last round yet
  if (roundStarted && now - lastRoundMs < cfg.intervalSec * 1000UL) return false;
  roundStarted = true;
  lastRoundMs = now;
  return true;
}

String MqttPublisher::names() const
{
  Lock l;
  return cfg.names;
}

void MqttPublisher::submitRound(const std::vector<NamedValue>& values,
                                const std::vector<String>& unknown, const String& readError)
{
  Lock l;
  stUnknown = unknown;
  if (readError.length()) stError = readError;
  else if (stError.startsWith("could not read")) stError = "";
  if (values.empty()) return;
  pending = values;
  pendingReady = true;
  if (task) xTaskNotifyGive(task);
}

// ---- Client task ----

static void taskEntry(void*) { mqttPublisher.taskLoop(); }

void MqttPublisher::ensureTask()
{
  bool enabled;
  {
    Lock l;
    enabled = cfg.enabled;
  }
  if (task || !enabled) return;
  // Created on first enable and kept: disabling just disconnects
  if (xTaskCreate(taskEntry, "mqtt", 8192, nullptr, 1, &task) != pdPASS) {
    task = nullptr;
    Lock l;
    stError = "could not start the MQTT task (low memory)";
  }
}

void MqttPublisher::taskLoop()
{
  WiFiClient net;
  PubSubClient mqtt(net);
  mqtt.setBufferSize(512);
  mqtt.setKeepAlive(30);
  mqtt.setSocketTimeout(5);

  MqttConfig c;             // the task's own copy of the config
  uint32_t seenGen = (uint32_t)-1;
  String host;              // setServer keeps the pointer: must outlive the client's use
  IPAddress mdnsIp;
  uint32_t nextAttempt = 0, backoff = 0;
  std::vector<NamedValue> round;

  auto setStatus = [&](bool conn, const String* err) {
    Lock l;
    stConnected = conn;
    stState = mqtt.state();
    if (err) stError = *err;
  };
  auto goodbye = [&]() {
    if (mqtt.connected()) {
      mqtt.publish((effectivePrefix(c) + "/status").c_str(), "offline", true);
      mqtt.disconnect();
    }
    setStatus(false, nullptr);
  };

  for (;;) {
    bool changed = false;
    {
      Lock l;
      if (cfgGen != seenGen) {
        changed = true;
        seenGen = cfgGen;
      }
    }
    if (changed) {
      goodbye(); // on the old settings' prefix
      {
        Lock l;
        c = cfg;
      }
      host = c.host;
      mdnsIp = IPAddress();
      nextAttempt = 0;
      backoff = 0;
    }

    if (!c.enabled || WiFi.status() != WL_CONNECTED) {
      if (mqtt.connected()) goodbye();
      else if (c.enabled) { String e = "Wi-Fi station not connected"; setStatus(false, &e); }
      ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(500));
      continue;
    }

    if (!mqtt.connected()) {
      setStatus(false, nullptr);
      uint32_t now = millis();
      if (nextAttempt && (int32_t)(now - nextAttempt) < 0) {
        ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(200));
        continue;
      }
      String err;
      bool ok = false;
      if (!host.length()) err = "no broker host set";
      else {
        // ".local" names only resolve over mDNS
        String mdns = mqttlogic::mdnsName(host);
        if (mdns.length()) {
          if (mdnsIp == IPAddress()) mdnsIp = MDNS.queryHost((char*)mdns.c_str(), MDNS_TIMEOUT_MS);
          if (mdnsIp == IPAddress()) err = String("could not resolve ") + host + " over mDNS";
          else mqtt.setServer(mdnsIp, c.port);
        } else mqtt.setServer(host.c_str(), c.port);
        if (!err.length()) {
          String id = effectiveClientId(c);
          String will = effectivePrefix(c) + "/status";
          if (c.user.length())
            ok = mqtt.connect(id.c_str(), c.user.c_str(), c.pass.c_str(), will.c_str(), 0, true, "offline");
          else
            ok = mqtt.connect(id.c_str(), will.c_str(), 0, true, "offline");
          if (ok) ok = mqtt.publish(will.c_str(), "online", true);
          if (!ok) { err = stateText(mqtt.state()); mdnsIp = IPAddress(); }
        }
      }
      {
        // A config change while connecting wins: don't report stale results
        Lock l;
        if (cfgGen != seenGen) continue;
      }
      if (ok) {
        backoff = 0;
        nextAttempt = 0;
        String none;
        setStatus(true, &none);
        Lock l;
        stConnects++;
        roundStarted = false; // first values straight away
      } else {
        backoff = backoff ? backoff * 2 : RECONNECT_MIN_MS;
        if (backoff > RECONNECT_MAX_MS) backoff = RECONNECT_MAX_MS;
        nextAttempt = millis() + backoff;
        if (!nextAttempt) nextAttempt = 1;
        setStatus(false, &err);
      }
      continue;
    }

    mqtt.loop();

    bool have = false;
    {
      Lock l;
      if (pendingReady && cfgGen == seenGen) {
        round.swap(pending);
        pending.clear();
        pendingReady = false;
        have = true;
      }
    }
    if (have) {
      String prefix = effectivePrefix(c);
      uint32_t sent = 0;
      for (const NamedValue& v : round) {
        if (!mqtt.connected()) break;
        if (mqtt.publish(mqttlogic::valueTopic(prefix, v.name).c_str(), v.value.c_str(), c.retain)) sent++;
      }
      round.clear();
      Lock l;
      stPublished += sent;
      if (sent) stLastPublishMs = millis() ? millis() : 1;
    }
    // Wake on a new round, else poll the socket for keepalive/pings
    ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(100));
  }
}
