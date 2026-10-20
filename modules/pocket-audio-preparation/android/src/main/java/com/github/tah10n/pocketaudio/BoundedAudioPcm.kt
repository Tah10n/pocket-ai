package com.github.tah10n.pocketaudio

import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.min
import kotlin.math.roundToInt

internal enum class AudioInputFailure(val nativeCode: String) {
  SIZE("ERR_AUDIO_SIZE_LIMIT"), DURATION("ERR_AUDIO_DURATION_LIMIT"), FORMAT("ERR_AUDIO_INVALID_FORMAT")
}
internal class AudioInputException(val failure: AudioInputFailure) : IllegalArgumentException(failure.name)
internal fun requireAudioInput(condition: Boolean, failure: AudioInputFailure) {
  if (!condition) throw AudioInputException(failure)
}

/** Streaming area resampling: average each exact output-time interval, never relabel headers. */
internal class BoundedAudioPcm(
  private val file: File, val sourceRate: Int, val targetRate: Int, private val seconds: Int,
) : AutoCloseable {
  init {
    require(sourceRate in 8000..192000 && targetRate in 8000..48000 && seconds in 1..30)
  }
  private val output = BufferedOutputStream(FileOutputStream(file), 16 * 1024)
  private val step = sourceRate.toDouble() / targetRate
  private var filled = 0.0
  private var sum = 0.0
  private var frames = 0L
  var samples = 0
    private set
  init {
    output.write(ByteArray(44))
  }
  fun frame(channels: FloatArray) {
    require(channels.size in 1..2 && channels.all { it.isFinite() }) { "invalid_audio" }
    frames++
    requireAudioInput(frames <= sourceRate.toLong() * seconds, AudioInputFailure.DURATION)
    val mono = channels.sumOf { it.toDouble().coerceIn(-1.0, 1.0) } / channels.size
    var remaining = 1.0
    while (remaining > 1e-9) {
      val weight = min(remaining, step - filled)
      sum += mono * weight
      filled += weight
      remaining -= weight
      if (filled >= step - 1e-9) {
        val value = sum / step
        requireAudioInput(++samples <= targetRate * seconds, AudioInputFailure.DURATION)
        val pcm = (value * if (value < 0) 32768 else 32767).roundToInt().coerceIn(-32768, 32767)
        output.write(pcm and 255)
        output.write((pcm shr 8) and 255)
        filled = 0.0
        sum = 0.0
      }
    }
  }
  fun finish() {
    require(samples > 0 && frames > 0) { "invalid_audio" }
    output.flush()
    val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
    header.put("RIFF".toByteArray()).putInt(36 + samples * 2).put("WAVEfmt ".toByteArray())
      .putInt(16).putShort(1).putShort(1).putInt(targetRate).putInt(targetRate * 2)
      .putShort(2).putShort(16).put("data".toByteArray()).putInt(samples * 2)
    RandomAccessFile(file, "rw").use { it.seek(0); it.write(header.array()) }
  }
  override fun close() { output.close() }
}
