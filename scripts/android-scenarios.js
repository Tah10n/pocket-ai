#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const cliOptions = parseCliOptions(process.argv.slice(2));
const projectRoot = path.resolve(__dirname, "..");
const artifactsRoot = path.join(projectRoot, "artifacts", "android-scenarios");
const dumpPathOnDevice = "/sdcard/window_dump.xml";

main().catch((error) => {
  console.error(`[android-scenarios] ${error.message}`);
  process.exit(1);
});

async function main() {
  const scenarios = buildScenarios();

  if (cliOptions.list) {
    printScenarioList(scenarios);
    return;
  }

  const selectedScenarios = cliOptions.scenario
    ? scenarios.filter((scenario) => scenario.id === cliOptions.scenario)
    : scenarios;

  if (selectedScenarios.length === 0) {
    throw new Error(
      cliOptions.scenario
        ? `Unknown scenario "${cliOptions.scenario}". Run with --list to see available scenarios.`
        : "No scenarios were selected."
    );
  }

  fs.mkdirSync(artifactsRoot, { recursive: true });

  launchApp();

  const adbPath = resolveAdbPath();
  const serial = resolveTargetSerial(adbPath, cliOptions);
  const context = createScenarioContext(adbPath, serial);
  const results = [];

  await dismissDebuggerBannerIfPresent(adbPath, serial);

  for (const scenario of selectedScenarios) {
    const startedAt = Date.now();
    log(`Running scenario: ${scenario.id}`);

    try {
      await scenario.run(context);
      const screenshotPath = context.captureScreenshot(`${scenario.id}.png`);
      results.push({
        id: scenario.id,
        status: "passed",
        durationMs: Date.now() - startedAt,
        screenshotPath,
      });
      log(`PASS ${scenario.id}`);
    } catch (error) {
      const screenshotPath = context.captureScreenshot(`${scenario.id}-failed.png`);
      results.push({
        id: scenario.id,
        status: "failed",
        durationMs: Date.now() - startedAt,
        screenshotPath,
        error: error.message,
      });
      writeReport(results);
      throw error;
    }
  }

  writeReport(results);
  log(`Completed ${results.length} basic scenario(s).`);
}

function createScenarioContext(adbPath, serial) {
  return {
    serial,
    dismissDebuggerBanner: async () => {
      await dismissDebuggerBannerIfPresent(adbPath, serial);
    },
    tapText: async (label, options = {}) => {
      await dismissDebuggerBannerIfPresent(adbPath, serial);

      const node = await waitForNode(adbPath, serial, label, {
        timeoutMs: options.timeoutMs,
        visibleOnly: true,
      });

      if (!node.bounds) {
        throw new Error(`"${label}" was found but has no tap bounds.`);
      }

      const { centerX, centerY } = node.bounds;
      runChecked(adbPath, [
        "-s",
        serial,
        "shell",
        "input",
        "tap",
        `${centerX}`,
        `${centerY}`,
      ]);

      await delay(options.afterTapDelayMs ?? 800);
    },
    expectText: async (label, options = {}) => {
      await waitForNode(adbPath, serial, label, {
        timeoutMs: options.timeoutMs,
        visibleOnly: true,
      });
    },
    pressBack: async () => {
      runChecked(adbPath, ["-s", serial, "shell", "input", "keyevent", "4"]);
      await delay(700);
    },
    captureScreenshot: (fileName) => {
      const screenshotPath = path.join(artifactsRoot, fileName);
      fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });

      const result = spawnSync(
        adbPath,
        ["-s", serial, "exec-out", "screencap", "-p"],
        { maxBuffer: 20 * 1024 * 1024 }
      );

      if (result.error) {
        throw result.error;
      }

      if (result.status !== 0) {
        throw new Error("Failed to capture an Android screenshot.");
      }

      fs.writeFileSync(screenshotPath, result.stdout);
      return screenshotPath;
    },
  };
}

function buildScenarios() {
  return [
    {
      id: "home-smoke",
      description: "Verify the home screen loads and key call-to-actions are visible.",
      run: async (ctx) => {
        await goToHome(ctx);
        await ctx.expectText("Pocket AI");
        await ctx.expectText("New Chat");
        await ctx.expectText("Quick Actions");
        await ctx.expectText("Swap Model");
      },
    },
    {
      id: "bottom-tabs",
      description: "Verify bottom tab navigation across Home, Chat, Models, and Settings.",
      run: async (ctx) => {
        await goToHome(ctx);
        await ctx.tapText("Chat");
        await ctx.expectText("Load a model to continue chatting");
        await ctx.expectText("No messages yet");

        await ctx.tapText("Models");
        await ctx.expectText("Model Catalog");
        await ctx.expectText("All Models");
        await ctx.expectText("Downloaded");

        await ctx.tapText("Settings");
        await ctx.expectText("Theme Mode");
        await ctx.expectText("Language");
        await ctx.expectText("Device Storage");

        await ctx.tapText("Home");
        await ctx.expectText("Quick Actions");
      },
    },
    {
      id: "new-chat-cta",
      description: "Verify the Home screen New Chat button opens the chat screen empty state.",
      run: async (ctx) => {
        await goToHome(ctx);
        await ctx.tapText("New Chat");
        await ctx.expectText("Load a model to continue chatting");
        await ctx.expectText("No messages yet");
        await ctx.tapText("Home");
        await ctx.expectText("New Chat");
      },
    },
    {
      id: "swap-model-cta",
      description: "Verify the Home screen Swap Model CTA opens the model catalog.",
      run: async (ctx) => {
        await goToHome(ctx);
        await ctx.tapText("Swap Model");
        await ctx.expectText("Model Catalog");
        await ctx.expectText("All Models");
        await ctx.expectText("Downloaded");
        await ctx.tapText("Home");
        await ctx.expectText("Swap Model");
      },
    },
    {
      id: "all-conversations",
      description: "Verify the Home screen See All CTA opens the conversations management screen.",
      run: async (ctx) => {
        await goToHome(ctx);
        await ctx.tapText("See All");
        await ctx.expectText("All Conversations");
        await ctx.expectText("New Chat");
        await ctx.pressBack();
        await ctx.expectText("Pocket AI");
      },
    },
  ];
}

async function goToHome(ctx) {
  await ctx.dismissDebuggerBanner();

  const homeNode = await findNodeNow(resolveAdbPath(), ctx.serial, "Home");
  if (homeNode) {
    await ctx.tapText("Home", { afterTapDelayMs: 500 });
  }

  await ctx.expectText("Pocket AI");
}

function launchApp() {
  const args = [path.join(__dirname, "android-smoke.js"), "--screenshot", path.join("artifacts", "android-scenarios", "bootstrap.png")];

  if (cliOptions.emulator) {
    args.push("--emulator");
  }

  if (cliOptions.avd) {
    args.push("--avd", cliOptions.avd);
  }

  if (cliOptions.serial) {
    args.push("--serial", cliOptions.serial);
  }

  if (cliOptions.skipBuild) {
    args.push("--skip-build");
  }

  if (cliOptions.port) {
    args.push("--port", cliOptions.port);
  }

  const result = spawnSync(process.execPath, args, {
    cwd: projectRoot,
    stdio: "inherit",
    env: process.env,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error("Failed to launch the Android app before running scenarios.");
  }
}

function resolveAdbPath() {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    readSdkDirFromLocalProperties(),
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Android", "Sdk")
      : null,
  ]
    .filter(Boolean)
    .map((candidate) => path.resolve(candidate));

  const adbName = process.platform === "win32" ? "adb.exe" : "adb";

  for (const sdkRoot of candidates) {
    const adbPath = path.join(sdkRoot, "platform-tools", adbName);
    if (fs.existsSync(adbPath)) {
      return adbPath;
    }
  }

  throw new Error("Could not resolve adb. Ensure the Android SDK is installed.");
}

function readSdkDirFromLocalProperties() {
  const localPropertiesPath = path.join(projectRoot, "android", "local.properties");
  if (!fs.existsSync(localPropertiesPath)) {
    return null;
  }

  const content = fs.readFileSync(localPropertiesPath, "utf8");
  const match = content.match(/^sdk\.dir=(.+)$/m);
  return match ? match[1].trim().replace(/\\/g, "/") : null;
}

function resolveTargetSerial(adbPath, options) {
  const devices = listConnectedDevices(adbPath);

  if (options.serial) {
    const requested = devices.find((device) => device.serial === options.serial);
    if (!requested) {
      throw new Error(`Target device ${options.serial} is not connected.`);
    }
    return requested.serial;
  }

  if (options.emulator) {
    const emulator = devices.find((device) => device.serial.startsWith("emulator-"));
    if (!emulator) {
      throw new Error("No running emulator was found after launch.");
    }
    return emulator.serial;
  }

  if (devices.length === 0) {
    throw new Error("No Android device is connected.");
  }

  return devices[0].serial;
}

function listConnectedDevices(adbPath) {
  const output = runCapture(adbPath, ["devices", "-l"]);
  return output
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\S+)\s+(\S+)(?:\s+(.*))?$/);
      if (!match || match[2] !== "device") {
        return null;
      }

      return {
        serial: match[1],
      };
    })
    .filter(Boolean);
}

async function waitForNode(adbPath, serial, label, options = {}) {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const node = await findNodeNow(adbPath, serial, label, options);
    if (node) {
      return node;
    }

    await delay(600);
  }

  throw new Error(`Timed out waiting for text "${label}".`);
}

async function findNodeNow(adbPath, serial, label, options = {}) {
  const xml = dumpUiHierarchy(adbPath, serial);
  const nodes = parseUiNodes(xml);
  const matches = nodes.filter((node) => {
    if (!matchesLabel(node, label)) {
      return false;
    }

    if (options.visibleOnly && !node.bounds) {
      return false;
    }

    return true;
  });

  if (matches.length === 0) {
    return null;
  }

  return pickBestNode(matches);
}

function dumpUiHierarchy(adbPath, serial) {
  runChecked(adbPath, ["-s", serial, "shell", "uiautomator", "dump", dumpPathOnDevice], {
    stdio: "ignore",
  });

  return runCapture(adbPath, ["-s", serial, "exec-out", "cat", dumpPathOnDevice]);
}

function parseUiNodes(xml) {
  const nodes = [];
  const nodeRegex = /<node\b([^>]*?)(?:\/>|>)/g;
  let match = nodeRegex.exec(xml);

  while (match) {
    const rawAttributes = match[1];
    const attributes = {};
    const attrRegex = /([\w:-]+)="([^"]*)"/g;
    let attrMatch = attrRegex.exec(rawAttributes);

    while (attrMatch) {
      attributes[attrMatch[1]] = decodeXmlEntities(attrMatch[2]);
      attrMatch = attrRegex.exec(rawAttributes);
    }

    nodes.push({
      text: attributes.text || "",
      contentDesc: attributes["content-desc"] || "",
      clickable: attributes.clickable === "true",
      bounds: parseBounds(attributes.bounds),
    });

    match = nodeRegex.exec(xml);
  }

  return nodes;
}

function matchesLabel(node, label) {
  const normalizedLabel = normalizeUiLabel(label);
  const normalizedText = normalizeUiLabel(node.text);
  const normalizedContentDesc = normalizeUiLabel(node.contentDesc);

  return (
    node.text === label
    || node.contentDesc === label
    || node.contentDesc.endsWith(`, ${label}`)
    || node.contentDesc.includes(`, ${label},`)
    || normalizedText === normalizedLabel
    || normalizedContentDesc === normalizedLabel
    || normalizedContentDesc.endsWith(`, ${normalizedLabel}`)
    || normalizedContentDesc.includes(`, ${normalizedLabel},`)
  );
}

function normalizeUiLabel(value) {
  return (value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function pickBestNode(nodes) {
  return [...nodes].sort((left, right) => {
    const clickableDelta = Number(right.clickable) - Number(left.clickable);
    if (clickableDelta !== 0) {
      return clickableDelta;
    }

    const leftArea = left.bounds ? left.bounds.area : Number.MAX_SAFE_INTEGER;
    const rightArea = right.bounds ? right.bounds.area : Number.MAX_SAFE_INTEGER;
    return leftArea - rightArea;
  })[0];
}

function parseBounds(rawBounds) {
  if (!rawBounds) {
    return null;
  }

  const match = rawBounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!match) {
    return null;
  }

  const [, left, top, right, bottom] = match.map(Number);
  const width = right - left;
  const height = bottom - top;

  return {
    left,
    top,
    right,
    bottom,
    width,
    height,
    area: width * height,
    centerX: Math.round(left + width / 2),
    centerY: Math.round(top + height / 2),
  };
}

async function dismissDebuggerBannerIfPresent(adbPath, serial) {
  const xml = dumpUiHierarchy(adbPath, serial);
  const nodes = parseUiNodes(xml);
  const hasDebuggerBanner = nodes.some(
    (node) =>
      node.text === "Open debugger to view warnings."
      || node.contentDesc.includes("Open debugger to view warnings.")
  );

  if (!hasDebuggerBanner) {
    return;
  }

  const closeButton = [...nodes]
    .filter(
      (node) =>
        node.clickable
        && node.bounds
        && node.bounds.top > 2000
        && node.bounds.width <= 120
        && node.bounds.height <= 120
    )
    .sort((left, right) => right.bounds.centerX - left.bounds.centerX)[0];

  if (!closeButton) {
    return;
  }

  runChecked(adbPath, [
    "-s",
    serial,
    "shell",
    "input",
    "tap",
    `${closeButton.bounds.centerX}`,
    `${closeButton.bounds.centerY}`,
  ]);

  await delay(600);
}

function decodeXmlEntities(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#10;/g, "\n");
}

function writeReport(results) {
  const reportPath = path.join(artifactsRoot, "latest-report.json");
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        scenarioCount: results.length,
        results,
      },
      null,
      2
    )
  );
  log(`Wrote scenario report to ${reportPath}`);
}

function printScenarioList(scenarios) {
  console.log("Available Android scenarios:");
  for (const scenario of scenarios) {
    console.log(`- ${scenario.id}: ${scenario.description}`);
  }
}

function parseCliOptions(argv) {
  const options = {
    emulator: false,
    skipBuild: false,
    list: false,
    avd: null,
    serial: null,
    scenario: null,
    port: null,
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

    if (arg === "--list") {
      options.list = true;
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

    if (arg === "--scenario") {
      options.scenario = readCliValue(argv, ++index, "--scenario");
      continue;
    }

    if (arg === "--port") {
      options.port = readCliValue(argv, ++index, "--port");
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
  console.log("Usage: node ./scripts/android-scenarios.js [options]");
  console.log("");
  console.log("Options:");
  console.log("  --emulator                 Run scenarios on an Android emulator");
  console.log("  --avd <name>               Use a specific AVD when starting an emulator");
  console.log("  --serial <serial>          Target a specific connected device");
  console.log("  --scenario <id>            Run only one scenario");
  console.log("  --skip-build               Reuse the existing debug APK");
  console.log("  --port <number>            Forward a specific Metro port to android-smoke");
  console.log("  --list                     Print available scenarios");
}

function runCapture(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
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

  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
}

function log(message) {
  console.log(`[android-scenarios] ${message}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
