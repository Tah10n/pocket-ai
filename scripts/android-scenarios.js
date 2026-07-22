#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  buildGradleAssembleArgs,
  captureOwnedProcessOwnership,
  ensureMetroServer,
  spawnOwnedProcess,
  stopOwnedMetroProcessOrThrow,
  stopOwnedProcessTreeByPid,
} = require("./android-smoke");
const {
  ANDROID_UNIVERSAL_ABIS,
  BUILD_PROVENANCE_SCHEMA_VERSION,
  collectAndroidEffectiveBuildContext,
  collectBuildProvenance,
  collectGitProvenance,
  collectPrebuildInputState,
  createIsolatedAndroidBuildEnvironment,
  hashCanonicalJson,
} = require("./android-build-provenance");
const {
  describeAndroidQaError,
  sanitizeAndroidQaText,
} = require("./android-qa-sanitization");
const { isCompletePngBuffer } = require("./png-validation");
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
const STORAGE_SCENARIOS = [
  "storage-cache-clear",
];
const ATTACHMENT_SCENARIOS = [
  "chat-attachment-current-state-smoke",
];
const PRECONDITIONED_ATTACHMENT_SCENARIOS = [
  "chat-attachment-text-only-fallback",
];
const PREPARED_ATTACHMENT_SCENARIOS = [
  "chat-attachment-preview-remove",
];
const PREPARED_ATTACHMENT_SEND_SCENARIOS = [
  "chat-attachment-prepared-send",
];
const BRANCH_REGENERATION_SCENARIOS = [
  "branch-regeneration-01-fixture",
  "branch-regeneration-02-trailing-model-switch",
  "branch-regeneration-03-force-stop-before-token",
  "branch-regeneration-04-relaunch-old-branch",
  "branch-regeneration-05-force-stop-after-partial",
  "branch-regeneration-06-relaunch-partial-branch",
  "branch-regeneration-07-success",
  "branch-regeneration-08-stop-before-output",
  "branch-regeneration-09-stop-after-partial",
  "branch-regeneration-10-reasoning-clear",
  "branch-regeneration-11-image-attachment",
  "branch-regeneration-12-document-attachment",
  "branch-regeneration-13-audio-attachment",
  "branch-regeneration-14-delete-conversation",
  "branch-regeneration-15-clear-history-relaunch",
];
const SCENARIO_PACK_SCENARIOS = {
  core: CORE_SCENARIOS,
  catalog: CATALOG_SCENARIOS,
  storage: STORAGE_SCENARIOS,
  attachments: ATTACHMENT_SCENARIOS,
  "attachments-preconditioned": PRECONDITIONED_ATTACHMENT_SCENARIOS,
  "attachments-prepared": PREPARED_ATTACHMENT_SCENARIOS,
  "attachments-prepared-send": PREPARED_ATTACHMENT_SEND_SCENARIOS,
  "branch-regeneration": BRANCH_REGENERATION_SCENARIOS,
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
const SUPPORTED_ANDROID_PROVENANCE_ABIS = new Set([
  "universal",
  ...ANDROID_UNIVERSAL_ABIS,
]);

const cliOptions = require.main === module
  ? parseCliOptions(process.argv.slice(2))
  : parseCliOptions([]);
const projectRoot = path.resolve(__dirname, "..");
const appConfigPath = path.join(projectRoot, "app.json");
const artifactsRoot = path.join(projectRoot, "artifacts", "android-scenarios");
const androidRoot = path.join(projectRoot, "android");
const dumpPathOnDevice = "/sdcard/window_dump.xml";
const expoConfig = readExpoConfig();
const appPackageName = expoConfig.packageName;
const appSchemeName = expoConfig.scheme;
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
const ATTACH_MENU_LABELS = [
  "Attach file",
  "Прикрепить файл",
];
const ATTACH_MENU_BUTTON_RESOURCE_ID = "chat-attach-menu-button";
const ATTACH_IMAGE_BUTTON_RESOURCE_ID = "chat-attach-image-button";
const MODELS_FILTER_TOGGLE_RESOURCE_ID = "models-filter-toggle";
const MODELS_FILTER_PANEL_RESOURCE_ID = "models-filter-panel";
const MODELS_FILTER_CLEAR_RESOURCE_ID = "models-filter-clear";
const MODELS_FILTER_SIZE_LARGE_RESOURCE_ID = "filter-option-size-large";
const MODELS_FILTER_NO_TOKEN_REQUIRED_RESOURCE_ID = "filter-option-no-token-required";
const MODEL_WARMUP_BANNER_RESOURCE_ID = "model-warmup-banner-container";
const MODEL_WARMUP_LABEL_FRAGMENTS = [
  "Initializing",
  "Инициализация",
  "Warming up model",
  "Загрузка модели",
];
const CHAT_LIST_VIEWPORT_RESOURCE_ID = "chat-list-viewport";
const ATTACH_IMAGE_ACTION_SETTLE_TIMEOUT_MS = 8_000;
const ATTACHMENT_ACTION_BUSY_LABEL_FRAGMENTS = [
  "busy",
  "занят",
  "занято",
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
const PREPARED_ATTACHMENT_SEND_PROMPT_PREFIX =
  "Read the exact text in the image and reply with the words you see ignore test id";
const TEXT_ONLY_FALLBACK_SEND_PROMPT_PREFIX = "Text fallback smoke";
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
const LOADED_TEXT_ATTACHMENT_FALLBACK_LABELS = [
  "This model supports text chat only.",
  "Download the vision projector before attaching images.",
  "Choose the matching vision projector before attaching images.",
  "Vision support could not start. Text chat is still available.",
  "Vision chat is not supported by this runtime.",
  "Эта модель поддерживает только текстовый чат.",
  "Скачайте vision-проектор, прежде чем прикреплять изображения.",
  "Выберите подходящий vision-проектор, прежде чем прикреплять изображения.",
  "Не удалось запустить поддержку изображений. Текстовый чат по-прежнему доступен.",
  "Чат с изображениями не поддерживается этим runtime.",
];
const PREPARED_ASSISTANT_RESPONSE_ERROR_LABELS = [
  "Action failed",
  "Something went wrong",
  "Unknown chat generation error",
  "Engine not ready",
  "Model is not loaded",
  "Engine context changed during operation",
  "Completion was interrupted before generation started",
  "Private storage is unavailable.",
  "Load a local model before continuing.",
  "Finish or stop the current operation before starting another one.",
  "The current model is unloading. Wait a moment and try again.",
  "The selected model is no longer available on this device.",
  "The model could not be loaded. Try again or choose a different profile.",
  "This GGUF file cannot be loaded as a text model",
  "Not enough memory to load this model.",
  "This model may not fit in memory with the current settings.",
  "There is not enough free storage to finish this download.",
  "This model does not expose a reliable file size yet.",
  "This model metadata could not be resolved yet.",
  "The download failed because the remote server returned an error.",
  "The downloaded file could not be verified.",
  "The downloaded file could not be found on disk.",
  "Type a message before sending.",
  "This message is too long for the current context window.",
  "The image could not be copied into app storage.",
  "You can attach up to 4 images.",
  "One attached image is no longer available on device.",
  "Finish preparing or remove failed image attachments before sending.",
  "Не удалось выполнить действие",
  "Неизвестная ошибка генерации чата",
  "Модель не готова",
  "Модель не загружена",
  "Приватное хранилище недоступно.",
  "Загрузите локальную модель, прежде чем продолжить.",
  "Завершите или остановите текущую операцию, прежде чем запускать новую.",
  "Текущая модель выгружается. Подождите немного и повторите попытку.",
  "Выбранная модель больше недоступна на этом устройстве.",
  "Не удалось загрузить модель. Повторите попытку или выберите другой профиль.",
  "Этот GGUF-файл нельзя загрузить как текстовую модель",
  "Недостаточно памяти для загрузки этой модели.",
  "Эта модель может не поместиться в память с текущими настройками.",
  "Недостаточно свободного места, чтобы завершить загрузку.",
  "Для этой модели пока не удалось получить надежный размер файла.",
  "Не удалось получить метаданные модели.",
  "Загрузка не удалась из-за ошибки удаленного сервера.",
  "Не удалось проверить скачанный файл.",
  "Скачанный файл не найден на диске.",
  "Введите сообщение перед отправкой.",
  "Сообщение слишком длинное для текущего окна контекста.",
  "Не удалось скопировать изображение в хранилище приложения.",
  "Можно прикрепить не больше 4 изображений.",
  "Одно из прикрепленных изображений больше недоступно на устройстве.",
  "Дождитесь подготовки изображений или удалите неудачные вложения перед отправкой.",
];
const PREPARED_ASSISTANT_RESPONSE_NON_ANSWER_LABEL_FRAGMENTS = [
  ...CHAT_INPUT_LABELS,
  ...CHAT_SEND_LABELS,
  ...ATTACH_IMAGE_LABELS,
  ...ATTACHMENT_PREVIEW_LABELS,
  ...MESSAGE_ATTACHMENT_PREVIEW_LABELS,
  ...REMOVE_ATTACHMENT_LABELS,
  ...IMAGE_ATTACHMENT_TEXT_ONLY_FALLBACK_LABELS,
  ...LOADED_TEXT_ATTACHMENT_FALLBACK_LABELS,
  ...PREPARED_ASSISTANT_RESPONSE_ERROR_LABELS,
  "Ask local AI",
  "Спросите локальный ИИ",
  "Copy message",
  "Regenerate response",
  "Delete message",
  "Stop generating",
  "Thinking",
  "Thinking...",
  "Generating response",
  "Response failed",
  "Something went wrong",
  "Vision chat is not ready",
  "Vision support could not start",
  "Копировать сообщение",
  "Повторить ответ",
  "Удалить сообщение",
  "Остановить генерацию",
  "Думаю",
  "Генерация ответа",
  "Не удалось получить ответ",
  "Что-то пошло не так",
  "Чат с изображениями не готов",
].map(normalizeUiLabel).filter(Boolean);
const ASSISTANT_MESSAGE_CONTENT_RESOURCE_ID_FRAGMENT = "assistant-message-content-";
const ASSISTANT_MESSAGE_COMPLETE_RESOURCE_ID_FRAGMENT = "assistant-message-state-complete-";
const NO_MODEL_STATE_LABELS = [
  "NO MODEL LOADED",
  "МОДЕЛЬ НЕ ЗАГРУЖЕНА",
  "Load a model to continue chatting",
  "Загрузите модель, чтобы продолжить чат",
  "Choose a local model",
  "Выберите локальную модель",
  "Load Model",
  "Загрузить модель",
  "Download Model",
  "Скачать модель",
  "Browse Models",
  "Открыть каталог",
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
const CLEAR_ACTIVE_CACHE_LABELS = ["Clear Active Cache", "Очистить активный кэш"];
const STORAGE_CLEAR_CACHE_RESOURCE_ID = "storage-manager-clear-cache";
const STORAGE_CLEAR_CHAT_RESOURCE_ID = "storage-manager-clear-chat";
const ANDROID_DIALOG_POSITIVE_BUTTON_RESOURCE_ID = "android:id/button1";
const STORAGE_CACHE_QA_DIRECTORY = "cache/pocket-ai-storage-qa";
const STORAGE_CACHE_QA_SENTINEL = `${STORAGE_CACHE_QA_DIRECTORY}/sentinel.bin`;
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
const DELETE_LABELS = ["Delete", "Удалить"];
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
const MODEL_DETAILS_BACK_LABELS = ["Go back", "Вернуться назад"];
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
const CHAT_ROUTE_TIMEOUT_MS = 120_000;
const SETTINGS_ROUTE_TIMEOUT_MS = 60_000;
const CLEAR_TEXT_INPUT_PRIMARY_TIMEOUT_MS = 2_000;
const CLEAR_TEXT_INPUT_FALLBACK_TIMEOUT_MS = 2_000;
const CLEAR_TEXT_INPUT_FALLBACK_TOTAL_TIMEOUT_MS = 5_000;
const DEFAULT_CLEAR_TEXT_INPUT_MAX_DELETE_COUNT = 128;
const ADB_INPUT_TEXT_TIMEOUT_MS = 5_000;
const ADB_INPUT_TEXT_MAX_ATTEMPTS = 3;
const ADB_INPUT_TEXT_CONFIRM_TIMEOUT_MS = 5_000;
const ENABLED_ACTION_SETTLE_TIMEOUT_MS = 10_000;
const TRANSIENT_SURFACE_BACK_MAX_ATTEMPTS = 3;
const TRANSIENT_SURFACE_BACK_QUIET_DELAY_MS = 5_000;
const TRANSIENT_SURFACE_BACK_TIMEOUT_MS = 0;
// Catalog tree metadata calls can occupy the device for up to 20 seconds. Waiting beyond that
// boundary avoids queuing duplicate taps that later toggle the requested filter state back again.
const CATALOG_FILTER_PANEL_SETTLE_TIMEOUT_MS = 30_000;
const CATALOG_FILTER_ACTION_QUIET_DELAY_MS = 5_000;
const CATALOG_FILTER_POLL_INTERVAL_MS = 2_000;
// A live HF enrichment pass can keep React/Accessibility from applying a filter mutation while
// uiautomator is polling. Keep this path completely quiet, then take one authoritative snapshot.
const CATALOG_FILTER_MUTATION_QUIET_DELAY_MS = 75_000;
const CATALOG_FILTER_MUTATION_SETTLE_TIMEOUT_MS = 0;
const ROUTE_ACTION_QUIET_DELAY_MS = 5_000;
const ROUTE_POLL_INTERVAL_MS = 2_000;
const BOTTOM_TAB_ACTION_QUIET_DELAY_MS = 5_000;
const MODEL_CATALOG_EXIT_QUIET_DELAY_MS = 75_000;
const MODEL_DETAILS_ROUTE_TIMEOUT_MS = 25_000;
const DOWNLOAD_WARNING_QUIET_DELAY_MS = 75_000;
const DOWNLOAD_WARNING_SETTLE_TIMEOUT_MS = 0;
const MODEL_WARMUP_DETECTION_TIMEOUT_MS = 2_000;
const MODEL_WARMUP_SETTLE_TIMEOUT_MS = 180_000;
const UI_HIERARCHY_DUMP_COMMAND_TIMEOUT_MS = 5_000;
const ADB_COMMAND_TIMEOUT_MS = 15_000;
const LOGCAT_EVIDENCE_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const LOGCAT_COLLECTOR_START_TIMEOUT_MS = 10_000;
const LOGCAT_COLLECTOR_STOP_TIMEOUT_MS = 10_000;
const LOGCAT_COLLECTOR_FORCE_STOP_TIMEOUT_MS = 5_000;
const SCREENSHOT_CAPTURE_MAX_ATTEMPTS = 4;
const SCREENSHOT_CAPTURE_RETRY_DELAY_MS = 350;
// Accessibility nodes can become visible before SurfaceFlinger has committed the final frame.
// Give successful routes a short visual-settle window so QA evidence does not capture a
// transient black surface immediately after navigation.
const PASSED_SCENARIO_SCREENSHOT_SETTLE_MS = 1_000;
const REPORT_ARTIFACT_PATH_FIELDS = [
  "screenshotPath",
  "uiDumpPath",
  "logcatPath",
  "provenancePath",
];
const REPORT_PRIVATE_FIELDS = new Set([
  "rawLogPath",
  "rawLogPaths",
  "systemRawLogPath",
  "privateLogcatPath",
  "logcatCollector",
]);
const REPORT_MAX_DEPTH = 8;
const REPORT_MAX_COLLECTION_ENTRIES = 100;
const REPORT_MAX_STRING_LENGTH = 2_048;
const QA_PROVENANCE_PATH = path.join(artifactsRoot, "build-provenance-latest.json");
const BRANCH_EVIDENCE_DIRECTORY = "branch-regeneration";
const PRIVATE_LOGCAT_DIRECTORY = path.join(
  projectRoot,
  "node_modules",
  ".cache",
  "pocket-ai-android",
  "scenario-logcat"
);
const BRANCH_GENERATION_TIMEOUT_MS = 240_000;
const BRANCH_PARTIAL_TIMEOUT_MS = 120_000;
const BRANCH_FIXTURE_SCAN_LIMIT = 24;
const FATAL_LOG_PATTERNS = [
  /FATAL EXCEPTION/i,
  /Fatal signal\s+\d+|SIGABRT|SIGBUS|SIGFPE|SIGILL|SIGSEGV/i,
  /ANR in com\.github\.tah10n\.pocketai/i,
  /Unhandled JS Exception/i,
  /Unable to load script/i,
  /JSApplicationIllegalArgumentException/i,
  /ReactNativeJS.*(?:Invariant Violation|ReferenceError|TypeError)/i,
];
let activeQaProvenance = null;

if (require.main === module) {
  main().catch((error) => {
    console.error(`[android-scenarios] ${describeAndroidQaError(error, "scenario-run-failed")}`);
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
  const requiresCurrentHeadProvenance = selectedScenarios.some(
    (scenario) => scenario.requiresCurrentHeadProvenance
  );

  if (selectedScenarios.length === 0) {
    throw new Error(
      cliOptions.scenario
        ? `Unknown scenario "${cliOptions.scenario}". Run with --list to see available scenarios.`
        : "No scenarios were selected."
    );
  }

  fs.mkdirSync(artifactsRoot, { recursive: true });
  try {
    configureScenarioBuildEnvironment(cliOptions, requiresCurrentHeadProvenance);
  } catch (error) {
    const results = [{
      id: "current-head-provenance",
      status: "failed",
      failureKind: "precondition",
      durationMs: 0,
      error: error instanceof Error ? error.message : String(error),
    }];
    writeReport(results);
    throw markScenarioFailureRecorded(error);
  }

  const adbPath = resolveAdbPath();
  const launchPlan = buildScenarioLaunchPlan(cliOptions, () => resolveTargetSerial(adbPath, cliOptions));
  let scenarioMetro = null;
  let activeLogcatCollector = null;
  let removeResourceSignalHandlers = () => {};
  let mainError = null;

  try {
    if (launchPlan.shouldLaunch) {
      if (shouldPrepareMetroForScenarioLaunch()) {
        scenarioMetro = await ensureMetroServer({
          foreground: false,
          preferredPort: cliOptions.port ?? undefined,
        });
        if (scenarioMetro.started) {
          removeResourceSignalHandlers = installScenarioResourceSignalHandlers(
            () => ({
              metro: scenarioMetro,
              logcatCollector: activeLogcatCollector,
            })
          );
          scenarioMetro.removeSignalHandlers?.();
        }
      }
      launchApp(launchPlan.serialBeforeLaunch, scenarioMetro?.port ?? cliOptions.port);
    }

    if (!scenarioMetro?.started) {
      removeResourceSignalHandlers = installScenarioResourceSignalHandlers(
        () => ({
          metro: scenarioMetro,
          logcatCollector: activeLogcatCollector,
        })
      );
    }

    const serial = launchPlan.serialBeforeLaunch || resolveTargetSerial(adbPath, cliOptions);
    const context = createScenarioContext(adbPath, serial);
    const results = [];

    try {
      await context.ensureAppVisible();
      await dismissDebuggerBannerIfPresent(adbPath, serial);

      try {
        if (requiresCurrentHeadProvenance && cliOptions.preserveRunningApp) {
          throw new ScenarioPreconditionFailureError(
            "Current-head scenarios cannot use --preserve-running-app because the live JS surface would not be relaunched from verified source."
          );
        }
        activeQaProvenance = requiresCurrentHeadProvenance
          ? readAndValidateQaProvenance(adbPath, serial)
          : null;
      } catch (error) {
        results.push({
          id: "current-head-provenance",
          status: "failed",
          failureKind: "precondition",
          durationMs: 0,
          error: error instanceof Error ? error.message : String(error),
        });
        writeReport(results);
        throw markScenarioFailureRecorded(error);
      }

      for (const scenario of selectedScenarios) {
        if (activeLogcatCollector) {
          cleanupAndroidLogcatCollector(activeLogcatCollector);
          activeLogcatCollector = null;
        }
        const startedAt = Date.now();
        log(`Running scenario: ${scenario.id} [${scenario.tier}]`);
        context.resetStepEvidence(scenario.id);
        let logcatCollector = null;

        try {
          if (scenario.captureFullEvidence) {
            logcatCollector = await startAndroidLogcatCollector(
              {
                adbPath,
                serial,
                packageName: appPackageName,
                stem: scenario.id,
              },
              {
                onCollectorCreated: (collector) => {
                  activeLogcatCollector = collector;
                },
              }
            );
            context.setStepLogcatCollector(logcatCollector);
          }

          const outcome = await scenario.run(context);

          if (outcome && outcome.status === "skipped") {
            await stopAndroidLogcatCollector(logcatCollector);
            recordScenarioSkip({
              scenario,
              results,
              startedAt,
              reason: outcome.reason,
              context,
            });
            writeReport(results);
            continue;
          }

          if (outcome && outcome.status === "not_applicable") {
            const screenshotPath = await captureSettledScenarioScreenshot(
              context,
              path.join(BRANCH_EVIDENCE_DIRECTORY, `${scenario.id}.png`)
            );
            await stopAndroidLogcatCollector(logcatCollector);
            const evidence = captureScenarioEvidence({
              adbPath,
              serial,
              scenario,
              screenshotPath,
              checkpoints: context.consumeStepCheckpoints(),
              logcatCollector,
            });
            results.push({
              id: scenario.id,
              tier: scenario.tier,
              step: scenario.step,
              status: "not_applicable",
              durationMs: Date.now() - startedAt,
              ...evidence,
              reason: outcome.reason,
              ...(outcome.details ? { details: outcome.details } : {}),
            });
            log(`NOT APPLICABLE ${scenario.id}: ${outcome.reason}`);
            writeReport(results);
            continue;
          }

          const screenshotPath = await captureSettledScenarioScreenshot(
            context,
            scenario.captureFullEvidence
              ? path.join(BRANCH_EVIDENCE_DIRECTORY, `${scenario.id}.png`)
              : `${scenario.id}.png`
          );
          await stopAndroidLogcatCollector(logcatCollector);
          const evidence = scenario.captureFullEvidence
            ? captureScenarioEvidence({
                adbPath,
                serial,
                scenario,
                screenshotPath,
                checkpoints: context.consumeStepCheckpoints(),
                logcatCollector,
              })
            : { screenshotPath };
          results.push({
            id: scenario.id,
            tier: scenario.tier,
            step: scenario.step,
            status: "passed",
            durationMs: Date.now() - startedAt,
            ...evidence,
            ...(outcome?.details ? { details: outcome.details } : {}),
          });
          log(`PASS ${scenario.id}`);
          writeReport(results);
        } catch (caughtError) {
          let error = caughtError;
          if (logcatCollector && !logcatCollector.stopAttempted) {
            try {
              await stopAndroidLogcatCollector(logcatCollector);
            } catch (collectorError) {
              error = combineScenarioErrors(error, collectorError);
            }
          }

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
            writeReport(results);
            continue;
          }

          const evidence = captureFailedScenarioEvidence({
            adbPath,
            serial,
            scenario,
            context,
            logcatCollector,
          });
          results.push({
            id: scenario.id,
            tier: scenario.tier,
            step: scenario.step,
            status: "failed",
            durationMs: Date.now() - startedAt,
            ...evidence,
            error: error instanceof Error ? error.message : String(error),
            ...(error instanceof ScenarioPreconditionFailureError
              ? { failureKind: "precondition" }
              : {}),
          });
          writeReport(results);
          throw markScenarioFailureRecorded(error);
        } finally {
          context.setStepLogcatCollector(null);
          if (logcatCollector) {
            let cleanupSucceeded = false;
            try {
              cleanupAndroidLogcatCollector(logcatCollector);
              cleanupSucceeded = true;
            } catch (cleanupError) {
              log(
                `Could not remove private logcat capture for ${scenario.id}: ${describeAndroidQaError(cleanupError, "logcat-cleanup-failed")}`
              );
            } finally {
              if (cleanupSucceeded && activeLogcatCollector === logcatCollector) {
                activeLogcatCollector = null;
              }
            }
          }
        }
      }

      if (requiresCurrentHeadProvenance) {
        try {
          activeQaProvenance = readAndValidateQaProvenance(adbPath, serial);
        } catch (error) {
          results.push({
            id: "current-head-provenance-final",
            status: "failed",
            failureKind: "precondition",
            durationMs: 0,
            error: error instanceof Error ? error.message : String(error),
          });
          writeReport(results);
          throw markScenarioFailureRecorded(error);
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
        const packageUid = resolveAndroidPackageUid(adbPath, serial, appPackageName);
        const logcat = runCapture(adbPath, [
          "-s",
          serial,
          "logcat",
          "-b",
          "all",
          `--uid=${packageUid}`,
          "-d",
          "-t",
          "400",
          "-v",
          "threadtime",
        ], {
          allowFailure: true,
        });
        fs.writeFileSync(logcatPath, sanitizeQaLogcat(logcat));

        results.push({
          id: "runner-failure",
          status: "failed",
          durationMs: 0,
          screenshotPath,
          uiDumpPath,
          logcatPath,
          error: error instanceof Error ? error.message : String(error),
        });
        writeReport(results);
      } catch (captureError) {
        results.push({
          id: "runner-failure",
          status: "failed",
          durationMs: 0,
          error: error instanceof Error ? error.message : String(error),
          captureError: captureError instanceof Error ? captureError.message : String(captureError),
        });
        writeReport(results);
      }

      throw error;
    }
  } catch (error) {
    mainError = error;
    throw error;
  } finally {
    let logcatCleanupError = null;
    if (activeLogcatCollector) {
      try {
        cleanupAndroidLogcatCollector(activeLogcatCollector);
        activeLogcatCollector = null;
      } catch (cleanupError) {
        logcatCleanupError = cleanupError;
      }
    }
    let metroCleanupError = null;
    try {
      cleanupScenarioOwnedMetro(scenarioMetro);
      scenarioMetro = null;
    } catch (cleanupError) {
      metroCleanupError = cleanupError;
    }
    const cleanupErrors = [logcatCleanupError, metroCleanupError].filter(Boolean);
    if (cleanupErrors.length === 0) {
      removeResourceSignalHandlers();
    }
    if (cleanupErrors.length > 0) {
      if (!mainError && cleanupErrors.length === 1) {
        throw cleanupErrors[0];
      }
      throw new AggregateError(
        [mainError, ...cleanupErrors].filter(Boolean),
        mainError
          ? `Android scenario run failed (${mainError.message}) and owned-resource cleanup also failed.`
          : "Android scenario owned-resource cleanup failed."
      );
    }
  }
}

function captureFailedScenarioEvidence({
  adbPath,
  serial,
  scenario,
  context,
  logcatCollector = null,
}) {
  try {
    if (!scenario.captureFullEvidence) {
      return { screenshotPath: context.captureScreenshot(`${scenario.id}-failed.png`) };
    }

    return captureScenarioEvidence({
      adbPath,
      serial,
      scenario,
      screenshotPath: context.captureScreenshot(
        path.join(BRANCH_EVIDENCE_DIRECTORY, `${scenario.id}-failed.png`)
      ),
      checkpoints: context.consumeStepCheckpoints(),
      allowFatalMatches: true,
      logcatCollector,
    });
  } catch (captureError) {
    return {
      evidenceCaptureError: captureError instanceof Error
        ? captureError.message
        : String(captureError),
    };
  }
}

function createScenarioContext(adbPath, serial) {
  let activeStepId = "scenario";
  let stepCheckpoints = [];
  let stepLogcatCollector = null;

  return {
    serial,
    resetStepEvidence: (stepId = "scenario") => {
      activeStepId = sanitizeArtifactStem(stepId);
      stepCheckpoints = [];
      stepLogcatCollector = null;
    },
    setStepLogcatCollector: (collector) => {
      stepLogcatCollector = collector;
    },
    captureCheckpoint: (label, options = {}) => {
      const checkpoint = captureCheckpointEvidence({
        adbPath,
        serial,
        stem: `${activeStepId}-${sanitizeArtifactStem(label)}`,
        expectedJsSurface: options.expectedJsSurface || "foreground",
        logcatCollector: stepLogcatCollector,
      });
      stepCheckpoints.push(checkpoint);
      return checkpoint;
    },
    consumeStepCheckpoints: () => [...stepCheckpoints],
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
    expectResourceId: async (resourceId, options = {}) => {
      await waitForResourceId(adbPath, serial, resourceId, {
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

      const { match, snapshot } = await waitForSnapshotMatch(
        adbPath,
        serial,
        {
          timeoutMs: options.timeoutMs,
          visibleOnly: true,
        },
        (candidateSnapshot) => findBottomTabNodeInSnapshot(candidateSnapshot, labels)
      );
      if (!match) {
        throw new Error(
          withUiSnapshotSummary(
            snapshot,
            `Timed out waiting for a bottom tab matching any of: ${labels.map((label) => `"${label}"`).join(", ")}.`
          )
        );
      }

      const { label, node } = match;

      if (!node.bounds) {
        throw new Error(`"${label}" was found but has no tap bounds.`);
      }

      const tapPoint = getBottomTabTapPoint(node);

      runChecked(adbPath, [
        "-s",
        serial,
        "shell",
        "input",
        "tap",
        `${tapPoint.centerX}`,
        `${tapPoint.centerY}`,
      ]);

      await delay(options.afterTapDelayMs ?? BOTTOM_TAB_ACTION_QUIET_DELAY_MS);
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

async function captureSettledScenarioScreenshot(context, fileName, options = {}) {
  const wait = options.delayFn ?? delay;
  const settleDelayMs = options.settleDelayMs ?? PASSED_SCENARIO_SCREENSHOT_SETTLE_MS;

  await wait(settleDelayMs);
  return context.captureScreenshot(fileName);
}

function readExpoConfig() {
  const raw = fs.readFileSync(appConfigPath, "utf8");
  const config = JSON.parse(raw);
  const expo = config.expo || {};

  return {
    packageName: expo.android && expo.android.package,
    scheme: expo.scheme,
  };
}

function buildAppRouteDeepLinkArgs(serial, route, options = {}) {
  const packageName = options.packageName || appPackageName;
  const scheme = options.scheme || appSchemeName;
  const normalizedRoute = `${route || ""}`.replace(/^\/+/, "");

  if (!serial || !packageName || !scheme || !normalizedRoute) {
    throw new Error("Android route deep links require a serial, package, scheme, and route.");
  }

  return [
    "-s",
    serial,
    "shell",
    "am",
    "start",
    "-W",
    "-a",
    "android.intent.action.VIEW",
    "-d",
    `${scheme}://${normalizedRoute}`,
    packageName,
  ];
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
  const timestampSuffix = Date.now().toString(36).slice(-6);
  const randomSuffix = Math.floor(Math.random() * (36 ** 4)).toString(36).padStart(4, "0");
  return `${PREPARED_ATTACHMENT_SEND_PROMPT_PREFIX} qa${timestampSuffix}${randomSuffix}`;
}

function buildTextOnlyFallbackSendPrompt() {
  return `${TEXT_ONLY_FALLBACK_SEND_PROMPT_PREFIX} ${Date.now()} ${Math.floor(Math.random() * 1_000_000)}`;
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
    log(
      `Focused text select-all clear failed; falling back to repeated delete: ${describeAndroidQaError(error, "focused-text-clear-failed")}`
    );
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

async function inputFocusedTextAndConfirm(adbPath, serial, value, options = {}) {
  const normalizedValue = String(value).trim();
  const escapedValue = escapeAdbInputText(normalizedValue);
  const maxAttempts = options.maxAttempts ?? ADB_INPUT_TEXT_MAX_ATTEMPTS;
  const confirmTimeoutMs = options.confirmTimeoutMs ?? ADB_INPUT_TEXT_CONFIRM_TIMEOUT_MS;
  const focusSettleMs = options.focusSettleMs ?? 250;
  const retryDelayMs = options.retryDelayMs ?? 350;
  const runCommand = options.runCommand ?? runChecked;
  const clearInput = options.clearInput ?? clearFocusedTextInput;
  const createSnapshot = options.createSnapshot ?? createUiSnapshot;
  const wait = options.delayFn ?? delay;
  let lastSnapshot = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    clearInput(adbPath, serial, DEFAULT_CLEAR_TEXT_INPUT_MAX_DELETE_COUNT, runCommand);
    await wait(focusSettleMs);
    runCommand(adbPath, [
      "-s",
      serial,
      "shell",
      "input",
      "text",
      escapedValue,
    ], { timeout: ADB_INPUT_TEXT_TIMEOUT_MS });

    const result = await waitForSnapshotMatch(
      adbPath,
      serial,
      {
        timeoutMs: confirmTimeoutMs,
        pollIntervalMs: options.pollIntervalMs,
        createSnapshot,
        delayFn: wait,
      },
      (snapshot) => findPromptInComposerInputNode(snapshot, normalizedValue)
    );
    lastSnapshot = result.snapshot;

    if (result.match) {
      return result.match;
    }

    if (attempt < maxAttempts) {
      log(`ADB text input read-back mismatch on attempt ${attempt}; retrying the full value.`);
      await wait(retryDelayMs);
    }
  }

  throw new Error(
    withUiSnapshotSummary(
      lastSnapshot,
      `Timed out confirming the exact text prompt "${normalizedValue}" in the focused chat input after ${maxAttempts} attempts.`
    )
  );
}

async function waitForEnabledAnyNode(adbPath, serial, labels, options = {}) {
  const { match, snapshot } = await waitForSnapshotMatch(
    adbPath,
    serial,
    {
      ...options,
      timeoutMs: options.timeoutMs ?? ENABLED_ACTION_SETTLE_TIMEOUT_MS,
    },
    (candidateSnapshot) => {
      const candidate = findAnyNodeInSnapshot(candidateSnapshot, labels, {
        ...options,
        visibleOnly: true,
      });
      if (!candidate || candidate.node.enabled === false || candidate.node.clickable !== true) {
        return null;
      }
      return candidate;
    }
  );

  if (match) {
    return match;
  }

  throw new Error(
    withUiSnapshotSummary(
      snapshot,
      `Timed out waiting for an enabled action matching any of: ${labels.map((label) => `"${label}"`).join(", ")}.`
    )
  );
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

class ScenarioPreconditionFailureError extends Error {}

function shouldAppendRunnerFailure(error) {
  return !(
    error instanceof ScenarioSkipFailureError
    || error?.scenarioFailureRecorded === true
  );
}

function markScenarioFailureRecorded(error) {
  const normalizedError = error instanceof Error ? error : new Error(String(error));
  Object.defineProperty(normalizedError, "scenarioFailureRecorded", {
    configurable: true,
    value: true,
  });
  return normalizedError;
}

function combineScenarioErrors(primaryError, secondaryError) {
  const primary = primaryError instanceof Error
    ? primaryError
    : new Error(String(primaryError));
  const secondary = secondaryError instanceof Error
    ? secondaryError
    : new Error(String(secondaryError));
  const message = `${primary.message} Android logcat evidence also failed: ${secondary.message}`;
  const CombinedError = (
    primary instanceof ScenarioPreconditionFailureError
    || secondary instanceof ScenarioPreconditionFailureError
  )
    ? ScenarioPreconditionFailureError
    : Error;
  const combined = new CombinedError(message, { cause: primary });
  combined.errors = [primary, secondary];
  return combined;
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

}

function assertAttachmentTextOnlyFallbackState({
  fallbackNode = null,
  attachNode = null,
} = {}) {
  if (!fallbackNode) {
    throw new ScenarioSkipError(
      "Loaded text-only attachment fallback was not visible; prepare a loaded text-only model or a loaded vision model with missing/failed/ambiguous projector state."
    );
  }

  assertAttachmentActionBlocked(attachNode);
}

function isResourceId(node, resourceId) {
  const candidateResourceId = node?.resourceId || "";
  return candidateResourceId === resourceId || candidateResourceId.endsWith(`:id/${resourceId}`);
}

function findResourceIdInSnapshot(snapshot, resourceId, options = {}) {
  const viewportBounds = options.visibleOnly ? snapshot.viewportBounds : null;
  const matches = snapshot.nodes.filter((node) => {
    if (!isResourceId(node, resourceId)) {
      return false;
    }

    if (!options.visibleOnly) {
      return true;
    }

    return Boolean(node.bounds)
      && (!viewportBounds || isBoundsInViewport(node.bounds, viewportBounds));
  });

  return pickBestNode(matches) || null;
}

function findAttachImageActionInSnapshot(snapshot, options = {}) {
  const node = findResourceIdInSnapshot(snapshot, ATTACH_IMAGE_BUTTON_RESOURCE_ID, options);
  if (!node) {
    return findAnyNodeInSnapshot(snapshot, ATTACH_IMAGE_LABELS, options);
  }

  return {
    label: ATTACH_IMAGE_LABELS[0],
    node,
  };
}

function findAttachMenuActionInSnapshot(snapshot, options = {}) {
  const node = findResourceIdInSnapshot(snapshot, ATTACH_MENU_BUTTON_RESOURCE_ID, options);
  if (!node) {
    return findAnyNodeInSnapshot(snapshot, ATTACH_MENU_LABELS, options);
  }

  return {
    label: ATTACH_MENU_LABELS[0],
    node,
  };
}

function isAttachmentActionBusy(attachNode) {
  const node = attachNode && attachNode.node ? attachNode.node : attachNode;
  if (!node) {
    return false;
  }

  const contentDesc = normalizeUiLabel(node.contentDesc);
  return ATTACHMENT_ACTION_BUSY_LABEL_FRAGMENTS.some((fragment) => (
    contentDesc.includes(normalizeUiLabel(fragment))
  ));
}

function dismissAttachmentMenu(adbPath, serial) {
  runChecked(adbPath, [
    "-s",
    serial,
    "shell",
    "input",
    "keyevent",
    "KEYCODE_BACK",
  ]);
}

async function waitForSettledAttachImageAction(adbPath, serial, options = {}) {
  const timeoutMs = options.timeoutMs ?? ATTACH_IMAGE_ACTION_SETTLE_TIMEOUT_MS;
  const createSnapshot = options.createSnapshot ?? createUiSnapshot;
  const tap = options.tapBounds ?? tapBounds;
  const dismissMenu = options.dismissAttachmentMenu ?? dismissAttachmentMenu;
  const wait = options.delayFn ?? delay;
  const maxMenuTapAttempts = options.maxMenuTapAttempts ?? 3;
  const menuTapRetryIntervalMs = options.menuTapRetryIntervalMs ?? 1_200;
  const pollIntervalMs = options.pollIntervalMs ?? 600;
  const startedAt = Date.now();
  let lastMatch = null;
  let openedAttachmentMenu = false;
  let menuSurfaceObserved = false;
  let menuTapAttempts = 0;
  let lastMenuTapAt = 0;

  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = createSnapshot(adbPath, serial);
    const match = findAttachImageActionInSnapshot(snapshot, { visibleOnly: true });
    menuSurfaceObserved = menuSurfaceObserved || Boolean(match);
    if (match && !isAttachmentActionBusy(match.node)) {
      if (openedAttachmentMenu) {
        dismissMenu(adbPath, serial);
        await wait(options.afterMenuDismissDelayMs ?? 300);
      }
      return match;
    }

    if (!match) {
      const menuMatch = findAttachMenuActionInSnapshot(snapshot, { visibleOnly: true });
      const shouldTapMenu = menuMatch?.node?.bounds
        && menuTapAttempts < maxMenuTapAttempts
        && (!openedAttachmentMenu || Date.now() - lastMenuTapAt >= menuTapRetryIntervalMs);

      if (shouldTapMenu) {
        tap(adbPath, serial, menuMatch.node.bounds);
        openedAttachmentMenu = true;
        menuTapAttempts += 1;
        lastMenuTapAt = Date.now();
        await wait(options.afterMenuOpenDelayMs ?? 600);
        continue;
      }

      if (openedAttachmentMenu) {
        // The attachment sheet is rendered asynchronously. Keep polling after the menu tap
        // instead of treating the first stale hierarchy as authoritative.
        await wait(pollIntervalMs);
        continue;
      }

      return null;
    }

    lastMatch = match;
    await wait(pollIntervalMs);
  }

  if (openedAttachmentMenu && menuSurfaceObserved) {
    dismissMenu(adbPath, serial);
    await wait(options.afterMenuDismissDelayMs ?? 300);
  }

  return lastMatch;
}

function assertAttachmentActionBlocked(attachNode, options = {}) {
  const node = attachNode && attachNode.node ? attachNode.node : attachNode;
  const stateDescription = options.stateDescription || "text-only fallback state";

  if (!node) {
    throw new Error(`Image attachment action was not visible in the ${stateDescription}.`);
  }

  if (isAttachmentActionBusy(node)) {
    throw new Error(`Image attachment action is still busy in the ${stateDescription}.`);
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

  if (isAttachmentActionBusy(node)) {
    throw new Error("Image attachment action is still busy in the vision-ready composer state.");
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
        await tapBottomTabUntilVisible(ctx, CHAT_TAB_LABELS, CHAT_ROUTE_LABELS, {
          timeoutMs: CHAT_ROUTE_TIMEOUT_MS,
        });

        await tapBottomTabUntilVisible(ctx, MODELS_TAB_LABELS, MODEL_CATALOG_LABELS);
        await ctx.expectAnyText(ALL_MODELS_LABELS);
        await ctx.expectAnyText(DOWNLOADED_TAB_LABELS);

        await tapBottomTabUntilVisible(ctx, SETTINGS_TAB_LABELS, SETTINGS_TITLE_LABELS, {
          timeoutMs: SETTINGS_ROUTE_TIMEOUT_MS,
        });

        await tapBottomTabUntilVisible(ctx, HOME_TAB_LABELS, HOME_SECTION_LABELS, {
          timeoutMs: HOME_ROUTE_TIMEOUT_MS,
        });
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

        await tapBottomTabUntilVisible(ctx, CHAT_TAB_LABELS, CHAT_ROUTE_LABELS, {
          timeoutMs: CHAT_ROUTE_TIMEOUT_MS,
        });
        ctx.captureScreenshot("style-chat.png");

        await tapBottomTabUntilVisible(ctx, SETTINGS_TAB_LABELS, SETTINGS_TITLE_LABELS, {
          timeoutMs: SETTINGS_ROUTE_TIMEOUT_MS,
        });
        await scrollToAnyText(ctx, LANGUAGE_ROW_LABELS, { timeoutMs: SETTINGS_ROUTE_TIMEOUT_MS });
        ctx.captureScreenshot("style-settings.png");

        await tapBottomTabUntilVisible(ctx, MODELS_TAB_LABELS, MODEL_CATALOG_LABELS);
        await ctx.expectAnyText(ALL_MODELS_LABELS);
        ctx.captureScreenshot("style-models.png");
        await goToHome(ctx);
      },
    },
    {
      id: "storage-cache-clear",
      tier: "secondary",
      description: "Verify Storage Manager removes a real private-cache file through the user-facing flow.",
      run: async (ctx) => {
        await goToHome(ctx);
        await tapBottomTabUntilVisible(ctx, SETTINGS_TAB_LABELS, SETTINGS_TITLE_LABELS, {
          timeoutMs: SETTINGS_ROUTE_TIMEOUT_MS,
        });

        const adbPath = resolveAdbPath();
        seedPrivateStorageCacheSentinel(adbPath, ctx.serial);
        if (!appPrivatePathExists(adbPath, ctx.serial, STORAGE_CACHE_QA_SENTINEL)) {
          throw new Error("Failed to prepare the private-cache sentinel before opening Storage Manager.");
        }

        await scrollToAnyText(ctx, STORAGE_MANAGER_LABELS, { timeoutMs: SETTINGS_ROUTE_TIMEOUT_MS });
        await ctx.tapAnyText(STORAGE_MANAGER_LABELS);
        await ctx.expectAnyText(STORAGE_MANAGER_LABELS, { timeoutMs: SETTINGS_ROUTE_TIMEOUT_MS });
        await ctx.expectAnyText(CLEAR_ACTIVE_CACHE_LABELS, { timeoutMs: SETTINGS_ROUTE_TIMEOUT_MS });

        const clearButton = await waitForResourceId(
          adbPath,
          ctx.serial,
          STORAGE_CLEAR_CACHE_RESOURCE_ID,
          { timeoutMs: SETTINGS_ROUTE_TIMEOUT_MS, visibleOnly: true }
        );
        if (!clearButton.bounds) {
          throw new Error("The Storage Manager cache-clear control has no tap bounds.");
        }
        tapBounds(adbPath, ctx.serial, clearButton.bounds);
        await delay(500);
        const confirmButton = await waitForResourceId(
          adbPath,
          ctx.serial,
          ANDROID_DIALOG_POSITIVE_BUTTON_RESOURCE_ID,
          { timeoutMs: 5_000, visibleOnly: true }
        );
        if (!confirmButton.bounds) {
          throw new Error("The Android cache-clear confirmation has no tap bounds.");
        }
        tapBounds(adbPath, ctx.serial, confirmButton.bounds);

        for (let attempt = 0; attempt < 20; attempt += 1) {
          if (!appPrivatePathExists(adbPath, ctx.serial, STORAGE_CACHE_QA_SENTINEL)) {
            break;
          }
          await delay(500);
        }
        if (appPrivatePathExists(adbPath, ctx.serial, STORAGE_CACHE_QA_SENTINEL)) {
          throw new Error("Storage Manager reported success but the private-cache sentinel still exists.");
        }

        await ctx.expectAnyText(STORAGE_MANAGER_LABELS, { timeoutMs: 5_000 });
        await ctx.pressBack();
        await ctx.expectAnyText(SETTINGS_TITLE_LABELS, { timeoutMs: SETTINGS_ROUTE_TIMEOUT_MS });
        await tapBottomTabUntilVisible(ctx, HOME_TAB_LABELS, HOME_SECTION_LABELS, {
          timeoutMs: HOME_ROUTE_TIMEOUT_MS,
        });
      },
    },
    {
      id: "new-chat-cta",
      tier: "core",
      description: "Verify the Home screen New Chat button opens the chat screen empty state.",
      run: async (ctx) => {
        await goToHome(ctx);
        await waitForModelWarmupToSettleIfPresent(resolveAdbPath(), ctx.serial);
        await ctx.tapAnyText(NEW_CHAT_LABELS);
        await ctx.expectResourceId(CHAT_LIST_VIEWPORT_RESOURCE_ID, {
          timeoutMs: CHAT_ROUTE_TIMEOUT_MS,
        });
        await ctx.expectAnyText(CHAT_EMPTY_LABELS, { timeoutMs: CHAT_ROUTE_TIMEOUT_MS });
        await tapBottomTabUntilVisible(ctx, HOME_TAB_LABELS, NEW_CHAT_LABELS, {
          timeoutMs: HOME_ROUTE_TIMEOUT_MS,
        });
      },
    },
    {
      id: "chat-attachment-current-state-smoke",
      tier: "secondary",
      description: "Verify image attachment composer affordance matches the current model state without requiring prepared storage.",
      run: async (ctx) => {
        await goToHome(ctx);
        await waitForModelWarmupToSettleIfPresent(resolveAdbPath(), ctx.serial);
        await ctx.tapAnyText(NEW_CHAT_LABELS);
        await ctx.expectAnyText(CHAT_EMPTY_LABELS, { timeoutMs: CHAT_ROUTE_TIMEOUT_MS });

        const adbPath = resolveAdbPath();
        const noModelNode = await findAnyNodeNow(
          adbPath,
          ctx.serial,
          NO_MODEL_STATE_LABELS,
          { visibleOnly: true }
        );
        const fallbackNode = await findAnyNodeNow(
          adbPath,
          ctx.serial,
          IMAGE_ATTACHMENT_TEXT_ONLY_FALLBACK_LABELS,
          { visibleOnly: true, matchMode: "fragment" }
        );
        const attachNode = await waitForSettledAttachImageAction(adbPath, ctx.serial);

        if (noModelNode) {
          assertAttachmentActionBlocked(attachNode, { stateDescription: "no-model chat state" });
          log(
            "INFO chat-attachment-current-state-smoke: no loaded model detected; "
            + "validated no-model image attachment affordance. Prepare a loaded text-only model "
            + "or a loaded vision model with missing/failed/ambiguous projector state and run "
            + "android:scenarios:attachments-preconditioned for required fallback-send coverage."
          );
        } else if (fallbackNode) {
          assertAttachmentTextOnlyFallbackState({ fallbackNode, attachNode });
          await sendTextOnlyFallbackSmokeMessage(ctx, adbPath, buildTextOnlyFallbackSendPrompt());
          log(
            "INFO chat-attachment-current-state-smoke: image attachment fallback detected; "
            + "validated blocked image affordance and text-only fallback send."
          );
        } else {
          assertAttachmentActionAvailable(attachNode);
        }

        await tapBottomTabUntilVisible(ctx, HOME_TAB_LABELS, HOME_SECTION_LABELS, {
          timeoutMs: HOME_ROUTE_TIMEOUT_MS,
        });
      },
    },
    {
      id: "chat-attachment-text-only-fallback",
      tier: "secondary",
      description: "Preconditioned check: verify a loaded text-capable non-vision chat blocks images while preserving assistant text responses.",
      run: async (ctx) => {
        await ensureLoadedModelTextFallbackPrecondition(ctx);
        await ctx.tapAnyText(NEW_CHAT_LABELS);
        await ctx.expectAnyText(CHAT_EMPTY_LABELS);

        const adbPath = resolveAdbPath();
        const fallbackNode = await findAnyNodeNow(
          adbPath,
          ctx.serial,
          LOADED_TEXT_ATTACHMENT_FALLBACK_LABELS,
          { visibleOnly: true, matchMode: "fragment" }
        );

        const attachNode = await waitForSettledAttachImageAction(adbPath, ctx.serial);

        assertAttachmentTextOnlyFallbackState({ fallbackNode, attachNode });
        await sendTextOnlyFallbackSmokeMessage(ctx, adbPath, buildTextOnlyFallbackSendPrompt());

        await tapBottomTabUntilVisible(ctx, HOME_TAB_LABELS, HOME_SECTION_LABELS, {
          timeoutMs: HOME_ROUTE_TIMEOUT_MS,
        });
      },
    },
    {
      id: "chat-attachment-preview-remove",
      tier: "optional",
      description: "Verify a prepared running vision-ready image attachment draft can be previewed and removed without restarting the app.",
      run: async (ctx) => {
        const adbPath = resolveAdbPath();
        const fallbackNode = await findAnyNodeNow(
          adbPath,
          ctx.serial,
          LOADED_TEXT_ATTACHMENT_FALLBACK_LABELS,
          { visibleOnly: true, matchMode: "fragment" }
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
        const restoredAttachNode = await waitForSettledAttachImageAction(adbPath, ctx.serial, { timeoutMs: 5_000 });
        assertAttachmentActionAvailable(restoredAttachNode);
      },
    },
    {
      id: "chat-attachment-prepared-send",
      tier: "optional",
      description: "Verify a manually prepared vision-ready image attachment draft can be sent without restarting the app.",
      run: async (ctx) => {
        const preparedAttachmentSendPrompt = buildPreparedAttachmentSendPrompt();

        const adbPath = resolveAdbPath();
        const fallbackNode = await findAnyNodeNow(
          adbPath,
          ctx.serial,
          LOADED_TEXT_ATTACHMENT_FALLBACK_LABELS,
          { visibleOnly: true, matchMode: "fragment" }
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
          fallbackNode,
          previewNode,
          removeNode,
        });

        await ctx.tapAnyText(CHAT_INPUT_LABELS, {
          allowBottomOverlay: true,
          timeoutMs: 5_000,
        });
        await inputFocusedTextAndConfirm(adbPath, ctx.serial, preparedAttachmentSendPrompt);

        await waitForEnabledAnyNode(
          adbPath,
          ctx.serial,
          CHAT_SEND_LABELS,
          { timeoutMs: ENABLED_ACTION_SETTLE_TIMEOUT_MS }
        );

        await ctx.tapAnyText(CHAT_SEND_LABELS, {
          allowBottomOverlay: true,
          timeoutMs: 5_000,
          afterTapDelayMs: 1_500,
        });
        await waitForNoAnyNode(adbPath, ctx.serial, ATTACHMENT_PREVIEW_LABELS, { timeoutMs: 8_000 });
        await waitForNoAnyNode(adbPath, ctx.serial, REMOVE_ATTACHMENT_LABELS, { timeoutMs: 8_000 });
        await waitForPreparedSentMessageContext(adbPath, ctx.serial, preparedAttachmentSendPrompt, {
          timeoutMs: 10_000,
        }).then((sentContext) => waitForPreparedAssistantResponse(adbPath, ctx.serial, sentContext, preparedAttachmentSendPrompt, {
          timeoutMs: 30_000,
        }));
        await ctx.expectAnyText([preparedAttachmentSendPrompt], { timeoutMs: 10_000 });
      },
    },
    {
      id: "variant-picker-smoke",
      tier: "optional",
      description: "Verify the model catalog opens the GGUF file variant picker.",
      run: async (ctx) => {
        await goToModelCatalog(ctx);
        await prepareCatalogForVariantPickerSmokeScenario(ctx);

        await openFirstVisibleVariantPicker(ctx);
        await ctx.expectAnyText(VARIANT_PICKER_TITLE_LABELS, { timeoutMs: 15_000 });

        const adbPath = resolveAdbPath();
        await dismissTransientSurfaceWithBack(
          ctx,
          adbPath,
          ctx.serial,
          VARIANT_PICKER_TITLE_LABELS,
          MODEL_CATALOG_LABELS
        );
        await tapBottomTabUntilVisible(ctx, HOME_TAB_LABELS, HOME_SECTION_LABELS, {
          timeoutMs: HOME_ROUTE_TIMEOUT_MS,
        });
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
        await tapBottomTabUntilVisible(ctx, HOME_TAB_LABELS, ACTIVE_MODEL_CTA_LABELS, {
          timeoutMs: HOME_ROUTE_TIMEOUT_MS,
        });
      },
    },
    {
      id: "hf-catalog-hardening",
      tier: "optional",
      description: "Verify guided discovery, new HF catalog controls, and routed model details.",
      run: async (ctx) => {
        await goToModelCatalog(ctx);

        const adbPath = resolveAdbPath();
        const catalogResultsStartedAt = Date.now();
        await waitForAnyTappableNode(adbPath, ctx.serial, MODEL_DETAILS_CTA_LABELS, {
          timeoutMs: 12_000,
        });
        log(`Catalog model cards became interactive in ${Date.now() - catalogResultsStartedAt}ms.`);

        await setCatalogFilterPanelOpen(adbPath, ctx.serial, true);

        await ctx.tapAnyText(SORT_LABELS);
        await ctx.expectAnyText(MOST_DOWNLOADED_LABELS);
        await ctx.expectAnyText(MOST_POPULAR_LABELS);
        await ctx.tapAnyText(SORT_LABELS);

        await ctx.tapAnyText(MODEL_DETAILS_CTA_LABELS, { timeoutMs: 5_000 });
        await ctx.expectAnyText(MODEL_DETAILS_TITLE_LABELS);
        await ctx.expectAnyText(OPEN_ON_HF_LABELS);
      },
    },
    {
      id: "memory-fit-badges",
      tier: "optional",
      description: "Verify memory-fit badges show up in quantization picker rows.",
      run: async (ctx) => {
        await goToModelCatalog(ctx);
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
        await goToModelCatalog(ctx);
        await prepareCatalogForRamWarningScenario(ctx);

        const adbPath = resolveAdbPath();

        for (let attempt = 0; attempt < 6; attempt += 1) {
          const riskModelCard = findCatalogRiskModelCard(adbPath, ctx.serial);

          if (!riskModelCard) {
            await ctx.swipeUp();
            continue;
          }

          await tapBoundsUntilAnyNode(
            adbPath,
            ctx.serial,
            riskModelCard.detailsNode.bounds,
            MODEL_DETAILS_TITLE_LABELS,
            {
              timeoutMs: MODEL_DETAILS_ROUTE_TIMEOUT_MS,
              sourceLabels: MODEL_CATALOG_LABELS,
            }
          );

          await ctx.tapAnyText(DOWNLOAD_CTA_LABELS, {
            timeoutMs: 12_000,
            afterTapDelayMs: DOWNLOAD_WARNING_QUIET_DELAY_MS,
          });
          await waitForAnyNode(adbPath, ctx.serial, DOWNLOAD_WARNING_TITLE_LABELS, {
            timeoutMs: DOWNLOAD_WARNING_SETTLE_TIMEOUT_MS,
            visibleOnly: true,
          });

          await ctx.tapAnyText(DOWNLOAD_WARNING_CANCEL_LABELS, {
            timeoutMs: 5_000,
            allowBottomOverlay: true,
          });
          await waitForNoAnyNode(adbPath, ctx.serial, DOWNLOAD_WARNING_TITLE_LABELS, {
            timeoutMs: 10_000,
          });
          await ctx.tapAnyText(MODEL_DETAILS_BACK_LABELS, {
            timeoutMs: 5_000,
            afterTapDelayMs: 30_000,
          });
          const returnedToCatalog = await findAnyNodeNow(
            adbPath,
            ctx.serial,
            MODEL_CATALOG_LABELS,
            { visibleOnly: true }
          );
          if (!returnedToCatalog) {
            log(
              "INFO memory-fit-download-warning: warning and Cancel were verified; "
              + "model-details cleanup is still settling and was left for the next scenario precondition."
            );
          }
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
          await tapBottomTabUntilVisible(ctx, HOME_TAB_LABELS, nextHomeLabel, {
            timeoutMs: 10_000,
          });
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
        const adbPath = resolveAdbPath();
        runChecked(adbPath, buildAppRouteDeepLinkArgs(ctx.serial, "performance"), {
          stdio: "ignore",
        });
        await ctx.expectAnyText(PERFORMANCE_COPY_TRACE_LABELS);

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

        const packageUid = resolveAndroidPackageUid(adbPath, ctx.serial, appPackageName);
        const logcatStartEpoch = readAndroidLogcatStartEpoch(adbPath, ctx.serial);

        await scrollToAnyText(ctx, PERFORMANCE_DUMP_TO_LOGCAT_LABELS, {
          timeoutMs: 5_000,
          maxSwipesDown: 0,
        });
        await ctx.tapAnyText(PERFORMANCE_DUMP_TO_LOGCAT_LABELS);

        let logs = "";
        for (let attempt = 0; attempt < 4; attempt += 1) {
          await delay(1_500 + attempt * 1_000);
          logs = runCapture(adbPath, [
            "-s",
            ctx.serial,
            "logcat",
            "-b",
            "all",
            `--uid=${packageUid}`,
            "-T",
            logcatStartEpoch,
            "-d",
            "-v",
            "threadtime",
          ]);
          if (logs.includes("POCKET_AI_PERF_TRACE")) {
            break;
          }
        }

        if (!logs.includes("POCKET_AI_PERF_TRACE")) {
          throw new Error("Expected POCKET_AI_PERF_TRACE output in logcat.");
        }
      },
    },
    ...buildBranchRegenerationScenarios(),
  ];
}

function buildBranchRegenerationScenarios() {
  const state = {
    initialized: false,
    threadId: null,
    sentinelThreadId: null,
    audioSupported: false,
    targets: null,
    trailingModelSwitchId: null,
    stableMainAssistantId: null,
    forceStoppedBeforeAssistantId: null,
    partialAssistantId: null,
    successfulAssistantId: null,
  };
  const scenario = (step, id, description, run, expectedJsSurface = "foreground") => ({
    id,
    step,
    tier: "critical",
    description,
    captureFullEvidence: true,
    requiresCurrentHeadProvenance: true,
    expectedJsSurface,
    run,
  });

  return [
    scenario(
      1,
      BRANCH_REGENERATION_SCENARIOS[0],
      "Validate the prepared branch-regeneration conversation, sentinel conversation, and loaded model.",
      async (ctx) => {
        const adbPath = resolveAdbPath();
        await goToHome(ctx);
        await waitForModelWarmupToSettleIfPresent(adbPath, ctx.serial);
        const recentThreadIds = readVisibleRecentConversationIds(adbPath, ctx.serial);
        if (recentThreadIds.length < 2) {
          throw new ScenarioPreconditionFailureError(
            "Branch-regeneration requires two prepared recent conversations: the fixture conversation and a clear-history sentinel."
          );
        }

        state.threadId = recentThreadIds[0];
        state.sentinelThreadId = recentThreadIds[1];
        await openConversationByThreadId(ctx, state.threadId);
        assertLoadedChatPrecondition(adbPath, ctx.serial);

        const topology = await scanConversationTopology(ctx);
        state.audioSupported = await detectAudioAttachmentSupport(ctx);
        const fixture = resolveBranchFixture(topology, {
          audioSupported: state.audioSupported,
        });
        state.targets = fixture.targets;
        state.trailingModelSwitchId = fixture.trailingModelSwitchId;
        state.stableMainAssistantId = fixture.targets.main.assistantId;
        state.initialized = true;

        return {
          details: {
            fixtureThreadId: state.threadId,
            sentinelThreadId: state.sentinelThreadId,
            audioSupported: state.audioSupported,
            orderedMessageCount: topology.order.length,
            targetIds: Object.fromEntries(
              Object.entries(state.targets)
                .filter(([, target]) => Boolean(target))
                .map(([kind, target]) => [kind, {
                  userId: target.userId,
                  assistantId: target.assistantId,
                }])
            ),
            trailingModelSwitchId: state.trailingModelSwitchId,
          },
        };
      }
    ),
    scenario(
      2,
      BRANCH_REGENERATION_SCENARIOS[1],
      "Confirm that the prepared main turn ends in a completed assistant response followed by a model-switch marker.",
      async (ctx) => {
        requireBranchFixtureState(state, 2);
        await ensureBranchThreadOpen(ctx, state.threadId);
        const topology = await scanConversationTopology(ctx);
        assertTrailingModelSwitchTopology(topology, state.targets.main, state.trailingModelSwitchId);
        return {
          details: {
            mainUserId: state.targets.main.userId,
            stableAssistantId: state.stableMainAssistantId,
            trailingModelSwitchId: state.trailingModelSwitchId,
          },
        };
      }
    ),
    scenario(
      3,
      BRANCH_REGENERATION_SCENARIOS[2],
      "Start main-turn regeneration and force-stop the app before the first generated output.",
      async (ctx) => {
        requireBranchFixtureState(state, 3);
        await ensureBranchThreadOpen(ctx, state.threadId);
        const beforeTopology = await scanConversationTopology(ctx);
        const baseline = createBranchRegenerationBaseline(
          beforeTopology,
          state.targets.main.userId
        );
        await armAndroidQaGenerationGate(ctx, "before-first-output");
        await startBranchRegeneration(ctx, state.targets.main);
        const interruption = await interruptObservedBranchGeneration(ctx, {
          baselineAssistantIds: baseline.assistantIds,
          evidenceLabel: "force-stopped-before-first-output",
          mode: "force-stop",
          phase: "before-first-output",
        });
        state.forceStoppedBeforeAssistantId = interruption.assistantId;
        ctx.captureCheckpoint("force-stopped-before-first-token", { expectedJsSurface: "stopped" });
        return {
          details: {
            stableAssistantId: state.stableMainAssistantId,
            interruptedAssistantId: interruption.assistantId,
            interruptionEvidence: interruption,
          },
        };
      },
      "stopped"
    ),
    scenario(
      4,
      BRANCH_REGENERATION_SCENARIOS[3],
      "Relaunch after the pre-token force-stop and verify the original assistant branch remains intact.",
      async (ctx) => {
        requireBranchFixtureState(state, 4);
        await relaunchScenarioAppAndOpenThread(ctx, state.threadId);
        const topology = await scanConversationTopology(ctx);
        assertTrailingModelSwitchTopology(topology, state.targets.main, state.trailingModelSwitchId);
        assertAssistantState(topology, state.stableMainAssistantId, "complete");
        assertMessageIdAbsent(topology, state.forceStoppedBeforeAssistantId);
        assertNoDuplicateMessageIds(topology);
        return {
          details: {
            restoredAssistantId: state.stableMainAssistantId,
            restoredModelSwitchId: state.trailingModelSwitchId,
          },
        };
      }
    ),
    scenario(
      5,
      BRANCH_REGENERATION_SCENARIOS[4],
      "Start main-turn regeneration, persist real partial output, and force-stop the app.",
      async (ctx) => {
        requireBranchFixtureState(state, 5);
        await ensureBranchThreadOpen(ctx, state.threadId);
        const beforeTopology = await scanConversationTopology(ctx);
        const baseline = createBranchRegenerationBaseline(
          beforeTopology,
          state.targets.main.userId
        );
        await armAndroidQaGenerationGate(ctx, "after-first-durable-output");
        await startBranchRegeneration(ctx, state.targets.main);
        const partial = await interruptObservedBranchGeneration(ctx, {
          baselineAssistantIds: baseline.assistantIds,
          evidenceLabel: "force-stopped-after-first-durable-output",
          mode: "force-stop",
          phase: "after-first-durable-output",
        });
        state.partialAssistantId = partial.assistantId;
        ctx.captureCheckpoint("force-stopped-after-partial", { expectedJsSurface: "stopped" });
        return {
          details: {
            partialAssistantId: state.partialAssistantId,
            partialSurface: partial.surface,
          },
        };
      },
      "stopped"
    ),
    scenario(
      6,
      BRANCH_REGENERATION_SCENARIOS[5],
      "Relaunch after partial output and verify one stopped replacement branch without duplicates.",
      async (ctx) => {
        requireBranchFixtureState(state, 6);
        if (!state.partialAssistantId) {
          throw new ScenarioPreconditionFailureError("Step 6 requires the partial assistant id recorded by step 5.");
        }
        await relaunchScenarioAppAndOpenThread(ctx, state.threadId);
        await waitForExactAssistantState(ctx, state.partialAssistantId, "stopped");
        const topology = await scanConversationTopology(ctx);
        assertAssistantState(topology, state.partialAssistantId, "stopped");
        assertMessageIdAbsent(topology, state.stableMainAssistantId);
        assertMessageIdAbsent(topology, state.trailingModelSwitchId);
        assertNoDuplicateMessageIds(topology);
        await ctx.expectResourceId("chat-stopped-banner", { timeoutMs: 10_000 });
        return {
          details: {
            stoppedAssistantId: state.partialAssistantId,
            duplicateCount: 0,
          },
        };
      }
    ),
    scenario(
      7,
      BRANCH_REGENERATION_SCENARIOS[6],
      "Complete main-turn branch regeneration and verify the stopped branch is replaced atomically.",
      async (ctx) => {
        requireBranchFixtureState(state, 7);
        await ensureBranchThreadOpen(ctx, state.threadId);
        const completed = await completeBranchRegeneration(ctx, state.targets.main);
        state.successfulAssistantId = completed.assistantId;
        const topology = completed.topology;
        assertAssistantState(topology, state.successfulAssistantId, "complete");
        assertMessageIdAbsent(topology, state.partialAssistantId);
        assertNoDuplicateMessageIds(topology);
        return {
          details: {
            completedAssistantId: state.successfulAssistantId,
          },
        };
      }
    ),
    scenario(
      8,
      BRANCH_REGENERATION_SCENARIOS[7],
      "Stop main-turn regeneration before output and verify the completed branch remains authoritative.",
      async (ctx) => {
        requireBranchFixtureState(state, 8);
        if (!state.successfulAssistantId) {
          throw new ScenarioPreconditionFailureError("Step 8 requires the successful assistant id recorded by step 7.");
        }
        await ensureBranchThreadOpen(ctx, state.threadId);
        const beforeTopology = await scanConversationTopology(ctx);
        const baseline = createBranchRegenerationBaseline(
          beforeTopology,
          state.targets.main.userId
        );
        await armAndroidQaGenerationGate(ctx, "before-first-output");
        await startBranchRegeneration(ctx, state.targets.main);
        const interruption = await interruptObservedBranchGeneration(ctx, {
          baselineAssistantIds: baseline.assistantIds,
          evidenceLabel: "stopped-before-first-output",
          mode: "tap-stop",
          phase: "before-first-output",
        });
        await waitForRegenerationModeToClose(ctx);
        const topology = await scanConversationTopology(ctx);
        assertAssistantState(topology, state.successfulAssistantId, "complete");
        assertMessageIdAbsent(topology, interruption.assistantId);
        assertNoDuplicateMessageIds(topology);
        return {
          details: {
            preservedAssistantId: state.successfulAssistantId,
            interruptionEvidence: interruption,
          },
        };
      }
    ),
    scenario(
      9,
      BRANCH_REGENERATION_SCENARIOS[8],
      "Stop main-turn regeneration after partial output and verify one stopped replacement branch.",
      async (ctx) => {
        requireBranchFixtureState(state, 9);
        await ensureBranchThreadOpen(ctx, state.threadId);
        const beforeTopology = await scanConversationTopology(ctx);
        const baseline = createBranchRegenerationBaseline(
          beforeTopology,
          state.targets.main.userId
        );
        await armAndroidQaGenerationGate(ctx, "after-first-durable-output");
        await startBranchRegeneration(ctx, state.targets.main);
        const partial = await interruptObservedBranchGeneration(ctx, {
          baselineAssistantIds: baseline.assistantIds,
          evidenceLabel: "stopped-after-first-durable-output",
          mode: "tap-stop",
          phase: "after-first-durable-output",
        });
        await waitForExactAssistantState(ctx, partial.assistantId, "stopped");
        const topology = await scanConversationTopology(ctx);
        assertAssistantState(topology, partial.assistantId, "stopped");
        assertMessageIdAbsent(topology, state.successfulAssistantId);
        assertNoDuplicateMessageIds(topology);
        return {
          details: {
            stoppedAssistantId: partial.assistantId,
          },
        };
      }
    ),
    scenario(
      10,
      BRANCH_REGENERATION_SCENARIOS[9],
      "Regenerate the reasoning turn and verify stale reasoning from the replaced assistant is authoritatively removed.",
      async (ctx) => {
        requireBranchFixtureState(state, 10);
        await ensureBranchThreadOpen(ctx, state.threadId);
        const reasoningConfiguration = await disableReasoningForAuthoritativeClear(ctx);
        const completed = await completeBranchRegeneration(ctx, state.targets.reasoning);
        const settledThoughtClear = assertAuthoritativeThoughtClear({
          beforeTopology: completed.beforeTopology,
          topology: completed.topology,
          baseline: completed.baseline,
          replacementAssistantId: completed.assistantId,
        });
        assertNoDuplicateMessageIds(completed.topology);

        await relaunchScenarioAppAndOpenThread(ctx, state.threadId);
        const rehydratedTopology = await scanConversationTopology(ctx);
        const rehydratedThoughtClear = assertAuthoritativeThoughtClear({
          beforeTopology: completed.beforeTopology,
          topology: rehydratedTopology,
          baseline: completed.baseline,
          replacementAssistantId: completed.assistantId,
        });
        assertNoDuplicateMessageIds(rehydratedTopology);
        return {
          details: {
            replacedReasoningAssistantId: completed.baseline.previousAssistantId,
            authoritativeAssistantId: completed.assistantId,
            reasoningConfiguration,
            staleThoughtResourceRemoved: rehydratedThoughtClear.replacedThoughtAbsent,
            authoritativeThoughtCleared: settledThoughtClear.replacementThoughtAbsent,
            rehydratedThoughtClearVerified: rehydratedThoughtClear.replacementThoughtAbsent,
          },
        };
      }
    ),
    scenario(
      11,
      BRANCH_REGENERATION_SCENARIOS[10],
      "Regenerate the prepared image-attached turn and verify attachment identity survives branch replacement.",
      async (ctx) => {
        requireBranchFixtureState(state, 11);
        await ensureBranchThreadOpen(ctx, state.threadId);
        await assertTargetAttachmentVisible(ctx, state.targets.image, "image");
        const completed = await completeBranchRegeneration(ctx, state.targets.image);
        const topology = completed.topology;
        assertTargetAttachment(topology, state.targets.image, "image");
        assertAssistantState(topology, completed.assistantId, "complete");
        const preparedAttachmentIds = assertPreparedAttachmentGenerationEvidence(
          createUiSnapshot(resolveAdbPath(), ctx.serial),
          state.targets.image,
          completed.assistantId,
          "image"
        );
        return {
          details: {
            userId: state.targets.image.userId,
            completedAssistantId: completed.assistantId,
            attachmentKind: "image",
            preparedAttachmentIds,
          },
        };
      }
    ),
    scenario(
      12,
      BRANCH_REGENERATION_SCENARIOS[11],
      "Regenerate the prepared document-attached turn and verify attachment identity survives branch replacement.",
      async (ctx) => {
        requireBranchFixtureState(state, 12);
        await ensureBranchThreadOpen(ctx, state.threadId);
        await assertTargetAttachmentVisible(ctx, state.targets.document, "document");
        const completed = await completeBranchRegeneration(ctx, state.targets.document);
        const topology = completed.topology;
        assertTargetAttachment(topology, state.targets.document, "document");
        assertAssistantState(topology, completed.assistantId, "complete");
        const preparedAttachmentIds = assertPreparedAttachmentGenerationEvidence(
          createUiSnapshot(resolveAdbPath(), ctx.serial),
          state.targets.document,
          completed.assistantId,
          "document"
        );
        return {
          details: {
            userId: state.targets.document.userId,
            completedAssistantId: completed.assistantId,
            attachmentKind: "document",
            preparedAttachmentIds,
          },
        };
      }
    ),
    scenario(
      13,
      BRANCH_REGENERATION_SCENARIOS[12],
      "Regenerate the prepared audio-attached turn when the installed runtime exposes audio attachments.",
      async (ctx) => {
        requireBranchFixtureState(state, 13);
        if (!state.audioSupported) {
          return {
            status: "not_applicable",
            reason: "The installed runtime does not expose the audio attachment action.",
            details: {
              audioSupported: false,
              verifiedBy: "chat-attach-audio-button absence",
            },
          };
        }
        if (!state.targets.audio) {
          throw new ScenarioPreconditionFailureError(
            "Audio is supported, but the prepared conversation has no audio-attached regeneration turn."
          );
        }
        await ensureBranchThreadOpen(ctx, state.threadId);
        await assertTargetAttachmentVisible(ctx, state.targets.audio, "audio");
        const completed = await completeBranchRegeneration(ctx, state.targets.audio);
        const topology = completed.topology;
        assertTargetAttachment(topology, state.targets.audio, "audio");
        assertAssistantState(topology, completed.assistantId, "complete");
        const preparedAttachmentIds = assertPreparedAttachmentGenerationEvidence(
          createUiSnapshot(resolveAdbPath(), ctx.serial),
          state.targets.audio,
          completed.assistantId,
          "audio"
        );
        return {
          details: {
            audioSupported: true,
            userId: state.targets.audio.userId,
            completedAssistantId: completed.assistantId,
            preparedAttachmentIds,
          },
        };
      }
    ),
    scenario(
      14,
      BRANCH_REGENERATION_SCENARIOS[13],
      "Delete the final fixture conversation through the user-facing conversation control.",
      async (ctx) => {
        requireBranchFixtureState(state, 14);
        await goToHome(ctx);
        await tapConversationDelete(ctx, state.threadId);
        await assertRecentConversationAbsent(ctx, state.threadId);
        return {
          details: {
            deletedThreadId: state.threadId,
          },
        };
      }
    ),
    scenario(
      15,
      BRANCH_REGENERATION_SCENARIOS[14],
      "Clear chat history through Storage Manager, relaunch, and verify the sentinel conversation stays deleted.",
      async (ctx) => {
        requireBranchFixtureState(state, 15);
        await goToSettings(ctx);
        await scrollToAnyText(ctx, STORAGE_MANAGER_LABELS, { timeoutMs: SETTINGS_ROUTE_TIMEOUT_MS });
        await ctx.tapAnyText(STORAGE_MANAGER_LABELS);
        await ctx.expectAnyText(STORAGE_MANAGER_LABELS, { timeoutMs: SETTINGS_ROUTE_TIMEOUT_MS });
        await tapVisibleResource(ctx, STORAGE_CLEAR_CHAT_RESOURCE_ID, {
          allowScroll: true,
        });
        await confirmAndroidDialog(ctx);
        await delay(1_000);
        forceStopScenarioApp(resolveAdbPath(), ctx.serial);
        ctx.captureCheckpoint("history-cleared-force-stop", { expectedJsSurface: "stopped" });
        await relaunchScenarioApp(ctx);
        await goToHome(ctx);
        const remainingThreadIds = readVisibleRecentConversationIds(resolveAdbPath(), ctx.serial);
        if (remainingThreadIds.length > 0) {
          throw new Error(
            `Conversation history still contains ${remainingThreadIds.length} visible thread(s) after clear and relaunch.`
          );
        }
        return {
          details: {
            deletedFixtureThreadId: state.threadId,
            deletedSentinelThreadId: state.sentinelThreadId,
            remainingVisibleConversationCount: remainingThreadIds.length,
          },
        };
      }
    ),
  ];
}

function requireBranchFixtureState(state, step) {
  if (!state.initialized || !state.threadId || !state.sentinelThreadId || !state.targets) {
    throw new ScenarioPreconditionFailureError(
      `Branch-regeneration step ${step} requires the ordered pack to start successfully at step 1.`
    );
  }
}

function configureScenarioBuildEnvironment(options, requiresCurrentHeadProvenance, env = process.env) {
  if (options.apkVariant) {
    env.ANDROID_SMOKE_APK_VARIANT = options.apkVariant;
  }
  const effectiveApkVariant = (env.ANDROID_SMOKE_APK_VARIANT || "debug")
    .trim()
    .toLowerCase();
  if (requiresCurrentHeadProvenance) {
    if (effectiveApkVariant !== "release") {
      throw new ScenarioPreconditionFailureError(
        "Current-head Android scenarios require --apk-variant release so the verified APK contains the tested JS bundle."
      );
    }
    env.EXPO_PUBLIC_ANDROID_QA = "1";
    env.POCKET_AI_ALLOW_DEBUG_RELEASE_SIGNING =
      env.POCKET_AI_ALLOW_DEBUG_RELEASE_SIGNING || "true";
  }
  return {
    androidQaEvidence: env.EXPO_PUBLIC_ANDROID_QA === "1",
    apkVariant: effectiveApkVariant,
  };
}

function normalizeAndroidResourceId(resourceId) {
  const raw = `${resourceId || ""}`;
  const androidIdIndex = raw.lastIndexOf(":id/");
  if (androidIdIndex >= 0) {
    return raw.slice(androidIdIndex + 4);
  }
  return raw;
}

function findResourcePrefixNodesInSnapshot(snapshot, prefix, options = {}) {
  const viewportBounds = options.visibleOnly ? snapshot.viewportBounds : null;
  return snapshot.nodes.filter((node) => {
    if (!normalizeAndroidResourceId(node.resourceId).startsWith(prefix)) {
      return false;
    }
    if (!options.visibleOnly) {
      return true;
    }
    return Boolean(node.bounds)
      && (!viewportBounds || isBoundsInViewport(node.bounds, viewportBounds));
  });
}

function readVisibleRecentConversationIds(adbPath, serial) {
  const snapshot = createUiSnapshot(adbPath, serial);
  return findResourcePrefixNodesInSnapshot(snapshot, "recent-conversation-", {
    visibleOnly: true,
  })
    .sort((left, right) => (left.bounds?.top ?? 0) - (right.bounds?.top ?? 0))
    .map((node) => normalizeAndroidResourceId(node.resourceId).slice("recent-conversation-".length))
    .filter((threadId, index, all) => threadId && all.indexOf(threadId) === index);
}

async function openConversationByThreadId(ctx, threadId) {
  const adbPath = resolveAdbPath();
  const resourceId = `recent-conversation-${threadId}`;
  const node = await waitForResourceId(adbPath, ctx.serial, resourceId, {
    timeoutMs: HOME_ROUTE_TIMEOUT_MS,
    visibleOnly: true,
  });
  if (!node.bounds) {
    throw new ScenarioPreconditionFailureError(
      `Prepared conversation ${threadId} is present but has no tappable bounds.`
    );
  }
  tapBounds(adbPath, ctx.serial, node.bounds);
  await waitForResourceId(adbPath, ctx.serial, CHAT_LIST_VIEWPORT_RESOURCE_ID, {
    timeoutMs: CHAT_ROUTE_TIMEOUT_MS,
    visibleOnly: true,
  });
  await waitForModelWarmupToSettleIfPresent(adbPath, ctx.serial);
}

function assertLoadedChatPrecondition(adbPath, serial) {
  const snapshot = createUiSnapshot(adbPath, serial);
  const noModel = findAnyNodeInSnapshot(snapshot, NO_MODEL_STATE_LABELS, {
    visibleOnly: true,
  });
  const input = findResourceIdInSnapshot(snapshot, "chat-message-input", {
    visibleOnly: true,
  });
  const modelSelector = findResourceIdInSnapshot(snapshot, "chat-header-model-selector", {
    visibleOnly: true,
  });
  if (noModel || !input || !input.enabled || !modelSelector || !modelSelector.enabled) {
    throw new ScenarioPreconditionFailureError(
      "Branch-regeneration requires a prepared conversation with a loaded, selectable local model and an enabled chat input."
    );
  }
}

async function ensureBranchThreadOpen(ctx, threadId) {
  await goToHome(ctx);
  await waitForModelWarmupToSettleIfPresent(resolveAdbPath(), ctx.serial);
  await openConversationByThreadId(ctx, threadId);
  assertLoadedChatPrecondition(resolveAdbPath(), ctx.serial);
}

function extractConversationToken(node) {
  const resourceId = normalizeAndroidResourceId(node.resourceId);
  const messageMatch = resourceId.match(
    /^(user|assistant)-message-state-(complete|streaming|stopped|error)-(.+)$/
  );
  if (messageMatch) {
    return {
      key: `${messageMatch[1]}:${messageMatch[3]}`,
      kind: messageMatch[1],
      state: messageMatch[2],
      id: messageMatch[3],
      resourceId,
    };
  }
  if (resourceId.startsWith("chat-model-switch-row-")) {
    const id = resourceId.slice("chat-model-switch-row-".length);
    return {
      key: `model_switch:${id}`,
      kind: "model_switch",
      state: "complete",
      id,
      resourceId,
    };
  }
  return null;
}

function extractVisibleConversationTokens(snapshot) {
  const tokens = snapshot.nodes
    .filter((node) => (
      Boolean(node.bounds)
      && (!snapshot.viewportBounds || isBoundsInViewport(node.bounds, snapshot.viewportBounds))
    ))
    .map((node) => ({ node, token: extractConversationToken(node) }))
    .filter((entry) => Boolean(entry.token))
    .sort((left, right) => {
      const topDelta = left.node.bounds.top - right.node.bounds.top;
      if (topDelta !== 0) {
        return topDelta;
      }
      return left.node.bounds.left - right.node.bounds.left;
    })
    .map((entry) => entry.token);

  const counts = new Map();
  for (const token of tokens) {
    counts.set(token.key, (counts.get(token.key) || 0) + 1);
  }
  const duplicateKeys = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([key]) => key);
  if (duplicateKeys.length > 0) {
    throw new Error(`Duplicate rendered message ids detected: ${duplicateKeys.join(", ")}.`);
  }
  return tokens;
}

function mergeOlderConversationOrder(olderTokens, currentOrder) {
  if (currentOrder.length === 0) {
    return [...olderTokens];
  }
  const maxOverlap = Math.min(olderTokens.length, currentOrder.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    const olderSuffix = olderTokens.slice(olderTokens.length - overlap);
    const currentPrefix = currentOrder.slice(0, overlap);
    if (olderSuffix.every((token, index) => token.key === currentPrefix[index].key)) {
      return [...olderTokens.slice(0, olderTokens.length - overlap), ...currentOrder];
    }
  }
  return [...olderTokens, ...currentOrder];
}

function buildConversationTopology(order, snapshots) {
  const users = new Map();
  const assistants = new Map();
  const modelSwitches = new Map();
  for (const token of order) {
    const destination = token.kind === "user"
      ? users
      : token.kind === "assistant"
        ? assistants
        : modelSwitches;
    destination.set(token.id, token);
  }

  const userIdsByLength = [...users.keys()].sort((left, right) => right.length - left.length);
  const attachmentResourceIds = new Set();
  const regenerateUserIds = new Set();
  const thoughtAssistantIds = new Set();
  const maxRenderedCounts = new Map();
  for (const snapshot of snapshots) {
    const snapshotCounts = new Map();
    for (const node of snapshot.nodes) {
      const resourceId = normalizeAndroidResourceId(node.resourceId);
      if (!resourceId) {
        continue;
      }
      snapshotCounts.set(resourceId, (snapshotCounts.get(resourceId) || 0) + 1);
      if (/^message-attachment-(?:image|document|audio)-/.test(resourceId)) {
        attachmentResourceIds.add(resourceId);
      } else if (resourceId.startsWith("regenerate-message-")) {
        regenerateUserIds.add(resourceId.slice("regenerate-message-".length));
      } else if (resourceId.startsWith("thought-toggle-")) {
        thoughtAssistantIds.add(resourceId.slice("thought-toggle-".length));
      }
    }
    for (const [resourceId, count] of snapshotCounts) {
      maxRenderedCounts.set(resourceId, Math.max(maxRenderedCounts.get(resourceId) || 0, count));
    }
  }

  const attachmentsByUser = new Map([...users.keys()].map((userId) => [userId, new Map()]));
  const unresolvedAttachments = [];
  for (const resourceId of attachmentResourceIds) {
    const kindMatch = resourceId.match(/^message-attachment-(image|document|audio)-/);
    const kind = kindMatch?.[1] || null;
    const userId = kind
      ? userIdsByLength.find((candidate) => resourceId.startsWith(`message-attachment-${kind}-${candidate}-`))
      : null;
    if (!kind || !userId) {
      unresolvedAttachments.push(resourceId);
      continue;
    }
    const byKind = attachmentsByUser.get(userId);
    if (!byKind.has(kind)) {
      byKind.set(kind, []);
    }
    byKind.get(kind).push(resourceId);
  }

  return {
    order,
    users,
    assistants,
    modelSwitches,
    attachmentsByUser,
    regenerateUserIds,
    thoughtAssistantIds,
    unresolvedAttachments,
    duplicateResourceIds: [...maxRenderedCounts.entries()]
      .filter(([resourceId, count]) => (
        count > 1
        && /^(?:user|assistant)-message-state-|^chat-model-switch-row-/.test(resourceId)
      ))
      .map(([resourceId]) => resourceId),
  };
}

async function scanConversationTopology(ctx, options = {}) {
  const adbPath = resolveAdbPath();
  await ctx.expectResourceId(CHAT_LIST_VIEWPORT_RESOURCE_ID, {
    timeoutMs: CHAT_ROUTE_TIMEOUT_MS,
  });
  const snapshots = [];
  let order = [];
  let swipeCount = 0;
  let reachedHistoryStart = false;
  const scanLimit = options.scanLimit || BRANCH_FIXTURE_SCAN_LIMIT;

  for (let attempt = 0; attempt < scanLimit; attempt += 1) {
    const snapshot = createUiSnapshot(adbPath, ctx.serial);
    snapshots.push(snapshot);
    const visibleTokens = extractVisibleConversationTokens(snapshot);
    order = mergeOlderConversationOrder(visibleTokens, order);
    if (hasConversationHistoryStartAnchor(snapshot)) {
      reachedHistoryStart = true;
      break;
    }
    if (attempt < scanLimit - 1) {
      await ctx.swipeDown();
      swipeCount += 1;
    }
  }

  if (options.restoreBottom !== false) {
    for (let index = 0; index < swipeCount + 1; index += 1) {
      await ctx.swipeUp();
    }
  }
  if (!reachedHistoryStart) {
    throw new ScenarioPreconditionFailureError(
      `Conversation topology scan did not reach chat-history-start-anchor within ${scanLimit} viewports.`
    );
  }
  return buildConversationTopology(order, snapshots);
}

function hasConversationHistoryStartAnchor(snapshot) {
  return Boolean(findResourceIdInSnapshot(snapshot, "chat-history-start-anchor", {
    visibleOnly: true,
  }));
}

function findPrecedingUserToken(order, assistantIndex) {
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    if (order[index].kind === "user") {
      return order[index];
    }
    if (order[index].kind === "assistant") {
      break;
    }
  }
  return null;
}

function findFollowingAssistantToken(order, userIndex) {
  for (let index = userIndex + 1; index < order.length; index += 1) {
    if (order[index].kind === "assistant") {
      return order[index];
    }
    if (order[index].kind === "user") {
      break;
    }
  }
  return null;
}

function createBranchTarget(topology, userToken, assistantToken, attachmentKind = null) {
  if (!userToken || !assistantToken) {
    return null;
  }
  const attachmentResourceIds = attachmentKind
    ? topology.attachmentsByUser.get(userToken.id)?.get(attachmentKind) || []
    : [];
  return {
    userId: userToken.id,
    assistantId: assistantToken.id,
    userState: userToken.state,
    assistantState: assistantToken.state,
    attachmentKind,
    attachmentResourceIds,
  };
}

function resolveBranchFixture(topology, options = {}) {
  if (topology.unresolvedAttachments.length > 0) {
    throw new ScenarioPreconditionFailureError(
      `Prepared attachment ids could not be associated with user turns: ${topology.unresolvedAttachments.join(", ")}.`
    );
  }
  if (topology.order.length === 0) {
    throw new ScenarioPreconditionFailureError("The prepared fixture conversation has no rendered messages.");
  }

  const trailingSwitchIndex = topology.order.length - 1;
  const trailingSwitch = topology.order[trailingSwitchIndex];
  if (trailingSwitch.kind !== "model_switch") {
    throw new ScenarioPreconditionFailureError(
      "The prepared fixture conversation must end with a trailing model-switch marker."
    );
  }
  const mainAssistant = topology.order[trailingSwitchIndex - 1];
  const mainUser = findPrecedingUserToken(topology.order, trailingSwitchIndex - 1);
  if (!mainAssistant || mainAssistant.kind !== "assistant" || !mainUser) {
    throw new ScenarioPreconditionFailureError(
      "The trailing model-switch marker must follow a completed main assistant turn."
    );
  }
  const main = createBranchTarget(topology, mainUser, mainAssistant);

  let reasoning = null;
  for (let index = trailingSwitchIndex - 2; index >= 0; index -= 1) {
    const candidate = topology.order[index];
    if (candidate.kind !== "assistant" || !topology.thoughtAssistantIds.has(candidate.id)) {
      continue;
    }
    reasoning = createBranchTarget(
      topology,
      findPrecedingUserToken(topology.order, index),
      candidate
    );
    if (reasoning) {
      break;
    }
  }

  const findAttachmentTarget = (kind) => {
    for (let index = topology.order.length - 1; index >= 0; index -= 1) {
      const user = topology.order[index];
      if (user.kind !== "user") {
        continue;
      }
      const resourceIds = topology.attachmentsByUser.get(user.id)?.get(kind) || [];
      if (resourceIds.length === 0) {
        continue;
      }
      const assistant = findFollowingAssistantToken(topology.order, index);
      return createBranchTarget(topology, user, assistant, kind);
    }
    return null;
  };

  const targets = {
    main,
    reasoning,
    image: findAttachmentTarget("image"),
    document: findAttachmentTarget("document"),
    audio: findAttachmentTarget("audio"),
  };
  const requiredTargets = ["main", "reasoning", "image", "document"];
  if (options.audioSupported) {
    requiredTargets.push("audio");
  }
  const missingTargets = requiredTargets.filter((kind) => !targets[kind]);
  if (missingTargets.length > 0) {
    throw new ScenarioPreconditionFailureError(
      `Prepared branch-regeneration fixture is missing required turns: ${missingTargets.join(", ")}.`
    );
  }

  for (const kind of requiredTargets) {
    const target = targets[kind];
    if (
      target.userState !== "complete"
      || target.assistantState !== "complete"
      || !topology.regenerateUserIds.has(target.userId)
    ) {
      throw new ScenarioPreconditionFailureError(
        `Prepared ${kind} turn must contain a completed user message, a completed assistant response, and a regeneration action.`
      );
    }
  }

  const indexByUserId = new Map(
    topology.order.map((token, index) => [token.kind === "user" ? token.id : null, index])
      .filter(([id]) => Boolean(id))
  );
  const orderedKinds = [
    ...(options.audioSupported ? ["audio"] : []),
    "document",
    "image",
    "reasoning",
    "main",
  ];
  const targetIndexes = orderedKinds.map((kind) => indexByUserId.get(targets[kind].userId));
  if (targetIndexes.some((index) => !Number.isInteger(index))) {
    throw new ScenarioPreconditionFailureError("Prepared fixture target ordering could not be resolved.");
  }
  for (let index = 1; index < targetIndexes.length; index += 1) {
    if (targetIndexes[index] <= targetIndexes[index - 1]) {
      throw new ScenarioPreconditionFailureError(
        `Prepared fixture order must be ${orderedKinds.join(" -> ")} -> model_switch.`
      );
    }
  }

  assertNoDuplicateMessageIds(topology);
  return {
    targets,
    trailingModelSwitchId: trailingSwitch.id,
  };
}

async function detectAudioAttachmentSupport(ctx) {
  const adbPath = resolveAdbPath();
  const menuButton = await waitForResourceId(adbPath, ctx.serial, ATTACH_MENU_BUTTON_RESOURCE_ID, {
    timeoutMs: 10_000,
    visibleOnly: true,
  });
  if (!menuButton.bounds) {
    throw new ScenarioPreconditionFailureError("The prepared chat attachment menu is not tappable.");
  }
  tapBounds(adbPath, ctx.serial, menuButton.bounds);
  await waitForResourceId(adbPath, ctx.serial, "chat-attachment-menu-sheet", {
    timeoutMs: 10_000,
    visibleOnly: true,
  });
  const snapshot = createUiSnapshot(adbPath, ctx.serial);
  const audioSupported = Boolean(findResourceIdInSnapshot(snapshot, "chat-attach-audio-button", {
    visibleOnly: true,
  }));
  await ctx.pressBack();
  await waitForNoResourceId(adbPath, ctx.serial, "chat-attachment-menu-sheet", {
    timeoutMs: 10_000,
  });
  return audioSupported;
}

async function findChatResourceWithScroll(ctx, resourceId, options = {}) {
  const adbPath = resolveAdbPath();
  const findNow = () => findResourceIdInSnapshot(
    createUiSnapshot(adbPath, ctx.serial),
    resourceId,
    { visibleOnly: true }
  );
  let node = findNow();
  if (node) {
    return node;
  }

  const maxSwipes = options.maxSwipes ?? BRANCH_FIXTURE_SCAN_LIMIT;
  for (let attempt = 0; attempt < maxSwipes; attempt += 1) {
    await ctx.swipeDown();
    node = findNow();
    if (node) {
      return node;
    }
  }
  for (let attempt = 0; attempt < maxSwipes; attempt += 1) {
    await ctx.swipeUp();
    node = findNow();
    if (node) {
      return node;
    }
  }
  throw new Error(
    withUiSummary(adbPath, ctx.serial, `Could not find chat resource id "${resourceId}" while scanning the conversation.`)
  );
}

async function tapVisibleResource(ctx, resourceId, options = {}) {
  const adbPath = resolveAdbPath();
  let node;
  if (options.allowScroll) {
    const maxSwipes = options.maxSwipes ?? 12;
    for (let attempt = 0; attempt <= maxSwipes; attempt += 1) {
      const snapshot = createUiSnapshot(adbPath, ctx.serial);
      node = findResourceIdInSnapshot(snapshot, resourceId, { visibleOnly: true });
      if (node) {
        break;
      }
      if (attempt < maxSwipes) {
        await ctx.swipeUp();
      }
    }
  } else {
    node = await waitForResourceId(adbPath, ctx.serial, resourceId, {
      timeoutMs: options.timeoutMs ?? 15_000,
      visibleOnly: true,
    });
  }
  if (!node?.bounds || !node.enabled) {
    throw new Error(`Resource id "${resourceId}" is not enabled and tappable.`);
  }
  tapBounds(adbPath, ctx.serial, node.bounds);
  await delay(options.afterTapDelayMs ?? 250);
}

async function startBranchRegeneration(ctx, target) {
  const regenerateResourceId = `regenerate-message-${target.userId}`;
  const regenerateButton = await findChatResourceWithScroll(ctx, regenerateResourceId);
  if (!regenerateButton.bounds || !regenerateButton.enabled) {
    throw new Error(`Regeneration action for user message ${target.userId} is not enabled.`);
  }
  tapBounds(resolveAdbPath(), ctx.serial, regenerateButton.bounds);
  await waitForResourceId(resolveAdbPath(), ctx.serial, "chat-regeneration-mode", {
    timeoutMs: 15_000,
    visibleOnly: true,
  });
  await tapVisibleResource(ctx, "chat-primary-action-send", {
    timeoutMs: 15_000,
    afterTapDelayMs: 0,
  });
}

function findVisibleAssistantTokens(snapshot) {
  return findResourcePrefixNodesInSnapshot(snapshot, "assistant-message-state-", {
    visibleOnly: true,
  })
    .map(extractConversationToken)
    .filter(Boolean);
}

function hasAssistantPartialSurface(snapshot, assistantId) {
  const content = findResourceIdInSnapshot(snapshot, `assistant-message-content-${assistantId}`, {
    visibleOnly: true,
  });
  if (content && `${content.text || content.contentDesc || ""}`.trim()) {
    return "content";
  }
  const thought = findResourceIdInSnapshot(snapshot, `thought-toggle-${assistantId}`, {
    visibleOnly: true,
  });
  return thought ? "thought" : null;
}

function resolveAndroidQaGenerationGateObservation(snapshot, options) {
  const phase = options.phase;
  const markerPrefix = `chat-qa-generation-gate-${phase}-`;
  const markerNodes = findResourcePrefixNodesInSnapshot(snapshot, markerPrefix, {
    visibleOnly: true,
  });
  if (markerNodes.length === 0) {
    return null;
  }
  if (markerNodes.length !== 1) {
    throw new ScenarioPreconditionFailureError(
      `Expected one active ${phase} QA gate marker, observed ${markerNodes.length}.`
    );
  }
  const markerResourceId = normalizeAndroidResourceId(markerNodes[0].resourceId);
  const assistantId = markerResourceId.slice(markerPrefix.length);
  if (!assistantId || options.baselineAssistantIds.has(assistantId)) {
    throw new ScenarioPreconditionFailureError(
      `The ${phase} QA gate is not tied to a new branch assistant.`
    );
  }

  const assistant = findVisibleAssistantTokens(snapshot).find((token) => token.id === assistantId);
  const stopButton = findResourceIdInSnapshot(snapshot, "chat-primary-action-stop", {
    visibleOnly: true,
  });
  if (!assistant || assistant.state !== "streaming" || !stopButton?.bounds || !stopButton.enabled) {
    return null;
  }

  const surface = hasAssistantPartialSurface(snapshot, assistantId);
  if (phase === "before-first-output" && surface) {
    throw new ScenarioPreconditionFailureError(
      `Assistant ${assistantId} exposed ${surface} while the before-first-output QA gate was active.`
    );
  }
  if (phase === "after-first-durable-output" && !surface) {
    return null;
  }

  return {
    assistantId,
    markerResourceId,
    observedAt: new Date().toISOString(),
    phase,
    snapshot,
    stopBounds: stopButton.bounds,
    surface,
  };
}

async function armAndroidQaGenerationGate(ctx, phase) {
  const resourceId = `chat-qa-arm-${phase}`;
  try {
    await tapVisibleResource(ctx, resourceId, {
      timeoutMs: 10_000,
      afterTapDelayMs: 0,
    });
    await waitForResourceId(
      resolveAdbPath(),
      ctx.serial,
      `chat-qa-generation-armed-${phase}`,
      { timeoutMs: 10_000, visibleOnly: true }
    );
  } catch (error) {
    throw new ScenarioPreconditionFailureError(
      `The installed APK does not expose the required ${phase} Android QA generation gate: ${error.message}`
    );
  }
}

function persistBranchObservationSnapshot(label, snapshot) {
  const evidenceRoot = path.join(artifactsRoot, BRANCH_EVIDENCE_DIRECTORY);
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const uiDumpPath = path.join(
    evidenceRoot,
    `${sanitizeArtifactStem(label)}-observation.xml`
  );
  fs.writeFileSync(uiDumpPath, snapshot.xml);
  return uiDumpPath;
}

async function interruptObservedBranchGeneration(ctx, options) {
  const adbPath = resolveAdbPath();
  const { match, snapshot } = await waitForSnapshotMatch(
    adbPath,
    ctx.serial,
    {
      timeoutMs: options.timeoutMs
        ?? (options.phase === "after-first-durable-output" ? BRANCH_PARTIAL_TIMEOUT_MS : 30_000),
      pollIntervalMs: 200,
    },
    (candidateSnapshot) => resolveAndroidQaGenerationGateObservation(candidateSnapshot, options)
  );
  if (!match) {
    throw new ScenarioPreconditionFailureError(
      withUiSnapshotSummary(
        snapshot,
        `The required ${options.phase} Android QA generation gate was not observed.`
      )
    );
  }

  if (options.mode === "force-stop") {
    forceStopScenarioApp(adbPath, ctx.serial);
  } else if (options.mode === "tap-stop") {
    tapBounds(adbPath, ctx.serial, match.stopBounds);
  } else {
    throw new Error(`Unsupported branch interruption mode ${options.mode}.`);
  }

  const uiDumpPath = persistBranchObservationSnapshot(
    options.evidenceLabel,
    match.snapshot
  );
  if (options.mode === "tap-stop") {
    await delay(250);
  }
  return {
    assistantId: match.assistantId,
    interruptedAt: new Date().toISOString(),
    markerResourceId: match.markerResourceId,
    uiDumpPath,
    observedAt: match.observedAt,
    phase: match.phase,
    surface: match.surface,
  };
}

async function disableReasoningForAuthoritativeClear(ctx) {
  const adbPath = resolveAdbPath();
  try {
    await tapVisibleResource(ctx, "chat-header-model-controls", {
      timeoutMs: 10_000,
    });
    await waitForResourceId(adbPath, ctx.serial, "model-parameters-sheet", {
      timeoutMs: 10_000,
      visibleOnly: true,
    });
    const reasoningOff = await waitForResourceId(adbPath, ctx.serial, "reasoning-effort-off", {
      timeoutMs: 10_000,
      visibleOnly: true,
    });
    if (!reasoningOff.enabled || !reasoningOff.bounds) {
      throw new Error("reasoning-effort-off is disabled or not tappable");
    }
    if (!reasoningOff.selected) {
      tapBounds(adbPath, ctx.serial, reasoningOff.bounds);
      const { match, snapshot } = await waitForSnapshotMatch(
        adbPath,
        ctx.serial,
        { timeoutMs: 10_000, pollIntervalMs: 250 },
        (candidateSnapshot) => {
          const candidate = findResourceIdInSnapshot(
            candidateSnapshot,
            "reasoning-effort-off",
            { visibleOnly: true }
          );
          return candidate?.selected ? candidate : null;
        }
      );
      if (!match) {
        throw new Error(withUiSnapshotSummary(snapshot, "Reasoning-off selection did not settle."));
      }
    }
    await tapVisibleResource(ctx, "model-parameters-sheet-close-button", {
      timeoutMs: 10_000,
    });
    await waitForNoResourceId(adbPath, ctx.serial, "model-parameters-sheet", {
      timeoutMs: 10_000,
    });
    return { reasoningEffort: "off", verifiedSelected: true };
  } catch (error) {
    throw new ScenarioPreconditionFailureError(
      `Reasoning authoritative-clear requires an optional reasoning-off control: ${error.message}`
    );
  }
}

function createBranchRegenerationBaseline(topology, targetUserId) {
  const targetUserIndex = topology.order.findIndex(
    (token) => token.kind === "user" && token.id === targetUserId
  );
  if (targetUserIndex < 0) {
    throw new ScenarioPreconditionFailureError(
      `Branch-regeneration target user ${targetUserId} is missing from the pre-operation topology.`
    );
  }

  const previousAssistant = topology.order[targetUserIndex + 1];
  if (!previousAssistant || previousAssistant.kind !== "assistant") {
    throw new ScenarioPreconditionFailureError(
      `Branch-regeneration target user ${targetUserId} has no directly adjacent assistant before regeneration.`
    );
  }

  return {
    targetUserId,
    previousAssistantId: previousAssistant.id,
    assistantIds: new Set(topology.assistants.keys()),
  };
}

function resolveBranchRegenerationReplacement(topology, baseline) {
  const targetUserIndex = topology.order.findIndex(
    (token) => token.kind === "user" && token.id === baseline.targetUserId
  );
  if (targetUserIndex < 0) {
    throw new Error(
      `Branch-regeneration target user ${baseline.targetUserId} disappeared after regeneration.`
    );
  }

  const replacement = topology.order[targetUserIndex + 1];
  if (!replacement || replacement.kind !== "assistant") {
    throw new Error(
      `Branch regeneration did not create an assistant directly adjacent to target user ${baseline.targetUserId}.`
    );
  }
  if (baseline.assistantIds.has(replacement.id)) {
    throw new Error(
      `Branch regeneration reused pre-operation assistant ${replacement.id} for target user ${baseline.targetUserId}.`
    );
  }
  if (replacement.state !== "complete") {
    throw new Error(
      `Branch-regeneration assistant ${replacement.id} ended in ${replacement.state} instead of complete.`
    );
  }

  assertMessageIdAbsent(topology, baseline.previousAssistantId);
  return replacement;
}

function assertAuthoritativeThoughtClear({
  beforeTopology,
  topology,
  baseline,
  replacementAssistantId,
}) {
  if (!beforeTopology.thoughtAssistantIds.has(baseline.previousAssistantId)) {
    throw new ScenarioPreconditionFailureError(
      `Reasoning-clear target assistant ${baseline.previousAssistantId} has no thought surface before regeneration.`
    );
  }

  const replacement = resolveBranchRegenerationReplacement(topology, baseline);
  if (replacement.id !== replacementAssistantId) {
    throw new Error(
      `Expected authoritative reasoning assistant ${replacementAssistantId}, observed ${replacement.id}.`
    );
  }
  if (topology.thoughtAssistantIds.has(replacementAssistantId)) {
    throw new Error(
      `Authoritative reasoning assistant ${replacementAssistantId} still exposes thought content after clear.`
    );
  }

  return {
    replacedThoughtAbsent: !topology.thoughtAssistantIds.has(baseline.previousAssistantId),
    replacementThoughtAbsent: !topology.thoughtAssistantIds.has(replacementAssistantId),
  };
}

async function completeBranchRegeneration(ctx, target) {
  const beforeTopology = await scanConversationTopology(ctx);
  const baseline = createBranchRegenerationBaseline(beforeTopology, target.userId);
  await startBranchRegeneration(ctx, target);
  await waitForRegenerationModeToClose(ctx, {
    timeoutMs: BRANCH_GENERATION_TIMEOUT_MS,
  });
  const topology = await scanConversationTopology(ctx);
  const replacement = resolveBranchRegenerationReplacement(topology, baseline);
  return {
    assistantId: replacement.id,
    baseline,
    beforeTopology,
    topology,
  };
}

async function waitForRegenerationModeToClose(ctx, options = {}) {
  const adbPath = resolveAdbPath();
  const { match, snapshot } = await waitForSnapshotMatch(
    adbPath,
    ctx.serial,
    { timeoutMs: options.timeoutMs ?? 30_000, pollIntervalMs: 500 },
    (candidateSnapshot) => {
      const mode = findResourceIdInSnapshot(candidateSnapshot, "chat-regeneration-mode", {
        visibleOnly: true,
      });
      const send = findResourceIdInSnapshot(candidateSnapshot, "chat-primary-action-send", {
        visibleOnly: true,
      });
      return !mode && send ? { settled: true } : null;
    }
  );
  if (!match) {
    throw new Error(withUiSnapshotSummary(snapshot, "Regeneration mode did not settle back to the composer."));
  }
}

async function waitForExactAssistantState(ctx, assistantId, state) {
  const resourceId = `assistant-message-state-${state}-${assistantId}`;
  await waitForResourceId(resolveAdbPath(), ctx.serial, resourceId, {
    timeoutMs: 30_000,
    visibleOnly: true,
  });
}

function forceStopScenarioApp(adbPath, serial) {
  runChecked(adbPath, ["-s", serial, "shell", "am", "force-stop", appPackageName]);
  sleepSync(500);
  const pid = runCapture(adbPath, ["-s", serial, "shell", "pidof", appPackageName], {
    allowFailure: true,
  }).trim();
  if (pid) {
    throw new Error(`App process is still running after force-stop (${pid}).`);
  }
}

async function relaunchScenarioApp(ctx) {
  const adbPath = resolveAdbPath();
  runChecked(adbPath, [
    "-s",
    ctx.serial,
    "shell",
    "monkey",
    "-p",
    appPackageName,
    "-c",
    "android.intent.category.LAUNCHER",
    "1",
  ]);
  await ctx.ensureAppVisible();
  await ctx.dismissDebuggerBanner();
  await waitForModelWarmupToSettleIfPresent(adbPath, ctx.serial);
}

async function relaunchScenarioAppAndOpenThread(ctx, threadId) {
  await relaunchScenarioApp(ctx);
  await ensureBranchThreadOpen(ctx, threadId);
}

function assertAssistantState(topology, assistantId, expectedState) {
  const assistant = assistantId ? topology.assistants.get(assistantId) : null;
  if (!assistant || assistant.state !== expectedState) {
    throw new Error(
      `Expected assistant ${assistantId} in state ${expectedState}, observed ${assistant?.state || "absent"}.`
    );
  }
}

function assertMessageIdAbsent(topology, messageId) {
  if (!messageId) {
    return;
  }
  if (
    topology.users.has(messageId)
    || topology.assistants.has(messageId)
    || topology.modelSwitches.has(messageId)
    || topology.thoughtAssistantIds.has(messageId)
  ) {
    throw new Error(`Replaced message ${messageId} is still present in the conversation.`);
  }
}

function assertNoDuplicateMessageIds(topology) {
  if (topology.duplicateResourceIds.length > 0) {
    throw new Error(
      `Duplicate message resources are visible: ${topology.duplicateResourceIds.join(", ")}.`
    );
  }
  const keys = topology.order.map((token) => token.key);
  const duplicateKeys = keys.filter((key, index) => keys.indexOf(key) !== index);
  if (duplicateKeys.length > 0) {
    throw new Error(`Duplicate message ids are present in conversation order: ${[...new Set(duplicateKeys)].join(", ")}.`);
  }
}

function assertTrailingModelSwitchTopology(topology, mainTarget, modelSwitchId) {
  const switchIndex = topology.order.findIndex(
    (token) => token.kind === "model_switch" && token.id === modelSwitchId
  );
  if (switchIndex !== topology.order.length - 1) {
    throw new Error(`Model-switch ${modelSwitchId} is not the trailing conversation item.`);
  }
  const assistant = topology.order[switchIndex - 1];
  const user = findPrecedingUserToken(topology.order, switchIndex - 1);
  if (
    assistant?.kind !== "assistant"
    || assistant.id !== mainTarget.assistantId
    || assistant.state !== "complete"
    || user?.id !== mainTarget.userId
  ) {
    throw new Error("The original main assistant branch before the trailing model-switch is not intact.");
  }
}

function assertTargetAttachment(topology, target, kind) {
  const resourceIds = topology.attachmentsByUser.get(target.userId)?.get(kind) || [];
  if (resourceIds.length === 0) {
    throw new Error(`Prepared ${kind} attachment disappeared from user message ${target.userId}.`);
  }
  const expected = target.attachmentResourceIds || [];
  if (expected.length > 0 && !expected.every((resourceId) => resourceIds.includes(resourceId))) {
    throw new Error(`Prepared ${kind} attachment identity changed during branch regeneration.`);
  }
}

function resolveTargetAttachmentIds(target, kind) {
  const prefix = `message-attachment-${kind}-${target.userId}-`;
  const attachmentIds = (target.attachmentResourceIds || []).map((resourceId) => {
    if (!resourceId.startsWith(prefix) || resourceId.length === prefix.length) {
      throw new ScenarioPreconditionFailureError(
        `Prepared ${kind} attachment resource ${resourceId} does not encode a stable attachment identity.`
      );
    }
    return resourceId.slice(prefix.length);
  });
  if (attachmentIds.length === 0) {
    throw new ScenarioPreconditionFailureError(
      `Prepared ${kind} target ${target.userId} has no attachment identities.`
    );
  }
  return attachmentIds;
}

function assertPreparedAttachmentGenerationEvidence(snapshot, target, assistantId, kind) {
  const generationResourceId = `chat-prepared-generation-${target.userId}-${assistantId}`;
  if (!findResourceIdInSnapshot(snapshot, generationResourceId, { visibleOnly: true })) {
    throw new ScenarioPreconditionFailureError(
      `Prepared-generation evidence for user ${target.userId} and assistant ${assistantId} is absent or stale.`
    );
  }

  const attachmentIds = resolveTargetAttachmentIds(target, kind);
  const evidencePrefix = `chat-prepared-attachment-${assistantId}-`;
  const expectedMarkers = attachmentIds
    .map((attachmentId) => `${kind}-${attachmentId}`)
    .sort((left, right) => left.localeCompare(right));
  const observedMarkers = [...new Set(
    findResourcePrefixNodesInSnapshot(snapshot, evidencePrefix, { visibleOnly: true })
      .map((node) => normalizeAndroidResourceId(node.resourceId).slice(evidencePrefix.length))
      .filter(Boolean)
  )].sort((left, right) => left.localeCompare(right));
  if (!areExactStringArraysEqual(observedMarkers, expectedMarkers)) {
    throw new ScenarioPreconditionFailureError(
      `Final prepared request for assistant ${assistantId} has non-exact attachment evidence; expected ${expectedMarkers.join(", ")}, observed ${observedMarkers.join(", ") || "none"}.`
    );
  }
  return attachmentIds;
}

async function assertTargetAttachmentVisible(ctx, target, kind) {
  const resourceId = target.attachmentResourceIds?.[0];
  if (!resourceId) {
    throw new ScenarioPreconditionFailureError(
      `Prepared ${kind} target has no stable attachment resource id.`
    );
  }
  await findChatResourceWithScroll(ctx, resourceId);
}

async function confirmAndroidDialog(ctx) {
  const button = await waitForResourceId(
    resolveAdbPath(),
    ctx.serial,
    ANDROID_DIALOG_POSITIVE_BUTTON_RESOURCE_ID,
    { timeoutMs: 10_000, visibleOnly: true }
  );
  if (!button.bounds || !button.enabled) {
    throw new Error("Android confirmation dialog is not enabled and tappable.");
  }
  tapBounds(resolveAdbPath(), ctx.serial, button.bounds);
  await delay(500);
}

async function tapConversationDelete(ctx, threadId) {
  const adbPath = resolveAdbPath();
  const deleteResourceId = `delete-conversation-${threadId}`;
  const button = await waitForResourceId(adbPath, ctx.serial, deleteResourceId, {
    timeoutMs: HOME_ROUTE_TIMEOUT_MS,
    visibleOnly: true,
  });
  if (!button.bounds || !button.enabled) {
    throw new Error(`Delete control for conversation ${threadId} is not enabled and tappable.`);
  }
  tapBounds(adbPath, ctx.serial, button.bounds);
  const snapshot = createUiSnapshot(adbPath, ctx.serial);
  const resourceConfirm = findResourceIdInSnapshot(
    snapshot,
    ANDROID_DIALOG_POSITIVE_BUTTON_RESOURCE_ID,
    { visibleOnly: true }
  );
  if (resourceConfirm) {
    await confirmAndroidDialog(ctx);
    return;
  }
  await ctx.tapAnyText(DELETE_LABELS, { timeoutMs: 10_000 });
}

async function assertRecentConversationAbsent(ctx, threadId) {
  const resourceId = `recent-conversation-${threadId}`;
  await waitForNoResourceId(resolveAdbPath(), ctx.serial, resourceId, {
    timeoutMs: 15_000,
  });
}

function selectScenarios(scenarios, options) {
  if (options.scenario) {
    return scenarios.filter((scenario) => scenario.id === options.scenario);
  }

  const requestedPack = options.pack || DEFAULT_SCENARIO_PACK;
  if (requestedPack === "all") {
    // Prepared scenarios depend on in-memory app state set up manually by the tester, so keep
    // them out of broad automated packs. They remain available by direct id or pack name.
    const explicitStateMutationScenarioIds = new Set([
      ...PREPARED_ATTACHMENT_SCENARIOS,
      ...PREPARED_ATTACHMENT_SEND_SCENARIOS,
      ...STORAGE_SCENARIOS,
      ...BRANCH_REGENERATION_SCENARIOS,
    ]);
    return scenarios.filter((scenario) => !explicitStateMutationScenarioIds.has(scenario.id));
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

async function goToHome(ctx, options = {}) {
  await ctx.ensureAppVisible();
  await ctx.dismissDebuggerBanner();

  const resolveAdb = options.resolveAdbPath || resolveAdbPath;
  const findNodeNow = options.findAnyNodeNow || findAnyNodeNow;
  const reachHome = options.tryReachHome || tryReachHome;
  const adbPath = resolveAdb();
  const homeVisibleNow = await findNodeNow(adbPath, ctx.serial, HOME_SECTION_LABELS, {
    visibleOnly: true,
  });

  if (homeVisibleNow) {
    await ctx.expectAnyText(APP_TITLE_LABELS, { timeoutMs: 5_000 });
    return;
  }

  try {
    await ctx.expectAnyText(HOME_SECTION_LABELS, { timeoutMs: 8_000 });
  } catch {
    const reachedHome = await reachHome(ctx);

    if (!reachedHome) {
      const finalHomeVisible = await findNodeNow(adbPath, ctx.serial, HOME_SECTION_LABELS, {
        visibleOnly: true,
      });
      if (finalHomeVisible) {
        return;
      }

      throw new Error(withUiSummary(adbPath, ctx.serial, "Timed out returning to Home from the current route."));
    }

    await ctx.expectAnyText(HOME_SECTION_LABELS, { timeoutMs: 15_000 });
  }

  await ctx.expectAnyText(APP_TITLE_LABELS);
}

async function ensureLoadedModelTextFallbackPrecondition(ctx) {
  await goToHome(ctx);

  const adbPath = resolveAdbPath();
  await waitForModelWarmupToSettleIfPresent(adbPath, ctx.serial);
  const noModelNode = await findAnyNodeNow(
    adbPath,
    ctx.serial,
    NO_MODEL_STATE_LABELS,
    { visibleOnly: true }
  );

  if (noModelNode) {
    throw new ScenarioSkipError(
      "Loaded text-only attachment fallback smoke requires an already loaded text-only model or a loaded vision model with missing/failed/ambiguous projector state. The no-model fallback is covered separately and is not sufficient for this vision gate."
    );
  }
}

async function sendTextOnlyFallbackSmokeMessage(ctx, adbPath, prompt) {
  await ctx.tapAnyText(CHAT_INPUT_LABELS, {
    allowBottomOverlay: true,
    timeoutMs: 5_000,
  });
  await inputFocusedTextAndConfirm(adbPath, ctx.serial, prompt);
  await waitForEnabledAnyNode(
    adbPath,
    ctx.serial,
    CHAT_SEND_LABELS,
    { timeoutMs: ENABLED_ACTION_SETTLE_TIMEOUT_MS }
  );

  await ctx.tapAnyText(CHAT_SEND_LABELS, {
    allowBottomOverlay: true,
    timeoutMs: 5_000,
    afterTapDelayMs: 1_000,
  });
  await waitForTextOnlyFallbackSentMessage(adbPath, ctx.serial, prompt, {
    timeoutMs: 10_000,
  }).then((sentMessageNode) => waitForTextOnlyFallbackAssistantResponse(adbPath, ctx.serial, sentMessageNode, prompt, {
    timeoutMs: 45_000,
  }));
}

async function waitForTextOnlyFallbackSentMessage(adbPath, serial, prompt, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = createUiSnapshot(adbPath, serial);
    const sentMessageNode = findTextOnlySentMessageNode(snapshot, prompt);
    if (sentMessageNode && !findPromptInComposerInputNode(snapshot, prompt)) {
      return sentMessageNode;
    }

    await delay(500);
  }

  throw new Error(
    withUiSummary(
      adbPath,
      serial,
      `Timed out waiting for text-only fallback prompt "${prompt}" to appear as a sent chat message with the composer cleared.`
    )
  );
}

function findTextOnlySentMessageNode(snapshot, prompt) {
  return findMatchingNodes(snapshot, prompt, { visibleOnly: true })
    .find((node) => !isComposerInputNode(node) && node.clickable !== true) ?? null;
}

async function waitForTextOnlyFallbackAssistantResponse(adbPath, serial, sentMessageNode, prompt, options = {}) {
  const timeoutMs = options.timeoutMs ?? 45_000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = createUiSnapshot(adbPath, serial);
    const responseNode = findTextOnlyFallbackAssistantResponseNode(snapshot, sentMessageNode, prompt);
    if (responseNode) {
      return responseNode;
    }

    await delay(800);
  }

  throw new Error(
    withUiSummary(
      adbPath,
      serial,
      `Timed out waiting for a non-empty assistant response after text-only fallback prompt "${prompt}".`
    )
  );
}

function findTextOnlyFallbackAssistantResponseNode(snapshot, sentMessageNode, prompt) {
  const sentBottom = sentMessageNode?.bounds?.bottom ?? 0;
  const viewportBottom = snapshot.viewportBounds?.bottom ?? Number.POSITIVE_INFINITY;

  return snapshot.nodes.find((node) => {
    if (!node.bounds || node.bounds.top <= sentBottom) {
      return false;
    }

    if (node.bounds.top > viewportBottom - DEFAULT_TAP_SAFE_BOTTOM_INSET_MIN_PX) {
      return false;
    }

    if (!isPreparedAssistantResponseCandidateNode(node)) {
      return false;
    }

    const hasResponseLabel = isPreparedAssistantResponseLabel(node.text, prompt)
      || isPreparedAssistantResponseLabel(node.contentDesc, prompt);
    return hasResponseLabel && isInsidePreparedAssistantResponseContent(snapshot, node, sentBottom);
  }) ?? null;
}

function findPromptInComposerInputNode(snapshot, prompt) {
  return findMatchingNodes(snapshot, prompt, { visibleOnly: true })
    .find(isComposerInputNode) ?? null;
}

function isComposerInputNode(node) {
  const contentDescription = normalizeUiLabel(node?.contentDesc);
  return CHAT_INPUT_LABELS.some((label) => contentDescription.includes(normalizeUiLabel(label)));
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
      const modelCatalogVisible = await findAnyNodeNow(adbPath, ctx.serial, MODEL_CATALOG_LABELS, {
        visibleOnly: true,
      });
      await ctx.tapBottomTab(HOME_TAB_LABELS, {
        afterTapDelayMs: modelCatalogVisible
          ? MODEL_CATALOG_EXIT_QUIET_DELAY_MS
          : BOTTOM_TAB_ACTION_QUIET_DELAY_MS,
      });
      continue;
    }

    if (attempt < maxAttempts - 1) {
      await ctx.pressBack();
      await ctx.dismissDebuggerBanner();
    }
  }

  return false;
}

async function goToSettings(ctx, options = {}) {
  const goHome = options.goToHome || goToHome;
  const waitForWarmup = options.waitForModelWarmup || (async (targetCtx) => {
    await waitForModelWarmupToSettleIfPresent(resolveAdbPath(), targetCtx.serial);
  });

  await goHome(ctx);
  await waitForWarmup(ctx);
  await tapBottomTabUntilVisible(ctx, SETTINGS_TAB_LABELS, SETTINGS_TITLE_LABELS, {
    timeoutMs: SETTINGS_ROUTE_TIMEOUT_MS,
  });
}

async function goToModelCatalog(ctx, options = {}) {
  const goHome = options.goToHome || goToHome;
  const waitForWarmup = options.waitForModelWarmup || (async (targetCtx) => {
    await waitForModelWarmupToSettleIfPresent(resolveAdbPath(), targetCtx.serial);
  });

  await goHome(ctx);
  await waitForWarmup(ctx);
  await tapBottomTabUntilVisible(ctx, MODELS_TAB_LABELS, MODEL_CATALOG_LABELS);
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

  await tapBottomTabUntilVisible(ctx, HOME_TAB_LABELS, restoredHomeLabel, {
    timeoutMs: 10_000,
  });
}

async function goToConversationManagement(ctx) {
  await goToHome(ctx);
  await ctx.tapAnyText(MANAGE_CONVERSATIONS_LABELS);
  await ctx.expectAnyText(CONVERSATIONS_TITLE_LABELS);
}

async function prepareCatalogForMemoryFitRiskBadgeScenario(ctx) {
  const adbPath = resolveAdbPath();
  await setCatalogFilterPanelOpen(adbPath, ctx.serial, true);
  await clearCatalogFiltersIfPresent(adbPath, ctx.serial);
  await ctx.expectAnyText(MODEL_CATALOG_LABELS);
}

async function prepareCatalogForVariantPickerSmokeScenario(ctx, options = {}) {
  const resolveAdb = options.resolveAdbPath || resolveAdbPath;
  const findNodeNow = options.findAnyNodeNow || findAnyNodeNow;
  const setFilterPanelOpen = options.setCatalogFilterPanelOpen || setCatalogFilterPanelOpen;
  const clearFilters = options.clearCatalogFiltersIfPresent || clearCatalogFiltersIfPresent;
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

  await setFilterPanelOpen(adbPath, ctx.serial, true);
  await clearFilters(adbPath, ctx.serial);

  await ctx.expectAnyText(MODEL_CATALOG_LABELS, { timeoutMs: 8_000 });
}

async function openFirstVisibleVariantPicker(ctx, options = {}) {
  const resolveAdb = options.resolveAdbPath || resolveAdbPath;
  const createSnapshot = options.createUiSnapshot || createUiSnapshot;
  const findNodeNow = options.findAnyNodeNow || findAnyNodeNow;
  const waitForAny = options.waitForAnyNode || waitForAnyNode;
  const tap = options.tapBounds || tapBounds;
  const waitAfterTapTimeoutMs = options.waitAfterTapTimeoutMs ?? 5_000;
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
    swipeUp: ctx.swipeUp,
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
  const timeoutMs = options.timeoutMs ?? 45_000;
  const pollIntervalMs = options.pollIntervalMs ?? 600;
  const wait = options.delayFn || delay;
  const swipeUp = options.swipeUp;
  const startedAt = Date.now();
  let lastState = "waiting for catalog content";
  let scanSwipes = 0;

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
    if (!loading && typeof swipeUp === "function" && scanSwipes < 8) {
      await swipeUp();
      scanSwipes += 1;
    }
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
  const hasStableVariantSelectorId = typeof node.resourceId === "string"
    && node.resourceId.includes("model-variant-selector-");
  if (hasStableVariantSelectorId) {
    return true;
  }

  const normalizedLabel = normalizeUiLabel(`${node.text || ""} ${node.contentDesc || ""}`);
  const hasQuantizationValue = /\b(?:(?:i?q|tq)\d(?:_[a-z0-9]+){0,3}|bf16|f16|fp16)\b/.test(normalizedLabel);
  const hasSizeContext = normalizedLabel.includes(" gb")
    || normalizedLabel.includes("unknown")
    || normalizedLabel.includes("неизвестно");
  return hasQuantizationValue && hasSizeContext;
}

async function prepareCatalogForRamWarningScenario(ctx) {
  const adbPath = resolveAdbPath();
  await setCatalogFilterPanelOpen(adbPath, ctx.serial, true);
  await clearCatalogFiltersIfPresent(adbPath, ctx.serial);
  // Clearing persisted filters (especially "Fits in RAM") exposes the live catalog's real risk
  // cards. The scenario does not need to mutate another toggle before validating the warning.
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

function seedPrivateStorageCacheSentinel(adbPath, serial) {
  runChecked(adbPath, [
    "-s",
    serial,
    "shell",
    "run-as",
    appPackageName,
    "mkdir",
    "-p",
    STORAGE_CACHE_QA_DIRECTORY,
  ], { stdio: "ignore" });
  runChecked(adbPath, [
    "-s",
    serial,
    "shell",
    "run-as",
    appPackageName,
    "dd",
    "if=/dev/zero",
    `of=${STORAGE_CACHE_QA_SENTINEL}`,
    "bs=1024",
    "count=64",
  ], { stdio: "ignore" });
}

function appPrivatePathExists(adbPath, serial, relativePath, options = {}) {
  const runSpawnSync = options.spawnSync ?? spawnSync;
  const result = runSpawnSync(adbPath, [
    "-s",
    serial,
    "shell",
    "run-as",
    appPackageName,
    "ls",
    "-d",
    relativePath,
  ], {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeout ?? ADB_COMMAND_TIMEOUT_MS,
  });

  if (result.error) {
    throw new Error(
      `Could not verify private path ${relativePath}: ${result.error.message || String(result.error)}`
    );
  }

  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  if (result.status === 0) {
    if (stdout.split(/\r?\n/u).some((line) => line.trim() === relativePath)) {
      return true;
    }
    throw new Error(`Could not verify private path ${relativePath}: adb returned an unexpected response.`);
  }

  const failureOutput = `${stdout}\n${stderr}`.trim();
  if (/no such file or directory|cannot access .+: no such file/iu.test(failureOutput)) {
    return false;
  }

  throw new Error(
    `Could not verify private path ${relativePath}: ${failureOutput || `adb exited with status ${result.status}`}`
  );
}

function shouldPrepareMetroForScenarioLaunch(env = process.env) {
  const apkVariant = (env.ANDROID_SMOKE_APK_VARIANT ?? "debug").trim().toLowerCase();
  return env.ANDROID_SMOKE_SKIP_METRO !== "1" && apkVariant !== "release";
}

function launchApp(resolvedSerial, metroPort) {
  const args = buildSmokeLaunchArgs({
    ...cliOptions,
    port: metroPort === null || metroPort === undefined
      ? cliOptions.port
      : String(metroPort),
  }, resolvedSerial);

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

function cleanupScenarioOwnedMetro(metro, options = {}) {
  if (!metro?.started) {
    return;
  }

  metro.removeSignalHandlers?.();
  if (!metro.lifecycle) {
    throw new Error("Scenario-owned Metro is missing its process lifecycle.");
  }

  const stopMetro = options.stopOwnedMetroProcessOrThrow ?? stopOwnedMetroProcessOrThrow;
  stopMetro(metro.lifecycle);
}

function installScenarioResourceSignalHandlers(
  getResources,
  processRef = process,
  options = {}
) {
  let isHandlingSignal = false;
  let cleanedLogcatCollector = null;
  let cleanedMetro = null;
  const cleanupLogcat = options.cleanupAndroidLogcatCollector
    ?? cleanupAndroidLogcatCollector;
  const cleanupMetro = options.cleanupScenarioOwnedMetro
    ?? cleanupScenarioOwnedMetro;
  const add = () => {
    processRef.once("SIGINT", onSigint);
    processRef.once("SIGTERM", onSigterm);
  };
  const remove = () => {
    processRef.removeListener("SIGINT", onSigint);
    processRef.removeListener("SIGTERM", onSigterm);
  };
  const handle = (signal) => {
    if (isHandlingSignal) {
      return;
    }
    isHandlingSignal = true;
    let resources = {};
    let cleanupFailed = false;
    try {
      resources = getResources() || {};
    } catch (error) {
      cleanupFailed = true;
      console.error(
        `[android-scenarios] Resource lookup after ${signal} failed: ${describeAndroidQaError(error, "resource-lookup-failed")}`
      );
    }
    try {
      if (
        resources.logcatCollector
        && resources.logcatCollector !== cleanedLogcatCollector
      ) {
        cleanupLogcat(resources.logcatCollector);
        cleanedLogcatCollector = resources.logcatCollector;
      }
    } catch (error) {
      cleanupFailed = true;
      console.error(
        `[android-scenarios] Logcat cleanup after ${signal} failed: ${describeAndroidQaError(error, "logcat-cleanup-failed")}`
      );
    }
    try {
      if (resources.metro && resources.metro !== cleanedMetro) {
        cleanupMetro(resources.metro);
        cleanedMetro = resources.metro;
      }
    } catch (error) {
      cleanupFailed = true;
      console.error(
        `[android-scenarios] Metro cleanup after ${signal} failed: ${describeAndroidQaError(error, "metro-cleanup-failed")}`
      );
    }
    if (cleanupFailed) {
      remove();
      isHandlingSignal = false;
      add();
      return;
    }
    remove();
    processRef.kill(processRef.pid, signal);
  };
  const onSigint = () => handle("SIGINT");
  const onSigterm = () => handle("SIGTERM");
  add();
  return remove;
}

function readTransferredMetroOwnership(ownershipPath) {
  if (!ownershipPath || !fs.existsSync(ownershipPath)) {
    return null;
  }

  const ownership = JSON.parse(fs.readFileSync(ownershipPath, "utf8"));
  if (!Number.isSafeInteger(ownership.pid) || ownership.pid <= 0) {
    throw new Error("Android smoke returned an invalid Metro ownership record.");
  }
  if (!ownership.processIdentity?.startMarker) {
    throw new Error("Android smoke returned a Metro ownership record without process identity.");
  }
  if (
    !Array.isArray(ownership.processTreeIdentities)
    || !ownership.processTreeIdentities.some((identity) => (
      identity?.pid === ownership.pid
      && identity?.startMarker === ownership.processIdentity.startMarker
      && identity?.depth === 0
    ))
  ) {
    throw new Error("Android smoke returned a Metro ownership record without a valid process-tree identity snapshot.");
  }
  const expectedOwnershipBoundary = process.platform === "win32"
    ? "windows-job"
    : "posix-process-group";
  if (ownership.ownershipBoundary !== expectedOwnershipBoundary) {
    throw new Error(
      `Android smoke returned an incompatible Metro ownership boundary: ${ownership.ownershipBoundary || "missing"}.`
    );
  }

  return { ...ownership, ownershipPath };
}

function installTransferredMetroSignalHandlers(getOwnership, processRef = process) {
  let isHandlingSignal = false;
  const remove = () => {
    processRef.removeListener("SIGINT", onSigint);
    processRef.removeListener("SIGTERM", onSigterm);
  };
  const handle = (signal) => {
    if (isHandlingSignal) {
      return;
    }
    isHandlingSignal = true;
    try {
      cleanupTransferredMetroOwnership(getOwnership());
    } catch (error) {
      console.error(
        `[android-scenarios] Metro cleanup after ${signal} failed: ${describeAndroidQaError(error, "metro-cleanup-failed")}`
      );
    } finally {
      remove();
      processRef.kill(processRef.pid, signal);
    }
  };
  const onSigint = () => handle("SIGINT");
  const onSigterm = () => handle("SIGTERM");
  processRef.once("SIGINT", onSigint);
  processRef.once("SIGTERM", onSigterm);
  return remove;
}

function cleanupTransferredMetroOwnership(ownership, options = {}) {
  if (!ownership) {
    return;
  }

  const stopProcessTree = options.stopProcessTree ?? stopOwnedProcessTreeByPid;
  if (!stopProcessTree(ownership.pid, {
    expectedIdentity: ownership.processIdentity,
    expectedProcessTreeIdentities: ownership.processTreeIdentities,
    ownershipBoundary: ownership.ownershipBoundary,
  })) {
    throw new Error(`Failed to stop scenario-owned Metro process tree ${ownership.pid}.`);
  }
  fs.rmSync(ownership.ownershipPath, { force: true });
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

  if (options.apkVariant) {
    args.push("--apk-variant", options.apkVariant);
  }

  if (options.port) {
    args.push("--port", options.port);
  }

  if (options.transferMetroOwnership) {
    args.push("--transfer-metro-ownership", options.transferMetroOwnership);
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
  const { match: node, snapshot } = await waitForSnapshotMatch(
    adbPath,
    serial,
    options,
    (candidateSnapshot) => findNodeInSnapshot(candidateSnapshot, label, options)
  );
  if (node) {
    return node;
  }

  throw new Error(withUiSnapshotSummary(snapshot, `Timed out waiting for text "${label}".`));
}

async function waitForAnyNode(adbPath, serial, labels, options = {}) {
  const { match, snapshot } = await waitForSnapshotMatch(
    adbPath,
    serial,
    options,
    (candidateSnapshot) => findAnyNodeInSnapshot(candidateSnapshot, labels, options)
  );
  if (match) {
    return match;
  }

  throw new Error(
    withUiSnapshotSummary(
      snapshot,
      `Timed out waiting for any of: ${labels.map((label) => `"${label}"`).join(", ")}.`
    )
  );
}

async function waitForResourceId(adbPath, serial, resourceId, options = {}) {
  const { match: node, snapshot } = await waitForSnapshotMatch(
    adbPath,
    serial,
    options,
    (candidateSnapshot) => findResourceIdInSnapshot(candidateSnapshot, resourceId, options)
  );
  if (node) {
    return node;
  }

  throw new Error(
    withUiSnapshotSummary(snapshot, `Timed out waiting for resource id "${resourceId}".`)
  );
}

async function waitForNoResourceId(adbPath, serial, resourceId, options = {}) {
  const { match, snapshot } = await waitForSnapshotMatch(
    adbPath,
    serial,
    options,
    (candidateSnapshot) => (
      findResourceIdInSnapshot(candidateSnapshot, resourceId, { visibleOnly: true })
        ? null
        : { absent: true }
    )
  );

  if (match) {
    return;
  }

  throw new Error(
    withUiSnapshotSummary(snapshot, `Timed out waiting for resource id "${resourceId}" to disappear.`)
  );
}

async function waitForModelWarmupToSettleIfPresent(adbPath, serial, options = {}) {
  const createSnapshot = options.createSnapshot ?? createUiSnapshot;
  const findWarmupMarker = (snapshot) => (
    findResourceIdInSnapshot(snapshot, MODEL_WARMUP_BANNER_RESOURCE_ID, { visibleOnly: true })
    ?? findAnyNodeInSnapshot(snapshot, MODEL_WARMUP_LABEL_FRAGMENTS, {
      visibleOnly: true,
      matchMode: "fragment",
    })
  );

  // Engine initialization may begin a few frames after the Home route becomes visible. Give the
  // marker a short observation window so a pre-render snapshot cannot incorrectly declare the UI
  // ready, then wait for the same observable state to disappear before interacting with the chat.
  const { match: warmupMarker } = await waitForSnapshotMatch(
    adbPath,
    serial,
    {
      timeoutMs: options.detectionTimeoutMs ?? MODEL_WARMUP_DETECTION_TIMEOUT_MS,
      pollIntervalMs: options.pollIntervalMs,
      createSnapshot,
      delayFn: options.delayFn,
    },
    findWarmupMarker
  );
  if (!warmupMarker) {
    return false;
  }

  const { match: settled, snapshot } = await waitForSnapshotMatch(
    adbPath,
    serial,
    {
      timeoutMs: options.timeoutMs ?? MODEL_WARMUP_SETTLE_TIMEOUT_MS,
      pollIntervalMs: options.pollIntervalMs,
      createSnapshot,
      delayFn: options.delayFn,
    },
    (candidateSnapshot) => (findWarmupMarker(candidateSnapshot) ? null : { settled: true })
  );
  if (settled) {
    return true;
  }

  throw new Error(withUiSnapshotSummary(snapshot, "Timed out waiting for model warmup to settle."));
}

async function setCatalogFilterPanelOpen(adbPath, serial, shouldBeOpen, options = {}) {
  const createSnapshot = options.createSnapshot ?? createUiSnapshot;
  const tap = options.tapBounds ?? tapBounds;
  const wait = options.delayFn ?? delay;
  const maxAttempts = options.maxAttempts ?? 2;
  const timeoutMs = options.timeoutMs ?? CATALOG_FILTER_PANEL_SETTLE_TIMEOUT_MS;
  let lastSnapshot = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const snapshot = createSnapshot(adbPath, serial);
    lastSnapshot = snapshot;
    const panel = findResourceIdInSnapshot(snapshot, MODELS_FILTER_PANEL_RESOURCE_ID, { visibleOnly: true });
    if (Boolean(panel) === shouldBeOpen) {
      return panel;
    }

    const toggle = findResourceIdInSnapshot(snapshot, MODELS_FILTER_TOGGLE_RESOURCE_ID, { visibleOnly: true });
    if (!toggle?.bounds) {
      throw new Error(
        withUiSnapshotSummary(snapshot, "Catalog filter toggle is not visible while changing panel state.")
      );
    }

    log(
      `Catalog filter panel is ${panel ? "open" : "closed"}; tapping ${toggle.bounds.centerX},${toggle.bounds.centerY} `
      + `to make it ${shouldBeOpen ? "open" : "closed"} (attempt ${attempt}/${maxAttempts}).`
    );
    tap(adbPath, serial, toggle.bounds);
    await wait(options.afterTapDelayMs ?? CATALOG_FILTER_ACTION_QUIET_DELAY_MS);
    const result = await waitForSnapshotMatch(
      adbPath,
      serial,
      {
        timeoutMs,
        pollIntervalMs: options.pollIntervalMs ?? CATALOG_FILTER_POLL_INTERVAL_MS,
        createSnapshot,
        delayFn: wait,
      },
      (candidateSnapshot) => {
        const candidatePanel = findResourceIdInSnapshot(
          candidateSnapshot,
          MODELS_FILTER_PANEL_RESOURCE_ID,
          { visibleOnly: true }
        );
        return Boolean(candidatePanel) === shouldBeOpen
          ? { panel: candidatePanel, isOpen: shouldBeOpen }
          : null;
      }
    );
    lastSnapshot = result.snapshot;
    if (result.match) {
      return result.match.panel;
    }

    log(
      `Catalog filter panel did not settle ${shouldBeOpen ? "open" : "closed"} within ${timeoutMs}ms `
      + `after attempt ${attempt}/${maxAttempts}.`
    );
  }

  throw new Error(
    withUiSnapshotSummary(
      lastSnapshot,
      `Catalog filter panel did not become ${shouldBeOpen ? "open" : "closed"} after ${maxAttempts} bounded attempts.`
    )
  );
}

async function clearCatalogFiltersIfPresent(adbPath, serial, options = {}) {
  const createSnapshot = options.createSnapshot ?? createUiSnapshot;
  const tap = options.tapBounds ?? tapBounds;
  const wait = options.delayFn ?? delay;
  // Clear changes the panel layout. Do not queue a second tap at coordinates that may point to a
  // filter option by the time Android handles it under catalog enrichment load.
  const maxAttempts = options.maxAttempts ?? 1;
  let lastSnapshot = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const snapshot = createSnapshot(adbPath, serial);
    lastSnapshot = snapshot;
    const clearButton = findResourceIdInSnapshot(snapshot, MODELS_FILTER_CLEAR_RESOURCE_ID, { visibleOnly: true });
    if (!clearButton) {
      return;
    }
    if (!clearButton.bounds) {
      throw new Error(withUiSnapshotSummary(snapshot, "Catalog clear-filters action has no tap bounds."));
    }

    tap(adbPath, serial, clearButton.bounds);
    await wait(options.afterTapDelayMs ?? CATALOG_FILTER_MUTATION_QUIET_DELAY_MS);
    const result = await waitForSnapshotMatch(
      adbPath,
      serial,
      {
        timeoutMs: options.timeoutMs ?? CATALOG_FILTER_MUTATION_SETTLE_TIMEOUT_MS,
        pollIntervalMs: options.pollIntervalMs ?? CATALOG_FILTER_POLL_INTERVAL_MS,
        createSnapshot,
        delayFn: wait,
      },
      (candidateSnapshot) => (
        findResourceIdInSnapshot(candidateSnapshot, MODELS_FILTER_CLEAR_RESOURCE_ID, { visibleOnly: true })
          ? null
          : { cleared: true }
      )
    );
    lastSnapshot = result.snapshot;
    if (result.match) {
      return;
    }
  }

  throw new Error(
    withUiSnapshotSummary(lastSnapshot, `Catalog filters did not clear after ${maxAttempts} bounded attempts.`)
  );
}

async function activateClearedCatalogFilterOption(adbPath, serial, resourceId, options = {}) {
  const createSnapshot = options.createSnapshot ?? createUiSnapshot;
  const tap = options.tapBounds ?? tapBounds;
  const wait = options.delayFn ?? delay;
  // Option rows are toggles, so a late duplicate would undo the requested state.
  const maxAttempts = options.maxAttempts ?? 1;
  let lastSnapshot = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const snapshot = createSnapshot(adbPath, serial);
    lastSnapshot = snapshot;
    const activeFilterMarker = findResourceIdInSnapshot(
      snapshot,
      MODELS_FILTER_CLEAR_RESOURCE_ID,
      { visibleOnly: true }
    );
    if (activeFilterMarker) {
      return;
    }

    const optionNode = findResourceIdInSnapshot(snapshot, resourceId, { visibleOnly: true });
    if (!optionNode?.bounds) {
      throw new Error(
        withUiSnapshotSummary(snapshot, `Catalog filter option "${resourceId}" is not visible or tappable.`)
      );
    }

    tap(adbPath, serial, optionNode.bounds);
    await wait(options.afterTapDelayMs ?? CATALOG_FILTER_MUTATION_QUIET_DELAY_MS);
    const result = await waitForSnapshotMatch(
      adbPath,
      serial,
      {
        timeoutMs: options.timeoutMs ?? CATALOG_FILTER_MUTATION_SETTLE_TIMEOUT_MS,
        pollIntervalMs: options.pollIntervalMs ?? CATALOG_FILTER_POLL_INTERVAL_MS,
        createSnapshot,
        delayFn: wait,
      },
      (candidateSnapshot) => findResourceIdInSnapshot(
        candidateSnapshot,
        MODELS_FILTER_CLEAR_RESOURCE_ID,
        { visibleOnly: true }
      )
    );
    lastSnapshot = result.snapshot;
    if (result.match) {
      return;
    }
  }

  throw new Error(
    withUiSnapshotSummary(
      lastSnapshot,
      `Catalog filter option "${resourceId}" did not become active after ${maxAttempts} bounded attempts.`
    )
  );
}

async function tapBoundsUntilAnyNode(adbPath, serial, bounds, targetLabels, options = {}) {
  const createSnapshot = options.createSnapshot ?? createUiSnapshot;
  const tap = options.tapBounds ?? tapBounds;
  const wait = options.delayFn ?? delay;
  const maxAttempts = options.maxAttempts ?? 2;
  const timeoutMs = options.timeoutMs ?? MODEL_DETAILS_ROUTE_TIMEOUT_MS;
  let lastSnapshot = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const snapshot = createSnapshot(adbPath, serial);
    lastSnapshot = snapshot;
    const targetAlreadyVisible = findAnyNodeInSnapshot(snapshot, targetLabels, { visibleOnly: true });
    if (targetAlreadyVisible) {
      return targetAlreadyVisible;
    }
    if (
      attempt > 1
      && options.sourceLabels
      && !findAnyNodeInSnapshot(snapshot, options.sourceLabels, { visibleOnly: true })
    ) {
      break;
    }

    tap(adbPath, serial, bounds);
    await wait(options.afterTapDelayMs ?? ROUTE_ACTION_QUIET_DELAY_MS);
    const result = await waitForSnapshotMatch(
      adbPath,
      serial,
      {
        timeoutMs,
        pollIntervalMs: options.pollIntervalMs ?? ROUTE_POLL_INTERVAL_MS,
        createSnapshot,
        delayFn: wait,
      },
      (candidateSnapshot) => findAnyNodeInSnapshot(candidateSnapshot, targetLabels, { visibleOnly: true })
    );
    lastSnapshot = result.snapshot;
    if (result.match) {
      return result.match;
    }
  }

  throw new Error(
    withUiSnapshotSummary(
      lastSnapshot,
      `Timed out after tapping for any of: ${targetLabels.map((label) => `"${label}"`).join(", ")}.`
    )
  );
}

async function dismissTransientSurfaceWithBack(ctx, adbPath, serial, surfaceLabels, destinationLabels, options = {}) {
  const createSnapshot = options.createSnapshot ?? createUiSnapshot;
  const wait = options.delayFn ?? delay;
  const maxAttempts = options.maxAttempts ?? TRANSIENT_SURFACE_BACK_MAX_ATTEMPTS;
  const timeoutMs = options.timeoutMs ?? TRANSIENT_SURFACE_BACK_TIMEOUT_MS;
  let lastSnapshot = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const snapshot = createSnapshot(adbPath, serial);
    lastSnapshot = snapshot;
    const destination = findAnyNodeInSnapshot(snapshot, destinationLabels, { visibleOnly: true });
    if (destination) {
      return destination;
    }

    const surface = findAnyNodeInSnapshot(snapshot, surfaceLabels, { visibleOnly: true });
    if (!surface && attempt > 1) {
      break;
    }

    await ctx.pressBack();
    await wait(options.afterBackDelayMs ?? TRANSIENT_SURFACE_BACK_QUIET_DELAY_MS);
    const result = await waitForSnapshotMatch(
      adbPath,
      serial,
      {
        timeoutMs,
        pollIntervalMs: options.pollIntervalMs,
        createSnapshot,
        delayFn: wait,
      },
      (candidateSnapshot) => findAnyNodeInSnapshot(
        candidateSnapshot,
        destinationLabels,
        { visibleOnly: true }
      )
    );
    lastSnapshot = result.snapshot;
    if (result.match) {
      return result.match;
    }
  }

  throw new Error(
    withUiSnapshotSummary(
      lastSnapshot,
      `Timed out dismissing ${surfaceLabels.map((label) => `"${label}"`).join(", ")} and returning to ${destinationLabels.map((label) => `"${label}"`).join(", ")}.`
    )
  );
}

async function tapBottomTabUntilVisible(ctx, tabLabels, destinationLabels, options = {}) {
  const maxAttempts = options.maxAttempts ?? 3;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await ctx.tapBottomTab(tabLabels);
    try {
      if (options.timeoutMs === undefined) {
        await ctx.expectAnyText(destinationLabels);
      } else {
        await ctx.expectAnyText(destinationLabels, { timeoutMs: options.timeoutMs });
      }
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error(
    `Timed out navigating to bottom-tab destination: ${destinationLabels.join(", ")}.`
  );
}

async function waitForNoAnyNode(adbPath, serial, labels, options = {}) {
  const { match: absence, snapshot } = await waitForSnapshotMatch(
    adbPath,
    serial,
    options,
    (candidateSnapshot) => (
      findAnyNodeInSnapshot(candidateSnapshot, labels, {
        ...options,
        visibleOnly: true,
      })
        ? null
        : { absent: true }
    )
  );
  if (absence) {
    return;
  }

  throw new Error(
    withUiSnapshotSummary(
      snapshot,
      `Timed out waiting for all of these nodes to disappear: ${labels.map((label) => `"${label}"`).join(", ")}.`
    )
  );
}

async function waitForSnapshotMatch(adbPath, serial, options, matchSnapshot) {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const pollIntervalMs = options.pollIntervalMs ?? 600;
  const createSnapshot = options.createSnapshot ?? createUiSnapshot;
  const wait = options.delayFn ?? delay;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = createSnapshot(adbPath, serial);
    const match = matchSnapshot(snapshot);
    if (match) {
      return { match, snapshot };
    }

    await wait(pollIntervalMs);
  }

  // UI hierarchy capture is synchronous and may itself cross the timeout boundary. Take one
  // final authoritative snapshot so a node that became visible during that last capture is not
  // reported as missing while a second diagnostic dump immediately shows it on screen.
  const snapshot = createSnapshot(adbPath, serial);
  return {
    match: matchSnapshot(snapshot),
    snapshot,
  };
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

async function waitForPreparedAssistantResponse(adbPath, serial, sentContext, prompt, options = {}) {
  const timeoutMs = options.timeoutMs ?? 45_000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = createUiSnapshot(adbPath, serial);
    const responseNode = findPreparedAssistantResponseNode(snapshot, sentContext, prompt);
    if (responseNode) {
      return responseNode;
    }

    await delay(800);
  }

  throw new Error(
    withUiSummary(
      adbPath,
      serial,
      `Timed out waiting for a meaningful assistant response after prepared image prompt "${prompt}".`
    )
  );
}

function findPreparedAssistantResponseNode(snapshot, sentContext, prompt) {
  const sentBottom = Math.max(
    sentContext?.promptMatch?.node?.bounds?.bottom ?? 0,
    sentContext?.messagePreviewMatch?.node?.bounds?.bottom ?? 0
  );
  const viewportBottom = snapshot.viewportBounds?.bottom ?? Number.POSITIVE_INFINITY;

  return snapshot.nodes.find((node) => {
    if (!node.bounds || node.bounds.top <= sentBottom) {
      return false;
    }

    if (node.bounds.top > viewportBottom - DEFAULT_TAP_SAFE_BOTTOM_INSET_MIN_PX) {
      return false;
    }

    if (!isPreparedAssistantResponseCandidateNode(node)) {
      return false;
    }

    const hasResponseLabel = isPreparedAssistantResponseLabel(node.text, prompt)
      || isPreparedAssistantResponseLabel(node.contentDesc, prompt);
    return hasResponseLabel && isInsidePreparedAssistantResponseContent(snapshot, node, sentBottom);
  }) ?? null;
}

function isInsidePreparedAssistantResponseContent(snapshot, node, sentBottom) {
  if (!node.bounds) {
    return false;
  }

  const isInsideContentContainer = snapshot.nodes.some((container) => (
    isPreparedAssistantResponseContentContainerNode(container)
    && container.bounds
    && container.bounds.top > sentBottom
    && containsBounds(container.bounds, node.bounds)
  ));
  if (!isInsideContentContainer) {
    return false;
  }

  return snapshot.nodes.some((container) => (
    isPreparedAssistantCompleteMessageContainerNode(container)
    && container.bounds
    && container.bounds.top > sentBottom
    && containsBounds(container.bounds, node.bounds)
  ));
}

function isPreparedAssistantResponseContentContainerNode(node) {
  return [node.resourceId, node.contentDesc]
    .map(normalizeUiLabel)
    .some((label) => label.includes(ASSISTANT_MESSAGE_CONTENT_RESOURCE_ID_FRAGMENT));
}

function isPreparedAssistantCompleteMessageContainerNode(node) {
  return [node.resourceId, node.contentDesc]
    .map(normalizeUiLabel)
    .some((label) => label.includes(ASSISTANT_MESSAGE_COMPLETE_RESOURCE_ID_FRAGMENT));
}

function containsBounds(containerBounds, childBounds) {
  const tolerancePx = 2;
  return childBounds.left >= containerBounds.left - tolerancePx
    && childBounds.right <= containerBounds.right + tolerancePx
    && childBounds.top >= containerBounds.top - tolerancePx
    && childBounds.bottom <= containerBounds.bottom + tolerancePx;
}

function isPreparedAssistantResponseCandidateNode(node) {
  if (node.clickable === true) {
    return false;
  }

  const normalizedClassName = normalizeUiLabel(node.className);
  const normalizedResourceId = normalizeUiLabel(node.resourceId);
  const normalizedContentDesc = normalizeUiLabel(node.contentDesc);
  const structuralLabel = `${normalizedClassName} ${normalizedResourceId}`;
  const compactStructuralLabel = structuralLabel.replace(/[^a-z0-9]+/giu, "");
  if (
    /\b(?:tab|tabwidget|navigation|navbar|toolbar|actionbar|button|menu)\b/iu.test(structuralLabel)
    || compactStructuralLabel.includes("bottomnavigation")
    || compactStructuralLabel.includes("actionbar")
  ) {
    return false;
  }

  const navigationLabels = [
    ...HOME_TAB_LABELS,
    ...CHAT_TAB_LABELS,
    ...MODELS_TAB_LABELS,
    ...SETTINGS_TAB_LABELS,
  ].map(normalizeUiLabel).filter(Boolean);
  if (
    /\btab\b/iu.test(normalizedContentDesc)
    && navigationLabels.some((label) => normalizedContentDesc.includes(label))
  ) {
    return false;
  }

  return true;
}

function isPreparedAssistantResponseLabel(value, prompt) {
  const label = normalizeUiLabel(value);
  if (label.length < 2) {
    return false;
  }

  const normalizedPrompt = normalizeUiLabel(prompt);
  if (label === normalizedPrompt || label.includes(normalizedPrompt)) {
    return false;
  }

  if (/^\d+(?:\.\d+)?\s*t\/s$/iu.test(label)) {
    return false;
  }

  const letters = label.match(/\p{L}/gu) ?? [];
  if (letters.length < 4 || !/\p{L}{2,}/u.test(label)) {
    return false;
  }

  return !PREPARED_ASSISTANT_RESPONSE_NON_ANSWER_LABEL_FRAGMENTS.some((excludedLabel) => (
    label === excludedLabel || label.includes(excludedLabel)
  ));
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
  const { match, snapshot } = await waitForSnapshotMatch(
    adbPath,
    serial,
    options,
    (candidateSnapshot) => (
      options.allowBottomOverlay
        ? findAnyNodeInSnapshot(candidateSnapshot, labels, { visibleOnly: true })
        : findAnyNodeClearOfBottomOverlay(candidateSnapshot, labels, options)
    )
  );
  if (match) {
    return match;
  }

  throw new Error(
    withUiSnapshotSummary(
      snapshot,
      `Timed out waiting for a tappable node matching any of: ${labels.map((label) => `"${label}"`).join(", ")}.`
    )
  );
}

async function waitForAnyNodeWithPicker(adbPath, serial, labels, options = {}, picker) {
  const resolvedPicker = picker ?? pickBestNode;
  const { match, snapshot } = await waitForSnapshotMatch(
    adbPath,
    serial,
    options,
    (candidateSnapshot) => findAnyNodeInSnapshot(candidateSnapshot, labels, options, resolvedPicker)
  );
  if (match) {
    return match;
  }

  throw new Error(
    withUiSnapshotSummary(
      snapshot,
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
      className: attributes.class || "",
      resourceId: attributes["resource-id"] || "",
      packageName: attributes.package || "",
      clickable: attributes.clickable === "true",
      enabled: attributes.enabled !== "false",
      selected: attributes.selected === "true",
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
  const matchNode = options.matchMode === "fragment" ? matchesUiFragment : matchesLabel;

  return snapshot.nodes.filter((node) => {
    if (!matchNode(node, label)) {
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

function findBottomTabNodeInSnapshot(snapshot, labels) {
  return findAnyNodeInSnapshot(
    snapshot,
    labels,
    { visibleOnly: true },
    pickBottomMostNode
  );
}

function getBottomTabTapPoint(node) {
  if (!node?.bounds) {
    return null;
  }

  // React Native's collapsed warning banner can cover the lower half of the floating tab bar.
  // The tab root remains fully clickable, so prefer its upper quarter instead of the center.
  const upperInset = Math.max(8, Math.min(32, Math.round(node.bounds.height * 0.25)));
  return {
    centerX: node.bounds.centerX,
    centerY: Math.min(node.bounds.bottom - 1, node.bounds.top + upperInset),
  };
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

function summarizeUiSnapshot(snapshot, options = {}) {
  const maxItems = options.maxItems ?? 10;
  const maxLabelLength = options.maxLabelLength ?? 80;

  try {
    const { nodes, viewportBounds } = snapshot;
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

function summarizeCurrentUi(adbPath, serial, options = {}) {
  try {
    return summarizeUiSnapshot(createUiSnapshot(adbPath, serial), options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `<ui dump unavailable: ${message}>`;
  }
}

function withUiSummary(adbPath, serial, message) {
  return `${message}\nVisible UI: ${summarizeCurrentUi(adbPath, serial)}`;
}

function withUiSnapshotSummary(snapshot, message) {
  return `${message}\nVisible UI: ${summarizeUiSnapshot(snapshot)}`;
}

function sanitizeArtifactStem(value) {
  return `${value || "artifact"}`.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function resolveAndroidPackageUid(adbPath, serial, packageName, options = {}) {
  const capture = options.runCapture || runCapture;
  let packageDump;
  try {
    packageDump = capture(
      adbPath,
      ["-s", serial, "shell", "dumpsys", "package", packageName]
    );
  } catch (error) {
    throw new ScenarioPreconditionFailureError(
      `Could not resolve the Android UID for ${packageName}: ${error.message}`,
      { cause: error }
    );
  }

  const uid = packageDump.match(/(?:^|\s)userId=(\d+)\b/m)?.[1] || null;
  if (!uid) {
    throw new ScenarioPreconditionFailureError(
      `Could not resolve the Android UID for ${packageName}; the installed package dump has no userId.`
    );
  }
  return uid;
}

function readAndroidLogcatStartEpoch(adbPath, serial, options = {}) {
  const capture = options.runCapture || runCapture;
  let output;
  try {
    output = capture(adbPath, ["-s", serial, "shell", "date", "+%s.%3N"]);
  } catch (error) {
    throw new ScenarioPreconditionFailureError(
      `Could not establish the Android logcat start boundary: ${error.message}`,
      { cause: error }
    );
  }
  const epoch = output.trim().match(/^(\d{9,})\.(\d{3,6})$/);
  if (!epoch) {
    throw new ScenarioPreconditionFailureError(
      `Android returned an unsupported logcat start timestamp: ${JSON.stringify(output.trim())}.`
    );
  }
  return `${epoch[1]}.${epoch[2]}`;
}

function awaitWithTimeout(promise, timeoutMs, message) {
  let timeoutId;
  const timeoutPromise = new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

function escapeAndroidLogcatRegex(value) {
  return `${value}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function synchronizeAndroidLogcatCollector(collector) {
  const streams = collector.streams || [];
  collector.started = streams.length === collector.expectedStreamCount
    && streams.every((stream) => stream.started);
  collector.closed = streams.length === collector.expectedStreamCount
    && streams.every((stream) => stream.closed);
  collector.stopped = streams.length === collector.expectedStreamCount
    && streams.every((stream) => stream.stopped);
  collector.error = streams.find((stream) => stream.error)?.error || collector.error || null;
  return collector;
}

function spawnAndroidLogcatStream(collector, definition, dependencies) {
  const { fsImpl, spawnProcess, captureOwnership, requireOwnership } = dependencies;
  let rawLogFd;
  try {
    rawLogFd = fsImpl.openSync(definition.rawLogPath, "wx");
  } catch (error) {
    throw new Error(`Could not prepare one private Android logcat stream: ${error.code || "filesystem error"}.`);
  }

  let child;
  try {
    child = spawnProcess(collector.adbPath, definition.args, {
      stdio: ["ignore", rawLogFd, rawLogFd],
      windowsHide: true,
    });
  } catch (error) {
    fsImpl.closeSync(rawLogFd);
    try {
      fsImpl.rmSync(definition.rawLogPath, { force: true });
    } catch {
      // The generic collector failure below must not expose the private path.
    }
    throw error;
  }

  let resolveStarted;
  let rejectStarted;
  let resolveClosed;
  const startedPromise = new Promise((resolve, reject) => {
    resolveStarted = resolve;
    rejectStarted = reject;
  });
  const closedPromise = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  const stream = {
    ...definition,
    child,
    started: false,
    closed: false,
    stopped: false,
    stopRequested: false,
    error: null,
    close: null,
    startedPromise,
    closedPromise,
    resolveClosed,
    ownership: null,
    ownershipBoundary: child.pocketAiOwnershipBoundary || null,
  };
  collector.streams.push(stream);

  child.once("spawn", () => {
    try {
      if (Number.isSafeInteger(child.pid) && child.pid > 0) {
        stream.ownership = captureOwnership(child.pid, {
          ownershipBoundary: stream.ownershipBoundary,
        });
      }
      if (requireOwnership && !stream.ownership?.processIdentity?.startMarker) {
        throw new Error(`Could not authenticate ownership of the Android ${stream.kind} logcat process.`);
      }
      stream.started = true;
      synchronizeAndroidLogcatCollector(collector);
      resolveStarted();
    } catch (error) {
      stream.error = error;
      synchronizeAndroidLogcatCollector(collector);
      rejectStarted(error);
    }
  });
  child.once("error", (error) => {
    stream.error = error;
    synchronizeAndroidLogcatCollector(collector);
    if (!stream.started) {
      rejectStarted(error);
    }
  });
  child.once("close", (code, signal) => {
    stream.closed = true;
    stream.close = { code, signal };
    resolveClosed();
    synchronizeAndroidLogcatCollector(collector);
    if (!stream.started) {
      rejectStarted(new Error(
        `Android ${stream.kind} logcat exited before capture began (code=${code}, signal=${signal || "none"}).`
      ));
    }
  });
  fsImpl.closeSync(rawLogFd);
  return stream;
}

function forceTerminateAndroidLogcatStream(collector, stream, options = {}) {
  if (stream.closed) {
    return true;
  }

  const processId = stream.child?.pid;
  if (!Number.isSafeInteger(processId) || processId <= 0) {
    return false;
  }

  stream.stopRequested = true;
  const stopOwnedProcessTree = options.stopOwnedProcessTreeByPid
    || collector.stopOwnedProcessTreeByPid
    || stopOwnedProcessTreeByPid;
  const ownership = stream.ownership || {};
  let stopped = false;
  try {
    stopped = stopOwnedProcessTree(processId, {
      expectedIdentity: ownership.processIdentity,
      expectedProcessTreeIdentities: ownership.processTreeIdentities,
      ownershipBoundary: ownership.ownershipBoundary || stream.ownershipBoundary,
      trustedChildHandle: true,
      killRoot: () => stream.child.kill("SIGKILL"),
      gracefulTimeoutMs: options.gracefulTimeoutMs ?? LOGCAT_COLLECTOR_FORCE_STOP_TIMEOUT_MS,
      forcefulTimeoutMs: options.forcefulTimeoutMs ?? LOGCAT_COLLECTOR_FORCE_STOP_TIMEOUT_MS,
    });
  } catch {
    stopped = false;
  }
  if (!stopped) {
    return false;
  }

  stream.closed = true;
  stream.forcedTermination = true;
  stream.close = stream.close || { code: null, signal: "OWNERSHIP_FALLBACK" };
  stream.resolveClosed?.();
  synchronizeAndroidLogcatCollector(collector);
  return true;
}

function forceTerminateAndroidLogcatCollector(collector, options = {}) {
  if (!collector) {
    return true;
  }
  collector.stopRequested = true;
  for (const stream of collector.streams || []) {
    if (!stream.closed) {
      forceTerminateAndroidLogcatStream(collector, stream, options);
    }
  }
  synchronizeAndroidLogcatCollector(collector);
  return (collector.streams || []).every((stream) => stream.closed);
}

async function startAndroidLogcatCollector({
  adbPath,
  serial,
  packageName,
  stem,
}, options = {}) {
  const fsImpl = options.fs || fs;
  const spawnProcess = options.spawn || ((command, args, spawnOptions) => spawnOwnedProcess(
    command,
    args,
    {
      ...spawnOptions,
      cwd: projectRoot,
      detached: process.platform !== "win32",
    }
  ));
  const captureOwnership = options.captureOwnership || captureOwnedProcessOwnership;
  const requireOwnership = options.requireOwnership ?? !options.spawn;
  const privateRoot = path.resolve(options.privateRoot || PRIVATE_LOGCAT_DIRECTORY);
  const runCaptureForCollector = options.runCapture || runCapture;
  const uid = resolveAndroidPackageUid(adbPath, serial, packageName, {
    runCapture: runCaptureForCollector,
  });
  const startEpoch = readAndroidLogcatStartEpoch(adbPath, serial, {
    runCapture: runCaptureForCollector,
  });
  const rawStem = `${sanitizeArtifactStem(stem)}-${process.pid}-${Date.now()}`;
  const rawLogPath = path.join(privateRoot, `${rawStem}.app.raw.log`);
  const systemRawLogPath = path.join(privateRoot, `${rawStem}.system-anr.raw.log`);
  try {
    fsImpl.mkdirSync(privateRoot, { recursive: true });
  } catch (error) {
    throw new ScenarioPreconditionFailureError(
      `Could not prepare private Android logcat storage: ${error.code || "filesystem error"}.`,
      { cause: error }
    );
  }

  const collector = {
    adbPath,
    packageName,
    uid,
    startEpoch,
    rawLogPath,
    systemRawLogPath,
    rawLogPaths: [rawLogPath, systemRawLogPath],
    fs: fsImpl,
    streams: [],
    expectedStreamCount: 2,
    started: false,
    closed: false,
    stopped: false,
    stopAttempted: false,
    stopRequested: false,
    stopPromise: null,
    error: null,
    startError: null,
    stopOwnedProcessTreeByPid: options.stopOwnedProcessTreeByPid || stopOwnedProcessTreeByPid,
  };
  options.onCollectorCreated?.(collector);

  const sharedArgs = [
    "-s",
    serial,
    "logcat",
    "-b",
    "all",
  ];
  const streamDefinitions = [
    {
      kind: "app",
      rawLogPath,
      args: [
        ...sharedArgs,
        `--uid=${uid}`,
        "-T",
        startEpoch,
        "-v",
        "threadtime",
      ],
    },
    {
      kind: "system-anr",
      rawLogPath: systemRawLogPath,
      args: [
        ...sharedArgs,
        "--uid=1000",
        "-T",
        startEpoch,
        "-v",
        "threadtime",
        "--regex",
        `ANR in ${escapeAndroidLogcatRegex(packageName)}`,
        "ActivityManager:V",
        "*:S",
      ],
    },
  ];

  try {
    for (const definition of streamDefinitions) {
      spawnAndroidLogcatStream(collector, definition, {
        fsImpl,
        spawnProcess,
        captureOwnership,
        requireOwnership,
      });
    }
    await awaitWithTimeout(
      Promise.all(collector.streams.map((stream) => stream.startedPromise)),
      options.startTimeoutMs ?? LOGCAT_COLLECTOR_START_TIMEOUT_MS,
      "Timed out waiting for the app/system-scoped Android logcat collectors to start."
    );
    const earlyExit = collector.streams.find((stream) => stream.closed);
    if (earlyExit) {
      throw new Error(
        `Android ${earlyExit.kind} logcat exited before the scenario began (code=${earlyExit.close?.code}, signal=${earlyExit.close?.signal || "none"}).`
      );
    }
    synchronizeAndroidLogcatCollector(collector);
    if (!collector.started) {
      throw new Error("Android logcat collectors did not reach their complete owned-start state.");
    }
  } catch (error) {
    collector.startError = error;
    collector.stopRequested = true;
    for (const stream of collector.streams) {
      stream.stopRequested = true;
      if (!stream.closed) {
        try {
          stream.child.kill("SIGKILL");
        } catch {
          // Authenticated ownership cleanup below remains authoritative.
        }
      }
    }
    await Promise.all(collector.streams.map(async (stream) => {
      if (stream.closed) {
        return;
      }
      try {
        await awaitWithTimeout(
          stream.closedPromise,
          options.forceStopTimeoutMs ?? LOGCAT_COLLECTOR_FORCE_STOP_TIMEOUT_MS,
          "Timed out terminating an Android logcat collector that failed to start."
        );
      } catch {
        forceTerminateAndroidLogcatStream(collector, stream, options);
      }
    }));
    synchronizeAndroidLogcatCollector(collector);
    const allOwnedProcessesReleased = collector.streams.every((stream) => stream.closed);
    if (allOwnedProcessesReleased) {
      for (const privatePath of collector.rawLogPaths) {
        try {
          fsImpl.rmSync(privatePath, { force: true });
        } catch {
          // The generic collector failure below must not expose the private path.
        }
      }
      options.onCollectorCreated?.(null);
    }
    const cleanupSuffix = allOwnedProcessesReleased
      ? ""
      : " One or more owned collector processes remain retained for a later authenticated cleanup retry.";
    throw new ScenarioPreconditionFailureError(
      `Could not start the app/system-scoped Android logcat collectors: ${error.message}${cleanupSuffix}`,
      { cause: error }
    );
  }

  return collector;
}

async function stopAndroidLogcatStream(collector, stream, options = {}) {
  if (!stream.started) {
    throw new Error(`The Android ${stream.kind} logcat collector never started.`);
  }
  if (stream.closed && !stream.stopRequested) {
    throw new Error(
      `Android ${stream.kind} logcat exited before the step completed (code=${stream.close?.code}, signal=${stream.close?.signal || "none"}).`
    );
  }

  stream.stopRequested = true;
  let stopFailure = stream.error;
  if (!stream.closed) {
    const killAccepted = stream.child.kill();
    if (!killAccepted) {
      stopFailure = stopFailure || new Error(
        `The Android ${stream.kind} logcat process rejected its owned stop request.`
      );
    }
    try {
      await awaitWithTimeout(
        stream.closedPromise,
        options.stopTimeoutMs ?? LOGCAT_COLLECTOR_STOP_TIMEOUT_MS,
        `Timed out waiting for the Android ${stream.kind} logcat collector to stop.`
      );
    } catch (error) {
      stopFailure = stopFailure || error;
      stream.child.kill("SIGKILL");
      try {
        await awaitWithTimeout(
          stream.closedPromise,
          options.forceStopTimeoutMs ?? LOGCAT_COLLECTOR_FORCE_STOP_TIMEOUT_MS,
          `Timed out force-stopping the Android ${stream.kind} logcat collector.`
        );
      } catch (forceStopError) {
        const ownershipFallbackStopped = forceTerminateAndroidLogcatStream(
          collector,
          stream,
          options
        );
        const ownershipSuffix = ownershipFallbackStopped
          ? " The owned collector was terminated by its authenticated process boundary."
          : "";
        throw new Error(`${stopFailure.message} ${forceStopError.message}${ownershipSuffix}`);
      }
    }
  }

  stopFailure = stopFailure || stream.error;
  if (stopFailure) {
    throw new Error(`Android ${stream.kind} logcat collection failed: ${stopFailure.message}`);
  }
  stream.stopped = true;
  synchronizeAndroidLogcatCollector(collector);
}

async function stopAndroidLogcatCollector(collector, options = {}) {
  if (!collector) {
    return;
  }
  if (collector.stopPromise) {
    return collector.stopPromise;
  }

  collector.stopAttempted = true;
  collector.stopRequested = true;
  collector.stopPromise = (async () => {
    const failures = [];
    if (collector.streams.length !== collector.expectedStreamCount) {
      failures.push(new Error("Android logcat evidence is missing one or more required collectors."));
    }
    const results = await Promise.allSettled(
      collector.streams.map((stream) => stopAndroidLogcatStream(collector, stream, options))
    );
    for (const result of results) {
      if (result.status === "rejected") {
        failures.push(result.reason);
      }
    }
    synchronizeAndroidLogcatCollector(collector);
    if (failures.length > 0) {
      throw new ScenarioPreconditionFailureError(
        failures.map((failure) => failure.message).join(" "),
        { cause: failures[0] }
      );
    }
    collector.stopped = true;
  })();
  return collector.stopPromise;
}

function readBoundedAndroidLogcatFile(collector, rawLogPath, stat) {
  let descriptor;
  try {
    descriptor = collector.fs.openSync(rawLogPath, "r");
    const snapshot = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < snapshot.length) {
      const bytesRead = collector.fs.readSync(
        descriptor,
        snapshot,
        offset,
        snapshot.length - offset,
        offset
      );
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
    return snapshot.subarray(0, offset).toString("utf8");
  } finally {
    if (descriptor != null) {
      collector.fs.closeSync(descriptor);
    }
  }
}

function extractTargetSystemAnrLines(rawLog, packageName) {
  const targetAnr = new RegExp(
    `\\bANR in ${escapeAndroidLogcatRegex(packageName)}(?=\\s|:|$)`,
    "i"
  );
  const targetLines = [];
  for (const rawLine of `${rawLog || ""}`.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^-+\s+beginning of\s+/i.test(line)) {
      continue;
    }
    if (!targetAnr.test(line)) {
      throw new ScenarioPreconditionFailureError(
        "The system Android logcat stream contained unrelated output; refusing to publish it."
      );
    }
    if (!/\bActivityManager\s*:/i.test(line)) {
      throw new ScenarioPreconditionFailureError(
        "The system Android logcat stream contained output outside the ActivityManager ANR contract."
      );
    }
    targetLines.push(rawLine);
  }
  return targetLines;
}

function readAndroidLogcatCollector(collector, options = {}) {
  if (!collector?.started || collector.streams.length !== collector.expectedStreamCount) {
    throw new ScenarioPreconditionFailureError(
      "Android logcat evidence is unavailable because both required collectors were not started."
    );
  }
  const streamError = collector.streams.find((stream) => stream.error)?.error || collector.error;
  if (streamError) {
    throw new ScenarioPreconditionFailureError(
      `Android logcat evidence collection failed: ${streamError.message}`,
      { cause: streamError }
    );
  }
  const earlyExit = collector.streams.find((stream) => stream.closed && !stream.stopRequested);
  if (earlyExit) {
    throw new ScenarioPreconditionFailureError(
      `Android ${earlyExit.kind} logcat collector exited before the step completed (code=${earlyExit.close?.code}, signal=${earlyExit.close?.signal || "none"}).`
    );
  }
  const requireStopped = options.requireStopped !== false;
  if (requireStopped && !collector.stopped) {
    throw new ScenarioPreconditionFailureError(
      "Android logcat evidence is incomplete because its collectors have not stopped cleanly."
    );
  }

  let streamStats;
  try {
    streamStats = collector.streams.map((stream) => ({
      stream,
      stat: collector.fs.statSync(stream.rawLogPath),
    }));
  } catch (error) {
    throw new ScenarioPreconditionFailureError(
      `Could not read private Android logcat evidence: ${error.code || "filesystem error"}.`,
      { cause: error }
    );
  }
  const maxBytes = options.maxBytes ?? LOGCAT_EVIDENCE_MAX_BUFFER_BYTES;
  const totalBytes = streamStats.reduce((total, entry) => total + entry.stat.size, 0);
  if (totalBytes > maxBytes) {
    throw new ScenarioPreconditionFailureError(
      `Android logcat evidence exceeded the ${maxBytes}-byte safety limit.`
    );
  }

  let outputs;
  try {
    outputs = Object.fromEntries(streamStats.map(({ stream, stat }) => [
      stream.kind,
      readBoundedAndroidLogcatFile(collector, stream.rawLogPath, stat),
    ]));
  } catch (error) {
    throw new ScenarioPreconditionFailureError(
      `Could not read private Android logcat evidence: ${error.code || "filesystem error"}.`,
      { cause: error }
    );
  }
  const systemAnrLines = extractTargetSystemAnrLines(outputs["system-anr"], collector.packageName);
  const appOutput = outputs.app || "";
  if (systemAnrLines.length === 0) {
    return appOutput;
  }
  const separator = appOutput && !appOutput.endsWith("\n") ? "\n" : "";
  return `${appOutput}${separator}${systemAnrLines.join("\n")}\n`;
}

function cleanupAndroidLogcatCollector(collector) {
  if (!collector) {
    return;
  }
  if ((collector.streams || []).some((stream) => !stream.closed)) {
    if (!forceTerminateAndroidLogcatCollector(collector)) {
      throw new ScenarioPreconditionFailureError(
        "Refusing to remove private Android logcat files while a collector may still be running."
      );
    }
  }
  let removalError = null;
  for (const privatePath of collector.rawLogPaths || [collector.rawLogPath]) {
    try {
      collector.fs.rmSync(privatePath, { force: true });
    } catch (error) {
      removalError = removalError || error;
    }
  }
  if (removalError) {
    throw new ScenarioPreconditionFailureError(
      `Could not remove private Android logcat evidence: ${removalError.code || "filesystem error"}.`,
      { cause: removalError }
    );
  }
}

function sanitizeQaLogcat(logcat) {
  return sanitizeAndroidQaText(logcat, {
    maxChars: LOGCAT_EVIDENCE_MAX_BUFFER_BYTES,
    sensitiveRoots: [projectRoot],
  });
}

function scanFatalAndroidLogs(logcat, patterns = FATAL_LOG_PATTERNS) {
  return patterns
    .map((pattern) => ({ pattern: pattern.source, matched: pattern.test(logcat) }))
    .filter((entry) => entry.matched)
    .map((entry) => entry.pattern);
}

function resolveObservedJsSurface(snapshot) {
  return isAppForegroundSnapshot(snapshot) ? "foreground" : "stopped";
}

function captureEvidenceArtifacts({
  adbPath,
  serial,
  stem,
  screenshotPath = null,
  expectedJsSurface = "foreground",
  allowValidationFailure = false,
  logcatCollector = null,
  requireCompleteLogInterval = true,
}) {
  const evidenceRoot = path.join(artifactsRoot, BRANCH_EVIDENCE_DIRECTORY);
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const resolvedStem = sanitizeArtifactStem(stem);
  const resolvedScreenshotPath = screenshotPath || captureAndroidScreenshot(
    adbPath,
    serial,
    path.join(evidenceRoot, `${resolvedStem}.png`)
  );
  const uiXml = dumpUiHierarchy(adbPath, serial);
  const uiDumpPath = path.join(evidenceRoot, `${resolvedStem}.xml`);
  fs.writeFileSync(uiDumpPath, uiXml);
  const rawLogcat = readAndroidLogcatCollector(logcatCollector, {
    requireStopped: requireCompleteLogInterval,
  });
  const sanitizedLogcat = sanitizeQaLogcat(rawLogcat);
  const logcatPath = path.join(evidenceRoot, `${resolvedStem}-logcat.txt`);
  fs.writeFileSync(logcatPath, sanitizedLogcat);
  const fatalMatches = scanFatalAndroidLogs(sanitizedLogcat);
  const observedJsSurface = resolveObservedJsSurface(parseUiSnapshot(uiXml));
  const evidence = {
    screenshotPath: resolvedScreenshotPath,
    uiDumpPath,
    logcatPath,
    jsSurface: {
      expected: expectedJsSurface,
      observed: observedJsSurface,
      verified: observedJsSurface === expectedJsSurface,
    },
    fatalScan: {
      checked: true,
      intervalComplete: requireCompleteLogInterval,
      matchCount: fatalMatches.length,
      matchedPatterns: fatalMatches,
    },
  };

  if (!allowValidationFailure && !evidence.jsSurface.verified) {
    const error = new Error(
      `Expected Android JS surface ${expectedJsSurface}, observed ${observedJsSurface}.`
    );
    error.evidence = evidence;
    throw error;
  }
  if (!allowValidationFailure && fatalMatches.length > 0) {
    const error = new Error(
      `Fatal Android/React Native log markers detected: ${fatalMatches.join(", ")}.`
    );
    error.evidence = evidence;
    throw error;
  }

  return evidence;
}

function captureCheckpointEvidence({
  adbPath,
  serial,
  stem,
  expectedJsSurface,
  logcatCollector,
}) {
  return {
    label: stem,
    ...captureEvidenceArtifacts({
      adbPath,
      serial,
      stem: `${stem}-checkpoint`,
      expectedJsSurface,
      logcatCollector,
      requireCompleteLogInterval: false,
    }),
  };
}

function captureScenarioEvidence({
  adbPath,
  serial,
  scenario,
  screenshotPath,
  checkpoints = [],
  allowFatalMatches = false,
  logcatCollector = null,
}) {
  return {
    ...captureEvidenceArtifacts({
      adbPath,
      serial,
      stem: scenario.id,
      screenshotPath,
      expectedJsSurface: scenario.expectedJsSurface || "foreground",
      allowValidationFailure: allowFatalMatches,
      logcatCollector,
    }),
    checkpoints,
    provenancePath: QA_PROVENANCE_PATH,
  };
}

function readQaProvenanceIfPresent() {
  if (!fs.existsSync(QA_PROVENANCE_PATH)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(QA_PROVENANCE_PATH, "utf8"));
  } catch {
    return null;
  }
}

function readAndValidateQaProvenance(adbPath, serial) {
  const provenance = readQaProvenanceIfPresent();
  if (!provenance) {
    throw new ScenarioPreconditionFailureError(
      "Current-head Android QA provenance is missing or unreadable; rebuild and reinstall through android-smoke."
    );
  }
  const gitBeforeDeviceVerification = collectGitProvenance(projectRoot);
  const buildBeforeDeviceVerification = collectCurrentQaBuildProvenance(
    provenance,
    gitBeforeDeviceVerification
  );
  const installedIdentity = readInstalledScenarioPackageIdentity(adbPath, serial, appPackageName);
  const currentGit = collectGitProvenance(projectRoot);
  const currentBuildProvenance = collectCurrentQaBuildProvenance(provenance, currentGit);
  if (!areExactGitProvenancesEqual(gitBeforeDeviceVerification, currentGit)) {
    throw new ScenarioPreconditionFailureError(
      "Current source HEAD/tree/dirty digest changed while Android package provenance was being verified."
    );
  }
  if (buildBeforeDeviceVerification.digest !== currentBuildProvenance.digest) {
    throw new ScenarioPreconditionFailureError(
      "Android build inputs changed while installed-package provenance was being verified."
    );
  }
  return validateQaProvenance({
    provenance,
    currentGit,
    currentBuildProvenance,
    installedIdentity,
    serial,
    packageName: appPackageName,
  });
}

function collectCurrentQaBuildProvenance(provenance, currentGit, options = {}) {
  const storedManifest = provenance?.build?.provenance;
  const variant = provenance?.variant;
  const abi = provenance?.abi;
  if (!storedManifest || !variant || !abi) {
    throw new ScenarioPreconditionFailureError(
      "Android QA provenance cannot be recomputed because its build identity is incomplete."
    );
  }
  const nodeEnv = storedManifest.buildContext?.effectiveBuild?.javascript?.nodeEnv
    || (variant === "release" ? "production" : "development");
  const env = createIsolatedAndroidBuildEnvironment(
    projectRoot,
    process.env,
    { NODE_ENV: nodeEnv }
  );
  const assembleTask = `app:assemble${variant[0].toUpperCase()}${variant.slice(1)}`;
  const gradleArgs = buildGradleAssembleArgs(assembleTask, abi);
  const prebuildInputState = collectPrebuildInputState(projectRoot, {
    variant,
    nodeEnv,
    env,
    hmacKeyPath: options.hmacKeyPath,
  });
  const buildContext = {
    ...(storedManifest.buildContext || {}),
    androidQaEvidence: storedManifest.buildContext?.androidQaEvidence === true,
    effectiveBuild: collectAndroidEffectiveBuildContext(projectRoot, {
      variant,
      gradleArgs,
      env,
    }),
    prebuildInputDigest: prebuildInputState.digest,
  };
  return collectBuildProvenance(projectRoot, {
    variant,
    abi,
    includeBundleInputs: storedManifest.embeddedBundle === true,
    androidRoot,
    env,
    gradleArgs,
    git: currentGit,
    buildContext,
    hmacKeyPath: options.hmacKeyPath,
  });
}

function areExactGitProvenancesEqual(left, right) {
  return Boolean(
    left
    && right
    && left.headSha === right.headSha
    && left.treeSha === right.treeSha
    && left.dirty === right.dirty
    && left.dirtyDigest === right.dirtyDigest
    && left.dirtyEntryCount === right.dirtyEntryCount
  );
}

function validateQaProvenance({
  provenance,
  currentGit,
  currentBuildProvenance,
  installedIdentity,
  serial,
  packageName,
}) {
  const build = provenance?.build;
  const install = provenance?.install;
  const buildManifest = build?.provenance;
  const effectiveVersion = buildManifest?.buildContext?.effectiveBuild?.version;
  const packagedAbis = build?.apk?.packagedAbis;
  const installPackagedAbis = install?.packagedAbis;
  const matchedAbi = build?.apk?.matchedAbi;
  const manifestDigest = buildManifest?.digest;
  const manifestWithoutDigest = buildManifest
    ? Object.fromEntries(Object.entries(buildManifest).filter(([key]) => key !== "digest"))
    : null;
  if (
    provenance?.schemaVersion !== BUILD_PROVENANCE_SCHEMA_VERSION
    || !SUPPORTED_ANDROID_PROVENANCE_ABIS.has(provenance?.abi)
    || build?.schemaVersion !== BUILD_PROVENANCE_SCHEMA_VERSION
    || install?.schemaVersion !== BUILD_PROVENANCE_SCHEMA_VERSION
    || !manifestDigest
    || hashCanonicalJson(manifestWithoutDigest) !== manifestDigest
    || currentBuildProvenance?.digest !== manifestDigest
    || build.provenanceDigest !== manifestDigest
    || build.provenanceDigest !== install.buildProvenanceDigest
    || build.variant !== "release"
    || buildManifest.embeddedBundle !== true
    || buildManifest.buildContext?.androidQaEvidence !== true
    || !build.apk?.sha256
    || build.apk.sha256 !== install.apkSha256
    || build.apk.sha256 !== install.installedApkSha256
    || !Array.isArray(packagedAbis)
    || packagedAbis.length === 0
    || !areExactStringArraysEqual(packagedAbis, installPackagedAbis)
    || !matchedAbi
    || matchedAbi !== install.matchedAbi
    || !install.versionCode
    || !install.versionName
    || `${effectiveVersion?.code ?? ""}` !== `${install.versionCode}`
    || `${effectiveVersion?.name ?? ""}` !== `${install.versionName}`
  ) {
    throw new ScenarioPreconditionFailureError(
      "Android QA build/install provenance chain is stale, tampered, or incomplete."
    );
  }

  if (
    provenance.serial !== serial
    || install.serial !== serial
    || provenance.packageName !== packageName
    || install.packageName !== packageName
    || provenance.variant !== build.variant
    || build.variant !== install.variant
    || provenance.abi !== build.abi
    || build.abi !== install.abi
  ) {
    throw new ScenarioPreconditionFailureError(
      "Android QA provenance belongs to a different device, package, variant, or ABI."
    );
  }

  if (
    !installedIdentity?.installed
    || !installedIdentity.packagePath
    || !installedIdentity.apkSha256
    || installedIdentity.apkSha256 !== build.apk.sha256
    || installedIdentity.versionCode !== install.versionCode
    || installedIdentity.versionName !== install.versionName
    || (install.packagePath && installedIdentity.packagePath !== install.packagePath)
  ) {
    throw new ScenarioPreconditionFailureError(
      "The APK currently installed on the Android target does not match the verified QA artifact."
    );
  }

  const supportedAbis = Array.isArray(installedIdentity.supportedAbis)
    ? installedIdentity.supportedAbis
    : [];
  if (!supportedAbis.includes(matchedAbi)) {
    throw new ScenarioPreconditionFailureError(
      `The current Android target does not advertise the APK ABI ${matchedAbi} selected during verification.`
    );
  }
  if (provenance.abi === "universal") {
    if (!areExactStringArraysEqual(packagedAbis, [...ANDROID_UNIVERSAL_ABIS].sort())) {
      throw new ScenarioPreconditionFailureError(
        "Universal APK provenance must package exactly the canonical Android ABI set."
      );
    }
    if (!packagedAbis.includes(matchedAbi)) {
      throw new ScenarioPreconditionFailureError(
        "Universal APK provenance does not bind its selected device ABI to an actually packaged ABI."
      );
    }
  } else if (
    !areExactStringArraysEqual(packagedAbis, [provenance.abi])
    || matchedAbi !== provenance.abi
  ) {
    throw new ScenarioPreconditionFailureError(
      `Targeted APK provenance must package and select exactly requested ABI ${provenance.abi}.`
    );
  }

  const builtGit = buildManifest.git;
  if (
    !builtGit
    || builtGit.headSha !== currentGit.headSha
    || builtGit.treeSha !== currentGit.treeSha
    || builtGit.dirtyDigest !== currentGit.dirtyDigest
  ) {
    throw new ScenarioPreconditionFailureError(
      "Installed Android APK provenance does not match the current source HEAD/tree/dirty digest."
    );
  }

  return provenance;
}

function areExactStringArraysEqual(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function readInstalledScenarioPackageIdentity(adbPath, serial, packageName) {
  const packagePaths = runCapture(
    adbPath,
    ["-s", serial, "shell", "pm", "path", packageName],
    { allowFailure: true }
  )
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("package:"))
    .map((line) => line.slice("package:".length));
  const packagePath = packagePaths.find((candidate) => candidate.endsWith("/base.apk"))
    || packagePaths[0]
    || null;
  if (!packagePath) {
    return {
      installed: false,
      packagePath: null,
      apkSha256: null,
      versionCode: null,
      versionName: null,
      supportedAbis: readScenarioDeviceAbis(adbPath, serial),
    };
  }

  let apkSha256 = null;
  for (const command of [
    ["shell", "sha256sum", packagePath],
    ["shell", "toybox", "sha256sum", packagePath],
  ]) {
    const output = runCapture(adbPath, ["-s", serial, ...command], { allowFailure: true });
    const match = output.match(/(?:^|\r?\n)\s*([a-fA-F0-9]{64})(?:\s+|$)/);
    if (match) {
      apkSha256 = match[1].toLowerCase();
      break;
    }
  }

  const dumpsys = runCapture(
    adbPath,
    ["-s", serial, "shell", "dumpsys", "package", packageName],
    { allowFailure: true }
  );
  const versionCode = dumpsys.match(/versionCode=(\d+)/)?.[1] || null;
  const versionName = dumpsys.match(/versionName=([^\r\n]+)/)?.[1]?.trim() || null;
  return {
    installed: true,
    packagePath,
    apkSha256,
    versionCode,
    versionName,
    supportedAbis: readScenarioDeviceAbis(adbPath, serial),
  };
}

function readScenarioDeviceAbis(adbPath, serial) {
  const abiList = runCapture(
    adbPath,
    ["-s", serial, "shell", "getprop", "ro.product.cpu.abilist"],
    { allowFailure: true }
  ).trim();
  if (abiList) {
    return abiList.split(",").map((abi) => abi.trim()).filter(Boolean);
  }
  return ["ro.product.cpu.abi", "ro.product.cpu.abi2"]
    .map((property) => runCapture(
      adbPath,
      ["-s", serial, "shell", "getprop", property],
      { allowFailure: true }
    ).trim())
    .filter(Boolean);
}

function summarizeQaProvenance(provenance) {
  if (!provenance) {
    return null;
  }
  const build = provenance.build || {};
  const install = provenance.install || {};
  return {
    schemaVersion: provenance.schemaVersion,
    provenancePath: normalizeReportPath(path.relative(artifactsRoot, QA_PROVENANCE_PATH)),
    packageName: provenance.packageName,
    variant: provenance.variant,
    abi: provenance.abi,
    embeddedBundle: build.provenance?.embeddedBundle === true,
    androidQaEvidence: build.provenance?.buildContext?.androidQaEvidence === true,
    provenanceDigest: build.provenanceDigest,
    apkSha256: build.apk?.sha256 || null,
    packagedAbis: build.apk?.packagedAbis || [],
    matchedAbi: build.apk?.matchedAbi || null,
    installedApkSha256: install.installedApkSha256 || null,
    versionCode: install.versionCode || null,
    versionName: install.versionName || null,
    source: build.provenance?.git || null,
    device: provenance.device || {
      serial: provenance.serial || null,
      model: null,
      abis: [],
    },
  };
}

function writeReport(results) {
  const reportPath = path.join(artifactsRoot, "latest-report.json");
  const summary = results.reduce((accumulator, result) => {
    accumulator[result.status] = (accumulator[result.status] || 0) + 1;
    return accumulator;
  }, {});
  const serializedResults = serializeReportResults(results);
  const report = JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        pack: cliOptions.scenario ? null : cliOptions.pack,
        selectedScenario: cliOptions.scenario,
        scenarioCount: results.length,
        summary,
        provenance: summarizeQaProvenance(activeQaProvenance),
        results: serializedResults,
      },
      null,
      2
    );
  const temporaryPath = `${reportPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, report);
  fs.renameSync(temporaryPath, reportPath);
  log("Wrote machine-readable Android scenario report.");
}

function serializeReportResults(results, roots = {}) {
  const resolvedArtifactsRoot = path.resolve(roots.artifactsRoot || artifactsRoot);
  const resolvedProjectRoot = path.resolve(roots.projectRoot || projectRoot);
  const pathRoots = {
    artifactsRoot: resolvedArtifactsRoot,
    projectRoot: resolvedProjectRoot,
  };

  const sanitizeReportString = (value) => sanitizeAndroidQaText(value, {
    maxChars: REPORT_MAX_STRING_LENGTH,
    sensitiveRoots: [resolvedArtifactsRoot, resolvedProjectRoot],
  });

  const serializeValue = (value, fieldName = null, depth = 0) => {
    if (depth > REPORT_MAX_DEPTH) {
      return "<max-depth>";
    }
    if (Array.isArray(value)) {
      return value
        .slice(0, REPORT_MAX_COLLECTION_ENTRIES)
        .map((entry) => serializeValue(entry, null, depth + 1));
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => !REPORT_PRIVATE_FIELDS.has(key))
          .slice(0, REPORT_MAX_COLLECTION_ENTRIES)
          .map(([key, entry]) => [key, serializeValue(entry, key, depth + 1)])
      );
    }
    if (
      typeof value === "string"
      && fieldName
      && REPORT_ARTIFACT_PATH_FIELDS.includes(fieldName)
    ) {
      return sanitizeReportString(toReportRelativePath(value, pathRoots));
    }
    if (typeof value === "string") {
      return sanitizeReportString(value);
    }
    return value;
  };

  return results.map((result) => serializeValue(result));
}

function toReportRelativePath(filePath, roots) {
  if (!path.isAbsolute(filePath)) {
    return normalizeReportPath(filePath);
  }

  const resolvedPath = path.resolve(filePath);
  const isInsideArtifacts = isPathInsideOrEqual(resolvedPath, roots.artifactsRoot);
  const isInsideProject = isPathInsideOrEqual(resolvedPath, roots.projectRoot);
  if (!isInsideArtifacts && !isInsideProject) {
    return "<external-artifact>";
  }
  const baseRoot = isInsideArtifacts ? roots.artifactsRoot : roots.projectRoot;
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
    apkVariant: null,
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

    if (arg === "--apk-variant") {
      const apkVariant = readCliValue(argv, ++index, "--apk-variant").trim().toLowerCase();
      if (apkVariant !== "debug" && apkVariant !== "release") {
        throw new Error(`Unsupported Android APK variant "${apkVariant}". Expected debug or release.`);
      }
      options.apkVariant = apkVariant;
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
  console.log("  --apk-variant <variant>    Build/install debug or release APK (current-head packs require release)");
  console.log(`  --pack <${[...SCENARIO_PACKS].join("|")}> Run a scenario pack (default: ${DEFAULT_SCENARIO_PACK})`);
  console.log("  --scenario <id>            Run only one scenario");
  console.log("  --skip-build               Reuse the existing debug APK");
  console.log("  --fail-on-skip             Treat skipped scenarios as verification failures");
  console.log("  --preserve-running-app     Do not bootstrap or restart the app before scenarios");
  console.log("  --bootstrap-screenshot     Save a smoke bootstrap screenshot before scenarios");
  console.log("  --port <number>            Forward a specific Metro port to android-smoke");
  console.log("  --list                     Print available scenarios");
}

function runCapture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeout ?? ADB_COMMAND_TIMEOUT_MS,
    maxBuffer: options.maxBuffer ?? LOGCAT_EVIDENCE_MAX_BUFFER_BYTES,
  });

  if (result.error) {
    if (options.allowFailure) {
      return result.error.message || String(result.error);
    }

    throw result.error;
  }

  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    if (options.allowFailure) {
      return result.stdout || stderr || "";
    }

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
  const preferRemoteFile = options.preferRemoteFile ?? !isEmulatorSerial(serial);
  const copyRemoteFileInChunks = options.copyRemoteFileInChunks ?? preferRemoteFile;
  const remoteChunkSizeBytes = options.remoteChunkSizeBytes ?? 32 * 1024;
  const commandTimeoutMs = options.commandTimeoutMs ?? ADB_COMMAND_TIMEOUT_MS;

  const copyRemoteScreenshotInChunks = (remotePath) => {
    const statResult = runSpawnSync(
      adbPath,
      ["-s", serial, "shell", "stat", "-c", "%s", remotePath],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: commandTimeoutMs,
      }
    );
    const remoteSizeBytes = Number.parseInt(String(statResult.stdout || "").trim(), 10);
    if (statResult.error || statResult.status !== 0 || !Number.isSafeInteger(remoteSizeBytes) || remoteSizeBytes <= 0) {
      return {
        ok: false,
        deviceUnavailable: isAdbDeviceUnavailableResult(statResult),
        failure: statResult.error
          ? describeSpawnError("stat remote screenshot", statResult.error)
          : describeSpawnResult("stat remote screenshot", statResult),
      };
    }

    const chunks = [];
    const chunkCount = Math.ceil(remoteSizeBytes / remoteChunkSizeBytes);
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      const expectedChunkBytes = Math.min(
        remoteChunkSizeBytes,
        remoteSizeBytes - chunkIndex * remoteChunkSizeBytes
      );
      let chunkBuffer = null;
      let lastChunkFailure = null;
      let sawChunkDeviceUnavailable = false;

      for (let chunkAttempt = 1; chunkAttempt <= 3; chunkAttempt += 1) {
        const chunkResult = runSpawnSync(
          adbPath,
          [
            "-s",
            serial,
            "exec-out",
            "dd",
            `if=${remotePath}`,
            `bs=${remoteChunkSizeBytes}`,
            `skip=${chunkIndex}`,
            "count=1",
            "status=none",
          ],
          {
            maxBuffer: remoteChunkSizeBytes * 2,
            timeout: commandTimeoutMs,
          }
        );

        if (!chunkResult.error && chunkResult.status === 0 && chunkResult.stdout?.length === expectedChunkBytes) {
          chunkBuffer = chunkResult.stdout;
          break;
        }

        sawChunkDeviceUnavailable = isAdbDeviceUnavailableResult(chunkResult);
        lastChunkFailure = chunkResult.error
          ? describeSpawnError(`read screenshot chunk ${chunkIndex + 1}/${chunkCount}`, chunkResult.error)
          : chunkResult.status === 0
            ? `read screenshot chunk ${chunkIndex + 1}/${chunkCount} returned ${chunkResult.stdout?.length ?? 0}/${expectedChunkBytes} bytes`
            : describeSpawnResult(`read screenshot chunk ${chunkIndex + 1}/${chunkCount}`, chunkResult);

        if (sawChunkDeviceUnavailable) {
          waitForAdbDevice(adbPath, serial, runSpawnSync);
        }
        if (chunkAttempt < 3) {
          runSleepSync(retryDelayMs);
        }
      }

      if (!chunkBuffer) {
        return {
          ok: false,
          deviceUnavailable: sawChunkDeviceUnavailable,
          failure: lastChunkFailure || `Failed to read screenshot chunk ${chunkIndex + 1}/${chunkCount}`,
        };
      }
      chunks.push(chunkBuffer);
    }

    const screenshotBuffer = Buffer.concat(chunks, remoteSizeBytes);
    fs.writeFileSync(screenshotPath, screenshotBuffer);
    if (isCompletePngBuffer(screenshotBuffer)) {
      return { ok: true, deviceUnavailable: false };
    }

    return {
      ok: false,
      deviceUnavailable: false,
      failure: `chunked screenshot was incomplete or invalid (${screenshotBuffer.length} bytes)`,
    };
  };

  const captureDirect = () => {
    const result = runSpawnSync(
      adbPath,
      ["-s", serial, "exec-out", "screencap", "-p"],
      {
        maxBuffer: 20 * 1024 * 1024,
        timeout: commandTimeoutMs,
      }
    );

    if (result.error) {
      return {
        ok: false,
        deviceUnavailable: false,
        failure: describeSpawnError("exec-out screencap", result.error),
      };
    }

    if (result.status === 0 && isCompletePngBuffer(result.stdout)) {
      fs.writeFileSync(screenshotPath, result.stdout);
      return { ok: true, deviceUnavailable: false };
    }

    return {
      ok: false,
      deviceUnavailable: isAdbDeviceUnavailableResult(result),
      failure: result.status === 0
        ? `exec-out screencap returned an incomplete or invalid PNG (${result.stdout?.length ?? 0} bytes)`
        : describeSpawnResult("exec-out screencap", result),
    };
  };

  const captureViaRemoteFile = (attempt) => {
    const remotePath = `/data/local/tmp/pocket-ai-qa-${process.pid}-${Date.now()}-${attempt}.png`;

    try {
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
        return {
          ok: false,
          deviceUnavailable: false,
          failure: describeSpawnError("remote screencap", remoteCapture.error),
        };
      }

      if (remoteCapture.status !== 0) {
        return {
          ok: false,
          deviceUnavailable: isAdbDeviceUnavailableResult(remoteCapture),
          failure: describeSpawnResult("remote screencap", remoteCapture),
        };
      }

      if (copyRemoteFileInChunks) {
        return copyRemoteScreenshotInChunks(remotePath);
      }

      const pullResult = runSpawnSync(
        adbPath,
        ["-s", serial, "pull", remotePath, screenshotPath],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: commandTimeoutMs,
        }
      );

      if (pullResult.error) {
        return {
          ok: false,
          deviceUnavailable: false,
          failure: describeSpawnError("adb pull screenshot", pullResult.error),
        };
      }

      if (pullResult.status !== 0) {
        return {
          ok: false,
          deviceUnavailable: isAdbDeviceUnavailableResult(pullResult),
          failure: describeSpawnResult("adb pull screenshot", pullResult),
        };
      }

      const screenshotBuffer = fs.readFileSync(screenshotPath);
      if (isCompletePngBuffer(screenshotBuffer)) {
        return { ok: true, deviceUnavailable: false };
      }

      return {
        ok: false,
        deviceUnavailable: false,
        failure: `pulled screenshot was incomplete or invalid (${screenshotBuffer.length} bytes)`,
      };
    } finally {
      runSpawnSync(
        adbPath,
        ["-s", serial, "shell", "rm", "-f", remotePath],
        { stdio: "ignore", timeout: commandTimeoutMs }
      );
    }
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let sawAdbDeviceUnavailable = false;

    try {
      fs.rmSync(screenshotPath, { force: true });
      const strategies = preferRemoteFile
        ? [captureViaRemoteFile, captureDirect]
        : [captureDirect, captureViaRemoteFile];

      for (let strategyIndex = 0; strategyIndex < strategies.length; strategyIndex += 1) {
        const result = strategies[strategyIndex](attempt);
        if (result.ok) {
          return screenshotPath;
        }

        failures.push(result.failure);
        sawAdbDeviceUnavailable = sawAdbDeviceUnavailable || result.deviceUnavailable;
        if (result.deviceUnavailable) {
          break;
        }

        if (strategyIndex === 0) {
          log(preferRemoteFile
            ? "Remote-file screencap failed; retrying direct screenshot capture."
            : "Direct screencap failed; retrying screenshot capture via a temporary device file.");
        }
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

function isEmulatorSerial(serial) {
  return serial.startsWith("emulator-");
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || projectRoot,
    stdio: options.stdio || "inherit",
    env: options.env || process.env,
    timeout: options.timeout ?? ADB_COMMAND_TIMEOUT_MS,
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
  BRANCH_REGENERATION_SCENARIOS,
  areExactGitProvenancesEqual,
  assertAuthoritativeThoughtClear,
  assertPreparedAttachmentGenerationEvidence,
  buildAppRouteDeepLinkArgs,
  buildConversationTopology,
  buildScenarios,
  buildPreparedAttachmentSendPrompt,
  buildScenarioLaunchPlan,
  buildSmokeLaunchArgs,
  cleanupScenarioOwnedMetro,
  cleanupTransferredMetroOwnership,
  cleanupAndroidLogcatCollector,
  configureScenarioBuildEnvironment,
  collectCurrentQaBuildProvenance,
  createBranchRegenerationBaseline,
  captureAndroidScreenshot,
  captureSettledScenarioScreenshot,
  activateClearedCatalogFilterOption,
  appPrivatePathExists,
  clearCatalogFiltersIfPresent,
  clearFocusedTextInput,
  CLEAR_TEXT_INPUT_FALLBACK_TOTAL_TIMEOUT_MS,
  DEFAULT_CLEAR_TEXT_INPUT_MAX_DELETE_COUNT,
  dumpUiHierarchy,
  dismissTransientSurfaceWithBack,
  findCatalogRiskModelCard,
  findQuantizationSelectorNodeClearOfBottomOverlay,
  openFirstVisibleVariantPicker,
  prepareCatalogForVariantPickerSmokeScenario,
  findAnyNodeInSnapshot,
  findAttachImageActionInSnapshot,
  findAttachMenuActionInSnapshot,
  findAnyNodeClearOfBottomOverlay,
  findBottomTabNodeInSnapshot,
  findPreparedSentMessageContext,
  findPreparedAssistantResponseNode,
  findTextOnlySentMessageNode,
  findNodeInSnapshot,
  findResourceIdInSnapshot,
  hasConversationHistoryStartAnchor,
  isBoundsClearOfBottomOverlay,
  getBottomTabTapPoint,
  goToHome,
  goToModelCatalog,
  inputFocusedTextAndConfirm,
  installScenarioResourceSignalHandlers,
  isAppForegroundSnapshot,
  findBlockingSystemDialogAction,
  escapeAdbInputText,
  extractVisibleConversationTokens,
  mergeOlderConversationOrder,
  markScenarioFailureRecorded,
  normalizeAndroidResourceId,
  pickClosestNodePair,
  selectScenarios,
  parseCliOptions,
  parseUiSnapshot,
  readAndroidLogcatCollector,
  readAndroidLogcatStartEpoch,
  readTransferredMetroOwnership,
  resolveAndroidPackageUid,
  resolveBranchRegenerationReplacement,
  resolveAndroidQaGenerationGateObservation,
  resolveTargetAttachmentIds,
  restoreLanguageAfterScenario,
  runCapture,
  runChecked,
  sanitizeQaLogcat,
  scanFatalAndroidLogs,
  ScenarioPreconditionFailureError,
  ScenarioSkipError,
  ScenarioSkipFailureError,
  serializeReportResults,
  startAndroidLogcatCollector,
  stopAndroidLogcatCollector,
  setCatalogFilterPanelOpen,
  shouldPrepareMetroForScenarioLaunch,
  shouldAppendRunnerFailure,
  validateQaProvenance,
  waitForAnyNode,
  waitForEnabledAnyNode,
  waitForModelWarmupToSettleIfPresent,
  waitForSettledAttachImageAction,
  tapBottomTabUntilVisible,
  tapBoundsUntilAnyNode,
  assertAttachmentActionBlocked,
  assertAttachmentActionAvailable,
  assertAttachmentPreviewRemovePreconditions,
  assertAttachmentTextOnlyFallbackState,
  isAttachmentActionBusy,
  isPreparedAssistantResponseLabel,
  resolveBranchFixture,
};
