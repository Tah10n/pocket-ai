#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const DEFAULT_SCENARIO_PACK = "core";
const DEFAULT_TAP_SAFE_BOTTOM_INSET_RATIO = 0.14;
const DEFAULT_TAP_SAFE_BOTTOM_INSET_MIN_PX = 220;
// Native and extended keep the stable secondary surface; live catalog smokes stay targeted, in catalog, or behind all.
const STABLE_SECONDARY_SCENARIOS = [
  "swap-model-cta",
  "hf-token-education",
  "conversations-management",
];
const CORE_SCENARIOS = [
  "home-smoke",
  "bottom-tabs",
  "new-chat-cta",
];
const CATALOG_SCENARIOS = [
  "variant-picker-smoke",
];
const ATTACHMENT_SCENARIOS = [
  "chat-attachment-text-only-fallback",
];
const PREPARED_ATTACHMENT_SCENARIOS = [
  "chat-attachment-preview-remove",
];
const PREPARED_ATTACHMENT_SEND_SCENARIOS = [
  "chat-attachment-prepared-send",
];
const SCENARIO_PACK_SCENARIOS = {
  core: CORE_SCENARIOS,
  catalog: CATALOG_SCENARIOS,
  attachments: ATTACHMENT_SCENARIOS,
  "attachments-prepared": PREPARED_ATTACHMENT_SCENARIOS,
  "attachments-prepared-send": PREPARED_ATTACHMENT_SEND_SCENARIOS,
  "dependency-ui": [
    ...CORE_SCENARIOS,
    "style-screenshots",
  ],
  runtime: [
    ...CORE_SCENARIOS,
    "language-switch",
    "conversations-management",
  ],
  native: [
    ...CORE_SCENARIOS,
    ...STABLE_SECONDARY_SCENARIOS,
  ],
  extended: [
    ...CORE_SCENARIOS,
    ...STABLE_SECONDARY_SCENARIOS,
  ],
};
const SCENARIO_PACKS = new Set([...Object.keys(SCENARIO_PACK_SCENARIOS), "all"]);

const cliOptions = require.main === module
  ? parseCliOptions(process.argv.slice(2))
  : parseCliOptions([]);
const projectRoot = path.resolve(__dirname, "..");
const appConfigPath = path.join(projectRoot, "app.json");
const artifactsRoot = path.join(projectRoot, "artifacts", "android-scenarios");
const dumpPathOnDevice = "/sdcard/window_dump.xml";
const appPackageName = readExpoConfig().packageName;
const homeLauncherLabel = "Pocket AI";
const APP_TITLE_LABELS = ["Pocket AI"];
const HOME_SECTION_LABELS = ["Recent Conversations", "Недавние разговоры"];
const HOME_TAB_LABELS = ["Home", "Главная"];
const CHAT_TAB_LABELS = ["Chat", "Чат"];
const CLOSE_APP_LABELS = ["Close app", "Закрыть приложение"];
const WAIT_LABELS = ["Wait", "Подождать"];
const APP_NOT_RESPONDING_LABEL_FRAGMENTS = ["isn't responding", "не отвечает"];
const NEW_CHAT_LABELS = ["New Chat", "Новый чат"];
const CHAT_EMPTY_LABELS = [
  "No messages yet",
  "Сообщений пока нет",
  "Load a model to continue chatting",
  "Загрузите модель, чтобы продолжить чат",
];
const CHAT_ROUTE_LABELS = [
  ...CHAT_EMPTY_LABELS,
  "Start a new chat",
  "Начать новый чат",
  "Open model controls",
  "Открыть параметры модели",
  "Open the preset picker for this chat",
  "Открыть выбор пресета для этого чата",
  "Ask local AI...",
  "Спросите локальный ИИ...",
  "Chat message input",
  "Поле ввода сообщения",
];
const CHAT_INPUT_LABELS = [
  "Chat message input",
  "Поле ввода сообщения",
];
const ATTACH_IMAGE_LABELS = [
  "Attach an image from the photo library",
  "Прикрепить изображение из медиатеки",
];
const ATTACHMENT_PREVIEW_LABELS = [
  "Attached image 1 of 1 preview",
  "Предпросмотр прикрепленного изображения 1 из 1",
];
const MESSAGE_ATTACHMENT_PREVIEW_LABELS = [
  "Message image 1 of 1 preview",
  "Предпросмотр изображения 1 из 1 в сообщении",
];
const CHAT_SEND_LABELS = ["Send message", "Отправить сообщение"];
const PREPARED_ATTACHMENT_SEND_PROMPT_PREFIX = "Describe prepared image";
const UNLOAD_MODEL_LABELS = ["Unload", "Выгрузить"];
const REMOVE_ATTACHMENT_LABELS = [
  "Remove attached image 1 of 1",
  "Удалить прикрепленное изображение 1 из 1",
];
const IMAGE_ATTACHMENT_TEXT_ONLY_FALLBACK_LABELS = [
  "This model supports text chat only.",
  "Download the vision projector before attaching images.",
  "Choose the matching vision projector before attaching images.",
  "The vision projector is still downloading.",
  "Vision support is initializing.",
  "Vision support could not start. Text chat is still available.",
  "Choose and load a vision-capable model before attaching images.",
  "Image attachments are disabled while editing an earlier message.",
  "Vision chat is not supported by this runtime.",
  "Эта модель поддерживает только текстовый чат.",
  "Скачайте vision-проектор, прежде чем прикреплять изображения.",
  "Выберите подходящий vision-проектор, прежде чем прикреплять изображения.",
  "Vision-проектор еще скачивается.",
  "Поддержка изображений инициализируется.",
  "Не удалось запустить поддержку изображений. Текстовый чат по-прежнему доступен.",
  "Выберите и загрузите модель с поддержкой изображений, прежде чем прикреплять изображения.",
  "Вложения с изображениями отключены при редактировании предыдущего сообщения.",
  "Чат с изображениями не поддерживается этим runtime.",
];
const MODELS_TAB_LABELS = ["Models", "Модели"];
const MODEL_CATALOG_LABELS = ["Model Catalog", "Каталог моделей"];
const ALL_MODELS_LABELS = ["All Models", "Все модели"];
const DOWNLOADED_TAB_LABELS = ["Downloaded", "Загруженные"];
const MODELS_FILTER_TOGGLE_LABELS = ["Filters", "Фильтры"];
const MODELS_FILTER_SIZE_LARGE_LABELS = ["> 5 GB", "> 5 ГБ"];
const MODELS_FILTER_NO_TOKEN_REQUIRED_LABELS = ["No token required", "Без токена"];
const MODELS_FILTER_CLEAR_LABELS = ["Clear", "Очистить"];
const SORT_LABELS = ["Sort", "Сортировка"];
const MOST_DOWNLOADED_LABELS = ["Most downloaded", "Самые скачиваемые"];
const MOST_POPULAR_LABELS = ["Most popular", "Самые популярные"];
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
const ACCESS_TOKEN_LABELS = ["Access token", "Токен доступа"];
const TOKEN_PURPOSE_LABELS = ["What this token does", "Что делает этот токен"];
const GET_TOKEN_LABELS = ["Get token", "Получить токен"];
const ACTIVE_MODEL_CTA_LABELS = [
  "Swap Model",
  "Choose Model",
  "Browse Models",
  "Сменить модель",
  "Выбрать модель",
  "Открыть каталог",
];
const CONVERSATIONS_TITLE_LABELS = ["All Conversations", "Все разговоры"];
const MANAGE_CONVERSATIONS_LABELS = ["Manage", "Управлять"];
const CONVERSATIONS_SEARCH_LABELS = ["Search conversations", "Поиск по разговорам"];
const APP_FOREGROUND_MARKER_LABELS = [
  "NO MODEL LOADED",
  "МОДЕЛЬ НЕ ЗАГРУЖЕНА",
  "Active model",
  "Активная модель",
  "Choose a local model",
  "Выберите локальную модель",
  ...ACTIVE_MODEL_CTA_LABELS,
  ...HOME_SECTION_LABELS,
  ...NEW_CHAT_LABELS,
  "No conversations yet",
  "Разговоров пока нет",
];
const MODEL_DETAILS_TITLE_LABELS = ["Model details", "Детали модели"];
const MODEL_DETAILS_CTA_LABELS = ["Details", "Детали"];
const OPEN_ON_HF_LABELS = ["Open on HF", "Открыть на HF"];
const VARIANT_PICKER_TITLE_LABELS = ["Choose GGUF file", "Выберите GGUF-файл"];
const MODEL_CATALOG_LOADING_LABELS = ["Searching Hugging Face...", "Поиск в Hugging Face..."];
const MODEL_CATALOG_EMPTY_OR_ERROR_LABELS = [
  "No models found",
  "Модели не найдены",
  "The model could not be loaded",
  "Не удалось загрузить модель",
];
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
const INITIAL_APP_VISIBLE_TIMEOUT_MS = 60_000;
const HOME_ROUTE_TIMEOUT_MS = 90_000;
const SETTINGS_ROUTE_TIMEOUT_MS = 60_000;
const CLEAR_TEXT_INPUT_PRIMARY_TIMEOUT_MS = 2_000;
const CLEAR_TEXT_INPUT_FALLBACK_TIMEOUT_MS = 2_000;
const CLEAR_TEXT_INPUT_FALLBACK_TOTAL_TIMEOUT_MS = 5_000;
const DEFAULT_CLEAR_TEXT_INPUT_MAX_DELETE_COUNT = 128;
const ADB_INPUT_TEXT_TIMEOUT_MS = 5_000;
const UI_HIERARCHY_DUMP_COMMAND_TIMEOUT_MS = 5_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SCREENSHOT_CAPTURE_MAX_ATTEMPTS = 4;
const SCREENSHOT_CAPTURE_RETRY_DELAY_MS = 350;
const REPORT_ARTIFACT_PATH_FIELDS = ["screenshotPath", "uiDumpPath", "logcatPath"];

if (require.main === module) {
  main().catch((error) => {
    console.error(`[android-scenarios] ${error.message}`);
    process.exit(1);
  });
}

async function main() {
  const scenarios = buildScenarios();

  if (cliOptions.list) {
    printScenarioList(scenarios);
    return;
  }

  const selectedScenarios = selectScenarios(scenarios, cliOptions);

  if (selectedScenarios.length === 0) {
    throw new Error(
      cliOptions.scenario
        ? `Unknown scenario "${cliOptions.scenario}". Run with --list to see available scenarios.`
        : "No scenarios were selected."
    );
  }

  fs.mkdirSync(artifactsRoot, { recursive: true });

  const adbPath = resolveAdbPath();
  const launchPlan = buildScenarioLaunchPlan(cliOptions, () => resolveTargetSerial(adbPath, cliOptions));

  if (launchPlan.shouldLaunch) {
    launchApp(launchPlan.serialBeforeLaunch);
  }

  const serial = launchPlan.serialBeforeLaunch || resolveTargetSerial(adbPath, cliOptions);
  const context = createScenarioContext(adbPath, serial);
  const results = [];

  try {
    await context.ensureAppVisible();
    await dismissDebuggerBannerIfPresent(adbPath, serial);

    for (const scenario of selectedScenarios) {
      const startedAt = Date.now();
      log(`Running scenario: ${scenario.id} [${scenario.tier}]`);

      try {
        const outcome = await scenario.run(context);

        if (outcome && outcome.status === "skipped") {
          recordScenarioSkip({
            scenario,
            results,
            startedAt,
            reason: outcome.reason,
            context,
          });
          continue;
        }

        const screenshotPath = context.captureScreenshot(`${scenario.id}.png`);
        results.push({
          id: scenario.id,
          tier: scenario.tier,
          status: "passed",
          durationMs: Date.now() - startedAt,
          screenshotPath,
        });
        log(`PASS ${scenario.id}`);
      } catch (error) {
        if (error instanceof ScenarioSkipFailureError) {
          throw error;
        }

        if (error instanceof ScenarioSkipError) {
          recordScenarioSkip({
            scenario,
            results,
            startedAt,
            reason: error.message,
            context,
          });
          continue;
        }

        const screenshotPath = context.captureScreenshot(`${scenario.id}-failed.png`);
        results.push({
          id: scenario.id,
          tier: scenario.tier,
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
    if (!shouldAppendRunnerFailure(error)) {
      throw error;
    }

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

    throw error;
  }
}

function createScenarioContext(adbPath, serial) {
  return {
    serial,
    ensureAppVisible: async () => {
      const startedAt = Date.now();

      while (Date.now() - startedAt < INITIAL_APP_VISIBLE_TIMEOUT_MS) {
        const dismissedBlockingDialog = await dismissBlockingSystemDialogIfPresent(adbPath, serial);
        if (dismissedBlockingDialog) {
          continue;
        }

        const snapshot = createUiSnapshot(adbPath, serial);

        if (isAppForegroundSnapshot(snapshot)) {
          return;
        }

        const homeNode = findAnyNodeInSnapshot(snapshot, HOME_SECTION_LABELS, {
          visibleOnly: true,
        });

        if (homeNode) {
          return;
        }

        const launcherNode = findNodeInSnapshot(snapshot, homeLauncherLabel, {
          visibleOnly: true,
        });

        if (launcherNode?.bounds) {
          tapBounds(adbPath, serial, launcherNode.bounds);
          await delay(1_500);
          continue;
        }

        await delay(1_000);
      }

      throw new Error(withUiSummary(adbPath, serial, "Timed out waiting for the app to become visible after launch."));
    },
    pressHome: async () => {
      runChecked(adbPath, ["-s", serial, "shell", "input", "keyevent", "3"]);
      await delay(900);
    },
    dismissDebuggerBanner: async () => {
      await dismissDebuggerBannerIfPresent(adbPath, serial);
    },
    tapText: async (label, options = {}) => {
      await dismissDebuggerBannerIfPresent(adbPath, serial);

      const { node } = await waitForAnyTappableNode(adbPath, serial, [label], {
        timeoutMs: options.timeoutMs,
        allowBottomOverlay: options.allowBottomOverlay,
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

      const { label, node } = await waitForAnyTappableNode(adbPath, serial, labels, {
        timeoutMs: options.timeoutMs,
        allowBottomOverlay: options.allowBottomOverlay,
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
      return captureAndroidScreenshot(adbPath, serial, screenshotPath);
    },
  };
}

function readExpoConfig() {
  const raw = fs.readFileSync(appConfigPath, "utf8");
  const config = JSON.parse(raw);
  const expo = config.expo || {};

  return {
    packageName: expo.android && expo.android.package,
  };
}

async function dismissBlockingSystemDialogIfPresent(adbPath, serial) {
  const snapshot = createUiSnapshot(adbPath, serial);
  const action = findBlockingSystemDialogAction(snapshot);

  if (!action?.node?.bounds) {
    return action ? "detected" : null;
  }

  tapBounds(adbPath, serial, action.node.bounds);
  await delay(action.kind === "wait" ? 2_000 : 1_200);
  return action.kind;
}

function findBlockingSystemDialogAction(snapshot) {
  const hasAppNotRespondingDialog = snapshot.nodes.some((node) =>
    APP_NOT_RESPONDING_LABEL_FRAGMENTS.some((fragment) => matchesUiFragment(node, fragment))
  );

  if (!hasAppNotRespondingDialog) {
    return null;
  }

  const waitAction = findAnyNodeInSnapshot(snapshot, WAIT_LABELS, { visibleOnly: true });
  if (waitAction) {
    return { ...waitAction, kind: "wait" };
  }

  const closeAppAction = findAnyNodeInSnapshot(snapshot, CLOSE_APP_LABELS, { visibleOnly: true });
  if (closeAppAction) {
    return { ...closeAppAction, kind: "close-app" };
  }

  return { kind: "detected", label: null, node: null };
}

function tapBounds(adbPath, serial, bounds) {
  runChecked(adbPath, [
    "-s",
    serial,
    "shell",
    "input",
    "tap",
    `${bounds.centerX}`,
    `${bounds.centerY}`,
  ]);
}

function escapeAdbInputText(value) {
  const normalized = String(value).trim();
  if (!/^[A-Za-z0-9 ]+$/.test(normalized)) {
    throw new Error(`ADB text input supports only ASCII letters, numbers, and spaces: ${normalized}`);
  }

  return normalized
    .replace(/%/g, "%25")
    .replace(/\s+/g, "%s");
}

function buildPreparedAttachmentSendPrompt() {
  return `${PREPARED_ATTACHMENT_SEND_PROMPT_PREFIX} ${Date.now()} ${Math.floor(Math.random() * 1_000_000)}`;
}

function clearFocusedTextInput(
  adbPath,
  serial,
  maxDeleteCount = DEFAULT_CLEAR_TEXT_INPUT_MAX_DELETE_COUNT,
  runCommand = runChecked
) {
  const primaryCommandOptions = { timeout: CLEAR_TEXT_INPUT_PRIMARY_TIMEOUT_MS };
  try {
    runCommand(adbPath, ["-s", serial, "shell", "input", "keycombination", "KEYCODE_CTRL_LEFT", "KEYCODE_A"], primaryCommandOptions);
    runCommand(adbPath, ["-s", serial, "shell", "input", "keyevent", "KEYCODE_DEL"], primaryCommandOptions);
    return;
  } catch (error) {
    log(`Focused text select-all clear failed; falling back to repeated delete: ${error.message}`);
  }

  const boundedMaxDeleteCount = Number.isFinite(maxDeleteCount)
    ? Math.max(0, Math.trunc(maxDeleteCount))
    : DEFAULT_CLEAR_TEXT_INPUT_MAX_DELETE_COUNT;
  const fallbackStartedAt = Date.now();
  const buildFallbackCommandOptions = () => {
    const remainingTimeoutMs = CLEAR_TEXT_INPUT_FALLBACK_TOTAL_TIMEOUT_MS - (Date.now() - fallbackStartedAt);
    if (remainingTimeoutMs <= 0) {
      return null;
    }

    return {
      timeout: Math.min(CLEAR_TEXT_INPUT_FALLBACK_TIMEOUT_MS, remainingTimeoutMs),
    };
  };

  const moveEndCommandOptions = buildFallbackCommandOptions();
  if (!moveEndCommandOptions) {
    return;
  }

  runCommand(adbPath, ["-s", serial, "shell", "input", "keyevent", "KEYCODE_MOVE_END"], moveEndCommandOptions);
  for (let index = 0; index < boundedMaxDeleteCount; index += 1) {
    const fallbackCommandOptions = buildFallbackCommandOptions();
    if (!fallbackCommandOptions) {
      break;
    }

    runCommand(adbPath, ["-s", serial, "shell", "input", "keyevent", "KEYCODE_DEL"], fallbackCommandOptions);
  }
}

function findCatalogRiskModelCard(adbPath, serial, snapshot = null) {
  const resolvedSnapshot = snapshot || createUiSnapshot(adbPath, serial);
  const riskBadges = findNodesForLabelsInSnapshot(resolvedSnapshot, RAM_FIT_RISK_BADGE_LABELS, {
    visibleOnly: true,
  }).filter((node) => isBoundsClearOfBottomOverlay(node.bounds, resolvedSnapshot.viewportBounds));
  const detailNodes = findNodesForLabelsInSnapshot(resolvedSnapshot, MODEL_DETAILS_CTA_LABELS, {
    visibleOnly: true,
  }).filter((node) => isBoundsClearOfBottomOverlay(node.bounds, resolvedSnapshot.viewportBounds));

  if (riskBadges.length === 0 || detailNodes.length === 0) {
    return null;
  }

  const pair = pickClosestNodePair(riskBadges, detailNodes);
  if (!pair) {
    return null;
  }

  return {
    riskBadgeNode: pair.sourceNode,
    detailsNode: pair.targetNode,
  };
}

class ScenarioSkipError extends Error {}

class ScenarioSkipFailureError extends Error {}

function shouldAppendRunnerFailure(error) {
  return !(error instanceof ScenarioSkipFailureError);
}

function recordScenarioSkip({
  scenario,
  results,
  startedAt,
  reason,
  context,
}) {
  const durationMs = Date.now() - startedAt;

  if (cliOptions.failOnSkip) {
    const screenshotPath = context.captureScreenshot(`${scenario.id}-skipped.png`);
    const message = `Scenario ${scenario.id} skipped while --fail-on-skip is enabled: ${reason}`;
    results.push({
      id: scenario.id,
      tier: scenario.tier,
      status: "failed",
      durationMs,
      screenshotPath,
      error: message,
      skipReason: reason,
    });
    writeReport(results);
    log(`FAIL ${scenario.id}: ${message}`);
    throw new ScenarioSkipFailureError(message);
  }

  results.push({
    id: scenario.id,
    tier: scenario.tier,
    status: "skipped",
    durationMs,
    reason,
  });
  log(`SKIP ${scenario.id}: ${reason}`);
}

function assertAttachmentPreviewRemovePreconditions({
  attachNode = null,
  fallbackNode = null,
  previewNode = null,
  removeNode = null,
} = {}) {
  if (fallbackNode) {
    throw new ScenarioSkipError(
      "Prepared image attachment preview/remove precondition failed: the composer is still showing text-only fallback copy. Open a running vision-ready chat composer, attach a gallery image, then rerun this scenario with --preserve-running-app."
    );
  }

  if (!previewNode || !removeNode) {
    const missingParts = [
      !previewNode ? "attached image preview" : null,
      !removeNode ? "remove attached image action" : null,
    ].filter(Boolean).join(" and ");

    throw new ScenarioSkipError(
      `Prepared image attachment preview/remove precondition failed: missing ${missingParts}. Open a running vision-ready chat composer, attach a gallery image, then rerun this scenario with --preserve-running-app.`
    );
  }

  assertAttachmentActionAvailable(attachNode);
}

function assertAttachmentTextOnlyFallbackState({
  fallbackNode = null,
  attachNode = null,
} = {}) {
  if (!fallbackNode) {
    throw new ScenarioSkipError(
      "Text-only attachment fallback was not visible after navigating to a no-model chat state; a deterministic text-only composer could not be established."
    );
  }

  assertAttachmentActionBlocked(attachNode);
}

function assertAttachmentActionBlocked(attachNode) {
  const node = attachNode && attachNode.node ? attachNode.node : attachNode;

  if (!node) {
    throw new Error("Image attachment action was not visible in the text-only fallback state.");
  }

  if (node.clickable && node.enabled !== false) {
    throw new Error("Image attachment action is still enabled while the text-only fallback is visible.");
  }
}

function assertAttachmentActionAvailable(attachNode) {
  const node = attachNode && attachNode.node ? attachNode.node : attachNode;

  if (!node) {
    throw new Error("Image attachment action was not visible in the vision-ready composer state.");
  }

  if (node.enabled === false) {
    throw new Error("Image attachment action is disabled while no text-only fallback is visible.");
  }

  if (!node.clickable) {
    throw new Error("Image attachment action is not actionable while no text-only fallback is visible.");
  }
}

function buildScenarios() {
  return [
    {
      id: "home-smoke",
      tier: "core",
      description: "Verify the home screen loads and key call-to-actions are visible.",
      run: async (ctx) => {
        await goToHome(ctx);
        await ctx.expectAnyText(APP_TITLE_LABELS);
        await ctx.expectAnyText(NEW_CHAT_LABELS);
        await ctx.expectAnyText(HOME_SECTION_LABELS);
        await ctx.expectAnyText(ACTIVE_MODEL_CTA_LABELS);
      },
    },
    {
      id: "bottom-tabs",
      tier: "core",
      description: "Verify bottom tab navigation across Home, Chat, Models, and Settings.",
      run: async (ctx) => {
        await goToHome(ctx);
        await ctx.tapBottomTab(CHAT_TAB_LABELS);
        await ctx.expectAnyText(CHAT_ROUTE_LABELS);

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
      id: "style-screenshots",
      tier: "secondary",
      description: "Capture stable Home, Chat, Models, and Settings screenshots for styling dependency checks.",
      run: async (ctx) => {
        await goToHome(ctx);
        await ctx.expectAnyText(APP_TITLE_LABELS);
        ctx.captureScreenshot("style-home.png");

        await ctx.tapBottomTab(CHAT_TAB_LABELS);
        await ctx.expectAnyText(CHAT_ROUTE_LABELS);
        ctx.captureScreenshot("style-chat.png");

        await ctx.tapBottomTab(MODELS_TAB_LABELS);
        await ctx.expectAnyText(MODEL_CATALOG_LABELS);
        await ctx.expectAnyText(ALL_MODELS_LABELS);
        ctx.captureScreenshot("style-models.png");

        await ctx.tapBottomTab(SETTINGS_TAB_LABELS);
        await ctx.expectAnyText(SETTINGS_TITLE_LABELS);
        await scrollToAnyText(ctx, LANGUAGE_ROW_LABELS, { timeoutMs: SETTINGS_ROUTE_TIMEOUT_MS });
        ctx.captureScreenshot("style-settings.png");
      },
    },
    {
      id: "new-chat-cta",
      tier: "core",
      description: "Verify the Home screen New Chat button opens the chat screen empty state.",
      run: async (ctx) => {
        await goToHome(ctx);
        await ctx.tapAnyText(NEW_CHAT_LABELS);
        await ctx.expectAnyText(CHAT_EMPTY_LABELS);
        await ctx.tapBottomTab(HOME_TAB_LABELS);
        await ctx.expectAnyText(NEW_CHAT_LABELS);
      },
    },
    {
      id: "chat-attachment-text-only-fallback",
      tier: "secondary",
      description: "Verify the chat composer exposes image attachment state with text-only fallback copy.",
      run: async (ctx) => {
        await ensureNoModelTextOnlyAttachmentState(ctx);
        await ctx.tapAnyText(NEW_CHAT_LABELS);
        await ctx.expectAnyText(CHAT_EMPTY_LABELS);
        await ctx.expectAnyText(ATTACH_IMAGE_LABELS, { timeoutMs: 8_000 });

        const adbPath = resolveAdbPath();
        const fallbackNode = await findAnyNodeNow(
          adbPath,
          ctx.serial,
          IMAGE_ATTACHMENT_TEXT_ONLY_FALLBACK_LABELS,
          { visibleOnly: true }
        );

        const attachNode = await findAnyNodeNow(
          adbPath,
          ctx.serial,
          ATTACH_IMAGE_LABELS,
          { visibleOnly: true }
        );

        assertAttachmentTextOnlyFallbackState({ fallbackNode, attachNode });

        await ctx.tapBottomTab(HOME_TAB_LABELS);
        await ctx.expectAnyText(HOME_SECTION_LABELS);
      },
    },
    {
      id: "chat-attachment-preview-remove",
      tier: "optional",
      description: "Verify a prepared running vision-ready image attachment draft can be previewed and removed without restarting the app.",
      run: async (ctx) => {
        await ctx.expectAnyText(ATTACH_IMAGE_LABELS, { timeoutMs: 8_000 });

        const adbPath = resolveAdbPath();
        const fallbackNode = await findAnyNodeNow(
          adbPath,
          ctx.serial,
          IMAGE_ATTACHMENT_TEXT_ONLY_FALLBACK_LABELS,
          { visibleOnly: true }
        );
        const attachNode = await findAnyNodeNow(
          adbPath,
          ctx.serial,
          ATTACH_IMAGE_LABELS,
          { visibleOnly: true }
        );

        const previewNode = await findAnyNodeNow(
          adbPath,
          ctx.serial,
          ATTACHMENT_PREVIEW_LABELS,
          { visibleOnly: true }
        );
        const removeNode = await findAnyNodeNow(
          adbPath,
          ctx.serial,
          REMOVE_ATTACHMENT_LABELS,
          { visibleOnly: true }
        );

        assertAttachmentPreviewRemovePreconditions({
          attachNode,
          fallbackNode,
          previewNode,
          removeNode,
        });

        await ctx.tapAnyText(REMOVE_ATTACHMENT_LABELS, {
          allowBottomOverlay: true,
          timeoutMs: 5_000,
        });
        await waitForNoAnyNode(adbPath, ctx.serial, ATTACHMENT_PREVIEW_LABELS, { timeoutMs: 5_000 });
        await waitForNoAnyNode(adbPath, ctx.serial, REMOVE_ATTACHMENT_LABELS, { timeoutMs: 5_000 });
        await ctx.expectAnyText(ATTACH_IMAGE_LABELS, { timeoutMs: 5_000 });
        const restoredAttachNode = await findAnyNodeNow(
          adbPath,
          ctx.serial,
          ATTACH_IMAGE_LABELS,
          { visibleOnly: true }
        );
        assertAttachmentActionAvailable(restoredAttachNode);
      },
    },
    {
      id: "chat-attachment-prepared-send",
      tier: "optional",
      description: "Verify a manually prepared vision-ready image attachment draft can be sent without restarting the app.",
      run: async (ctx) => {
        const preparedAttachmentSendPrompt = buildPreparedAttachmentSendPrompt();
        await ctx.expectAnyText(ATTACH_IMAGE_LABELS, { timeoutMs: 8_000 });

        const adbPath = resolveAdbPath();
        const fallbackNode = await findAnyNodeNow(
          adbPath,
          ctx.serial,
          IMAGE_ATTACHMENT_TEXT_ONLY_FALLBACK_LABELS,
          { visibleOnly: true }
        );
        const attachNode = await findAnyNodeNow(
          adbPath,
          ctx.serial,
          ATTACH_IMAGE_LABELS,
          { visibleOnly: true }
        );
        const previewNode = await findAnyNodeNow(
          adbPath,
          ctx.serial,
          ATTACHMENT_PREVIEW_LABELS,
          { visibleOnly: true }
        );
        const removeNode = await findAnyNodeNow(
          adbPath,
          ctx.serial,
          REMOVE_ATTACHMENT_LABELS,
          { visibleOnly: true }
        );

        assertAttachmentPreviewRemovePreconditions({
          attachNode,
          fallbackNode,
          previewNode,
          removeNode,
        });

        await ctx.tapAnyText(CHAT_INPUT_LABELS, {
          allowBottomOverlay: true,
          timeoutMs: 5_000,
        });
        clearFocusedTextInput(adbPath, ctx.serial);
        runChecked(adbPath, [
          "-s",
          ctx.serial,
          "shell",
          "input",
          "text",
          escapeAdbInputText(preparedAttachmentSendPrompt),
        ], { timeout: ADB_INPUT_TEXT_TIMEOUT_MS });
        await delay(500);

        await waitForAnyNode(adbPath, ctx.serial, [preparedAttachmentSendPrompt], {
          timeoutMs: 5_000,
          visibleOnly: true,
        });

        const sendNode = await findAnyNodeNow(
          adbPath,
          ctx.serial,
          CHAT_SEND_LABELS,
          { visibleOnly: true }
        );
        if (!sendNode || sendNode.node.enabled === false) {
          throw new Error("Prepared attachment send button is not enabled after entering the prompt.");
        }

        await ctx.tapAnyText(CHAT_SEND_LABELS, {
          allowBottomOverlay: true,
          timeoutMs: 5_000,
          afterTapDelayMs: 1_500,
        });
        await waitForNoAnyNode(adbPath, ctx.serial, ATTACHMENT_PREVIEW_LABELS, { timeoutMs: 8_000 });
        await waitForNoAnyNode(adbPath, ctx.serial, REMOVE_ATTACHMENT_LABELS, { timeoutMs: 8_000 });
        await waitForPreparedSentMessageContext(adbPath, ctx.serial, preparedAttachmentSendPrompt, {
          timeoutMs: 10_000,
        });
        await ctx.expectAnyText([preparedAttachmentSendPrompt], { timeoutMs: 10_000 });
      },
    },
    {
      id: "variant-picker-smoke",
      tier: "optional",
      description: "Verify the model catalog opens the GGUF file variant picker.",
      run: async (ctx) => {
        await goToHome(ctx);
        await ctx.tapAnyText(ACTIVE_MODEL_CTA_LABELS);
        await ctx.expectAnyText(MODEL_CATALOG_LABELS);
        await prepareCatalogForVariantPickerSmokeScenario(ctx);

        await openFirstVisibleVariantPicker(ctx);
        await ctx.expectAnyText(VARIANT_PICKER_TITLE_LABELS, { timeoutMs: 10_000 });

        await ctx.pressBack();
        await ctx.expectAnyText(MODEL_CATALOG_LABELS, { timeoutMs: 8_000 });
        await ctx.tapBottomTab(HOME_TAB_LABELS);
        await ctx.expectAnyText(HOME_SECTION_LABELS);
      },
    },
    {
      id: "swap-model-cta",
      tier: "secondary",
      description: "Verify the Home screen active-model CTA opens the model catalog.",
      run: async (ctx) => {
        await goToHome(ctx);
        await ctx.tapAnyText(ACTIVE_MODEL_CTA_LABELS);
        await ctx.expectAnyText(MODEL_CATALOG_LABELS);
        await ctx.expectAnyText(ALL_MODELS_LABELS);
        await ctx.expectAnyText(DOWNLOADED_TAB_LABELS);
        await ctx.tapBottomTab(HOME_TAB_LABELS);
        await ctx.expectAnyText(ACTIVE_MODEL_CTA_LABELS);
      },
    },
    {
      id: "hf-catalog-hardening",
      tier: "optional",
      description: "Verify guided discovery, new HF catalog controls, and routed model details.",
      run: async (ctx) => {
        await goToHome(ctx);
        await ctx.tapAnyText(ACTIVE_MODEL_CTA_LABELS);
        await ctx.expectAnyText(MODEL_CATALOG_LABELS);

        await ctx.tapAnyText(MODELS_FILTER_TOGGLE_LABELS);
        await ctx.expectAnyText(MODELS_FILTER_NO_TOKEN_REQUIRED_LABELS);

        await ctx.tapAnyText(SORT_LABELS);
        await ctx.expectAnyText(MOST_DOWNLOADED_LABELS);
        await ctx.expectAnyText(MOST_POPULAR_LABELS);
        await ctx.tapAnyText(SORT_LABELS);

        await ctx.tapAnyText(MODEL_DETAILS_CTA_LABELS, { timeoutMs: 15_000 });
        await ctx.expectAnyText(MODEL_DETAILS_TITLE_LABELS);
        await ctx.expectAnyText(OPEN_ON_HF_LABELS);
      },
    },
    {
      id: "memory-fit-badges",
      tier: "optional",
      description: "Verify memory-fit badges show up in quantization picker rows.",
      run: async (ctx) => {
        await goToHome(ctx);
        await ctx.tapAnyText(ACTIVE_MODEL_CTA_LABELS);
        await ctx.expectAnyText(MODEL_CATALOG_LABELS);
        await prepareCatalogForMemoryFitRiskBadgeScenario(ctx);

        await openFirstVisibleVariantPicker(ctx);
        await ctx.expectAnyText(VARIANT_PICKER_TITLE_LABELS, { timeoutMs: 10_000 });
        await ctx.expectAnyText(RAM_FIT_BADGE_LABELS, { timeoutMs: 10_000 });
        ctx.captureScreenshot("memory-fit-variant-picker.png");
      },
    },
    {
      id: "memory-fit-download-warning",
      tier: "optional",
      description: "Verify download flows warn for RAM risk or limited verification.",
      run: async (ctx) => {
        await goToHome(ctx);
        await ctx.tapAnyText(ACTIVE_MODEL_CTA_LABELS);
        await ctx.expectAnyText(MODEL_CATALOG_LABELS);
        await prepareCatalogForRamWarningScenario(ctx);

        const adbPath = resolveAdbPath();

        for (let attempt = 0; attempt < 6; attempt += 1) {
          const riskModelCard = findCatalogRiskModelCard(adbPath, ctx.serial);

          if (!riskModelCard) {
            await ctx.swipeUp();
            continue;
          }

          tapBounds(adbPath, ctx.serial, riskModelCard.detailsNode.bounds);
          await delay(800);
          await ctx.expectAnyText(MODEL_DETAILS_TITLE_LABELS, { timeoutMs: 10_000 });

          await ctx.tapAnyText(DOWNLOAD_CTA_LABELS, { timeoutMs: 12_000 });
          await waitForAnyNode(adbPath, ctx.serial, DOWNLOAD_WARNING_TITLE_LABELS, {
            timeoutMs: 8_000,
            visibleOnly: true,
          });

          await ctx.tapAnyText(DOWNLOAD_WARNING_CANCEL_LABELS, {
            timeoutMs: 5_000,
            allowBottomOverlay: true,
          });
          await ctx.pressBack();
          await ctx.expectAnyText(MODEL_CATALOG_LABELS, { timeoutMs: 8_000 });
          return;
        }

        throw new ScenarioSkipError(
          "No RAM-risk model was found to validate the download warning flow."
        );
      },
    },
    {
      id: "hf-token-education",
      tier: "secondary",
      description: "Verify the token education screen and external-token CTA are reachable from Settings.",
      run: async (ctx) => {
        await goToSettings(ctx);
        await scrollToAnyText(ctx, HF_TOKEN_LABELS, { timeoutMs: SETTINGS_ROUTE_TIMEOUT_MS });
        await ctx.tapAnyText(HF_TOKEN_LABELS);
        await ctx.expectAnyText(ACCESS_TOKEN_LABELS);
        await ctx.swipeUp();
        await ctx.expectAnyText(TOKEN_PURPOSE_LABELS);
        await ctx.expectAnyText(GET_TOKEN_LABELS);
      },
    },
    {
      id: "language-switch",
      tier: "secondary",
      description: "Verify language switching updates navigation and home copy, then restores the original language.",
      run: async (ctx) => {
        await goToSettings(ctx);
        await scrollToAnyText(ctx, LANGUAGE_ROW_LABELS, { timeoutMs: SETTINGS_ROUTE_TIMEOUT_MS });

        const adbPath = resolveAdbPath();
        const englishRow = await findAnyNodeNow(adbPath, ctx.serial, ["Language"], {
          visibleOnly: true,
        });
        const russianRow = englishRow
          ? null
          : await findAnyNodeNow(adbPath, ctx.serial, ["Язык"], {
              visibleOnly: true,
            });

        if (!englishRow && !russianRow) {
          throw new Error("Could not detect the current language row before toggling language.");
        }

        const startedInEnglish = Boolean(englishRow);
        const currentLanguageLabel = startedInEnglish ? ["Language"] : ["Язык"];
        const nextLanguageLabel = startedInEnglish ? ["Язык"] : ["Language"];
        const nextHomeLabel = startedInEnglish ? ["Недавние разговоры"] : ["Recent Conversations"];
        const restoredHomeLabel = startedInEnglish ? ["Recent Conversations"] : ["Недавние разговоры"];

        let languageToggled = false;
        let scenarioError = null;

        try {
          await ctx.tapAnyText(currentLanguageLabel, { afterTapDelayMs: 1_200 });
          languageToggled = true;
          await ctx.expectAnyText(nextLanguageLabel, { timeoutMs: 10_000 });
          await ctx.tapBottomTab(HOME_TAB_LABELS);
          await ctx.expectAnyText(nextHomeLabel, { timeoutMs: 10_000 });
        } catch (error) {
          scenarioError = error;
          throw error;
        } finally {
          if (languageToggled) {
            try {
              await restoreLanguageAfterScenario(ctx, currentLanguageLabel, nextLanguageLabel, restoredHomeLabel);
            } catch (restoreError) {
              if (!scenarioError) {
                throw restoreError;
              }

              log(
                `WARN language restore failed after scenario error: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`
              );
            }
          }
        }
      },
    },
    {
      id: "conversations-management",
      tier: "secondary",
      description: "Verify the conversation management route is reachable from Home.",
      run: async (ctx) => {
        await goToConversationManagement(ctx);
        await ctx.expectAnyText(CONVERSATIONS_TITLE_LABELS);
        await ctx.expectAnyText(CONVERSATIONS_SEARCH_LABELS);
        await ctx.expectAnyText(NEW_CHAT_LABELS);
      },
    },
    {
      id: "performance-logcat",
      tier: "optional",
      description: "Verify the Performance screen can dump a trace to logcat in dev builds.",
      run: async (ctx) => {
        await goToSettings(ctx);
        await scrollToAnyText(ctx, PERFORMANCE_ROW_LABELS, { timeoutMs: SETTINGS_ROUTE_TIMEOUT_MS });

        await ctx.tapAnyText(PERFORMANCE_ROW_LABELS);
        await ctx.expectAnyText(PERFORMANCE_COPY_TRACE_LABELS);

        const adbPath = resolveAdbPath();
        const enableInstrumentation = await findAnyNodeNow(adbPath, ctx.serial, PERFORMANCE_ENABLE_INSTRUMENTATION_LABELS, {
          visibleOnly: true,
        });

        if (enableInstrumentation) {
          await scrollToAnyText(ctx, PERFORMANCE_ENABLE_INSTRUMENTATION_LABELS, {
            timeoutMs: 5_000,
            maxSwipesDown: 0,
          });
          await ctx.tapAnyText(PERFORMANCE_ENABLE_INSTRUMENTATION_LABELS);
        }

        runChecked(adbPath, ["-s", ctx.serial, "logcat", "-c"]);

        await scrollToAnyText(ctx, PERFORMANCE_DUMP_TO_LOGCAT_LABELS, {
          timeoutMs: 5_000,
          maxSwipesDown: 0,
        });
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

function selectScenarios(scenarios, options) {
  if (options.scenario) {
    return scenarios.filter((scenario) => scenario.id === options.scenario);
  }

  const requestedPack = options.pack || DEFAULT_SCENARIO_PACK;
  if (requestedPack === "all") {
    // Prepared scenarios depend on in-memory app state set up manually by the tester, so keep
    // them out of broad automated packs. They remain available by direct id or pack name.
    const manualPreparedScenarioIds = new Set([
      ...PREPARED_ATTACHMENT_SCENARIOS,
      ...PREPARED_ATTACHMENT_SEND_SCENARIOS,
    ]);
    return scenarios.filter((scenario) => !manualPreparedScenarioIds.has(scenario.id));
  }

  const scenarioIds = SCENARIO_PACK_SCENARIOS[requestedPack];
  if (!scenarioIds) {
    return [];
  }

  const scenariosById = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  return scenarioIds
    .map((scenarioId) => scenariosById.get(scenarioId))
    .filter(Boolean);
}

async function goToHome(ctx) {
  await ctx.ensureAppVisible();
  await ctx.dismissDebuggerBanner();

  const adbPath = resolveAdbPath();
  const homeVisibleNow = await findAnyNodeNow(adbPath, ctx.serial, HOME_SECTION_LABELS, {
    visibleOnly: true,
  });

  if (homeVisibleNow) {
    await ctx.expectAnyText(APP_TITLE_LABELS, { timeoutMs: 5_000 });
    return;
  }

  try {
    await ctx.expectAnyText(HOME_SECTION_LABELS, { timeoutMs: 8_000 });
  } catch {
    const reachedHome = await tryReachHome(ctx);

    if (!reachedHome) {
      throw new Error(withUiSummary(adbPath, ctx.serial, `Timed out returning to Home from the current route.`));
    }

    await ctx.expectAnyText(HOME_SECTION_LABELS, { timeoutMs: 15_000 });
  }

  await ctx.expectAnyText(APP_TITLE_LABELS);
}

async function ensureNoModelTextOnlyAttachmentState(ctx) {
  await goToHome(ctx);

  const adbPath = resolveAdbPath();
  const unloadNode = await findAnyNodeNow(adbPath, ctx.serial, UNLOAD_MODEL_LABELS, {
    visibleOnly: true,
  });

  if (unloadNode?.node?.bounds) {
    tapBounds(adbPath, ctx.serial, unloadNode.node.bounds);
    await delay(2_500);
    await goToHome(ctx);
  }

  const noModelNode = await findAnyNodeNow(
    adbPath,
    ctx.serial,
    [
      "NO MODEL LOADED",
      "МОДЕЛЬ НЕ ЗАГРУЖЕНА",
      "Choose a local model",
      "Выберите локальную модель",
      "Browse Models",
      "Открыть каталог",
    ],
    { visibleOnly: true }
  );

  if (!noModelNode) {
    throw new ScenarioSkipError(
      "Could not establish a deterministic no-model chat state for the text-only attachment fallback smoke without resetting app data."
    );
  }
}

async function tryReachHome(ctx, maxAttempts = 4) {
  const adbPath = resolveAdbPath();

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const blockingDialogAction = await dismissBlockingSystemDialogIfPresent(adbPath, ctx.serial);
    if (blockingDialogAction) {
      if (blockingDialogAction === "close-app") {
        await ctx.pressHome();
        await ctx.ensureAppVisible();
      }
      continue;
    }

    const downloadWarning = await findAnyNodeNow(adbPath, ctx.serial, DOWNLOAD_WARNING_TITLE_LABELS, {
      visibleOnly: true,
    });
    if (downloadWarning) {
      await ctx.tapAnyText(DOWNLOAD_WARNING_CANCEL_LABELS, {
        timeoutMs: 5_000,
        allowBottomOverlay: true,
      });
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
      await ctx.tapAnyText(APP_TITLE_LABELS, { afterTapDelayMs: 1_500, timeoutMs: 5_000 });
      continue;
    }

    const homeNode = await findAnyNodeNow(adbPath, ctx.serial, HOME_TAB_LABELS, {
      visibleOnly: true,
    });
    if (homeNode) {
      await ctx.tapBottomTab(HOME_TAB_LABELS, { afterTapDelayMs: 500 });
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

async function restoreLanguageAfterScenario(
  ctx,
  originalLanguageLabel,
  alternateLanguageLabel,
  restoredHomeLabel,
  options = {}
) {
  const goSettings = options.goToSettings || goToSettings;
  const resolveAdb = options.resolveAdbPath || resolveAdbPath;
  const findNodeNow = options.findAnyNodeNow || findAnyNodeNow;
  const scrollToText = options.scrollToAnyText || scrollToAnyText;

  await goSettings(ctx);
  await scrollToText(ctx, [...originalLanguageLabel, ...alternateLanguageLabel], {
    timeoutMs: SETTINGS_ROUTE_TIMEOUT_MS,
  });

  const adbPath = resolveAdb();
  const originalLanguageRow = await findNodeNow(adbPath, ctx.serial, originalLanguageLabel, {
    visibleOnly: true,
  });

  if (!originalLanguageRow) {
    await ctx.tapAnyText(alternateLanguageLabel, { afterTapDelayMs: 1_200 });
    await ctx.expectAnyText(originalLanguageLabel, { timeoutMs: 10_000 });
  }

  await ctx.tapBottomTab(HOME_TAB_LABELS);
  await ctx.expectAnyText(restoredHomeLabel, { timeoutMs: 10_000 });
}

async function goToConversationManagement(ctx) {
  await goToHome(ctx);
  await ctx.tapAnyText(MANAGE_CONVERSATIONS_LABELS);
  await ctx.expectAnyText(CONVERSATIONS_TITLE_LABELS);
}

async function prepareCatalogForMemoryFitRiskBadgeScenario(ctx) {
  const adbPath = resolveAdbPath();

  const panelAlreadyOpen = await findAnyNodeNow(adbPath, ctx.serial, MODELS_FILTER_SIZE_LARGE_LABELS, {
    visibleOnly: true,
  });

  if (!panelAlreadyOpen) {
    await ctx.tapAnyText(MODELS_FILTER_TOGGLE_LABELS);
    await ctx.expectAnyText(MODELS_FILTER_SIZE_LARGE_LABELS);
  }

  const clearButton = await findAnyNodeNow(adbPath, ctx.serial, MODELS_FILTER_CLEAR_LABELS, {
    visibleOnly: true,
  });

  if (clearButton) {
    await ctx.tapAnyText(MODELS_FILTER_CLEAR_LABELS);
    await delay(600);
  }

  await ctx.tapAnyText(MODELS_FILTER_SIZE_LARGE_LABELS);
  await delay(1_200);
  await ctx.tapAnyText(MODELS_FILTER_TOGGLE_LABELS);
  await ctx.expectAnyText(MODEL_CATALOG_LABELS);
}

async function prepareCatalogForVariantPickerSmokeScenario(ctx, options = {}) {
  const resolveAdb = options.resolveAdbPath || resolveAdbPath;
  const findNodeNow = options.findAnyNodeNow || findAnyNodeNow;
  const adbPath = resolveAdb();

  const allModelsTab = await findNodeNow(adbPath, ctx.serial, ALL_MODELS_LABELS, {
    visibleOnly: true,
  });
  if (allModelsTab?.node?.bounds) {
    await ctx.tapAnyText(ALL_MODELS_LABELS, {
      afterTapDelayMs: 600,
      timeoutMs: 5_000,
    });
  }

  const filterPanelOpen = await findNodeNow(
    adbPath,
    ctx.serial,
    [
      ...MODELS_FILTER_SIZE_LARGE_LABELS,
      ...MODELS_FILTER_NO_TOKEN_REQUIRED_LABELS,
      ...MODELS_FILTER_CLEAR_LABELS,
    ],
    { visibleOnly: true }
  );

  if (!filterPanelOpen) {
    await ctx.tapAnyText(MODELS_FILTER_TOGGLE_LABELS, {
      afterTapDelayMs: 600,
      timeoutMs: 8_000,
    });
    await ctx.expectAnyText(MODELS_FILTER_NO_TOKEN_REQUIRED_LABELS, { timeoutMs: 8_000 });
  }

  const clearButton = await findNodeNow(adbPath, ctx.serial, MODELS_FILTER_CLEAR_LABELS, {
    visibleOnly: true,
  });
  if (clearButton) {
    await ctx.tapAnyText(MODELS_FILTER_CLEAR_LABELS, {
      afterTapDelayMs: 600,
      timeoutMs: 5_000,
    });
  }

  const filterPanelStillOpen = await findNodeNow(adbPath, ctx.serial, MODELS_FILTER_NO_TOKEN_REQUIRED_LABELS, {
    visibleOnly: true,
  });
  if (filterPanelStillOpen) {
    await ctx.tapAnyText(MODELS_FILTER_TOGGLE_LABELS, {
      afterTapDelayMs: 600,
      timeoutMs: 5_000,
    });
  }

  await ctx.expectAnyText(MODEL_CATALOG_LABELS, { timeoutMs: 8_000 });
}

async function openFirstVisibleVariantPicker(ctx, options = {}) {
  const resolveAdb = options.resolveAdbPath || resolveAdbPath;
  const createSnapshot = options.createUiSnapshot || createUiSnapshot;
  const findNodeNow = options.findAnyNodeNow || findAnyNodeNow;
  const waitForAny = options.waitForAnyNode || waitForAnyNode;
  const tap = options.tapBounds || tapBounds;
  const waitAfterTapTimeoutMs = options.waitAfterTapTimeoutMs ?? 2_000;
  const adbPath = resolveAdb();
  const maxAttempts = 8;

  const initialPickerAlreadyOpen = await findNodeNow(adbPath, ctx.serial, VARIANT_PICKER_TITLE_LABELS, {
    visibleOnly: true,
  });
  if (initialPickerAlreadyOpen) {
    return;
  }

  await waitForVariantPickerCatalogScanTarget(adbPath, ctx.serial, {
    createSnapshot,
    timeoutMs: options.catalogReadyTimeoutMs,
    pollIntervalMs: options.catalogReadyPollIntervalMs,
    delayFn: options.delayFn,
  });

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const pickerAlreadyOpen = await findNodeNow(adbPath, ctx.serial, VARIANT_PICKER_TITLE_LABELS, {
      visibleOnly: true,
    });
    if (pickerAlreadyOpen) {
      return;
    }

    const snapshot = createSnapshot(adbPath, ctx.serial);
    const quantizationNode = findQuantizationSelectorNodeClearOfBottomOverlay(snapshot);

    if (quantizationNode?.node.bounds) {
      tap(adbPath, ctx.serial, quantizationNode.node.bounds);

      try {
        await waitForAny(adbPath, ctx.serial, VARIANT_PICKER_TITLE_LABELS, {
          timeoutMs: waitAfterTapTimeoutMs,
          visibleOnly: true,
        });
        return;
      } catch (error) {
        if (!isWaitForAnyNodeTimeout(error)) {
          throw error;
        }
        // Keep scanning; the tapped quantization text may have belonged to a non-interactive row.
      }
    }

    await ctx.swipeUp();
  }

  throw new Error(withUiSummary(adbPath, ctx.serial, "Timed out opening a visible quantization picker."));
}

async function waitForVariantPickerCatalogScanTarget(adbPath, serial, options = {}) {
  const createSnapshot = options.createSnapshot || createUiSnapshot;
  const timeoutMs = options.timeoutMs ?? 12_000;
  const pollIntervalMs = options.pollIntervalMs ?? 600;
  const wait = options.delayFn || delay;
  const startedAt = Date.now();
  let lastState = "waiting for catalog content";

  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = createSnapshot(adbPath, serial);

    const pickerAlreadyOpen = findAnyNodeInSnapshot(snapshot, VARIANT_PICKER_TITLE_LABELS, {
      visibleOnly: true,
    });
    if (pickerAlreadyOpen) {
      return;
    }

    if (findQuantizationSelectorNodeClearOfBottomOverlay(snapshot)) {
      return;
    }

    const emptyOrError = findAnyNodeInSnapshot(snapshot, MODEL_CATALOG_EMPTY_OR_ERROR_LABELS, {
      visibleOnly: true,
    });
    if (emptyOrError) {
      throw new Error(withUiSummary(
        adbPath,
        serial,
        `Catalog reached ${emptyOrError.label || "an empty/error state"} before a variant picker row appeared.`
      ));
    }

    const loading = findAnyNodeInSnapshot(snapshot, MODEL_CATALOG_LOADING_LABELS, {
      visibleOnly: true,
    });
    lastState = loading ? "catalog still loading" : "waiting for catalog rows";
    await wait(pollIntervalMs);
  }

  throw new Error(withUiSummary(
    adbPath,
    serial,
    `Timed out waiting for catalog rows before opening a variant picker (${lastState}).`
  ));
}

function isWaitForAnyNodeTimeout(error) {
  return error instanceof Error
    && error.message.includes("Timed out waiting for any of:");
}

function findQuantizationSelectorNodeClearOfBottomOverlay(snapshot) {
  const candidates = snapshot.nodes.filter((node) => (
    node.clickable
    && isLikelyQuantizationSelectorNode(node)
    && isBoundsClearOfBottomOverlay(node.bounds, snapshot.viewportBounds)
  ));
  const node = pickBestNode(candidates);
  return node ? { label: "quantization-value", node } : null;
}

function isLikelyQuantizationSelectorNode(node) {
  const normalizedLabel = normalizeUiLabel(`${node.text || ""} ${node.contentDesc || ""}`);
  const hasQuantizationValue = /\b(?:(?:i?q|tq)\d(?:_[a-z0-9]+){0,3}|bf16|f16|fp16)\b/.test(normalizedLabel);
  const hasSizeContext = normalizedLabel.includes(" gb")
    || normalizedLabel.includes("unknown")
    || normalizedLabel.includes("неизвестно");
  return hasQuantizationValue && hasSizeContext;
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

async function scrollToAnyText(ctx, labels, options = {}) {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxSwipesDown = options.maxSwipesDown ?? 3;
  const maxSwipesUp = options.maxSwipesUp ?? 10;
  const requireClearTapArea = options.requireClearTapArea !== false;
  const adbPath = resolveAdbPath();
  const startedAt = Date.now();

  const findNow = async () => {
    const snapshot = createUiSnapshot(adbPath, ctx.serial);

    if (!requireClearTapArea) {
      return findAnyNodeInSnapshot(snapshot, labels, { visibleOnly: true });
    }

    return findAnyNodeClearOfBottomOverlay(snapshot, labels, options);
  };

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

function launchApp(resolvedSerial) {
  const args = buildSmokeLaunchArgs(cliOptions, resolvedSerial);

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

function buildSmokeLaunchArgs(options, resolvedSerial) {
  const args = [path.join(__dirname, "android-smoke.js")];

  if (options.bootstrapScreenshot) {
    args.push(
      "--screenshot",
      path.join("artifacts", "android-scenarios", "bootstrap.png")
    );
  }

  if (options.emulator) {
    args.push("--emulator");
  }

  if (options.avd) {
    args.push("--avd", options.avd);
  }

  const serial = options.serial || resolvedSerial;
  if (serial) {
    args.push("--serial", serial);
  }

  if (options.skipBuild) {
    args.push("--skip-build");
  }

  if (options.port) {
    args.push("--port", options.port);
  }

  return args;
}

function buildScenarioLaunchPlan(options, resolveSerial) {
  if (options.preserveRunningApp) {
    return {
      shouldLaunch: false,
      serialBeforeLaunch: resolveSerial(),
    };
  }

  if (options.emulator) {
    return {
      shouldLaunch: true,
      serialBeforeLaunch: null,
    };
  }

  return {
    shouldLaunch: true,
    serialBeforeLaunch: resolveSerial(),
  };
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

  const physicalDevices = devices.filter(
    (device) => !isEmulatorSerial(device.serial)
  );

  if (physicalDevices.length === 0) {
    throw new Error("Connect a phone and try again. No physical Android device is connected.");
  }

  if (physicalDevices.length > 1) {
    log(
      `Multiple Android phones are connected; defaulting to ${physicalDevices[0].serial}. Use --serial to override.`
    );
  }

  return physicalDevices[0].serial;
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
    const snapshot = createUiSnapshot(adbPath, serial);
    const node = findNodeInSnapshot(snapshot, label, options);
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
    const snapshot = createUiSnapshot(adbPath, serial);
    const match = findAnyNodeInSnapshot(snapshot, labels, options);
    if (match) {
      return match;
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

async function waitForNoAnyNode(adbPath, serial, labels, options = {}) {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = createUiSnapshot(adbPath, serial);
    const match = findAnyNodeInSnapshot(snapshot, labels, {
      ...options,
      visibleOnly: true,
    });
    if (!match) {
      return;
    }

    await delay(600);
  }

  throw new Error(
    withUiSummary(
      adbPath,
      serial,
      `Timed out waiting for all of these nodes to disappear: ${labels.map((label) => `"${label}"`).join(", ")}.`
    )
  );
}

async function waitForPreparedSentMessageContext(adbPath, serial, prompt, options = {}) {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = createUiSnapshot(adbPath, serial);
    const sentContext = findPreparedSentMessageContext(snapshot, prompt);

    if (sentContext) {
      return sentContext;
    }

    await delay(600);
  }

  throw new Error(
    withUiSummary(
      adbPath,
      serial,
      `Timed out waiting for sent message context containing prompt "${prompt}" and an image preview.`
    )
  );
}

function findPreparedSentMessageContext(snapshot, prompt) {
  const promptNodes = findMatchingNodes(snapshot, prompt, { visibleOnly: true });
  const previewMatches = MESSAGE_ATTACHMENT_PREVIEW_LABELS.flatMap((label) => (
    findMatchingNodes(snapshot, label, { visibleOnly: true }).map((node) => ({ label, node }))
  ));
  let bestMatch = null;

  for (const promptNode of promptNodes) {
    for (const previewMatch of previewMatches) {
      const score = scorePreparedSentMessagePair(promptNode.bounds, previewMatch.node.bounds);
      if (score === null) {
        continue;
      }

      if (!bestMatch || score < bestMatch.score) {
        bestMatch = {
          score,
          promptMatch: { label: prompt, node: promptNode },
          messagePreviewMatch: previewMatch,
        };
      }
    }
  }

  return bestMatch
    ? {
        promptMatch: bestMatch.promptMatch,
        messagePreviewMatch: bestMatch.messagePreviewMatch,
      }
    : null;
}

function scorePreparedSentMessagePair(promptBounds, previewBounds) {
  if (!promptBounds || !previewBounds) {
    return null;
  }

  const overlapWidth = Math.max(
    0,
    Math.min(promptBounds.right, previewBounds.right) - Math.max(promptBounds.left, previewBounds.left)
  );
  const minWidth = Math.max(1, Math.min(promptBounds.width, previewBounds.width));
  const horizontalOverlapRatio = overlapWidth / minWidth;
  if (horizontalOverlapRatio < 0.35) {
    return null;
  }

  const verticalGap = previewBounds.bottom <= promptBounds.top
    ? promptBounds.top - previewBounds.bottom
    : promptBounds.bottom <= previewBounds.top
      ? previewBounds.top - promptBounds.bottom
      : 0;
  if (verticalGap > 320) {
    return null;
  }

  const centerXDelta = Math.abs(promptBounds.centerX - previewBounds.centerX);
  const maxAllowedCenterXDelta = Math.max(promptBounds.width, previewBounds.width) * 0.75;
  if (centerXDelta > maxAllowedCenterXDelta) {
    return null;
  }

  const expectedImageAboveTextPenalty = previewBounds.bottom <= promptBounds.top ? 0 : 100;
  return (verticalGap * 10) + centerXDelta + expectedImageAboveTextPenalty;
}

async function waitForAnyTappableNode(adbPath, serial, labels, options = {}) {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = createUiSnapshot(adbPath, serial);
    const match = options.allowBottomOverlay
      ? findAnyNodeInSnapshot(snapshot, labels, { visibleOnly: true })
      : findAnyNodeClearOfBottomOverlay(snapshot, labels, options);

    if (match) {
      return match;
    }

    await delay(600);
  }

  throw new Error(
    withUiSummary(
      adbPath,
      serial,
      `Timed out waiting for a tappable node matching any of: ${labels.map((label) => `"${label}"`).join(", ")}.`
    )
  );
}

async function waitForAnyNodeWithPicker(adbPath, serial, labels, options = {}, picker) {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const startedAt = Date.now();
  const resolvedPicker = picker ?? pickBestNode;

  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = createUiSnapshot(adbPath, serial);
    const match = findAnyNodeInSnapshot(snapshot, labels, options, resolvedPicker);
    if (match) {
      return match;
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
  return findAnyNodeInSnapshot(createUiSnapshot(adbPath, serial), labels, options);
}

async function findNodeNow(adbPath, serial, label, options = {}) {
  return findNodeInSnapshot(createUiSnapshot(adbPath, serial), label, options);
}

function dumpUiHierarchy(adbPath, serial, options = {}) {
  const maxAttempts = options.maxAttempts ?? SCREENSHOT_CAPTURE_MAX_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? SCREENSHOT_CAPTURE_RETRY_DELAY_MS;
  const runSpawnSync = options.spawnSync ?? spawnSync;
  const runSleepSync = options.sleepSync ?? sleepSync;
  const failures = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let sawAdbDeviceUnavailable = false;
    const dumpResult = runSpawnSync(
      adbPath,
      ["-s", serial, "shell", "uiautomator", "dump", dumpPathOnDevice],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: UI_HIERARCHY_DUMP_COMMAND_TIMEOUT_MS,
      }
    );

    if (dumpResult.error) {
      if (!isRetryableSpawnError(dumpResult.error)) {
        throw dumpResult.error;
      }
      failures.push(describeSpawnError("uiautomator dump", dumpResult.error));
    } else if (dumpResult.status !== 0) {
      failures.push(describeSpawnResult("uiautomator dump", dumpResult));
      sawAdbDeviceUnavailable = sawAdbDeviceUnavailable || isAdbDeviceUnavailableResult(dumpResult);
    } else {
      const catResult = runSpawnSync(
        adbPath,
        ["-s", serial, "exec-out", "cat", dumpPathOnDevice],
        {
          encoding: "utf8",
          maxBuffer: 10 * 1024 * 1024,
          timeout: UI_HIERARCHY_DUMP_COMMAND_TIMEOUT_MS,
        }
      );

      if (catResult.error) {
        if (!isRetryableSpawnError(catResult.error)) {
          throw catResult.error;
        }
        failures.push(describeSpawnError("cat UI hierarchy", catResult.error));
      } else if (catResult.status === 0 && typeof catResult.stdout === "string" && catResult.stdout.includes("<hierarchy")) {
        return catResult.stdout;
      } else {
        failures.push(describeSpawnResult("cat UI hierarchy", catResult));
        sawAdbDeviceUnavailable = sawAdbDeviceUnavailable || isAdbDeviceUnavailableResult(catResult);
      }
    }

    if (attempt < maxAttempts) {
      if (sawAdbDeviceUnavailable) {
        const waitResult = waitForAdbDevice(adbPath, serial, runSpawnSync);
        failures.push(describeSpawnResult("adb wait-for-device", waitResult));
      }
      log(`UI hierarchy dump attempt ${attempt} failed; retrying.`);
      runSleepSync(retryDelayMs);
    }
  }

  throw new Error(
    `Failed to dump Android UI hierarchy after ${maxAttempts} attempts. `
    + failures.slice(-6).join(" | ")
  );
}

function createUiSnapshot(adbPath, serial) {
  return parseUiSnapshot(dumpUiHierarchy(adbPath, serial));
}

function parseUiSnapshot(xml) {
  const nodes = parseUiNodes(xml);
  return {
    xml,
    nodes,
    viewportBounds: resolveViewportBounds(nodes),
  };
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
      packageName: attributes.package || "",
      clickable: attributes.clickable === "true",
      enabled: attributes.enabled !== "false",
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

function matchesUiFragment(node, fragment) {
  const normalizedFragment = normalizeUiLabel(fragment);
  const normalizedText = normalizeUiLabel(node.text);
  const normalizedContentDesc = normalizeUiLabel(node.contentDesc);

  return normalizedText.includes(normalizedFragment)
    || normalizedContentDesc.includes(normalizedFragment);
}

function findAnyNodeInSnapshot(snapshot, labels, options = {}, picker = pickBestNode) {
  for (const label of labels) {
    const matches = findMatchingNodes(snapshot, label, options);
    if (matches.length > 0) {
      return { label, node: picker(matches) };
    }
  }

  return null;
}

function findNodeInSnapshot(snapshot, label, options = {}) {
  const matches = findMatchingNodes(snapshot, label, options);
  if (matches.length === 0) {
    return null;
  }

  return pickBestNode(matches);
}

function isAppForegroundSnapshot(snapshot) {
  if (!appPackageName) {
    return false;
  }

  if (snapshot.nodes.some((node) => node.packageName === appPackageName)) {
    return true;
  }

  const hasAppTitle = findAnyNodeInSnapshot(snapshot, APP_TITLE_LABELS, {
    visibleOnly: true,
  });
  const hasAppForegroundMarker = findAnyNodeInSnapshot(snapshot, APP_FOREGROUND_MARKER_LABELS, {
    visibleOnly: true,
  });

  return Boolean(hasAppTitle && hasAppForegroundMarker);
}

function findNodesForLabelsInSnapshot(snapshot, labels, options = {}) {
  const results = [];

  for (const label of labels) {
    results.push(...findMatchingNodes(snapshot, label, options));
  }

  return dedupeNodes(results);
}

function findMatchingNodes(snapshot, label, options = {}) {
  const viewportBounds = options.visibleOnly ? snapshot.viewportBounds : null;

  return snapshot.nodes.filter((node) => {
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
}

function dedupeNodes(nodes) {
  const seen = new Set();
  const results = [];

  for (const node of nodes) {
    const bounds = node.bounds
      ? `${node.bounds.left}:${node.bounds.top}:${node.bounds.right}:${node.bounds.bottom}`
      : "no-bounds";
    const key = `${normalizeUiLabel(node.text)}|${normalizeUiLabel(node.contentDesc)}|${bounds}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    results.push(node);
  }

  return results;
}

function pickClosestNodePair(sourceNodes, targetNodes) {
  let bestPair = null;

  for (const sourceNode of sourceNodes) {
    if (!sourceNode.bounds) {
      continue;
    }

    for (const targetNode of targetNodes) {
      if (!targetNode.bounds) {
        continue;
      }

      const verticalDistance = Math.abs(sourceNode.bounds.centerY - targetNode.bounds.centerY);
      const horizontalDistance = Math.abs(sourceNode.bounds.centerX - targetNode.bounds.centerX);
      const score = verticalDistance * 10 + horizontalDistance;

      if (!bestPair || score < bestPair.score) {
        bestPair = {
          sourceNode,
          targetNode,
          score,
        };
      }
    }
  }

  return bestPair;
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

function findAnyNodeClearOfBottomOverlay(snapshot, labels, options = {}) {
  for (const label of labels) {
    const nodes = findMatchingNodes(snapshot, label, { visibleOnly: true })
      .filter((node) => isBoundsClearOfBottomOverlay(node.bounds, snapshot.viewportBounds, options));

    const node = pickBestNode(nodes);
    if (node) {
      return { label, node };
    }
  }

  return null;
}

function isBoundsClearOfBottomOverlay(bounds, viewportBounds, options = {}) {
  if (!isBoundsInViewport(bounds, viewportBounds)) {
    return false;
  }

  const bottomInsetPx = resolveTapSafeBottomInsetPx(viewportBounds, options);
  return bounds.centerY <= viewportBounds.bottom - bottomInsetPx;
}

function resolveTapSafeBottomInsetPx(viewportBounds, options = {}) {
  if (Number.isFinite(options.bottomSafeInsetPx) && options.bottomSafeInsetPx >= 0) {
    return options.bottomSafeInsetPx;
  }

  const ratio = Number.isFinite(options.bottomSafeInsetRatio)
    ? options.bottomSafeInsetRatio
    : DEFAULT_TAP_SAFE_BOTTOM_INSET_RATIO;
  const minPx = Number.isFinite(options.minBottomSafeInsetPx)
    ? options.minBottomSafeInsetPx
    : DEFAULT_TAP_SAFE_BOTTOM_INSET_MIN_PX;

  return Math.max(minPx, Math.round(viewportBounds.height * ratio));
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
  const { nodes } = createUiSnapshot(adbPath, serial);
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
    const { nodes, viewportBounds } = createUiSnapshot(adbPath, serial);
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
  const summary = results.reduce((accumulator, result) => {
    accumulator[result.status] = (accumulator[result.status] || 0) + 1;
    return accumulator;
  }, {});
  const serializedResults = serializeReportResults(results);
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        pack: cliOptions.scenario ? null : cliOptions.pack,
        selectedScenario: cliOptions.scenario,
        scenarioCount: results.length,
        summary,
        results: serializedResults,
      },
      null,
      2
    )
  );
  log(`Wrote scenario report to ${reportPath}`);
}

function serializeReportResults(results, roots = {}) {
  const resolvedArtifactsRoot = path.resolve(roots.artifactsRoot || artifactsRoot);
  const resolvedProjectRoot = path.resolve(roots.projectRoot || projectRoot);

  return results.map((result) => {
    const serializedResult = { ...result };

    for (const field of REPORT_ARTIFACT_PATH_FIELDS) {
      if (typeof serializedResult[field] === "string") {
        serializedResult[field] = toReportRelativePath(serializedResult[field], {
          artifactsRoot: resolvedArtifactsRoot,
          projectRoot: resolvedProjectRoot,
        });
      }
    }

    return serializedResult;
  });
}

function toReportRelativePath(filePath, roots) {
  if (!path.isAbsolute(filePath)) {
    return normalizeReportPath(filePath);
  }

  const resolvedPath = path.resolve(filePath);
  const baseRoot = isPathInsideOrEqual(resolvedPath, roots.artifactsRoot)
    ? roots.artifactsRoot
    : roots.projectRoot;
  const relativePath = path.relative(baseRoot, resolvedPath);

  if (!relativePath || path.isAbsolute(relativePath) || /^[A-Za-z]:[\\/]/.test(relativePath)) {
    return path.basename(resolvedPath);
  }

  return normalizeReportPath(relativePath);
}

function isPathInsideOrEqual(targetPath, rootPath) {
  const relativePath = path.relative(rootPath, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function normalizeReportPath(reportPath) {
  return reportPath.replace(/\\/g, "/");
}

function printScenarioList(scenarios) {
  console.log(`Available Android scenario packs: ${[...SCENARIO_PACKS].join(", ")}`);
  console.log("");
  console.log("Available Android scenarios:");
  for (const scenario of scenarios) {
    console.log(`- ${scenario.id} [${scenario.tier}]: ${scenario.description}`);
  }
}

function parseCliOptions(argv) {
  const options = {
    emulator: false,
    skipBuild: false,
    failOnSkip: false,
    preserveRunningApp: false,
    bootstrapScreenshot: false,
    list: false,
    pack: DEFAULT_SCENARIO_PACK,
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

    if (arg === "--fail-on-skip") {
      options.failOnSkip = true;
      continue;
    }

    if (arg === "--preserve-running-app") {
      options.preserveRunningApp = true;
      continue;
    }

    if (arg === "--bootstrap-screenshot") {
      options.bootstrapScreenshot = true;
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

    if (arg === "--pack") {
      const pack = readCliValue(argv, ++index, "--pack");
      if (!SCENARIO_PACKS.has(pack)) {
        throw new Error(
          `Unknown scenario pack "${pack}". Expected one of: ${[...SCENARIO_PACKS].join(", ")}.`
        );
      }
      options.pack = pack;
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
  console.log("  --emulator                 Run scenarios on an Android emulator instead of a connected phone");
  console.log("  --avd <name>               Use a specific AVD when starting an emulator");
  console.log("  --serial <serial>          Target a specific connected device");
  console.log(`  --pack <${[...SCENARIO_PACKS].join("|")}> Run a scenario pack (default: ${DEFAULT_SCENARIO_PACK})`);
  console.log("  --scenario <id>            Run only one scenario");
  console.log("  --skip-build               Reuse the existing debug APK");
  console.log("  --fail-on-skip             Treat skipped scenarios as verification failures");
  console.log("  --preserve-running-app     Do not bootstrap or restart the app before scenarios");
  console.log("  --bootstrap-screenshot     Save a smoke bootstrap screenshot before scenarios");
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

function captureAndroidScreenshot(adbPath, serial, screenshotPath, options = {}) {
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });

  const failures = [];
  const maxAttempts = options.maxAttempts ?? SCREENSHOT_CAPTURE_MAX_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? SCREENSHOT_CAPTURE_RETRY_DELAY_MS;
  const runSpawnSync = options.spawnSync ?? spawnSync;
  const runSleepSync = options.sleepSync ?? sleepSync;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let sawAdbDeviceUnavailable = false;

    try {
      fs.rmSync(screenshotPath, { force: true });

      const directCapture = runSpawnSync(
        adbPath,
        ["-s", serial, "exec-out", "screencap", "-p"],
        { maxBuffer: 20 * 1024 * 1024 }
      );

      if (directCapture.error) {
        throw directCapture.error;
      }

      if (directCapture.status === 0 && isPngBuffer(directCapture.stdout)) {
        fs.writeFileSync(screenshotPath, directCapture.stdout);
        return screenshotPath;
      }

      failures.push(describeSpawnResult("exec-out screencap", directCapture));
      sawAdbDeviceUnavailable = isAdbDeviceUnavailableResult(directCapture);
      log("Direct screencap failed; retrying screenshot capture via a temporary device file.");

      const remotePath = `/data/local/tmp/pocket-ai-qa-${process.pid}-${Date.now()}-${attempt}.png`;
      const remoteCapture = runSpawnSync(
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
          const failure = describeSpawnResult("remote screencap", remoteCapture);
          failures.push(failure);
          sawAdbDeviceUnavailable = sawAdbDeviceUnavailable || isAdbDeviceUnavailableResult(remoteCapture);
          throw new Error(failure);
        }

        const pullResult = runSpawnSync(
          adbPath,
          ["-s", serial, "pull", remotePath, screenshotPath],
          {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          }
        );

        if (pullResult.error) {
          throw pullResult.error;
        }

        if (pullResult.status !== 0) {
          const failure = describeSpawnResult("adb pull screenshot", pullResult);
          failures.push(failure);
          sawAdbDeviceUnavailable = sawAdbDeviceUnavailable || isAdbDeviceUnavailableResult(pullResult);
          throw new Error(failure);
        }

        const screenshotBuffer = fs.readFileSync(screenshotPath);
        if (isPngBuffer(screenshotBuffer)) {
          return screenshotPath;
        }

        failures.push(`pulled screenshot was not a PNG (${screenshotBuffer.length} bytes)`);
      } finally {
        runSpawnSync(
          adbPath,
          ["-s", serial, "shell", "rm", "-f", remotePath],
          { stdio: "ignore" }
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(message);
      sawAdbDeviceUnavailable = sawAdbDeviceUnavailable || isAdbDeviceUnavailableMessage(message);
    }

    if (attempt < maxAttempts) {
      if (sawAdbDeviceUnavailable) {
        const waitResult = waitForAdbDevice(adbPath, serial, runSpawnSync);
        failures.push(describeSpawnResult("adb wait-for-device", waitResult));
      }
      log(`Screenshot capture attempt ${attempt} failed; retrying.`);
      runSleepSync(retryDelayMs);
    }
  }

  throw new Error(
    `Failed to capture an Android screenshot after ${maxAttempts} attempts. `
    + failures.slice(-6).join(" | ")
  );
}

function describeSpawnResult(label, result) {
  const stdoutLength = Buffer.isBuffer(result.stdout)
    ? result.stdout.length
    : String(result.stdout || "").length;
  const stderr = String(result.stderr || "").trim();
  return `${label} status=${result.status} stdout=${stdoutLength} stderr=${stderr || "<empty>"}`;
}

function describeSpawnError(label, error) {
  const code = typeof error?.code === "string" && error.code.length > 0 ? error.code : "unknown";
  const message = typeof error?.message === "string" && error.message.length > 0 ? error.message : String(error);
  return `${label} error=${code} message=${message}`;
}

function isRetryableSpawnError(error) {
  return error?.code === "ETIMEDOUT";
}

function isAdbDeviceUnavailableResult(result) {
  return isAdbDeviceUnavailableMessage(String(result.stderr || ""))
    || isAdbDeviceUnavailableMessage(String(result.stdout || ""));
}

function isAdbDeviceUnavailableMessage(message) {
  return /device ['"].+['"] not found/i.test(message)
    || /device offline/i.test(message)
    || /no devices?\/emulators? found/i.test(message);
}

function waitForAdbDevice(adbPath, serial, runSpawnSync = spawnSync) {
  return runSpawnSync(
    adbPath,
    ["-s", serial, "wait-for-device"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    }
  );
}

function isPngBuffer(value) {
  return Buffer.isBuffer(value)
    && value.length >= PNG_SIGNATURE.length
    && value.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

function isEmulatorSerial(serial) {
  return serial.startsWith("emulator-");
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || projectRoot,
    stdio: options.stdio || "inherit",
    env: options.env || process.env,
    timeout: options.timeout,
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

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

module.exports = {
  buildScenarios,
  buildScenarioLaunchPlan,
  buildSmokeLaunchArgs,
  captureAndroidScreenshot,
  clearFocusedTextInput,
  CLEAR_TEXT_INPUT_FALLBACK_TOTAL_TIMEOUT_MS,
  DEFAULT_CLEAR_TEXT_INPUT_MAX_DELETE_COUNT,
  dumpUiHierarchy,
  findCatalogRiskModelCard,
  findQuantizationSelectorNodeClearOfBottomOverlay,
  openFirstVisibleVariantPicker,
  prepareCatalogForVariantPickerSmokeScenario,
  findAnyNodeInSnapshot,
  findAnyNodeClearOfBottomOverlay,
  findPreparedSentMessageContext,
  findNodeInSnapshot,
  isBoundsClearOfBottomOverlay,
  isAppForegroundSnapshot,
  findBlockingSystemDialogAction,
  escapeAdbInputText,
  pickClosestNodePair,
  selectScenarios,
  parseCliOptions,
  parseUiSnapshot,
  restoreLanguageAfterScenario,
  runChecked,
  ScenarioSkipError,
  ScenarioSkipFailureError,
  serializeReportResults,
  shouldAppendRunnerFailure,
  assertAttachmentActionBlocked,
  assertAttachmentActionAvailable,
  assertAttachmentPreviewRemovePreconditions,
  assertAttachmentTextOnlyFallbackState,
};
