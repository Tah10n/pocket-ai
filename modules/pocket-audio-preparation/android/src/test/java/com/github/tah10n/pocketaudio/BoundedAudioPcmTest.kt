package com.github.tah10n.pocketaudio

import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder

class BoundedAudioPcmTest {
  @Test fun downmixAndResampleByActualIntervals() {
    val file = File.createTempFile("audio-area-", ".wav")
    try {
      BoundedAudioPcm(file, 48000, 24000, 1).use { sink ->
        sink.frame(floatArrayOf(1f, 0f)); sink.frame(floatArrayOf(0f, 1f))
        sink.frame(floatArrayOf(-1f, 0f)); sink.frame(floatArrayOf(0f, -1f))
        sink.finish(); assertEquals(2, sink.samples)
      }
      val bytes = file.readBytes()
      val values = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
      assertEquals(48, bytes.size); assertEquals(24000, values.getInt(24)); assertEquals(4, values.getInt(40))
      assertEquals(16384, values.getShort(44).toInt()); assertEquals(-16384, values.getShort(46).toInt())
    } finally { assertTrue(file.delete()) }
  }
  @Test fun rejectsNonfiniteAndOverlongDecodedInput() {
    val file = File.createTempFile("audio-bounds-", ".wav")
    try {
      BoundedAudioPcm(file, 8000, 16000, 1).use { sink ->
        try { sink.frame(floatArrayOf(Float.NaN)); fail("invalid_pcm accepted") } catch (_: IllegalArgumentException) { }
      }
      BoundedAudioPcm(file, 8000, 16000, 1).use { sink ->
        repeat(8000) { sink.frame(floatArrayOf(0f)) }
        assertEquals(16000, sink.samples)
        try { sink.frame(floatArrayOf(0f)); fail("overlong decoded audio accepted") } catch (_: IllegalArgumentException) { }
      }
    } finally { assertTrue(file.delete()) }
  }
}
