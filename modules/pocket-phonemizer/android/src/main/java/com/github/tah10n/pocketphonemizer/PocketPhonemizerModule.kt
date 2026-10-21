package com.github.tah10n.pocketphonemizer

import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.nio.CharBuffer
import java.nio.charset.CodingErrorAction
import java.util.concurrent.Executors

class PocketPhonemizerModule : Module() {
  private val lock = Any()
  private val worker = Executors.newSingleThreadExecutor()
  private var owner = 0L
  private var busy = false
  private var closing = false
  private var destroyed = false
  private fun failure(code: String) = NativeResult(emptyArray(), code, 0.0, 0.0, 0, false).value()
  private fun utf8(value: String): ByteArray {
    val buffer = Charsets.UTF_8.newEncoder().onMalformedInput(CodingErrorAction.REPORT)
      .onUnmappableCharacter(CodingErrorAction.REPORT).encode(CharBuffer.wrap(value))
    return ByteArray(buffer.remaining()).also { buffer.get(it) }
  }
  private fun operation(promise: Promise, request: String? = null, work: (Long) -> NativeResult) {
    synchronized(lock) {
      if (destroyed || closing) { promise.resolve(failure("disposed")); return }
      if (busy) { promise.resolve(failure("busy")); return }
      if (owner == 0L) owner = NativeBridge.openOwner()
      if (owner == 0L) { promise.resolve(failure("busy")); return }
      val token = owner
      if (request != null) {
        val error = NativeBridge.reserve(token, request.toByteArray(Charsets.US_ASCII))
        if (error.isNotEmpty()) { promise.resolve(failure(error)); return }
      }
      busy = true
      worker.execute {
        val result = try { work(token).value() } catch (_: DataFailure) { failure("data_invalid") }
          catch (_: java.nio.charset.CharacterCodingException) { failure("invalid_utf8") }
          catch (_: Throwable) {
            // JNI/encoding exceptions must not leave a pre-reserved request alive.
            try {
              NativeBridge.invalidate(token); NativeBridge.dispose(token)
              synchronized(lock) { if (owner == token) owner = 0L }
            } catch (_: Throwable) { synchronized(lock) { closing = true } }
            failure("native_failure")
          }
        if (result["error"] == "native_failure") {
          try {
            NativeBridge.invalidate(token); NativeBridge.dispose(token)
            synchronized(lock) { if (owner == token) owner = 0L }
          } catch (_: Throwable) { synchronized(lock) { closing = true } }
        }
        synchronized(lock) { busy = false }
        promise.resolve(result)
      }
    }
  }
  private fun release(promise: Promise?, destroy: Boolean) {
    synchronized(lock) {
      if (destroyed) { promise?.resolve(null); return }
      if (destroy) destroyed = true
      if (closing) { promise?.reject("busy", "Phonemizer disposal is already draining", null); return }
      closing = true; val token = owner
      if (token != 0L) NativeBridge.invalidate(token)
      // At most one active operation and one disposal are accepted, never an unbounded queue.
      worker.execute {
        try { if (token != 0L) NativeBridge.dispose(token) }
        finally {
          synchronized(lock) { owner = 0L; closing = false }
          promise?.resolve(null); if (destroyed) worker.shutdown()
        }
      }
    }
  }
  override fun definition() = ModuleDefinition {
    Name("PocketPhonemizer")
    AsyncFunction("initialize") { promise: Promise ->
      val context = appContext.reactContext
      if (context == null) promise.resolve(failure("disposed"))
      else operation(promise) { token ->
        val begin = System.nanoTime(); val path = PhonemizerData.stage(context)
        val native = NativeBridge.initialize(token, utf8(path))
        native.copy(initMs = (System.nanoTime() - begin) / 1_000_000.0)
      }
    }
    AsyncFunction("convert") { requestId: String, chunks: List<String>, promise: Promise ->
      if (!requestId.matches(Regex("[A-Za-z0-9_-]{1,64}"))) promise.resolve(failure("invalid_request"))
      else if (chunks.isEmpty() || chunks.size > 240 || chunks.sumOf { it.length } !in 1..240) promise.resolve(failure("input_limit"))
      else {
        // Encode before reserving the native request so malformed UTF-16 cannot strand a reservation.
        try {
          val encoded = chunks.map(::utf8).toTypedArray()
          operation(promise, requestId) { token -> NativeBridge.convert(token, utf8(requestId), encoded) }
        } catch (_: java.nio.charset.CharacterCodingException) { promise.resolve(failure("invalid_utf8")) }
      }
    }
    AsyncFunction("cancel") { requestId: String -> synchronized(lock) {
      if (owner != 0L && requestId.matches(Regex("[A-Za-z0-9_-]{1,64}"))) NativeBridge.cancel(owner, requestId.toByteArray(Charsets.US_ASCII))
    } }
    AsyncFunction("dispose") { promise: Promise -> release(promise, false) }
    OnDestroy { release(null, true) }
  }
}
