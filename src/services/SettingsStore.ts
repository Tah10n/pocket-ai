import { createStorage } from './storage';

export const storage = createStorage('pocket-ai-settings');

export interface AppSettings {
    temperature: number;
    topP: number;
    maxTokens: number;
    theme: 'light' | 'dark' | 'system';
    language: 'en' | 'ru';
    activePresetId: string | null;
    activeModelId: string | null;
    chatRetentionDays: number | null;
}

const DEFAULT_SETTINGS: AppSettings = {
    temperature: 0.7,
    topP: 0.9,
    maxTokens: 2048,
    theme: 'system',
    language: 'en',
    activePresetId: null,
    activeModelId: null,
    chatRetentionDays: 90,
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

function sanitizeSettings(input: Partial<AppSettings>): AppSettings {
    return {
        temperature: clampNumber(input.temperature, 0, 2, DEFAULT_SETTINGS.temperature),
        topP: clampNumber(input.topP, 0, 1, DEFAULT_SETTINGS.topP),
        maxTokens: Math.round(clampNumber(input.maxTokens, 1, 8192, DEFAULT_SETTINGS.maxTokens)),
        theme: input.theme === 'light' || input.theme === 'dark' || input.theme === 'system' ? input.theme : DEFAULT_SETTINGS.theme,
        language: normalizeLanguage(input.language),
        activePresetId: typeof input.activePresetId === 'string' ? input.activePresetId : null,
        activeModelId: typeof input.activeModelId === 'string' ? input.activeModelId : null,
        chatRetentionDays: normalizeChatRetentionDays(input.chatRetentionDays),
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



