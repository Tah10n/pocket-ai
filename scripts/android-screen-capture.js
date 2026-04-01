#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const cliOptions = parseCliOptions(process.argv.slice(2));
const projectRoot = path.resolve(__dirname, "..");
const defaultArtifactsRoot = path.join(projectRoot, "artifacts", "android-screen-capture");
const artifactsRoot = cliOptions.outputDir
  ? path.resolve(projectRoot, cliOptions.outputDir)
  : defaultArtifactsRoot;
const dumpPathOnDevice = "/sdcard/window_dump.xml";
const homeLauncherLabel = "Pocket AI";
const HOME_SECTION_LABELS = ["Recent Conversations", "Недавние разговоры"];
const HOME_TAB_LABELS = ["Home", "Главная"];
const CHAT_TAB_LABELS = ["Chat", "Чат"];
const CHAT_EMPTY_LABELS = [
  "No messages yet",
  "Сообщений пока нет",
  "Load a model to continue chatting",
  "Загрузите модель, чтобы продолжить чат",
];
const MODELS_TAB_LABELS = ["Models", "Модели"];
const MODEL_CATALOG_LABELS = ["Model Catalog", "Каталог моделей"];
const ALL_MODELS_LABELS = ["All Models", "Все модели"];
const SETTINGS_TAB_LABELS = ["Settings", "Настройки"];
const SETTINGS_TITLE_LABELS = ["Settings", "Настройки"];
const THEME_MODE_LABELS = ["Theme Mode", "Тема"];
const LANGUAGE_ROW_LABELS = ["Language", "Язык"];
const SETTINGS_HF_TOKEN_LABELS = ["Hugging Face Token", "Токен Hugging Face"];
const MANAGE_CONVERSATIONS_LABELS = ["Manage", "Управлять"];
const CONVERSATIONS_TITLE_LABELS = ["All Conversations", "Все разговоры"];
const CONVERSATIONS_SEARCH_LABELS = ["Search conversations", "Поиск по разговорам"];
const MODEL_DETAILS_TITLE_LABELS = ["Model details", "Детали модели"];
const OPEN_ON_HF_LABELS = ["Open on HF", "Открыть на HF"];
const ACTIVE_MODEL_CTA_LABELS = ["Swap Model", "Choose Model", "Browse Models"];
const HOME_ROUTE_TIMEOUT_MS = 40_000;
const SETTINGS_ROUTE_TIMEOUT_MS = 35_000;
const defaultScreenIds = [
  "home",
  "chat",
  "models",
  "settings",
  "conversations",
  "presets",
  "storage",
  "legal",
  "huggingface-token",
  "model-details",
];

main().catch((error) => {
  console.error(`[android-screen-capture] ${error.message}`);
  process.exit(1);
});

async function main() {
  const screens = buildScreens();

  if (cliOptions.list) {
    printScreenList(screens);
    return;
  }

  const selectedScreens = selectScreens(screens, cliOptions.screens);
  fs.mkdirSync(artifactsRoot, { recursive: true });

  if (!cliOptions.skipLaunch) {
    launchApp();
  }

  const adbPath = resolveAdbPath();
  const serial = resolveTargetSerial(adbPath, cliOptions);
  const context = createCaptureContext(adbPath, serial);
  const results = [];

  await context.ensureAppVisible();
  const languageState = {
    originalLabel: await readCurrentLanguageLabel(context),
    switchedToEnglish: false,
  };

  let runError = null;

  try {
    await ensureEnglishUi(context, languageState);

    for (const screen of selectedScreens) {
      const startedAt = Date.now();
      log(`Capturing screen: ${screen.id}`);

      try {
        await screen.run(context);
        const screenshotPath = context.captureScreenshot(`${screen.id}.png`);
        results.push({
          id: screen.id,
          status: "captured",
          durationMs: Date.now() - startedAt,
          screenshotPath,
        });
        log(`CAPTURED ${screen.id}`);
      } catch (error) {
        const screenshotPath = context.captureScreenshot(`${screen.id}-failed.png`);
        results.push({
          id: screen.id,
          status: "failed",
          durationMs: Date.now() - startedAt,
          screenshotPath,
          error: error.message,
        });
        writeReport(serial, results);
        throw error;
      }
    }

    writeReport(serial, results);
    log(`Captured ${results.length} screen(s).`);
  } catch (error) {
    runError = error;
  } finally {
    try {
      await restoreOriginalLanguage(context, languageState);
    } catch (error) {
      log(`Failed to restore the original Android language: ${error.message}`);
      if (!runError) {
        runError = error;
      }
    }
  }

  if (runError) {
    throw runError;
  }
}

function buildScreens() {
  return [
    {
      id: "current",
      description: "Capture the currently visible screen without any navigation.",
      run: async (ctx) => {
        await ctx.dismissDebuggerBanner();
      },
    },
    {
      id: "home",
      description: "Capture the Home tab.",
      run: async (ctx) => {
        await goToHome(ctx);
        await ctx.expectText("Pocket AI");
        await ctx.expectText("New Chat");
        await ctx.expectText(HOME_SECTION_LABELS[0]);
        await ctx.expectAnyText(ACTIVE_MODEL_CTA_LABELS);
      },
    },
    {
      id: "chat",
      description: "Capture the Chat tab empty state.",
      run: async (ctx) => {
        await goToHome(ctx);
        await ctx.tapAnyText(CHAT_TAB_LABELS);
        await ctx.expectAnyText(CHAT_EMPTY_LABELS);
      },
    },
    {
      id: "models",
      description: "Capture the Models catalog tab.",
      run: async (ctx) => {
        await goToModelsCatalog(ctx);
      },
    },
    {
      id: "conversations",
      description: "Capture the conversation management screen.",
      run: async (ctx) => {
        await goToConversationManagement(ctx);
        await ctx.expectAnyText(CONVERSATIONS_TITLE_LABELS);
        await ctx.expectAnyText(CONVERSATIONS_SEARCH_LABELS);
      },
    },
    {
      id: "settings",
      description: "Capture the Settings tab.",
      run: async (ctx) => {
        await goToSettings(ctx);
        await ctx.expectText("Theme Mode");
        await ctx.expectText("Language");
      },
    },
    {
      id: "presets",
      description: "Capture the System Prompt Presets screen.",
      run: async (ctx) => {
        await goToSettings(ctx);
        await ctx.tapAnyText(["System Prompt Presets", "Пресеты системных промптов"]);
        await ctx.expectAnyText(["System Prompt Presets", "Пресеты системных промптов"]);
        await ctx.expectAnyText(["Add Preset", "Добавить пресет"]);
      },
    },
    {
      id: "storage",
      description: "Capture the Storage Manager screen.",
      run: async (ctx) => {
        await goToSettings(ctx);
        await ctx.tapAnyText(["Storage Manager", "Управление хранилищем"]);
        await ctx.expectAnyText(["Storage Manager", "Управление хранилищем"]);
        await ctx.expectAnyText(["Cleanup actions", "Действия очистки"]);
      },
    },
    {
      id: "legal",
      description: "Capture the Privacy & Disclosures screen.",
      run: async (ctx) => {
        await goToSettings(ctx);
        await ctx.tapAnyText(["Privacy & Disclosures", "Приватность и раскрытие данных"]);
        await ctx.expectAnyText(["Privacy & Disclosures", "Приватность и раскрытие данных"]);
        await ctx.expectAnyText([
          "Pocket AI is designed for local-first usage.",
          "Pocket AI спроектирован как local-first приложение.",
        ]);
      },
    },
    {
      id: "huggingface-token",
      description: "Capture the Hugging Face token education screen.",
      run: async (ctx) => {
        await goToHuggingFaceToken(ctx);
        await ctx.expectAnyText(SETTINGS_HF_TOKEN_LABELS);
        await ctx.expectText("Access token");
      },
    },
    {
      id: "model-details",
      description: "Capture the model details routed screen.",
      run: async (ctx) => {
        await goToModelDetails(ctx);
        await ctx.expectAnyText(MODEL_DETAILS_TITLE_LABELS);
        await ctx.expectAnyText(OPEN_ON_HF_LABELS);
      },
    },
  ];
}

async function goToHome(ctx) {
  await ctx.ensureAppVisible();
  await ctx.dismissDebuggerBanner();

  const reachedHome = await tryReachHome(ctx);

  if (!reachedHome) {
    throw new Error(`Timed out returning to Home from the current route.`);
  }

  await ctx.expectAnyText(HOME_SECTION_LABELS, { timeoutMs: HOME_ROUTE_TIMEOUT_MS });
  await ctx.expectText("Pocket AI");
}

async function tryReachHome(ctx, maxAttempts = 4) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const homeSectionNode = await ctx.findAnyNodeNow(HOME_SECTION_LABELS, { visibleOnly: true });
    if (homeSectionNode) {
      return true;
    }

    const launcherNode = await ctx.findNodeNow(homeLauncherLabel, { visibleOnly: true });
    if (launcherNode) {
      await ctx.tapText(homeLauncherLabel, {
        afterTapDelayMs: 1_500,
        timeoutMs: 5_000,
      });
      continue;
    }

    const homeTabNode = await ctx.findAnyNodeNow(HOME_TAB_LABELS, { visibleOnly: true });
    if (homeTabNode) {
      await ctx.tapAnyText(HOME_TAB_LABELS, { afterTapDelayMs: 500 });
      continue;
    }

    if (attempt < maxAttempts - 1) {
      await ctx.pressBack();
      await ctx.dismissDebuggerBanner();
    }
  }

  return false;
}

async function goToModelsCatalog(ctx) {
  await goToHome(ctx);
  await ctx.tapAnyText(MODELS_TAB_LABELS);
  await ctx.expectAnyText(MODEL_CATALOG_LABELS);
  await ctx.expectAnyText(ALL_MODELS_LABELS);
}

async function goToConversationManagement(ctx) {
  await goToHome(ctx);
  await ctx.tapAnyText(MANAGE_CONVERSATIONS_LABELS);
  await ctx.expectAnyText(CONVERSATIONS_TITLE_LABELS);
}

async function goToSettings(ctx) {
  await goToHome(ctx);
  await ctx.tapAnyText(SETTINGS_TAB_LABELS);
  await ctx.expectAnyText(SETTINGS_TITLE_LABELS);
  await ctx.expectAnyText(THEME_MODE_LABELS, { timeoutMs: SETTINGS_ROUTE_TIMEOUT_MS });
}

async function goToHuggingFaceToken(ctx) {
  await goToSettings(ctx);
  await ctx.tapAnyText(SETTINGS_HF_TOKEN_LABELS);
  await ctx.expectAnyText(SETTINGS_HF_TOKEN_LABELS);
}

async function goToModelDetails(ctx) {
  await goToModelsCatalog(ctx);
  await ctx.tapText("Details", { timeoutMs: 15_000 });
  await ctx.expectAnyText(MODEL_DETAILS_TITLE_LABELS);
}

async function readCurrentLanguageLabel(ctx) {
  await goToSettings(ctx);

  const languageNode = await ctx.findAnyNodeNow(LANGUAGE_ROW_LABELS, {
    visibleOnly: true,
  });
  if (!languageNode) {
    throw new Error("Could not find the language row while preparing English screen captures.");
  }

  return languageNode.label;
}

async function ensureEnglishUi(ctx, languageState) {
  if (languageState.originalLabel === LANGUAGE_ROW_LABELS[0]) {
    return;
  }

  await ctx.tapAnyText([LANGUAGE_ROW_LABELS[1]]);
  languageState.switchedToEnglish = true;
  await ctx.expectText(LANGUAGE_ROW_LABELS[0], { timeoutMs: 5_000 });
  await ctx.expectText(THEME_MODE_LABELS[0], { timeoutMs: 5_000 });
  await goToHome(ctx);
}

async function restoreOriginalLanguage(ctx, languageState) {
  if (!languageState.switchedToEnglish) {
    return;
  }

  await goToSettings(ctx);
  await ctx.tapAnyText([LANGUAGE_ROW_LABELS[0]]);
  await ctx.expectText(languageState.originalLabel, { timeoutMs: 5_000 });
  await ctx.expectText(THEME_MODE_LABELS[1], { timeoutMs: 5_000 });
  await goToHome(ctx);
}

function createCaptureContext(adbPath, serial) {
  return {
    serial,
    ensureAppVisible: async () => {
      const homeNode = await findAnyNodeNow(adbPath, serial, HOME_SECTION_LABELS, {
        visibleOnly: true,
      });
      if (homeNode) {
        return;
      }

      const launcherNode = await findNodeNow(adbPath, serial, homeLauncherLabel, {
        visibleOnly: true,
      });
      if (launcherNode) {
        runChecked(adbPath, [
          "-s",
          serial,
          "shell",
          "input",
          "tap",
          `${launcherNode.bounds.centerX}`,
          `${launcherNode.bounds.centerY}`,
        ]);
        await delay(1_500);
      }
    },
    dismissDebuggerBanner: async () => {
      await dismissDebuggerBannerIfPresent(adbPath, serial);
    },
    findNodeNow: async (label, options = {}) => findNodeNow(adbPath, serial, label, options),
    findAnyNodeNow: async (labels, options = {}) => findAnyNodeNow(adbPath, serial, labels, options),
    tapText: async (label, options = {}) => {
      await dismissDebuggerBannerIfPresent(adbPath, serial);
      const node = await waitForNode(adbPath, serial, label, {
        timeoutMs: options.timeoutMs,
        visibleOnly: true,
      });

      if (!node.bounds) {
        throw new Error(`"${label}" was found but has no tap bounds.`);
      }

      runChecked(adbPath, [
        "-s",
        serial,
        "shell",
        "input",
        "tap",
        `${node.bounds.centerX}`,
        `${node.bounds.centerY}`,
      ]);

      await delay(options.afterTapDelayMs ?? 800);
    },
    tapAnyText: async (labels, options = {}) => {
      await dismissDebuggerBannerIfPresent(adbPath, serial);
      const { label, node } = await waitForAnyNode(adbPath, serial, labels, {
        timeoutMs: options.timeoutMs,
        visibleOnly: true,
      });

      if (!node.bounds) {
        throw new Error(`"${label}" was found but has no tap bounds.`);
      }

      runChecked(adbPath, [
        "-s",
        serial,
        "shell",
        "input",
        "tap",
        `${node.bounds.centerX}`,
        `${node.bounds.centerY}`,
      ]);

      await delay(options.afterTapDelayMs ?? 800);
      return label;
    },
    pressBack: async () => {
      runChecked(adbPath, ["-s", serial, "shell", "input", "keyevent", "4"]);
      await delay(700);
    },
    expectText: async (label, options = {}) => {
      await waitForNode(adbPath, serial, label, {
        timeoutMs: options.timeoutMs,
        visibleOnly: true,
      });
    },
    expectAnyText: async (labels, options = {}) => {
      await waitForAnyNode(adbPath, serial, labels, {
        timeoutMs: options.timeoutMs,
        visibleOnly: true,
      });
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

function selectScreens(screens, requestedScreenIds) {
  const requested = requestedScreenIds.length === 0
    ? [...defaultScreenIds]
    : expandRequestedScreenIds(requestedScreenIds, screens);

  const screenMap = new Map(screens.map((screen) => [screen.id, screen]));
  const selected = [];

  for (const screenId of requested) {
    const screen = screenMap.get(screenId);
    if (!screen) {
      throw new Error(
        `Unknown screen "${screenId}". Run with --list to see available screen ids.`
      );
    }

    if (!selected.some((entry) => entry.id === screen.id)) {
      selected.push(screen);
    }
  }

  if (selected.length === 0) {
    throw new Error("No screens were selected.");
  }

  return selected;
}

function expandRequestedScreenIds(requestedScreenIds, screens) {
  const knownScreenIds = new Set(screens.map((screen) => screen.id));
  const expanded = [];

  for (const screenId of requestedScreenIds) {
    if (screenId === "all") {
      expanded.push(...defaultScreenIds);
      continue;
    }

    if (!knownScreenIds.has(screenId)) {
      expanded.push(screenId);
      continue;
    }

    expanded.push(screenId);
  }

  return expanded;
}

function launchApp() {
  const bootstrapRelativePath = path.relative(
    projectRoot,
    path.join(artifactsRoot, "bootstrap.png")
  );
  const args = [
    path.join(__dirname, "android-smoke.js"),
    "--screenshot",
    bootstrapRelativePath,
  ];

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
    throw new Error("Failed to launch the Android app before capturing screens.");
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

async function waitForAnyNode(adbPath, serial, labels, options = {}) {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    for (const label of labels) {
      const node = await findNodeNow(adbPath, serial, label, options);
      if (node) {
        return { label, node };
      }
    }

    await delay(600);
  }

  throw new Error(
    `Timed out waiting for any of: ${labels.map((label) => `"${label}"`).join(", ")}.`
  );
}

async function findAnyNodeNow(adbPath, serial, labels, options = {}) {
  for (const label of labels) {
    const node = await findNodeNow(adbPath, serial, label, options);
    if (node) {
      return { label, node };
    }
  }

  return null;
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

function writeReport(serial, results) {
  const reportPath = path.join(artifactsRoot, "latest-report.json");
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        serial,
        screenCount: results.length,
        results,
      },
      null,
      2
    )
  );
  log(`Wrote screen capture report to ${reportPath}`);
}

function printScreenList(screens) {
  console.log("Available Android screen capture targets:");
  for (const screen of screens) {
    console.log(`- ${screen.id}: ${screen.description}`);
  }
}

function parseCliOptions(argv) {
  const options = {
    emulator: false,
    skipBuild: false,
    skipLaunch: false,
    list: false,
    avd: null,
    serial: null,
    port: null,
    outputDir: null,
    screens: [],
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

    if (arg === "--skip-launch") {
      options.skipLaunch = true;
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

    if (arg === "--screen") {
      const rawValue = readCliValue(argv, ++index, "--screen");
      options.screens.push(
        ...rawValue
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
      );
      continue;
    }

    if (arg === "--port") {
      options.port = readCliValue(argv, ++index, "--port");
      continue;
    }

    if (arg === "--output-dir") {
      options.outputDir = readCliValue(argv, ++index, "--output-dir");
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
  console.log("Usage: node ./scripts/android-screen-capture.js [options]");
  console.log("");
  console.log("Options:");
  console.log("  --emulator                 Run against an Android emulator");
  console.log("  --avd <name>               Use a specific AVD when launching an emulator");
  console.log("  --serial <serial>          Target a specific connected device");
  console.log("  --screen <id[,id...]>      Capture one or more named screens");
  console.log("  --skip-build               Reuse the existing debug APK");
  console.log("  --skip-launch              Skip android-smoke and only drive the current app state");
  console.log("  --port <number>            Forward a specific Metro port to android-smoke");
  console.log("  --output-dir <path>        Store screenshots and report under a custom directory");
  console.log("  --list                     Print available screen ids");
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
  console.log(`[android-screen-capture] ${message}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
