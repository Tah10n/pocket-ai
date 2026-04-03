const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const appConfigPath = path.resolve(__dirname, "..", "app.json");
const args = process.argv.slice(2);
let clean = false;
let bump = true;
let task = "bundleRelease";
let versionCode;
let versionName;
const gradleArgs = [];

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
    task = args[index + 1];
    index += 1;
    continue;
  }

  if (arg === "--version-code") {
    versionCode = args[index + 1];
    index += 1;
    continue;
  }

  if (arg === "--version-name") {
    versionName = args[index + 1];
    index += 1;
    continue;
  }

  gradleArgs.push(arg);
}

if (!task) {
  console.error("Missing Gradle task. Use --task <task-name>.");
  process.exit(1);
}

function readAppConfig() {
  return JSON.parse(fs.readFileSync(appConfigPath, "utf8"));
}

function writeAppConfig(config) {
  fs.writeFileSync(appConfigPath, `${JSON.stringify(config, null, 2)}\n`);
}

function parsePositiveInt(value, label) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    console.error(`${label} must be a positive integer. Received: ${value}`);
    process.exit(1);
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
const resolvedVersionCode = parsePositiveInt(versionCode ?? storedVersionCode, "Android versionCode");

const androidDir = path.resolve(__dirname, "..", "android");
const gradleWrapper = path.join(
  androidDir,
  process.platform === "win32" ? "gradlew.bat" : "gradlew"
);

if (!fs.existsSync(gradleWrapper)) {
  console.error(
    "Android native project not found. Generate it first with `npx expo prebuild --platform android`."
  );
  process.exit(1);
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
    console.log(`Wrote android/local.properties with sdk.dir=${normalizedSdkDir}`);
    return;
  }

  const existing = fs.readFileSync(localPropertiesPath, "utf8");
  if (/^\s*sdk\.dir\s*=.+$/m.test(existing)) {
    return;
  }

  const suffix = existing.endsWith("\n") ? "" : "\n";
  fs.writeFileSync(localPropertiesPath, `${existing}${suffix}sdk.dir=${normalizedSdkDir}\n`);
  console.log(`Appended sdk.dir=${normalizedSdkDir} to android/local.properties`);
}

ensureAndroidLocalProperties(androidDir);

const command = process.platform === "win32" ? "cmd.exe" : "./gradlew";
const commandArgs = process.platform === "win32" ? ["/c", "gradlew.bat"] : [];

if (clean) {
  commandArgs.push("clean");
}

commandArgs.push(task);

commandArgs.push(`-PpocketAiVersionCode=${resolvedVersionCode}`);
commandArgs.push(`-PpocketAiVersionName=${resolvedVersionName}`);

commandArgs.push(...gradleArgs);

console.log(`Running Android release build: ${[command, ...commandArgs].join(" ")}`);
console.log(`Using Android versionName=${resolvedVersionName} versionCode=${resolvedVersionCode}`);

const result = spawnSync(command, commandArgs, {
  cwd: androidDir,
  env: {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV || "production",
  },
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const normalizedTask = String(task).toLowerCase();
const shouldBump = bump && normalizedTask.includes("release") && normalizedTask.includes("bundle");

if (shouldBump) {
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

const bundlePath = path.join(
  androidDir,
  "app",
  "build",
  "outputs",
  "bundle",
  "release",
  "app-release.aab"
);

if (task.toLowerCase().includes("bundle") && fs.existsSync(bundlePath)) {
  console.log(`Android App Bundle ready: ${bundlePath}`);
}
