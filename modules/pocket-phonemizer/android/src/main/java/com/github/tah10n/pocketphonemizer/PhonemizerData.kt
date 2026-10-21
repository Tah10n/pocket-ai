package com.github.tah10n.pocketphonemizer

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.io.InputStream
import java.security.MessageDigest
import java.util.UUID

internal class DataFailure : Exception()
internal object PhonemizerData {
  private data class Entry(val path: String, val bytes: Long, val sha: String)
  private fun check(value: Boolean) { if (!value) throw DataFailure() }
  private val HEX = "0123456789abcdef".toCharArray()
  private fun hex(value: ByteArray): String {
    val result = CharArray(value.size * 2)
    for (index in value.indices) {
      val byte = value[index].toInt() and 0xff
      result[index * 2] = HEX[byte ushr 4]
      result[index * 2 + 1] = HEX[byte and 0x0f]
    }
    return String(result)
  }
  private fun sha(value: ByteArray) = hex(MessageDigest.getInstance("SHA-256").digest(value))
  private fun safe(file: File) { check(file.canonicalPath == file.absolutePath) }
  private fun digest(input: InputStream, expected: Long, output: java.io.OutputStream? = null): String {
    val hash = MessageDigest.getInstance("SHA-256"); val buffer = ByteArray(65536); var size = 0L
    input.use { stream -> while (true) { val count = stream.read(buffer); if (count < 0) break
      size += count; check(size <= expected); hash.update(buffer, 0, count); output?.write(buffer, 0, count)
    } }
    check(size == expected); return hex(hash.digest())
  }
  private fun verifyTree(root: File, entries: List<Entry>) {
    safe(root); check(root.isDirectory)
    val expected = entries.associateBy { it.path }; val observed = mutableSetOf<String>(); var nodes = 0
    fun walk(directory: File) {
      safe(directory); val children = directory.listFiles() ?: throw DataFailure()
      for (file in children) {
        check(++nodes <= 8192); safe(file)
        if (file.isDirectory) { val prefix = file.relativeTo(root).invariantSeparatorsPath + "/"; check(expected.keys.any { it.startsWith(prefix) }); walk(file) } else {
          check(file.isFile); val path = file.relativeTo(root).invariantSeparatorsPath
          val entry = expected[path] ?: throw DataFailure(); check(observed.add(path)); check(file.length() == entry.bytes)
          check(digest(file.inputStream(), entry.bytes) == entry.sha)
        }
      }
    }
    walk(root); check(observed == expected.keys)
  }
  fun stage(context: Context): String {
    val manifest = context.assets.open("data-manifest.json").use { stream ->
      val bytes = stream.readBytesBounded(512 * 1024); check(sha(bytes) == NativeBridge.manifestSha()); bytes
    }
    val document = JSONObject(String(manifest, Charsets.UTF_8)); check(document.getInt("schemaVersion") == 1)
    val files = document.getJSONArray("files"); check(files.length() in 1..4096)
    val entries = (0 until files.length()).map { index ->
      val item = files.getJSONObject(index); val path = item.getString("path"); val size = item.getLong("bytes"); val hash = item.getString("sha256")
      check(path.length in 1..240 && path.split('/').all { it.matches(Regex("[A-Za-z0-9_+.! -]+")) && it != "." && it != ".." })
      check(size in 0..(32L * 1024 * 1024) && hash.matches(Regex("[a-f0-9]{64}"))); Entry(path, size, hash)
    }
    check(entries.map { it.path }.toSet().size == entries.size); check(entries.sumOf { it.bytes } <= 64L * 1024 * 1024)
    val assets = mutableSetOf<String>(); var nodes = 0
    fun list(path: String, relative: String) {
      check(++nodes <= 8192); val children = context.assets.list(path) ?: throw DataFailure()
      if (children.isEmpty()) { check(relative.isNotEmpty()); assets.add(relative) }
      else children.forEach { list("$path/$it", if (relative.isEmpty()) it else "$relative/$it") }
    }
    list("espeak-ng-data", ""); check(assets == entries.map { it.path }.toSet())
    val base = File(context.filesDir.canonicalFile, "pocket-phonemizer"); safe(base); check(base.isDirectory || base.mkdir())
    val target = File(base, NativeBridge.manifestSha()); safe(target)
    if (target.exists()) { verifyTree(target, entries); return target.canonicalPath }
    val staging = File(base, "pending-${UUID.randomUUID()}"); check(staging.mkdir()); safe(staging)
    try {
      for (entry in entries) {
        val destination = File(staging, entry.path); val parent = destination.parentFile ?: throw DataFailure()
        check(parent.isDirectory || parent.mkdirs()); safe(parent); safe(destination); check(destination.createNewFile())
        destination.outputStream().use { out -> check(digest(context.assets.open("espeak-ng-data/${entry.path}"), entry.bytes, out) == entry.sha) }
        check(destination.setReadOnly())
      }
      verifyTree(staging, entries); check(!target.exists() && staging.renameTo(target)); verifyTree(target, entries)
      return target.canonicalPath
    } finally {
      // Only this invocation's unshared, canonical staging directory is disposable.
      if (staging.exists()) { safe(staging); staging.walkBottomUp().forEach { safe(it); check(it.delete()) } }
    }
  }
  private fun InputStream.readBytesBounded(limit: Int): ByteArray {
    val output = java.io.ByteArrayOutputStream(); val buffer = ByteArray(8192)
    while (true) { val count = read(buffer); if (count < 0) break; check(output.size() + count <= limit); output.write(buffer, 0, count) }
    return output.toByteArray()
  }
}
