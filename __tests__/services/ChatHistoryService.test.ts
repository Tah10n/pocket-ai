import { clearChatHistory } from '../../src/services/ChatHistoryService';

const mockStop = jest.fn();
const mockClearThreads = jest.fn();
const mockClearDocuments = jest.fn();
const mockClearLegacy = jest.fn();
const mockDismiss = jest.fn();
const mockMark = jest.fn();
let mockThreads: Record<string, object>;
jest.mock('../../src/services/ChatGenerationService', () => ({ stopAllGenerationWork: () => mockStop() }));
jest.mock('../../src/store/chatStore', () => ({ useChatStore: { getState: () => ({
  threads: mockThreads, activeThreadId: null, clearAllThreads: () => mockClearThreads(),
}) } }));
jest.mock('../../src/services/DocumentSessionContextCache', () => ({ documentSessionContextCache: { clearAll: () => mockClearDocuments() } }));
jest.mock('../../src/services/SettingsStore', () => ({ clearLegacyChatHistory: () => mockClearLegacy() }));
jest.mock('../../src/services/NotificationService', () => ({ notificationService: { dismissInferenceNotificationForThread: (...args: unknown[]) => mockDismiss(...args) } }));
jest.mock('../../src/services/PerformanceMonitor', () => ({ performanceMonitor: { mark: (...args: unknown[]) => mockMark(...args) } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('ChatHistoryService drain boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks(); mockStop.mockReset(); mockThreads = { thread: { id: 'thread' } };
    mockClearThreads.mockImplementation(() => { const count = Object.keys(mockThreads).length; mockThreads = {}; return count; });
    mockClearLegacy.mockReturnValue(2); mockClearDocuments.mockResolvedValue(undefined);
    mockDismiss.mockResolvedValue(undefined); mockStop.mockResolvedValue('drained');
  });
  it('preserves history and document resources when a pending generation drain times out', async () => {
    const drain = deferred<'drained' | 'timed_out'>();
    mockStop.mockReturnValue(drain.promise);
    const clearing = clearChatHistory();
    await Promise.resolve();
    expect(mockClearThreads).not.toHaveBeenCalled();
    expect(mockClearDocuments).not.toHaveBeenCalled();
    drain.resolve('timed_out');
    await expect(clearing).rejects.toMatchObject({ code: 'chat_history_busy' });
    expect(mockThreads).toHaveProperty('thread');
    expect(mockClearThreads).not.toHaveBeenCalled();
    expect(mockClearDocuments).not.toHaveBeenCalled();
    expect(mockClearLegacy).not.toHaveBeenCalled();
    expect(mockDismiss).not.toHaveBeenCalled();
    expect(mockMark).toHaveBeenCalledWith('chat.history.clear', expect.objectContaining({ clearHistoryOutcome: 'failure' }));
  });
  it('allows an explicit retry after the work really drains', async () => {
    mockStop.mockResolvedValueOnce('timed_out').mockResolvedValueOnce('drained');
    await expect(clearChatHistory()).rejects.toMatchObject({ code: 'chat_history_busy' });
    await expect(clearChatHistory()).resolves.toBe(3);
    expect(mockClearThreads).toHaveBeenCalledTimes(1);
    expect(mockClearDocuments).toHaveBeenCalledTimes(1);
    expect(mockClearLegacy).toHaveBeenCalledTimes(1);
    expect(mockDismiss).toHaveBeenCalledWith('thread');
  });
  it('does not mutate storage when stopping generation rejects', async () => {
    mockStop.mockRejectedValue(new Error('Stop failed'));
    await expect(clearChatHistory()).rejects.toThrow('Stop failed');
    expect(mockClearThreads).not.toHaveBeenCalled(); expect(mockClearDocuments).not.toHaveBeenCalled();
    expect(mockClearLegacy).not.toHaveBeenCalled();
  });
});
