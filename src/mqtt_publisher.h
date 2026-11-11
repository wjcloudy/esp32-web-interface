#pragma once
// MQTT publisher: periodically reads a configured list of spot values from
// the inverter and publishes each one to <prefix>/<name> on a broker
// (plain TCP, optional username/password). Availability is reported on
// <prefix>/status ("online", retained; the broker publishes the "offline"
// last-will if the link drops). Config lives in /mqtt.json on SPIFFS.
#include <Arduino.h>

struct MqttConfig {
  bool enabled = false;
  String host = "";
  uint16_t port = 1883;
  String user = "";
  String pass = "";
  String clientId = "";     // blank = use the device hostname
  String prefix = "";       // blank = "openinverter/<hostname>"
  String names = "";        // comma-separated spot value names to publish
  uint32_t intervalSec = 5; // publish period (1..3600 s)
  bool retain = false;      // retain flag on value messages
};

// Reads spot values: `names` is a comma list, `out` receives the raw reply
// (values separated by whitespace, in request order). Returns false if the
// values can't be read right now (busy bus, no reply) — the cycle is skipped.
typedef bool (*MqttFetchFn)(const String& names, String& out);

class MqttPublisher {
public:
  void begin(const String& hostname, MqttFetchFn fetch);
  void loop();

  void loadConfig();
  bool saveConfig();
  // Apply a new config (drops the current connection so it takes effect)
  void setConfig(const MqttConfig& cfg);
  const MqttConfig& getConfig() const { return config; }

  // Config without the password (pass_set says whether one is stored)
  String getConfigJson() const;
  String getStatusJson() const;

  String effectivePrefix() const;
  String effectiveClientId() const;

private:
  String autoClientId() const;
  MqttConfig config;
  String hostname = "inverter";
  MqttFetchFn fetchFn = nullptr;
  unsigned long lastConnectAttempt = 0;
  unsigned long lastPublish = 0;
  unsigned long reconnectDelay = 5000;
  uint32_t publishCount = 0;
  uint32_t connectCount = 0;
  String lastError = "";
  bool hadLink = false;

  bool connect();
  void publishValues();
};

extern MqttPublisher mqttPublisher;
