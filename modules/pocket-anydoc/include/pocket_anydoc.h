#ifndef POCKET_ANYDOC_H
#define POCKET_ANYDOC_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#if defined(_WIN32)
#define POCKET_ANYDOC_EXPORT __declspec(dllexport)
#else
#define POCKET_ANYDOC_EXPORT __attribute__((visibility("default")))
#endif

typedef struct PocketAnyDocEngine PocketAnyDocEngine;

typedef struct PocketAnyDocBuffer {
  uint8_t *ptr;
  uintptr_t len;
  uintptr_t capacity;
} PocketAnyDocBuffer;

/* Engine ownership belongs to the native Expo module. Calls may be concurrent,
 * except that engine_free requires all in-flight calls to have completed. */
POCKET_ANYDOC_EXPORT PocketAnyDocEngine *pocket_anydoc_engine_new(void);
POCKET_ANYDOC_EXPORT void pocket_anydoc_engine_free(PocketAnyDocEngine *engine);

/* Every non-empty returned buffer is UTF-8 JSON and must be released exactly
 * once with pocket_anydoc_buffer_free. Document bytes and full-document
 * Markdown are never returned by this ABI. */
POCKET_ANYDOC_EXPORT PocketAnyDocBuffer pocket_anydoc_version(void);
POCKET_ANYDOC_EXPORT PocketAnyDocBuffer pocket_anydoc_capabilities(void);
POCKET_ANYDOC_EXPORT PocketAnyDocBuffer pocket_anydoc_prepare(
    PocketAnyDocEngine *engine, const uint8_t *request, uintptr_t request_len);
POCKET_ANYDOC_EXPORT PocketAnyDocBuffer pocket_anydoc_select_context(
    PocketAnyDocEngine *engine, const uint8_t *request, uintptr_t request_len);
/* The request names one prepared asset and a non-existing destination inside
 * a native-provided private root. The core atomically writes the validated
 * bytes but never returns bytes or a path in JSON. */
POCKET_ANYDOC_EXPORT PocketAnyDocBuffer pocket_anydoc_materialize_asset(
    PocketAnyDocEngine *engine, const uint8_t *request, uintptr_t request_len);
POCKET_ANYDOC_EXPORT PocketAnyDocBuffer pocket_anydoc_cancel(
    PocketAnyDocEngine *engine, const uint8_t *request, uintptr_t request_len);
POCKET_ANYDOC_EXPORT PocketAnyDocBuffer pocket_anydoc_release(
    PocketAnyDocEngine *engine, const uint8_t *request, uintptr_t request_len);
POCKET_ANYDOC_EXPORT void pocket_anydoc_buffer_free(PocketAnyDocBuffer buffer);

#ifdef __cplusplus
}
#endif

#endif
