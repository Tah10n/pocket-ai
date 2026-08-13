#include <jni.h>

#include <cstdint>
#include <limits>
#include <string_view>

#include "pocket_anydoc.h"

namespace {

constexpr uintptr_t kMaxRequestBytes = 64U * 1024U;
constexpr uintptr_t kMaxResponseBytes = 1024U * 1024U;
constexpr std::string_view kAllocationError =
    R"({"ok":false,"error":{"code":"native_allocation_failed","message":"The native response could not be allocated.","retryable":true}})";
constexpr std::string_view kRequestTooLargeError =
    R"({"ok":false,"error":{"code":"request_too_large","message":"The native request exceeds the bridge limit.","retryable":false}})";
constexpr std::string_view kResponseTooLargeError =
    R"({"ok":false,"error":{"code":"response_too_large","message":"The native response exceeds the bridge limit.","retryable":false}})";
constexpr std::string_view kBridgeError =
    R"({"ok":false,"error":{"code":"native_bridge_failed","message":"The native bridge failed.","retryable":true}})";

jbyteArray copy_bytes(JNIEnv* env, std::string_view bytes) {
  if (bytes.size() > static_cast<size_t>(std::numeric_limits<jsize>::max())) {
    return nullptr;
  }
  auto* output = env->NewByteArray(static_cast<jsize>(bytes.size()));
  if (output != nullptr && !bytes.empty()) {
    env->SetByteArrayRegion(output, 0, static_cast<jsize>(bytes.size()),
                            reinterpret_cast<const jbyte*>(bytes.data()));
  }
  return output;
}

jbyteArray copy_owned_buffer(JNIEnv* env, PocketAnyDocBuffer buffer) {
  if (buffer.ptr == nullptr || buffer.len == 0U) {
    pocket_anydoc_buffer_free(buffer);
    return copy_bytes(env, kAllocationError);
  }
  if (buffer.len > kMaxResponseBytes || buffer.len > static_cast<uintptr_t>(std::numeric_limits<jsize>::max())) {
    pocket_anydoc_buffer_free(buffer);
    return copy_bytes(env, kResponseTooLargeError);
  }
  auto* output = env->NewByteArray(static_cast<jsize>(buffer.len));
  if (output != nullptr) {
    env->SetByteArrayRegion(output, 0, static_cast<jsize>(buffer.len),
                            reinterpret_cast<const jbyte*>(buffer.ptr));
  }
  pocket_anydoc_buffer_free(buffer);
  return output != nullptr ? output : copy_bytes(env, kAllocationError);
}

template <typename Callback>
jbyteArray with_request(JNIEnv* env, jbyteArray request, Callback&& callback) {
  if (request == nullptr) {
    return copy_bytes(env, kBridgeError);
  }
  const jsize length = env->GetArrayLength(request);
  if (length < 0 || static_cast<uintptr_t>(length) > kMaxRequestBytes) {
    return copy_bytes(env, kRequestTooLargeError);
  }
  jbyte* bytes = env->GetByteArrayElements(request, nullptr);
  if (bytes == nullptr && length > 0) {
    return copy_bytes(env, kAllocationError);
  }
  PocketAnyDocBuffer result{};
  try {
    result = callback(reinterpret_cast<const uint8_t*>(bytes), static_cast<uintptr_t>(length));
  } catch (...) {
    if (bytes != nullptr) {
      env->ReleaseByteArrayElements(request, bytes, JNI_ABORT);
    }
    return copy_bytes(env, kBridgeError);
  }
  if (bytes != nullptr) {
    env->ReleaseByteArrayElements(request, bytes, JNI_ABORT);
  }
  return copy_owned_buffer(env, result);
}

PocketAnyDocEngine* from_handle(jlong handle) {
  return reinterpret_cast<PocketAnyDocEngine*>(static_cast<uintptr_t>(handle));
}

}  // namespace

extern "C" JNIEXPORT jlong JNICALL
Java_com_github_tah10n_pocketanydoc_PocketAnyDocJni_engineNew(JNIEnv*, jobject) {
  try {
    return static_cast<jlong>(reinterpret_cast<uintptr_t>(pocket_anydoc_engine_new()));
  } catch (...) {
    return 0;
  }
}

extern "C" JNIEXPORT void JNICALL
Java_com_github_tah10n_pocketanydoc_PocketAnyDocJni_engineFree(JNIEnv*, jobject, jlong engine) {
  try {
    pocket_anydoc_engine_free(from_handle(engine));
  } catch (...) {
    // The C ABI is panic-safe. This guard prevents a foreign C++ exception from
    // crossing JNI if the implementation is replaced incorrectly.
  }
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_github_tah10n_pocketanydoc_PocketAnyDocJni_version(JNIEnv* env, jobject) {
  try {
    return copy_owned_buffer(env, pocket_anydoc_version());
  } catch (...) {
    return copy_bytes(env, kBridgeError);
  }
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_github_tah10n_pocketanydoc_PocketAnyDocJni_capabilities(JNIEnv* env, jobject) {
  try {
    return copy_owned_buffer(env, pocket_anydoc_capabilities());
  } catch (...) {
    return copy_bytes(env, kBridgeError);
  }
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_github_tah10n_pocketanydoc_PocketAnyDocJni_prepare(
    JNIEnv* env, jobject, jlong engine, jbyteArray request) {
  return with_request(env, request, [engine](const uint8_t* bytes, uintptr_t length) {
    return pocket_anydoc_prepare(from_handle(engine), bytes, length);
  });
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_github_tah10n_pocketanydoc_PocketAnyDocJni_selectContext(
    JNIEnv* env, jobject, jlong engine, jbyteArray request) {
  return with_request(env, request, [engine](const uint8_t* bytes, uintptr_t length) {
    return pocket_anydoc_select_context(from_handle(engine), bytes, length);
  });
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_github_tah10n_pocketanydoc_PocketAnyDocJni_materializeAsset(
    JNIEnv* env, jobject, jlong engine, jbyteArray request) {
  return with_request(env, request, [engine](const uint8_t* bytes, uintptr_t length) {
    return pocket_anydoc_materialize_asset(from_handle(engine), bytes, length);
  });
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_github_tah10n_pocketanydoc_PocketAnyDocJni_cancel(
    JNIEnv* env, jobject, jlong engine, jbyteArray request) {
  return with_request(env, request, [engine](const uint8_t* bytes, uintptr_t length) {
    return pocket_anydoc_cancel(from_handle(engine), bytes, length);
  });
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_github_tah10n_pocketanydoc_PocketAnyDocJni_release(
    JNIEnv* env, jobject, jlong engine, jbyteArray request) {
  return with_request(env, request, [engine](const uint8_t* bytes, uintptr_t length) {
    return pocket_anydoc_release(from_handle(engine), bytes, length);
  });
}
