// SPDX-License-Identifier: GPL-3.0-or-later
// Compiles the actual mobile Core against a controllable C API to verify its drain contract.
#include "../PhonemizerCore.h"
#include <espeak-ng/espeak_ng.h>
#include <atomic>
#include <chrono>
#include <filesystem>
#include <future>
#include <iostream>
#include <stdexcept>
#include <thread>
using namespace pocket::phonemizer;
namespace {
std::string path;
std::atomic<bool> block{false}, entered{false}, leave{false};
std::atomic<int> calls{0}, terminated{0};
std::thread::id nativeThread;
void check(bool condition) { if (!condition) throw std::runtime_error("test_failed"); }
void sameThread() { if (nativeThread == std::thread::id()) nativeThread = std::this_thread::get_id(); check(nativeThread == std::this_thread::get_id()); }
}
extern "C" {
void espeak_ng_InitializePath(const char* data) { sameThread(); path = data; }
espeak_ng_STATUS espeak_ng_Initialize(espeak_ng_ERROR_CONTEXT*) { sameThread(); return ENS_OK; }
void espeak_ng_ClearErrorContext(espeak_ng_ERROR_CONTEXT*) {}
espeak_ng_STATUS espeak_ng_InitializeOutput(espeak_ng_OUTPUT_MODE, int, const char*) { sameThread(); return ENS_OK; }
espeak_ERROR espeak_SetVoiceByName(const char*) { sameThread(); return EE_OK; }
const char* espeak_Info(const char** data) { *data = path.c_str(); return "test"; }
espeak_ERROR espeak_Terminate() { sameThread(); ++terminated; return EE_OK; }
const char* espeak_TextToPhonemes(const void** cursor, int mode, int flags) {
  sameThread(); check(mode == 1 && flags == (('_' << 8) | 2)); ++calls; entered = true;
  while (block && !leave) std::this_thread::sleep_for(std::chrono::milliseconds(1));
  *cursor = nullptr; return "h_\xc9\x99_l_\xcb\x88o\xca\x8a";
}
}
int main(int argc, char** argv) {
 try {
  check(argc == 2); auto owner = openOwner(); check(owner != 0 && openOwner() == 0);
  check(initialize(owner, argv[1]).error.empty()); check(nativeThread != std::this_thread::get_id());
  check(reserve(owner, "before").empty()); cancel(owner, "before");
  auto early = convert(owner, "before", {"hello"}); check(early.error == "cancelled" && early.raw.empty() && calls == 0);
  check(reserve(owner, "invalid").empty()); check(convert(owner, "invalid", {std::string("\xc0\x80", 2)}).error == "invalid_utf8");
  check(reserve(owner, "normal").empty()); auto normal = convert(owner, "normal", {"hello"}); check(normal.error.empty() && normal.raw.size() == 1 && normal.calls == 1 && normal.offThread);
  block = true; entered = false; leave = false; check(reserve(owner, "drain").empty());
  auto work = std::async(std::launch::async, [&] { return convert(owner, "drain", {"hello"}); });
  while (!entered) std::this_thread::yield(); check(reserve(owner, "second") == "busy");
  cancel(owner, "drain"); check(work.wait_for(std::chrono::milliseconds(10)) == std::future_status::timeout);
  auto release = std::async(std::launch::async, [&] { dispose(owner); });
  check(release.wait_for(std::chrono::milliseconds(10)) == std::future_status::timeout); check(terminated == 0 && openOwner() == 0);
  leave = true; auto cancelled = work.get(); release.get(); check(cancelled.error == "cancelled" && cancelled.raw.empty() && terminated == 1);
  auto next = openOwner(); check(next != 0 && next != owner); block = false;
  check(initialize(next, argv[1]).error.empty()); invalidate(owner); cancel(owner, "new");
  check(reserve(next, "new").empty()); check(convert(next, "new", {"hello"}).error.empty());
    check(reserve(next, "size").empty()); check(convert(next, "size", {std::string(241, 'a')}).error == "input_limit");
  block = true; entered = false; leave = false; check(reserve(next, "deadline").empty());
  auto deadline = std::async(std::launch::async, [&] { return convert(next, "deadline", {"hello"}); });
  while (!entered) std::this_thread::yield();
  std::this_thread::sleep_for(std::chrono::milliseconds(1050));
  check(deadline.wait_for(std::chrono::milliseconds(1)) == std::future_status::timeout);
  leave = true; auto late = deadline.get(); check(late.error == "deadline" && late.raw.empty());
  dispose(next); check(terminated == 2);
  std::cout << "PASS: actual core serial thread, bounds, reservation cancellation, drain, disposal, stale owner\n";
 } catch (...) { std::cerr << "core_lifecycle_failed\n"; return 1; }
}
