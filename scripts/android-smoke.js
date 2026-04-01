#!/usr/bin/env node

const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const cliOptions = parseCliOptions(process.argv.slice(2));
const projectRoot = path.resolve(__dirname, "..");
const androidRoot = path.join(projectRoot, "android");
const localPropertiesPath = path.join(androidRoot, "local.properties");
const appConfigPath = path.join(projectRoot, "app.json");
const apkPath = path.join(
  androidRoot,
  "app",
  "build",
  "outputs",
  "apk",
  "debug",
  "app-debug.apk"
);
const metroStartupTimeoutMs = 90_000;
const deviceStartupTimeoutMs = 180_000;
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
    device = await startEmulatorAndWait(tools, {
      requestedSerial,
      requestedAvd,
    });
  }

  log(`Using Android target ${device.serial}${device.model ? ` (${device.model})` : ""}.`);
  wakeAndUnlockDevice(tools.adb, device.serial);

  const metro = await ensureMetroServer();

  if ((cliOptions.skipBuild || process.env.ANDROID_SKIP_BUILD === "1") && fs.existsSync(apkPath)) {
    log("Skipping Gradle build and reusing the existing debug APK.");
  } else {
    buildDebugApk();
  }

  if (!fs.existsSync(apkPath)) {
    throw new Error(`Expected debug APK at ${apkPath}, but it was not found.`);
  }

  installDebugApk(tools.adb, device.serial);
  reverseMetroPort(tools.adb, device.serial, metro.port);
  launchDevClient(tools.adb, device.serial, appPackage, appScheme, metro.port);

  if (screenshotPath) {
    await delay(launchDelayMs);
    wakeAndUnlockDevice(tools.adb, device.serial);
    saveScreenshot(tools.adb, device.serial, screenshotPath);
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

  if (devices.length === 0) {
    return null;
  }

  if (devices.length > 1) {
    log(
      `Multiple Android targets are connected; defaulting to ${devices[0].serial}. Set ANDROID_SERIAL to override.`
    );
  }

  return devices[0];
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

    if (includeOffline) {
      const offlineDevice = matchingDevices.find(
        (candidate) => candidate.state === "offline"
      );
      if (offlineDevice) {
        return offlineDevice.serial;
      }
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

function startMetroProcess(port) {
  const env = {
    ...process.env,
    CI: process.env.CI || "1",
    EXPO_NO_INTERACTIVE: "1",
    NODE_ENV: process.env.NODE_ENV || "development",
  };

  if (process.platform === "win32") {
    const command = `npm run start -- --dev-client --localhost --port ${port}`;
    return spawn(
      process.env.ComSpec || process.env.COMSPEC || "cmd.exe",
      ["/d", "/s", "/c", command],
      {
        cwd: projectRoot,
        detached: true,
        stdio: "ignore",
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
      stdio: "ignore",
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

  runChecked(path.join(androidRoot, "gradlew"), ["app:assembleDebug"], {
    cwd: androidRoot,
    stdio: "inherit",
  });
}

function installDebugApk(adbPath, serial) {
  log("Installing debug APK...");
  runChecked(adbPath, ["-s", serial, "install", "-r", apkPath], {
    stdio: "inherit",
  });
}

function reverseMetroPort(adbPath, serial, port) {
  log(`Reversing device port ${port} to localhost:${port}...`);
  runChecked(adbPath, ["-s", serial, "reverse", `tcp:${port}`, `tcp:${port}`], {
    stdio: "inherit",
  });
}

function launchDevClient(adbPath, serial, appPackage, appScheme, port) {
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

function saveScreenshot(adbPath, serial, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const result = spawnSync(
    adbPath,
    ["-s", serial, "exec-out", "screencap", "-p"],
    {
      maxBuffer: 20 * 1024 * 1024,
    }
  );

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error("Failed to capture an Android screenshot.");
  }

  fs.writeFileSync(outputPath, result.stdout);
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
  console.log("  --emulator                 Prefer an Android emulator over physical devices");
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
