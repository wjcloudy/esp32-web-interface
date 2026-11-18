// Minimal host-side stand-in for Arduino's String, covering only what
// src/web_logic.h uses, with the same semantics where they matter:
// out-of-range substring()/indexOf() clamp or return -1 instead of throwing,
// and toInt() parses a leading integer (0 for junk) like the core's atol.
#pragma once

#include <string>
#include <cstdlib>
#include <cstring>
#include <type_traits>
#include <sstream>
#include <iomanip>

class String {
public:
  String() {}
  String(const char* s) : s_(s ? s : "") {}
  String(const std::string& s) : s_(s) {}
  explicit String(char c) : s_(1, c) {}
  template<class T, typename std::enable_if<std::is_integral<T>::value, int>::type = 0>
  explicit String(T v) : s_(std::to_string(v)) {}
  explicit String(double v, unsigned char decimals = 2) {
    std::ostringstream out; out << std::fixed << std::setprecision(decimals) << v; s_ = out.str();
  }

  unsigned int length() const { return (unsigned int)s_.size(); }
  const char* c_str() const { return s_.c_str(); }
  bool reserve(unsigned int n) { s_.reserve(n); return true; }

  char operator[](unsigned int i) const { return i < s_.size() ? s_[i] : 0; }

  String& operator+=(const String& o) { s_ += o.s_; return *this; }
  String& operator+=(const char* o) { if (o) s_ += o; return *this; }
  String& operator+=(char c) { s_ += c; return *this; }
  bool concat(const char* buf, unsigned int len) {
    if (!buf) return false;
    s_.append(buf, len);
    return true;
  }

  friend String operator+(const String& a, const String& b) { return String(a.s_ + b.s_); }
  friend String operator+(const String& a, const char* b) { return String(a.s_ + (b ? b : "")); }
  friend String operator+(const char* a, const String& b) { return String(std::string(a ? a : "") + b.s_); }

  bool operator==(const String& o) const { return s_ == o.s_; }
  bool operator==(const char* o) const { return o && s_ == o; }
  bool operator!=(const String& o) const { return s_ != o.s_; }
  bool operator!=(const char* o) const { return !(*this == o); }

  int indexOf(char c, unsigned int from = 0) const {
    if (from >= s_.size()) return -1;
    size_t p = s_.find(c, from);
    return p == std::string::npos ? -1 : (int)p;
  }
  int indexOf(const String& str, unsigned int from = 0) const {
    if (from >= s_.size()) return -1;
    size_t p = s_.find(str.s_, from);
    return p == std::string::npos ? -1 : (int)p;
  }

  String substring(unsigned int from) const { return substring(from, length()); }
  String substring(unsigned int from, unsigned int to) const {
    if (from > to) { unsigned int t = from; from = to; to = t; }
    if (from >= s_.size()) return String();
    if (to > s_.size()) to = (unsigned int)s_.size();
    return String(s_.substr(from, to - from));
  }

  bool startsWith(const String& p) const { return s_.compare(0, p.s_.size(), p.s_) == 0; }
  long toInt() const { return std::atol(s_.c_str()); }

  const std::string& std() const { return s_; }

private:
  std::string s_;
};
