#pragma once
#include <stdint.h>
#include <stddef.h>
#include <string.h>
// Always present, even in builds without the maintenance console. No suffix of
// an oversized/invalid line may become a recovery command.
struct SerialRecoveryLine {
  char bytes[48] = {};
  size_t length = 0;
  bool discard = false;
  uint32_t id = 0;
  bool framed = false;
  bool push(int c) {
    if (c == '\r' || c == '\n') {
      bytes[length] = 0;
      bool valid = !discard;
      const char* command = bytes;
      id = 0; framed = false;
      if (valid && strncmp(command, "@oi ", 4) == 0) {
        framed = true; command += 4;
        bool digits = false;
        while (*command >= '0' && *command <= '9') {
          uint32_t n = *command++ - '0';
          if (id > (UINT32_MAX - n) / 10) valid = false;
          else id = id * 10 + n;
          digits = true;
        }
        if (!digits || *command != ' ') valid = false;
        else ++command;
      }
      bool reset = valid && strcmp(command, "auth reset") == 0;
      length = 0; discard = false;
      return reset;
    }
    if (c < 32 || c > 126 || length == sizeof(bytes) - 1) { discard = true; return false; }
    if (!discard) bytes[length++] = (char)c;
    return false;
  }
};
