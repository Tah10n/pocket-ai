import { createStorage } from './storage';

export const storage = createStorage('pocket-ai-settings');

export interface AppSettings {
    temperature: number;
    topP: number;
    maxTokens: number;
    theme: 'light' | 'dark' | 'system';
    language: 'en' | 'ru';
    activePresetId: string | null;
}

const DEFAULT_SETTINGS: AppSettings = {
    temperature: 0.7,
    topP: 0.9,
    maxTokens: 2048,
    theme: 'system',
    language: 'en',
    activePresetId: null,
};

const SETTINGS_KEY = 'app_settings';

type SettingsListener = (settings: AppSettings) => void;
const settingsListeners: Set<SettingsListener> = new Set();

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

function sanitizeSettings(input: Partial<AppSettings>): AppSettings {
    return {
        temperature: clampNumber(input.temperature, 0, 2, DEFAULT_SETTINGS.temperature),
        topP: clampNumber(input.topP, 0, 1, DEFAULT_SETTINGS.topP),
        maxTokens: Math.round(clampNumber(input.maxTokens, 1, 8192, DEFAULT_SETTINGS.maxTokens)),
        theme: input.theme === 'light' || input.theme === 'dark' || input.theme === 'system' ? input.theme : DEFAULT_SETTINGS.theme,
        language: normalizeLanguage(input.language),
        activePresetId: typeof input.activePresetId === 'string' ? input.activePresetId : null,
    };
}

export function getSettings(): AppSettings {
    const raw = storage.getString(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    try {
        const parsed = JSON.parse(raw) as Partial<AppSettings>;
        return sanitizeSettings({ ...DEFAULT_SETTINGS, ...parsed });
    } catch (e) {
        console.warn('[SettingsStore] Corrupted settings payload, resetting.', e);
        storage.remove(SETTINGS_KEY);
        return { ...DEFAULT_SETTINGS };
    }
}

export function updateSettings(partial: Partial<AppSettings>) {
    const current = getSettings();
    const updated = sanitizeSettings({ ...current, ...partial });
    storage.set(SETTINGS_KEY, JSON.stringify(updated));
    settingsListeners.forEach((l) => l(updated));
    return updated;
}

export function subscribeSettings(listener: SettingsListener) {
    settingsListeners.add(listener);
    listener(getSettings());
    return () => settingsListeners.delete(listener);
}

// Chat history persistence
const CHAT_HISTORY_PREFIX = 'chat_history_';

export interface ChatHistoryEntry {
    id: string;
    messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
    modelId: string;
    presetId: string | null;
    createdAt: number;
    updatedAt: number;
}

export function saveChatHistory(entry: ChatHistoryEntry) {
    storage.set(`${CHAT_HISTORY_PREFIX}${entry.id}`, JSON.stringify(entry));

    // Update index
    const index = getChatHistoryIndex();
    if (!index.includes(entry.id)) {
        index.push(entry.id);
        storage.set('chat_history_index', JSON.stringify(index));
    }
}

export function getChatHistory(chatId: string): ChatHistoryEntry | null {
    const raw = storage.getString(`${CHAT_HISTORY_PREFIX}${chatId}`);
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch (e) {
        console.warn(`[SettingsStore] Corrupted chat history entry (${chatId}), removing.`, e);
        storage.remove(`${CHAT_HISTORY_PREFIX}${chatId}`);
        return null;
    }
}

export function getChatHistoryIndex(): string[] {
    const raw = storage.getString('chat_history_index');
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        console.warn('[SettingsStore] Corrupted chat history index, resetting.', e);
        storage.remove('chat_history_index');
        return [];
    }
}

export function deleteChatHistory(chatId: string) {
    storage.remove(`${CHAT_HISTORY_PREFIX}${chatId}`);
    const index = getChatHistoryIndex().filter(id => id !== chatId);
    storage.set('chat_history_index', JSON.stringify(index));
}

export function repairChatHistoryIndex() {
    const index = getChatHistoryIndex();
    if (index.length === 0) return { removed: 0, total: 0 };

    const repaired = index.filter((id) => !!getChatHistory(id));
    const removed = index.length - repaired.length;

    if (removed > 0) {
        storage.set('chat_history_index', JSON.stringify(repaired));
    }

    return { removed, total: index.length };
}



