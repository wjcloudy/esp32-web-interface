#include "mqtt_publisher.h"
#include <WiFi.h>
#include <WiFiClient.h>
#include <PubSubClient.h>
#include <SPIFFS.h>
#include <vector>

MqttPublisher mqttPublisher;

static WiFiClient mqttNet;
static PubSubClient mqtt(mqttNet);

static const char* MQTT_CONFIG_PATH = "/mqtt.json";
static const unsigned long MQTT_RECONNECT_MIN_MS = 5000;
static const unsigned long MQTT_RECONNECT_MAX_MS = 60000;
// The inverter's UART terminal truncates commands beyond 128 chars — keep
// each 'get' well inside that (same limit the web UI uses)
static const unsigned int MQTT_GET_CHUNK = 120;

// ---------- tiny JSON helpers (flat object, known keys) ----------

static String jsonEsc(const String& s)
{
  String out;
  out.reserve(s.length() + 4);
  for (size_t i = 0; i < s.length(); i++) {
    char c = s[i];
    if (c == '"' || c == '\\') { out += '\\'; out += c; }
    else if ((uint8_t)c >= 0x20) out += c;
  }
  return out;
}

// Value of a quoted string field (honours backslash escapes); "" if absent
static String jsonStr(const String& json, const char* key)
{
  String pat = String("\"") + key + "\":\"";
  int i = json.indexOf(pat);
  if (i < 0) return "";
  String out;
  for (unsigned int p = i + pat.length(); p < json.length(); p++) {
    char ch = json[p];
    if (ch == '\\' && p + 1 < json.length()) out += json[++p];
    else if (ch == '"') break;
    else out += ch;
  }
  return out;
}

static long jsonNum(const String& json, const char* key, long def)
{
  String pat = String("\"") + key + "\":";
  int i = json.indexOf(pat);
  if (i < 0) return def;
  return json.substring(i + pat.length()).toInt();
}

static bool jsonBool(const String& json, const char* key)
{
  return json.indexOf(String("\"") + key + "\":true") >= 0;
}

// Keep only characters that are valid in a spot value name (and safe in a
// topic: no '+', '#', '/' wildcards/levels), deduplicate separators
static String sanitizeNames(const String& in)
{
  String out;
  for (unsigned int i = 0; i < in.length(); i++) {
    char ch = in[i];
    if (isalnum((unsigned char)ch) || ch == '_' || ch == '.' || ch == '-') out += ch;
    else if ((ch == ',' || ch == ' ' || ch == '\n' || ch == ';') && out.length() && out[out.length() - 1] != ',') out += ',';
  }
  while (out.length() && out[out.length() - 1] == ',') out.remove(out.length() - 1);
  return out;
}

static String sanitizePrefix(const String& in)
{
  String out;
  for (unsigned int i = 0; i < in.length(); i++) {
    char ch = in[i];
    if (ch == '+' || ch == '#' || (uint8_t)ch < 0x20) continue; // no wildcards in a publish topic
    out += ch;
  }
  while (out.length() && out[out.length() - 1] == '/') out.remove(out.length() - 1);
  return out;
}

// ---------- config ----------

void MqttPublisher::begin(const String& hn, MqttFetchFn fetch)
{
  if (hn.length()) hostname = hn;
  fetchFn = fetch;
  mqtt.setBufferSize(512);
  mqtt.setKeepAlive(30);
  mqtt.setSocketTimeout(3); // bounds how long a stalled broker can block loop()
  loadConfig();
}

void MqttPublisher::loadConfig()
{
  config = MqttConfig();
  if (!SPIFFS.exists(MQTT_CONFIG_PATH)) return;
  File f = SPIFFS.open(MQTT_CONFIG_PATH, "r");
  if (!f) return;
  String json = f.readString();
  f.close();
  config.enabled = jsonBool(json, "enabled");
  config.host = jsonStr(json, "host");
  long port = jsonNum(json, "port", 1883);
  config.port = (port > 0 && port < 65536) ? port : 1883;
  config.user = jsonStr(json, "user");
  config.pass = jsonStr(json, "pass");
  config.clientId = jsonStr(json, "client_id");
  config.prefix = sanitizePrefix(jsonStr(json, "prefix"));
  config.names = sanitizeNames(jsonStr(json, "names"));
  long iv = jsonNum(json, "interval", 5);
  config.intervalSec = (iv < 1) ? 1 : (iv > 3600) ? 3600 : iv;
  config.retain = jsonBool(json, "retain");
}

bool MqttPublisher::saveConfig()
{
  File f = SPIFFS.open(MQTT_CONFIG_PATH, "w");
  if (!f) return false;
  f.printf("{\"enabled\":%s,\"host\":\"%s\",\"port\":%u,\"user\":\"%s\",\"pass\":\"%s\","
           "\"client_id\":\"%s\",\"prefix\":\"%s\",\"names\":\"%s\",\"interval\":%u,\"retain\":%s}",
           config.enabled ? "true" : "false",
           jsonEsc(config.host).c_str(), config.port,
           jsonEsc(config.user).c_str(), jsonEsc(config.pass).c_str(),
           jsonEsc(config.clientId).c_str(), jsonEsc(config.prefix).c_str(),
           jsonEsc(config.names).c_str(), (unsigned)config.intervalSec,
           config.retain ? "true" : "false");
  f.close();
  return true;
}

void MqttPublisher::setConfig(const MqttConfig& cfg)
{
  // Say goodbye on the old connection before its settings change
  if (mqtt.connected()) {
    mqtt.publish((effectivePrefix() + "/status").c_str(), "offline", true);
    mqtt.disconnect();
  }
  config = cfg;
  config.host.trim();
  config.prefix = sanitizePrefix(config.prefix);
  config.names = sanitizeNames(config.names);
  if (config.port == 0) config.port = 1883;
  if (config.intervalSec < 1) config.intervalSec = 1;
  if (config.intervalSec > 3600) config.intervalSec = 3600;
  lastConnectAttempt = 0;
  reconnectDelay = 0; // connect right away with the new settings
  lastError = "";
  hadLink = false;
}

String MqttPublisher::effectivePrefix() const
{
  return config.prefix.length() ? config.prefix : String("openinverter/") + hostname;
}

String MqttPublisher::autoClientId() const
{
  // Hostname plus the chip's MAC tail: two boards both called "inverter"
  // would otherwise keep kicking each other off the broker
  uint64_t mac = ESP.getEfuseMac();
  char tail[8];
  snprintf(tail, sizeof(tail), "-%06x", (unsigned)((mac >> 24) & 0xFFFFFF));
  return hostname + tail;
}

String MqttPublisher::effectiveClientId() const
{
  return config.clientId.length() ? config.clientId : autoClientId();
}

String MqttPublisher::getConfigJson() const
{
  String j = "{\"enabled\":";
  j += config.enabled ? "true" : "false";
  j += ",\"host\":\"" + jsonEsc(config.host) + "\"";
  j += ",\"port\":" + String(config.port);
  j += ",\"user\":\"" + jsonEsc(config.user) + "\"";
  j += ",\"pass_set\":";
  j += config.pass.length() ? "true" : "false";
  j += ",\"client_id\":\"" + jsonEsc(config.clientId) + "\"";
  j += ",\"prefix\":\"" + jsonEsc(config.prefix) + "\"";
  j += ",\"names\":\"" + jsonEsc(config.names) + "\"";
  j += ",\"interval\":" + String(config.intervalSec);
  j += ",\"retain\":";
  j += config.retain ? "true" : "false";
  j += ",\"default_prefix\":\"" + jsonEsc(String("openinverter/") + hostname) + "\"";
  j += ",\"default_client_id\":\"" + jsonEsc(autoClientId()) + "\"";
  j += "}";
  return j;
}

String MqttPublisher::getStatusJson() const
{
  bool conn = mqtt.connected();
  String j = "{\"enabled\":";
  j += config.enabled ? "true" : "false";
  j += ",\"connected\":";
  j += conn ? "true" : "false";
  j += ",\"wifi\":";
  j += (WiFi.status() == WL_CONNECTED) ? "true" : "false";
  j += ",\"state\":" + String(mqtt.state());
  j += ",\"prefix\":\"" + jsonEsc(effectivePrefix()) + "\"";
  j += ",\"client_id\":\"" + jsonEsc(effectiveClientId()) + "\"";
  j += ",\"publish_count\":" + String(publishCount);
  j += ",\"connect_count\":" + String(connectCount);
  j += ",\"last_error\":\"" + jsonEsc(lastError) + "\"";
  j += "}";
  return j;
}

// ---------- connection & publishing ----------

static const char* mqttStateText(int st)
{
  switch (st) {
    case -4: return "connection timeout";
    case -3: return "connection lost";
    case -2: return "connect failed (broker unreachable?)";
    case -1: return "disconnected";
    case 1:  return "broker rejected protocol version";
    case 2:  return "broker rejected client id";
    case 3:  return "broker unavailable";
    case 4:  return "bad username or password";
    case 5:  return "not authorised";
    default: return "error";
  }
}

bool MqttPublisher::connect()
{
  if (!config.host.length()) { lastError = "no broker host set"; return false; }
  mqtt.setServer(config.host.c_str(), config.port); // PubSubClient keeps the pointer — re-set every attempt
  String id = effectiveClientId();
  String willTopic = effectivePrefix() + "/status";
  bool ok;
  if (config.user.length())
    ok = mqtt.connect(id.c_str(), config.user.c_str(), config.pass.c_str(),
                      willTopic.c_str(), 0, true, "offline");
  else
    ok = mqtt.connect(id.c_str(), willTopic.c_str(), 0, true, "offline");
  if (!ok) {
    lastError = mqttStateText(mqtt.state());
    return false;
  }
  connectCount++;
  lastError = "";
  mqtt.publish(willTopic.c_str(), "online", true);
  lastPublish = 0; // publish a fresh set straight away
  return true;
}

void MqttPublisher::publishValues()
{
  if (!fetchFn || !config.names.length()) return;
  String prefix = effectivePrefix();

  // Walk the name list in 'get'-sized chunks
  unsigned int pos = 0;
  while (pos < config.names.length() && mqtt.connected()) {
    // Build one chunk of whole names
    String chunk;
    std::vector<String> chunkNames;
    while (pos < config.names.length()) {
      int comma = config.names.indexOf(',', pos);
      String n = (comma < 0) ? config.names.substring(pos) : config.names.substring(pos, comma);
      unsigned int next = (comma < 0) ? config.names.length() : comma + 1;
      if (n.length() == 0) { pos = next; continue; }
      if (chunkNames.size() && 4 + chunk.length() + 1 + n.length() > MQTT_GET_CHUNK) break;
      if (chunk.length()) chunk += ',';
      chunk += n;
      chunkNames.push_back(n);
      pos = next;
    }
    if (chunkNames.empty()) break;

    String reply;
    if (!fetchFn(chunk, reply)) { lastError = "could not read values from inverter"; return; }

    // Values come back whitespace-separated (UART: one per line, CAN: tabs)
    std::vector<String> tokens;
    int i = 0, len = reply.length();
    while (i < len) {
      while (i < len && isspace((unsigned char)reply[i])) i++;
      int s = i;
      while (i < len && !isspace((unsigned char)reply[i])) i++;
      if (i > s) tokens.push_back(reply.substring(s, i));
    }
    if (tokens.size() != chunkNames.size()) {
      // Mis-mapped values are worse than none — skip the whole chunk
      lastError = "reply didn't match requested values (unknown name?)";
      continue;
    }
    for (size_t k = 0; k < chunkNames.size(); k++) {
      const char* t = tokens[k].c_str();
      char* end;
      strtod(t, &end);
      if (end == t || *end) continue; // not a number (e.g. an error word)
      String topic = prefix + "/" + chunkNames[k];
      if (mqtt.publish(topic.c_str(), t, config.retain)) publishCount++;
    }
  }
}

void MqttPublisher::loop()
{
  if (!config.enabled) {
    if (mqtt.connected()) {
      mqtt.publish((effectivePrefix() + "/status").c_str(), "offline", true);
      mqtt.disconnect();
    }
    return;
  }
  if (WiFi.status() != WL_CONNECTED) {
    if (hadLink) { lastError = "WiFi station not connected"; hadLink = false; }
    return;
  }
  hadLink = true;

  if (!mqtt.connected()) {
    unsigned long now = millis();
    if (lastConnectAttempt && now - lastConnectAttempt < reconnectDelay) return;
    lastConnectAttempt = now;
    if (connect()) {
      reconnectDelay = MQTT_RECONNECT_MIN_MS;
    } else {
      // Back off so an unreachable broker doesn't stall the web server
      // with a blocking connect attempt every pass
      reconnectDelay = reconnectDelay ? reconnectDelay * 2 : MQTT_RECONNECT_MIN_MS;
      if (reconnectDelay > MQTT_RECONNECT_MAX_MS) reconnectDelay = MQTT_RECONNECT_MAX_MS;
      return;
    }
  }

  mqtt.loop();

  if (lastPublish == 0 || millis() - lastPublish >= config.intervalSec * 1000UL) {
    lastPublish = millis();
    if (lastPublish == 0) lastPublish = 1;
    publishValues();
  }
}
