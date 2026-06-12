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
      continue; // unrelated bus traffic — keep draining without sleeping
    }
    delay(1);
  }
  return false;
}

CanSegStatus canSegStatus = {0, 0, 0};

uint32_t canSdoReadSegmented(uint8_t nodeId, uint16_t index, uint8_t* buffer, uint32_t maxLen, uint32_t timeoutPerSegmentMs, bool* outComplete) {
  // CANopen segmented upload: initiate with an SDO read, then request segments
  // with an alternating toggle bit. Each segment carries up to 7 data bytes;
  // the last segment is flagged in bit 0 of the command byte.
  if (outComplete) *outComplete = false;
  canSegStatus = {0, 0, 0};

  // Drain stale frames (e.g. late responses to earlier reads) so the initiate
  // response can't be mismatched to a leftover expedited frame
  twai_message_t resp;
  while (canDriverReceive(&resp)) {}

  if (!canSdoRead(nodeId, index, 0)) { canSegStatus.stage = 1; return 0; }

  if (!canReceiveForNode(nodeId, &resp, timeoutPerSegmentMs)) { canSegStatus.stage = 2; return 0; }

  uint8_t cmd = resp.data[0];
  if (cmd == SDO_ABORT) { canSegStatus.stage = 4; canSegStatus.cmd = cmd; return 0; }
  if ((cmd & 0xE0) != SDO_RESPONSE_UPLOAD) { canSegStatus.stage = 3; canSegStatus.cmd = cmd; return 0; }

  // Expedited response: object fits in the 4 data bytes of the initiate response
  if (cmd & SDO_EXPEDITED) {
    uint8_t n = (cmd & SDO_SIZE_SPECIFIED) ? 4 - ((cmd >> 2) & 0x3) : 4;
    if (n > maxLen) n = maxLen;
    memcpy(buffer, &resp.data[4], n);
    if (outComplete) *outComplete = true;
    canSegStatus.bytes = n;
    return n;
  }

  // Segmented transfer: request segments until last-segment flag or buffer full.
  // A lost segment ends the transfer — the caller checks outComplete and retries
  // the whole download (blind re-requests can silently skip data).
  uint32_t totalBytes = 0;
  bool toggle = false;

  while (true) {
    if (totalBytes >= maxLen) { canSegStatus.stage = 8; break; }

    uint8_t expected = toggle ? SDO_TOGGLE_BIT : 0;
    uint8_t req[8] = {0};
    req[0] = SDO_REQUEST_SEGMENT | expected;
    if (!canDriverSend(CAN_SDO_REQUEST_BASE | nodeId, req, 8)) { canSegStatus.stage = 5; break; }

    if (!canReceiveForNode(nodeId, &resp, timeoutPerSegmentMs)) { canSegStatus.stage = 6; break; }
    cmd = resp.data[0];
    if (cmd & SDO_ABORT) { canSegStatus.stage = 4; canSegStatus.cmd = cmd; break; }
    if ((cmd & SDO_TOGGLE_BIT) != expected) { canSegStatus.stage = 7; canSegStatus.cmd = cmd; break; }

    uint8_t n = 7 - ((cmd >> 1) & 0x7);  // valid data bytes in this segment
    for (uint8_t i = 0; i < n && totalBytes < maxLen; i++)
      buffer[totalBytes++] = resp.data[1 + i];

    if (cmd & SDO_SIZE_SPECIFIED) {      // last segment received
      if (outComplete) *outComplete = true;
      break;
    }
    toggle = !toggle;
    if ((totalBytes & 0x3FF) == 0) delay(1); // yield periodically to keep WiFi alive
  }

  canSegStatus.bytes = totalBytes;
  return totalBytes;
}
