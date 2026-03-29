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

class ${SYSTEM_METRICS_MODULE_NAME}Module(
  reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {

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
      val totalBytes = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE
        && memoryInfo.advertisedMem > 0L
      ) {
        memoryInfo.advertisedMem.coerceAtLeast(0L)
      } else {
        memoryInfo.totalMem.coerceAtLeast(0L)
      }
      val availableBytes = memoryInfo.availMem.coerceAtLeast(0L)
      val usedBytes = (totalBytes - availableBytes).coerceAtLeast(0L)

      val result = Arguments.createMap().apply {
        putDouble("totalBytes", totalBytes.toDouble())
        putDouble("availableBytes", availableBytes.toDouble())
        putDouble("usedBytes", usedBytes.toDouble())
        putDouble("appUsedBytes", appUsedBytes.toDouble())
        putDouble("appResidentBytes", appResidentBytes.toDouble())
        putDouble("appPssBytes", appPssBytes.toDouble())
        putBoolean("lowMemory", memoryInfo.lowMemory)
        putDouble("thresholdBytes", memoryInfo.threshold.coerceAtLeast(0L).toDouble())
      }

      promise.resolve(result)
    } catch (error: Exception) {
      promise.reject("E_SYSTEM_METRICS", "Failed to read Android system memory metrics", error)
    }
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

module.exports = function withAndroidSystemMetrics(config) {
  config = withAndroidSystemMetricsSourceFiles(config);
  config = withAndroidSystemMetricsMainApplication(config);
  return config;
};
