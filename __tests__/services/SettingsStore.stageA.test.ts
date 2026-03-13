import {
  getSettings,
  repairChatHistoryIndex,
  saveChatHistory,
  storage,
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
});

