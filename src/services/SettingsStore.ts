import { createStorage } from './storage';

export const storage = createStorage('pocket-ai-settings');

export interface GenerationParameters {
    temperature: number;
    topP: number;
    maxTokens: number;
}

export interface ModelLoadParameters {
    contextSize: number;
    gpuLayers: number | null;
}

export interface AppSettings {
    temperature: number;
    topP: number;
    maxTokens: number;
    theme: 'light' | 'dark' | 'system';
    language: 'en' | 'ru';
    activePresetId: string | null;
    activeModelId: string | null;
    chatRetentionDays: number | null;
    modelParamsByModelId: Record<string, GenerationParameters>;
    modelLoadParamsByModelId: Record<string, ModelLoadParameters>;
}

export const DEFAULT_GENERATION_PARAMETERS: GenerationParameters = {
    temperature: 0.7,
    topP: 0.9,
    maxTokens: 2048,
};

export const DEFAULT_MODEL_LOAD_PARAMETERS: ModelLoadParameters = {
    contextSize: 2048,
    gpuLayers: null,
};

const DEFAULT_SETTINGS: AppSettings = {
    temperature: DEFAULT_GENERATION_PARAMETERS.temperature,
    topP: DEFAULT_GENERATION_PARAMETERS.topP,
    maxTokens: DEFAULT_GENERATION_PARAMETERS.maxTokens,
    theme: 'system',
    language: 'en',
    activePresetId: null,
    activeModelId: null,
    chatRetentionDays: 90,
    modelParamsByModelId: {},
    modelLoadParamsByModelId: {},
};

const SETTINGS_KEY = 'app_settings';
const CHAT_HISTORY_INDEX_KEY = 'chat_history_index';
const CHAT_HISTORY_PREFIX = 'chat_history_';

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
    return {
        temperature: clampNumber(input?.temperature, 0, 2, DEFAULT_GENERATION_PARAMETERS.temperature),
        topP: clampNumber(input?.topP, 0, 1, DEFAULT_GENERATION_PARAMETERS.topP),
        maxTokens: Math.round(clampNumber(input?.maxTokens, 1, 8192, DEFAULT_GENERATION_PARAMETERS.maxTokens)),
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
            : Math.round(clampNumber(rawGpuLayers, 0, 80, DEFAULT_MODEL_LOAD_PARAMETERS.gpuLayers ?? 0));

    return {
        contextSize: Math.round(clampNumber(input?.contextSize, 512, 8192, DEFAULT_MODEL_LOAD_PARAMETERS.contextSize)),
        gpuLayers: normalizedGpuLayers,
    };
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
        maxTokens: generationDefaults.maxTokens,
        theme: input.theme === 'light' || input.theme === 'dark' || input.theme === 'system' ? input.theme : DEFAULT_SETTINGS.theme,
        language: normalizeLanguage(input.language),
        activePresetId: typeof input.activePresetId === 'string' ? input.activePresetId : null,
        activeModelId: typeof input.activeModelId === 'string' ? input.activeModelId : null,
        chatRetentionDays: normalizeChatRetentionDays(input.chatRetentionDays),
        modelParamsByModelId: sanitizeModelParamsByModelId(input.modelParamsByModelId),
        modelLoadParamsByModelId: sanitizeModelLoadParamsByModelId(input.modelLoadParamsByModelId),
    };
}

function readJsonValue<T>(key: string): T | null {
    const raw = storage.getString(key);
    if (!raw) {
        return null;
    }

    try {
        return JSON.parse(raw) as T;
    } catch (error) {
        console.warn(`[SettingsStore] Corrupted JSON payload (${key}), removing.`, error);
        storage.remove(key);
        return null;
    }
}

function writeJsonValue(key: string, value: unknown) {
    storage.set(key, JSON.stringify(value));
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

    return sanitizeSettings({
        ...DEFAULT_SETTINGS,
        ...parsed,
        chatRetentionDays: hasExplicitChatRetention ? parsed.chatRetentionDays : null,
    });
}

export function updateSettings(partial: Partial<AppSettings>) {
    const current = getSettings();
    const updated = sanitizeSettings({ ...current, ...partial });
    writeJsonValue(SETTINGS_KEY, updated);
    settingsListeners.forEach((l) => l(updated));
    return updated;
}

export function resetParameters() {
    return updateSettings({
        temperature: DEFAULT_GENERATION_PARAMETERS.temperature,
        topP: DEFAULT_GENERATION_PARAMETERS.topP,
        maxTokens: DEFAULT_GENERATION_PARAMETERS.maxTokens,
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
    storage.remove(getChatHistoryStorageKey(chatId));
    const index = getChatHistoryIndex().filter(id => id !== chatId);
    writeChatHistoryIndex(index);
    notifyChatHistoryListeners();
}

export function clearLegacyChatHistory() {
    const indexedIds = getChatHistoryIndex();
    const legacyKeys = storage
        .getAllKeys()
        .filter((key) => key !== CHAT_HISTORY_INDEX_KEY && key.startsWith(CHAT_HISTORY_PREFIX));
    const clearedConversationIds = new Set<string>(indexedIds);

    legacyKeys.forEach((key) => {
        clearedConversationIds.add(key.slice(CHAT_HISTORY_PREFIX.length));
        storage.remove(key);
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



