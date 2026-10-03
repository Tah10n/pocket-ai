package com.github.tah10n.pocketaudio

import android.media.AudioFormat
import android.app.ActivityManager
import android.content.Context
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.net.Uri
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

class PocketAudioPreparationModule : Module() {
  private val worker = Executors.newSingleThreadExecutor()
  private val busy = AtomicBoolean(false)
  private val cleanupFailed = AtomicBoolean(false)
  override fun definition() = ModuleDefinition {
    Name("PocketAudioPreparation")
    AsyncFunction("prepare") { source: String, rate: Int, seconds: Int, bytes: Int, promise: Promise ->
      if (cleanupFailed.get()) { promise.reject("ERR_AUDIO_CLEANUP", "cleanup_failed", null); return@AsyncFunction }
      if (!busy.compareAndSet(false, true)) { promise.reject("ERR_AUDIO_BUSY", "preparation_busy", null); return@AsyncFunction }
      try {
        worker.execute {
          try { promise.resolve(prepare(source, rate, seconds, bytes)) }
          catch (_: Exception) {
            if (cleanupFailed.get()) promise.reject("ERR_AUDIO_CLEANUP", "cleanup_failed", null)
            else promise.reject("ERR_AUDIO_PREPARATION", "invalid_or_oversized_audio", null)
          }
          finally { busy.set(false) }
        }
      } catch (_: Exception) { busy.set(false); promise.reject("ERR_AUDIO_PREPARATION", "preparation_failed", null) }
    }
    AsyncFunction("remove") { uri: String ->
      val context = requireNotNull(appContext.reactContext)
      val root = File(context.cacheDir, "audio-preparation").canonicalFile
      val file = managed(uri)
      require(file.parentFile == root && file.name.matches(Regex("[a-f0-9-]+\\.wav")))
      require(!file.exists() || file.delete()) { "cleanup_failed" }
      if (root.listFiles()?.isEmpty() == true) cleanupFailed.set(false)
    }
    OnDestroy { worker.shutdown() } // Submitted work drains; shutdown is not cancellation.
  }
  private fun managed(uri: String): File {
    val context = requireNotNull(appContext.reactContext)
    val parsed = Uri.parse(uri)
    require(parsed.scheme == "file" && parsed.authority.isNullOrEmpty()) { "invalid_audio" }
    val file = File(requireNotNull(parsed.path)).canonicalFile
    require(listOf(context.filesDir, context.cacheDir).any { file.path.startsWith(it.canonicalPath + File.separator) })
    return file
  }
  private fun hash(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().buffered(65536).use { input ->
      val chunk = ByteArray(65536)
      var total = 0
      while (true) {
        val count = input.read(chunk); if (count < 0) break
        total += count; require(total <= 4 * 1024 * 1024) { "audio_limit" }
        digest.update(chunk, 0, count)
      }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
  }
  private fun prepare(uri: String, rate: Int, seconds: Int, maxBytes: Int): Map<String, Any> {
    require(rate in 8000..48000 && seconds in 1..30 && maxBytes in 1..4 * 1024 * 1024)
    val source = managed(uri)
    require(source.isFile && source.length() in 1..maxBytes.toLong()) { "audio_limit" }
    val context = requireNotNull(appContext.reactContext)
    val manager = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
    val memory = ActivityManager.MemoryInfo(); manager.getMemoryInfo(memory)
    // OS codec buffers are not measured here. Reserve 64 MiB in addition to its low-memory threshold.
    require(!memory.lowMemory && memory.availMem - memory.threshold >= 64L * 1024 * 1024) { "memory_insufficient" }
    val originalHash = hash(source)
    val header = ByteArray(12)
    source.inputStream().use { require(it.read(header) == 12) { "invalid_audio" } }
    val wave = String(header, 0, 4) == "RIFF" && String(header, 8, 4) == "WAVE"
    val compressed = String(header, 4, 4) == "ftyp" || String(header, 0, 3) == "ID3"
      || (header[0].toInt() and 255 == 255 && header[1].toInt() and 224 == 224)
    require(wave || compressed) { "invalid_audio" }
    val root = File(context.cacheDir, "audio-preparation").canonicalFile
    require(root.isDirectory || root.mkdirs())
    val file = File(root, UUID.randomUUID().toString() + ".wav")
    var success = false
    try {
      val count = if (wave) decodeWave(source, file, rate, seconds) else decodeCompressed(source, file, rate, seconds)
      require(source.length() <= maxBytes && hash(source) == originalHash) { "source_changed" }
      require(file.length() == 44L + count * 2L)
      val result = mapOf("uri" to Uri.fromFile(file).toString(), "sourceSha256" to originalHash,
        "sha256" to hash(file), "sampleRate" to rate, "channels" to 1, "sampleCount" to count, "sizeBytes" to file.length())
      success = true
      return result
    } finally {
      if (!success && file.exists() && !file.delete()) { cleanupFailed.set(true); error("cleanup_failed") }
    }
  }
  private fun decodeWave(source: File, output: File, target: Int, seconds: Int): Int {
    RandomAccessFile(source, "r").use { input ->
      val initial = ByteArray(12); input.readFully(initial)
      val size = ByteBuffer.wrap(initial).order(ByteOrder.LITTLE_ENDIAN).getInt(4).toLong() and 0xffffffffL
      require(size + 8 == input.length()) { "invalid_audio" }
      var format = 0; var channels = 0; var rate = 0; var bits = 0; var align = 0
      var dataOffset = -1L; var dataSize = 0L; var chunks = 0
      while (input.filePointer + 8 <= input.length()) {
        require(++chunks <= 64)
        val chunk = ByteArray(8); input.readFully(chunk)
        val length = ByteBuffer.wrap(chunk).order(ByteOrder.LITTLE_ENDIAN).getInt(4).toLong() and 0xffffffffL
        val start = input.filePointer
        require(start + length + (length and 1L) <= input.length())
        when (String(chunk, 0, 4)) {
          "fmt " -> {
            require(format == 0 && length in 16..40)
            val fmt = ByteArray(16); input.readFully(fmt)
            val buffer = ByteBuffer.wrap(fmt).order(ByteOrder.LITTLE_ENDIAN)
            format = buffer.short.toInt() and 65535; channels = buffer.short.toInt() and 65535
            rate = buffer.int; val byteRate = buffer.int; align = buffer.short.toInt() and 65535; bits = buffer.short.toInt() and 65535
            require(channels in 1..2 && rate in 8000..192000 && ((format == 1 && bits == 16) || (format == 3 && bits == 32)))
            require(align == channels * bits / 8 && byteRate == rate * align)
          }
          "data" -> { require(dataOffset < 0); dataOffset = start; dataSize = length }
        }
        input.seek(start + length + (length and 1L))
      }
      require(input.filePointer == input.length() && format != 0 && dataOffset >= 0 && dataSize > 0 && dataSize % align == 0L
        && dataSize / align <= rate.toLong() * seconds)
      input.seek(dataOffset)
      BoundedAudioPcm(output, rate, target, seconds).use { sink ->
        val frameBytes = ByteArray(align)
        val frame = FloatArray(channels)
        val deadline = System.nanoTime() + 30_000_000_000L
        repeat((dataSize / align).toInt()) { index ->
          if (index % 1024 == 0) require(System.nanoTime() < deadline) { "decode_deadline" }
          input.readFully(frameBytes)
          val values = ByteBuffer.wrap(frameBytes).order(ByteOrder.LITTLE_ENDIAN)
          for (channel in 0 until channels) frame[channel] = if (format == 1) values.short / 32768f else values.float
          sink.frame(frame)
        }
        sink.finish(); return sink.samples
      }
    }
  }
  private fun decodeCompressed(source: File, output: File, target: Int, seconds: Int): Int {
    val extractor = MediaExtractor()
    var codec: MediaCodec? = null
    var sink: BoundedAudioPcm? = null
    try {
      extractor.setDataSource(source.path)
      require(extractor.trackCount in 1..2)
      var selected = -1
      for (index in 0 until extractor.trackCount) {
        val mime = extractor.getTrackFormat(index).getString(MediaFormat.KEY_MIME) ?: ""
        require(!mime.startsWith("video/"))
        if (mime in listOf("audio/mp4a-latm", "audio/mpeg")) { require(selected == -1); selected = index }
      }
      require(selected >= 0)
      val format = extractor.getTrackFormat(selected)
      val rate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
      val channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
      require(rate in 8000..192000 && channels in 1..2)
      if (format.containsKey(MediaFormat.KEY_DURATION)) require(format.getLong(MediaFormat.KEY_DURATION) in 1..seconds * 1_000_000L)
      format.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 65536)
      extractor.selectTrack(selected)
      codec = MediaCodec.createDecoderByType(requireNotNull(format.getString(MediaFormat.KEY_MIME)))
      codec.configure(format, null, null, 0); codec.start()
      sink = BoundedAudioPcm(output, rate, target, seconds)
      var inputDone = false; var outputDone = false; var encoding = AudioFormat.ENCODING_PCM_16BIT
      val info = MediaCodec.BufferInfo()
      val deadline = System.nanoTime() + 30_000_000_000L
      while (!outputDone) {
        require(System.nanoTime() < deadline) { "decode_deadline" }
        if (!inputDone) {
          val index = codec.dequeueInputBuffer(10000)
          if (index >= 0) {
            val buffer = requireNotNull(codec.getInputBuffer(index)); buffer.clear()
            require(buffer.capacity() <= 1024 * 1024)
            val size = extractor.readSampleData(buffer, 0)
            if (size < 0) { inputDone = true; codec.queueInputBuffer(index, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM) }
            else {
              require(size <= 65536 && extractor.sampleTime <= seconds * 1_000_000L)
              codec.queueInputBuffer(index, 0, size, extractor.sampleTime, 0); extractor.advance()
            }
          }
        }
        when (val index = codec.dequeueOutputBuffer(info, 10000)) {
          MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
            val decoded = codec.outputFormat
            require(decoded.getInteger(MediaFormat.KEY_SAMPLE_RATE) == rate && decoded.getInteger(MediaFormat.KEY_CHANNEL_COUNT) == channels)
            if (decoded.containsKey(MediaFormat.KEY_PCM_ENCODING)) encoding = decoded.getInteger(MediaFormat.KEY_PCM_ENCODING)
            require(encoding == AudioFormat.ENCODING_PCM_16BIT || encoding == AudioFormat.ENCODING_PCM_FLOAT)
          }
          else -> if (index >= 0) {
            try {
              val buffer = requireNotNull(codec.getOutputBuffer(index)).order(ByteOrder.LITTLE_ENDIAN)
              require(buffer.capacity() <= 1024 * 1024 && info.size in 0..1024 * 1024)
              val bytes = if (encoding == AudioFormat.ENCODING_PCM_FLOAT) 4 else 2
              require(info.size % (channels * bytes) == 0)
              buffer.position(info.offset); buffer.limit(info.offset + info.size)
              val frame = FloatArray(channels)
              while (buffer.hasRemaining()) {
                for (channel in 0 until channels) frame[channel] = if (bytes == 4) buffer.float else buffer.short / 32768f
                sink.frame(frame)
              }
              outputDone = info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
            } finally { codec.releaseOutputBuffer(index, false) }
          }
        }
      }
      sink.finish(); return sink.samples
    } finally {
      try { sink?.close() } finally { try { codec?.stop() } finally { try { codec?.release() } finally { extractor.release() } } }
    }
  }
}
