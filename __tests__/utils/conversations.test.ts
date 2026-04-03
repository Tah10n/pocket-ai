import {
  formatConversationUpdatedAt,
  getConversationModelLabel,
  matchesConversationSearch,
} from '../../src/utils/conversations';

describe('conversations utils', () => {
  it('formats relative timestamps for recent updates', () => {
    const now = 1_000_000;
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      expect(formatConversationUpdatedAt(now - 2_000)).toBe('1 min ago');
      expect(formatConversationUpdatedAt(now - 59 * 60 * 1000)).toBe('59 min ago');
      expect(formatConversationUpdatedAt(now - 60 * 60 * 1000)).toBe('1 hr ago');
      expect(formatConversationUpdatedAt(now - 23 * 60 * 60 * 1000)).toBe('23 hr ago');
      expect(formatConversationUpdatedAt(now - 24 * 60 * 60 * 1000)).toBe('1 day ago');
      expect(formatConversationUpdatedAt(now - 6 * 24 * 60 * 60 * 1000)).toBe('6 days ago');
    } finally {
      spy.mockRestore();
    }
  });

  it('falls back to locale dates for old timestamps', () => {
    const now = 1_000_000_000;
    const oldTimestamp = now - 10 * 24 * 60 * 60 * 1000;
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      expect(formatConversationUpdatedAt(oldTimestamp)).toBe(new Date(oldTimestamp).toLocaleDateString());
    } finally {
      spy.mockRestore();
    }
  });

  it('derives model labels from the last path segment', () => {
    expect(getConversationModelLabel('author/model-q4')).toBe('model-q4');
  });

  it('matches conversations by title, preview, or model identifiers', () => {
    const conversation = {
      id: 'thread-1',
      title: 'Shopping ideas',
      lastMessagePreview: 'Groceries and meal prep',
      modelId: 'author/model-q4',
      updatedAt: 0,
      messageCount: 1,
      presetId: null,
    } as any;

    expect(matchesConversationSearch(conversation, '')).toBe(true);
    expect(matchesConversationSearch(conversation, '  SHOPPING ')).toBe(true);
    expect(matchesConversationSearch(conversation, 'meal')).toBe(true);
    expect(matchesConversationSearch(conversation, 'model-q4')).toBe(true);
    expect(matchesConversationSearch(conversation, 'does-not-match')).toBe(false);
  });
});

