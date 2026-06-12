#include "can_driver.h"
#include <cstring>

static bool driverInstalled = false;

// Common SDO response IDs for scanning: 0x580-0x5FF (node IDs 0-127)
#define SDO_RESPONSE_BASE_ID 0x580
#define SDO_RESPONSE_MAX_ID  0x5FF
#define BOOTLOADER_RESPONSE_ID 0x7DE

static bool configureTwai(CanSpeed speed, int txPin, int rxPin,
                           const twai_filter_config_t* filter) {
  if (driverInstalled) {
    twai_stop();
    twai_driver_uninstall();
    driverInstalled = false;
  }

  twai_general_config_t g_config = {
    .mode = TWAI_MODE_NORMAL,
    .tx_io = static_cast<gpio_num_t>(txPin),
    .rx_io = static_cast<gpio_num_t>(rxPin),
    .clkout_io = TWAI_IO_UNUSED,
    .bus_off_io = TWAI_IO_UNUSED,
    .tx_queue_len = 30,
    .rx_queue_len = 30,
    .alerts_enabled = TWAI_ALERT_NONE,
    .clkout_divider = 0,
    .intr_flags = 0
  };

  twai_timing_config_t t_config;
  switch (speed) {
    case CAN_125K: t_config = TWAI_TIMING_CONFIG_125KBITS(); break;
    case CAN_250K: t_config = TWAI_TIMING_CONFIG_250KBITS(); break;
    case CAN_500K:
    default:        t_config = TWAI_TIMING_CONFIG_500KBITS(); break;
  }

  esp_err_t err = twai_driver_install(&g_config, &t_config, filter);
  if (err != ESP_OK) return false;

  err = twai_start();
  if (err != ESP_OK) {
    twai_driver_uninstall();
    return false;
  }

  driverInstalled = true;
  return true;
}

bool canDriverInitScan(CanSpeed speed, int txPin, int rxPin) {
  // Dual filter: bootloader responses + SDO response range
  // Filter 0: SDO response base IDs 0x580-0x5FF
  // Filter 1: Bootloader response 0x7DE
  twai_filter_config_t filter = {
    .acceptance_code = (uint32_t)(SDO_RESPONSE_BASE_ID << 5)
                     | (uint32_t)(BOOTLOADER_RESPONSE_ID << 21),
    .acceptance_mask  = (uint32_t)(0x7F << 5) | 0x1F | (uint32_t)(0x1F << 16),
    .single_filter = false
  };
  return configureTwai(speed, txPin, rxPin, &filter);
}

bool canDriverInitForDevice(uint8_t nodeId, CanSpeed speed, int txPin, int rxPin) {
  // Accept everything: SDO consumers filter by id themselves, and virtual
  // spot values need to observe arbitrary bus traffic
  (void)nodeId;
  twai_filter_config_t filter = TWAI_FILTER_CONFIG_ACCEPT_ALL();
  return configureTwai(speed, txPin, rxPin, &filter);
}

bool canDriverInitAcceptAll(CanSpeed speed, int txPin, int rxPin) {
  twai_filter_config_t filter = TWAI_FILTER_CONFIG_ACCEPT_ALL();
  return configureTwai(speed, txPin, rxPin, &filter);
}

void canDriverStop() {
  if (driverInstalled) {
    twai_stop();
    twai_driver_uninstall();
    driverInstalled = false;
  }
}

bool canDriverSend(uint32_t canId, const uint8_t* data, uint8_t len) {
  if (!driverInstalled) return false;
  if (len > 8) len = 8;

  twai_message_t msg = {};
  msg.identifier = canId;
  msg.data_length_code = len;
  msg.extd = (canId > 0x7FF) ? 1 : 0;
  msg.rtr = 0;
  memcpy(msg.data, data, len);

  return twai_transmit(&msg, pdMS_TO_TICKS(10)) == ESP_OK;
}

static void (*rxHook)(const twai_message_t*) = nullptr;

void canDriverSetRxHook(void (*hook)(const twai_message_t*)) {
  rxHook = hook;
}

bool canDriverReceive(twai_message_t* outFrame) {
  if (!driverInstalled) return false;
  if (twai_receive(outFrame, 0) != ESP_OK) return false;
  if (rxHook) rxHook(outFrame);
  return true;
}

bool canDriverIsRunning() {
  return driverInstalled;
}
