// SPDX-License-Identifier: GPL-3.0-or-later
// Fault-injected JNI table executes the real bridge; no JVM allocation hook or production hook.
#include <jni.h>
#include <cstdarg>
#include <cstring>
#include <iostream>
#include <stdexcept>
#include "../PhonemizerJni.cpp"
namespace {
int calls = 0, failAt = 0, invalidCalls = 0, coreCalls = 0;
bool pending = false;
_jobject dummy;
template<typename T> T ref() { return reinterpret_cast<T>(&dummy); }
bool step(bool valid = true) {
  ++calls;
  if (pending || !valid) { ++invalidCalls; return false; }
  if (failAt == calls) { pending = true; return false; }
  return true;
}
jboolean JNICALL exceptionCheck(JNIEnv*) { return pending ? JNI_TRUE : JNI_FALSE; }
void JNICALL deleteLocal(JNIEnv*, jobject) {} // JNI permits DeleteLocalRef with a pending exception.
jsize JNICALL arrayLength(JNIEnv*, jarray array) { return step(array != nullptr) ? 1 : 0; }
void JNICALL getBytes(JNIEnv*, jbyteArray array, jsize, jsize count, jbyte* out) { if (step(array != nullptr && out != nullptr)) std::memset(out, 'x', count); }
jbyteArray JNICALL newBytes(JNIEnv*, jsize) { return step() ? ref<jbyteArray>() : nullptr; }
void JNICALL setBytes(JNIEnv*, jbyteArray array, jsize, jsize, const jbyte* in) { step(array != nullptr && in != nullptr); }
jclass JNICALL findClass(JNIEnv*, const char*) { return step() ? ref<jclass>() : nullptr; }
jmethodID JNICALL method(JNIEnv*, jclass cls, const char*, const char*) { return step(cls != nullptr) ? reinterpret_cast<jmethodID>(&dummy) : nullptr; }
jstring JNICALL newUtf(JNIEnv*, const char*) { return step() ? ref<jstring>() : nullptr; }
jobject JNICALL newObject(JNIEnv*, jclass cls, jmethodID id, va_list) { return step(cls != nullptr && id != nullptr) ? ref<jobject>() : nullptr; }
jobjectArray JNICALL newArray(JNIEnv*, jsize, jclass cls, jobject) { return step(cls != nullptr) ? ref<jobjectArray>() : nullptr; }
jobject JNICALL getItem(JNIEnv*, jobjectArray array, jsize) { return step(array != nullptr) ? ref<jobject>() : nullptr; }
void JNICALL setItem(JNIEnv*, jobjectArray array, jsize, jobject item) { step(array != nullptr && item != nullptr); }
void require(bool condition) { if (!condition) throw std::runtime_error("jni_boundary_failed"); }
void reset(int failure = 0) { calls = invalidCalls = coreCalls = 0; pending = false; failAt = failure; }
}
namespace pocket::phonemizer {
uint64_t openOwner() { ++coreCalls; return 1; }
std::string reserve(uint64_t, const std::string&) { ++coreCalls; return {}; }
void cancel(uint64_t, const std::string&) { ++coreCalls; }
void invalidate(uint64_t) { ++coreCalls; }
void dispose(uint64_t) { ++coreCalls; }
const char* expectedManifestSha256() { return "test"; }
Result initialize(uint64_t, const std::string&) { ++coreCalls; Result r; r.raw = {"hello"}; return r; }
Result convert(uint64_t, const std::string&, std::vector<std::string>) { ++coreCalls; Result r; r.raw = {"hello"}; return r; }
}
int main() {
 try {
  JNINativeInterface_ table{};
  table.ExceptionCheck = exceptionCheck; table.DeleteLocalRef = deleteLocal;
  table.GetArrayLength = arrayLength; table.GetByteArrayRegion = getBytes; table.NewByteArray = newBytes;
  table.SetByteArrayRegion = setBytes; table.FindClass = findClass; table.GetMethodID = method;
  table.NewStringUTF = newUtf; table.NewObjectV = newObject; table.NewObjectArray = newArray;
  table.GetObjectArrayElement = getItem; table.SetObjectArrayElement = setItem;
  JNIEnv env{&table};
  auto convert = [&] { return JNI(convert)(&env, nullptr, 1, ref<jbyteArray>(), ref<jobjectArray>()); };
  auto initialize = [&] { return JNI(initialize)(&env, nullptr, 1, ref<jbyteArray>()); };
  int injected = 0;
  for (int kind = 0; kind < 2; ++kind) {
    reset(); require((kind ? initialize() : convert()) != nullptr); require(!pending && invalidCalls == 0 && coreCalls == 1); int count = calls;
    for (int failure = 1; failure <= count; ++failure) {
      reset(failure); auto output = kind ? initialize() : convert();
      require(output == nullptr && pending && invalidCalls == 0); ++injected;
    }
  }
  reset(); require(JNI(reserve)(&env, nullptr, 1, ref<jbyteArray>()) != nullptr); int reserveCalls = calls;
  for (int failure = 1; failure <= reserveCalls; ++failure) {
    reset(failure); require(JNI(reserve)(&env, nullptr, 1, ref<jbyteArray>()) == nullptr);
    require(pending && invalidCalls == 0 && coreCalls == 0); ++injected;
  }
  reset(); require(JNI(convert)(&env, nullptr, 1, nullptr, ref<jobjectArray>()) != nullptr); require(!pending && invalidCalls == 0 && coreCalls == 0);
  reset(); pending = true; require(convert() == nullptr && calls == 0 && coreCalls == 0);
  reset(); require(JNI(convert)(&env, nullptr, 1, ref<jbyteArray>(), nullptr) != nullptr); require(!pending && invalidCalls == 0 && coreCalls == 0);
  reset(); require(JNI(initialize)(&env, nullptr, 1, nullptr) != nullptr); require(!pending && invalidCalls == 0 && coreCalls == 0);
  std::cout << "PASS: actual JNI " << injected << " injected allocation/query/region failures, pending exception and null inputs\n";
 } catch (...) { std::cerr << "jni_boundary_failed invalidCalls=" << invalidCalls << " failAt=" << failAt << '\n'; return 1; }
}
