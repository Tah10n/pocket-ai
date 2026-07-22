#!/usr/bin/env node

const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const {
  ANDROID_PROVENANCE_GRADLE_EXECUTION_ARGS,
  ANDROID_REQUIRED_NATIVE_LIBRARIES_BY_ABI,
  ANDROID_UNIVERSAL_ABIS,
  BUILD_PROVENANCE_SCHEMA_VERSION,
  assertAndroidBuildOverrideContract,
  buildAndroidCleanPrebuildArgs,
  collectAndroidNativeProjectState,
  collectAndroidEffectiveBuildContext,
  collectBuildProvenance,
  collectPrebuildInputState,
  createIsolatedAndroidBuildEnvironment,
  createFileContentFingerprint,
  listZipEntries,
  resolveBuildStampPath,
  resolveAndroidGradleWrapperInvocation,
  resolveExpoCliInvocation,
  resolvePrebuildStampPaths,
  shouldRunPrebuild,
  withAndroidProvenanceGradleExecutionArgs,
} = require("./android-build-provenance");
const { sanitizeAndroidQaText } = require("./android-qa-sanitization");
const { isCompletePngBuffer } = require("./png-validation");

const cliOptions = require.main === module ? parseCliOptions(process.argv.slice(2)) : {};
const projectRoot = path.resolve(__dirname, "..");
const artifactsRoot = path.join(projectRoot, "artifacts", "android-scenarios");
const androidRoot = path.join(projectRoot, "android");
const apkVariant = parseApkVariant(cliOptions.apkVariant ?? process.env.ANDROID_SMOKE_APK_VARIANT ?? "debug");
const shouldUseEmbeddedBundle = apkVariant === "release" || process.env.ANDROID_SMOKE_SKIP_METRO === "1";
const androidBuildNodeEnv = process.env.NODE_ENV
  || (apkVariant === "release" ? "production" : "development");
const androidBuildEnvironment = createIsolatedAndroidBuildEnvironment(
  projectRoot,
  process.env,
  {
    NODE_ENV: androidBuildNodeEnv,
    ...(apkVariant === "release"
      ? {
          POCKET_AI_ALLOW_DEBUG_RELEASE_SIGNING:
            process.env.POCKET_AI_ALLOW_DEBUG_RELEASE_SIGNING || "true",
        }
      : {}),
  }
);
const localPropertiesPath = path.join(androidRoot, "local.properties");
const appConfigPath = path.join(projectRoot, "app.json");
const packageJsonPath = path.join(projectRoot, "package.json");
const packageLockPath = path.join(projectRoot, "package-lock.json");
const npmShrinkwrapPath = path.join(projectRoot, "npm-shrinkwrap.json");
const patchesRoot = path.join(projectRoot, "patches");
const appConfigJsPath = path.join(projectRoot, "app.config.js");
const appConfigTsPath = path.join(projectRoot, "app.config.ts");
const gradleWrapperPath = path.join(
  androidRoot,
  process.platform === "win32" ? "gradlew.bat" : "gradlew"
);
const apkPath = path.join(
  androidRoot,
  "app",
  "build",
  "outputs",
  "apk",
  apkVariant,
  `app-${apkVariant}.apk`
);
const supportedAndroidTargetAbis = Object.freeze([
  "universal",
  "arm64-v8a",
  "x86_64",
]);
const cacheRoot = path.join(projectRoot, "node_modules", ".cache", "pocket-ai-android");
const buildTargetAbi = parseTargetAbi(
  cliOptions.targetAbi ?? process.env.ANDROID_SMOKE_TARGET_ABI ?? "universal"
);
const buildStampPath = resolveBuildStampPath(cacheRoot, apkVariant, buildTargetAbi);
const {
  activeStampPath: activePrebuildStampPath,
  variantStampPath: prebuildStampPath,
} = resolvePrebuildStampPaths(cacheRoot, apkVariant);
const qaProvenanceReportPath = path.join(artifactsRoot, "build-provenance-latest.json");
const metroStartupTimeoutMs = 90_000;
const metroBundleTimeoutMs = 120_000;
const deviceStartupTimeoutMs = 180_000;
const screenshotAdbCommandTimeoutMs = 15_000;
const appJsReadyTimeoutMs = 60_000;
const appJsReadyPollIntervalMs = 1_000;
const uiHierarchyCommandTimeoutMs = 5_000;
const metroTreeTerminationTimeoutMs = 10_000;
const metroGracefulTerminationTimeoutMs = 2_000;
const windowsJobOwnershipBoundary = "windows-job";
const posixProcessGroupOwnershipBoundary = "posix-process-group";
const launchDelayMs = parsePositiveInteger(
  cliOptions.launchDelayMs ?? process.env.ANDROID_SMOKE_LAUNCH_DELAY_MS ?? "4000",
  "launch delay"
);
const preferredPort = parsePositiveInteger(
  cliOptions.port ?? process.env.ANDROID_SMOKE_PORT ?? "8081",
  "Metro port"
);
const defaultDeviceMetroPort = 8081;
const screenshotTarget =
  cliOptions.screenshot ?? process.env.ANDROID_SMOKE_SCREENSHOT ?? null;
const screenshotPath = screenshotTarget
  ? path.resolve(projectRoot, screenshotTarget)
  : null;

if (require.main === module) {
  main().catch((error) => {
    console.error(`[android-smoke] ${error.message}`);
    if (!process.exitCode) {
      process.exitCode = 1;
    }
  });
}

async function main() {
  assertSmokeBuildOverrideContract();
  const requestedSerial = cliOptions.serial || process.env.ANDROID_SERIAL || null;
  const requestedAvd = cliOptions.avd || process.env.ANDROID_AVD || null;
  const forceEmulator =
    cliOptions.emulator || process.env.ANDROID_EMULATOR_ONLY === "1";

  if (forceEmulator && requestedSerial && !isEmulatorSerial(requestedSerial)) {
    throw new Error(
      "The requested serial is not an emulator. Remove --serial or pass an emulator serial when using --emulator."
    );
  }

  const tools = resolveAndroidTools();
  const appConfig = readExpoConfig();
  const appPackage = appConfig.packageName;
  const appScheme = appConfig.scheme || "app";

  if (!appPackage) {
    throw new Error("Could not resolve expo.android.package from app.json.");
  }

  log("Starting adb server...");
  runChecked(tools.adb, ["start-server"], { stdio: "ignore" });

  let device = pickConnectedDevice(tools.adb, {
    requestedSerial,
    forceEmulator,
  });

  if (!device) {
    if (forceEmulator) {
      device = await startEmulatorAndWait(tools, {
        requestedSerial,
        requestedAvd,
      });
    } else if (cliOptions.autoTarget && !requestedSerial) {
      device = pickConnectedDevice(tools.adb, {
        requestedSerial: null,
        forceEmulator: true,
      });
      if (!device) {
        log("No Android phone is connected; falling back to an emulator.");
        device = await startEmulatorAndWait(tools, {
          requestedSerial: null,
          requestedAvd,
        });
      }
    } else {
      throw new Error("Connect a phone and try again. No physical Android device is connected.");
    }
  }

  log(`Using Android target ${device.serial}${device.model ? ` (${device.model})` : ""}.`);
  wakeAndUnlockDevice(tools.adb, device.serial);

  const wantsSkipBuild = cliOptions.skipBuild || process.env.ANDROID_SKIP_BUILD === "1";
  let didBuildAndroidApk = false;
  const verifiedPrebuildInputState = ensureAndroidNativeProject();
  const buildInputState = collectNativeBuildInputState(verifiedPrebuildInputState.digest);
  const buildReuse = resolveBuildReuseState(tools.adb, device.serial, buildInputState);
  if (buildReuse.canReuse) {
    const abiLabel = buildReuse.reuseDecision.matchedAbi
      ? ` for ABI ${buildReuse.reuseDecision.matchedAbi}`
      : "";
    const prefix = wantsSkipBuild
      ? "Skipping Gradle build"
      : `Reusing the existing ${apkVariant} APK`;
    log(`${prefix}${abiLabel} (${buildReuse.reason}).`);
  } else {
    const prefix = wantsSkipBuild
      ? `Requested --skip-build, but the existing ${apkVariant} APK cannot be reused`
      : `Building a fresh Android ${apkVariant} APK`;
    log(`${prefix} (${buildReuse.reason}).`);
    buildAndroidApk();
    didBuildAndroidApk = true;
    const postBuildInputState = collectNativeBuildInputState(verifiedPrebuildInputState.digest);
    if (postBuildInputState.digest !== buildInputState.digest) {
      throw new Error(
        "Android build inputs changed while Gradle was running; refusing to stamp an ambiguous APK. Retry from a stable worktree."
      );
    }
    const postBuildReuseDecision = resolveDebugApkReuseDecision(tools.adb, device.serial, apkPath);
    if (!postBuildReuseDecision.canReuse) {
      throw new Error(
        `The freshly built ${apkVariant} APK does not satisfy the requested ABI contract `
          + `(${postBuildReuseDecision.reason || "unknown incompatibility"}). `
          + `Packaged ABIs: ${postBuildReuseDecision.packagedAbis.join(", ") || "none"}. `
          + `Supported device ABIs: ${postBuildReuseDecision.supportedAbis.join(", ") || "unknown"}.`
      );
    }
    writeBuildStamp(
      postBuildInputState,
      createFileFingerprint(apkPath),
      postBuildReuseDecision
    );
  }

  const readyInputState = collectNativeBuildInputState(verifiedPrebuildInputState.digest);
  if (readyInputState.digest !== buildInputState.digest) {
    throw new Error(
      "Android inputs changed after APK selection; refusing to install an artifact with ambiguous provenance."
    );
  }

  if (!fs.existsSync(apkPath)) {
    throw new Error(`Expected Android ${apkVariant} APK at ${apkPath}, but it was not found.`);
  }

  let metro = null;
  let removeMetroSignalHandlers = () => {};
  let didTransferMetroOwnership = false;
  let mainError = null;
  try {
    metro = shouldUseEmbeddedBundle
      ? null
      : await ensureMetroServer({
          foreground: cliOptions.keepMetroForeground,
          clearCache: cliOptions.clearMetroCache,
        });
    if (metro?.lifecycle) {
      removeMetroSignalHandlers = metro.removeSignalHandlers
        ?? installOwnedMetroSignalHandlers(metro.lifecycle);
    }
    if (metro) {
      await prewarmMetroBundle(metro.port, appPackage);
    } else {
      log(`Using embedded JS bundle from the ${apkVariant} APK; Metro startup is not required.`);
    }

    const installResult = installDebugApk(tools.adb, device.serial, appPackage, {
      allowReuseExistingInstallOnLowStorage: !didBuildAndroidApk,
      didBuildDebugApk: didBuildAndroidApk,
      buildInputState,
    });
    const installedInputState = collectNativeBuildInputState(verifiedPrebuildInputState.digest);
    if (installedInputState.digest !== buildInputState.digest) {
      throw new Error(
        "Android inputs changed during install; refusing to publish stale QA provenance."
      );
    }
    writeQaProvenanceReport({
      adbPath: tools.adb,
      serial: device.serial,
      appPackage,
      buildInputState,
      installResult,
    });
    if (metro) {
      reverseMetroPort(tools.adb, device.serial, metro.port);
    }

    if (metro) {
      launchDevClient(tools.adb, device.serial, appPackage, appScheme, metro.port);
    } else {
      launchInstalledApp(tools.adb, device.serial, appPackage);
    }
    await waitForAppJsReady(tools.adb, device.serial, appPackage, {
      lifecycle: metro?.lifecycle,
    });

    if (screenshotPath) {
      await delay(launchDelayMs);
      wakeAndUnlockDevice(tools.adb, device.serial);
      saveScreenshot(tools.adb, device.serial, screenshotPath);

      const logcatPath = path.join(path.dirname(screenshotPath), "bootstrap-logcat.txt");
      saveLogcat(tools.adb, device.serial, logcatPath, { packageName: appPackage });
    }

    log(
      metro
        ? `Android smoke check finished on ${device.serial} using Metro port ${metro.port}.`
        : `Android smoke check finished on ${device.serial} using the embedded ${apkVariant} APK bundle.`
    );
    if (metro) {
      log(
        metro.started
          ? cliOptions.keepMetroForeground
            ? `Started an attached Metro on port ${metro.port}.`
            : `Started a temporary Metro on port ${metro.port}; it will stop with this smoke run.`
          : `Reused an existing Metro server on port ${metro.port}.`
      );
    }

    if (screenshotPath) {
      log("Saved Android bootstrap screenshot.");
    }

    if (metro?.started && cliOptions.transferMetroOwnership) {
      const ownershipPath = path.resolve(projectRoot, cliOptions.transferMetroOwnership);
      const temporaryOwnershipPath = `${ownershipPath}.tmp-${process.pid}`;
      const metroProcessId = metro.lifecycle.process.pid;
      const ownershipSnapshot = captureOwnedProcessOwnership(metroProcessId, {
        ownershipBoundary: metro.lifecycle.process.pocketAiOwnershipBoundary,
      });
      if (!ownershipSnapshot) {
        throw new Error(`Could not capture the owned Metro process identity for PID ${metroProcessId}.`);
      }
      metro.lifecycle.setOwnershipSnapshot(ownershipSnapshot);
      fs.mkdirSync(path.dirname(ownershipPath), { recursive: true });
      try {
        fs.writeFileSync(temporaryOwnershipPath, JSON.stringify({
          pid: metroProcessId,
          port: metro.port,
          ...ownershipSnapshot,
        }));
        fs.renameSync(temporaryOwnershipPath, ownershipPath);
        didTransferMetroOwnership = true;
      } finally {
        fs.rmSync(temporaryOwnershipPath, { force: true });
      }
      log("Transferred temporary Metro ownership metadata.");
    }

    if (metro?.started && cliOptions.keepMetroForeground) {
      log('Metro remains attached for development. Press Ctrl+C to stop it.');
      await waitForAttachedMetroExit(metro.lifecycle);
    }
  } catch (error) {
    mainError = error;
    throw error;
  } finally {
    removeMetroSignalHandlers();
    if (!didTransferMetroOwnership && metro?.lifecycle) {
      try {
        stopOwnedMetroProcessOrThrow(metro.lifecycle);
      } catch (cleanupError) {
        if (!mainError) {
          throw cleanupError;
        }
        console.error(`[android-smoke] ${cleanupError.message}`);
        if (!process.exitCode) {
          process.exitCode = 1;
        }
      }
    }
  }
}

function resolveAndroidTools() {
  const sdkRoots = getSdkRoots();
  const adbName = process.platform === "win32" ? "adb.exe" : "adb";
  const emulatorName =
    process.platform === "win32" ? "emulator.exe" : "emulator";

  let adbPath = null;
  let emulatorPath = null;

  for (const sdkRoot of sdkRoots) {
    const adbCandidate = path.join(sdkRoot, "platform-tools", adbName);
    const emulatorCandidate = path.join(sdkRoot, "emulator", emulatorName);

    if (!adbPath && fs.existsSync(adbCandidate)) {
      adbPath = adbCandidate;
    }

    if (!emulatorPath && fs.existsSync(emulatorCandidate)) {
      emulatorPath = emulatorCandidate;
    }
  }

  if (!adbPath) {
    throw new Error(
      "Android SDK platform-tools were not found. Set ANDROID_HOME or ANDROID_SDK_ROOT."
    );
  }

  return {
    adb: adbPath,
    emulator: emulatorPath,
  };
}

function getSdkRoots() {
  const roots = [];
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    readSdkDirFromLocalProperties(),
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Android", "Sdk")
      : null,
    (process.env.HOME || process.env.USERPROFILE)
      ? path.join(process.env.HOME || process.env.USERPROFILE, "Android", "Sdk")
      : null,
  ];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    const normalized = path.resolve(candidate);
    if (!roots.includes(normalized) && fs.existsSync(normalized)) {
      roots.push(normalized);
    }
  }

  return roots;
}

function readSdkDirFromLocalProperties() {
  if (!fs.existsSync(localPropertiesPath)) {
    return null;
  }

  const content = fs.readFileSync(localPropertiesPath, "utf8");
  const match = content.match(/^sdk\.dir=(.+)$/m);
  if (!match) {
    return null;
  }

  return match[1].trim().replace(/\\/g, "/");
}

function readExpoConfig() {
  const raw = fs.readFileSync(appConfigPath, "utf8");
  const config = JSON.parse(raw);
  const expo = config.expo || {};

  return {
    scheme: expo.scheme,
    packageName: expo.android && expo.android.package,
  };
}

function collectNativeBuildInputState(verifiedPrebuildInputDigest = null) {
  const currentPrebuildInputState = collectPrebuildInputState(projectRoot, {
    variant: apkVariant,
    nodeEnv: androidBuildNodeEnv,
    env: androidBuildEnvironment,
  });
  if (
    verifiedPrebuildInputDigest
    && currentPrebuildInputState.digest !== verifiedPrebuildInputDigest
  ) {
    throw new Error(
      "Expo/config-plugin inputs changed after native prebuild verification; retry the Android run."
    );
  }
  const assembleTask = `app:assemble${apkVariant[0].toUpperCase()}${apkVariant.slice(1)}`;
  const gradleArgs = buildGradleAssembleArgs(assembleTask, buildTargetAbi);
  assertSmokeBuildOverrideContract(gradleArgs);
  return collectBuildProvenance(projectRoot, {
    variant: apkVariant,
    abi: buildTargetAbi,
    includeBundleInputs: shouldUseEmbeddedBundle,
    androidRoot,
    env: androidBuildEnvironment,
    gradleArgs,
    buildContext: {
      androidQaEvidence: process.env.EXPO_PUBLIC_ANDROID_QA === "1",
      effectiveBuild: collectAndroidEffectiveBuildContext(projectRoot, {
        variant: apkVariant,
        gradleArgs,
        env: androidBuildEnvironment,
      }),
      prebuildInputDigest: currentPrebuildInputState.digest,
    },
  });
}

function resolveBuildReuseState(adbPath, serial, buildInputState) {
  const apkExists = fs.existsSync(apkPath);
  const apkFingerprint = apkExists ? createFileFingerprint(apkPath) : null;
  const reuseDecision = apkExists
    ? resolveDebugApkReuseDecision(adbPath, serial, apkPath)
    : {
      canReuse: false,
      matchedAbi: null,
      packagedAbis: [],
      supportedAbis: [],
      missingEntries: [],
      reason: "APK is missing",
    };
  const buildStamp = readJsonFile(buildStampPath);
  const fingerprintMatches = Boolean(
    buildStamp
      && apkFingerprint
      && buildStamp.schemaVersion === BUILD_PROVENANCE_SCHEMA_VERSION
      && buildStamp.variant === apkVariant
      && buildStamp.abi === buildTargetAbi
      && buildStamp.provenanceDigest === buildInputState.digest
      && buildStamp.apk?.sha256 === apkFingerprint.sha256
      && buildStamp.apk?.size === apkFingerprint.size
      && areStringArraysEqual(buildStamp.apk?.packagedAbis, reuseDecision.packagedAbis)
      && buildStamp.apk?.matchedAbi === reuseDecision.matchedAbi
  );

  return {
    ...evaluateApkReuse({
      apkExists,
      abiCompatible: reuseDecision.canReuse,
      fingerprintMatches,
      variant: apkVariant,
    }),
    apkFingerprint,
    reuseDecision,
  };
}

function evaluateApkReuse({ apkExists, abiCompatible, fingerprintMatches, variant = "debug" }) {
  if (!apkExists) {
    return {
      canReuse: false,
      reason: `${variant} APK is missing`,
    };
  }

  if (!abiCompatible) {
    return {
      canReuse: false,
      reason: `the existing ${variant} APK is incompatible with the target device ABI`,
    };
  }

  if (fingerprintMatches) {
    return {
      canReuse: true,
      reason: "the content-hash build provenance matches the current APK",
    };
  }

  return {
    canReuse: false,
    reason: "the APK is missing current content-hash build provenance",
  };
}

function createFileFingerprint(filePath) {
  return createFileContentFingerprint(filePath, projectRoot);
}

function writeBuildStamp(buildInputState, apkFingerprint, abiDecision) {
  writeJsonFile(buildStampPath, {
    schemaVersion: BUILD_PROVENANCE_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    variant: apkVariant,
    abi: buildTargetAbi,
    provenanceDigest: buildInputState.digest,
    provenance: buildInputState,
    apk: {
      path: apkFingerprint.path,
      size: apkFingerprint.size,
      sha256: apkFingerprint.sha256,
      packagedAbis: abiDecision.packagedAbis,
      matchedAbi: abiDecision.matchedAbi,
    },
  });
}

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    const errorCode = typeof error?.code === "string" ? error.code : "invalid_json";
    log(`Ignoring unreadable Android QA cache JSON (${errorCode}).`);
    return null;
  }
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2));
  fs.renameSync(temporaryPath, filePath);
}

function toProjectRelativePath(filePath) {
  return normalizePath(path.relative(projectRoot, filePath));
}

function normalizePath(value) {
  return `${value}`.replace(/\\/g, "/");
}

function resolveDebugApkReuseDecision(adbPath, serial, apkFilePath) {
  try {
    const primaryAbi = resolvePrimaryDeviceAbi(adbPath, serial);
    const supportedAbis = resolveDeviceSupportedAbis(adbPath, serial, primaryAbi);
    return evaluateApkAbiCompatibility({
      targetAbi: buildTargetAbi,
      deviceAbis: supportedAbis,
      zipEntries: listZipEntries(apkFilePath),
      requiredLibraries: ANDROID_REQUIRED_NATIVE_LIBRARIES_BY_ABI,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(
      `Failed to inspect the existing ${apkVariant} APK for ABI compatibility (${message}). `
        + "Rebuilding instead."
    );
    return {
      canReuse: false,
      matchedAbi: null,
      packagedAbis: [],
      supportedAbis: [],
      missingEntries: [],
      reason: `APK inspection failed: ${message}`,
    };
  }
}

function resolvePackagedAndroidAbis(zipEntries) {
  const packagedAbis = new Set();
  for (const entry of zipEntries || []) {
    const match = `${entry}`.replace(/\\/gu, "/").match(/^lib\/([^/]+)\//u);
    if (match) {
      packagedAbis.add(match[1]);
    }
  }
  return [...packagedAbis].sort();
}

function evaluateApkAbiCompatibility({
  targetAbi,
  deviceAbis,
  zipEntries,
  requiredLibraries = ANDROID_REQUIRED_NATIVE_LIBRARIES_BY_ABI,
}) {
  const normalizedTargetAbi = parseTargetAbi(targetAbi);
  const supportedAbis = [...new Set((deviceAbis || []).map((abi) => `${abi}`.trim()).filter(Boolean))];
  const normalizedZipEntries = new Set((zipEntries || []).map((entry) => `${entry}`.replace(/\\/gu, "/")));
  const packagedAbis = resolvePackagedAndroidAbis(normalizedZipEntries);
  const result = {
    canReuse: false,
    matchedAbi: null,
    packagedAbis,
    supportedAbis,
    missingEntries: [],
    reason: null,
  };

  if (supportedAbis.length === 0) {
    return {
      ...result,
      reason: "the device did not report any supported ABI",
    };
  }

  if (normalizedTargetAbi !== "universal") {
    if (!supportedAbis.includes(normalizedTargetAbi)) {
      return {
        ...result,
        reason: `the device does not support requested ABI ${normalizedTargetAbi}`,
      };
    }
    if (!areStringArraysEqual(packagedAbis, [normalizedTargetAbi])) {
      return {
        ...result,
        reason: `the targeted APK must package exactly ${normalizedTargetAbi}`,
      };
    }
    const missingEntries = resolveRequiredNativeLibrariesForAbi(
      normalizedTargetAbi,
      requiredLibraries
    )
      .map((library) => `lib/${normalizedTargetAbi}/${library}`)
      .filter((entryName) => !normalizedZipEntries.has(entryName));
    if (missingEntries.length > 0) {
      return {
        ...result,
        missingEntries,
        reason: `the targeted APK is missing required native libraries for ${normalizedTargetAbi}`,
      };
    }
    return {
      ...result,
      canReuse: true,
      matchedAbi: normalizedTargetAbi,
      reason: `the APK packages exactly requested ABI ${normalizedTargetAbi}`,
    };
  }

  if (!areStringArraysEqual(packagedAbis, [...ANDROID_UNIVERSAL_ABIS].sort())) {
    return {
      ...result,
      reason: "the universal APK must package exactly the canonical Android ABI set",
    };
  }

  const missingUniversalEntries = ANDROID_UNIVERSAL_ABIS.flatMap((abi) => (
    resolveRequiredNativeLibrariesForAbi(abi, requiredLibraries)
      .map((library) => `lib/${abi}/${library}`)
      .filter((entryName) => !normalizedZipEntries.has(entryName))
  ));
  if (missingUniversalEntries.length > 0) {
    return {
      ...result,
      missingEntries: missingUniversalEntries,
      reason: "the universal APK is missing required native libraries for one or more canonical ABIs",
    };
  }

  for (const deviceAbi of supportedAbis) {
    if (!packagedAbis.includes(deviceAbi)) {
      continue;
    }
    return {
      ...result,
      canReuse: true,
      matchedAbi: deviceAbi,
      reason: `the universal APK packages the canonical ABI set and supports device ABI ${deviceAbi}`,
    };
  }

  return {
    ...result,
    reason: "the universal APK has no ABI compatible with the target device",
  };
}

function resolveRequiredNativeLibrariesForAbi(abi, requirements) {
  if (Array.isArray(requirements)) {
    return requirements;
  }
  const libraries = requirements?.[abi];
  if (!Array.isArray(libraries) || libraries.length === 0) {
    throw new Error(`Android APK verification has no required native-library contract for ABI ${abi}.`);
  }
  return libraries;
}

function areStringArraysEqual(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function resolvePrimaryDeviceAbi(adbPath, serial) {
  const primaryAbi = runCapture(
    adbPath,
    ["-s", serial, "shell", "getprop", "ro.product.cpu.abi"],
    { allowFailure: true }
  ).trim();

  return primaryAbi || null;
}

function resolveDeviceSupportedAbis(adbPath, serial, primaryAbi = null) {
  const abilist = runCapture(
    adbPath,
    ["-s", serial, "shell", "getprop", "ro.product.cpu.abilist"],
    { allowFailure: true }
  )
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (abilist.length > 0) {
    if (primaryAbi && !abilist.includes(primaryAbi)) {
      return [primaryAbi, ...abilist];
    }
    return abilist;
  }

  return primaryAbi ? [primaryAbi] : [];
}

function pickConnectedDevice(adbPath, options = {}) {
  const devices = listConnectedDevices(adbPath);

  if (options.requestedSerial) {
    const requestedDevice = devices.find(
      (device) => device.serial === options.requestedSerial
    );
    if (!requestedDevice) {
      throw new Error(
        `ANDROID_SERIAL=${options.requestedSerial} was requested but is not connected.`
      );
    }

    return requestedDevice;
  }

  if (options.forceEmulator) {
    return devices.find((device) => isEmulatorSerial(device.serial)) || null;
  }

  const physicalDevices = devices.filter(
    (device) => !isEmulatorSerial(device.serial)
  );

  if (physicalDevices.length === 0) {
    return null;
  }

  if (physicalDevices.length > 1) {
    log(
      `Multiple Android phones are connected; defaulting to ${physicalDevices[0].serial}. Set ANDROID_SERIAL to override.`
    );
  }

  return physicalDevices[0];
}

function listConnectedDevices(adbPath) {
  return listAdbDevices(adbPath);
}

function listAdbDevices(adbPath, options = {}) {
  const includeOffline = options.includeOffline === true;
  const output = runCapture(adbPath, ["devices", "-l"]);

  return output
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => parseAdbDeviceLine(line, { includeOffline }))
    .filter(Boolean);
}

function parseAdbDeviceLine(line, options = {}) {
  const match = line.match(/^(\S+)\s+(\S+)(?:\s+(.*))?$/);
  if (!match) {
    return null;
  }

  const [, serial, state, details = ""] = match;
  if (
    state !== "device" &&
    !(options.includeOffline === true && state === "offline")
  ) {
    return null;
  }

  const modelMatch = details.match(/model:(\S+)/);
  return {
    serial,
    state,
    model: modelMatch ? modelMatch[1] : null,
  };
}

async function startEmulatorAndWait(tools, options = {}) {
  const existingEmulator = listAdbDevices(tools.adb, { includeOffline: true }).find(
    (device) => isEmulatorSerial(device.serial)
  );

  if (!tools.emulator) {
    throw new Error(
      "No connected Android device was found and emulator.exe is unavailable."
    );
  }

  let serial = null;
  let avdName = null;

  if (existingEmulator) {
    serial = existingEmulator.serial;
    avdName = existingEmulator.model || "Android emulator";
    log(
      `Found existing emulator ${serial} (${existingEmulator.state}). Waiting for it to become ready...`
    );
    if (existingEmulator.state !== "device") {
      serial = await waitForAndroidDevice(
        tools.adb,
        deviceStartupTimeoutMs,
        (value) => value === existingEmulator.serial,
        { includeOffline: true }
      );
    }
  } else {
    avdName = resolveAvdName(tools.emulator, options.requestedAvd);
    log(`No suitable emulator is running. Starting ${avdName}...`);

    const emulatorProcess = spawn(tools.emulator, ["-avd", avdName], {
      detached: true,
      stdio: "ignore",
    });
    emulatorProcess.unref();

    serial = await waitForAndroidDevice(
      tools.adb,
      deviceStartupTimeoutMs,
      options.requestedSerial
        ? (value) => value === options.requestedSerial
        : isEmulatorSerial,
      { includeOffline: true }
    );
  }

  log(`Waiting for ${serial} to finish booting...`);
  await waitForBootCompletion(tools.adb, serial, deviceStartupTimeoutMs);

  runChecked(
    tools.adb,
    ["-s", serial, "shell", "input", "keyevent", "82"],
    { stdio: "ignore", allowFailure: true }
  );

  return (
    listConnectedDevices(tools.adb).find((device) => device.serial === serial) ||
    { serial, model: avdName }
  );
}

function resolveAvdName(emulatorPath, requestedAvd) {
  if (requestedAvd) {
    return requestedAvd;
  }

  const output = runCapture(emulatorPath, ["-list-avds"]);
  const avds = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (avds.length === 0) {
    throw new Error(
      "No Android Virtual Devices are available. Create one or connect a physical device."
    );
  }

  return avds[0];
}

async function waitForAndroidDevice(adbPath, timeoutMs, matcher, options = {}) {
  const start = Date.now();
  const includeOffline = options.includeOffline === true;

  while (Date.now() - start < timeoutMs) {
    const devices = listAdbDevices(adbPath, { includeOffline });
    const matchingDevices = matcher
      ? devices.filter((candidate) => matcher(candidate.serial))
      : devices;

    const readyDevice = matchingDevices.find(
      (candidate) => candidate.state === "device"
    );
    if (readyDevice) {
      return readyDevice.serial;
    }

    await delay(2_000);
  }

  throw new Error("Timed out while waiting for an Android device to appear.");
}

async function waitForBootCompletion(adbPath, serial, timeoutMs) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const bootCompleted = runCapture(
      adbPath,
      ["-s", serial, "shell", "getprop", "sys.boot_completed"],
      { allowFailure: true }
    ).trim();

    if (bootCompleted === "1") {
      return;
    }

    await delay(2_000);
  }

  throw new Error(`Timed out while waiting for ${serial} to finish booting.`);
}

async function ensureMetroServer(options = {}) {
  const foreground = options.foreground === true;
  const clearCache = options.clearCache === true;
  const firstPort = parsePositiveInteger(options.preferredPort ?? preferredPort, "Metro port");
  const lastPort = firstPort + 9;

  for (let port = firstPort; port <= lastPort; port += 1) {
    if (await isMetroRunning(port)) {
      if (clearCache) {
        log(`Metro is already running on port ${port}; using a fresh port for the cache reset.`);
        continue;
      }
      return { port, started: false };
    }

    if (await isPortFree(port)) {
      log(`Starting Metro on port ${port}...`);

      const metroProcess = startMetroProcess(port, { foreground, clearCache });
      // Every Metro started by this command is owned, even when its stdio is in
      // the background. The lifecycle is required so normal completion and
      // startup failures can both tear down the complete process tree.
      const lifecycle = createOwnedMetroProcessLifecycle(metroProcess);
      const removeSignalHandlers = installOwnedMetroSignalHandlers(lifecycle);

      if (!foreground) {
        metroProcess.unref();
      }

      try {
        if (process.platform === "win32") {
          const initialOwnershipSnapshot = captureOwnedProcessOwnership(metroProcess.pid, {
            ownershipBoundary: metroProcess.pocketAiOwnershipBoundary,
          });
          if (!initialOwnershipSnapshot) {
            throw new Error(`Could not capture the new Metro process tree for PID ${metroProcess.pid}.`);
          }
          lifecycle.setOwnershipSnapshot(initialOwnershipSnapshot);
        }
        const readinessResult = await Promise.race([
          waitForMetro(port, metroStartupTimeoutMs).then(() => ({ type: "ready" })),
          lifecycle.outcomePromise.then((outcome) => ({ type: "exit", outcome })),
        ]);
        if (readinessResult.type === "exit") {
          throw createUnexpectedMetroExitError(readinessResult.outcome, " before becoming ready");
        }
        if (process.platform === "win32") {
          const ownershipSnapshot = captureOwnedProcessOwnership(metroProcess.pid, {
            ownershipBoundary: metroProcess.pocketAiOwnershipBoundary,
          });
          if (!ownershipSnapshot) {
            throw new Error(`Could not capture the owned Metro process tree for PID ${metroProcess.pid}.`);
          }
          lifecycle.setOwnershipSnapshot(ownershipSnapshot);
        }
      } catch (error) {
        cleanupOwnedMetroAfterStartupFailure(lifecycle, removeSignalHandlers, error);
      }

      return {
        port,
        started: true,
        process: foreground ? metroProcess : null,
        lifecycle,
        removeSignalHandlers,
      };
    }
  }

  throw new Error(
    `Could not find a reusable or free Metro port in the ${firstPort}-${lastPort} range.`
  );
}

function withDnsResultOrderIpv4First(currentValue) {
  const normalized = typeof currentValue === "string" ? currentValue.trim() : "";

  if (normalized.includes("--dns-result-order=")) {
    return normalized;
  }

  const flag = "--dns-result-order=ipv4first";

  if (!normalized) {
    return flag;
  }

  if (normalized.split(/\s+/).includes(flag)) {
    return normalized;
  }

  return `${normalized} ${flag}`.trim();
}

function cleanupOwnedMetroAfterStartupFailure(
  lifecycle,
  removeSignalHandlers,
  startupError,
  options = {}
) {
  removeSignalHandlers();
  try {
    stopOwnedMetroProcessOrThrow(lifecycle, options);
  } catch (cleanupError) {
    throw new AggregateError(
      [startupError, cleanupError],
      `Metro startup failed (${startupError.message}) and owned-process cleanup also failed (${cleanupError.message}).`
    );
  }
  throw startupError;
}

function quoteWindowsProcessArgument(value) {
  const normalized = String(value);
  if (normalized.length === 0) {
    return '""';
  }
  if (!/[\s"]/u.test(normalized)) {
    return normalized;
  }

  let quoted = '"';
  let backslashCount = 0;
  for (const character of normalized) {
    if (character === "\\") {
      backslashCount += 1;
      continue;
    }
    if (character === '"') {
      quoted += "\\".repeat(backslashCount * 2 + 1) + '"';
      backslashCount = 0;
      continue;
    }
    quoted += "\\".repeat(backslashCount) + character;
    backslashCount = 0;
  }
  return `${quoted}${"\\".repeat(backslashCount * 2)}"`;
}

function buildWindowsProcessCommandLine(command, args = []) {
  return [command, ...args].map(quoteWindowsProcessArgument).join(" ");
}

function spawnWindowsJobProcess(command, args, options = {}) {
  const runSpawn = options.spawnImpl ?? spawn;
  const commandLine = buildWindowsProcessCommandLine(command, args);
  const jobHostPath = path.join(__dirname, "windows-job-process-host.ps1");
  if (!fs.existsSync(jobHostPath)) {
    throw new Error(`Windows Job host is missing: ${jobHostPath}`);
  }
  const payloadBase64 = Buffer.from(JSON.stringify({
    applicationPath: command,
    commandLine,
    currentDirectory: options.cwd || process.cwd(),
  }), "utf8").toString("base64");
  const child = runSpawn(
    options.powershellPath ?? "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      jobHostPath,
      "-PayloadBase64",
      payloadBase64,
    ],
    {
      cwd: options.cwd,
      // Hidden detached Windows PowerShell can exit successfully without
      // executing its script. The Job boundary provides lifecycle isolation,
      // so the host must stay non-detached.
      detached: false,
      stdio: options.stdio,
      env: options.env,
      windowsHide: options.windowsHide === true,
    }
  );
  child.pocketAiOwnershipBoundary = windowsJobOwnershipBoundary;
  return child;
}

function spawnOwnedProcess(command, args, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return spawnWindowsJobProcess(command, args, options);
  }

  const child = (options.spawnImpl ?? spawn)(command, args, {
    cwd: options.cwd,
    detached: options.detached === true,
    stdio: options.stdio,
    env: options.env,
    windowsHide: options.windowsHide === true,
  });
  child.pocketAiOwnershipBoundary = posixProcessGroupOwnershipBoundary;
  return child;
}

function startMetroProcess(port, options = {}) {
  const foreground = options.foreground === true;
  const metroArgs = buildMetroStartArgs(port, { clearCache: options.clearCache === true });
  const expoCliPath = require.resolve("expo/bin/cli");
  const env = {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV || "development",
  };

  if (foreground) {
    delete env.CI;
    delete env.EXPO_NO_INTERACTIVE;
  } else {
    env.CI = process.env.CI || "1";
    env.EXPO_NO_INTERACTIVE = "1";
  }

  // On Windows, `--localhost` can cause Expo/Metro to bind to ::1 only, while the
  // smoke runner expects the /status endpoint on 127.0.0.1. Prefer IPv4 for
  // deterministic local connectivity and adb reverse behavior.
  env.NODE_OPTIONS = withDnsResultOrderIpv4First(env.NODE_OPTIONS);

  let stdio = "inherit";
  if (!foreground) {
    fs.mkdirSync(artifactsRoot, { recursive: true });
    const metroLogPath = path.join(artifactsRoot, `metro-${port}.log`);
    const metroLogFd = fs.openSync(metroLogPath, "w");
    stdio = ["ignore", metroLogFd, metroLogFd];
  }

  return spawnOwnedProcess(
    process.execPath,
    [expoCliPath, ...metroArgs],
    {
      cwd: projectRoot,
      // POSIX process-group termination requires a dedicated group. Windows
      // uses a Job Object; keeping its PowerShell host non-detached also avoids
      // Windows PowerShell's silent no-op behavior in hidden detached mode.
      detached: process.platform !== "win32",
      stdio,
      env,
      windowsHide: !foreground,
    }
  );
}

function buildMetroStartArgs(port, options = {}) {
  const args = ["start", "--dev-client", "--localhost", "--port", `${port}`];

  if (options.clearCache === true) {
    args.push("--clear");
  }

  return args;
}

function createOwnedMetroProcessLifecycle(metroProcess) {
  let outcome = null;
  let stopRequested = false;
  let stopResult = null;
  let ownershipSnapshot = null;
  let resolveOutcome;
  const outcomePromise = new Promise((resolve) => {
    resolveOutcome = resolve;
  });
  const settle = (nextOutcome) => {
    if (outcome) {
      return;
    }
    outcome = nextOutcome;
    resolveOutcome(nextOutcome);
  };

  metroProcess.once("error", (error) => settle({ type: "error", error }));
  metroProcess.once("exit", (code, signal) => settle({ type: "exit", code, signal }));

  return {
    process: metroProcess,
    outcomePromise,
    getOutcome: () => outcome,
    isStopRequested: () => stopRequested,
    getStopResult: () => stopResult,
    setStopResult: (result) => {
      stopResult = result === true;
    },
    getOwnershipSnapshot: () => ownershipSnapshot,
    setOwnershipSnapshot: (snapshot) => {
      ownershipSnapshot = snapshot;
    },
    requestStop: () => {
      if (stopRequested && stopResult !== false) {
        return false;
      }
      stopRequested = true;
      stopResult = null;
      return true;
    },
  };
}

function createUnexpectedMetroExitError(outcome, suffix = "") {
  if (outcome?.type === "error") {
    return new Error(`Attached Metro failed${suffix}: ${outcome.error.message}`);
  }

  const detail = outcome?.signal
    ? ` after ${outcome.signal}`
    : ` with code ${outcome?.code}`;
  return new Error(`Attached Metro exited unexpectedly${suffix}${detail}.`);
}

async function waitForAttachedMetroExit(lifecycle) {
  if (!lifecycle) {
    return;
  }

  const outcome = await lifecycle.outcomePromise;
  if (lifecycle.isStopRequested()) {
    return;
  }
  if (outcome.type === "error") {
    throw outcome.error;
  }
  if (outcome.code === 0 || outcome.signal === "SIGINT" || outcome.signal === "SIGTERM") {
    return;
  }

  throw createUnexpectedMetroExitError(outcome);
}

function readProcessIdentity(processId, options = {}) {
  if (!Number.isSafeInteger(processId) || processId <= 0) {
    return null;
  }

  const platform = options.platform ?? process.platform;
  const runSpawnSync = options.spawnSync ?? spawnSync;
  if (platform === "win32") {
    const script = [
      `$targetProcess = Get-Process -Id ${processId} -ErrorAction Stop`,
      "$startMarker = $targetProcess.StartTime.ToUniversalTime().Ticks.ToString()",
      "$executablePath = $targetProcess.Path",
      "[Console]::Out.Write($startMarker + '|' + $executablePath)",
    ].join("; ");
    const result = runSpawnSync(
      options.powershellPath ?? "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: options.timeoutMs ?? metroTreeTerminationTimeoutMs,
        windowsHide: true,
      }
    );
    if (result.error || result.status !== 0) {
      return null;
    }

    const output = (result.stdout || "").trim();
    const separatorIndex = output.indexOf("|");
    if (separatorIndex <= 0) {
      return null;
    }
    return {
      startMarker: output.slice(0, separatorIndex),
      executablePath: output.slice(separatorIndex + 1),
    };
  }

  if (platform === "linux") {
    try {
      const procRoot = options.procRoot ?? "/proc";
      const stat = fs.readFileSync(path.join(procRoot, String(processId), "stat"), "utf8");
      const commandEnd = stat.lastIndexOf(") ");
      if (commandEnd < 0) {
        return null;
      }
      const fieldsAfterCommand = stat.slice(commandEnd + 2).trim().split(/\s+/);
      const startTimeTicks = fieldsAfterCommand[19];
      if (!startTimeTicks) {
        return null;
      }
      let executablePath = "";
      try {
        executablePath = fs.realpathSync(path.join(procRoot, String(processId), "exe"));
      } catch {
        // The kernel start-time marker is authoritative even when /proc/<pid>/exe is restricted.
      }
      return { startMarker: startTimeTicks, executablePath };
    } catch {
      return null;
    }
  }

  const result = runSpawnSync(
    "ps",
    ["-p", String(processId), "-o", "lstart=", "-o", "command="],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
  const output = result.error || result.status !== 0 ? "" : (result.stdout || "").trim();
  return output ? { startMarker: output, executablePath: "" } : null;
}

function normalizeOwnedProcessTreeIdentities(records, processId, processIdentity) {
  if (!Array.isArray(records) || records.length === 0) {
    return null;
  }

  const normalized = [];
  const seenProcessIds = new Set();
  for (const record of records) {
    const pid = Number(record?.pid);
    const parentPid = record?.parentPid === null || record?.parentPid === undefined
      ? null
      : Number(record.parentPid);
    const depth = Number(record?.depth);
    const startMarker = typeof record?.startMarker === "string"
      ? record.startMarker
      : String(record?.startMarker ?? "");
    if (
      !Number.isSafeInteger(pid)
      || pid <= 0
      || seenProcessIds.has(pid)
      || (parentPid !== null && (!Number.isSafeInteger(parentPid) || parentPid <= 0))
      || !Number.isSafeInteger(depth)
      || depth < 0
      || !/^\d+$/.test(startMarker)
    ) {
      return null;
    }
    seenProcessIds.add(pid);
    normalized.push({ pid, parentPid, startMarker, depth });
  }

  const rootRecord = normalized.find((record) => record.pid === processId && record.depth === 0);
  if (!rootRecord || rootRecord.startMarker !== processIdentity?.startMarker) {
    return null;
  }
  return normalized;
}


const windowsNativeProcessInfoSourceBase64 = Buffer.from(`
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace PocketAi {
  public static class NativeProcessInfo {
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessBasicInformation {
      public IntPtr Reserved1;
      public IntPtr PebBaseAddress;
      public IntPtr Reserved2_0;
      public IntPtr Reserved2_1;
      public IntPtr UniqueProcessId;
      public IntPtr InheritedFromUniqueProcessId;
    }

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(
      IntPtr processHandle,
      int processInformationClass,
      ref ProcessBasicInformation processInformation,
      int processInformationLength,
      out int returnLength
    );

    public static int GetParentProcessId(Process process) {
      var information = new ProcessBasicInformation();
      int returnLength;
      int status = NtQueryInformationProcess(
        process.Handle,
        0,
        ref information,
        Marshal.SizeOf(information),
        out returnLength
      );
      if (status != 0) {
        throw new Win32Exception(status);
      }
      return information.InheritedFromUniqueProcessId.ToInt32();
    }
  }
}
`, "utf16le").toString("base64");

function buildWindowsProcessSnapshotPowerShellStatements() {
  return [
    `$nativeProcessInfoSource = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${windowsNativeProcessInfoSourceBase64}'))`,
    "if ($null -eq ('PocketAi.NativeProcessInfo' -as [type])) { Add-Type -TypeDefinition $nativeProcessInfoSource -ErrorAction Stop }",
    "$allProcesses = @(Get-Process -ErrorAction SilentlyContinue | ForEach-Object { $candidateProcess = $_; try { [PSCustomObject]@{ ProcessId = [int]$candidateProcess.Id; ParentProcessId = [PocketAi.NativeProcessInfo]::GetParentProcessId($candidateProcess); StartMarker = [Int64]$candidateProcess.StartTime.ToUniversalTime().Ticks } } catch { } })",
  ];
}

function readWindowsProcessTreeIdentities(processId, processIdentity, options = {}) {
  if (
    !Number.isSafeInteger(processId)
    || processId <= 0
    || !/^\d+$/.test(processIdentity?.startMarker ?? "")
  ) {
    return null;
  }

  const runSpawnSync = options.spawnSync ?? spawnSync;
  const expectedStartMarker = escapePowerShellSingleQuotedString(processIdentity.startMarker);
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$targetProcessId = ${processId}`,
    `$expectedStartMarker = [Int64]${expectedStartMarker}`,
    "$targetProcess = Get-Process -Id $targetProcessId -ErrorAction SilentlyContinue",
    "if ($null -eq $targetProcess -or [Int64]$targetProcess.StartTime.ToUniversalTime().Ticks -ne $expectedStartMarker) { exit 41 }",
    ...buildWindowsProcessSnapshotPowerShellStatements(),
    "$pending = [System.Collections.Generic.Queue[int]]::new()",
    "$pending.Enqueue($targetProcessId)",
    "$visited = [System.Collections.Generic.HashSet[int]]::new()",
    "$null = $visited.Add($targetProcessId)",
    "$startMarkers = @{}",
    "$startMarkers[$targetProcessId] = $expectedStartMarker",
    "$depths = @{}",
    "$depths[$targetProcessId] = 0",
    "$records = [System.Collections.Generic.List[object]]::new()",
    "$records.Add([PSCustomObject]@{ pid = $targetProcessId; parentPid = $null; startMarker = $expectedStartMarker.ToString(); depth = 0 })",
    "while ($pending.Count -gt 0) { $parentProcessId = $pending.Dequeue(); $parentStartMarker = [Int64]$startMarkers[$parentProcessId]; $parentDepth = [int]$depths[$parentProcessId]; foreach ($candidate in $allProcesses) { $candidateProcessId = [int]$candidate.ProcessId; if ([int]$candidate.ParentProcessId -ne $parentProcessId -or $visited.Contains($candidateProcessId)) { continue }; $candidateStartMarker = [Int64]$candidate.StartMarker; if ($candidateStartMarker -lt $parentStartMarker) { continue }; $candidateProcess = Get-Process -Id $candidateProcessId -ErrorAction SilentlyContinue; if ($null -eq $candidateProcess -or [Int64]$candidateProcess.StartTime.ToUniversalTime().Ticks -ne $candidateStartMarker) { continue }; $null = $visited.Add($candidateProcessId); $startMarkers[$candidateProcessId] = $candidateStartMarker; $depths[$candidateProcessId] = $parentDepth + 1; $pending.Enqueue($candidateProcessId); $records.Add([PSCustomObject]@{ pid = $candidateProcessId; parentPid = $parentProcessId; startMarker = $candidateStartMarker.ToString(); depth = $parentDepth + 1 }) } }",
    "[Console]::Out.Write((ConvertTo-Json -InputObject @($records) -Compress -Depth 3))",
  ].join("; ");
  const result = runSpawnSync(
    options.powershellPath ?? "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options.timeoutMs ?? metroTreeTerminationTimeoutMs,
      windowsHide: true,
    }
  );
  if (result.error || result.status !== 0) {
    return null;
  }

  try {
    const parsed = JSON.parse((result.stdout || "").trim());
    return normalizeOwnedProcessTreeIdentities(parsed, processId, processIdentity);
  } catch {
    return null;
  }
}

function captureOwnedProcessOwnership(processId, options = {}) {
  const identityReader = options.readProcessIdentity ?? readProcessIdentity;
  const processIdentity = identityReader(processId, options);
  if (!processIdentity?.startMarker) {
    return null;
  }

  const platform = options.platform ?? process.platform;
  const ownershipBoundary = options.ownershipBoundary
    ?? (platform === "win32" ? null : posixProcessGroupOwnershipBoundary);
  const rootIdentity = {
    pid: processId,
    parentPid: null,
    startMarker: processIdentity.startMarker,
    depth: 0,
  };
  if (platform !== "win32") {
    return {
      processIdentity,
      processTreeIdentities: [rootIdentity],
      ownershipBoundary,
    };
  }

  if (ownershipBoundary === windowsJobOwnershipBoundary) {
    return {
      processIdentity,
      processTreeIdentities: [rootIdentity],
      ownershipBoundary,
    };
  }

  const treeReader = options.readWindowsProcessTreeIdentities ?? readWindowsProcessTreeIdentities;
  const processTreeIdentities = treeReader(processId, processIdentity, options);
  if (!processTreeIdentities) {
    return null;
  }
  return {
    processIdentity,
    processTreeIdentities,
    ownershipBoundary: "windows-process-tree-snapshot",
  };
}

function processIdentityMatches(actual, expected) {
  return Boolean(
    actual
    && expected
    && actual.startMarker
    && actual.startMarker === expected.startMarker
  );
}

function waitForPosixProcessGroupExit(processId, timeoutMs, signalProcessGroup = process.kill) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      signalProcessGroup(-processId, 0);
    } catch (error) {
      if (error?.code === "ESRCH") {
        return true;
      }
      if (error?.code !== "EPERM") {
        return false;
      }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return false;
}

function isPosixProcessAlive(processId, signalProcess = process.kill) {
  try {
    signalProcess(processId, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function isPosixProcessGroupAlive(processId, signalProcessGroup = process.kill) {
  try {
    signalProcessGroup(-processId, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function escapePowerShellSingleQuotedString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function stopOwnedMetroProcess(lifecycle, options = {}) {
  if (!lifecycle?.requestStop()) {
    return lifecycle?.getStopResult?.() === true;
  }

  const metroProcess = lifecycle.process;
  const ownershipSnapshot = lifecycle.getOwnershipSnapshot?.();
  const didStop = stopOwnedProcessTreeByPid(metroProcess.pid, {
    ...options,
    expectedIdentity: options.expectedIdentity ?? ownershipSnapshot?.processIdentity,
    expectedProcessTreeIdentities:
      options.expectedProcessTreeIdentities ?? ownershipSnapshot?.processTreeIdentities,
    ownershipBoundary:
      options.ownershipBoundary
      ?? ownershipSnapshot?.ownershipBoundary
      ?? metroProcess.pocketAiOwnershipBoundary,
    trustedChildHandle: true,
    killRoot: () => lifecycle.getOutcome?.() ? true : metroProcess.kill("SIGTERM"),
  });
  lifecycle.setStopResult?.(didStop);
  return didStop;
}

function stopOwnedMetroProcessOrThrow(lifecycle, options = {}) {
  if (!lifecycle) {
    return;
  }
  const stopProcess = options.stopProcess ?? stopOwnedMetroProcess;
  if (!stopProcess(lifecycle, options)) {
    throw new Error(`Failed to stop owned Metro process tree ${lifecycle.process?.pid ?? "unknown"}.`);
  }
}

function stopOwnedProcessTreeByPid(processId, options = {}) {
  const platform = options.platform ?? process.platform;
  const runSpawnSync = options.spawnSync ?? spawnSync;
  const identityReader = options.readProcessIdentity ?? readProcessIdentity;
  let ownedIdentity = options.expectedIdentity ?? null;

  if (options.expectedIdentity && platform !== "win32") {
    const actualIdentity = identityReader(processId, options);
    if (!processIdentityMatches(actualIdentity, options.expectedIdentity)) {
      const rootIsAlive = (options.isProcessAlive ?? isPosixProcessAlive)(
        processId,
        options.killProcess ?? process.kill,
      );
      if (rootIsAlive) {
        return false;
      }
      const groupIsAlive = (options.isProcessGroupAlive ?? isPosixProcessGroupAlive)(
        processId,
        options.killProcessGroup ?? process.kill,
      );
      if (!groupIsAlive) {
        return true;
      }
      // The authenticated leader has exited, but its dedicated process group
      // still exists. Signal the group rather than treating the stale root as
      // a reason to orphan its descendants.
    }
  }

  if (platform === "win32" && options.ownershipBoundary === windowsJobOwnershipBoundary) {
    const stopViaTrustedChildHandle = () => {
      if (options.trustedChildHandle !== true || typeof options.killRoot !== "function") {
        return false;
      }
      try {
        return options.killRoot() === true;
      } catch {
        return false;
      }
    };
    if (!/^\d+$/.test(ownedIdentity?.startMarker ?? "")) {
      return stopViaTrustedChildHandle();
    }
    const stopScriptPath = path.join(__dirname, "windows-job-process-stop.ps1");
    if (!fs.existsSync(stopScriptPath)) {
      return stopViaTrustedChildHandle();
    }
    const powershellResult = runSpawnSync(
      options.powershellPath ?? "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        stopScriptPath,
        "-ProcessId",
        String(processId),
        "-StartMarker",
        ownedIdentity.startMarker,
      ],
      {
        stdio: "ignore",
        timeout: options.timeoutMs ?? metroTreeTerminationTimeoutMs,
        windowsHide: true,
      }
    );
    if (!powershellResult.error && powershellResult.status === 0) {
      return true;
    }
    return stopViaTrustedChildHandle();
  }

  if (platform === "win32") {
    // A PID/PPID snapshot cannot prove ownership after a parent exits and its
    // PID is reused. Refuse non-Job-Object tree cleanup instead of risking an
    // unrelated process or claiming that late descendants were removed.
    return false;
  }


  if (platform !== "win32" && Number.isSafeInteger(processId)) {
    const signalProcessGroup = options.killProcessGroup ?? process.kill;
    try {
      signalProcessGroup(-processId, "SIGTERM");
    } catch {
      // Fall through to the child-process handle as a last-resort root cleanup.
      try {
        return options.killRoot?.() === true;
      } catch {
        return false;
      }
    }

    const didExit = (options.waitForProcessTreeExit ?? waitForPosixProcessGroupExit)(
      processId,
      options.gracefulTimeoutMs ?? metroGracefulTerminationTimeoutMs,
      signalProcessGroup,
    );
    if (didExit) {
      return true;
    }
    try {
      signalProcessGroup(-processId, "SIGKILL");
      const didExitAfterKill = (options.waitForProcessTreeExit ?? waitForPosixProcessGroupExit)(
        processId,
        options.forcefulTimeoutMs ?? metroGracefulTerminationTimeoutMs,
        signalProcessGroup,
      );
      if (didExitAfterKill) {
        return true;
      }
    } catch {
      // Fall through to the child handle when group escalation is unavailable.
    }
  }

  try {
    return options.killRoot?.() === true;
  } catch {
    return false;
  }
}

function installOwnedMetroSignalHandlers(lifecycle, processRef = process) {
  const onSigint = () => {
    processRef.exitCode = 130;
    if (!stopOwnedMetroProcess(lifecycle)) {
      console.error("[android-smoke] Failed to stop owned Metro after SIGINT; cleanup will be retried.");
    }
  };
  const onSigterm = () => {
    processRef.exitCode = 143;
    if (!stopOwnedMetroProcess(lifecycle)) {
      console.error("[android-smoke] Failed to stop owned Metro after SIGTERM; cleanup will be retried.");
    }
  };
  processRef.once("SIGINT", onSigint);
  processRef.once("SIGTERM", onSigterm);

  return () => {
    processRef.removeListener("SIGINT", onSigint);
    processRef.removeListener("SIGTERM", onSigterm);
  };
}

async function waitForMetro(port, timeoutMs) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (await isMetroRunning(port)) {
      return;
    }

    await delay(1_500);
  }

  throw new Error(`Timed out while waiting for Metro on port ${port}.`);
}

async function isMetroRunning(port) {
  return new Promise((resolve) => {
    const request = http.get(
      {
        host: "127.0.0.1",
        port,
        path: "/status",
        timeout: 1_500,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          resolve(body.includes("packager-status:running"));
        });
      }
    );

    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });

    request.on("error", () => {
      resolve(false);
    });
  });
}

async function prewarmMetroBundle(port, appPackage) {
  const bundlePath = buildMetroBundlePath(readPackageEntryPoint(), { appPackage });
  log(`Prewarming Android Metro bundle on port ${port}...`);

  const bytes = await requestMetroBundle(port, bundlePath, metroBundleTimeoutMs);
  log(`Prewarmed Android Metro bundle (${bytes} bytes).`);
}

function buildMetroBundlePath(entryPoint = readPackageEntryPoint(), options = {}) {
  const appPackage = options.appPackage ?? readExpoConfig().packageName;
  const params = new URLSearchParams({
    platform: "android",
    dev: "true",
    lazy: "true",
    minify: "false",
    app: appPackage,
    modulesOnly: "false",
    runModule: "true",
    excludeSource: "true",
    sourcePaths: "url-server",
  });

  return `${buildMetroEntryBundlePath(entryPoint)}?${params.toString()}`;
}

function readPackageEntryPoint() {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  return typeof packageJson.main === "string" && packageJson.main.trim() ? packageJson.main : "index";
}

function buildMetroEntryBundlePath(entryPoint) {
  let normalized = `${entryPoint || "index"}`.trim();

  normalized = normalized.replace(/\\/g, "/");
  normalized = normalized.replace(/^\.\//, "");
  normalized = normalized.replace(/^\/+/, "");
  normalized = normalized.replace(/\.(android|native)?\.(js|jsx|ts|tsx|mjs|cjs)$/, "");
  normalized = normalized.replace(/\.(js|jsx|ts|tsx|mjs|cjs)$/, "");

  if (!normalized) {
    normalized = "index";
  }

  const isProjectLocalEntry =
    normalized === "index" ||
    normalized.startsWith("src/") ||
    normalized.startsWith("app/") ||
    normalized.startsWith("node_modules/");
  const bundleEntry = isProjectLocalEntry ? normalized : `node_modules/${normalized}`;

  return `/${bundleEntry}.bundle`;
}

async function requestMetroBundle(port, bundlePath, timeoutMs = metroBundleTimeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let receivedBytes = 0;
    let responseBody = "";

    const finish = (error, value) => {
      if (settled) {
        return;
      }

      settled = true;
      if (error) {
        reject(error);
        return;
      }

      resolve(value);
    };

    const request = http.get(
      {
        host: "127.0.0.1",
        port,
        path: bundlePath,
        timeout: timeoutMs,
      },
      (response) => {
        response.on("data", (chunk) => {
          receivedBytes += chunk.length;
          if (response.statusCode !== 200 && responseBody.length < 4096) {
            responseBody += chunk.toString("utf8");
          }
        });
        response.on("end", () => {
          if (response.statusCode !== 200) {
            finish(
              new Error(
                `Metro bundle prewarm failed with HTTP ${response.statusCode}: ${responseBody.slice(0, 500)}`
              )
            );
            return;
          }

          finish(null, receivedBytes);
        });
      }
    );

    request.on("timeout", () => {
      request.destroy();
      finish(new Error(`Timed out while prewarming Metro bundle on port ${port}.`));
    });

    request.on("error", (error) => {
      finish(error);
    });
  });
}

async function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once("error", () => {
      resolve(false);
    });

    server.once("listening", () => {
      server.close(() => resolve(true));
    });

    server.listen(port, "127.0.0.1");
  });
}

function buildAndroidApk() {
  ensureAndroidNativeProject();
  ensureGradleWrapperExecutable();
  log(`Building Android ${apkVariant} APK...`);

  const assembleTask = `app:assemble${apkVariant[0].toUpperCase()}${apkVariant.slice(1)}`;
  const gradleArgs = buildGradleAssembleArgs(assembleTask, buildTargetAbi);
  assertSmokeBuildOverrideContract(gradleArgs);
  runAndroidGradleBuild(gradleArgs);
}

function runAndroidGradleBuild(gradleArgs, options = {}) {
  for (const requiredArgument of ANDROID_PROVENANCE_GRADLE_EXECUTION_ARGS) {
    if (!gradleArgs.includes(requiredArgument)) {
      throw new Error(
        `Android provenance-aware Gradle execution requires ${requiredArgument}.`
      );
    }
  }
  const execute = options.runChecked || runChecked;
  const platform = options.platform || process.platform;
  const buildEnv = options.env || androidBuildEnvironment;
  const buildRoot = options.androidRoot || androidRoot;
  const wrapperPath = options.gradleWrapperPath || gradleWrapperPath;

  const invocation = resolveAndroidGradleWrapperInvocation({
    platform,
    comSpec: options.comSpec,
    gradleArgs,
    gradleWrapperPath: wrapperPath,
  });
  execute(invocation.command, invocation.args, {
    cwd: buildRoot,
    stdio: "inherit",
    env: buildEnv,
  });
}

function ensureAndroidNativeProject() {
  const prebuildInputState = collectPrebuildInputState(projectRoot, {
    variant: apkVariant,
    nodeEnv: androidBuildNodeEnv,
    env: androidBuildEnvironment,
  });
  const nativeProjectState = collectAndroidNativeProjectState(projectRoot);
  const activePrebuildStamp = readJsonFile(activePrebuildStampPath);
  const hasCurrentPrebuild = !shouldRunPrebuild({
    gradleWrapperExists: fs.existsSync(gradleWrapperPath),
    activeStamp: activePrebuildStamp,
    inputState: prebuildInputState,
    nativeProjectState,
    variant: apkVariant,
  });

  if (hasCurrentPrebuild) {
    return prebuildInputState;
  }

  const reason = fs.existsSync(gradleWrapperPath)
    ? "Expo/config-plugin inputs changed or have no verified prebuild stamp"
    : "the Android native project is missing";
  log(`Generating the Android native project with Expo prebuild because ${reason}...`);
  fs.rmSync(activePrebuildStampPath, { force: true });
  const expoCli = resolveExpoCliInvocation(projectRoot);
  runChecked(
    expoCli.command,
    [...expoCli.args, ...buildAndroidCleanPrebuildArgs()],
    {
      cwd: projectRoot,
      stdio: "inherit",
      env: androidBuildEnvironment,
    }
  );

  if (!fs.existsSync(gradleWrapperPath)) {
    throw new Error(
      `Expected Gradle wrapper at ${gradleWrapperPath} after Expo prebuild, but it was not found.`
    );
  }

  const verifiedInputState = collectPrebuildInputState(projectRoot, {
    variant: apkVariant,
    nodeEnv: androidBuildNodeEnv,
    env: androidBuildEnvironment,
  });
  if (verifiedInputState.digest !== prebuildInputState.digest) {
    throw new Error(
      "Expo/config-plugin inputs changed while prebuild was running; refusing to stamp generated native sources."
    );
  }

  const verifiedNativeProjectState = collectAndroidNativeProjectState(projectRoot);
  const verifiedPrebuildStamp = {
    schemaVersion: BUILD_PROVENANCE_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    variant: apkVariant,
    inputDigest: verifiedInputState.digest,
    nativeInputDigest: verifiedNativeProjectState.digest,
    context: verifiedInputState.context,
    inputs: verifiedInputState.entries,
  };
  writeJsonFile(prebuildStampPath, verifiedPrebuildStamp);
  writeJsonFile(activePrebuildStampPath, verifiedPrebuildStamp);
  return verifiedInputState;
}

function ensureGradleWrapperExecutable() {
  if (process.platform === "win32") {
    return;
  }

  fs.chmodSync(gradleWrapperPath, 0o755);
}

function installDebugApk(adbPath, serial, appPackage, options = {}) {
  const allowReuseExistingInstallOnLowStorage =
    options.allowReuseExistingInstallOnLowStorage !== false;
  const didBuildDebugApk = options.didBuildDebugApk === true;
  const buildInputState = options.buildInputState;
  const apkFingerprint = createFileFingerprint(apkPath);
  const abiDecision = resolveDebugApkReuseDecision(adbPath, serial, apkPath);
  if (!abiDecision.canReuse) {
    throw new Error(
      `The ${apkVariant} APK no longer satisfies the requested ABI contract before install `
        + `(${abiDecision.reason || "unknown incompatibility"}).`
    );
  }
  const buildStamp = readJsonFile(buildStampPath);
  if (
    !buildStamp
    || buildStamp.schemaVersion !== BUILD_PROVENANCE_SCHEMA_VERSION
    || buildStamp.variant !== apkVariant
    || buildStamp.abi !== buildTargetAbi
    || buildStamp.provenanceDigest !== buildInputState?.digest
    || buildStamp.apk?.sha256 !== apkFingerprint.sha256
    || buildStamp.apk?.size !== apkFingerprint.size
    || !areStringArraysEqual(buildStamp.apk?.packagedAbis, abiDecision.packagedAbis)
    || buildStamp.apk?.matchedAbi !== abiDecision.matchedAbi
  ) {
    throw new Error(
      `The ${apkVariant} APK does not have verified build provenance for the current inputs; refusing to install it.`
    );
  }
  const installedPackageInfo = readInstalledPackageInfo(adbPath, serial, appPackage);
  const installStampPath = resolveInstallStampPath(serial, appPackage);
  const installStamp = readJsonFile(installStampPath);
  const installReuse = evaluateInstallReuse({
    packageInstalled: installedPackageInfo.installed,
    didBuildDebugApk,
    installStamp,
    apkFingerprint,
    devicePackageInfo: installedPackageInfo,
    variant: apkVariant,
    abi: buildTargetAbi,
    buildProvenanceDigest: buildInputState.digest,
    packagedAbis: abiDecision.packagedAbis,
    matchedAbi: abiDecision.matchedAbi,
  });

  if (installReuse.canReuse) {
    log(`Reusing the existing app installation (${installReuse.reason}).`);
    return {
      reused: true,
      installStampPath,
      installedPackageInfo,
      abiDecision,
    };
  }

  log(`Installing ${apkVariant} APK...`);

  const result = spawnSync(adbPath, ["-s", serial, "install", "-r", apkPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    throw result.error;
  }

  const output = `${result.stdout || ""}${result.stderr || ""}`;
  if (output) {
    process.stdout.write(output);
  }

  if (result.status === 0) {
    const verifiedPackageInfo = readInstalledPackageInfo(adbPath, serial, appPackage);
    verifyInstalledApkProvenance(verifiedPackageInfo, apkFingerprint, appPackage);
    writeInstallStamp(
      serial,
      appPackage,
      apkFingerprint,
      verifiedPackageInfo,
      buildInputState.digest,
      abiDecision
    );
    return {
      reused: false,
      installStampPath,
      installedPackageInfo: verifiedPackageInfo,
      abiDecision,
    };
  }

  if (isInsufficientStorageInstallFailure(output)) {
    if (!allowReuseExistingInstallOnLowStorage) {
      throw new Error(
        `Android target storage is insufficient and the freshly built ${apkVariant} APK could not be installed. ` +
          "Free space on the device/emulator (or uninstall the existing app) and retry."
      );
    }

    throw new Error(
      `Android target storage is insufficient and the current app installation could not be verified against the requested ${apkVariant} APK. ` +
        "Free space on the device/emulator (or wipe the emulator) and retry."
    );
  }

  const trimmed = output.trim();
  throw new Error(
    `Command failed: ${adbPath} -s ${serial} install -r ${apkPath}${trimmed ? `\n${trimmed}` : ""}`
  );
}

function evaluateInstallReuse({
  packageInstalled,
  didBuildDebugApk,
  installStamp,
  apkFingerprint,
  devicePackageInfo,
  variant = "debug",
  abi = "universal",
  buildProvenanceDigest = null,
  packagedAbis = [],
  matchedAbi = null,
}) {
  if (!packageInstalled) {
    return {
      canReuse: false,
      reason: "the app is not installed on the target device yet",
    };
  }

  if (didBuildDebugApk) {
    return {
      canReuse: false,
      reason: `a fresh ${variant} APK was built for this run`,
    };
  }

  if (!installStamp) {
    return {
      canReuse: false,
      reason: "no install stamp exists for this device yet",
    };
  }

  if (
    installStamp.schemaVersion !== BUILD_PROVENANCE_SCHEMA_VERSION
    || installStamp.variant !== variant
    || installStamp.abi !== abi
    || !buildProvenanceDigest
    || installStamp.buildProvenanceDigest !== buildProvenanceDigest
  ) {
    return {
      canReuse: false,
      reason: "the installed-app stamp has stale or incompatible build provenance",
    };
  }

  if (installStamp.apkSha256 !== apkFingerprint.sha256) {
    return {
      canReuse: false,
      reason: `the installed-app stamp points to a different ${variant} APK`,
    };
  }

  if (
    !areStringArraysEqual(installStamp.packagedAbis, packagedAbis)
    || installStamp.matchedAbi !== matchedAbi
  ) {
    return {
      canReuse: false,
      reason: "the installed-app stamp has stale or incompatible packaged ABI evidence",
    };
  }

  if (
    !devicePackageInfo
    || !devicePackageInfo.installed
    || !devicePackageInfo.packagePath
    || !devicePackageInfo.apkSha256
  ) {
    return {
      canReuse: false,
      reason: "current installed-app metadata or content hash is unavailable",
    };
  }

  if (
    devicePackageInfo.apkSha256 !== apkFingerprint.sha256
    || installStamp.installedApkSha256 !== devicePackageInfo.apkSha256
  ) {
    return {
      canReuse: false,
      reason: "the installed APK content hash does not match the verified local APK",
    };
  }

  if (installStamp.packagePath && installStamp.packagePath !== devicePackageInfo.packagePath) {
    return {
      canReuse: false,
      reason: "the installed app path changed on the device",
    };
  }

  if (
    installStamp.lastUpdateTime
    && devicePackageInfo.lastUpdateTime
    && installStamp.lastUpdateTime !== devicePackageInfo.lastUpdateTime
  ) {
    return {
      canReuse: false,
      reason: "the installed app update time changed on the device",
    };
  }

  if (
    installStamp.versionCode
    && devicePackageInfo.versionCode
    && installStamp.versionCode !== devicePackageInfo.versionCode
  ) {
    return {
      canReuse: false,
      reason: "the installed app version code changed on the device",
    };
  }

  if (
    installStamp.versionName
    && devicePackageInfo.versionName
    && installStamp.versionName !== devicePackageInfo.versionName
  ) {
    return {
      canReuse: false,
      reason: "the installed app version name changed on the device",
    };
  }

  return {
    canReuse: true,
    reason: `the installed app content still matches the current ${variant} APK`,
  };
}

function readInstalledPackageInfo(adbPath, serial, appPackage) {
  const packagePathOutput = runCapture(
    adbPath,
    ["-s", serial, "shell", "pm", "path", appPackage],
    { allowFailure: true }
  );
  const packagePath = parsePackagePathOutput(packagePathOutput);
  if (!packagePath) {
    return {
      installed: false,
      packagePath: null,
      apkSha256: null,
      lastUpdateTime: null,
      versionCode: null,
      versionName: null,
    };
  }

  const dumpsysOutput = runCapture(
    adbPath,
    ["-s", serial, "shell", "dumpsys", "package", appPackage],
    { allowFailure: true }
  );
  const packageMetadata = parseDumpsysPackageOutput(dumpsysOutput);

  return {
    installed: true,
    packagePath,
    apkSha256: readInstalledApkSha256(adbPath, serial, packagePath),
    lastUpdateTime: packageMetadata.lastUpdateTime,
    versionCode: packageMetadata.versionCode,
    versionName: packageMetadata.versionName,
  };
}

function readInstalledApkSha256(adbPath, serial, packagePath) {
  const commands = [
    ["shell", "sha256sum", packagePath],
    ["shell", "toybox", "sha256sum", packagePath],
  ];

  for (const command of commands) {
    const output = runCapture(adbPath, ["-s", serial, ...command], { allowFailure: true });
    const sha256 = parseSha256Output(output);
    if (sha256) {
      return sha256;
    }
  }

  return null;
}

function parseSha256Output(output) {
  const match = `${output || ""}`.match(/(?:^|\r?\n)\s*([a-fA-F0-9]{64})(?:\s+|$)/);
  return match ? match[1].toLowerCase() : null;
}

function parsePackagePathOutput(output) {
  const packagePaths = `${output}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("package:"))
    .map((line) => line.slice("package:".length));
  return packagePaths.find((packagePath) => packagePath.endsWith("/base.apk"))
    || packagePaths[0]
    || null;
}

function parseDumpsysPackageOutput(output) {
  const normalized = `${output}`;
  const lastUpdateTimeMatch = normalized.match(/lastUpdateTime=(.+)/);
  const versionCodeMatch = normalized.match(/versionCode=(\d+)/);
  const versionNameMatch = normalized.match(/versionName=([^\r\n]+)/);

  return {
    lastUpdateTime: lastUpdateTimeMatch ? lastUpdateTimeMatch[1].trim() : null,
    versionCode: versionCodeMatch ? versionCodeMatch[1] : null,
    versionName: versionNameMatch ? versionNameMatch[1].trim() : null,
  };
}

function resolveInstallStampPath(serial, appPackage) {
  const safeSerial = sanitizeForFileName(serial);
  const safePackage = sanitizeForFileName(appPackage);
  return path.join(cacheRoot, `install-${safeSerial}-${safePackage}.json`);
}

function verifyInstalledApkProvenance(installedPackageInfo, apkFingerprint, appPackage) {
  if (
    !installedPackageInfo?.installed
    || !installedPackageInfo.packagePath
    || !installedPackageInfo.versionCode
    || !installedPackageInfo.versionName
  ) {
    throw new Error(
      `Android reported an incomplete installed-package identity for ${appPackage} after install.`
    );
  }
  if (!installedPackageInfo.apkSha256) {
    throw new Error(
      `Could not content-hash the installed APK for ${appPackage}; refusing to claim install provenance.`
    );
  }
  if (installedPackageInfo.apkSha256 !== apkFingerprint.sha256) {
    throw new Error(
      `Installed APK provenance mismatch for ${appPackage}: device content does not match the verified local APK.`
    );
  }
}

function writeInstallStamp(
  serial,
  appPackage,
  apkFingerprint,
  installedPackageInfo,
  buildProvenanceDigest,
  abiDecision
) {
  writeJsonFile(resolveInstallStampPath(serial, appPackage), {
    schemaVersion: BUILD_PROVENANCE_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    serial,
    packageName: appPackage,
    variant: apkVariant,
    abi: buildTargetAbi,
    buildProvenanceDigest,
    apkSha256: apkFingerprint.sha256,
    apkPath: apkFingerprint.path,
    apkSize: apkFingerprint.size,
    packagedAbis: abiDecision.packagedAbis,
    matchedAbi: abiDecision.matchedAbi,
    installedApkSha256: installedPackageInfo.apkSha256,
    packagePath: installedPackageInfo.packagePath || null,
    lastUpdateTime: installedPackageInfo.lastUpdateTime || null,
    versionCode: installedPackageInfo.versionCode || null,
    versionName: installedPackageInfo.versionName || null,
  });
}

function writeQaProvenanceReport({ adbPath, serial, appPackage, buildInputState, installResult }) {
  const buildStamp = readJsonFile(buildStampPath);
  const installStampPath = installResult.installStampPath;
  const installStamp = readJsonFile(installStampPath);
  if (
    !buildStamp
    || !installStamp
    || buildStamp.provenanceDigest !== buildInputState.digest
    || installStamp.buildProvenanceDigest !== buildInputState.digest
    || buildStamp.apk?.sha256 !== installStamp.installedApkSha256
    || !areStringArraysEqual(buildStamp.apk?.packagedAbis, installStamp.packagedAbis)
    || buildStamp.apk?.matchedAbi !== installStamp.matchedAbi
    || !areStringArraysEqual(installResult.abiDecision?.packagedAbis, installStamp.packagedAbis)
    || installResult.abiDecision?.matchedAbi !== installStamp.matchedAbi
  ) {
    throw new Error("Android QA provenance chain is incomplete after build/install verification.");
  }

  writeJsonFile(qaProvenanceReportPath, {
    schemaVersion: BUILD_PROVENANCE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    serial,
    packageName: appPackage,
    variant: apkVariant,
    abi: buildTargetAbi,
    device: {
      serial,
      model: runCapture(
        adbPath,
        ["-s", serial, "shell", "getprop", "ro.product.model"],
        { allowFailure: true }
      ).trim() || null,
      abis: resolveDeviceSupportedAbis(adbPath, serial),
    },
    reusedInstallation: installResult.reused,
    buildStampPath: toProjectRelativePath(buildStampPath),
    installStampPath: toProjectRelativePath(installStampPath),
    build: buildStamp,
    install: installStamp,
  });
}

function sanitizeForFileName(value) {
  return `${value}`.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function isInsufficientStorageInstallFailure(output) {
  const normalizedOutput = (output || "").toLowerCase();
  return normalizedOutput.includes("install_failed_insufficient_storage")
    || normalizedOutput.includes("insufficient storage")
    || normalizedOutput.includes("not enough space");
}

function buildMetroReverseSpecs(hostPort, devicePort = defaultDeviceMetroPort) {
  const normalizedHostPort = parsePositiveInteger(hostPort, "host Metro port");
  const normalizedDevicePort = parsePositiveInteger(devicePort, "device Metro port");
  const specsByDevicePort = new Map([
    [
      normalizedDevicePort,
      {
        devicePort: normalizedDevicePort,
        hostPort: normalizedHostPort,
      },
    ],
  ]);

  if (normalizedHostPort !== normalizedDevicePort) {
    specsByDevicePort.set(normalizedHostPort, {
      devicePort: normalizedHostPort,
      hostPort: normalizedHostPort,
    });
  }

  return Array.from(specsByDevicePort.values());
}

function reverseMetroPort(adbPath, serial, hostPort) {
  for (const spec of buildMetroReverseSpecs(hostPort)) {
    log(`Reversing device port ${spec.devicePort} to localhost:${spec.hostPort}...`);
    runChecked(
      adbPath,
      ["-s", serial, "reverse", `tcp:${spec.devicePort}`, `tcp:${spec.hostPort}`],
      {
        stdio: "inherit",
      }
    );
  }
}

function launchInstalledApp(adbPath, serial, appPackage) {
  log("Launching the installed Android app...");
  runCapture(adbPath, ["-s", serial, "shell", "am", "force-stop", appPackage], {
    allowFailure: true,
  });
  runChecked(
    adbPath,
    [
      "-s",
      serial,
      "shell",
      "monkey",
      "-p",
      appPackage,
      "-c",
      "android.intent.category.LAUNCHER",
      "1",
    ],
    {
      stdio: "inherit",
    }
  );
}

function launchDevClient(adbPath, serial, appPackage, appScheme, port) {
  if (!hasExpoDevClientDependency()) {
    launchInstalledApp(adbPath, serial, appPackage);
    return;
  }

  const bundleUrl = `http://127.0.0.1:${port}`;
  const deepLink = `${appScheme}://expo-development-client/?url=${encodeURIComponent(
    bundleUrl
  )}`;

  log("Launching the Expo development client...");
  runChecked(
    adbPath,
    [
      "-s",
      serial,
      "shell",
      "am",
      "start",
      "-W",
      "-S",
      "-a",
      "android.intent.action.VIEW",
      "-d",
      deepLink,
      appPackage,
    ],
    {
      stdio: "inherit",
    }
  );
}

const appJsReadyResourceIds = [
  "home-screen-content",
  "models-screen-content",
  "settings-screen-content",
  "chat-list-viewport",
  "storage-recovery-screen",
  "conversation-search-input",
];

const appJsReadyTextLabels = [
  "Recent Conversations",
  "Недавние разговоры",
  "Active model",
  "Активная модель",
  "Model details",
  "Детали модели",
];

function isAppJsReadyUiHierarchy(xml, appPackage) {
  if (
    typeof xml !== "string"
    || !xml.includes("<hierarchy")
    || !xml.includes(`package="${appPackage}"`)
  ) {
    return false;
  }

  return appJsReadyResourceIds.some((resourceId) => (
    xml.includes(`resource-id="${resourceId}"`)
    || xml.includes(`resource-id="${appPackage}:id/${resourceId}"`)
  )) || appJsReadyTextLabels.some((label) => xml.includes(`text="${label}"`));
}

function readAndroidUiHierarchy(adbPath, serial, options = {}) {
  const runSpawnSync = options.spawnSync ?? spawnSync;
  const remotePath = options.remotePath ?? `/sdcard/pocket-ai-smoke-ready-${process.pid}.xml`;
  const commandTimeoutMs = options.commandTimeoutMs ?? uiHierarchyCommandTimeoutMs;
  const spawnOptions = {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: commandTimeoutMs,
  };
  try {
    const dumpResult = runSpawnSync(
      adbPath,
      ["-s", serial, "shell", "uiautomator", "dump", remotePath],
      spawnOptions,
    );
    if (dumpResult.error || dumpResult.status !== 0) {
      return null;
    }

    const readResult = runSpawnSync(
      adbPath,
      ["-s", serial, "exec-out", "cat", remotePath],
      { ...spawnOptions, maxBuffer: 10 * 1024 * 1024 },
    );
    if (
      readResult.error
      || readResult.status !== 0
      || typeof readResult.stdout !== "string"
      || !readResult.stdout.includes("<hierarchy")
    ) {
      return null;
    }
    return readResult.stdout;
  } finally {
    runSpawnSync(
      adbPath,
      ["-s", serial, "shell", "rm", "-f", remotePath],
      { stdio: "ignore", timeout: commandTimeoutMs },
    );
  }
}

async function waitForAppJsReady(adbPath, serial, appPackage, options = {}) {
  const timeoutMs = options.timeoutMs ?? appJsReadyTimeoutMs;
  const pollIntervalMs = options.pollIntervalMs ?? appJsReadyPollIntervalMs;
  const readUiHierarchy = options.readUiHierarchy ?? readAndroidUiHierarchy;
  const wait = options.delay ?? delay;
  const startedAt = Date.now();

  do {
    if (options.lifecycle?.isStopRequested?.()) {
      throw new Error("Android smoke was interrupted while waiting for the app JS surface.");
    }
    const metroOutcome = options.lifecycle?.getOutcome?.();
    if (metroOutcome) {
      throw createUnexpectedMetroExitError(metroOutcome, " while waiting for the app JS surface");
    }

    const hierarchy = readUiHierarchy(adbPath, serial, options);
    if (isAppJsReadyUiHierarchy(hierarchy, appPackage)) {
      log("Confirmed that the app JS surface is visible.");
      return;
    }

    if (Date.now() - startedAt >= timeoutMs) {
      break;
    }
    await wait(pollIntervalMs);
  } while (true);

  throw new Error(
    `Timed out while waiting for ${appPackage} to render its JS surface after launch.`
  );
}

function hasExpoDevClientDependency() {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  return Boolean(
    (packageJson.dependencies && packageJson.dependencies["expo-dev-client"]) ||
      (packageJson.devDependencies && packageJson.devDependencies["expo-dev-client"])
  );
}

function saveScreenshot(adbPath, serial, outputPath) {
  captureAndroidScreenshot(adbPath, serial, outputPath);
}

function parseAndroidPackageUid(output, packageName) {
  for (const line of `${output || ""}`.split(/\r?\n/u)) {
    const [packageToken, uidToken, ...extraTokens] = line.trim().split(/\s+/u);
    if (
      extraTokens.length === 0
      && packageToken === `package:${packageName}`
      && /^uid:\d+$/u.test(uidToken || "")
    ) {
      return uidToken.slice("uid:".length);
    }
  }
  return null;
}

function parseAndroidProcessId(output) {
  const normalized = `${output || ""}`.trim();
  return /^\d+$/u.test(normalized) ? normalized : null;
}

function saveLogcat(adbPath, serial, outputPath, options = {}) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const capture = options.runCapture || runCapture;
  const packageName = `${options.packageName || ""}`.trim();
  if (!packageName) {
    throw new Error("Privacy-scoped Android bootstrap logcat requires an app package name.");
  }
  const uid = parseAndroidPackageUid(
    capture(
      adbPath,
      ["-s", serial, "shell", "cmd", "package", "list", "packages", "-U", packageName],
      { allowFailure: true }
    ),
    packageName
  );
  const processId = parseAndroidProcessId(capture(
    adbPath,
    ["-s", serial, "shell", "pidof", "-s", packageName],
    { allowFailure: true }
  ));
  if (!uid || !processId) {
    throw new Error(
      "Could not resolve the installed Android app UID and process for privacy-scoped bootstrap logcat."
    );
  }

  const logs = capture(
    adbPath,
    [
      "-s",
      serial,
      "logcat",
      "-d",
      "-v",
      "time",
      `--uid=${uid}`,
      `--pid=${processId}`,
      "-t",
      "800",
    ],
    { allowFailure: true }
  );

  fs.writeFileSync(outputPath, sanitizeAndroidQaText(logs, {
    maxChars: 1_000_000,
    sensitiveRoots: options.sensitiveRoots || [projectRoot],
  }));
  log("Saved sanitized app-scoped bootstrap logcat.");
}

function captureAndroidScreenshot(adbPath, serial, outputPath, options = {}) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const runSpawnSync = options.spawnSync ?? spawnSync;
  const commandTimeoutMs = options.commandTimeoutMs ?? screenshotAdbCommandTimeoutMs;

  const directCapture = runSpawnSync(
    adbPath,
    ["-s", serial, "exec-out", "screencap", "-p"],
    {
      maxBuffer: 20 * 1024 * 1024,
      timeout: commandTimeoutMs,
    }
  );

  if (directCapture.error) {
    throw directCapture.error;
  }

  if (directCapture.status === 0 && isCompletePngBuffer(directCapture.stdout)) {
    fs.writeFileSync(outputPath, directCapture.stdout);
    return;
  }

  log("Direct screencap failed; retrying screenshot capture via a temporary device file.");

  const remotePath = `/data/local/tmp/pocket-ai-qa-${process.pid}-${Date.now()}.png`;
  const remoteCapture = runSpawnSync(
    adbPath,
    ["-s", serial, "shell", "screencap", "-p", remotePath],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: commandTimeoutMs,
    }
  );

  if (remoteCapture.error) {
    throw remoteCapture.error;
  }

  try {
    if (remoteCapture.status !== 0) {
      throw new Error("Failed to capture an Android screenshot.");
    }

    const pullResult = runSpawnSync(
      adbPath,
      ["-s", serial, "pull", remotePath, outputPath],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: commandTimeoutMs,
      }
    );

    if (pullResult.error) {
      throw pullResult.error;
    }

    if (pullResult.status !== 0) {
      throw new Error("Failed to capture an Android screenshot.");
    }

    const screenshotBuffer = fs.readFileSync(outputPath);
    if (!isCompletePngBuffer(screenshotBuffer)) {
      throw new Error("Failed to capture an Android screenshot.");
    }
  } finally {
    runSpawnSync(
      adbPath,
      ["-s", serial, "shell", "rm", "-f", remotePath],
      { stdio: "ignore", timeout: commandTimeoutMs }
    );
  }
}

function runCapture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0 && !options.allowFailure) {
    const stderr = (result.stderr || "").trim();
    throw new Error(
      `Command failed: ${command} ${args.join(" ")}${stderr ? `\n${stderr}` : ""}`
    );
  }

  return result.stdout || "";
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || projectRoot,
    stdio: options.stdio || "inherit",
    env: options.env || process.env,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
}

function parseCliOptions(argv) {
  const options = {
    emulator: false,
    skipBuild: false,
    screenshot: null,
    avd: null,
    serial: null,
    port: null,
    launchDelayMs: null,
    apkVariant: null,
    targetAbi: null,
    keepMetroForeground: false,
    clearMetroCache: false,
    autoTarget: false,
    transferMetroOwnership: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--emulator") {
      options.emulator = true;
      continue;
    }

    if (arg === "--auto-target") {
      options.autoTarget = true;
      continue;
    }

    if (arg === "--skip-build") {
      options.skipBuild = true;
      continue;
    }

    if (arg === "--keep-metro-foreground") {
      options.keepMetroForeground = true;
      continue;
    }

    if (arg === "--clear-metro-cache") {
      options.clearMetroCache = true;
      continue;
    }

    if (arg === "--transfer-metro-ownership") {
      options.transferMetroOwnership = readCliValue(argv, ++index, "--transfer-metro-ownership");
      continue;
    }

    if (arg === "--avd") {
      options.avd = readCliValue(argv, ++index, "--avd");
      continue;
    }

    if (arg === "--serial") {
      options.serial = readCliValue(argv, ++index, "--serial");
      continue;
    }

    if (arg === "--port") {
      options.port = readCliValue(argv, ++index, "--port");
      continue;
    }

    if (arg === "--launch-delay-ms") {
      options.launchDelayMs = readCliValue(argv, ++index, "--launch-delay-ms");
      continue;
    }

    if (arg === "--apk-variant") {
      options.apkVariant = readCliValue(argv, ++index, "--apk-variant");
      continue;
    }

    if (arg === "--target-abi") {
      options.targetAbi = parseTargetAbi(readCliValue(argv, ++index, "--target-abi"));
      continue;
    }

    if (arg === "--screenshot") {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) {
        options.screenshot = path.join("artifacts", "android-smoke.png");
      } else {
        options.screenshot = next;
        index += 1;
      }
      continue;
    }

    if (arg === "--help") {
      printHelp();
      process.exit(0);
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  if (options.keepMetroForeground && options.transferMetroOwnership) {
    throw new Error("--keep-metro-foreground cannot be combined with --transfer-metro-ownership.");
  }
  if (process.platform === "win32" && options.transferMetroOwnership) {
    throw new Error(
      "--transfer-metro-ownership is not supported on Windows; the parent runner must own Metro directly."
    );
  }

  return options;
}

function readCliValue(argv, index, flagName) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flagName} requires a value.`);
  }

  return value;
}

function printHelp() {
  console.log("Usage: node ./scripts/android-smoke.js [options]");
  console.log("");
  console.log("Options:");
  console.log("  --emulator                 Use an Android emulator instead of a connected phone");
  console.log("  --auto-target              Prefer a phone, then reuse or start an emulator");
  console.log("  --avd <name>               Use a specific AVD when launching an emulator");
  console.log("  --serial <serial>          Target a specific connected device");
  console.log("  --port <number>            First Metro port to probe");
  console.log("  --skip-build               Reuse the existing APK");
  console.log("  --keep-metro-foreground    Keep an owned Metro attached until Ctrl+C");
  console.log("  --clear-metro-cache        Start a fresh Metro and reset its disk cache");
  console.log("  --transfer-metro-ownership <path> Internal: hand an owned Metro PID to a parent runner");
  console.log("  --apk-variant <variant>    Install debug or release APK (default: debug)");
  console.log("  --target-abi <abi>         Build and verify universal, arm64-v8a, or x86_64");
  console.log("  --screenshot [path]        Save a screenshot after launch");
  console.log("  --launch-delay-ms <ms>     Wait time before saving a screenshot");
}

function parsePositiveInteger(value, label) {
  const parsed = Number.parseInt(`${value}`, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${label}: ${value}`);
  }

  return parsed;
}

function parseApkVariant(value) {
  const normalized = `${value || "debug"}`.trim().toLowerCase();
  if (normalized !== "debug" && normalized !== "release") {
    throw new Error(`Invalid Android APK variant: ${value}`);
  }

  return normalized;
}

function parseTargetAbi(value) {
  const normalized = `${value || "universal"}`.trim().toLowerCase();
  if (!supportedAndroidTargetAbis.includes(normalized)) {
    throw new Error(
      `Invalid Android target ABI: ${value}. Expected one of ${supportedAndroidTargetAbis.join(", ")}.`
    );
  }
  return normalized;
}

function buildGradleAssembleArgs(assembleTask, targetAbi = "universal") {
  const normalizedAssembleTask = `${assembleTask || ""}`.trim();
  if (!normalizedAssembleTask) {
    throw new Error("Android Gradle provenance requires an explicit assemble task.");
  }
  const normalizedTargetAbi = parseTargetAbi(targetAbi);
  const buildArgs = normalizedTargetAbi === "universal"
    ? [normalizedAssembleTask]
    : [normalizedAssembleTask, `-PreactNativeArchitectures=${normalizedTargetAbi}`];
  return withAndroidProvenanceGradleExecutionArgs(buildArgs);
}

function assertSmokeBuildOverrideContract(gradleArgs = null, options = {}) {
  const resolvedAbi = options.abi || buildTargetAbi;
  const resolvedVariant = options.variant || apkVariant;
  const resolvedGradleArgs = gradleArgs || buildGradleAssembleArgs(
    `app:assemble${resolvedVariant[0].toUpperCase()}${resolvedVariant.slice(1)}`,
    resolvedAbi
  );
  assertAndroidBuildOverrideContract(options.projectRoot || projectRoot, {
    ...options,
    abi: resolvedAbi,
    variant: resolvedVariant,
    env: options.env || androidBuildEnvironment,
    gradleArgs: resolvedGradleArgs,
  });
}

function isEmulatorSerial(serial) {
  return serial.startsWith("emulator-");
}

function log(message) {
  console.log(`[android-smoke] ${message}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function wakeAndUnlockDevice(adbPath, serial) {
  runChecked(adbPath, ["-s", serial, "shell", "input", "keyevent", "224"], {
    stdio: "ignore",
    allowFailure: true,
  });
  runChecked(adbPath, ["-s", serial, "shell", "wm", "dismiss-keyguard"], {
    stdio: "ignore",
    allowFailure: true,
  });
  runChecked(adbPath, ["-s", serial, "shell", "input", "keyevent", "82"], {
    stdio: "ignore",
    allowFailure: true,
  });
}

module.exports = {
  assertSmokeBuildOverrideContract,
  areStringArraysEqual,
  buildGradleAssembleArgs,
  buildMetroBundlePath,
  buildMetroReverseSpecs,
  buildMetroStartArgs,
  buildWindowsProcessCommandLine,
  captureOwnedProcessOwnership,
  captureAndroidScreenshot,
  cleanupOwnedMetroAfterStartupFailure,
  createOwnedMetroProcessLifecycle,
  evaluateApkReuse,
  evaluateApkAbiCompatibility,
  evaluateInstallReuse,
  ensureMetroServer,
  isInsufficientStorageInstallFailure,
  isAppJsReadyUiHierarchy,
  parseDumpsysPackageOutput,
  parseAndroidPackageUid,
  parseAndroidProcessId,
  parseSha256Output,
  parseCliOptions,
  parseApkVariant,
  parseTargetAbi,
  parsePackagePathOutput,
  readProcessIdentity,
  readAndroidUiHierarchy,
  readWindowsProcessTreeIdentities,
  sanitizeForFileName,
  resolvePackagedAndroidAbis,
  runAndroidGradleBuild,
  saveLogcat,
  spawnOwnedProcess,
  spawnWindowsJobProcess,
  stopOwnedMetroProcess,
  stopOwnedMetroProcessOrThrow,
  stopOwnedProcessTreeByPid,
  waitForAppJsReady,
  waitForAttachedMetroExit,
};
