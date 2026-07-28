const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const {
  BUILD_PROVENANCE_SCHEMA_VERSION,
  assertAndroidReleaseArtifactCreated,
  assertAndroidBuildOverrideContract,
  buildAndroidCleanPrebuildArgs,
  collectAndroidNativeProjectState,
  collectAndroidEffectiveBuildContext,
  collectBuildProvenance,
  collectPrebuildInputState,
  cleanAndroidNativeBuildIntermediates,
  createAndroidShippingBuildEnvironment,
  createIsolatedAndroidBuildEnvironment,
  createFileContentFingerprint,
  formatAndroidGradleCommandForLog,
  inspectAndroidArtifactNativeLibraries,
  parseGradleProjectProperties,
  resolveAndroidGradleWrapperInvocation,
  resolveAndroidReleaseTaskContract,
  resolveExpoCliInvocation,
  resolvePrebuildStampPaths,
  runAndroidReleaseArtifactTransaction,
  shouldRunPrebuild,
  withAndroidProvenanceGradleExecutionArgs,
} = require("./android-build-provenance");

const projectRoot = path.resolve(__dirname, "..");
const appConfigPath = path.join(projectRoot, "app.json");
const artifactsRoot = path.join(projectRoot, "artifacts", "android-release");
const cacheRoot = path.join(projectRoot, "node_modules", ".cache", "pocket-ai-android");
const {
  activeStampPath: activePrebuildStampPath,
  variantStampPath: prebuildStampPath,
} = resolvePrebuildStampPaths(cacheRoot, "release");
const releaseProvenancePath = path.join(artifactsRoot, "build-provenance-release-universal.json");
const ANDROID_VERSION_CODE_MAX = 2_100_000_000;
const releaseBuildEnvironment = createIsolatedAndroidBuildEnvironment(
  projectRoot,
  createAndroidShippingBuildEnvironment(projectRoot, process.env, {
    forceProductionNodeEnv: true,
  })
);
const args = process.argv.slice(2);
let clean = false;
let bump = true;
let task = "app:bundleRelease";
let versionCode;
let versionName;
const gradleArgs = [];

function readCliValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (value == null || !`${value}`.trim() || `${value}`.trimStart().startsWith("-")) {
    throw new Error(`${optionName} requires a value.`);
  }
  return `${value}`;
}

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];

  if (arg === "--clean") {
    clean = true;
    continue;
  }

  if (arg === "--no-bump") {
    bump = false;
    continue;
  }

  if (arg === "--task") {
    task = readCliValue(args, index, "--task");
    index += 1;
    continue;
  }

  if (arg === "--version-code") {
    versionCode = readCliValue(args, index, "--version-code");
    index += 1;
    continue;
  }

  if (arg === "--version-name") {
    versionName = readCliValue(args, index, "--version-name");
    index += 1;
    continue;
  }

  gradleArgs.push(arg);
}

const requestedVersionCode = versionCode == null
  ? null
  : parsePositiveInt(versionCode, "Android versionCode");
const releaseTaskContract = resolveAndroidReleaseTaskContract(task);
task = releaseTaskContract.gradleTask;

const additionalGradleProperties = parseGradleProjectProperties(gradleArgs);
for (const reservedProperty of ["pocketAiVersionCode", "pocketAiVersionName"]) {
  if (Object.prototype.hasOwnProperty.call(additionalGradleProperties, reservedProperty)) {
    throw new Error(
      `Do not override ${reservedProperty} through raw Gradle arguments; use --version-code or --version-name.`
    );
  }
}

assertAndroidBuildOverrideContract(projectRoot, {
  abi: "universal",
  variant: "release",
  env: releaseBuildEnvironment,
  gradleArgs,
});

function readAppConfig() {
  return JSON.parse(fs.readFileSync(appConfigPath, "utf8"));
}

function writeAppConfig(config) {
  writeJsonAtomic(appConfigPath, config);
}

function parsePositiveInt(value, label) {
  const normalized = `${value}`.trim();
  if (!/^[1-9]\d*$/u.test(normalized)) {
    throw new Error(`${label} must be a positive integer. Received: ${value}`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${label} must be a safe positive integer. Received: ${value}`);
  }
  if (parsed > ANDROID_VERSION_CODE_MAX) {
    throw new Error(`${label} must not exceed the Android publication limit of 2100000000.`);
  }
  return parsed;
}

const appConfig = readAppConfig();
const expoConfig = appConfig.expo ?? {};
const androidConfig = expoConfig.android ?? {};
const resolvedVersionName = versionName ?? expoConfig.version;

if (!resolvedVersionName) {
  console.error("Missing expo.version in app.json. Set it before building a production Android bundle.");
  process.exit(1);
}

const storedVersionCode = parsePositiveInt(androidConfig.versionCode ?? 1, "app.json expo.android.versionCode");
const resolvedVersionCode = requestedVersionCode ?? storedVersionCode;
const shouldReserveNextVersionCode = bump && releaseTaskContract.shouldBumpVersionCode;
if (shouldReserveNextVersionCode && resolvedVersionCode === ANDROID_VERSION_CODE_MAX) {
  throw new Error(
    "Cannot auto-reserve an Android versionCode after the publication limit of 2100000000. Use --no-bump only when this is intentionally the final publication code."
  );
}

const androidDir = path.join(projectRoot, "android");
const gradleWrapper = path.join(
  androidDir,
  process.platform === "win32" ? "gradlew.bat" : "gradlew"
);

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(temporaryPath, filePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function ensureReleasePrebuild() {
  const inputState = collectPrebuildInputState(projectRoot, {
    variant: "release",
    nodeEnv: releaseBuildEnvironment.NODE_ENV,
    env: releaseBuildEnvironment,
  });
  const nativeProjectState = collectAndroidNativeProjectState(projectRoot);
  const activePrebuildStamp = readJsonFile(activePrebuildStampPath);
  if (!shouldRunPrebuild({
    gradleWrapperExists: fs.existsSync(gradleWrapper),
    activeStamp: activePrebuildStamp,
    inputState,
    nativeProjectState,
    variant: "release",
  })) {
    return inputState;
  }

  const expoCli = resolveExpoCliInvocation(projectRoot);
  console.log("Regenerating Android native sources from verified Expo/config-plugin inputs...");
  fs.rmSync(activePrebuildStampPath, { force: true });
  const result = spawnSync(
    expoCli.command,
    [...expoCli.args, ...buildAndroidCleanPrebuildArgs()],
    {
      cwd: projectRoot,
      env: {
        ...releaseBuildEnvironment,
      },
      stdio: "inherit",
    }
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0 || !fs.existsSync(gradleWrapper)) {
    console.error("Expo prebuild did not produce a usable Android Gradle wrapper.");
    process.exit(result.status || 1);
  }

  const verifiedInputState = collectPrebuildInputState(projectRoot, {
    variant: "release",
    nodeEnv: releaseBuildEnvironment.NODE_ENV,
    env: releaseBuildEnvironment,
  });
  if (verifiedInputState.digest !== inputState.digest) {
    throw new Error(
      "Expo/config-plugin inputs changed while prebuild was running; refusing to stamp generated native sources."
    );
  }

  const verifiedNativeProjectState = collectAndroidNativeProjectState(projectRoot);
  const verifiedPrebuildStamp = {
    schemaVersion: BUILD_PROVENANCE_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    variant: "release",
    inputDigest: verifiedInputState.digest,
    nativeInputDigest: verifiedNativeProjectState.digest,
    context: verifiedInputState.context,
    inputs: verifiedInputState.entries,
  };
  writeJsonAtomic(prebuildStampPath, verifiedPrebuildStamp);
  writeJsonAtomic(activePrebuildStampPath, verifiedPrebuildStamp);
  return verifiedInputState;
}

const verifiedPrebuildInputState = ensureReleasePrebuild();
assertAndroidBuildOverrideContract(projectRoot, {
  abi: "universal",
  variant: "release",
  env: releaseBuildEnvironment,
  gradleArgs,
});
if (process.platform !== "win32") {
  fs.chmodSync(gradleWrapper, 0o755);
}

function normalizeSdkDirForLocalProperties(sdkDir) {
  if (process.platform === "win32") {
    return sdkDir.replace(/\\/g, "/");
  }

  return sdkDir;
}

function pathSeemsPresent(candidatePath) {
  try {
    fs.statSync(candidatePath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      return error.code !== "ENOENT";
    }
    return false;
  }
}

function resolveAndroidSdkDir() {
  const envSdkDir = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (envSdkDir && pathSeemsPresent(envSdkDir)) {
    return envSdkDir;
  }

  const homeDir = os.homedir();

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      const candidate = path.join(localAppData, "Android", "Sdk");
      if (pathSeemsPresent(candidate)) {
        return candidate;
      }
    }

    if (homeDir) {
      const candidate = path.join(homeDir, "AppData", "Local", "Android", "Sdk");
      if (pathSeemsPresent(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  if (process.platform === "darwin") {
    const candidate = path.join(homeDir, "Library", "Android", "sdk");
    if (pathSeemsPresent(candidate)) {
      return candidate;
    }

    return null;
  }

  const candidate = path.join(homeDir, "Android", "Sdk");
  if (pathSeemsPresent(candidate)) {
    return candidate;
  }

  return null;
}

function ensureAndroidLocalProperties(androidRootDir) {
  const localPropertiesPath = path.join(androidRootDir, "local.properties");
  const sdkDirValue = resolveAndroidSdkDir();

  if (!sdkDirValue) {
    const fileHint = path.relative(path.resolve(__dirname, ".."), localPropertiesPath);
    console.error("Android SDK location not found.");
    console.error(
      "Set ANDROID_HOME or ANDROID_SDK_ROOT, or create %s with a valid sdk.dir path.",
      fileHint
    );
    console.error("Example (Windows): sdk.dir=C:/Users/<you>/AppData/Local/Android/Sdk");
    console.error("Example (macOS): sdk.dir=/Users/<you>/Library/Android/sdk");
    console.error("Example (Linux): sdk.dir=/home/<you>/Android/Sdk");
    process.exit(1);
  }

  const normalizedSdkDir = normalizeSdkDirForLocalProperties(sdkDirValue);

  if (!fs.existsSync(localPropertiesPath)) {
    fs.writeFileSync(localPropertiesPath, `sdk.dir=${normalizedSdkDir}\n`);
    console.log("Wrote android/local.properties with the detected Android SDK path.");
    return;
  }

  const existing = fs.readFileSync(localPropertiesPath, "utf8");
  if (/^\s*sdk\.dir\s*=.+$/m.test(existing)) {
    return;
  }

  const suffix = existing.endsWith("\n") ? "" : "\n";
  fs.writeFileSync(localPropertiesPath, `${existing}${suffix}sdk.dir=${normalizedSdkDir}\n`);
  console.log("Added the detected Android SDK path to android/local.properties.");
}

ensureAndroidLocalProperties(androidDir);

const currentPrebuildInputState = collectPrebuildInputState(projectRoot, {
  variant: "release",
  nodeEnv: releaseBuildEnvironment.NODE_ENV,
  env: releaseBuildEnvironment,
});
if (currentPrebuildInputState.digest !== verifiedPrebuildInputState.digest) {
  throw new Error(
    "Expo/config-plugin inputs changed after native prebuild verification; retry the Android release build."
  );
}

const releaseGradleExecutionArgs = withAndroidProvenanceGradleExecutionArgs([
  ...(clean ? ["clean"] : []),
  task,
  `-PpocketAiVersionCode=${resolvedVersionCode}`,
  `-PpocketAiVersionName=${resolvedVersionName}`,
  ...gradleArgs,
]);

function collectReleaseBuildContext(prebuildInputDigest) {
  return {
    androidQaEvidence: false,
    task,
    clean,
    versionCode: resolvedVersionCode,
    versionName: resolvedVersionName,
    effectiveBuild: collectAndroidEffectiveBuildContext(projectRoot, {
      variant: "release",
      gradleArgs: releaseGradleExecutionArgs,
      env: releaseBuildEnvironment,
      versionDefaults: {
        versionCode: resolvedVersionCode,
        versionName: resolvedVersionName,
      },
    }),
    gradleArgumentCount: releaseGradleExecutionArgs.length,
    prebuildInputDigest,
  };
}

const buildProvenance = collectBuildProvenance(projectRoot, {
  variant: "release",
  abi: "universal",
  includeBundleInputs: true,
  androidRoot: androidDir,
  env: releaseBuildEnvironment,
  gradleArgs: releaseGradleExecutionArgs,
  buildContext: collectReleaseBuildContext(verifiedPrebuildInputState.digest),
});

const removedNativeIntermediateCount = cleanAndroidNativeBuildIntermediates(projectRoot);
if (removedNativeIntermediateCount > 0) {
  console.log(
    `Removed ${removedNativeIntermediateCount} generated native build intermediate directories before the provenance build.`
  );
}

const gradleInvocation = resolveAndroidGradleWrapperInvocation({
  platform: process.platform,
  comSpec: process.env.ComSpec || process.env.COMSPEC,
  gradleArgs: releaseGradleExecutionArgs,
  gradleWrapperPath: "./gradlew",
});
const { command, args: commandArgs } = gradleInvocation;

assertAndroidBuildOverrideContract(projectRoot, {
  abi: "universal",
  variant: "release",
  env: releaseBuildEnvironment,
  gradleArgs,
});
console.log(
  `Running Android release build: ${formatAndroidGradleCommandForLog({
    platform: process.platform,
    command,
    gradleArgs: releaseGradleExecutionArgs,
  })}`
);
console.log(`Using Android versionName=${resolvedVersionName} versionCode=${resolvedVersionCode}`);
runAndroidReleaseArtifactTransaction(
  projectRoot,
  releaseTaskContract,
  { provenancePath: releaseProvenancePath },
  (releaseArtifactPath) => {
    const result = spawnSync(command, commandArgs, {
      cwd: androidDir,
      env: releaseBuildEnvironment,
      stdio: "inherit",
    });

    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(`Android release Gradle execution failed with status ${result.status ?? 1}.`);
    }

    const postBuildPrebuildInputState = collectPrebuildInputState(projectRoot, {
      variant: "release",
      nodeEnv: releaseBuildEnvironment.NODE_ENV,
      env: releaseBuildEnvironment,
    });
    const postBuildProvenance = collectBuildProvenance(projectRoot, {
      variant: "release",
      abi: "universal",
      includeBundleInputs: true,
      androidRoot: androidDir,
      env: releaseBuildEnvironment,
      gradleArgs: releaseGradleExecutionArgs,
      buildContext: collectReleaseBuildContext(postBuildPrebuildInputState.digest),
    });
    if (postBuildProvenance.digest !== buildProvenance.digest) {
      throw new Error(
        "Android release inputs changed while Gradle was running; refusing ambiguous artifact provenance."
      );
    }

    assertAndroidReleaseArtifactCreated(releaseArtifactPath);
    const nativeArtifactInspection = inspectAndroidArtifactNativeLibraries(
      releaseArtifactPath,
      releaseTaskContract.artifactType
    );
    const artifactFingerprint = createFileContentFingerprint(releaseArtifactPath, projectRoot);
    writeJsonAtomic(releaseProvenancePath, {
      schemaVersion: BUILD_PROVENANCE_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      variant: releaseTaskContract.variant,
      abi: "universal",
      androidQaEvidence: false,
      provenanceDigest: buildProvenance.digest,
      provenance: buildProvenance,
      artifact: {
        type: releaseTaskContract.artifactType,
        path: artifactFingerprint.path,
        size: artifactFingerprint.size,
        sha256: artifactFingerprint.sha256,
        ...nativeArtifactInspection,
      },
    });
    console.log(
      `Android release provenance ready: ${path.relative(projectRoot, releaseProvenancePath)}`
    );

    if (shouldReserveNextVersionCode) {
      const nextVersionCode = Math.max(storedVersionCode, resolvedVersionCode + 1);
      if (androidConfig.versionCode !== nextVersionCode) {
        appConfig.expo = {
          ...expoConfig,
          android: {
            ...androidConfig,
            versionCode: nextVersionCode,
          },
        };
        writeAppConfig(appConfig);
        console.log(`Reserved next Android versionCode=${nextVersionCode} in app.json`);
      }
    }
  }
);

const bundlePath = path.join(
  androidDir,
  "app",
  "build",
  "outputs",
  "bundle",
  "release",
  "app-release.aab"
);

if (releaseTaskContract.artifactType === "aab" && fs.existsSync(bundlePath)) {
  console.log(`Android App Bundle ready: ${path.relative(projectRoot, bundlePath)}`);
}
