import { createStorage } from './storage';

export const storage = createStorage('pocket-ai-settings');

export interface AppSettings {
    temperature: number;
    topP: number;
    maxTokens: number;
    theme: 'light' | 'dark' | 'system';
    language: string;
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

export function getSettings(): AppSettings {
    const raw = storage.getString(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
}

export function updateSettings(partial: Partial<AppSettings>) {
    const current = getSettings();
    const updated = { ...current, ...partial };
    storage.set(SETTINGS_KEY, JSON.stringify(updated));
    return updated;
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
    return raw ? JSON.parse(raw) : null;
}

export function getChatHistoryIndex(): string[] {
    const raw = storage.getString('chat_history_index');
    return raw ? JSON.parse(raw) : [];
}

export function deleteChatHistory(chatId: string) {
    storage.delete(`${CHAT_HISTORY_PREFIX}${chatId}`);
    const index = getChatHistoryIndex().filter(id => id !== chatId);
    storage.set('chat_history_index', JSON.stringify(index));
}
