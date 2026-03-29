import {
  clearLegacyChatHistory,
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

  it('defaults new installs to 90 day chat retention', () => {
    expect(getSettings().chatRetentionDays).toBe(90);
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

  it('normalizes chat retention settings as nullable positive day counts', () => {
    updateSettings({ chatRetentionDays: 90 });
    expect(getSettings().chatRetentionDays).toBe(90);

    updateSettings({ chatRetentionDays: '365' as any });
    expect(getSettings().chatRetentionDays).toBe(365);

    updateSettings({ chatRetentionDays: 0 as any });
    expect(getSettings().chatRetentionDays).toBeNull();
  });

  it('preserves legacy installs without a chat retention setting', () => {
    storage.set('app_settings', JSON.stringify({
      theme: 'system',
      language: 'en',
      activeModelId: 'author/model-q4',
    }));

    expect(getSettings().chatRetentionDays).toBeNull();
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

  it('sanitizes chat history index entries before consumers read them', () => {
    storage.set('chat_history_index', JSON.stringify(['chat-1', ' chat-1 ', '', null, 5]));

    expect(getChatHistorySummaries()).toEqual([]);
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

  it('clears legacy chat history keys and index together', () => {
    saveChatHistory({
      id: 'chat-1',
      messages: [{ role: 'user', content: 'hello there' }],
      modelId: 'm1',
      presetId: null,
      createdAt: 1,
      updatedAt: 1,
    });

    expect(clearLegacyChatHistory()).toBe(1);
    expect(storage.getString('chat_history_chat-1')).toBeUndefined();
    expect(storage.getString('chat_history_index')).toBeUndefined();
  });
});

