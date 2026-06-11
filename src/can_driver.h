#pragma once
#include <driver/twai.h>

// Default CAN pins
// ESP32-S3 (T-2Can): TX=7, RX=6. Classic ESP32: GPIO6/7 are flash pins, use 4/5.
#if defined(CONFIG_IDF_TARGET_ESP32S3)
#ifndef CAN_RX_PIN
#define CAN_RX_PIN GPIO_NUM_6
#endif
#ifndef CAN_TX_PIN
#define CAN_TX_PIN GPIO_NUM_7
#endif
#else
#ifndef CAN_RX_PIN
#define CAN_RX_PIN GPIO_NUM_4
#endif
#ifndef CAN_TX_PIN
#define CAN_TX_PIN GPIO_NUM_5
#endif
#endif

enum CanSpeed {
  CAN_125K = 0,
  CAN_250K = 1,
  CAN_500K = 2
};

// Initialize CAN bus for scanning (accepts all SDO responses + bootloader)
bool canDriverInitScan(CanSpeed speed, int txPin, int rxPin);

// Initialize CAN bus for a specific device (narrow filter on node ID)
bool canDriverInitForDevice(uint8_t nodeId, CanSpeed speed, int txPin, int rxPin);

// Stop and uninstall CAN driver
void canDriverStop();

// Send a raw CAN message (returns true if queued successfully)
bool canDriverSend(uint32_t canId, const uint8_t* data, uint8_t len);

// Receive a CAN message (non-blocking, returns false if no message)
bool canDriverReceive(twai_message_t* outFrame);

// Check if driver is installed and running
bool canDriverIsRunning();
