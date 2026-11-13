#pragma once
#include "can_protocol.h"
#include <cstring>

// Text only owns its final storage. Use the advertised size when available,
// otherwise grow in bounded 1 KiB steps rather than reallocating every 7 bytes.
// T is Arduino String, or a constrained allocator stand-in in the host tests.
template<class T>
class CanTextSink {
public:
  CanTextSink(T& text, uint32_t limit) : text_(text), limit_(limit) {}
  CanSdoSink sink() { return {this, begin, write}; }
private:
  T& text_;
  uint32_t limit_;
  uint32_t capacity_ = 0;
  static bool begin(void* context, uint32_t hint) {
    auto& self = *static_cast<CanTextSink*>(context);
    self.text_ = "";
    self.capacity_ = 0;
    if (hint && hint <= self.limit_) {
      if (!self.text_.reserve(hint)) return false;
      self.capacity_ = hint;
    }
    return true;
  }
  static bool write(void* context, const uint8_t* bytes, uint8_t length) {
    auto& self = *static_cast<CanTextSink*>(context);
    uint32_t used = self.text_.length();
    if (used > self.limit_ || length > self.limit_ - used) return false;
    uint32_t needed = used + length;
    if (needed > self.capacity_) {
      uint32_t capacity = needed > UINT32_MAX - 1023 ? self.limit_ : ((needed + 1023) / 1024) * 1024;
      if (capacity > self.limit_) capacity = self.limit_;
      if (!self.text_.reserve(capacity)) return false;
      self.capacity_ = capacity;
    }
    return !length || self.text_.concat(reinterpret_cast<const char*>(bytes), length);
  }
};

// Diagnostics count the whole transfer but only retain the displayed prefix.
template<size_t N>
class CanPreviewSink {
public:
  char bytes[N] = {};
  size_t length = 0;
  CanSdoSink sink() { return {this, begin, write}; }
private:
  static bool begin(void* context, uint32_t) {
    static_cast<CanPreviewSink*>(context)->length = 0;
    return true;
  }
  static bool write(void* context, const uint8_t* data, uint8_t size) {
    auto& self = *static_cast<CanPreviewSink*>(context);
    size_t n = size;
    if (n > N - self.length) n = N - self.length;
    memcpy(self.bytes + self.length, data, n);
    self.length += n;
    return true;
  }
};
