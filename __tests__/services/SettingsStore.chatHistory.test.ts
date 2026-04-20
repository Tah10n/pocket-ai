import {
  CHAT_HISTORY_INDEX_KEY,
  CHAT_HISTORY_PREFIX,
  deleteChatHistory,
  getChatHistory,
  getChatHistoryEntries,
  getChatHistoryIndex,
  getChatHistorySummaries,
  getSettingsStorage,
  repairChatHistoryIndex,
  saveChatHistory,
  subscribeChatHistory,
  clearLegacyChatHistory,
} from '../../src/services/SettingsStore';

type ChatHistoryEntry = Parameters<typeof saveChatHistory>[0];

function buildEntry(overrides: Partial<ChatHistoryEntry> = {}): ChatHistoryEntry {
  const now = Date.now();
  return {
    id: 'chat-1',
    modelId: 'model',
    presetId: null,
    createdAt: now - 1000,
    updatedAt: now,
    messages: [
      { role: 'user', content: 'Hello world' },
      { role: 'assistant', content: 'Hi' },
    ],
    ...overrides,
  } as any;
}

describe('SettingsStore chat history', () => {
  beforeEach(() => {
    getSettingsStorage().clearAll();
  });

  it('sanitizes and rewrites an invalid chat history index', () => {
    getSettingsStorage().set(CHAT_HISTORY_INDEX_KEY, JSON.stringify([' ', 'a', 'a', 42, ' b ', '']));

    const index = getChatHistoryIndex();
    expect(index).toEqual(['a', 'b']);

    // should have rewritten the index
    expect(JSON.parse(getSettingsStorage().getString(CHAT_HISTORY_INDEX_KEY) as string)).toEqual(['a', 'b']);
  });

  it('persists entries and keeps index unique', () => {
    saveChatHistory(buildEntry({ id: 'chat-1' }));
    saveChatHistory(buildEntry({ id: 'chat-2', updatedAt: Date.now() + 1 }));
    saveChatHistory(buildEntry({ id: 'chat-2', updatedAt: Date.now() + 2 }));

    expect(getChatHistoryIndex().sort()).toEqual(['chat-1', 'chat-2']);
    expect(getChatHistory('chat-2')?.id).toBe('chat-2');
  });

  it('returns entries sorted by updatedAt and respects limit', () => {
    saveChatHistory(buildEntry({ id: 'c1', updatedAt: 10 }));
    saveChatHistory(buildEntry({ id: 'c2', updatedAt: 20 }));
    saveChatHistory(buildEntry({ id: 'c3', updatedAt: 15 }));

    const entries = getChatHistoryEntries();
    expect(entries.map((e) => e.id)).toEqual(['c2', 'c3', 'c1']);
    expect(getChatHistoryEntries(2).map((e) => e.id)).toEqual(['c2', 'c3']);
  });

  it('deletes entries, removes ids from index, and drops the index key when empty', () => {
    saveChatHistory(buildEntry({ id: 'c1' }));
    deleteChatHistory('c1');

    expect(getChatHistory('c1')).toBeNull();
    expect(getChatHistoryIndex()).toEqual([]);
    expect(getSettingsStorage().contains(CHAT_HISTORY_INDEX_KEY)).toBe(false);
  });

  it('clears legacy chat history keys and notifies subscribers only when something was cleared', () => {
    const callback = jest.fn();
    const unsubscribe = subscribeChatHistory(callback);

    callback.mockClear();

    // nothing to clear
    expect(clearLegacyChatHistory()).toBe(0);
    expect(callback).not.toHaveBeenCalled();

    // legacy keys + index
    getSettingsStorage().set(CHAT_HISTORY_INDEX_KEY, JSON.stringify(['x']));
    getSettingsStorage().set(`${CHAT_HISTORY_PREFIX}legacy-1`, JSON.stringify(buildEntry({ id: 'legacy-1' })));
    getSettingsStorage().set(`${CHAT_HISTORY_PREFIX}legacy-2`, JSON.stringify(buildEntry({ id: 'legacy-2' })));

    expect(clearLegacyChatHistory()).toBe(3);
    expect(callback).toHaveBeenCalled();
    expect(getChatHistoryIndex()).toEqual([]);
    expect(getSettingsStorage().contains(`${CHAT_HISTORY_PREFIX}legacy-1`)).toBe(false);
    expect(getSettingsStorage().contains(`${CHAT_HISTORY_PREFIX}legacy-2`)).toBe(false);

    unsubscribe();
  });

  it('repairs the index by removing ids with missing entries', () => {
    // index refers to two chats, but only one entry exists
    getSettingsStorage().set(CHAT_HISTORY_INDEX_KEY, JSON.stringify(['c1', 'c2']));
    getSettingsStorage().set(`${CHAT_HISTORY_PREFIX}c1`, JSON.stringify(buildEntry({ id: 'c1' })));

    const callback = jest.fn();
    const unsubscribe = subscribeChatHistory(callback);

    const result = repairChatHistoryIndex();
    expect(result).toEqual({ removed: 1, total: 2 });
    expect(getChatHistoryIndex()).toEqual(['c1']);
    expect(callback).toHaveBeenCalled();

    unsubscribe();
  });

  it('builds summaries with derived titles', () => {
    saveChatHistory(buildEntry({
      id: 'empty',
      messages: [{ role: 'assistant', content: 'hi' }],
      updatedAt: 1,
    }));
    saveChatHistory(buildEntry({
      id: 'long',
      messages: [{ role: 'user', content: 'a'.repeat(100) }],
      updatedAt: 2,
    }));

    const summaries = getChatHistorySummaries();
    const empty = summaries.find((s) => s.id === 'empty');
    const long = summaries.find((s) => s.id === 'long');

    expect(empty?.title).toBe('New Conversation');
    expect(long?.title).toMatch(/\.{3}$/);
    expect(long?.title.length).toBeLessThanOrEqual(48);
  });
});
