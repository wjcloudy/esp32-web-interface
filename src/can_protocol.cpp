#include "can_protocol.h"
#include "can_driver.h"
#include <Arduino.h>
#include <cstring>

bool canSdoRead(uint8_t nodeId, uint16_t index, uint8_t subIndex) {
  uint32_t canId = CAN_SDO_REQUEST_BASE | nodeId;
  uint8_t data[8] = {0};
  data[0] = SDO_READ_REQUEST;
  data[1] = index & 0xFF;
  data[2] = (index >> 8) & 0xFF;
  data[3] = subIndex;
  // data[4-7] remain 0
  return canDriverSend(canId, data, 8);
}

bool canSdoWrite(uint8_t nodeId, uint16_t index, uint8_t subIndex, int32_t value) {
  uint32_t canId = CAN_SDO_REQUEST_BASE | nodeId;
  uint8_t data[8] = {0};
  data[0] = SDO_WRITE_REQUEST_4B;
  data[1] = index & 0xFF;
  data[2] = (index >> 8) & 0xFF;
  data[3] = subIndex;
  // Little-endian 32-bit value in bytes 4-7
  memcpy(&data[4], &value, 4);
  return canDriverSend(canId, data, 8);
}

bool canSdoCommand(uint8_t nodeId, uint8_t command) {
  return canSdoWrite(nodeId, CAN_INDEX_COMMANDS, command, 0);
}

bool canSdoParseResponse(const twai_message_t* frame, uint8_t* outNodeId,
                          uint16_t* outIndex, uint8_t* outSubIndex, int32_t* outValue) {
  if (!frame) return false;

  uint32_t id = frame->identifier;
  // Check if it's an SDO response (0x580-0x5FF range)
  if (id < CAN_SDO_RESPONSE_BASE || id > (CAN_SDO_RESPONSE_BASE | 0x7F))
    return false;

  if (outNodeId) *outNodeId = id & 0x7F;

  // Check SDO command byte
  uint8_t cmd = frame->data[0];
  if (cmd == SDO_READ_RESPONSE) {
    // Expedited upload response: bytes 4-7 contain the 32-bit value
    if (outIndex)    *outIndex    = frame->data[1] | (frame->data[2] << 8);
    if (outSubIndex) *outSubIndex = frame->data[3];
    if (outValue)    memcpy(outValue, &frame->data[4], 4);
    return true;
  } else if (cmd == SDO_WRITE_RESPONSE) {
    // Write confirmation
    if (outIndex)    *outIndex    = frame->data[1] | (frame->data[2] << 8);
    if (outSubIndex) *outSubIndex = frame->data[3];
    if (outValue)    *outValue = 0;
    return true;
  }
  // Other SDO response types (abort, segmented, etc.) are not handled here
  return false;
}

bool canRawSend(uint32_t canId, const uint8_t* data, uint8_t len) {
  return canDriverSend(canId, data, len);
}

bool canReceiveForNode(uint8_t nodeId, twai_message_t* outFrame, uint32_t timeoutMs) {
  uint32_t expectedId = CAN_SDO_RESPONSE_BASE | nodeId;
  uint32_t start = millis();

  while (millis() - start < timeoutMs) {
    twai_message_t frame;
    if (canDriverReceive(&frame)) {
      if (frame.identifier == expectedId || frame.identifier == CAN_BOOTLOADER_RESP) {
        if (outFrame) *outFrame = frame;
        return true;
      }
    }
    delay(1);
  }
  return false;
}
