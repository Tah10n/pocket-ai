import type { MMKV } from 'react-native-mmkv';
import { createStorage } from './storage';
import { DEFAULT_REASONING_EFFORT, normalizeReasoningEffort, type ReasoningEffort } from '../types/reasoning';
import { MAX_CONTEXT_WINDOW_TOKENS } from '../utils/contextWindow';
import { UNKNOWN_MODEL_GPU_LAYERS_CEILING } from '../utils/modelLimits';
import { DEFAULT_THEME_ID, isThemeId, type ThemeId } from '../utils/themeTokens';

export { UNKNOWN_MODEL_GPU_LAYERS_CEILING };

let storageInstance: MMKV | null = null;

export function getSettingsStorage(): MMKV {
    if (!storageInstance) {
        storageInstance = createStorage('pocket-ai-settings', { tier: 'private' });
    }

    return storageInstance;
}

export type SettingsStorageFacade = Pick<
    MMKV,
    'set' | 'getString' | 'getNumber' | 'getBoolean' | 'remove' | 'clearAll' | 'contains' | 'getAllKeys'
>;

export const storage: SettingsStorageFacade = {
    set: (key: string, value: boolean | string | number | ArrayBuffer) => getSettingsStorage().set(key, value),
    getString: (key: string) => getSettingsStorage().getString(key),
    getNumber: (key: string) => getSettingsStorage().getNumber(key),
    getBoolean: (key: string) => getSettingsStorage().getBoolean(key),
    remove: (key: string) => getSettingsStorage().remove(key),
    clearAll: () => getSettingsStorage().clearAll(),
    contains: (key: string) => getSettingsStorage().contains(key),
    getAllKeys: () => getSettingsStorage().getAllKeys(),
};

export interface GenerationParameters {
    temperature: number;
    topP: number;
    topK: number;
    minP: number;
    repetitionPenalty: number;
    maxTokens: number;
    reasoningEffort?: ReasoningEffort;
    seed: number | null;
}

export type BackendPolicy = 'auto' | 'cpu' | 'gpu' | 'npu';
export type FlashAttentionPolicy = 'auto' | 'on' | 'off';

export interface ModelLoadParameters {
    contextSize: number;
    gpuLayers: number | null;
    kvCacheType: 'auto' | 'f16' | 'q8_0' | 'q4_0';
    backendPolicy?: BackendPolicy;
    selectedBackendDevices?: string[] | null;

    cpuThreads?: number | null;
    cpuMask?: string | null;
    cpuStrict?: boolean;

    flashAttention?: FlashAttentionPolicy;
    useMmap?: boolean;
    useMlock?: boolean;

    parallelSlots?: number;
    nBatch?: number | null;
    nUbatch?: number | null;
    kvUnified?: boolean | null;
}

export type ModelLoadProfileField = 'contextSize' | 'gpuLayers' | 'kvCacheType' | 'backendPolicy';

export interface AppSettings {
    temperature: number;
    topP: number;
    topK: number;
    minP: number;
    repetitionPenalty: number;
    maxTokens: number;
    reasoningEffort?: ReasoningEffort;
    seed: number | null;
    theme: 'light' | 'dark' | 'system';
    themeId: ThemeId;
    language: 'en' | 'ru';
    allowCellularDownloads: boolean;
    showAdvancedInferenceControls?: boolean;
    activePresetId: string | null;
    activeModelId: string | null;
    chatRetentionDays: number | null;
    modelParamsByModelId: Record<string, GenerationParameters>;
    modelLoadParamsByModelId: Record<string, ModelLoadParameters>;
}

export const DEFAULT_GENERATION_PARAMETERS: GenerationParameters = {
    temperature: 0.7,
    topP: 0.9,
    topK: 40,
    minP: 0.05,
    repetitionPenalty: 1,
    maxTokens: 512,
    reasoningEffort: DEFAULT_REASONING_EFFORT,
    seed: null,
};

export const DEFAULT_MODEL_LOAD_PARAMETERS: ModelLoadParameters = {
    contextSize: 4096,
    gpuLayers: null,
    kvCacheType: 'auto',
};

const DEFAULT_SETTINGS: AppSettings = {
    temperature: DEFAULT_GENERATION_PARAMETERS.temperature,
    topP: DEFAULT_GENERATION_PARAMETERS.topP,
    topK: DEFAULT_GENERATION_PARAMETERS.topK,
    minP: DEFAULT_GENERATION_PARAMETERS.minP,
    repetitionPenalty: DEFAULT_GENERATION_PARAMETERS.repetitionPenalty,
    maxTokens: DEFAULT_GENERATION_PARAMETERS.maxTokens,
    reasoningEffort: DEFAULT_GENERATION_PARAMETERS.reasoningEffort,
    seed: DEFAULT_GENERATION_PARAMETERS.seed,
    theme: 'system',
    themeId: DEFAULT_THEME_ID,
    language: 'en',
    allowCellularDownloads: false,
    showAdvancedInferenceControls: false,
    activePresetId: null,
    activeModelId: null,
    chatRetentionDays: 90,
    modelParamsByModelId: {},
    modelLoadParamsByModelId: {},
};

export const SETTINGS_KEY = 'app_settings';
export const CHAT_HISTORY_INDEX_KEY = 'chat_history_index';
export const CHAT_HISTORY_PREFIX = 'chat_history_';

type SettingsListener = (settings: AppSettings) => void;
const settingsListeners: Set<SettingsListener> = new Set();
type ChatHistoryListener = () => void;
const chatHistoryListeners: Set<ChatHistoryListener> = new Set();

function normalizeLanguage(language: unknown): 'en' | 'ru' {
    if (typeof language !== 'string') return DEFAULT_SETTINGS.language;
    const lowered = language.trim().toLowerCase();
    if (!lowered) return DEFAULT_SETTINGS.language;
    if (lowered === 'en' || lowered.startsWith('en-') || lowered.includes('english')) return 'en';
    if (lowered === 'ru' || lowered.startsWith('ru-') || lowered.includes('рус')) return 'ru';
    return DEFAULT_SETTINGS.language;
}

const BACKEND_DEVICE_SELECTOR_REGEX = /^[A-Za-z0-9_*.-]{1,32}$/;
export const MAX_BACKEND_DEVICE_SELECTORS = 10;

export function isSafeBackendDeviceSelector(value: unknown): value is string {
    if (typeof value !== 'string') {
        return false;
    }
    return BACKEND_DEVICE_SELECTOR_REGEX.test(value);
}

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

function normalizeChatRetentionDays(value: unknown): number | null {
    if (value === undefined) {
        return DEFAULT_SETTINGS.chatRetentionDays;
    }

    if (value == null || value === '') {
        return null;
    }

    const normalized = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(normalized) || normalized <= 0) {
        return null;
    }

    return Math.round(normalized);
}

function sanitizeGenerationParameters(input: Partial<GenerationParameters> | undefined): GenerationParameters {
    const rawSeed: unknown = (input as { seed?: unknown } | undefined)?.seed;
    const legacyReasoningEnabled = (input as { reasoningEnabled?: unknown } | undefined)?.reasoningEnabled;
    const seedCandidate = rawSeed == null
        ? null
        : typeof rawSeed === 'number'
          ? rawSeed
          : typeof rawSeed === 'string' && rawSeed.trim().length === 0
            ? null
            : Number(rawSeed);
    const normalizedSeed = seedCandidate === null || !Number.isFinite(seedCandidate)
        ? null
        : (() => {
            const rounded = Math.round(seedCandidate);
            if (rounded < 0) {
                return null;
            }
            return Math.min(2_147_483_647, rounded);
        })();

    return {
        temperature: clampNumber(input?.temperature, 0, 2, DEFAULT_GENERATION_PARAMETERS.temperature),
        topP: clampNumber(input?.topP, 0, 1, DEFAULT_GENERATION_PARAMETERS.topP),
        topK: Math.round(clampNumber(input?.topK, 0, 200, DEFAULT_GENERATION_PARAMETERS.topK)),
        minP: clampNumber(input?.minP, 0, 1, DEFAULT_GENERATION_PARAMETERS.minP),
        repetitionPenalty: clampNumber(input?.repetitionPenalty, 0, 2, DEFAULT_GENERATION_PARAMETERS.repetitionPenalty),
        maxTokens: Math.round(clampNumber(input?.maxTokens, 1, 8192, DEFAULT_GENERATION_PARAMETERS.maxTokens)),
        reasoningEffort: normalizeReasoningEffort(input?.reasoningEffort, legacyReasoningEnabled),
        seed: normalizedSeed,
    };
}

function sanitizeModelParamsByModelId(input: unknown): Record<string, GenerationParameters> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return {};
    }

    return Object.entries(input).reduce<Record<string, GenerationParameters>>((acc, [modelId, params]) => {
        const normalizedModelId = typeof modelId === 'string' ? modelId.trim() : '';
        if (!normalizedModelId) {
            return acc;
        }

        acc[normalizedModelId] = sanitizeGenerationParameters(params as Partial<GenerationParameters>);
        return acc;
    }, {});
}

function sanitizeModelLoadParameters(input: Partial<ModelLoadParameters> | undefined): ModelLoadParameters {
    const rawGpuLayers = input?.gpuLayers;
    const normalizedGpuLayers =
        rawGpuLayers == null
            ? null
            : Math.round(clampNumber(rawGpuLayers, 0, UNKNOWN_MODEL_GPU_LAYERS_CEILING, DEFAULT_MODEL_LOAD_PARAMETERS.gpuLayers ?? 0));

    const rawKvCacheType = typeof input?.kvCacheType === 'string' ? input.kvCacheType.trim().toLowerCase() : '';
    const normalizedKvCacheType =
        rawKvCacheType === 'auto'
            ? 'auto'
            : rawKvCacheType === 'f16' || rawKvCacheType === 'fp16'
              ? 'f16'
              : rawKvCacheType === 'q8_0' || rawKvCacheType === 'q8'
                ? 'q8_0'
                : rawKvCacheType === 'q4_0' || rawKvCacheType === 'q4'
                  ? 'q4_0'
                  : DEFAULT_MODEL_LOAD_PARAMETERS.kvCacheType;

    const rawBackendPolicy = typeof input?.backendPolicy === 'string' ? input.backendPolicy.trim().toLowerCase() : '';
    const normalizedBackendPolicy =
        rawBackendPolicy === 'cpu'
            ? 'cpu'
            : rawBackendPolicy === 'gpu'
                ? 'gpu'
                : rawBackendPolicy === 'npu'
                  ? 'npu'
                    : undefined;

    let normalizedSelectedBackendDevices: string[] | null | undefined;
    if (input?.selectedBackendDevices === null) {
        normalizedSelectedBackendDevices = null;
    } else if (Array.isArray(input?.selectedBackendDevices)) {
        const sanitized = input.selectedBackendDevices
            .map((device) => (typeof device === 'string' ? device.trim() : ''))
            .filter(isSafeBackendDeviceSelector);
        const deduped = Array.from(new Set(sanitized)).slice(0, MAX_BACKEND_DEVICE_SELECTORS);
        normalizedSelectedBackendDevices = deduped.length > 0 ? deduped : null;
    } else {
        normalizedSelectedBackendDevices = undefined;
    }

    const rawCpuThreads = input?.cpuThreads;
    const normalizedCpuThreads =
        rawCpuThreads === null
            ? null
            : typeof rawCpuThreads === 'number' || typeof rawCpuThreads === 'string'
              ? Math.round(clampNumber(rawCpuThreads, 1, 64, 0)) || null
              : rawCpuThreads === undefined
                ? undefined
                : null;

    const rawCpuMask = input?.cpuMask;
    const normalizedCpuMask =
        rawCpuMask === null
            ? null
            : typeof rawCpuMask === 'string'
              ? (rawCpuMask.trim().length > 0 ? rawCpuMask.trim() : null)
              : rawCpuMask === undefined
                ? undefined
                : null;

    const rawCpuStrict = input?.cpuStrict;
    const normalizedCpuStrict = typeof rawCpuStrict === 'boolean' ? rawCpuStrict : undefined;

    const rawFlashAttention = typeof input?.flashAttention === 'string' ? input.flashAttention.trim().toLowerCase() : '';
    const normalizedFlashAttention =
        rawFlashAttention === 'auto'
            ? 'auto'
            : rawFlashAttention === 'on'
              ? 'on'
              : rawFlashAttention === 'off'
                ? 'off'
                : undefined;

    const rawUseMmap = input?.useMmap;
    const normalizedUseMmap = typeof rawUseMmap === 'boolean' ? rawUseMmap : undefined;
    const rawUseMlock = input?.useMlock;
    const normalizedUseMlock = typeof rawUseMlock === 'boolean' ? rawUseMlock : undefined;

    const rawParallelSlots = input?.parallelSlots;
    const normalizedParallelSlots =
        rawParallelSlots === undefined
            ? undefined
            : 1;

    const rawNBatch = input?.nBatch;
    const normalizedNBatch =
        rawNBatch === null
            ? null
            : typeof rawNBatch === 'number' || typeof rawNBatch === 'string'
              ? Math.round(clampNumber(rawNBatch, 1, 4096, 0)) || null
              : rawNBatch === undefined
                ? undefined
                : null;

    const rawNUbatch = input?.nUbatch;
    const normalizedNUbatch =
        rawNUbatch === null
            ? null
            : typeof rawNUbatch === 'number' || typeof rawNUbatch === 'string'
              ? Math.round(clampNumber(rawNUbatch, 1, 4096, 0)) || null
              : rawNUbatch === undefined
                ? undefined
                : null;

    const rawKvUnified = input?.kvUnified;
    const normalizedKvUnified =
        rawKvUnified === null
            ? null
            : typeof rawKvUnified === 'boolean'
              ? rawKvUnified
              : rawKvUnified === undefined
                ? undefined
                : null;

    const sanitized: ModelLoadParameters = {
        contextSize: Math.round(clampNumber(
            input?.contextSize,
            512,
            MAX_CONTEXT_WINDOW_TOKENS,
            DEFAULT_MODEL_LOAD_PARAMETERS.contextSize,
        )),
        gpuLayers: normalizedGpuLayers,
        kvCacheType: normalizedKvCacheType,
    };

    if (normalizedBackendPolicy) {
        sanitized.backendPolicy = normalizedBackendPolicy;
    }

    if (normalizedSelectedBackendDevices !== undefined) {
        sanitized.selectedBackendDevices = normalizedSelectedBackendDevices;
    }

    if (normalizedCpuThreads !== undefined) {
        sanitized.cpuThreads = normalizedCpuThreads;
    }

    if (normalizedCpuMask !== undefined) {
        sanitized.cpuMask = normalizedCpuMask;
    }

    if (normalizedCpuStrict !== undefined) {
        sanitized.cpuStrict = normalizedCpuStrict;
    }

    if (normalizedFlashAttention) {
        sanitized.flashAttention = normalizedFlashAttention;
    }

    if (normalizedUseMmap !== undefined) {
        sanitized.useMmap = normalizedUseMmap;
    }

    if (normalizedUseMlock !== undefined) {
        sanitized.useMlock = normalizedUseMlock;
    }

    if (normalizedParallelSlots !== undefined) {
        sanitized.parallelSlots = normalizedParallelSlots;
    }

    if (normalizedNBatch !== undefined) {
        sanitized.nBatch = normalizedNBatch;
    }

    if (normalizedNUbatch !== undefined) {
        sanitized.nUbatch = normalizedNUbatch;
    }

    if (normalizedKvUnified !== undefined) {
        sanitized.kvUnified = normalizedKvUnified;
    }

    return sanitized;
}

function sanitizeModelLoadParamsByModelId(input: unknown): Record<string, ModelLoadParameters> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return {};
    }

    return Object.entries(input).reduce<Record<string, ModelLoadParameters>>((acc, [modelId, params]) => {
        const normalizedModelId = typeof modelId === 'string' ? modelId.trim() : '';
        if (!normalizedModelId) {
            return acc;
        }

        acc[normalizedModelId] = sanitizeModelLoadParameters(params as Partial<ModelLoadParameters>);
        return acc;
    }, {});
}

function sanitizeSettings(input: Partial<AppSettings>): AppSettings {
    const generationDefaults = sanitizeGenerationParameters(input);

    return {
        temperature: generationDefaults.temperature,
        topP: generationDefaults.topP,
        topK: generationDefaults.topK,
        minP: generationDefaults.minP,
        repetitionPenalty: generationDefaults.repetitionPenalty,
        maxTokens: generationDefaults.maxTokens,
        reasoningEffort: generationDefaults.reasoningEffort,
        seed: generationDefaults.seed,
        theme: input.theme === 'light' || input.theme === 'dark' || input.theme === 'system' ? input.theme : DEFAULT_SETTINGS.theme,
        themeId: isThemeId(input.themeId) ? input.themeId : DEFAULT_SETTINGS.themeId,
        language: normalizeLanguage(input.language),
        allowCellularDownloads: typeof input.allowCellularDownloads === 'boolean'
            ? input.allowCellularDownloads
            : DEFAULT_SETTINGS.allowCellularDownloads,
        showAdvancedInferenceControls: typeof input.showAdvancedInferenceControls === 'boolean'
            ? input.showAdvancedInferenceControls
            : DEFAULT_SETTINGS.showAdvancedInferenceControls,
        activePresetId: typeof input.activePresetId === 'string' ? input.activePresetId : null,
        activeModelId: typeof input.activeModelId === 'string' ? input.activeModelId : null,
        chatRetentionDays: normalizeChatRetentionDays(input.chatRetentionDays),
        modelParamsByModelId: sanitizeModelParamsByModelId(input.modelParamsByModelId),
        modelLoadParamsByModelId: sanitizeModelLoadParamsByModelId(input.modelLoadParamsByModelId),
    };
}

function readJsonValue<T>(key: string): T | null {
    const raw = getSettingsStorage().getString(key);
    if (!raw) {
        return null;
    }

    try {
        return JSON.parse(raw) as T;
    } catch (error) {
        console.warn(`[SettingsStore] Corrupted JSON payload (${key}), removing.`, error);
        getSettingsStorage().remove(key);
        return null;
    }
}

function writeJsonValue(key: string, value: unknown) {
    getSettingsStorage().set(key, JSON.stringify(value));
}

export function getSettings(): AppSettings {
    const parsed = readJsonValue<Partial<AppSettings>>(SETTINGS_KEY);
    if (!parsed) {
        return { ...DEFAULT_SETTINGS };
    }

    const hasExplicitChatRetention =
        typeof parsed === 'object' &&
        parsed !== null &&
        Object.prototype.hasOwnProperty.call(parsed, 'chatRetentionDays');
    const hasExplicitReasoningEffort =
        typeof parsed === 'object' &&
        parsed !== null &&
        Object.prototype.hasOwnProperty.call(parsed, 'reasoningEffort');
    const hasValidPersistedThemeId =
        typeof parsed === 'object' &&
        parsed !== null &&
        Object.prototype.hasOwnProperty.call(parsed, 'themeId') &&
        isThemeId(parsed.themeId);

    const sanitized = sanitizeSettings({
        ...DEFAULT_SETTINGS,
        ...parsed,
        reasoningEffort: hasExplicitReasoningEffort ? parsed.reasoningEffort : undefined,
        chatRetentionDays: hasExplicitChatRetention ? parsed.chatRetentionDays : null,
    });

    if (!hasValidPersistedThemeId) {
        writeJsonValue(SETTINGS_KEY, sanitized);
    }

    return sanitized;
}

export function updateSettings(partial: Partial<AppSettings>) {
    const current = getSettings();
    const updated = sanitizeSettings({ ...current, ...partial });
    writeJsonValue(SETTINGS_KEY, updated);
    settingsListeners.forEach((l) => l(updated));
    return updated;
}

export function resetSettings() {
    getSettingsStorage().remove(SETTINGS_KEY);
    const defaults = { ...DEFAULT_SETTINGS };
    settingsListeners.forEach((listener) => listener(defaults));
    return defaults;
}

export function resetParameters() {
    return updateSettings({
        temperature: DEFAULT_GENERATION_PARAMETERS.temperature,
        topP: DEFAULT_GENERATION_PARAMETERS.topP,
        topK: DEFAULT_GENERATION_PARAMETERS.topK,
        minP: DEFAULT_GENERATION_PARAMETERS.minP,
        repetitionPenalty: DEFAULT_GENERATION_PARAMETERS.repetitionPenalty,
        maxTokens: DEFAULT_GENERATION_PARAMETERS.maxTokens,
        reasoningEffort: DEFAULT_GENERATION_PARAMETERS.reasoningEffort,
        seed: DEFAULT_GENERATION_PARAMETERS.seed,
    });
}

export function getGenerationParametersForModel(modelId: string | null | undefined): GenerationParameters {
    const settings = getSettings();
    const normalizedModelId = typeof modelId === 'string' ? modelId.trim() : '';
    if (!normalizedModelId) {
        return sanitizeGenerationParameters(settings);
    }

    const storedParams = settings.modelParamsByModelId?.[normalizedModelId];
    if (storedParams) {
        return sanitizeGenerationParameters(storedParams);
    }

    return sanitizeGenerationParameters(settings);
}

export function updateGenerationParametersForModel(
    modelId: string | null | undefined,
    partial: Partial<GenerationParameters>,
) {
    const normalizedModelId = typeof modelId === 'string' ? modelId.trim() : '';
    const currentSettings = getSettings();
    const nextParams = sanitizeGenerationParameters({
        ...getGenerationParametersForModel(normalizedModelId),
        ...partial,
    });

    if (!normalizedModelId) {
        return updateSettings(nextParams);
    }

    return updateSettings({
        modelParamsByModelId: {
            ...currentSettings.modelParamsByModelId,
            [normalizedModelId]: nextParams,
        },
    });
}

export function resetGenerationParametersForModel(modelId: string | null | undefined) {
    const normalizedModelId = typeof modelId === 'string' ? modelId.trim() : '';
    const currentSettings = getSettings();

    if (!normalizedModelId) {
        return updateSettings(DEFAULT_GENERATION_PARAMETERS);
    }

    const nextModelParamsByModelId = { ...currentSettings.modelParamsByModelId };
    delete nextModelParamsByModelId[normalizedModelId];

    return updateSettings({
        modelParamsByModelId: nextModelParamsByModelId,
    });
}

export function getModelLoadParametersForModel(modelId: string | null | undefined): ModelLoadParameters {
    const settings = getSettings();
    const normalizedModelId = typeof modelId === 'string' ? modelId.trim() : '';
    if (!normalizedModelId) {
        return { ...DEFAULT_MODEL_LOAD_PARAMETERS };
    }

    const storedParams = settings.modelLoadParamsByModelId?.[normalizedModelId];
    if (storedParams) {
        return sanitizeModelLoadParameters(storedParams);
    }

    return { ...DEFAULT_MODEL_LOAD_PARAMETERS };
}

export function updateModelLoadParametersForModel(
    modelId: string | null | undefined,
    partial: Partial<ModelLoadParameters>,
) {
    const normalizedModelId = typeof modelId === 'string' ? modelId.trim() : '';
    if (!normalizedModelId) {
        return getSettings();
    }

    const currentSettings = getSettings();
    const nextParams = sanitizeModelLoadParameters({
        ...getModelLoadParametersForModel(normalizedModelId),
        ...partial,
    });

    return updateSettings({
        modelLoadParamsByModelId: {
            ...currentSettings.modelLoadParamsByModelId,
            [normalizedModelId]: nextParams,
        },
    });
}

export function resetModelLoadParametersForModel(modelId: string | null | undefined) {
    const normalizedModelId = typeof modelId === 'string' ? modelId.trim() : '';
    if (!normalizedModelId) {
        return getSettings();
    }

    const currentSettings = getSettings();
    const nextModelLoadParamsByModelId = { ...currentSettings.modelLoadParamsByModelId };
    delete nextModelLoadParamsByModelId[normalizedModelId];

    return updateSettings({
        modelLoadParamsByModelId: nextModelLoadParamsByModelId,
    });
}

export function resetAllParametersForModel(modelId: string | null | undefined) {
    const normalizedModelId = typeof modelId === 'string' ? modelId.trim() : '';
    if (!normalizedModelId) {
        return getSettings();
    }

    const currentSettings = getSettings();
    const nextModelParamsByModelId = { ...currentSettings.modelParamsByModelId };
    const nextModelLoadParamsByModelId = { ...currentSettings.modelLoadParamsByModelId };

    delete nextModelParamsByModelId[normalizedModelId];
    delete nextModelLoadParamsByModelId[normalizedModelId];

    return updateSettings({
        modelParamsByModelId: nextModelParamsByModelId,
        modelLoadParamsByModelId: nextModelLoadParamsByModelId,
    });
}

export function subscribeSettings(listener: SettingsListener) {
    settingsListeners.add(listener);
    listener(getSettings());
    return () => {
        settingsListeners.delete(listener);
    };
}

function notifyChatHistoryListeners() {
    chatHistoryListeners.forEach((listener) => listener());
}

export function subscribeChatHistory(listener: ChatHistoryListener) {
    chatHistoryListeners.add(listener);
    listener();
    return () => {
        chatHistoryListeners.delete(listener);
    };
}

export interface ChatHistoryEntry {
    id: string;
    messages: { role: 'user' | 'assistant' | 'system'; content: string }[];
    modelId: string;
    presetId: string | null;
    createdAt: number;
    updatedAt: number;
}

export interface ChatHistorySummary {
    id: string;
    title: string;
    modelId: string;
    presetId: string | null;
    createdAt: number;
    updatedAt: number;
}

function getChatHistoryStorageKey(chatId: string) {
    return `${CHAT_HISTORY_PREFIX}${chatId}`;
}

function sanitizeChatHistoryIndex(input: unknown): string[] {
    if (!Array.isArray(input)) {
        return [];
    }

    const uniqueIds = new Set<string>();
    for (const value of input) {
        if (typeof value !== 'string') {
            continue;
        }

        const normalized = value.trim();
        if (!normalized) {
            continue;
        }

        uniqueIds.add(normalized);
    }

    return [...uniqueIds];
}

function readChatHistoryIndex() {
    return readJsonValue<unknown>(CHAT_HISTORY_INDEX_KEY);
}

function writeChatHistoryIndex(index: string[]) {
    if (index.length === 0) {
        getSettingsStorage().remove(CHAT_HISTORY_INDEX_KEY);
        return;
    }

    writeJsonValue(CHAT_HISTORY_INDEX_KEY, index);
}

function loadChatHistoryEntry(chatId: string): ChatHistoryEntry | null {
    return readJsonValue<ChatHistoryEntry>(getChatHistoryStorageKey(chatId));
}

function getIndexedChatHistoryEntries(): ChatHistoryEntry[] {
    return getChatHistoryIndex()
        .map((id) => getChatHistory(id))
        .filter((entry): entry is ChatHistoryEntry => !!entry);
}

export function getChatHistoryEntries(limit?: number): ChatHistoryEntry[] {
    const entries = getIndexedChatHistoryEntries()
        .sort((left, right) => right.updatedAt - left.updatedAt);

    return typeof limit === 'number' ? entries.slice(0, limit) : entries;
}

function deriveChatTitle(entry: ChatHistoryEntry): string {
    const firstUserMessage = entry.messages.find((message) => message.role === 'user' && message.content.trim().length > 0);
    if (!firstUserMessage) {
        return 'New Conversation';
    }

    const normalized = firstUserMessage.content.replace(/\s+/g, ' ').trim();
    return normalized.length > 48 ? `${normalized.slice(0, 45)}...` : normalized;
}

export function saveChatHistory(entry: ChatHistoryEntry) {
    writeJsonValue(getChatHistoryStorageKey(entry.id), entry);

    const index = getChatHistoryIndex();
    if (!index.includes(entry.id)) {
        writeChatHistoryIndex([...index, entry.id]);
    }

    notifyChatHistoryListeners();
}

export function getChatHistory(chatId: string): ChatHistoryEntry | null {
    return loadChatHistoryEntry(chatId);
}

export function getChatHistoryIndex(): string[] {
    const parsed = readChatHistoryIndex();
    if (!parsed) {
        return [];
    }

    const sanitized = sanitizeChatHistoryIndex(parsed);
    const shouldRewrite =
        !Array.isArray(parsed) ||
        sanitized.length !== parsed.length ||
        sanitized.some((id, index) => id !== parsed[index]);

    if (shouldRewrite) {
        writeChatHistoryIndex(sanitized);
    }

    return sanitized;
}

export function deleteChatHistory(chatId: string) {
    getSettingsStorage().remove(getChatHistoryStorageKey(chatId));
    const index = getChatHistoryIndex().filter(id => id !== chatId);
    writeChatHistoryIndex(index);
    notifyChatHistoryListeners();
}

export function clearLegacyChatHistory() {
    const indexedIds = getChatHistoryIndex();
    const legacyKeys = getSettingsStorage()
        .getAllKeys()
        .filter((key) => key !== CHAT_HISTORY_INDEX_KEY && key.startsWith(CHAT_HISTORY_PREFIX));
    const clearedConversationIds = new Set<string>(indexedIds);

    legacyKeys.forEach((key) => {
        clearedConversationIds.add(key.slice(CHAT_HISTORY_PREFIX.length));
        getSettingsStorage().remove(key);
    });

    writeChatHistoryIndex([]);

    if (indexedIds.length > 0 || legacyKeys.length > 0) {
        notifyChatHistoryListeners();
    }

    return clearedConversationIds.size;
}

export function repairChatHistoryIndex() {
    const index = getChatHistoryIndex();
    if (index.length === 0) return { removed: 0, total: 0 };

    const repaired = index.filter((id) => !!getChatHistory(id));
    const removed = index.length - repaired.length;

    if (removed > 0) {
        writeChatHistoryIndex(repaired);
        notifyChatHistoryListeners();
    }

    return { removed, total: index.length };
}

export function getChatHistorySummaries(limit?: number): ChatHistorySummary[] {
    const slicedEntries = getChatHistoryEntries(limit);
    return slicedEntries.map((entry) => ({
        id: entry.id,
        title: deriveChatTitle(entry),
        modelId: entry.modelId,
        presetId: entry.presetId,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
    }));
}



