const fs = require('fs');
const path = require('path');
const { withDangerousMod, withMainApplication } = require('expo/config-plugins');
const { mergeContents } = require('@expo/config-plugins/build/utils/generateCode');

const GPU_INFO_MODULE_NAME = 'GpuInfo';
const GPU_INFO_PACKAGE_CLASS = 'GpuInfoPackage';
const GPU_INFO_REGISTRATION_APPLY = `              add(${GPU_INFO_PACKAGE_CLASS}())`;
const GPU_INFO_REGISTRATION_PACKAGES = `      packages.add(${GPU_INFO_PACKAGE_CLASS}())`;
const GPU_INFO_MERGE_TAG = 'pocket-ai-gpu-info-package';

function getPackageName(config) {
  return config.android?.package ?? 'com.github.tah10n.pocketai';
}

function getPackageDirectory(projectRoot, packageName) {
  return path.join(projectRoot, 'android', 'app', 'src', 'main', 'java', ...packageName.split('.'));
}

function createGpuInfoModuleSource(packageName) {
  return `package ${packageName}

import android.opengl.EGL14
import android.opengl.EGLConfig
import android.opengl.GLES20
import android.os.Build
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class ${GPU_INFO_MODULE_NAME}Module(
  reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "${GPU_INFO_MODULE_NAME}"

  private data class GlStrings(
    val renderer: String?,
    val vendor: String?,
    val version: String?,
  )

  private fun readGlStrings(): GlStrings? {
    var display = EGL14.EGL_NO_DISPLAY
    var surface = EGL14.EGL_NO_SURFACE
    var context = EGL14.EGL_NO_CONTEXT

    return try {
      display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
      if (display == EGL14.EGL_NO_DISPLAY) {
        return null
      }

      val version = IntArray(2)
      if (!EGL14.eglInitialize(display, version, 0, version, 1)) {
        return null
      }

      EGL14.eglBindAPI(EGL14.EGL_OPENGL_ES_API)

      val configAttribs = intArrayOf(
        EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
        EGL14.EGL_SURFACE_TYPE, EGL14.EGL_PBUFFER_BIT,
        EGL14.EGL_RED_SIZE, 8,
        EGL14.EGL_GREEN_SIZE, 8,
        EGL14.EGL_BLUE_SIZE, 8,
        EGL14.EGL_ALPHA_SIZE, 8,
        EGL14.EGL_NONE
      )

      val configs = arrayOfNulls<EGLConfig>(1)
      val numConfigs = IntArray(1)
      if (!EGL14.eglChooseConfig(display, configAttribs, 0, configs, 0, configs.size, numConfigs, 0)) {
        return null
      }
      val config = configs[0] ?: return null

      val surfaceAttribs = intArrayOf(
        EGL14.EGL_WIDTH, 1,
        EGL14.EGL_HEIGHT, 1,
        EGL14.EGL_NONE
      )

      surface = EGL14.eglCreatePbufferSurface(display, config, surfaceAttribs, 0)
      if (surface == EGL14.EGL_NO_SURFACE) {
        return null
      }

      val contextAttribs = intArrayOf(
        EGL14.EGL_CONTEXT_CLIENT_VERSION, 2,
        EGL14.EGL_NONE
      )

      context = EGL14.eglCreateContext(display, config, EGL14.EGL_NO_CONTEXT, contextAttribs, 0)
      if (context == EGL14.EGL_NO_CONTEXT) {
        return null
      }

      if (!EGL14.eglMakeCurrent(display, surface, surface, context)) {
        return null
      }

      GlStrings(
        renderer = GLES20.glGetString(GLES20.GL_RENDERER),
        vendor = GLES20.glGetString(GLES20.GL_VENDOR),
        version = GLES20.glGetString(GLES20.GL_VERSION),
      )
    } catch (_: Exception) {
      null
    } finally {
      try {
        if (display != EGL14.EGL_NO_DISPLAY) {
          EGL14.eglMakeCurrent(display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT)
        }
      } catch (_: Exception) {}

      try {
        if (display != EGL14.EGL_NO_DISPLAY && context != EGL14.EGL_NO_CONTEXT) {
          EGL14.eglDestroyContext(display, context)
        }
      } catch (_: Exception) {}

      try {
        if (display != EGL14.EGL_NO_DISPLAY && surface != EGL14.EGL_NO_SURFACE) {
          EGL14.eglDestroySurface(display, surface)
        }
      } catch (_: Exception) {}

      try {
        if (display != EGL14.EGL_NO_DISPLAY) {
          EGL14.eglTerminate(display)
        }
      } catch (_: Exception) {}
    }
  }

  @ReactMethod
  fun getGpuInfo(promise: Promise) {
    try {
      val glStrings = readGlStrings()

      val result = Arguments.createMap().apply {
        putString("glRenderer", glStrings?.renderer)
        putString("glVendor", glStrings?.vendor)
        putString("glVersion", glStrings?.version)
        putString("board", Build.BOARD)
        putString("hardware", Build.HARDWARE)
        putString("device", Build.DEVICE)
        putString("product", Build.PRODUCT)
        putString("brand", Build.BRAND)
        putString("model", Build.MODEL)
        putString("manufacturer", Build.MANUFACTURER)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
          putString("socModel", Build.SOC_MODEL)
          putString("socManufacturer", Build.SOC_MANUFACTURER)
        }
      }

      promise.resolve(result)
    } catch (error: Exception) {
      promise.reject("E_GPU_INFO", "Failed to read Android GPU info", error)
    }
  }
}
`;
}

function createGpuInfoPackageSource(packageName) {
  return `package ${packageName}

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class ${GPU_INFO_PACKAGE_CLASS} : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(${GPU_INFO_MODULE_NAME}Module(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()
}
`;
}

function writeAndroidGpuInfoFiles(projectRoot, packageName) {
  const packageDirectory = getPackageDirectory(projectRoot, packageName);
  fs.mkdirSync(packageDirectory, { recursive: true });

  fs.writeFileSync(
    path.join(packageDirectory, `${GPU_INFO_MODULE_NAME}Module.kt`),
    createGpuInfoModuleSource(packageName),
  );
  fs.writeFileSync(
    path.join(packageDirectory, `${GPU_INFO_PACKAGE_CLASS}.kt`),
    createGpuInfoPackageSource(packageName),
  );
}

function withAndroidGpuInfoSourceFiles(config) {
  return withDangerousMod(config, [
    'android',
    async (nextConfig) => {
      if (nextConfig.modRequest.introspect) {
        return nextConfig;
      }

      writeAndroidGpuInfoFiles(
        nextConfig.modRequest.projectRoot,
        getPackageName(nextConfig),
      );
      return nextConfig;
    },
  ]);
}

function withAndroidGpuInfoMainApplication(config) {
  return withMainApplication(config, (nextConfig) => {
    if (nextConfig.modResults.language !== 'kt') {
      throw new Error('withAndroidGpuInfo currently supports Kotlin MainApplication files only.');
    }

    // Prefer tag-based idempotency: inserted source may be formatted differently.
    if (nextConfig.modResults.contents.includes(GPU_INFO_MERGE_TAG)) {
      return nextConfig;
    }

    const attempts = [
      {
        label: 'packages.apply',
        anchor: /PackageList\(this\)\.packages\.apply\s*\{/, // RN/Expo Kotlin template
        newSrc: GPU_INFO_REGISTRATION_APPLY,
        offset: 1,
      },
      {
        label: 'val packages = PackageList(this).packages',
        anchor: /val\s+packages\s*=\s*PackageList\(this\)\.packages\b/, // Alternative template
        newSrc: GPU_INFO_REGISTRATION_PACKAGES,
        offset: 1,
      },
    ];

    let mergeResult = null;
    for (const attempt of attempts) {
      mergeResult = mergeContents({
        src: nextConfig.modResults.contents,
        newSrc: attempt.newSrc,
        tag: GPU_INFO_MERGE_TAG,
        anchor: attempt.anchor,
        offset: attempt.offset,
        comment: '//',
      });

      if (mergeResult.didMerge) {
        break;
      }
    }

    if (!mergeResult || !mergeResult.didMerge) {
      const packageListLines = nextConfig.modResults.contents
        .split(/\r?\n/)
        .map((line, index) => ({ line, index: index + 1 }))
        .filter(({ line }) => line.includes('PackageList') || line.includes('getPackages') || line.includes('.packages'))
        .slice(0, 12)
        .map(({ line, index }) => `${index}: ${line}`)
        .join('\n');

      console.warn('[withAndroidGpuInfo] Failed to register GpuInfoPackage (anchor not found).');
      console.warn('[withAndroidGpuInfo] Attempted anchors: ' + attempts.map((a) => a.label).join(', '));
      if (packageListLines) {
        console.warn('[withAndroidGpuInfo] MainApplication.kt relevant lines:\n' + packageListLines);
      }
      throw new Error('withAndroidGpuInfo failed to register GpuInfoPackage (anchor not found). See logs for context.');
    }

    nextConfig.modResults.contents = mergeResult.contents;
    return nextConfig;
  });
}

module.exports = function withAndroidGpuInfo(config) {
  config = withAndroidGpuInfoSourceFiles(config);
  config = withAndroidGpuInfoMainApplication(config);
  return config;
};
