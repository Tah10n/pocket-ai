// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once
#include <cstdint>
#include <string>
#include <vector>
namespace pocket::phonemizer {
struct Result {
  std::vector<std::string> raw;
  std::string error;
  double initMs = 0, conversionMs = 0;
  size_t calls = 0;
  bool offThread = false;
};
// These lightweight ownership operations never invoke eSpeak or wait for it.
uint64_t openOwner();
std::string reserve(uint64_t owner, const std::string& requestId);
void cancel(uint64_t owner, const std::string& requestId);
void invalidate(uint64_t owner);
// Call only on a platform background worker. All C API calls run on one process worker.
Result initialize(uint64_t owner, const std::string& verifiedDataPath);
Result convert(uint64_t owner, const std::string& requestId, std::vector<std::string> chunks);
void dispose(uint64_t owner);
const char* expectedManifestSha256();
}
