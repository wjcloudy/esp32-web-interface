#pragma once
// MQTT publisher: publishes a configured list of spot values to
// <prefix>/<name> on a broker (plain TCP, optional username/password).
// Availability goes to <prefix>/status: "online" (retained) on connect, and
// the broker publishes the "offline" last will if the link drops.
//
// The client runs in its own FreeRTOS task, so DNS, connect timeouts and a
// stalled broker can only ever block that task, never the web server. The
// main loop reads the values from the inverter (it owns the UART/CAN link)
// and hands each finished round over with submitRound().
//
// Settings live in settings.json (kept across updates through the NVS
// mirror); the password is stored only in NVS (namespace "oimqtt"), so the
// static file handler, /list and the settings export never see it.
#include <Arduino.h>
#include <vector>
#include "mqtt_logic.h"

struct MqttConfig {
  bool enabled = false;
  String host;
  uint16_t port = 1883;
  String user;
  String pass;
  String clientId;          // blank = hostname + MAC tail
  String prefix;            // blank = "openinverter/<hostname>"
  String names;             // comma-separated spot value names
  uint32_t intervalSec = 5; // 1..3600 s
  bool retain = false;      // retain flag on value messages
};

class MqttPublisher {
public:
  // setup(), before begin(): read the mqtt_* fields of settings.json and the
  // password from NVS
  void loadSettings(const String& settingsJson);
  // setup(): starts the client task if MQTT is enabled
  void begin(const String& hostname);

  // HTTP side. Never touches the network: the task picks changes up.
  MqttConfig config() const;
  // Clean and apply; stores the password in NVS. Caller saves settings.json.
  void setConfig(const MqttConfig& cfg);
  // "Reset settings": back to defaults, password erased
  void reset();
  // settings.json fields, each starting with ',' (no password)
  String settingsFields() const;
  String configJson() const;   // admin view, pass_set instead of the password
  String statusJson() const;   // viewer view

  // Main-loop side
  bool roundDue(uint32_t nowMs); // true once per interval while connected
  String names() const;
  void submitRound(const std::vector<mqttlogic::NamedValue>& values,
                   const std::vector<String>& unknown, const String& readError);

  void taskLoop(); // the client task's body (internal)

private:
  String effectivePrefix(const MqttConfig& c) const;
  String effectiveClientId(const MqttConfig& c) const;
  String autoClientId() const;
  void ensureTask();
};

extern MqttPublisher mqttPublisher;
