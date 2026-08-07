package com.github.tah10n.pocketanydoc

import android.content.ComponentCallbacks2
import android.content.Context
import android.content.res.Configuration
import android.net.Uri
import android.system.Os
import android.system.OsConstants
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.LinkedHashMap
import java.util.LinkedHashSet
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.LinkedBlockingDeque
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.locks.ReentrantReadWriteLock
import kotlin.concurrent.read
import kotlin.concurrent.write

internal object PocketAnyDocJni {
  init {
    System.loadLibrary("pocket_anydoc_jni")
  }

  external fun engineNew(): Long
  external fun engineFree(engine: Long)
  external fun version(): ByteArray
  external fun capabilities(): ByteArray
  external fun prepare(engine: Long, request: ByteArray): ByteArray
  external fun selectContext(engine: Long, request: ByteArray): ByteArray
  external fun materializeAsset(engine: Long, request: ByteArray): ByteArray
  external fun cancel(engine: Long, request: ByteArray): ByteArray
  external fun release(engine: Long, request: ByteArray): ByteArray
}

private const val MODULE_NAME = "PocketAnydoc"
private const val ATTACHMENT_DIRECTORY = "chat-attachments"
private const val MAX_REQUEST_BYTES = 64 * 1024
private const val MAX_RESPONSE_BYTES = 1024 * 1024
private const val MAX_SOURCE_BYTES = 32L * 1024L * 1024L
private const val MAX_REQUEST_DEPTH = 8
private const val MAX_REQUEST_NODES = 512
private const val MAX_STRING_CHARS = 16 * 1024
private const val MAX_REQUEST_ID_CHARS = 128
private const val MAX_HANDLE_CHARS = 256
private const val MAX_SELECTED_CHARS = 64 * 1024
private const val MAX_SELECTED_CHUNKS = 64
private const val MAX_PENDING_HEAVY_JOBS = 16
private const val MAX_ASSET_DESCRIPTORS = 128
private const val MAX_ASSET_BYTES = 8 * 1024 * 1024
private const val MAX_TRACKED_HANDLES = 16
private const val ASSET_DIRECTORY = "pocket-anydoc-assets"
private val SAFE_ID = Regex("^[A-Za-z0-9._:-]+$")
private val SHA256 = Regex("^[a-f0-9]{64}$")
private val ASSET_FILE_NAME = Regex("^[a-f0-9]{32}\\.(?:png|jpg|gif|webp)$")
private val ASSET_EXTENSIONS = mapOf(
  "image/png" to "png",
  "image/jpeg" to "jpg",
  "image/gif" to "gif",
  "image/webp" to "webp",
)
private val MATERIALIZE_REQUEST_KEYS = setOf("requestId", "handle", "assetId")

private class RequestException(
  val code: String,
  override val message: String,
) : IllegalArgumentException(message)

private data class FileIdentity(
  val device: Long,
  val inode: Long,
  val size: Long,
  val modifiedSeconds: Long,
) {
  fun toJson(): JSONObject = JSONObject()
    .put("device", device)
    .put("inode", inode)
    .put("size", size)
    .put("modifiedSeconds", modifiedSeconds)
}

private data class ValidatedSource(
  val file: File,
  val root: File,
  val identity: FileIdentity,
)

private data class AssetMetadata(
  val mediaType: String,
  val byteLength: Int,
  val sha256: String,
  val width: Int,
  val height: Int,
)

private data class OwnedAsset(
  val handle: String,
  val requestId: String,
  val file: File,
)

private enum class HeavyOperation {
  PREPARE,
  SELECT_CONTEXT,
  MATERIALIZE_ASSET,
}

public class PocketAnyDocModule : Module() {
  private val queueLock = Any()
  private val heavyQueue = LinkedBlockingDeque<Runnable>(MAX_PENDING_HEAVY_JOBS)
  private val heavyExecutor = ThreadPoolExecutor(
    1,
    1,
    0L,
    TimeUnit.MILLISECONDS,
    heavyQueue,
    { runnable ->
      Thread(runnable, "pocket-anydoc-worker").apply {
        isDaemon = true
        priority = Thread.NORM_PRIORITY - 1
      }
    },
    ThreadPoolExecutor.AbortPolicy(),
  )
  private val engineLock = ReentrantReadWriteLock()
  private val destroyed = AtomicBoolean(false)
  private val callbacksRegistered = AtomicBoolean(false)
  private val generation = AtomicLong(0)
  private val activeRequestIds = ConcurrentHashMap.newKeySet<String>()
  private val cancelledRequestIds = ConcurrentHashMap.newKeySet<String>()
  private val assetMetadataByHandle = LinkedHashMap<String, Map<Int, AssetMetadata>>()
  private val releasedAssetHandles = LinkedHashSet<String>()
  private val pendingAssetDestinations = mutableMapOf<String, OwnedAsset>()
  private val ownedAssetsByHandle = mutableMapOf<String, MutableSet<OwnedAsset>>()

  @Volatile
  private var engine: Long = 0L

  @Volatile
  private var retainedApplicationContext: Context? = null

  private val applicationContext: Context
    get() = retainedApplicationContext
      ?: appContext.reactContext?.applicationContext
      ?: throw Exceptions.ReactContextLost()

  private val memoryCallbacks = object : ComponentCallbacks2 {
    override fun onConfigurationChanged(newConfig: Configuration) = Unit

    @Deprecated("Called by Android for compatibility on older API levels")
    override fun onLowMemory() {
      handleMemoryPressure("low_memory")
    }

    @Suppress("DEPRECATION") // Required while ComponentCallbacks2 still delivers legacy trim levels.
    override fun onTrimMemory(level: Int) {
      if (level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW) {
        handleMemoryPressure("trim_memory")
      }
    }
  }

  override fun definition() = ModuleDefinition {
    Name(MODULE_NAME)

    OnCreate {
      val context = applicationContext
      retainedApplicationContext = context
      if (callbacksRegistered.compareAndSet(false, true)) {
        context.registerComponentCallbacks(memoryCallbacks)
      }
    }

    AsyncFunction("getCapabilities") { promise: Promise ->
      resolveStaticCall(promise) { PocketAnyDocJni.capabilities() }
    }

    AsyncFunction("getVersion") { promise: Promise ->
      resolveStaticCall(promise) { PocketAnyDocJni.version() }
    }

    AsyncFunction("prepareDocument") { request: Map<String, Any?>, promise: Promise ->
      enqueueHeavy(HeavyOperation.PREPARE, request, promise)
    }

    AsyncFunction("selectContext") { request: Map<String, Any?>, promise: Promise ->
      enqueueHeavy(HeavyOperation.SELECT_CONTEXT, request, promise)
    }

    AsyncFunction("materializeAsset") { request: Map<String, Any?>, promise: Promise ->
      enqueueHeavy(HeavyOperation.MATERIALIZE_ASSET, request, promise)
    }

    AsyncFunction("cancel") { requestId: String ->
      cancelDirect(requestId)
    }

    AsyncFunction("release") { handle: String ->
      releaseDirect(handle)
    }

    OnDestroy {
      close()
    }
  }

  private fun resolveStaticCall(promise: Promise, call: () -> ByteArray) {
    if (destroyed.get()) {
      promise.resolve(errorEnvelope("module_destroyed", "The document module is no longer available.", true))
      return
    }
    promise.resolve(runCatching { decodeEnvelope(call()) }.getOrElse { bridgeFailure(it) })
  }

  private fun enqueueHeavy(operation: HeavyOperation, request: Map<String, Any?>, promise: Promise) {
    val requestId = runCatching { requiredIdentifier(request["requestId"], "requestId", MAX_REQUEST_ID_CHARS) }
      .getOrElse {
        promise.resolve(requestFailure(it))
        return
      }
    var immediateFailure: Map<String, Any?>? = null
    synchronized(queueLock) {
      when {
        destroyed.get() -> {
          immediateFailure = errorEnvelope("module_destroyed", "The document module is no longer available.", true)
        }
        !activeRequestIds.add(requestId) -> {
          immediateFailure = errorEnvelope("duplicate_request", "A request with this identifier is already active.", false)
        }
        else -> {
          val job = HeavyJob(operation, request, requestId, generation.get(), promise)
          try {
            heavyExecutor.execute(job)
          } catch (_: RejectedExecutionException) {
            activeRequestIds.remove(requestId)
            cancelledRequestIds.remove(requestId)
            immediateFailure = if (destroyed.get()) {
              errorEnvelope("module_destroyed", "The document module is shutting down.", true)
            } else {
              errorEnvelope("resource_limit", "Too many document requests are pending.", true)
            }
          }
        }
      }
    }
    immediateFailure?.let(promise::resolve)
  }

  private inner class HeavyJob(
    private val operation: HeavyOperation,
    private val request: Map<String, Any?>,
    val requestId: String,
    private val submittedGeneration: Long,
    val promise: Promise,
  ) : Runnable {
    override fun run() {
      val invalidated = synchronized(queueLock) {
        when {
          destroyed.get() -> errorEnvelope("module_destroyed", "The document module is no longer available.", true)
          cancelledRequestIds.contains(requestId) -> cancelledEnvelope()
          generation.get() != submittedGeneration -> staleEnvelope()
          else -> null
        }
      }
      if (invalidated != null) {
        finish(invalidated)
        return
      }
      try {
        val result = when (operation) {
          HeavyOperation.PREPARE -> prepareOnWorker(request, requestId, submittedGeneration)
          HeavyOperation.SELECT_CONTEXT -> selectContextOnWorker(request, requestId, submittedGeneration)
          HeavyOperation.MATERIALIZE_ASSET -> materializeAssetOnWorker(request, requestId, submittedGeneration)
        }
        promise.resolve(result)
      } catch (error: Throwable) {
        promise.resolve(requestFailure(error))
      } finally {
        cleanupRequest(requestId)
      }
    }

    fun invalidate(result: Map<String, Any?>) {
      promise.resolve(result)
    }

    private fun finish(result: Map<String, Any?>) {
      try {
        promise.resolve(result)
      } finally {
        cleanupRequest(requestId)
      }
    }
  }

  private fun prepareOnWorker(
    request: Map<String, Any?>,
    requestId: String,
    submittedGeneration: Long,
  ): Map<String, Any?> {
    val source = validatePrivateAttachment(request["localUri"])
    val declaredSize = requiredBoundedInteger(request["sourceSizeBytes"], "sourceSizeBytes", 0, MAX_SOURCE_BYTES.toInt())
    if (declaredSize.toLong() != source.identity.size) {
      throw RequestException("source_size_mismatch", "The source file size changed before parsing.")
    }
    val payload = boundedJsonObject(request)
      .put("schemaVersion", 1)
      .put("sourcePath", source.file.path)
      .put("privateRoot", source.root.path)
      .put("sourceIdentity", source.identity.toJson())
    payload.remove("localUri")
    currentInvalidationEnvelope(requestId, submittedGeneration)?.let { return it }
    val response = decodeEnvelope(callWithEngine(true) { pointer -> PocketAnyDocJni.prepare(pointer, encode(payload)) })

    val currentIdentity = runCatching { validatePrivateAttachment(source.file.path).identity }.getOrNull()
    if (currentIdentity != source.identity) {
      releaseReturnedHandle(response, "source_changed")
      return errorEnvelope("source_changed", "The source file changed while it was being parsed.", true)
    }
    val result = finishHeavyResponse(response, requestId, submittedGeneration)
    rememberPreparedAssets(result)
    return result
  }

  private fun selectContextOnWorker(
    request: Map<String, Any?>,
    requestId: String,
    submittedGeneration: Long,
  ): Map<String, Any?> {
    requiredIdentifier(request["handle"], "handle", MAX_HANDLE_CHARS)
    requiredBoundedInteger(request["maxChars"], "maxChars", 1, MAX_SELECTED_CHARS)
    requiredBoundedInteger(request["maxChunks"], "maxChunks", 1, MAX_SELECTED_CHUNKS)
    val payload = boundedJsonObject(request).put("schemaVersion", 1)
    currentInvalidationEnvelope(requestId, submittedGeneration)?.let { return it }
    val response = decodeEnvelope(callWithEngine(true) { pointer -> PocketAnyDocJni.selectContext(pointer, encode(payload)) })
    return finishHeavyResponse(response, requestId, submittedGeneration)
  }

  private fun materializeAssetOnWorker(
    request: Map<String, Any?>,
    requestId: String,
    submittedGeneration: Long,
  ): Map<String, Any?> {
    if (request.keys != MATERIALIZE_REQUEST_KEYS) {
      throw RequestException("invalid_request", "The asset request contains unsupported fields.")
    }
    val handle = requiredIdentifier(request["handle"], "handle", MAX_HANDLE_CHARS)
    val assetId = requiredBoundedInteger(request["assetId"], "assetId", 0, Int.MAX_VALUE)
    val metadata = synchronized(queueLock) {
      if (handle in releasedAssetHandles) null else assetMetadataByHandle[handle]?.get(assetId)
    }
      ?: throw RequestException("invalid_asset", "The requested asset is not available for this document.")
    val extension = ASSET_EXTENSIONS[metadata.mediaType]
      ?: throw RequestException("invalid_asset", "The requested asset media type is not supported.")
    val root = createAssetCacheRoot()
    val destination = createUniqueAssetDestination(root, extension)
    val pending = OwnedAsset(handle, requestId, destination)
    var retained = false
    synchronized(queueLock) {
      pendingAssetDestinations[requestId] = pending
    }
    try {
      currentInvalidationEnvelope(requestId, submittedGeneration)?.let { return it }
      if (synchronized(queueLock) { handle in releasedAssetHandles }) {
        return errorEnvelope("invalid_handle", "The document handle is no longer available.", false)
      }
      val payload = JSONObject()
        .put("schemaVersion", 1)
        .put("requestId", requestId)
        .put("handle", handle)
        .put("assetId", assetId)
        .put("destinationPath", destination.path)
        .put("privateRoot", root.path)
      val response = decodeEnvelope(
        callWithEngine(true) { pointer -> PocketAnyDocJni.materializeAsset(pointer, encode(payload)) },
      )
      if (response["ok"] != true) {
        return response
      }
      currentInvalidationEnvelope(requestId, submittedGeneration)?.let { return it }
      val sanitized = try {
        validateMaterializedAsset(response, handle, assetId, metadata, root, destination)
      } catch (error: Throwable) {
        currentInvalidationEnvelope(requestId, submittedGeneration)?.let { return it }
        if (synchronized(queueLock) { handle in releasedAssetHandles }) {
          return errorEnvelope("invalid_handle", "The document handle is no longer available.", false)
        }
        throw error
      }
      val invalidated = synchronized(queueLock) {
        when {
          destroyed.get() -> errorEnvelope("module_destroyed", "The document module is no longer available.", true)
          cancelledRequestIds.contains(requestId) -> cancelledEnvelope()
          generation.get() != submittedGeneration -> staleEnvelope()
          handle in releasedAssetHandles -> errorEnvelope("invalid_handle", "The document handle is no longer available.", false)
          else -> {
            pendingAssetDestinations.remove(requestId)
            ownedAssetsByHandle.getOrPut(handle, ::mutableSetOf).add(pending)
            retained = true
            null
          }
        }
      }
      return invalidated ?: sanitized
    } finally {
      synchronized(queueLock) {
        if (pendingAssetDestinations[requestId] == pending) {
          pendingAssetDestinations.remove(requestId)
        }
      }
      if (!retained) {
        deleteOwnedFile(destination)
      }
    }
  }

  private fun finishHeavyResponse(
    response: Map<String, Any?>,
    requestId: String,
    submittedGeneration: Long,
  ): Map<String, Any?> {
    if (cancelledRequestIds.contains(requestId)) {
      releaseReturnedHandle(response, "cancelled")
      return cancelledEnvelope()
    }
    if (destroyed.get() || generation.get() != submittedGeneration) {
      releaseReturnedHandle(response, "stale_result")
      return errorEnvelope("stale_result", "The result became stale before delivery.", true)
    }
    return response
  }

  private fun currentInvalidationEnvelope(
    requestId: String,
    submittedGeneration: Long,
  ): Map<String, Any?>? = synchronized(queueLock) {
    when {
      destroyed.get() -> errorEnvelope("module_destroyed", "The document module is no longer available.", true)
      cancelledRequestIds.contains(requestId) -> cancelledEnvelope()
      generation.get() != submittedGeneration -> staleEnvelope()
      else -> null
    }
  }

  private fun rememberPreparedAssets(response: Map<String, Any?>) {
    if (response["ok"] != true) return
    val data = response["data"] as? Map<*, *> ?: return
    val handle = data["handle"] as? String ?: return
    if (handle.length > MAX_HANDLE_CHARS || !SAFE_ID.matches(handle)) return
    val assets = data["assets"] as? List<*> ?: emptyList<Any?>()
    if (assets.size > MAX_ASSET_DESCRIPTORS) return
    val metadata = linkedMapOf<Int, AssetMetadata>()
    for (asset in assets) {
      val descriptor = asset as? Map<*, *> ?: return
      val id = runCatching { requiredBoundedInteger(descriptor["id"], "assetId", 0, Int.MAX_VALUE) }
        .getOrNull() ?: return
      val mediaType = (descriptor["mediaType"] as? String)?.lowercase() ?: return
      val byteLength = runCatching {
        requiredBoundedInteger(descriptor["byteLength"], "byteLength", 1, MAX_ASSET_BYTES)
      }.getOrNull() ?: return
      val sha256 = descriptor["sha256"] as? String ?: return
      val width = runCatching { requiredBoundedInteger(descriptor["width"], "width", 1, 16_384) }
        .getOrNull() ?: return
      val height = runCatching { requiredBoundedInteger(descriptor["height"], "height", 1, 16_384) }
        .getOrNull() ?: return
      if (id in metadata || mediaType !in ASSET_EXTENSIONS) return
      if (!SHA256.matches(sha256) || width.toLong() * height.toLong() > 40_000_000L) return
      metadata[id] = AssetMetadata(mediaType, byteLength, sha256, width, height)
    }
    val evicted = mutableListOf<File>()
    synchronized(queueLock) {
      assetMetadataByHandle.remove(handle)
      assetMetadataByHandle[handle] = metadata
      releasedAssetHandles.remove(handle)
      while (assetMetadataByHandle.size > MAX_TRACKED_HANDLES) {
        val oldest = assetMetadataByHandle.keys.first()
        assetMetadataByHandle.remove(oldest)
        evicted += ownedAssetsByHandle.remove(oldest).orEmpty().map(OwnedAsset::file)
      }
    }
    evicted.distinctBy(File::getPath).forEach(::deleteOwnedFile)
  }

  private fun createAssetCacheRoot(): File {
    val cacheRoot = applicationContext.cacheDir.canonicalFile
    val rawRoot = File(applicationContext.cacheDir, ASSET_DIRECTORY).absoluteFile
    if (!rawRoot.exists() && !rawRoot.mkdirs()) {
      throw RequestException("asset_cache_unavailable", "Private asset cache storage is unavailable.")
    }
    val rootStat = Os.lstat(rawRoot.path)
    if (!OsConstants.S_ISDIR(rootStat.st_mode) || OsConstants.S_ISLNK(rootStat.st_mode)) {
      throw RequestException("asset_cache_unavailable", "Private asset cache storage is unavailable.")
    }
    val canonicalRoot = rawRoot.canonicalFile
    if (canonicalRoot.parentFile != cacheRoot) {
      throw RequestException("asset_cache_unavailable", "Private asset cache storage is unavailable.")
    }
    Os.chmod(canonicalRoot.path, 448) // 0700
    return canonicalRoot
  }

  private fun createUniqueAssetDestination(root: File, extension: String): File {
    repeat(8) {
      val name = "${UUID.randomUUID().toString().replace("-", "")}.$extension"
      val candidate = File(root, name).absoluteFile
      if (ASSET_FILE_NAME.matches(name) && candidate.parentFile == root && !candidate.exists()) {
        return candidate
      }
    }
    throw RequestException("asset_cache_unavailable", "A private asset cache destination could not be reserved.")
  }

  private fun validateMaterializedAsset(
    response: Map<String, Any?>,
    expectedHandle: String,
    expectedAssetId: Int,
    expectedMetadata: AssetMetadata,
    root: File,
    destination: File,
  ): Map<String, Any?> {
    val data = response["data"] as? Map<*, *>
      ?: throw RequestException("invalid_native_response", "The native asset response is invalid.")
    if (data["handle"] != expectedHandle) {
      throw RequestException("invalid_native_response", "The native asset response is invalid.")
    }
    val assetId = requiredBoundedInteger(data["assetId"], "assetId", 0, Int.MAX_VALUE)
    val mediaType = data["mediaType"] as? String
    val byteLength = requiredBoundedInteger(data["byteLength"], "byteLength", 1, MAX_ASSET_BYTES)
    val expectedSha256 = data["sha256"] as? String
    val width = requiredBoundedInteger(data["width"], "width", 1, 16_384)
    val height = requiredBoundedInteger(data["height"], "height", 1, 16_384)
    if (
      expectedSha256 == null
      || assetId != expectedAssetId
      || mediaType != expectedMetadata.mediaType
      || byteLength != expectedMetadata.byteLength
      || expectedSha256 != expectedMetadata.sha256
      || width != expectedMetadata.width
      || height != expectedMetadata.height
      || !SHA256.matches(expectedSha256)
      || width.toLong() * height.toLong() > 40_000_000L
    ) {
      throw RequestException("invalid_native_response", "The native asset response is invalid.")
    }
    val canonicalDestination = destination.canonicalFile
    if (canonicalDestination.parentFile != root || !ASSET_FILE_NAME.matches(canonicalDestination.name)) {
      throw RequestException("invalid_native_response", "The native asset destination is invalid.")
    }
    val digest = sha256(destination, byteLength)
    if (digest != expectedSha256) {
      throw RequestException("invalid_native_response", "The materialized asset digest is invalid.")
    }
    return mapOf(
      "ok" to true,
      "data" to mapOf(
        "assetId" to assetId,
        "mediaType" to mediaType,
        "byteLength" to byteLength,
        "sha256" to expectedSha256,
        "width" to width,
        "height" to height,
        "localUri" to Uri.fromFile(canonicalDestination).toString(),
      ),
    )
  }

  private fun sha256(file: File, expectedByteLength: Int): String {
    try {
      val descriptor = Os.open(file.path, OsConstants.O_RDONLY or OsConstants.O_CLOEXEC or OsConstants.O_NOFOLLOW, 0)
      try {
        val stat = Os.fstat(descriptor)
        if (
          !OsConstants.S_ISREG(stat.st_mode)
          || stat.st_size != expectedByteLength.toLong()
          || (stat.st_mode and 0x3f) != 0
        ) {
          throw RequestException("invalid_native_response", "The materialized asset file is invalid.")
        }
        val digest = MessageDigest.getInstance("SHA-256")
        var measured = 0
        val buffer = ByteArray(64 * 1024)
        while (true) {
          val count = Os.read(descriptor, buffer, 0, buffer.size)
          if (count == 0) break
          if (count > 0) {
            measured += count
            if (measured > expectedByteLength) {
              throw RequestException("invalid_native_response", "The materialized asset file changed before delivery.")
            }
            digest.update(buffer, 0, count)
          }
        }
        if (measured != expectedByteLength) {
          throw RequestException("invalid_native_response", "The materialized asset file changed before delivery.")
        }
        return digest.digest().joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
      } finally {
        runCatching { Os.close(descriptor) }
      }
    } catch (error: RequestException) {
      throw error
    } catch (_: Throwable) {
      throw RequestException("invalid_native_response", "The materialized asset file is unreadable.")
    }
  }

  private fun deleteOwnedFile(file: File) {
    val context = retainedApplicationContext ?: appContext.reactContext?.applicationContext ?: return
    val rawRoot = File(context.cacheDir, ASSET_DIRECTORY).absoluteFile
    val candidate = file.absoluteFile
    val allowedParents = setOf(rawRoot.path, runCatching { rawRoot.canonicalPath }.getOrDefault(rawRoot.path))
    if (candidate.parentFile?.path?.let(allowedParents::contains) == true && ASSET_FILE_NAME.matches(candidate.name)) {
      runCatching { candidate.delete() }
    }
  }

  private fun cleanupAssetsForRequest(requestId: String) {
    val files = synchronized(queueLock) {
      buildList {
        pendingAssetDestinations.remove(requestId)?.let { add(it.file) }
        for ((_, assets) in ownedAssetsByHandle) {
          val iterator = assets.iterator()
          while (iterator.hasNext()) {
            val asset = iterator.next()
            if (asset.requestId == requestId) {
              add(asset.file)
              iterator.remove()
            }
          }
        }
      }
    }
    files.distinctBy(File::getPath).forEach(::deleteOwnedFile)
  }

  private fun cleanupAssetsForHandle(handle: String) {
    val files = synchronized(queueLock) {
      assetMetadataByHandle.remove(handle)
      val pending = pendingAssetDestinations.values.filter { it.handle == handle }
      pending.forEach { pendingAssetDestinations.remove(it.requestId) }
      pending.map(OwnedAsset::file) + ownedAssetsByHandle.remove(handle).orEmpty().map(OwnedAsset::file)
    }
    files.distinctBy(File::getPath).forEach(::deleteOwnedFile)
  }

  private fun cleanupAllAssets() {
    val files = synchronized(queueLock) {
      val pending = pendingAssetDestinations.values.map(OwnedAsset::file)
      val owned = ownedAssetsByHandle.values.flatten().map(OwnedAsset::file)
      pendingAssetDestinations.clear()
      ownedAssetsByHandle.clear()
      assetMetadataByHandle.clear()
      pending + owned
    }
    files.distinctBy(File::getPath).forEach(::deleteOwnedFile)
  }

  private fun cancelDirect(requestIdValue: String): Map<String, Any?> {
    val requestId = runCatching { requiredIdentifier(requestIdValue, "requestId", MAX_REQUEST_ID_CHARS) }
      .getOrElse { return requestFailure(it) }
    val active = synchronized(queueLock) {
      activeRequestIds.contains(requestId).also { isActive ->
        if (isActive) cancelledRequestIds.add(requestId)
      }
    }
    val payload = encode(JSONObject().put("schemaVersion", 1).put("requestId", requestId))
    val result = runCatching {
      callExistingEngine { pointer -> PocketAnyDocJni.cancel(pointer, payload) }
        ?.let(::decodeEnvelope)
        ?: mapOf("ok" to true, "data" to mapOf("cancelledCount" to if (active) 1 else 0))
    }.getOrElse(::bridgeFailure)
    cleanupAssetsForRequest(requestId)
    return result
  }

  private fun releaseDirect(handleValue: String): Map<String, Any?> {
    val handle = runCatching { requiredIdentifier(handleValue, "handle", MAX_HANDLE_CHARS) }
      .getOrElse { return requestFailure(it) }
    synchronized(queueLock) {
      releasedAssetHandles.add(handle)
      while (releasedAssetHandles.size > MAX_TRACKED_HANDLES * 4) {
        releasedAssetHandles.remove(releasedAssetHandles.first())
      }
    }
    val payload = encode(JSONObject().put("schemaVersion", 1).put("handle", handle))
    val result = runCatching {
      callExistingEngine { pointer -> PocketAnyDocJni.release(pointer, payload) }
        ?.let(::decodeEnvelope)
        ?: mapOf("ok" to true, "data" to mapOf("releasedCount" to 0))
    }.getOrElse(::bridgeFailure)
    cleanupAssetsForHandle(handle)
    return result
  }

  private fun releaseReturnedHandle(response: Map<String, Any?>, reason: String) {
    val data = response["data"] as? Map<*, *> ?: return
    val handle = data["handle"] as? String ?: return
    if (handle.length > MAX_HANDLE_CHARS || !SAFE_ID.matches(handle)) {
      return
    }
    val payload = encode(JSONObject().put("schemaVersion", 1).put("handle", handle).put("reason", reason))
    runCatching { callExistingEngine { pointer -> PocketAnyDocJni.release(pointer, payload) } }
  }

  private fun callWithEngine(create: Boolean, call: (Long) -> ByteArray): ByteArray {
    while (true) {
      engineLock.read {
        if (engine != 0L) {
          return call(engine)
        }
        if (!create) {
          throw RequestException("engine_unavailable", "The native document engine is unavailable.")
        }
      }
      engineLock.write {
        if (engine == 0L) {
          engine = PocketAnyDocJni.engineNew()
          if (engine == 0L) {
            throw RequestException("engine_initialization_failed", "The native document engine could not be initialized.")
          }
        }
      }
    }
  }

  private fun callExistingEngine(call: (Long) -> ByteArray): ByteArray? =
    engineLock.read {
      if (engine == 0L) null else call(engine)
    }

  private fun destroyEngine() {
    engineLock.write {
      val pointer = engine
      engine = 0L
      if (pointer != 0L) {
        runCatching { PocketAnyDocJni.engineFree(pointer) }
      }
    }
  }

  private fun handleMemoryPressure(reason: String) {
    if (destroyed.get()) return
    val pending = synchronized(queueLock) {
      if (destroyed.get()) return
      generation.incrementAndGet()
      drainPendingJobsLocked().also {
        // The queue is empty at this point. Retirement is therefore ordered
        // immediately after the one possibly active parse and before any job
        // admitted after this memory-pressure generation.
        heavyExecutor.execute { destroyEngine() }
      }
    }
    pending.forEach { job -> job.invalidate(staleEnvelope()) }
    cancelAllAndReleaseCached(reason)
    cleanupAllAssets()
  }

  private fun cancelAllAndReleaseCached(reason: String) {
    val cancelPayload = encode(JSONObject().put("schemaVersion", 1).put("scope", "all").put("reason", reason))
    runCatching { callExistingEngine { pointer -> PocketAnyDocJni.cancel(pointer, cancelPayload) } }
    val releasePayload = encode(JSONObject().put("schemaVersion", 1).put("scope", "all_cached").put("reason", reason))
    runCatching { callExistingEngine { pointer -> PocketAnyDocJni.release(pointer, releasePayload) } }
  }

  private fun close() {
    val teardownContext = retainedApplicationContext
    val pending = synchronized(queueLock) {
      if (!destroyed.compareAndSet(false, true)) return
      generation.incrementAndGet()
      drainPendingJobsLocked()
    }
    pending.forEach { job ->
      job.invalidate(errorEnvelope("module_destroyed", "The document module is no longer available.", true))
    }
    if (callbacksRegistered.compareAndSet(true, false)) {
      runCatching { teardownContext?.unregisterComponentCallbacks(memoryCallbacks) }
    }
    try {
      cancelAllAndReleaseCached("module_destroyed")
      cleanupAllAssets()
    } finally {
      synchronized(queueLock) {
        try {
          // The queue was drained and destroyed rejects new jobs, so this is
          // ordered behind at most the one non-preemptive active native call.
          heavyExecutor.execute {
            try {
              destroyEngine()
            } finally {
              retainedApplicationContext = null
            }
          }
        } catch (_: RejectedExecutionException) {
          destroyEngine()
          retainedApplicationContext = null
        } finally {
          heavyExecutor.shutdown()
        }
      }
    }
  }

  private fun drainPendingJobsLocked(): List<HeavyJob> {
    val drained = mutableListOf<Runnable>()
    heavyQueue.drainTo(drained)
    return drained.filterIsInstance<HeavyJob>().onEach { job ->
      activeRequestIds.remove(job.requestId)
      cancelledRequestIds.remove(job.requestId)
    }
  }

  private fun cleanupRequest(requestId: String) {
    synchronized(queueLock) {
      activeRequestIds.remove(requestId)
      cancelledRequestIds.remove(requestId)
    }
  }

  private fun validatePrivateAttachment(value: Any?): ValidatedSource {
    val sourcePath = value as? String
      ?: throw RequestException("invalid_source_path", "sourcePath must be a local file path.")
    if (sourcePath.isBlank() || sourcePath.indexOf('\u0000') >= 0) {
      throw RequestException("invalid_source_path", "sourcePath must be a local file path.")
    }
    val uri = Uri.parse(sourcePath)
    val rawFile = when (uri.scheme?.lowercase()) {
      null -> File(sourcePath)
      "file" -> uri.path?.let(::File)
      else -> null
    } ?: throw RequestException("unsupported_source_uri", "The source must be copied into private app storage first.")

    val rawRoot = File(applicationContext.filesDir, ATTACHMENT_DIRECTORY).absoluteFile
    if (!rawRoot.exists() || !rawRoot.isDirectory) {
      throw RequestException("attachment_root_unavailable", "Private attachment storage is unavailable.")
    }
    val rawCandidate = rawFile.absoluteFile
    val rawSegments = rawCandidate.path.split(File.separatorChar)
    if (rawSegments.any { it == "." || it == ".." }) {
      throw RequestException("unsafe_source_path", "The source path is not allowed.")
    }
    val rootPrefix = "${rawRoot.path}${File.separator}"
    if (!rawCandidate.path.startsWith(rootPrefix)) {
      throw RequestException("source_outside_private_root", "The source is outside private attachment storage.")
    }

    rejectSymlinks(rawRoot, rawCandidate)
    val canonicalRoot = rawRoot.canonicalFile
    val canonicalCandidate = rawCandidate.canonicalFile
    if (!canonicalCandidate.path.startsWith("${canonicalRoot.path}${File.separator}")) {
      throw RequestException("source_outside_private_root", "The source is outside private attachment storage.")
    }
    val stat = Os.lstat(canonicalCandidate.path)
    if (!OsConstants.S_ISREG(stat.st_mode)) {
      throw RequestException("source_not_file", "The source must be a regular file.")
    }
    if (stat.st_size < 0L || stat.st_size > MAX_SOURCE_BYTES) {
      throw RequestException("source_too_large", "The source exceeds the mobile document limit.")
    }
    if (!canonicalCandidate.canRead()) {
      throw RequestException("source_unreadable", "The source file cannot be read.")
    }
    return ValidatedSource(
      file = canonicalCandidate,
      root = canonicalRoot,
      identity = FileIdentity(stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime),
    )
  }

  private fun rejectSymlinks(root: File, candidate: File) {
    var current = root
    if (OsConstants.S_ISLNK(Os.lstat(current.path).st_mode)) {
      throw RequestException("symlink_source_rejected", "Symlinked attachment paths are not allowed.")
    }
    val relative = candidate.path.removePrefix("${root.path}${File.separator}")
    for (segment in relative.split(File.separatorChar)) {
      current = File(current, segment)
      if (OsConstants.S_ISLNK(Os.lstat(current.path).st_mode)) {
        throw RequestException("symlink_source_rejected", "Symlinked attachment paths are not allowed.")
      }
    }
  }

  private fun boundedJsonObject(request: Map<String, Any?>): JSONObject {
    val counter = intArrayOf(0)
    val normalized = normalizeJson(request, 0, counter) as JSONObject
    encode(normalized)
    return normalized
  }

  private fun normalizeJson(value: Any?, depth: Int, counter: IntArray): Any {
    if (depth > MAX_REQUEST_DEPTH || ++counter[0] > MAX_REQUEST_NODES) {
      throw RequestException("request_too_complex", "The request object is too complex.")
    }
    return when (value) {
      null -> JSONObject.NULL
      is Boolean -> value
      is String -> {
        if (value.length > MAX_STRING_CHARS || value.indexOf('\u0000') >= 0) {
          throw RequestException("request_value_too_large", "A request string exceeds the bridge limit.")
        }
        value
      }
      is Number -> {
        val numeric = value.toDouble()
        if (!numeric.isFinite()) throw RequestException("invalid_number", "Request numbers must be finite.")
        value
      }
      is Map<*, *> -> {
        val output = JSONObject()
        value.keys.map {
          it as? String ?: throw RequestException("invalid_request_key", "Request keys must be strings.")
        }.sorted().forEach { key ->
          if (key.length > 128) throw RequestException("invalid_request_key", "A request key is too long.")
          output.put(key, normalizeJson(value[key], depth + 1, counter))
        }
        output
      }
      is List<*> -> {
        if (value.size > 128) throw RequestException("request_array_too_large", "A request array is too large.")
        JSONArray().also { output -> value.forEach { output.put(normalizeJson(it, depth + 1, counter)) } }
      }
      else -> throw RequestException("invalid_request_value", "The request contains an unsupported value.")
    }
  }

  private fun encode(json: JSONObject): ByteArray {
    val bytes = json.toString().toByteArray(StandardCharsets.UTF_8)
    if (bytes.size > MAX_REQUEST_BYTES) {
      throw RequestException("request_too_large", "The request exceeds the native bridge limit.")
    }
    return bytes
  }

  private fun decodeEnvelope(bytes: ByteArray): Map<String, Any?> {
    if (bytes.isEmpty() || bytes.size > MAX_RESPONSE_BYTES) {
      throw RequestException("invalid_native_response", "The native response is invalid.")
    }
    val decoder = StandardCharsets.UTF_8.newDecoder()
      .onMalformedInput(CodingErrorAction.REPORT)
      .onUnmappableCharacter(CodingErrorAction.REPORT)
    val text = decoder.decode(ByteBuffer.wrap(bytes)).toString()
    val objectValue = JSONObject(text)
    if (!objectValue.has("ok") || objectValue.opt("ok") !is Boolean) {
      throw RequestException("invalid_native_response", "The native response envelope is invalid.")
    }
    @Suppress("UNCHECKED_CAST")
    return jsonToKotlin(objectValue) as Map<String, Any?>
  }

  private fun jsonToKotlin(value: Any?): Any? = when (value) {
    null, JSONObject.NULL -> null
    is JSONObject -> value.keys().asSequence().associateWith { key -> jsonToKotlin(value.get(key)) }
    is JSONArray -> (0 until value.length()).map { index -> jsonToKotlin(value.get(index)) }
    else -> value
  }

  private fun requiredIdentifier(value: Any?, field: String, maxLength: Int): String {
    val identifier = value as? String
      ?: throw RequestException("invalid_$field", "$field must be a string.")
    if (identifier.isEmpty() || identifier.length > maxLength || !SAFE_ID.matches(identifier)) {
      throw RequestException("invalid_$field", "$field is invalid.")
    }
    return identifier
  }

  private fun requiredBoundedInteger(value: Any?, field: String, minimum: Int, maximum: Int): Int {
    val number = value as? Number ?: throw RequestException("invalid_$field", "$field must be an integer.")
    val double = number.toDouble()
    if (!double.isFinite() || double % 1.0 != 0.0 || double < minimum || double > maximum) {
      throw RequestException("invalid_$field", "$field is outside the supported range.")
    }
    return double.toInt()
  }

  private fun cancelledEnvelope(): Map<String, Any?> =
    errorEnvelope("conversion_cancelled", "Document processing was cancelled.", true)

  private fun staleEnvelope(): Map<String, Any?> =
    errorEnvelope("stale_result", "The result became stale before delivery.", true)

  private fun requestFailure(error: Throwable): Map<String, Any?> = when (error) {
    is RequestException -> errorEnvelope(error.code, error.message, false)
    else -> errorEnvelope("native_bridge_failed", "The native document bridge failed.", true)
  }

  private fun bridgeFailure(error: Throwable): Map<String, Any?> = requestFailure(error)

  private fun errorEnvelope(code: String, message: String, retryable: Boolean): Map<String, Any?> = mapOf(
    "ok" to false,
    "error" to mapOf(
      "code" to code,
      "message" to message,
      "retryable" to retryable,
    ),
  )
}
