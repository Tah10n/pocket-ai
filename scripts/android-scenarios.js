#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const cliOptions = parseCliOptions(process.argv.slice(2));
const projectRoot = path.resolve(__dirname, "..");
const artifactsRoot = path.join(projectRoot, "artifacts", "android-scenarios");
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
const DOWNLOADED_TAB_LABELS = ["Downloaded", "Загруженные"];
const MODELS_FILTER_TOGGLE_LABELS = ["Filters", "Фильтры"];
const MODELS_FILTER_NO_TOKEN_REQUIRED_LABELS = ["No token required", "Без токена"];
const MODELS_FILTER_CLEAR_LABELS = ["Clear", "Очистить"];
const SETTINGS_TAB_LABELS = ["Settings", "Настройки"];
const SETTINGS_TITLE_LABELS = ["Settings", "Настройки"];
const THEME_MODE_LABELS = ["Theme Mode", "Тема"];
const LANGUAGE_ROW_LABELS = ["Language", "Язык"];
const STORAGE_MANAGER_LABELS = ["Storage Manager", "Управление хранилищем"];
const PERFORMANCE_ROW_LABELS = ["Performance", "Производительность"];
const PERFORMANCE_COPY_TRACE_LABELS = ["Copy trace", "Копировать трассу"];
const PERFORMANCE_DUMP_TO_LOGCAT_LABELS = ["Dump to logcat", "Выгрузить в logcat"];
const PERFORMANCE_ENABLE_INSTRUMENTATION_LABELS = ["Enable instrumentation", "Включить инструментацию"];
const HF_TOKEN_LABELS = ["Hugging Face Token", "Токен Hugging Face"];
const ACTIVE_MODEL_CTA_LABELS = ["Swap Model", "Choose Model", "Browse Models"];
const CONVERSATIONS_TITLE_LABELS = ["All Conversations", "Все разговоры"];
const MANAGE_CONVERSATIONS_LABELS = ["Manage", "Управлять"];
const CONVERSATIONS_SEARCH_LABELS = ["Search conversations", "Поиск по разговорам"];
const MODEL_DETAILS_TITLE_LABELS = ["Model details", "Детали модели"];
const MODEL_DETAILS_CTA_LABELS = ["Details", "Детали"];
const OPEN_ON_HF_LABELS = ["Open on HF", "Открыть на HF"];
const RAM_FIT_BADGE_LABELS = [
  "Fits in RAM",
  "Won't fit RAM",
  "Likely OOM",
  "Near RAM limit",
  "RAM fit unknown",
  "RAM Warning",
  "Помещается в RAM",
  "Не влезет в RAM",
  "Вероятен OOM",
  "На пределе RAM",
  "Неизвестно по RAM",
  "Риск по RAM",
];
const RAM_FIT_RISK_BADGE_LABELS = [
  "Won't fit RAM",
  "Likely OOM",
  "Near RAM limit",
  "RAM fit unknown",
  "RAM Warning",
  "Не влезет в RAM",
  "Вероятен OOM",
  "На пределе RAM",
  "Неизвестно по RAM",
  "Риск по RAM",
];
const DOWNLOAD_CTA_LABELS = [
  "Download",
  "Скачать",
];
const DOWNLOAD_WARNING_TITLE_LABELS = [
  "Memory Warning",
  "Size could not be verified",
  "Предупреждение о памяти",
  "Размер не удалось подтвердить",
];
const DOWNLOAD_WARNING_CANCEL_LABELS = [
  "Cancel",
  "CANCEL",
  "Отмена",
  "ОТМЕНА",
];
const HOME_ROUTE_TIMEOUT_MS = 90_000;
const SETTINGS_ROUTE_TIMEOUT_MS = 60_000;

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
  const languageState = {
    originalLabel: null,
    switchedToEnglish: false,
  };

  let runError = null;

  try {
    await context.ensureAppVisible();
    await dismissDebuggerBannerIfPresent(adbPath, serial);
    languageState.originalLabel = await readCurrentLanguageLabel(context);
    await ensureEnglishUi(context, languageState);

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
  } catch (error) {
    runError = error;

    try {
      const screenshotPath = context.captureScreenshot("run-failed.png");
      const uiDumpPath = path.join(artifactsRoot, "run-failed.xml");
      fs.writeFileSync(uiDumpPath, dumpUiHierarchy(adbPath, serial));

      const logcatPath = path.join(artifactsRoot, "run-failed-logcat.txt");
      const logcat = runCapture(adbPath, ["-s", serial, "logcat", "-d", "-t", "400"], {
        allowFailure: true,
      });
      fs.writeFileSync(logcatPath, logcat);

      results.push({
        id: "runner-failure",
        status: "failed",
        durationMs: 0,
        screenshotPath,
        uiDumpPath,
        logcatPath,
        error: error.message,
      });
      writeReport(results);
    } catch (captureError) {
      results.push({
        id: "runner-failure",
        status: "failed",
        durationMs: 0,
        error: error.message,
        captureError: captureError instanceof Error ? captureError.message : String(captureError),
      });
      writeReport(results);
    }
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

function createScenarioContext(adbPath, serial) {
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

      if (launcherNode?.bounds) {
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
    expectAnyText: async (labels, options = {}) => {
      await waitForAnyNode(adbPath, serial, labels, {
        timeoutMs: options.timeoutMs,
        visibleOnly: true,
      });
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
      return label;
    },
    tapBottomTab: async (labels, options = {}) => {
      await dismissDebuggerBannerIfPresent(adbPath, serial);

      const { label, node } = await waitForAnyNodeWithPicker(
        adbPath,
        serial,
        labels,
        {
          timeoutMs: options.timeoutMs,
          visibleOnly: true,
        },
        pickBottomMostNode
      );

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
    swipeUp: async () => {
      runChecked(adbPath, [
        "-s",
        serial,
        "shell",
        "input",
        "swipe",
        "540",
        "1700",
        "540",
        "700",
        "250",
      ]);
      await delay(900);
    },
    swipeDown: async () => {
      runChecked(adbPath, [
        "-s",
        serial,
        "shell",
        "input",
        "swipe",
        "540",
        "700",
        "540",
        "1700",
        "250",
      ]);
      await delay(900);
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
        await ctx.expectAnyText(HOME_SECTION_LABELS);
        await ctx.expectAnyText(ACTIVE_MODEL_CTA_LABELS);
      },
    },
    {
      id: "bottom-tabs",
      description: "Verify bottom tab navigation across Home, Chat, Models, and Settings.",
      run: async (ctx) => {
        await goToHome(ctx);
        await ctx.tapBottomTab(CHAT_TAB_LABELS);
        await ctx.expectAnyText(CHAT_EMPTY_LABELS);

        await ctx.tapBottomTab(MODELS_TAB_LABELS);
        await ctx.expectAnyText(MODEL_CATALOG_LABELS);
        await ctx.expectAnyText(ALL_MODELS_LABELS);
        await ctx.expectAnyText(DOWNLOADED_TAB_LABELS);

        await ctx.tapBottomTab(SETTINGS_TAB_LABELS);
        await ctx.expectAnyText(SETTINGS_TITLE_LABELS);
        await scrollToAnyText(ctx, THEME_MODE_LABELS, { timeoutMs: SETTINGS_ROUTE_TIMEOUT_MS });
        await scrollToAnyText(ctx, LANGUAGE_ROW_LABELS, { timeoutMs: SETTINGS_ROUTE_TIMEOUT_MS });
        await scrollToAnyText(ctx, STORAGE_MANAGER_LABELS, { timeoutMs: SETTINGS_ROUTE_TIMEOUT_MS });

        await ctx.tapBottomTab(HOME_TAB_LABELS);
        await ctx.expectAnyText(HOME_SECTION_LABELS);
      },
    },
    {
      id: "new-chat-cta",
      description: "Verify the Home screen New Chat button opens the chat screen empty state.",
      run: async (ctx) => {
        await goToHome(ctx);
        await ctx.tapText("New Chat");
        await ctx.expectAnyText(CHAT_EMPTY_LABELS);
        await ctx.tapAnyText(HOME_TAB_LABELS);
        await ctx.expectText("New Chat");
      },
    },
    {
      id: "swap-model-cta",
      description: "Verify the Home screen active-model CTA opens the model catalog.",
      run: async (ctx) => {
        await goToHome(ctx);
        await ctx.tapAnyText(ACTIVE_MODEL_CTA_LABELS);
        await ctx.expectAnyText(MODEL_CATALOG_LABELS);
        await ctx.expectAnyText(ALL_MODELS_LABELS);
        await ctx.expectAnyText(DOWNLOADED_TAB_LABELS);
        await ctx.tapAnyText(HOME_TAB_LABELS);
        await ctx.expectAnyText(ACTIVE_MODEL_CTA_LABELS);
      },
    },
    {
      id: "hf-catalog-hardening",
      description: "Verify guided discovery, new HF catalog controls, and routed model details.",
      run: async (ctx) => {
        await goToHome(ctx);
        await ctx.tapAnyText(ACTIVE_MODEL_CTA_LABELS);
        await ctx.expectAnyText(MODEL_CATALOG_LABELS);

        await ctx.tapText("Filters");
        await ctx.expectText("No token required");

        await ctx.tapText("Sort");
        await ctx.expectText("Most downloaded");
        await ctx.expectText("Most popular");
        await ctx.tapText("Sort");

        await ctx.tapText("Details", { timeoutMs: 15_000 });
        await ctx.expectAnyText(MODEL_DETAILS_TITLE_LABELS);
        await ctx.expectAnyText(OPEN_ON_HF_LABELS);
      },
    },
    {
      id: "memory-fit-badges",
      description: "Verify memory-fit badges show up in catalog and model details.",
      run: async (ctx) => {
        await goToHome(ctx);
        await ctx.tapAnyText(ACTIVE_MODEL_CTA_LABELS);
        await ctx.expectAnyText(MODEL_CATALOG_LABELS);
        await ctx.tapAnyText(MODEL_DETAILS_CTA_LABELS, { timeoutMs: 45_000 });
        await ctx.expectAnyText(MODEL_DETAILS_TITLE_LABELS);
        await ctx.expectAnyText(RAM_FIT_BADGE_LABELS, { timeoutMs: 20_000 });
      },
    },
    {
      id: "memory-fit-download-warning",
      description: "Verify download flows warn for RAM risk or limited verification.",
      run: async (ctx) => {
        await goToHome(ctx);
        await ctx.tapAnyText(ACTIVE_MODEL_CTA_LABELS);
        await ctx.expectAnyText(MODEL_CATALOG_LABELS);
        await prepareCatalogForRamWarningScenario(ctx);

        const adbPath = resolveAdbPath();

        for (let attempt = 0; attempt < 12; attempt += 1) {
          await ctx.tapAnyText(MODEL_DETAILS_CTA_LABELS, { timeoutMs: 45_000 });
          await ctx.expectAnyText(MODEL_DETAILS_TITLE_LABELS);

          const riskBadge = await findAnyNodeNow(adbPath, ctx.serial, RAM_FIT_RISK_BADGE_LABELS, {
            visibleOnly: true,
          });

          if (!riskBadge) {
            await ctx.pressBack();
            await ctx.expectAnyText(MODEL_CATALOG_LABELS, { timeoutMs: 20_000 });
            await ctx.swipeUp();
            continue;
          }

          await ctx.tapAnyText(DOWNLOAD_CTA_LABELS, { timeoutMs: 20_000 });
          await waitForAnyNode(adbPath, ctx.serial, DOWNLOAD_WARNING_TITLE_LABELS, {
            timeoutMs: 15_000,
            visibleOnly: true,
          });

          await ctx.tapAnyText(DOWNLOAD_WARNING_CANCEL_LABELS, { timeoutMs: 5_000 });
          await ctx.pressBack();
          await ctx.expectAnyText(MODEL_CATALOG_LABELS, { timeoutMs: 20_000 });
          return;
        }

        log("SKIP memory-fit-download-warning: No RAM-risk model was found to validate download warnings.");
      },
    },
    {
      id: "hf-token-education",
      description: "Verify the token education screen and external-token CTA are reachable from Settings.",
      run: async (ctx) => {
        await goToSettings(ctx);
        await scrollToAnyText(ctx, HF_TOKEN_LABELS, { timeoutMs: SETTINGS_ROUTE_TIMEOUT_MS });
        await ctx.tapAnyText(HF_TOKEN_LABELS);
        await ctx.expectText("Access token");
        await ctx.swipeUp();
        await ctx.expectText("What this token does");
        await ctx.expectText("Get token");
      },
    },
    {
      id: "conversations-management",
      description: "Verify the conversation management route is reachable from Home.",
      run: async (ctx) => {
        await goToConversationManagement(ctx);
        await ctx.expectAnyText(CONVERSATIONS_TITLE_LABELS);
        await ctx.expectAnyText(CONVERSATIONS_SEARCH_LABELS);
        await ctx.expectText("New Chat");
      },
    },
    {
      id: "performance-logcat",
      description: "Verify the Performance screen can dump a trace to logcat in dev builds.",
      run: async (ctx) => {
        await goToSettings(ctx);

        const adbPath = resolveAdbPath();

        for (let attempt = 0; attempt < 5; attempt += 1) {
          const performanceRow = await findAnyNodeNow(adbPath, ctx.serial, PERFORMANCE_ROW_LABELS, {
            visibleOnly: true,
          });

          if (performanceRow) {
            break;
          }

          await ctx.swipeUp();
        }

        const performanceRow = await findAnyNodeNow(adbPath, ctx.serial, PERFORMANCE_ROW_LABELS, {
          visibleOnly: true,
        });

        if (!performanceRow) {
          throw new Error("Timed out waiting for the Performance settings row.");
        }

        await ctx.tapAnyText(PERFORMANCE_ROW_LABELS);
        await ctx.expectAnyText(PERFORMANCE_COPY_TRACE_LABELS);

        const enableInstrumentation = await findAnyNodeNow(adbPath, ctx.serial, PERFORMANCE_ENABLE_INSTRUMENTATION_LABELS, {
          visibleOnly: true,
        });

        if (enableInstrumentation) {
          await ctx.tapAnyText(PERFORMANCE_ENABLE_INSTRUMENTATION_LABELS);
        }

        runChecked(adbPath, ["-s", ctx.serial, "logcat", "-c"]);

        await ctx.tapAnyText(PERFORMANCE_DUMP_TO_LOGCAT_LABELS);

        let logs = "";
        for (let attempt = 0; attempt < 4; attempt += 1) {
          await delay(1_500 + attempt * 1_000);
          logs = runCapture(adbPath, ["-s", ctx.serial, "logcat", "-d", "-t", "800"]);
          if (logs.includes("POCKET_AI_PERF_TRACE")) {
            break;
          }
        }

        if (!logs.includes("POCKET_AI_PERF_TRACE")) {
          throw new Error("Expected POCKET_AI_PERF_TRACE output in logcat.");
        }
      },
    },
  ];
}

async function goToHome(ctx) {
  await ctx.ensureAppVisible();
  await ctx.dismissDebuggerBanner();

  try {
    await ctx.expectAnyText(HOME_SECTION_LABELS, { timeoutMs: HOME_ROUTE_TIMEOUT_MS });
  } catch {
    const reachedHome = await tryReachHome(ctx);

    if (!reachedHome) {
      const adbPath = resolveAdbPath();
      throw new Error(withUiSummary(adbPath, ctx.serial, `Timed out returning to Home from the current route.`));
    }

    await ctx.expectAnyText(HOME_SECTION_LABELS, { timeoutMs: HOME_ROUTE_TIMEOUT_MS });
  }

  await ctx.expectText("Pocket AI");
}

async function tryReachHome(ctx, maxAttempts = 4) {
  const adbPath = resolveAdbPath();

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const downloadWarning = await findAnyNodeNow(adbPath, ctx.serial, DOWNLOAD_WARNING_TITLE_LABELS, {
      visibleOnly: true,
    });
    if (downloadWarning) {
      await ctx.tapAnyText(DOWNLOAD_WARNING_CANCEL_LABELS, { timeoutMs: 5_000 });
      continue;
    }

    const homeSectionNode = await findAnyNodeNow(adbPath, ctx.serial, HOME_SECTION_LABELS, {
      visibleOnly: true,
    });
    if (homeSectionNode) {
      return true;
    }

    const pocketAiLauncherNode = await findNodeNow(adbPath, ctx.serial, "Pocket AI", {
      visibleOnly: true,
    });
    if (pocketAiLauncherNode) {
      await ctx.tapText("Pocket AI", { afterTapDelayMs: 1_500, timeoutMs: 5_000 });
      continue;
    }

    const homeNode = await findAnyNodeNow(adbPath, ctx.serial, HOME_TAB_LABELS, {
      visibleOnly: true,
    });
    if (homeNode) {
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

async function goToSettings(ctx) {
  await goToHome(ctx);
  await ctx.tapBottomTab(SETTINGS_TAB_LABELS);
  await ctx.expectAnyText(SETTINGS_TITLE_LABELS);
}

async function goToConversationManagement(ctx) {
  await goToHome(ctx);
  await ctx.tapAnyText(MANAGE_CONVERSATIONS_LABELS);
  await ctx.expectAnyText(CONVERSATIONS_TITLE_LABELS);
}

async function prepareCatalogForRamWarningScenario(ctx) {
  const adbPath = resolveAdbPath();

  const panelAlreadyOpen = await findAnyNodeNow(adbPath, ctx.serial, MODELS_FILTER_NO_TOKEN_REQUIRED_LABELS, {
    visibleOnly: true,
  });

  if (!panelAlreadyOpen) {
    await ctx.tapAnyText(MODELS_FILTER_TOGGLE_LABELS);
    await ctx.expectAnyText(MODELS_FILTER_NO_TOKEN_REQUIRED_LABELS);
  }

  const clearButton = await findAnyNodeNow(adbPath, ctx.serial, MODELS_FILTER_CLEAR_LABELS, {
    visibleOnly: true,
  });

  if (clearButton) {
    await ctx.tapAnyText(MODELS_FILTER_CLEAR_LABELS);
  }

  // Make the scenario deterministic: show RAM-risk models by clearing persisted filters
  // (including "Fits in RAM"), then keep downloads unblocked by enabling "No token required".
  await ctx.tapAnyText(MODELS_FILTER_NO_TOKEN_REQUIRED_LABELS);

  await ctx.tapAnyText(MODELS_FILTER_TOGGLE_LABELS);
  await ctx.expectAnyText(MODEL_CATALOG_LABELS);
}

async function readCurrentLanguageLabel(ctx) {
  await goToSettings(ctx);

  const languageNode = await scrollToAnyText(ctx, LANGUAGE_ROW_LABELS, {
    timeoutMs: SETTINGS_ROUTE_TIMEOUT_MS,
  });

  return languageNode.label;
}

async function ensureEnglishUi(ctx, languageState) {
  if (languageState.originalLabel === LANGUAGE_ROW_LABELS[0]) {
    return;
  }

  await scrollToAnyText(ctx, [LANGUAGE_ROW_LABELS[1]], {
    timeoutMs: SETTINGS_ROUTE_TIMEOUT_MS,
  });
  await ctx.tapAnyText([LANGUAGE_ROW_LABELS[1]]);
  languageState.switchedToEnglish = true;
  await scrollToAnyText(ctx, [LANGUAGE_ROW_LABELS[0]], { timeoutMs: 10_000 });
  await scrollToAnyText(ctx, THEME_MODE_LABELS, { timeoutMs: 10_000 });
  await goToHome(ctx);
}

async function restoreOriginalLanguage(ctx, languageState) {
  if (!languageState.switchedToEnglish) {
    return;
  }

  await goToSettings(ctx);
  await scrollToAnyText(ctx, [LANGUAGE_ROW_LABELS[0]], { timeoutMs: SETTINGS_ROUTE_TIMEOUT_MS });
  await ctx.tapAnyText([LANGUAGE_ROW_LABELS[0]]);
  await scrollToAnyText(ctx, [languageState.originalLabel], { timeoutMs: 10_000 });
  await scrollToAnyText(ctx, THEME_MODE_LABELS, { timeoutMs: 10_000 });
  await goToHome(ctx);
}

async function scrollToAnyText(ctx, labels, options = {}) {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxSwipesDown = options.maxSwipesDown ?? 3;
  const maxSwipesUp = options.maxSwipesUp ?? 10;
  const adbPath = resolveAdbPath();
  const startedAt = Date.now();

  const findNow = async () => findAnyNodeNow(adbPath, ctx.serial, labels, { visibleOnly: true });

  let match = await findNow();
  if (match) {
    return match;
  }

  for (let attempt = 0; attempt < maxSwipesDown && Date.now() - startedAt < timeoutMs; attempt += 1) {
    await ctx.swipeDown();
    match = await findNow();
    if (match) {
      return match;
    }
  }

  for (let attempt = 0; attempt < maxSwipesUp && Date.now() - startedAt < timeoutMs; attempt += 1) {
    await ctx.swipeUp();
    match = await findNow();
    if (match) {
      return match;
    }
  }

  throw new Error(
    withUiSummary(
      adbPath,
      ctx.serial,
      `Timed out waiting for any of: ${labels.map((label) => `"${label}"`).join(", ")}.`
    )
  );
}

function launchApp() {
  const args = [
    path.join(__dirname, "android-smoke.js"),
    "--screenshot",
    path.join("artifacts", "android-scenarios", "bootstrap.png"),
    "--launch-delay-ms",
    "20000",
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

  throw new Error(withUiSummary(adbPath, serial, `Timed out waiting for text "${label}".`));
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
    withUiSummary(
      adbPath,
      serial,
      `Timed out waiting for any of: ${labels.map((label) => `"${label}"`).join(", ")}.`
    )
  );
}

async function waitForAnyNodeWithPicker(adbPath, serial, labels, options = {}, picker) {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const startedAt = Date.now();
  const resolvedPicker = picker ?? pickBestNode;

  while (Date.now() - startedAt < timeoutMs) {
    const xml = dumpUiHierarchy(adbPath, serial);
    const nodes = parseUiNodes(xml);
    const viewportBounds = options.visibleOnly ? resolveViewportBounds(nodes) : null;

    for (const label of labels) {
      const matches = nodes.filter((node) => {
        if (!matchesLabel(node, label)) {
          return false;
        }

        if (options.visibleOnly) {
          if (!node.bounds) {
            return false;
          }

          if (viewportBounds && !isBoundsInViewport(node.bounds, viewportBounds)) {
            return false;
          }
        }

        return true;
      });

      if (matches.length > 0) {
        return { label, node: resolvedPicker(matches) };
      }
    }

    await delay(600);
  }

  throw new Error(
    withUiSummary(
      adbPath,
      serial,
      `Timed out waiting for any of: ${labels.map((label) => `"${label}"`).join(", ")}.`
    )
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
  const viewportBounds = options.visibleOnly ? resolveViewportBounds(nodes) : null;
  const matches = nodes.filter((node) => {
    if (!matchesLabel(node, label)) {
      return false;
    }

    if (options.visibleOnly) {
      if (!node.bounds) {
        return false;
      }

      if (viewportBounds && !isBoundsInViewport(node.bounds, viewportBounds)) {
        return false;
      }
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

function resolveViewportBounds(nodes) {
  if (!nodes || nodes.length === 0) {
    return null;
  }

  const candidates = nodes
    .map((node) => node.bounds)
    .filter(Boolean);

  if (candidates.length === 0) {
    return null;
  }

  return candidates.reduce((best, next) => (next.area > best.area ? next : best));
}

function isBoundsInViewport(bounds, viewportBounds) {
  if (!bounds || !viewportBounds) {
    return false;
  }

  return (
    bounds.centerX >= viewportBounds.left
    && bounds.centerX <= viewportBounds.right
    && bounds.centerY >= viewportBounds.top
    && bounds.centerY <= viewportBounds.bottom
  );
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

function pickBottomMostNode(nodes) {
  return [...nodes].sort((left, right) => {
    const clickableDelta = Number(right.clickable) - Number(left.clickable);
    if (clickableDelta !== 0) {
      return clickableDelta;
    }

    const leftY = left.bounds ? left.bounds.centerY : -1;
    const rightY = right.bounds ? right.bounds.centerY : -1;
    if (leftY !== rightY) {
      return rightY - leftY;
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
  const hasDevMenu = nodes.some(
    (node) =>
      node.text === "React Native Dev Menu"
      || node.contentDesc.includes("React Native Dev Menu")
  );

  if (hasDevMenu) {
    runChecked(adbPath, ["-s", serial, "shell", "input", "keyevent", "4"]);
    await delay(600);
    return;
  }

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

function summarizeCurrentUi(adbPath, serial, options = {}) {
  const maxItems = options.maxItems ?? 10;
  const maxLabelLength = options.maxLabelLength ?? 80;

  try {
    const xml = dumpUiHierarchy(adbPath, serial);
    const nodes = parseUiNodes(xml);
    const viewportBounds = resolveViewportBounds(nodes);
    const seen = new Set();

    const visibleNodes = nodes
      .filter((node) => {
        if (!node.bounds) {
          return false;
        }

        if (viewportBounds && !isBoundsInViewport(node.bounds, viewportBounds)) {
          return false;
        }

        return Boolean((node.text || node.contentDesc || "").trim());
      })
      .sort((left, right) => {
        if (left.bounds.top !== right.bounds.top) {
          return left.bounds.top - right.bounds.top;
        }

        return left.bounds.left - right.bounds.left;
      });

    const items = [];

    for (const node of visibleNodes) {
      const raw = node.text || node.contentDesc;
      if (!raw) {
        continue;
      }

      let label = raw.replace(/\s+/g, " ").trim();
      if (!label) {
        continue;
      }

      if (label.length > maxLabelLength) {
        label = `${label.slice(0, Math.max(0, maxLabelLength - 3))}...`;
      }

      const key = normalizeUiLabel(label);
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      items.push(label);

      if (items.length >= maxItems) {
        break;
      }
    }

    if (items.length === 0) {
      return "<no visible text>";
    }

    return items.join(" | ");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `<ui dump unavailable: ${message}>`;
  }
}

function withUiSummary(adbPath, serial, message) {
  return `${message}\nVisible UI: ${summarizeCurrentUi(adbPath, serial)}`;
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
