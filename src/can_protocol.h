#pragma once
#include <cstdint>
#include <Arduino.h>
#include <driver/twai.h>

// CAN ID base addresses
#define CAN_SDO_REQUEST_BASE   0x600  // + nodeId
#define CAN_SDO_RESPONSE_BASE  0x580  // + nodeId
#define CAN_BOOTLOADER_CMD     0x7DD
#define CAN_BOOTLOADER_RESP    0x7DE

// SDO command bytes
#define SDO_READ_REQUEST       0x40   // expedited upload request
#define SDO_READ_RESPONSE      0x43   // expedited upload response (4 bytes)
#define SDO_WRITE_REQUEST_4B   0x23   // expedited download, 4 bytes
#define SDO_WRITE_RESPONSE     0x60   // write confirmation

// SDO command bits for segmented upload (CANopen)
#define SDO_RESPONSE_UPLOAD    0x40   // scs=2: upload initiate response
#define SDO_REQUEST_SEGMENT    0x60   // ccs=3: upload segment request
#define SDO_TOGGLE_BIT         0x10   // toggles on each segment
#define SDO_EXPEDITED          0x02   // data fits in initiate response
#define SDO_SIZE_SPECIFIED     0x01   // initiate: size valid; segment: last segment
#define SDO_ABORT              0x80   // abort transfer

// SDO index definitions (OpenInverter parameter database)
#define CAN_INDEX_PARAMS       0x2000 // named parameters (indexed by param ID)
#define CAN_INDEX_PARAM_UID    0x2100 // parameter by UID
#define CAN_INDEX_SERIAL       0x5000 // device serial number
#define CAN_INDEX_COMMANDS     0x5002 // device commands
#define CAN_INDEX_ERRORS       0x5003 // error log: error codes
#define CAN_INDEX_ERROR_TIME   0x5004 // error log: timestamps
#define CAN_INDEX_JSON         0x5001 // JSON parameter strings
#define CAN_INDEX_MAP_TX       0x3000 // add TX CAN mapping (write-only, 3-stage)
#define CAN_INDEX_MAP_RX       0x3001 // add RX CAN mapping (write-only, 3-stage)
#define CAN_INDEX_MAP_RD       0x3100 // read TX mappings (RX mappings at +0x80)
#define CAN_INDEX_MAP_RD_RX    0x3180 // read RX mappings

// SDO abort codes
#define SDO_ERR_RANGE          0x06090030

// Device command values (sub-index to CAN_INDEX_COMMANDS)
#define CAN_CMD_SAVE           0
#define CAN_CMD_LOAD           1
#define CAN_CMD_RESET          2
#define CAN_CMD_DEFAULTS       3
#define CAN_CMD_START          4
#define CAN_CMD_STOP           5
#define CAN_CMD_CLEAR_MAP      6

// Build an SDO read request and send via CAN
// Returns true if queued successfully
bool canSdoRead(uint8_t nodeId, uint16_t index, uint8_t subIndex);

// Build an SDO write request (32-bit value) and send via CAN
bool canSdoWrite(uint8_t nodeId, uint16_t index, uint8_t subIndex, int32_t value);

// Send a device command (e.g., start, stop, reset)
bool canSdoCommand(uint8_t nodeId, uint8_t command);

// Parse an SDO response frame and extract the 32-bit value
// Returns false if frame is not a valid SDO response
bool canSdoParseResponse(const twai_message_t* frame, uint8_t* outNodeId,
                          uint16_t* outIndex, uint8_t* outSubIndex, int32_t* outValue);

// Build a raw CAN message send (for one-shot sends)
bool canRawSend(uint32_t canId, const uint8_t* data, uint8_t len);

// Receive a CAN frame and check if it's for our node
bool canReceiveForNode(uint8_t nodeId, twai_message_t* outFrame, uint32_t timeoutMs);

// Build SDO index/subIndex for a parameter ID
inline uint16_t canParamIndex(uint16_t paramId) {
  return CAN_INDEX_PARAM_UID | (paramId >> 8);
}
inline uint8_t canParamSubIndex(uint16_t paramId) {
  return paramId & 0xFF;
}

// Encode/decode parameter values (fixed-point × 32)
inline int32_t canEncodeValue(float value) {
  return (int32_t)(value * 32.0f);
}
inline float canDecodeValue(int32_t raw) {
  return (float)raw / 32.0f;
}

// Diagnostic status of the last segmented transfer
// stage: 0=complete 1=initSendFail 2=initTimeout 3=initBadCmd 4=abort
//        5=segSendFail 6=segTimeout 7=toggleMismatch 8=bufferFull
struct CanSegStatus { uint8_t stage; uint8_t cmd; uint32_t bytes; };
extern CanSegStatus canSegStatus;

// Segmented SDO upload: reads a multi-byte object (like JSON string) from the device
// using the CANopen segmented transfer protocol (7 data bytes per segment).
// Returns number of bytes read, 0 on failure. If outComplete is given it is set
// true only when the device's last-segment flag was received (i.e. the transfer
// finished cleanly rather than timing out or overflowing the buffer).
uint32_t canSdoReadSegmented(uint8_t nodeId, uint16_t index, uint8_t* buffer, uint32_t maxLen, uint32_t timeoutPerSegmentMs, bool* outComplete = nullptr);
