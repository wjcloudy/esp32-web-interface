#pragma once
#include <cstdint>
struct twai_message_t {
  uint32_t identifier = 0;
  uint8_t data_length_code = 0;
  uint8_t data[8] = {};
  bool extd = false;
  bool rtr = false;
};
