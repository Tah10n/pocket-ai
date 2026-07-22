const fs = require('fs');
const path = require('path');
const { withDangerousMod, withMainApplication } = require('expo/config-plugins');
const { mergeContents } = require('@expo/config-plugins/build/utils/generateCode');

const SYSTEM_METRICS_MODULE_NAME = 'SystemMetrics';
const SYSTEM_METRICS_PACKAGE_CLASS = 'SystemMetricsPackage';
const SYSTEM_METRICS_REGISTRATION = `              add(${SYSTEM_METRICS_PACKAGE_CLASS}())`;

function getPackageName(config) {
  return config.android?.package ?? 'com.github.tah10n.pocketai';
}

function getPackageDirectory(projectRoot, packageName) {
  return path.join(projectRoot, 'android', 'app', 'src', 'main', 'java', ...packageName.split('.'));
}

function createSystemMetricsModuleSource(packageName) {
  return `package ${packageName}

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.attribute.BasicFileAttributes
import java.util.ArrayDeque
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.SynchronousQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

class ${SYSTEM_METRICS_MODULE_NAME}Module(
  reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {

  companion object {
    private const val CACHE_DIRECTORY_MAX_VISITED_NODES = 4_096
    private const val CACHE_DIRECTORY_MAX_DEPTH = 64
    private const val CACHE_DIRECTORY_MAX_ELAPSED_MS = 2_000L
  }

  private data class CacheDirectoryNode(
    val directory: File,
    val depth: Int
  )

  private class CacheDirectoryTraversalCancelledException : Exception()

  private class CacheDirectoryTraversalLimitException(scope: String) :
    Exception("Cache directory traversal exceeded its " + scope + " limit.")

  private class CacheDirectoryTraversalUnavailableException : Exception()

  private val cacheDirectorySizeGeneration = AtomicLong(0L)
  private val activeCacheDirectorySizeThread = AtomicReference<Thread?>(null)
  private val storageMetricsExecutor = ThreadPoolExecutor(
    1,
    1,
    0L,
    TimeUnit.MILLISECONDS,
    SynchronousQueue<Runnable>(),
    ThreadPoolExecutor.AbortPolicy()
  )

  override fun getName(): String = "${SYSTEM_METRICS_MODULE_NAME}"

  private fun readProcessResidentBytes(): Long {
    return try {
      File("/proc/self/status").useLines { lines ->
        lines.firstOrNull { it.startsWith("VmRSS:") }
          ?.substringAfter(':')
          ?.trim()
          ?.split(Regex("\\\\s+"))
          ?.firstOrNull()
          ?.toLongOrNull()
          ?.times(1024L)
          ?.coerceAtLeast(0L)
          ?: 0L
      }
    } catch (_: Exception) {
      0L
    }
  }

  private fun readProcMemInfoBytes(entryName: String): Long? {
    return try {
      File("/proc/meminfo").useLines { lines ->
        lines.firstOrNull { it.startsWith(entryName) }
          ?.substringAfter(':')
          ?.trim()
          ?.split(Regex("\\\\s+"))
          ?.firstOrNull()
          ?.toLongOrNull()
          ?.times(1024L)
          ?.coerceAtLeast(0L)
      }
    } catch (_: Exception) {
      null
    }
  }

  private fun readFreeMemoryBytes(memoryInfo: ActivityManager.MemoryInfo): Long? {
    val reflectedFreeBytes = try {
      ActivityManager.MemoryInfo::class.java
        .getField("freeMem")
        .getLong(memoryInfo)
        .coerceAtLeast(0L)
    } catch (_: Exception) {
      null
    }

    return reflectedFreeBytes ?: readProcMemInfoBytes("MemFree:")
  }

  private fun throwIfCacheDirectoryTraversalCancelled(
    generation: Long,
    deadlineNanos: Long
  ) {
    if (
      Thread.currentThread().isInterrupted ||
      cacheDirectorySizeGeneration.get() != generation
    ) {
      throw CacheDirectoryTraversalCancelledException()
    }
    if (System.nanoTime() >= deadlineNanos) {
      throw CacheDirectoryTraversalLimitException("elapsed_time")
    }
  }

  private fun addCacheEntryBytes(totalBytes: Long, entryBytes: Long): Long {
    val safeEntryBytes = entryBytes.coerceAtLeast(0L)
    return if (Long.MAX_VALUE - totalBytes < safeEntryBytes) {
      Long.MAX_VALUE
    } else {
      totalBytes + safeEntryBytes
    }
  }

  private fun readClearableCacheDirectorySizeBytes(root: File, generation: Long): Long {
    if (!root.exists() || !root.isDirectory) {
      return 0L
    }
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      throw CacheDirectoryTraversalUnavailableException()
    }

    // React Native owns this live OkHttp disk cache. Removing its files behind
    // an active client can corrupt or stall requests, so it is neither reported
    // nor removed by the in-app active-cache action.
    val protectedRootNames = setOf("http-cache")
    val canonicalRoot = root.canonicalFile
    val rootPrefix = canonicalRoot.path + File.separator
    val pendingDirectories = ArrayDeque<CacheDirectoryNode>()
    val seenDirectoryPaths = mutableSetOf(canonicalRoot.path)
    val deadlineNanos = System.nanoTime() +
      TimeUnit.MILLISECONDS.toNanos(CACHE_DIRECTORY_MAX_ELAPSED_MS)
    pendingDirectories.add(CacheDirectoryNode(canonicalRoot, 0))

    var visitedNodes = 0
    var totalBytes = 0L
    while (pendingDirectories.isNotEmpty()) {
      throwIfCacheDirectoryTraversalCancelled(generation, deadlineNanos)
      val node = pendingDirectories.removeLast()
      Files.newDirectoryStream(node.directory.toPath()).use { entries ->
        val iterator = entries.iterator()
        while (iterator.hasNext()) {
          throwIfCacheDirectoryTraversalCancelled(generation, deadlineNanos)
          if (visitedNodes >= CACHE_DIRECTORY_MAX_VISITED_NODES) {
            throw CacheDirectoryTraversalLimitException("visited_nodes")
          }

          val entryPath = iterator.next()
          throwIfCacheDirectoryTraversalCancelled(generation, deadlineNanos)
          visitedNodes += 1
          val entryName = entryPath.fileName?.toString() ?: continue

          if (node.depth == 0 && protectedRootNames.contains(entryName.lowercase())) {
            continue
          }

          if (Files.isSymbolicLink(entryPath)) {
            continue
          }

          val expectedPath = File(node.directory, entryName).absolutePath
          val canonicalEntry = entryPath.toFile().canonicalFile
          val canonicalPath = canonicalEntry.path
          if (expectedPath != canonicalPath || !canonicalPath.startsWith(rootPrefix)) {
            continue
          }

          val attributes = Files.readAttributes(
            entryPath,
            BasicFileAttributes::class.java,
            LinkOption.NOFOLLOW_LINKS
          )
          if (attributes.isDirectory) {
            val childDepth = node.depth + 1
            if (childDepth > CACHE_DIRECTORY_MAX_DEPTH) {
              throw CacheDirectoryTraversalLimitException("depth")
            }
            if (seenDirectoryPaths.add(canonicalPath)) {
              pendingDirectories.add(CacheDirectoryNode(canonicalEntry, childDepth))
            }
          } else if (attributes.isRegularFile) {
            totalBytes = addCacheEntryBytes(totalBytes, attributes.size())
          }
        }
      }
    }

    throwIfCacheDirectoryTraversalCancelled(generation, deadlineNanos)
    return totalBytes
  }

  @ReactMethod
  fun invalidateCacheDirectorySizeMeasurement() {
    cacheDirectorySizeGeneration.incrementAndGet()
    activeCacheDirectorySizeThread.get()?.interrupt()
  }

  @ReactMethod
  fun getCacheDirectorySize(promise: Promise) {
    val generation = cacheDirectorySizeGeneration.get()
    try {
      storageMetricsExecutor.execute {
        val workerThread = Thread.currentThread()
        activeCacheDirectorySizeThread.set(workerThread)
        try {
          val cacheBytes = readClearableCacheDirectorySizeBytes(
            reactApplicationContext.cacheDir,
            generation
          )
          promise.resolve(cacheBytes.toDouble())
        } catch (_: CacheDirectoryTraversalCancelledException) {
          Thread.interrupted()
          promise.reject(
            "E_SYSTEM_METRICS_CANCELLED",
            "Android app cache size scan was cancelled"
          )
        } catch (error: CacheDirectoryTraversalLimitException) {
          promise.reject(
            "E_SYSTEM_METRICS_LIMIT",
            "Android app cache size scan exceeded bounded traversal limits",
            error
          )
        } catch (_: CacheDirectoryTraversalUnavailableException) {
          promise.reject(
            "E_SYSTEM_METRICS_UNAVAILABLE",
            "Bounded Android app cache scanning requires Android 8 or newer"
          )
        } catch (error: Exception) {
          promise.reject("E_SYSTEM_METRICS", "Failed to read Android app cache size", error)
        } finally {
          activeCacheDirectorySizeThread.compareAndSet(workerThread, null)
        }
      }
    } catch (error: RejectedExecutionException) {
      promise.reject(
        "E_SYSTEM_METRICS_BUSY",
        "Android app cache size scan is already running",
        error
      )
    }
  }

  @ReactMethod
  fun getMemorySnapshot(promise: Promise) {
    try {
      val activityManager = reactApplicationContext.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager?
      if (activityManager == null) {
        promise.reject("E_SYSTEM_METRICS", "ActivityManager is unavailable")
        return
      }

      val memoryInfo = ActivityManager.MemoryInfo()
      activityManager.getMemoryInfo(memoryInfo)

      val processMemoryInfo = activityManager.getProcessMemoryInfo(intArrayOf(android.os.Process.myPid()))
      val appPssBytes = processMemoryInfo.firstOrNull()?.totalPss?.toLong()?.times(1024L)?.coerceAtLeast(0L) ?: 0L
      val appResidentBytes = readProcessResidentBytes()
      val appUsedBytes = appResidentBytes.takeIf { it > 0L } ?: appPssBytes
      val totalBytes = memoryInfo.totalMem.coerceAtLeast(0L)
      val advertisedMemoryBytes = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        memoryInfo.advertisedMem.coerceAtLeast(0L)
      } else {
        0L
      }
      val availableBytes = memoryInfo.availMem.coerceAtLeast(0L)
      val freeBytes = readFreeMemoryBytes(memoryInfo)
      val usedBytes = (totalBytes - (freeBytes ?: availableBytes)).coerceAtLeast(0L)
      val pressureRatio = if (totalBytes > 0L) {
        availableBytes.toDouble() / totalBytes.toDouble()
      } else {
        Double.NaN
      }
      val hasPressureRatio = !pressureRatio.isNaN() && !pressureRatio.isInfinite()
      val pressureLevel = when {
        memoryInfo.lowMemory -> "critical"
        hasPressureRatio && pressureRatio <= 0.08 -> "critical"
        hasPressureRatio && pressureRatio <= 0.15 -> "warning"
        hasPressureRatio -> "normal"
        else -> "unknown"
      }

      val result = Arguments.createMap().apply {
        putDouble("timestampMs", System.currentTimeMillis().toDouble())
        putDouble("totalBytes", totalBytes.toDouble())
        if (advertisedMemoryBytes > 0L) {
          putDouble("advertisedMemoryBytes", advertisedMemoryBytes.toDouble())
        }
        putDouble("availableBytes", availableBytes.toDouble())
        if (freeBytes != null) {
          putDouble("freeBytes", freeBytes.toDouble())
        }
        putDouble("usedBytes", usedBytes.toDouble())
        putDouble("appUsedBytes", appUsedBytes.toDouble())
        putDouble("appResidentBytes", appResidentBytes.toDouble())
        putDouble("appPssBytes", appPssBytes.toDouble())
        putBoolean("lowMemory", memoryInfo.lowMemory)
        putString("pressureLevel", pressureLevel)
        putDouble("thresholdBytes", memoryInfo.threshold.coerceAtLeast(0L).toDouble())
      }

      promise.resolve(result)
    } catch (error: Exception) {
      promise.reject("E_SYSTEM_METRICS", "Failed to read Android system memory metrics", error)
    }
  }

  override fun invalidate() {
    cacheDirectorySizeGeneration.incrementAndGet()
    activeCacheDirectorySizeThread.get()?.interrupt()
    storageMetricsExecutor.shutdownNow()
    super.invalidate()
  }
}
`;
}

function createSystemMetricsPackageSource(packageName) {
  return `package ${packageName}

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class ${SYSTEM_METRICS_PACKAGE_CLASS} : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(${SYSTEM_METRICS_MODULE_NAME}Module(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()
}
`;
}

function writeAndroidSystemMetricsFiles(projectRoot, packageName) {
  const packageDirectory = getPackageDirectory(projectRoot, packageName);
  fs.mkdirSync(packageDirectory, { recursive: true });

  fs.writeFileSync(
    path.join(packageDirectory, `${SYSTEM_METRICS_MODULE_NAME}Module.kt`),
    createSystemMetricsModuleSource(packageName),
  );
  fs.writeFileSync(
    path.join(packageDirectory, `${SYSTEM_METRICS_PACKAGE_CLASS}.kt`),
    createSystemMetricsPackageSource(packageName),
  );
}

function withAndroidSystemMetricsSourceFiles(config) {
  return withDangerousMod(config, [
    'android',
    async (nextConfig) => {
      if (nextConfig.modRequest.introspect) {
        return nextConfig;
      }

      writeAndroidSystemMetricsFiles(
        nextConfig.modRequest.projectRoot,
        getPackageName(nextConfig),
      );
      return nextConfig;
    },
  ]);
}

function withAndroidSystemMetricsMainApplication(config) {
  return withMainApplication(config, (nextConfig) => {
    if (nextConfig.modResults.language !== 'kt') {
      throw new Error('withAndroidSystemMetrics currently supports Kotlin MainApplication files only.');
    }

    if (nextConfig.modResults.contents.includes(SYSTEM_METRICS_REGISTRATION)) {
      return nextConfig;
    }

    nextConfig.modResults.contents = mergeContents({
      src: nextConfig.modResults.contents,
      newSrc: SYSTEM_METRICS_REGISTRATION,
      tag: 'pocket-ai-system-metrics-package',
      anchor: /PackageList\(this\)\.packages\.apply \{/,
      offset: 1,
      comment: '//',
    }).contents;
    return nextConfig;
  });
}

function withAndroidSystemMetrics(config) {
  config = withAndroidSystemMetricsSourceFiles(config);
  config = withAndroidSystemMetricsMainApplication(config);
  return config;
}

withAndroidSystemMetrics._internal = {
  createSystemMetricsModuleSource,
  createSystemMetricsPackageSource,
};

module.exports = withAndroidSystemMetrics;
