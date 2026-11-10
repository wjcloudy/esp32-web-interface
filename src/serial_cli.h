#pragma once

// Hardware-independent framing/validation shared by the console and host tests.
#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <math.h>
#include <limits.h>

namespace serialcli {
constexpr size_t MAX_LINE = 1024;
constexpr size_t MAX_WORDS = 12;

// Discard an entire overlong/invalid line, never execute its suffix. CRLF is
// one terminator. Bounded work in loop() is the caller's responsibility.
struct LineBuffer {
  char data[MAX_LINE + 1] = {};
  size_t length = 0;
  bool invalid = false;
  enum Event { NONE, READY, REJECTED };
  Event push(int c) {
    if (c == '\r' || c == '\n') {
      data[length] = 0;
      Event event = invalid ? REJECTED : length ? READY : NONE;
      length = 0;
      invalid = false;
      return event;
    }
    if (invalid) return NONE;
    if (c == '\b' || c == 127) { if (length) --length; return NONE; }
    if ((c < 32 && c != '\t') || c > 126 || length == MAX_LINE) {
      invalid = true;
      return NONE;
    }
    data[length++] = static_cast<char>(c);
    return NONE;
  }
};

// Decimal integers, or hexadecimal with an explicit 0x prefix; no octal,
// signs, wrapping, trailing garbage, or silently truncated values.
inline bool number(const char* s, uint32_t max, uint32_t& out) {
  if (!s || !*s || *s == '-' || *s == '+' || *s == ' ') return false;
  int base = (s[0] == '0' && (s[1] == 'x' || s[1] == 'X')) ? 16 : 10;
  errno = 0;
  char* end;
  unsigned long long v = strtoull(s, &end, base);
  if (errno || end == s || *end || v > max) return false;
  out = static_cast<uint32_t>(v);
  return true;
}

inline bool integer(const char* s, int32_t min, int32_t max, int32_t& out) {
  if (!s || !*s || *s == '+' || *s == ' ') return false;
  bool negative = *s == '-';
  uint32_t magnitude;
  if (!number(s + (negative ? 1 : 0), UINT32_MAX, magnitude)) return false;
  int64_t v = negative ? -static_cast<int64_t>(magnitude) : magnitude;
  if (v < min || v > max) return false;
  out = static_cast<int32_t>(v);
  return true;
}

inline bool real(const char* s, double& out) {
  if (!s || !*s || *s == ' ') return false;
  errno = 0;
  char* end;
  out = strtod(s, &end);
  return !errno && end != s && !*end && isfinite(out);
}

inline bool fixed32(const char* s, int32_t& raw) {
  double v;
  if (!real(s, v) || v * 32.0 < INT32_MIN || v * 32.0 > INT32_MAX) return false;
  raw = static_cast<int32_t>(v * 32.0);
  return true;
}

struct Words {
  char* args[MAX_WORDS] = {};
  size_t count = 0;
  uint32_t id = 0;
  bool parse(char* line) {
    char* p = line;
    while (*p) {
      while (*p == ' ' || *p == '\t') ++p;
      if (!*p) break;
      if (count == MAX_WORDS) return false;
      args[count++] = p;
      while (*p && *p != ' ' && *p != '\t') ++p;
      if (*p) *p++ = 0;
    }
    if (count && !strcmp(args[0], "@oi")) {
      if (count < 3 || !number(args[1], UINT32_MAX, id)) return false;
      count -= 2;
      for (size_t i = 0; i < count; ++i) args[i] = args[i + 2];
    }
    return count > 0;
  }
  bool is(size_t i, const char* s) const { return i < count && !strcmp(args[i], s); }
};

inline int unhex(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}
inline bool hexBytes(const char* s, uint8_t* bytes, size_t capacity, size_t& length) {
  size_t n = strlen(s);
  if (n % 2 || n / 2 > capacity) return false;
  length = n / 2;
  for (size_t i = 0; i < length; ++i) {
    int hi = unhex(s[i * 2]), lo = unhex(s[i * 2 + 1]);
    if (hi < 0 || lo < 0) return false;
    bytes[i] = static_cast<uint8_t>((hi << 4) | lo);
  }
  return true;
}
inline uint32_t crc32(uint32_t crc, const uint8_t* bytes, size_t length) {
  for (size_t i = 0; i < length; ++i) {
    crc ^= bytes[i];
    for (int bit = 0; bit < 8; ++bit)
      crc = (crc >> 1) ^ ((crc & 1) ? 0xedb88320U : 0);
  }
  return crc;
}
} // namespace serialcli
