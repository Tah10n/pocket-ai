// SPDX-License-Identifier: GPL-3.0-or-later
#include <jni.h>
#include "PhonemizerCore.h"
#include <string>
namespace {
struct JniFailure {};
void checked(JNIEnv* env) { if (env->ExceptionCheck()) throw JniFailure{}; }
template<typename T> T checked(JNIEnv* env, T value) {
  checked(env); if (!value) throw JniFailure{}; return value;
}
// JNI permits local-reference deletion with an exception pending. No other JNI
// operation is attempted after failure; returning preserves the original Java exception.
template<typename T> class LocalRef {
  JNIEnv* env; T value;
 public:
  LocalRef(JNIEnv* e, T v) : env(e), value(v) {}
  ~LocalRef() { if (value) env->DeleteLocalRef(value); }
  T get() const { return value; }
  T release() { T output = value; value = nullptr; return output; }
  LocalRef(const LocalRef&) = delete; LocalRef& operator=(const LocalRef&) = delete;
};
std::string bytes(JNIEnv* env, jbyteArray value) {
  checked(env); if (!value) throw JniFailure{};
  auto count = env->GetArrayLength(value); checked(env);
  if (count < 0 || count > 4096) throw JniFailure{};
  std::string output(static_cast<size_t>(count), '\0');
  if (count) { env->GetByteArrayRegion(value, 0, count, reinterpret_cast<jbyte*>(output.data())); checked(env); }
  return output;
}
jstring string(JNIEnv* env, const std::string& value) {
  checked(env); if (value.size() > 16384) throw JniFailure{};
  LocalRef<jbyteArray> data(env, checked(env, env->NewByteArray(static_cast<jsize>(value.size()))));
  if (!value.empty()) {
    env->SetByteArrayRegion(data.get(), 0, static_cast<jsize>(value.size()), reinterpret_cast<const jbyte*>(value.data())); checked(env);
  }
  LocalRef<jclass> cls(env, checked(env, env->FindClass("java/lang/String")));
  auto constructor = checked(env, env->GetMethodID(cls.get(), "<init>", "([BLjava/lang/String;)V"));
  LocalRef<jstring> encoding(env, checked(env, env->NewStringUTF("UTF-8")));
  return static_cast<jstring>(checked(env, env->NewObject(cls.get(), constructor, data.get(), encoding.get())));
}
jobject result(JNIEnv* env, const pocket::phonemizer::Result& value) {
  checked(env); if (value.raw.size() > 240) throw JniFailure{};
  LocalRef<jclass> strings(env, checked(env, env->FindClass("java/lang/String")));
  LocalRef<jobjectArray> raw(env, checked(env, env->NewObjectArray(static_cast<jsize>(value.raw.size()), strings.get(), nullptr)));
  for (size_t i = 0; i < value.raw.size(); ++i) {
    LocalRef<jstring> item(env, string(env, value.raw[i]));
    env->SetObjectArrayElement(raw.get(), static_cast<jsize>(i), item.get()); checked(env);
  }
  LocalRef<jclass> cls(env, checked(env, env->FindClass("com/github/tah10n/pocketphonemizer/NativeResult")));
  auto constructor = checked(env, env->GetMethodID(cls.get(), "<init>", "([Ljava/lang/String;Ljava/lang/String;DDIZ)V"));
  LocalRef<jstring> error(env, value.error.empty() ? nullptr : string(env, value.error));
  return checked(env, env->NewObject(cls.get(), constructor, raw.get(), error.get(), value.initMs, value.conversionMs,
    static_cast<jint>(value.calls), static_cast<jboolean>(value.offThread)));
}
jobject failure(JNIEnv* env) noexcept {
  if (env->ExceptionCheck()) return nullptr;
  try { pocket::phonemizer::Result value; value.error = "native_failure"; return result(env, value); }
  catch (...) { return nullptr; } // Never allocate a second fallback after a failed fallback.
}
jstring literal(JNIEnv* env, const char* value) noexcept {
  if (env->ExceptionCheck()) return nullptr;
  try { return checked(env, env->NewStringUTF(value)); } catch (...) { return nullptr; }
}
}
#define JNI(name) Java_com_github_tah10n_pocketphonemizer_NativeBridge_##name
extern "C" JNIEXPORT jlong JNICALL JNI(openOwner)(JNIEnv* env, jobject) {
  if (env->ExceptionCheck()) return 0;
  try { return static_cast<jlong>(pocket::phonemizer::openOwner()); } catch (...) { return 0; }
}
extern "C" JNIEXPORT jstring JNICALL JNI(manifestSha)(JNIEnv* env, jobject) { return literal(env, pocket::phonemizer::expectedManifestSha256()); }
extern "C" JNIEXPORT jstring JNICALL JNI(reserve)(JNIEnv* env, jobject, jlong owner, jbyteArray id) {
  try {
    auto request = bytes(env, id);
    // Success marshalling must precede reservation: OOME cannot strand an accepted request.
    LocalRef<jstring> success(env, checked(env, env->NewStringUTF("")));
    auto error = pocket::phonemizer::reserve(owner, request);
    return error.empty() ? success.release() : string(env, error);
  }
  catch (...) { return literal(env, "native_failure"); }
}
extern "C" JNIEXPORT void JNICALL JNI(cancel)(JNIEnv* env, jobject, jlong owner, jbyteArray id) {
  try { auto request = bytes(env, id); pocket::phonemizer::cancel(owner, request); } catch (...) {}
}
extern "C" JNIEXPORT void JNICALL JNI(invalidate)(JNIEnv* env, jobject, jlong owner) {
  if (env->ExceptionCheck()) return;
  try { pocket::phonemizer::invalidate(owner); } catch (...) {}
}
extern "C" JNIEXPORT void JNICALL JNI(dispose)(JNIEnv* env, jobject, jlong owner) {
  if (env->ExceptionCheck()) return;
  try { pocket::phonemizer::dispose(owner); } catch (...) {}
}
extern "C" JNIEXPORT jobject JNICALL JNI(initialize)(JNIEnv* env, jobject, jlong owner, jbyteArray path) {
  try { auto dataPath = bytes(env, path); return result(env, pocket::phonemizer::initialize(owner, dataPath)); }
  catch (...) { return failure(env); }
}
extern "C" JNIEXPORT jobject JNICALL JNI(convert)(JNIEnv* env, jobject, jlong owner, jbyteArray id, jobjectArray chunks) {
  try {
    checked(env); if (!chunks) throw JniFailure{};
    auto count = env->GetArrayLength(chunks); checked(env);
    if (count < 0 || count > 240) throw JniFailure{};
    std::vector<std::string> values;
    for (jsize i = 0; i < count; ++i) {
      LocalRef<jbyteArray> value(env, static_cast<jbyteArray>(checked(env, env->GetObjectArrayElement(chunks, i))));
      values.push_back(bytes(env, value.get()));
    }
    auto request = bytes(env, id);
    return result(env, pocket::phonemizer::convert(owner, request, std::move(values)));
  } catch (...) { return failure(env); }
}
