// SPDX-License-Identifier: GPL-3.0-or-later
#include "PhonemizerCore.h"
#include "data-identity.h"
#include <espeak-ng/espeak_ng.h>
#include <espeak-ng/speak_lib.h>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstring>
#include <filesystem>
#include <functional>
#include <future>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <utility>
namespace pocket::phonemizer {
namespace {
using Clock = std::chrono::steady_clock;
struct Failure { const char* code; };
void require(bool yes, const char* code) { if (!yes) throw Failure{code}; }
size_t units(const std::string& text, bool input) {
  size_t count = 0;
  for (size_t i = 0; i < text.size();) {
    uint32_t value = static_cast<unsigned char>(text[i++]); size_t extra = 0;
    if (value >= 0xc2 && value <= 0xdf) { value &= 31; extra = 1; }
    else if (value >= 0xe0 && value <= 0xef) { value &= 15; extra = 2; }
    else if (value >= 0xf0 && value <= 0xf4) { value &= 7; extra = 3; }
    else require(value < 128, "invalid_utf8");
    require(i + extra <= text.size(), "invalid_utf8");
    for (size_t n = 0; n < extra; ++n) {
      auto next = static_cast<unsigned char>(text[i++]);
      require((next & 0xc0) == 0x80, "invalid_utf8"); value = (value << 6) | (next & 63);
    }
    require(!((extra == 1 && value < 128) || (extra == 2 && value < 2048) ||
      (extra == 3 && value < 65536) || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)), "invalid_utf8");
    require(value != 0 && !(input && ((value < 32 && value != 9 && value != 10 && value != 13) ||
      (value >= 127 && value <= 159))), "invalid_control");
    count += value >= 0x10000 ? 2 : 1;
  }
  return count;
}
class Core {
 public:
  std::mutex mutex; std::condition_variable cv;
  uint64_t owner = 0, sequence = 0;
  bool invalid = false, cancelled = false, busy = false, stopping = false, initialized = false;
  std::string request;
  std::function<void()> pending;
  std::thread thread;
  Core() { thread = std::thread([this] {
    for (;;) {
      std::function<void()> work;
      { std::unique_lock<std::mutex> lock(mutex); cv.wait(lock, [this] { return stopping || pending; });
        if (stopping && !pending) break; work = std::move(pending); pending = nullptr; }
      work();
    }
    if (initialized) espeak_Terminate();
  }); }
  ~Core() { { std::unique_lock<std::mutex> lock(mutex); invalid = true; cancelled = true;
      cv.wait(lock, [this] { return !busy; }); stopping = true; } cv.notify_all(); thread.join(); }
  void check(uint64_t token) {
    std::lock_guard<std::mutex> lock(mutex);
    require(owner == token && !invalid && !cancelled, "cancelled");
  }
  Result run(uint64_t token, std::function<void(Result&)> work, bool release = false) {
    auto promise = std::make_shared<std::promise<Result>>(); auto future = promise->get_future();
    auto caller = std::this_thread::get_id();
    { std::lock_guard<std::mutex> lock(mutex);
      if (owner != token || (!release && invalid)) { Result r; r.error = "disposed"; return r; }
      if (busy) { Result r; r.error = "busy"; return r; }
      busy = true;
      pending = [this, token, work = std::move(work), promise, caller, release] {
        Result result; result.offThread = std::this_thread::get_id() != caller;
        try { if (!release) check(token); work(result); if (!release) check(token); }
        catch (const Failure& failure) { result.error = failure.code; result.raw.clear(); }
        catch (...) { result.error = "native_failure"; result.raw.clear(); }
        { std::lock_guard<std::mutex> lock(mutex);
          if (!release && (invalid || cancelled)) { result.error = "cancelled"; result.raw.clear(); }
          request.clear(); busy = false;
          if (release) { owner = 0; invalid = false; cancelled = false; }
          promise->set_value(std::move(result)); }
        cv.notify_all();
      };
    }
    cv.notify_all(); return future.get();
  }
};
Core& core() { static Core instance; return instance; }
}
const char* expectedManifestSha256() { return POCKET_PHONEMIZER_MANIFEST_SHA256; }
uint64_t openOwner() {
  auto& c = core(); std::lock_guard<std::mutex> lock(c.mutex);
  if (c.owner) return 0;
  c.owner = ++c.sequence; c.invalid = false; c.cancelled = false; return c.owner;
}
std::string reserve(uint64_t token, const std::string& id) {
  if (id.empty() || id.size() > 64 || id.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-") != std::string::npos) return "invalid_request";
  auto& c = core(); std::lock_guard<std::mutex> lock(c.mutex);
  if (!token || c.owner != token || c.invalid) return "disposed";
  if (c.busy || !c.request.empty()) return "busy";
  c.request = id; c.cancelled = false; return {};
}
void cancel(uint64_t token, const std::string& id) {
  auto& c = core(); std::lock_guard<std::mutex> lock(c.mutex);
  if (c.owner == token && c.request == id) c.cancelled = true;
}
void invalidate(uint64_t token) {
  auto& c = core(); std::lock_guard<std::mutex> lock(c.mutex);
  if (c.owner == token) { c.invalid = true; c.cancelled = true; }
}
Result initialize(uint64_t token, const std::string& path) {
  auto& c = core();
  return c.run(token, [&c, path](Result& result) {
    if (c.initialized) return;
    require(!path.empty() && path.size() < 220, "data_path_limit");
    auto begin = Clock::now(); bool started = false;
    try {
      espeak_ng_InitializePath(path.c_str()); started = true;
      espeak_ng_ERROR_CONTEXT context = nullptr;
      auto status = espeak_ng_Initialize(&context); espeak_ng_ClearErrorContext(&context);
      require(status == ENS_OK, "init_failed");
      require(espeak_ng_InitializeOutput(ENOUTPUT_MODE_SYNCHRONOUS, 0, nullptr) == ENS_OK, "output_init_failed");
      require(espeak_SetVoiceByName("gmw/en-US") == EE_OK, "voice_failed");
      const char* actual = nullptr; espeak_Info(&actual);
      require(actual && std::filesystem::equivalent(actual, path), "data_path_mismatch");
      result.initMs = std::chrono::duration<double, std::milli>(Clock::now() - begin).count();
      require(result.initMs <= 2000, "init_deadline"); c.initialized = true;
    } catch (...) { if (started) espeak_Terminate(); throw; }
  });
}
Result convert(uint64_t token, const std::string& id, std::vector<std::string> chunks) {
  auto& c = core();
  { std::lock_guard<std::mutex> lock(c.mutex);
    if (c.owner != token || c.request != id) { Result r; r.error = "invalid_request"; return r; } }
  return c.run(token, [&c, token, chunks = std::move(chunks)](Result& result) {
    require(c.initialized, "not_initialized");
    require(!chunks.empty() && chunks.size() <= 240, "input_limit");
    size_t count = 0;
    for (const auto& chunk : chunks) { require(chunk.size() <= 960, "input_limit"); count += units(chunk, true); }
    require(count > 0 && count <= 240, "input_limit");
    auto start = Clock::now(); size_t total = 0;
    auto check = [&] { c.check(token); require(Clock::now() - start <= std::chrono::milliseconds(1000), "deadline"); };
    for (const auto& chunk : chunks) {
      const void* cursor = chunk.c_str(); std::string output; size_t clauses = 0;
      while (cursor) {
        check(); auto before = reinterpret_cast<uintptr_t>(cursor);
        const char* phones = espeak_TextToPhonemes(&cursor, 1, ('_' << 8) | 2); ++result.calls; check();
        require(++clauses <= 241, "clause_limit");
        auto after = reinterpret_cast<uintptr_t>(cursor);
        require(!cursor || (after > before && after <= reinterpret_cast<uintptr_t>(chunk.c_str() + chunk.size())), "cursor_stall");
        size_t bytes = phones ? strnlen(phones, 16385) : 0; require(bytes <= 16384, "output_limit");
        std::string value(phones ? phones : "", bytes);
        if (!value.empty()) {
          total += units(value, false) + (output.empty() ? 0 : 1); require(total <= 4096, "output_limit");
          if (!output.empty()) output += ' '; output += value;
        }
      }
      result.raw.push_back(std::move(output));
    }
    result.conversionMs = std::chrono::duration<double, std::milli>(Clock::now() - start).count(); check();
  });
}
void dispose(uint64_t token) {
  if (!token) return;
  auto& c = core(); invalidate(token);
  { std::unique_lock<std::mutex> lock(c.mutex); c.cv.wait(lock, [&] { return !c.busy || c.owner != token; });
    if (c.owner != token) return; }
  c.run(token, [&c](Result&) { if (c.initialized) { espeak_Terminate(); c.initialized = false; } }, true);
}
}
