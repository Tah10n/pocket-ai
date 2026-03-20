import {
  getSettings,
  getChatHistorySummaries,
  repairChatHistoryIndex,
  saveChatHistory,
  storage,
  subscribeChatHistory,
  updateSettings,
} from '../../src/services/SettingsStore';

describe('SettingsStore (Stage A)', () => {
  beforeEach(() => {
    (storage as any).clearAll?.();
    storage.remove('app_settings');
    storage.remove('chat_history_index');
  });

  it('normalizes language values', () => {
    updateSettings({ language: 'English (US)' as any });
    expect(getSettings().language).toBe('en');

    updateSettings({ language: 'ru' as any });
    expect(getSettings().language).toBe('ru');

    updateSettings({ language: 'русский' as any });
    expect(getSettings().language).toBe('ru');
  });

  it('persists activeModelId as nullable string settings state', () => {
    updateSettings({ activeModelId: 'author/model-q4' });
    expect(getSettings().activeModelId).toBe('author/model-q4');

    updateSettings({ activeModelId: 42 as any });
    expect(getSettings().activeModelId).toBeNull();
  });

  it('resets corrupted settings payload', () => {
    storage.set('app_settings', '{');
    expect(getSettings().language).toBe('en');
  });

  it('repairs chat history index when entries are missing', () => {
    saveChatHistory({
      id: 'chat-1',
      messages: [{ role: 'user', content: 'hi' }],
      modelId: 'm1',
      presetId: null,
      createdAt: 1,
      updatedAt: 1,
    });

    storage.set('chat_history_index', JSON.stringify(['chat-1', 'missing']));

    const res = repairChatHistoryIndex();
    expect(res.removed).toBe(1);
    expect(JSON.parse(storage.getString('chat_history_index') || '[]')).toEqual(['chat-1']);
  });

  it('publishes chat history summaries in reverse chronological order', () => {
    saveChatHistory({
      id: 'chat-1',
      messages: [{ role: 'user', content: 'First conversation title' }],
      modelId: 'author/model-a',
      presetId: null,
      createdAt: 1,
      updatedAt: 10,
    });

    saveChatHistory({
      id: 'chat-2',
      messages: [{ role: 'user', content: 'Second conversation title' }],
      modelId: 'author/model-b',
      presetId: null,
      createdAt: 2,
      updatedAt: 20,
    });

    expect(getChatHistorySummaries()).toEqual([
      expect.objectContaining({ id: 'chat-2', title: 'Second conversation title' }),
      expect.objectContaining({ id: 'chat-1', title: 'First conversation title' }),
    ]);
  });

  it('notifies subscribers when chat history changes', () => {
    const listener = jest.fn();
    const unsubscribe = subscribeChatHistory(listener);

    listener.mockClear();

    saveChatHistory({
      id: 'chat-1',
      messages: [{ role: 'user', content: 'hello there' }],
      modelId: 'm1',
      presetId: null,
      createdAt: 1,
      updatedAt: 1,
    });

    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});

