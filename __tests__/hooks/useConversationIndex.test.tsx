import React, { useEffect } from 'react';
import { render } from '@testing-library/react-native';
import type { ConversationIndexItem } from '../../src/types/chat';
import { useConversationIndex } from '../../src/hooks/useConversationIndex';

const mockUseChatStore = jest.fn();
const mockBuildConversationIndex = jest.fn();

jest.mock('../../src/store/chatStore', () => ({
  useChatStore: (selector: (state: { threads: Record<string, unknown> | null }) => unknown) => mockUseChatStore(selector),
}));

jest.mock('../../src/types/chat', () => {
  const actual = jest.requireActual('../../src/types/chat');
  return {
    ...actual,
    buildConversationIndex: (...args: unknown[]) => mockBuildConversationIndex(...args),
  };
});

describe('useConversationIndex', () => {
  function renderHook(options?: { enabled?: boolean; limit?: number }) {
    let currentValue: ConversationIndexItem[] | null = null;

    const Harness = () => {
      const value = useConversationIndex(options);
      useEffect(() => {
        currentValue = value;
      }, [value]);
      return null;
    };

    render(<Harness />);
    return () => currentValue;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockUseChatStore.mockImplementation((selector: (state: { threads: Record<string, unknown> }) => unknown) => selector({
      threads: {
        'thread-1': { id: 'thread-1' },
      },
    }));
    mockBuildConversationIndex.mockReturnValue([
      {
        id: 'thread-1',
        title: 'Thread 1',
        updatedAt: 1,
        modelId: 'author/model-q4',
        presetId: null,
        messageCount: 1,
      },
    ]);
  });

  it('returns an empty index when disabled and skips index building', () => {
    const getValue = renderHook({ enabled: false });

    expect(getValue()).toEqual([]);
    expect(mockBuildConversationIndex).not.toHaveBeenCalled();
  });

  it('returns an empty index when threads are missing or when the builder returns nothing', () => {
    mockUseChatStore.mockImplementation((selector: (state: { threads: null }) => unknown) => selector({ threads: null }));
    const getValueWithoutThreads = renderHook();

    expect(getValueWithoutThreads()).toEqual([]);
    expect(mockBuildConversationIndex).not.toHaveBeenCalled();

    mockUseChatStore.mockImplementation((selector: (state: { threads: Record<string, unknown> }) => unknown) => selector({
      threads: {
        'thread-1': { id: 'thread-1' },
      },
    }));
    mockBuildConversationIndex.mockReturnValueOnce([]);

    const getEmptyBuiltValue = renderHook();
    expect(getEmptyBuiltValue()).toEqual([]);
    expect(mockBuildConversationIndex).toHaveBeenCalled();
  });

  it('passes through limit and returns the built conversation index', () => {
    const getValue = renderHook({ limit: 3 });

    expect(mockBuildConversationIndex).toHaveBeenCalledWith(
      { 'thread-1': { id: 'thread-1' } },
      { limit: 3 },
    );
    expect(getValue()).toEqual([
      expect.objectContaining({ id: 'thread-1', title: 'Thread 1' }),
    ]);
  });
});
