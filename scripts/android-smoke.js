#!/usr/bin/env node

const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const cliOptions = parseCliOptions(process.argv.slice(2));
const projectRoot = path.resolve(__dirname, "..");
const artifactsRoot = path.join(projectRoot, "artifacts", "android-scenarios");
const androidRoot = path.join(projectRoot, "android");
const localPropertiesPath = path.join(androidRoot, "local.properties");
const appConfigPath = path.join(projectRoot, "app.json");
const packageJsonPath = path.join(projectRoot, "package.json");
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
  "debug",
  "app-debug.apk"
);
const requiredNativeLibraries = ["libreactnative.so"];
const metroStartupTimeoutMs = 90_000;
const deviceStartupTimeoutMs = 180_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const launchDelayMs = parsePositiveInteger(
  cliOptions.launchDelayMs ?? process.env.ANDROID_SMOKE_LAUNCH_DELAY_MS ?? "4000",
  "launch delay"
);
const preferredPort = parsePositiveInteger(
  cliOptions.port ?? process.env.ANDROID_SMOKE_PORT ?? "8081",
  "Metro port"
);
const maxPort = preferredPort + 9;
const screenshotTarget =
  cliOptions.screenshot ?? process.env.ANDROID_SMOKE_SCREENSHOT ?? null;
const screenshotPath = screenshotTarget
  ? path.resolve(projectRoot, screenshotTarget)
  : null;

main().catch((error) => {
  console.error(`[android-smoke] ${error.message}`);
  process.exit(1);
});

async function main() {
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
    } else {
      throw new Error("Connect a phone and try again. No physical Android device is connected.");
    }
  }

  log(`Using Android target ${device.serial}${device.model ? ` (${device.model})` : ""}.`);
  wakeAndUnlockDevice(tools.adb, device.serial);

  const wantsSkipBuild = cliOptions.skipBuild || process.env.ANDROID_SKIP_BUILD === "1";
  let didBuildDebugApk = false;
  if (wantsSkipBuild && fs.existsSync(apkPath)) {
    const reuseDecision = resolveDebugApkReuseDecision(tools.adb, device.serial, apkPath);
    if (reuseDecision.canReuse) {
      const abiLabel = reuseDecision.matchedAbi ? ` for ABI ${reuseDecision.matchedAbi}` : "";
      log(`Skipping Gradle build and reusing the existing debug APK${abiLabel}.`);
    } else {
      const abiLabel = reuseDecision.supportedAbis.length > 0
        ? reuseDecision.supportedAbis.join(", ")
        : "unknown target ABI";
      const missingLabel = reuseDecision.missingEntries.length > 0
        ? ` Missing entries: ${reuseDecision.missingEntries.join(", ")}.`
        : "";
      log(
        `Requested --skip-build, but the existing debug APK is incompatible with ${abiLabel}.${missingLabel} Rebuilding instead.`
      );
      buildDebugApk();
      didBuildDebugApk = true;
    }
  } else {
    buildDebugApk();
    didBuildDebugApk = true;
  }

  if (!fs.existsSync(apkPath)) {
    throw new Error(`Expected debug APK at ${apkPath}, but it was not found.`);
  }

  const metro = await ensureMetroServer();

  installDebugApk(tools.adb, device.serial, appPackage, {
    allowReuseExistingInstallOnLowStorage: !didBuildDebugApk,
  });
  reverseMetroPort(tools.adb, device.serial, metro.port);

  runCapture(tools.adb, ["-s", device.serial, "logcat", "-c"], { allowFailure: true });
  launchDevClient(tools.adb, device.serial, appPackage, appScheme, metro.port);

  if (screenshotPath) {
    await delay(launchDelayMs);
    wakeAndUnlockDevice(tools.adb, device.serial);
    saveScreenshot(tools.adb, device.serial, screenshotPath);

    const logcatPath = path.join(path.dirname(screenshotPath), "bootstrap-logcat.txt");
    saveLogcat(tools.adb, device.serial, logcatPath);
  }

  log(
    `Android smoke check finished on ${device.serial} using Metro port ${metro.port}.`
  );
  log(
    metro.started
      ? `Started Metro in the background on port ${metro.port}.`
      : `Reused an existing Metro server on port ${metro.port}.`
  );

  if (screenshotPath) {
    log(`Saved screenshot to ${screenshotPath}.`);
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

function resolveDebugApkReuseDecision(adbPath, serial, apkFilePath) {
  try {
    const primaryAbi = resolvePrimaryDeviceAbi(adbPath, serial);
    const supportedAbis = resolveDeviceSupportedAbis(adbPath, serial, primaryAbi);
    if (!primaryAbi) {
      return {
        canReuse: false,
        matchedAbi: null,
        supportedAbis,
        missingEntries: [],
      };
    }

    const zipEntries = new Set(listZipEntries(apkFilePath));
    const missingEntries = requiredNativeLibraries
      .map((library) => `lib/${primaryAbi}/${library}`)
      .filter((entryName) => !zipEntries.has(entryName));

    if (missingEntries.length === 0) {
      return {
        canReuse: true,
        matchedAbi: primaryAbi,
        supportedAbis,
        missingEntries: [],
      };
    }

    return {
      canReuse: false,
      matchedAbi: null,
      supportedAbis,
      missingEntries,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Failed to inspect the existing debug APK for ABI compatibility (${message}). Rebuilding instead.`);
    return {
      canReuse: false,
      matchedAbi: null,
      supportedAbis: [],
      missingEntries: [],
    };
  }
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

function listZipEntries(zipFilePath) {
  const zipBuffer = fs.readFileSync(zipFilePath);
  const eocdSignature = 0x06054b50;
  const centralDirectoryHeaderSignature = 0x02014b50;
  const minimumEocdSize = 22;
  const maxCommentLength = 0xffff;
  const searchStart = Math.max(0, zipBuffer.length - minimumEocdSize - maxCommentLength);

  let eocdOffset = -1;
  for (let offset = zipBuffer.length - minimumEocdSize; offset >= searchStart; offset -= 1) {
    if (zipBuffer.readUInt32LE(offset) === eocdSignature) {
      eocdOffset = offset;
      break;
    }
  }

  if (eocdOffset < 0) {
    throw new Error(`Could not find the ZIP central directory in ${zipFilePath}.`);
  }

  const centralDirectorySize = zipBuffer.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = zipBuffer.readUInt32LE(eocdOffset + 16);
  const entries = [];
  let offset = centralDirectoryOffset;
  const directoryEnd = centralDirectoryOffset + centralDirectorySize;

  while (offset < directoryEnd) {
    if (zipBuffer.readUInt32LE(offset) !== centralDirectoryHeaderSignature) {
      throw new Error(`Unexpected ZIP central directory header at offset ${offset}.`);
    }

    const fileNameLength = zipBuffer.readUInt16LE(offset + 28);
    const extraFieldLength = zipBuffer.readUInt16LE(offset + 30);
    const fileCommentLength = zipBuffer.readUInt16LE(offset + 32);
    const fileNameOffset = offset + 46;
    const fileNameEnd = fileNameOffset + fileNameLength;

    entries.push(zipBuffer.toString("utf8", fileNameOffset, fileNameEnd));
    offset = fileNameEnd + extraFieldLength + fileCommentLength;
  }

  return entries;
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

async function ensureMetroServer() {
  for (let port = preferredPort; port <= maxPort; port += 1) {
    if (await isMetroRunning(port)) {
      return { port, started: false };
    }

    if (await isPortFree(port)) {
      log(`Starting Metro on port ${port}...`);

      const metroProcess = startMetroProcess(port);

      metroProcess.unref();
      await waitForMetro(port, metroStartupTimeoutMs);
      return { port, started: true };
    }
  }

  throw new Error(
    `Could not find a reusable or free Metro port in the ${preferredPort}-${maxPort} range.`
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

function startMetroProcess(port) {
  const env = {
    ...process.env,
    CI: process.env.CI || "1",
    EXPO_NO_INTERACTIVE: "1",
    NODE_ENV: process.env.NODE_ENV || "development",
  };

  // On Windows, `--localhost` can cause Expo/Metro to bind to ::1 only, while the
  // smoke runner expects the /status endpoint on 127.0.0.1. Prefer IPv4 for
  // deterministic local connectivity and adb reverse behavior.
  env.NODE_OPTIONS = withDnsResultOrderIpv4First(env.NODE_OPTIONS);

  fs.mkdirSync(artifactsRoot, { recursive: true });
  const metroLogPath = path.join(artifactsRoot, `metro-${port}.log`);
  const metroLogFd = fs.openSync(metroLogPath, "w");

  if (process.platform === "win32") {
    const command = `npm run start -- --dev-client --localhost --port ${port}`;
    return spawn(
      process.env.ComSpec || process.env.COMSPEC || "cmd.exe",
      ["/d", "/s", "/c", command],
      {
        cwd: projectRoot,
        detached: true,
        stdio: ["ignore", metroLogFd, metroLogFd],
        env,
        windowsHide: true,
      }
    );
  }

  return spawn(
    "npm",
    ["run", "start", "--", "--dev-client", "--localhost", "--port", `${port}`],
    {
      cwd: projectRoot,
      detached: true,
      stdio: ["ignore", metroLogFd, metroLogFd],
      env,
    }
  );
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

function buildDebugApk() {
  ensureAndroidNativeProject();
  ensureGradleWrapperExecutable();
  log("Building Android debug APK...");

  if (process.platform === "win32") {
    runChecked(
      process.env.ComSpec || process.env.COMSPEC || "cmd.exe",
      ["/d", "/s", "/c", "gradlew.bat app:assembleDebug"],
      {
        cwd: androidRoot,
        stdio: "inherit",
      }
    );
    return;
  }

  runChecked(gradleWrapperPath, ["app:assembleDebug"], {
    cwd: androidRoot,
    stdio: "inherit",
  });
}

function ensureAndroidNativeProject() {
  if (fs.existsSync(gradleWrapperPath)) {
    return;
  }

  log("Android native project not found. Generating it with Expo prebuild...");
  runChecked(
    resolveNpxCommand(),
    ["expo", "prebuild", "--platform", "android", "--no-install"],
    {
      cwd: projectRoot,
      stdio: "inherit",
    }
  );

  if (!fs.existsSync(gradleWrapperPath)) {
    throw new Error(
      `Expected Gradle wrapper at ${gradleWrapperPath} after Expo prebuild, but it was not found.`
    );
  }
}

function ensureGradleWrapperExecutable() {
  if (process.platform === "win32") {
    return;
  }

  fs.chmodSync(gradleWrapperPath, 0o755);
}

function resolveNpxCommand() {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

function isPackageInstalled(adbPath, serial, appPackage) {
  const output = runCapture(
    adbPath,
    ["-s", serial, "shell", "pm", "path", appPackage],
    { allowFailure: true }
  ).trim();

  return output.startsWith("package:");
}

function installDebugApk(adbPath, serial, appPackage, options = {}) {
  log("Installing debug APK...");
  const allowReuseExistingInstallOnLowStorage =
    options.allowReuseExistingInstallOnLowStorage !== false;

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
    return;
  }

  if (isInsufficientStorageInstallFailure(output)) {
    if (!allowReuseExistingInstallOnLowStorage) {
      throw new Error(
        "Android target storage is insufficient and the freshly built debug APK could not be installed. " +
          "Free space on the device/emulator (or uninstall the existing app) and retry."
      );
    }

    log("APK install failed due to insufficient storage. Attempting to reuse the existing app installation...");

    if (isPackageInstalled(adbPath, serial, appPackage)) {
      log("Existing installation detected. Continuing without reinstalling the debug APK.");
      return;
    }

    throw new Error(
      "Android target storage is insufficient and the app is not currently installed. " +
        "Free space on the device/emulator (or wipe the emulator) and retry."
    );
  }

  const trimmed = output.trim();
  throw new Error(
    `Command failed: ${adbPath} -s ${serial} install -r ${apkPath}${trimmed ? `\n${trimmed}` : ""}`
  );
}

function isInsufficientStorageInstallFailure(output) {
  const normalizedOutput = (output || "").toLowerCase();
  return normalizedOutput.includes("install_failed_insufficient_storage")
    || normalizedOutput.includes("insufficient storage")
    || normalizedOutput.includes("not enough space");
}

function reverseMetroPort(adbPath, serial, port) {
  log(`Reversing device port ${port} to localhost:${port}...`);
  runChecked(adbPath, ["-s", serial, "reverse", `tcp:${port}`, `tcp:${port}`], {
    stdio: "inherit",
  });
}

function launchDevClient(adbPath, serial, appPackage, appScheme, port) {
  if (!hasExpoDevClientDependency()) {
    log("Launching the Android debug app...");
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

function saveLogcat(adbPath, serial, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const logs = runCapture(
    adbPath,
    ["-s", serial, "logcat", "-d", "-v", "time", "-t", "800"],
    { allowFailure: true }
  );

  fs.writeFileSync(outputPath, logs);
  log(`Saved logcat to ${outputPath}.`);
}

function captureAndroidScreenshot(adbPath, serial, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const directCapture = spawnSync(
    adbPath,
    ["-s", serial, "exec-out", "screencap", "-p"],
    {
      maxBuffer: 20 * 1024 * 1024,
    }
  );

  if (directCapture.error) {
    throw directCapture.error;
  }

  if (directCapture.status === 0 && isPngBuffer(directCapture.stdout)) {
    fs.writeFileSync(outputPath, directCapture.stdout);
    return;
  }

  log("Direct screencap failed; retrying screenshot capture via a temporary device file.");

  const remotePath = `/data/local/tmp/pocket-ai-qa-${process.pid}-${Date.now()}.png`;
  const remoteCapture = spawnSync(
    adbPath,
    ["-s", serial, "shell", "screencap", "-p", remotePath],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  if (remoteCapture.error) {
    throw remoteCapture.error;
  }

  try {
    if (remoteCapture.status !== 0) {
      throw new Error("Failed to capture an Android screenshot.");
    }

    const pullResult = spawnSync(
      adbPath,
      ["-s", serial, "pull", remotePath, outputPath],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    if (pullResult.error) {
      throw pullResult.error;
    }

    if (pullResult.status !== 0) {
      throw new Error("Failed to capture an Android screenshot.");
    }

    const screenshotBuffer = fs.readFileSync(outputPath);
    if (!isPngBuffer(screenshotBuffer)) {
      throw new Error("Failed to capture an Android screenshot.");
    }
  } finally {
    runChecked(
      adbPath,
      ["-s", serial, "shell", "rm", "-f", remotePath],
      { stdio: "ignore", allowFailure: true }
    );
  }
}

function isPngBuffer(value) {
  return Buffer.isBuffer(value)
    && value.length >= PNG_SIGNATURE.length
    && value.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
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
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--emulator") {
      options.emulator = true;
      continue;
    }

    if (arg === "--skip-build") {
      options.skipBuild = true;
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
  console.log("  --avd <name>               Use a specific AVD when launching an emulator");
  console.log("  --serial <serial>          Target a specific connected device");
  console.log("  --port <number>            First Metro port to probe");
  console.log("  --skip-build               Reuse the existing debug APK");
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
