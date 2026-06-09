#pragma once
#include <driver/twai.h>

// Default CAN pins (ESP32 dev board — GPIO4/5 are safe defaults)
#ifndef CAN_RX_PIN
#define CAN_RX_PIN GPIO_NUM_4
#endif
#ifndef CAN_TX_PIN
#define CAN_TX_PIN GPIO_NUM_5
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
