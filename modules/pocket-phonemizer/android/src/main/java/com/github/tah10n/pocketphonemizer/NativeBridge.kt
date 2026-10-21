package com.github.tah10n.pocketphonemizer

internal data class NativeResult(
  val raw: Array<String>, val error: String?, val initMs: Double,
  val conversionMs: Double, val calls: Int, val offThread: Boolean,
) {
  fun value(): Map<String, Any> = buildMap {
    put("raw", raw.toList()); put("initMs", initMs); put("conversionMs", conversionMs)
    put("calls", calls); put("offThread", offThread); error?.let { put("error", it) }
  }
}
internal object NativeBridge {
  init { System.loadLibrary("pocket_phonemizer") }
  external fun openOwner(): Long
  external fun manifestSha(): String
  external fun reserve(owner: Long, id: ByteArray): String
  external fun cancel(owner: Long, id: ByteArray)
  external fun invalidate(owner: Long)
  external fun initialize(owner: Long, path: ByteArray): NativeResult
  external fun convert(owner: Long, id: ByteArray, chunks: Array<ByteArray>): NativeResult
  external fun dispose(owner: Long)
}
