import * as FileSystem from 'expo-file-system/legacy';
import { ChatMessage, ChatThread } from '../../src/types/chat';
import {
  __getUnreferencedAttachmentCleanupStateForTests,
  __resetUnreferencedAttachmentCleanupForTests,
  findMostRecentThreadId,
  flushPendingChatPersistenceWrites,
  getThreadInferenceWindow,
  resetChatStoreForPrivateStorageReset,
  useChatStore,
  type AssistantTurnCommitResult,
  type AssistantTurnFinalization,
} from '../../src/store/chatStore';
import {
  CHAT_PERSISTENCE_INDEX_KEY,
  CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY,
  CHAT_PERSISTENCE_SCHEMA_VERSION,
  CHAT_STREAM_PROGRESS_SCHEMA_VERSION,
  MAX_ASSISTANT_PROGRESS_CONTENT_CHARS,
  getChatStreamingProgressStorageKey,
  getThreadIdFromChatStreamingProgressArtifactStorageKey,
  getChatThreadStorageKey,
  listChatStreamingProgressStorageKeys,
  readChatStreamingProgressRecord,
  readChatThreadRecord,
  removeChatStreamingProgressRecord,
  writeChatStreamingProgressRecord,
  writeChatPendingIndexCommit,
  writeChatPersistenceIndex,
  writeChatThreadRecord,
} from '../../src/store/chatPersistence';
import { getAppStorage, storage } from '../../src/store/storage';
import { performanceMonitor } from '../../src/services/PerformanceMonitor';
import * as privateStorageService from '../../src/services/storage';
import {
  chatAttachmentStorageService,
  type ChatAttachmentFileCleanupResult,
} from '../../src/services/ChatAttachmentStorageService';
import { copiedImageAttachment } from '../fixtures/chatImageAttachmentFixtures';
import { buildPerformanceThread } from '../fixtures/chatPerformanceFixtures';
import {
  MAX_CHAT_BRANCH_REPLACEMENT_ATTACHMENTS,
  MAX_CHAT_BRANCH_REPLACEMENT_ATTACHMENT_METADATA_BYTES,
  MAX_CHAT_BRANCH_REPLACEMENT_CONTENT_LENGTH,
  MAX_CHAT_BRANCH_REPLACEMENT_CONTENT_PARTS,
  MAX_CHAT_BRANCH_REPLACEMENT_CONTENT_PART_TOTAL_CHARS,
} from '../../src/store/chatBranchReplacement';
import {
  captureReferenceSequence,
  countUnretainedItemReferences,
  createMutationCounter,
  getCounterDelta,
} from '../../testUtils';

function buildThread(id: string, updatedAt: number): ChatThread {
  return {
    id,
    title: `Conversation ${id}`,
    modelId: 'author/model-q4',
    presetId: null,
    presetSnapshot: {
      id: null,
      name: 'Default',
      systemPrompt: 'You are helpful.',
    },
    paramsSnapshot: {
      temperature: 0.7,
      topP: 0.9,
      maxTokens: 1024,
      seed: null,
    },
    messages: [
      {
        id: `${id}-user-1`,
        role: 'user',
        content: `Prompt for ${id}`,
        createdAt: updatedAt,
        state: 'complete',
      },
    ],
    createdAt: updatedAt,
    updatedAt,
    status: 'idle',
  };
}

function buildCompletedRegenerationThread(id: string): ChatThread {
  const thread = buildThread(id, 10);
  return {
    ...thread,
    messages: [
      ...thread.messages,
      {
        id: `${id}-assistant-original`,
        role: 'assistant',
        content: 'Original durable answer',
        createdAt: 11,
        state: 'complete',
        kind: 'message',
        modelId: 'author/model-q4',
      },
    ],
    updatedAt: 11,
    status: 'idle',
  };
}

function buildTrailingModelSwitchThread(
  id: string,
  options: {
    targetCreatedAt?: number;
    oldTailAttachment?: ReturnType<typeof buildStoredAttachment>;
  } = {},
): ChatThread {
  const targetCreatedAt = options.targetCreatedAt ?? 10;
  return {
    ...buildThread(id, targetCreatedAt),
    title: 'Original branch title',
    titleSource: 'derived',
    activeModelId: 'author/model-q8',
    messages: [
      {
        id: `${id}-user-1`,
        role: 'user',
        content: 'Original prompt',
        createdAt: targetCreatedAt,
        state: 'complete',
        kind: 'message',
        modelId: 'author/model-q4',
      },
      {
        id: `${id}-assistant-old`,
        role: 'assistant',
        content: 'Original durable answer',
        createdAt: targetCreatedAt + 1,
        state: 'complete',
        kind: 'message',
        modelId: 'author/model-q4',
      },
      ...(options.oldTailAttachment
        ? [{
            id: `${id}-user-tail`,
            role: 'user' as const,
            content: 'Old tail attachment',
            attachments: [options.oldTailAttachment],
            createdAt: targetCreatedAt + 2,
            state: 'complete' as const,
            kind: 'message' as const,
            modelId: 'author/model-q4',
          }, {
            id: `${id}-assistant-tail`,
            role: 'assistant' as const,
            content: 'Old tail response',
            createdAt: targetCreatedAt + 3,
            state: 'complete' as const,
            kind: 'message' as const,
            modelId: 'author/model-q4',
          }]
        : []),
      {
        id: `${id}-switch-q8`,
        role: 'system',
        content: '',
        createdAt: targetCreatedAt + 4,
        state: 'complete',
        kind: 'model_switch',
        modelId: 'author/model-q8',
        switchFromModelId: 'author/model-q4',
        switchToModelId: 'author/model-q8',
      },
    ],
    summary: {
      content: 'Stale summary from the old branch',
      createdAt: targetCreatedAt + 3,
      sourceMessageIds: [`${id}-user-1`, `${id}-assistant-old`],
    },
    updatedAt: targetCreatedAt + 4,
    status: 'idle',
  };
}

function captureChatPersistenceWrites() {
  const appStorage = getAppStorage() as unknown as { set: jest.Mock; remove: jest.Mock };
  const originalSet = appStorage.set;
  const originalRemove = appStorage.remove;
  const setKeys: string[] = [];
  const removedKeys: string[] = [];
  appStorage.set = jest.fn(function setWithCapture(this: unknown, key: string, value: unknown) {
    setKeys.push(key);
    return originalSet.call(this, key, value);
  });
  appStorage.remove = jest.fn(function removeWithCapture(this: unknown, key: string) {
    removedKeys.push(key);
    return originalRemove.call(this, key);
  });

  return {
    setKeys,
    removedKeys,
    restore: () => {
      appStorage.set = originalSet;
      appStorage.remove = originalRemove;
    },
  };
}

function seedPersistedChatThread(thread: ChatThread, persistedAt = 100): void {
  writeChatThreadRecord(storage, thread, persistedAt);
  writeChatPersistenceIndex(storage, {
    schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
    activeThreadId: thread.id,
    threadIds: [thread.id],
    updatedAt: persistedAt,
  });
  useChatStore.setState({
    threads: { [thread.id]: thread },
    activeThreadId: thread.id,
  });
}

function snapshotStreamingProgressArtifacts(threadId: string): Map<string, string> {
  return new Map(listChatStreamingProgressStorageKeys(storage)
    .filter((key) => (
      getThreadIdFromChatStreamingProgressArtifactStorageKey(key) === threadId
    ))
    .flatMap((key) => {
      const value = storage.getString(key);
      return value == null ? [] : [[key, value] as const];
    }));
}

function restoreStreamingProgressArtifacts(artifacts: ReadonlyMap<string, string>): void {
  const entries = Array.from(artifacts);
  entries
    .filter(([key]) => !key.startsWith('chat-store:progress:'))
    .forEach(([key, value]) => storage.set(key, value));
  entries
    .filter(([key]) => key.startsWith('chat-store:progress:'))
    .forEach(([key, value]) => storage.set(key, value));
}

function expectNoStreamingProgressArtifacts(threadId: string): void {
  expect(snapshotStreamingProgressArtifacts(threadId)).toEqual(new Map());
}

type TerminalPersistenceMode = 'append' | 'replace' | 'replace_branch';
type TerminalPersistenceOutcome = AssistantTurnFinalization['outcome'];

function prepareTerminalPersistenceCase(
  mode: TerminalPersistenceMode,
  suffix: string,
): {
  threadId: string;
  messageId: string;
  partialContent: string;
  durableRecordBefore: string;
} {
  const threadId = `thread-terminal-matrix-${mode}-${suffix}`;
  const durableThread = mode === 'append'
    ? buildThread(threadId, 10)
    : mode === 'replace'
      ? buildCompletedRegenerationThread(threadId)
      : buildTrailingModelSwitchThread(threadId);
  seedPersistedChatThread(durableThread, 100);

  const messageId = mode === 'append'
    ? useChatStore.getState().createAssistantPlaceholder(threadId)
    : mode === 'replace'
      ? useChatStore.getState().replaceLastAssistantMessage(threadId)!
      : useChatStore.getState().replaceBranchFromUserMessage(
          threadId,
          `${threadId}-user-1`,
          'Edited terminal matrix prompt',
        )!;
  const partialContent = `Recoverable ${mode} ${suffix} partial`;
  useChatStore.getState().patchAssistantMessage(threadId, messageId, {
    content: partialContent,
    thoughtContent: `Reasoning for ${mode} ${suffix}`,
  });
  flushPendingChatPersistenceWrites('background');

  return {
    threadId,
    messageId,
    partialContent,
    durableRecordBefore: storage.getString(getChatThreadStorageKey(threadId))!,
  };
}

function buildTerminalPersistenceFinalization(
  mode: TerminalPersistenceMode,
  outcome: TerminalPersistenceOutcome,
): AssistantTurnFinalization {
  const content = `Final ${mode} ${outcome} output`;
  if (outcome === 'error') {
    return {
      outcome,
      content,
      errorCode: 'generation_failed',
      errorMessage: `Terminal ${mode} failure`,
    };
  }

  return { outcome, content };
}

const TERMINAL_PERSISTENCE_MODES: TerminalPersistenceMode[] = [
  'append',
  'replace',
  'replace_branch',
];
const TERMINAL_PERSISTENCE_OUTCOMES: TerminalPersistenceOutcome[] = [
  'success',
  'stopped',
  'error',
];
const TERMINAL_TRANSACTION_FAULTS = [
  'pending_write',
  'thread_write',
  'index_write',
  'pending_remove',
] as const;

function readPersistedChatIndex() {
  return JSON.parse(storage.getString(CHAT_PERSISTENCE_INDEX_KEY) ?? '{}') as Record<string, unknown>;
}

function expectPersistedChatClearTombstone() {
  const rawIndex = storage.getString(CHAT_PERSISTENCE_INDEX_KEY);
  expect(rawIndex).toBeTruthy();

  const index = readPersistedChatIndex();
  expect(index).toEqual(expect.objectContaining({
    schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
    activeThreadId: null,
    threadIds: [],
    clearedAt: expect.any(Number),
  }));
  expect(index.updatedAt).toBe(index.clearedAt);
}

type CapturedClearIndexWrite = {
  threadIds?: unknown[];
  revision?: number;
  clearedAt?: number;
};

function captureClearIndexWrites(options?: {
  throwOnClearWrite?: number;
  error?: Error;
}) {
  const appStorage = getAppStorage() as unknown as { set: jest.Mock };
  const originalSet = appStorage.set;
  const writes: CapturedClearIndexWrite[] = [];
  appStorage.set = jest.fn(function setWithClearIndexCapture(
    this: unknown,
    key: string,
    value: unknown,
  ) {
    if (key === CHAT_PERSISTENCE_INDEX_KEY && typeof value === 'string') {
      const parsed = JSON.parse(value) as CapturedClearIndexWrite;
      if (typeof parsed.clearedAt === 'number') {
        writes.push(parsed);
        if (writes.length === options?.throwOnClearWrite) {
          throw options.error ?? new Error('simulated clear index write failure');
        }
      }
    }

    return originalSet.call(this, key, value);
  });

  return {
    writes,
    restore: () => {
      appStorage.set = originalSet;
    },
  };
}

function buildStoredAttachment(threadId: string, messageId: string, fileName: string) {
  return {
    ...copiedImageAttachment,
    id: fileName.replace(/\.[^.]+$/u, ''),
    threadId,
    messageId,
    localUri: `test-dir/chat-attachments/${fileName}`,
    fileName,
  };
}

async function flushAttachmentCleanup(cycles = 2) {
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    await Promise.resolve();
  }
}

async function reportAllAttachmentCleanupCandidatesDeleted({
  candidateLocalUris,
}: {
  candidateLocalUris: Iterable<string>;
}): Promise<ChatAttachmentFileCleanupResult[]> {
  return Array.from(candidateLocalUris, (localUri) => ({
    localUri,
    status: 'deleted' as const,
  }));
}

function captureScheduledTimeouts() {
  const callbacks: Array<() => void> = [];
  const delays: Array<number | undefined> = [];
  const setTimeoutSpy = jest
    .spyOn(global, 'setTimeout')
    .mockImplementation((callback, delay) => {
      callbacks.push(callback as () => void);
      delays.push(typeof delay === 'number' ? delay : undefined);
      return callbacks.length as unknown as ReturnType<typeof setTimeout>;
    });

  return { callbacks, delays, setTimeoutSpy };
}

describe('chatStore', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetUnreferencedAttachmentCleanupForTests();
    (FileSystem.deleteAsync as jest.Mock).mockResolvedValue(undefined);
    flushPendingChatPersistenceWrites('background');
    useChatStore.setState({ threads: {}, activeThreadId: null });
    storage.getAllKeys().forEach((key) => storage.remove(key));
  });

  it('findMostRecentThreadId returns the newest thread id without sorting', () => {
    const threads = {
      a: buildThread('a', 10),
      b: buildThread('b', 20),
      c: buildThread('c', 5),
    };

    expect(findMostRecentThreadId(threads)).toBe('b');
  });

  it('creates a thread and conversation index entry', () => {
    const threadId = useChatStore.getState().createThread({
      modelId: 'author/model-q4',
      presetId: 'preset-1',
      presetSnapshot: {
        id: 'preset-1',
        name: 'Helpful Assistant',
        systemPrompt: 'Be concise.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 1024,
        seed: null,
      },
    });

    useChatStore.getState().appendMessage(threadId, {
      id: 'user-1',
      role: 'user',
      content: 'Hello there from the user',
      createdAt: Date.now(),
      state: 'complete',
    });

    const thread = useChatStore.getState().getThread(threadId);
    const index = useChatStore.getState().getConversationIndex();

    expect(thread?.title).toContain('Hello there');
    expect(index).toHaveLength(1);
    expect(index[0]).toEqual(
      expect.objectContaining({
        id: threadId,
        modelId: 'author/model-q4',
        presetId: 'preset-1',
        messageCount: 1,
      }),
    );
  });

  it('advances prompt inference revision independently of wall-clock and streaming presentation updates', () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      let revision = useChatStore.getState().inferenceRevision;
      const expectIncrement = (operation: () => unknown) => {
        operation();
        expect(useChatStore.getState().inferenceRevision).toBe(revision + 1);
        revision += 1;
      };
      const expectStable = (operation: () => unknown) => {
        operation();
        expect(useChatStore.getState().inferenceRevision).toBe(revision);
      };

      let threadId = '';
      expectIncrement(() => {
        threadId = useChatStore.getState().createThread({
          modelId: 'author/model-q4',
          presetId: 'preset-1',
          presetSnapshot: {
            id: 'preset-1',
            name: 'Helpful Assistant',
            systemPrompt: 'Be concise.',
          },
          paramsSnapshot: {
            temperature: 0.7,
            topP: 0.9,
            maxTokens: 1024,
            seed: null,
          },
        });
      });
      expectStable(() => useChatStore.getState().renameThread(threadId, 'Same-time rename'));
      expectStable(() => useChatStore.getState().finalizeThreadStatus(threadId, 'idle'));

      expectIncrement(() => useChatStore.getState().appendMessage(threadId, {
        id: 'fixed-time-user',
        role: 'user',
        content: 'Prompt content changes at the same timestamp',
        createdAt: 1_000,
        state: 'complete',
      }));

      let assistantId = '';
      expectStable(() => {
        assistantId = useChatStore.getState().createAssistantPlaceholder(threadId);
      });
      expectStable(() => useChatStore.getState().patchAssistantMessage(threadId, assistantId, {
        content: 'streaming presentation only',
        tokensPerSec: 12,
      }));
      expectIncrement(() => useChatStore.getState().finalizeAssistantMessage(
        threadId,
        assistantId,
        'Completed answer at the same timestamp',
      ));

      let replacementId = '';
      expectIncrement(() => {
        replacementId = useChatStore.getState().replaceLastAssistantMessage(threadId) ?? '';
      });
      expect(replacementId).toBeTruthy();
      expectStable(() => useChatStore.getState().patchAssistantMessage(threadId, replacementId, {
        content: 'replacement stream patch',
      }));
      expectIncrement(() => useChatStore.getState().stopAssistantMessage(threadId, replacementId));

      expectIncrement(() => useChatStore.getState().updateThreadPresetSnapshot(
        threadId,
        'preset-2',
        { id: 'preset-2', name: 'Precise', systemPrompt: 'Answer precisely.' },
      ));
      expectIncrement(() => useChatStore.getState().updateThreadParamsSnapshot(threadId, {
        temperature: 0.2,
        topP: 0.8,
        maxTokens: 512,
        reasoningEffort: 'high',
        seed: 7,
      }));
      expectIncrement(() => useChatStore.getState().setThreadSummary(threadId, {
        content: 'Same-time summary replacement',
        createdAt: 1_000,
        sourceMessageIds: ['fixed-time-user'],
      }));
      expectIncrement(() => useChatStore.getState().switchThreadModel(
        threadId,
        'author/model-q8',
        1_000,
      ));
      expectIncrement(() => useChatStore.getState().deleteMessageBranch(
        threadId,
        'fixed-time-user',
      ));
      expectIncrement(() => useChatStore.getState().deleteThread(threadId));

      const beforeReset = revision;
      resetChatStoreForPrivateStorageReset();
      expect(useChatStore.getState().inferenceRevision).toBe(beforeReset + 1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('advances inference revision when persisted chat state is rehydrated', async () => {
    const thread = buildThread('thread-inference-revision-hydration', 100);
    writeChatThreadRecord(storage, thread, 100);
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: thread.id,
      threadIds: [thread.id],
      updatedAt: 100,
    });
    useChatStore.setState({ threads: {}, activeThreadId: null });
    const beforeHydration = useChatStore.getState().inferenceRevision;

    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().inferenceRevision).toBe(beforeHydration + 1);
    expect(useChatStore.getState().threads[thread.id]).toBeDefined();
  });

  it('rolls back in-memory chat state when a persistence write fails', () => {
    const threadId = useChatStore.getState().createThread({
      modelId: 'author/model-q4',
      presetId: 'preset-1',
      presetSnapshot: {
        id: 'preset-1',
        name: 'Helpful Assistant',
        systemPrompt: 'Be concise.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 1024,
        seed: null,
      },
    });
    const threadBeforeAppend = useChatStore.getState().getThread(threadId);
    const inferenceRevisionBeforeAppend = useChatStore.getState().inferenceRevision;
    const appStorage = getAppStorage() as unknown as { set: jest.Mock };
    const originalSet = appStorage.set;
    const writeError = new Error('simulated thread write failure');
    let threadWriteAttempts = 0;
    appStorage.set = jest.fn(function setWithFailure(this: unknown, key: string, value: unknown) {
      if (key === getChatThreadStorageKey(threadId) && threadWriteAttempts === 0) {
        threadWriteAttempts += 1;
        throw writeError;
      }

      return originalSet.call(this, key, value);
    });

    try {
      expect(() => {
        useChatStore.getState().appendMessage(threadId, {
          id: 'user-after-failure',
          role: 'user',
          content: 'This write should roll back',
          createdAt: Date.now(),
          state: 'complete',
        });
      }).toThrow(writeError);

      expect(useChatStore.getState().getThread(threadId)).toEqual(threadBeforeAppend);
      expect(useChatStore.getState().inferenceRevision).toBe(inferenceRevisionBeforeAppend + 1);
      expect(useChatStore.getState().getConversationIndex()[0]).toEqual(expect.objectContaining({
        id: threadId,
        messageCount: threadBeforeAppend?.messages.length ?? 0,
      }));
    } finally {
      appStorage.set = originalSet;
    }
  });

  it('rolls back partial durable chat records when a persistence index write fails', async () => {
    const threadId = useChatStore.getState().createThread({
      modelId: 'author/model-q4',
      presetId: 'preset-1',
      presetSnapshot: {
        id: 'preset-1',
        name: 'Helpful Assistant',
        systemPrompt: 'Be concise.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 1024,
        seed: null,
      },
    });
    const threadBeforeAppend = useChatStore.getState().getThread(threadId);
    const appStorage = getAppStorage() as unknown as { set: jest.Mock };
    const originalSet = appStorage.set;
    const writeError = new Error('simulated index write failure');
    let indexWriteAttempts = 0;
    appStorage.set = jest.fn(function setWithFailure(this: unknown, key: string, value: unknown) {
      if (key === CHAT_PERSISTENCE_INDEX_KEY && indexWriteAttempts === 0) {
        indexWriteAttempts += 1;
        throw writeError;
      }

      return originalSet.call(this, key, value);
    });

    try {
      expect(() => {
        useChatStore.getState().appendMessage(threadId, {
          id: 'user-after-durable-failure',
          role: 'user',
          content: 'This partial write should not survive rehydrate',
          createdAt: Date.now(),
          state: 'complete',
        });
      }).toThrow(writeError);
    } finally {
      appStorage.set = originalSet;
    }

    expect(useChatStore.getState().getThread(threadId)).toEqual(threadBeforeAppend);
    expect(storage.getString(CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY)).toBeUndefined();
    expect(storage.getString(getChatThreadStorageKey(threadId))).not.toContain('partial write should not survive');

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().getThread(threadId)).toEqual(threadBeforeAppend);
    expect(useChatStore.getState().getThread(threadId)?.messages).toEqual(threadBeforeAppend?.messages);
  });

  it('defaults kind and modelId when appending messages without metadata', () => {
    const threadId = useChatStore.getState().createThread({
      modelId: 'author/model-q4',
      presetId: null,
      presetSnapshot: {
        id: null,
        name: 'Default',
        systemPrompt: 'You are helpful.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 1024,
        seed: null,
      },
    });

    useChatStore.getState().appendMessage(threadId, {
      id: 'user-1',
      role: 'user',
      content: 'Hello there from the user',
      createdAt: 1,
      state: 'complete',
    });

    expect(useChatStore.getState().getThread(threadId)?.messages.at(-1)).toEqual(
      expect.objectContaining({
        id: 'user-1',
        kind: 'message',
        modelId: 'author/model-q4',
      }),
    );
  });

  it('uses activeModelId for the conversation index model id when available', () => {
    const thread = {
      ...buildThread('thread-active-model', 10),
      modelId: 'author/model-q4',
      activeModelId: 'author/model-q8',
    };

    useChatStore.setState({
      threads: {
        [thread.id]: thread,
      },
      activeThreadId: thread.id,
    });

    expect(useChatStore.getState().getConversationIndex()[0]?.modelId).toBe('author/model-q8');
  });

  it('switchThreadModel updates activeModelId and appends a model_switch system message', () => {
    const threadId = useChatStore.getState().createThread({
      modelId: 'author/model-q4',
      presetId: null,
      presetSnapshot: {
        id: null,
        name: 'Default',
        systemPrompt: 'You are helpful.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 1024,
        seed: null,
      },
    });

    useChatStore.getState().appendMessage(threadId, {
      id: 'user-1',
      role: 'user',
      content: 'Hello there',
      createdAt: 1,
      state: 'complete',
    });

    const switchMessageId = useChatStore.getState().switchThreadModel(threadId, 'author/model-q8', 123);
    const thread = useChatStore.getState().getThread(threadId);

    expect(switchMessageId).toBeTruthy();
    expect(thread?.activeModelId).toBe('author/model-q8');
    expect(thread?.messages.filter((message) => message.kind === 'model_switch')).toHaveLength(1);
    expect(thread?.messages.at(-1)).toEqual(
      expect.objectContaining({
        id: switchMessageId,
        role: 'system',
        kind: 'model_switch',
        content: '',
        modelId: 'author/model-q8',
        switchFromModelId: 'author/model-q4',
        switchToModelId: 'author/model-q8',
        createdAt: 123,
        state: 'complete',
      }),
    );
  });

  it('switchThreadModel is a no-op when switching to the current active model', () => {
    const threadId = useChatStore.getState().createThread({
      modelId: 'author/model-q4',
      presetId: null,
      presetSnapshot: {
        id: null,
        name: 'Default',
        systemPrompt: 'You are helpful.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 1024,
        seed: null,
      },
    });

    useChatStore.getState().appendMessage(threadId, {
      id: 'user-1',
      role: 'user',
      content: 'Hello there',
      createdAt: 1,
      state: 'complete',
    });

    const before = useChatStore.getState().getThread(threadId);
    const result = useChatStore.getState().switchThreadModel(threadId, 'author/model-q4', 123);
    const after = useChatStore.getState().getThread(threadId);

    expect(result).toBeNull();
    expect(after).toBe(before);
    expect(after?.activeModelId).toBe('author/model-q4');
    expect(after?.messages).toHaveLength(1);
  });

  it('excludes model_switch messages from conversation previews and message counts', () => {
    const threadId = useChatStore.getState().createThread({
      modelId: 'author/model-q4',
      presetId: null,
      presetSnapshot: {
        id: null,
        name: 'Default',
        systemPrompt: 'You are helpful.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 1024,
        seed: null,
      },
    });

    useChatStore.getState().appendMessage(threadId, {
      id: 'user-1',
      role: 'user',
      content: 'Hello there',
      createdAt: 1,
      state: 'complete',
    });
    useChatStore.getState().switchThreadModel(threadId, 'author/model-q8', 2);

    const indexItem = useChatStore.getState().getConversationIndex()[0];
    expect(indexItem).toEqual(
      expect.objectContaining({
        id: threadId,
        modelId: 'author/model-q8',
        messageCount: 1,
        lastMessagePreview: 'Hello there',
      }),
    );
  });

  it('creates and patches an assistant placeholder', () => {
    const threadId = useChatStore.getState().createThread({
      modelId: 'author/model-q4',
      presetId: null,
      presetSnapshot: {
        id: null,
        name: 'Default',
        systemPrompt: 'You are helpful.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 1024,
        seed: null,
      },
    });

    const assistantId = useChatStore.getState().createAssistantPlaceholder(threadId);
    useChatStore.getState().patchAssistantMessage(threadId, assistantId, {
      content: 'Streaming reply',
      state: 'complete',
    });

    const thread = useChatStore.getState().getThread(threadId);
    expect(thread?.messages.at(-1)).toEqual(
      expect.objectContaining({
        id: assistantId,
        role: 'assistant',
        content: 'Streaming reply',
        state: 'complete',
      }),
    );
  });

  it('keeps durable history and presentation references stable across 100 streaming patches', () => {
    const fixtureThread = buildPerformanceThread({
      historicalMessageCount: 1000,
      attachments: 'mixed',
      modelSwitchEvery: 125,
    });
    useChatStore.setState({
      threads: { [fixtureThread.id]: fixtureThread },
      activeThreadId: fixtureThread.id,
    });

    const assistantId = useChatStore.getState().createAssistantPlaceholder(
      fixtureThread.id,
      fixtureThread.activeModelId,
    );
    const durableThreads = useChatStore.getState().threads;
    const durableThread = durableThreads[fixtureThread.id];
    const durableMessages = durableThread.messages;
    const durablePlaceholder = durableMessages.at(-1);
    const presentedAfterPlaceholder = useChatStore.getState().getThread(fixtureThread.id)!;
    const presentationReferences = captureReferenceSequence(presentedAfterPlaceholder.messages);
    const historicalReferences = presentationReferences.items.slice(0, -1);
    const initialRevision = useChatStore.getState().streamingRevision;
    let previousTransientAssistant = presentedAfterPlaceholder.messages.at(-1);

    for (let patchIndex = 1; patchIndex <= 100; patchIndex += 1) {
      useChatStore.getState().patchAssistantMessage(fixtureThread.id, assistantId, {
        content: `Partial response ${patchIndex}`,
        thoughtContent: `Reasoning ${patchIndex}`,
        tokensPerSec: patchIndex / 10,
        state: 'streaming',
      });

      const presentedThread = useChatStore.getState().getThread(fixtureThread.id)!;
      const nextTransientAssistant = presentedThread.messages.at(-1);
      expect(presentedThread.messages).toBe(presentationReferences.array);
      expect(nextTransientAssistant).not.toBe(previousTransientAssistant);
      expect(nextTransientAssistant).toEqual(expect.objectContaining({
        id: assistantId,
        modelId: fixtureThread.activeModelId,
        content: `Partial response ${patchIndex}`,
        thoughtContent: `Reasoning ${patchIndex}`,
        tokensPerSec: patchIndex / 10,
        state: 'streaming',
      }));
      previousTransientAssistant = nextTransientAssistant;
    }

    const stateAfterPatches = useChatStore.getState();
    const presentedAfterPatches = stateAfterPatches.getThread(fixtureThread.id)!;
    expect(stateAfterPatches.threads).toBe(durableThreads);
    expect(stateAfterPatches.threads[fixtureThread.id]).toBe(durableThread);
    expect(stateAfterPatches.threads[fixtureThread.id].messages).toBe(durableMessages);
    expect(stateAfterPatches.threads[fixtureThread.id].messages.at(-1)).toBe(durablePlaceholder);
    expect(durablePlaceholder).toEqual(expect.objectContaining({
      id: assistantId,
      content: '',
      state: 'streaming',
    }));
    expect(stateAfterPatches.threads[fixtureThread.id].title).toBe(durableThread.title);
    expect(stateAfterPatches.threads[fixtureThread.id].updatedAt).toBe(durableThread.updatedAt);
    expect(stateAfterPatches.streamingRevision - initialRevision).toBe(100);
    expect(countUnretainedItemReferences(
      historicalReferences,
      presentedAfterPatches.messages.slice(0, -1),
    )).toBe(0);

    useChatStore.getState().stopAssistantMessage(fixtureThread.id, assistantId);

    const stoppedThread = useChatStore.getState().getThread(fixtureThread.id)!;
    expect(stoppedThread.status).toBe('stopped');
    expect(stoppedThread.messages).not.toBe(durableMessages);
    expect(countUnretainedItemReferences(
      historicalReferences,
      stoppedThread.messages.slice(0, -1),
    )).toBe(0);
    expect(stoppedThread.messages.at(-1)).toEqual(expect.objectContaining({
      id: assistantId,
      modelId: fixtureThread.activeModelId,
      content: 'Partial response 100',
      thoughtContent: 'Reasoning 100',
      tokensPerSec: 10,
      state: 'stopped',
    }));
  });

  it('keeps a regenerated replacement transient across 100 patches over 1000 messages', () => {
    jest.useFakeTimers();
    const durableThread = buildPerformanceThread({
      historicalMessageCount: 1000,
      attachments: 'mixed',
      modelSwitchEvery: 125,
    });
    seedPersistedChatThread(durableThread, durableThread.updatedAt);
    const durableThreads = useChatStore.getState().threads;
    const durableMessages = durableThread.messages;
    const originalAnswer = durableMessages.at(-1)!;
    const durableRecordBefore = storage.getString(getChatThreadStorageKey(durableThread.id));
    const replacementId = useChatStore.getState().replaceLastAssistantMessage(durableThread.id)!;
    const presentedAtStart = useChatStore.getState().getThread(durableThread.id)!;
    const presentationReferences = captureReferenceSequence(presentedAtStart.messages);
    const historicalReferences = presentationReferences.items.slice(0, -1);
    const initialRevision = useChatStore.getState().streamingRevision;
    const previousEnabled = performanceMonitor.isEnabled();
    performanceMonitor.setEnabled(true);
    performanceMonitor.clear();

    try {
      for (let patchIndex = 1; patchIndex <= 100; patchIndex += 1) {
        useChatStore.getState().patchAssistantMessage(durableThread.id, replacementId, {
          content: `Regenerated partial ${patchIndex}`,
          thoughtContent: `Regenerated reasoning ${patchIndex}`,
          tokensPerSec: patchIndex,
        });

        expect(useChatStore.getState().getThread(durableThread.id)?.messages).toBe(
          presentationReferences.array,
        );
      }

      const stateAfterPatches = useChatStore.getState();
      const presentedAfterPatches = stateAfterPatches.getThread(durableThread.id)!;
      expect(stateAfterPatches.threads).toBe(durableThreads);
      expect(stateAfterPatches.threads[durableThread.id]).toBe(durableThread);
      expect(stateAfterPatches.threads[durableThread.id].messages).toBe(durableMessages);
      expect(stateAfterPatches.threads[durableThread.id].messages.at(-1)).toBe(originalAnswer);
      expect(originalAnswer.content).toBe('Deterministic assistant message 999');
      expect(presentedAfterPatches.messages.at(-1)).toEqual(expect.objectContaining({
        id: replacementId,
        content: 'Regenerated partial 100',
        thoughtContent: 'Regenerated reasoning 100',
        regeneratesMessageId: originalAnswer.id,
        state: 'streaming',
      }));
      expect(stateAfterPatches.streamingRevision - initialRevision).toBe(100);
      expect(countUnretainedItemReferences(
        historicalReferences,
        presentedAfterPatches.messages.slice(0, -1),
      )).toBe(0);
      expect(performanceMonitor.snapshot().counters['chat.persist.sanitize'] ?? 0).toBe(0);
      expect(performanceMonitor.snapshot().counters['chat.persist.stringify'] ?? 0).toBe(0);
      expect(storage.getString(getChatThreadStorageKey(durableThread.id))).toBe(durableRecordBefore);

      flushPendingChatPersistenceWrites('background');

      const snapshot = performanceMonitor.snapshot();
      expect(snapshot.counters['chat.persist.sanitize'] ?? 0).toBe(0);
      expect(snapshot.counters['chat.persist.stringify']).toBe(3);
      expect(snapshot.counters['chat.persist.streaming']).toBe(1);
      expect(readChatStreamingProgressRecord(storage, durableThread.id)).toEqual({
        ok: true,
        value: expect.objectContaining({
          messageId: replacementId,
          content: 'Regenerated partial 100',
          revision: 100,
          regeneratesMessageId: originalAnswer.id,
        }),
      });
      expect(storage.getString(getChatThreadStorageKey(durableThread.id))).toBe(durableRecordBefore);
    } finally {
      performanceMonitor.clear();
      performanceMonitor.setEnabled(previousEnabled);
      useChatStore.getState().stopAssistantMessage(durableThread.id, replacementId);
      jest.useRealTimers();
    }
  });

  it('materializes visible partial output when a transient assistant enters the error state', () => {
    const thread = buildPerformanceThread({ historicalMessageCount: 20 });
    useChatStore.setState({
      threads: { [thread.id]: thread },
      activeThreadId: thread.id,
    });
    const assistantId = useChatStore.getState().createAssistantPlaceholder(thread.id);

    useChatStore.getState().patchAssistantMessage(thread.id, assistantId, {
      content: 'Visible partial answer',
      thoughtContent: 'Partial reasoning',
      tokensPerSec: 4.5,
    });
    useChatStore.getState().patchAssistantMessage(thread.id, assistantId, {
      state: 'error',
      errorCode: 'generation_failed',
      errorMessage: 'Native completion failed',
    });

    expect(useChatStore.getState().getThread(thread.id)).toEqual(expect.objectContaining({
      status: 'error',
      messages: expect.arrayContaining([
        expect.objectContaining({
          id: assistantId,
          modelId: thread.activeModelId,
          content: 'Visible partial answer',
          thoughtContent: 'Partial reasoning',
          tokensPerSec: 4.5,
          state: 'error',
          errorCode: 'generation_failed',
          errorMessage: 'Native completion failed',
        }),
      ]),
    }));
  });

  it('keeps an empty assistant placeholder in memory but out of durable records before the first token', () => {
    const threadId = useChatStore.getState().createThread({
      modelId: 'author/model-q4',
      presetId: null,
      presetSnapshot: {
        id: null,
        name: 'Default',
        systemPrompt: 'You are helpful.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 1024,
        seed: null,
      },
    });

    useChatStore.getState().appendMessage(threadId, {
      id: 'user-1',
      role: 'user',
      content: 'Prompt before first token',
      createdAt: 1,
      state: 'complete',
    });

    const assistantId = useChatStore.getState().createAssistantPlaceholder(threadId);
    flushPendingChatPersistenceWrites('background');

    expect(useChatStore.getState().getThread(threadId)?.messages.at(-1)).toEqual(
      expect.objectContaining({
        id: assistantId,
        state: 'streaming',
      }),
    );

    const rawRecord = storage.getString(getChatThreadStorageKey(threadId));
    const record = JSON.parse(rawRecord ?? '{}') as { thread: ChatThread };
    expect(record.thread.status).toBe('idle');
    expect(record.thread.messages).toEqual([
      expect.objectContaining({
        id: 'user-1',
        role: 'user',
        content: 'Prompt before first token',
      }),
    ]);
  });

  it('ignores assistant patches when the target message does not exist', () => {
    const threadId = useChatStore.getState().createThread({
      modelId: 'author/model-q4',
      presetId: null,
      presetSnapshot: {
        id: null,
        name: 'Default',
        systemPrompt: 'You are helpful.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 1024,
        seed: null,
      },
    });

    useChatStore.getState().appendMessage(threadId, {
      id: 'user-1',
      role: 'user',
      content: 'Hello there',
      createdAt: Date.now(),
      state: 'complete',
    });

    const before = useChatStore.getState().getThread(threadId);

    useChatStore.getState().patchAssistantMessage(threadId, 'missing-message-id', {
      content: 'Should not apply',
      state: 'complete',
    });

    const after = useChatStore.getState().getThread(threadId);

    expect(after).toBe(before);
    expect(after?.messages).toBe(before?.messages);
    expect(after?.status).toBe(before?.status);
  });

  it('ignores stale assistant patches once the target is no longer the latest message', () => {
    const threadId = useChatStore.getState().createThread({
      modelId: 'author/model-q4',
      presetId: null,
      presetSnapshot: {
        id: null,
        name: 'Default',
        systemPrompt: 'You are helpful.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 1024,
        seed: null,
      },
    });

    useChatStore.getState().appendMessage(threadId, {
      id: 'user-1',
      role: 'user',
      content: 'Original prompt',
      createdAt: 1,
      state: 'complete',
    });
    useChatStore.getState().appendMessage(threadId, {
      id: 'assistant-1',
      role: 'assistant',
      content: 'Original answer',
      createdAt: 2,
      state: 'complete',
    });
    useChatStore.getState().appendMessage(threadId, {
      id: 'user-2',
      role: 'user',
      content: 'New prompt',
      createdAt: 3,
      state: 'complete',
    });
    const replacementId = useChatStore.getState().createAssistantPlaceholder(threadId);
    const before = useChatStore.getState().getThread(threadId);

    useChatStore.getState().patchAssistantMessage(threadId, 'assistant-1', {
      content: 'Late stale token',
      state: 'complete',
    });

    const after = useChatStore.getState().getThread(threadId);
    expect(after).toBe(before);
    expect(after?.messages.find((message) => message.id === 'assistant-1')).toEqual(
      expect.objectContaining({
        content: 'Original answer',
        state: 'complete',
      }),
    );
    expect(after?.messages.at(-1)).toEqual(
      expect.objectContaining({
        id: replacementId,
        state: 'streaming',
      }),
    );
  });

  it('ignores late streaming patches after the assistant message is stopped', () => {
    const threadId = useChatStore.getState().createThread({
      modelId: 'author/model-q4',
      presetId: null,
      presetSnapshot: {
        id: null,
        name: 'Default',
        systemPrompt: 'You are helpful.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 1024,
        seed: null,
      },
    });

    const assistantId = useChatStore.getState().createAssistantPlaceholder(threadId);
    useChatStore.getState().stopAssistantMessage(threadId, assistantId);
    const before = useChatStore.getState().getThread(threadId);

    useChatStore.getState().patchAssistantMessage(threadId, assistantId, {
      content: 'Late token after stop',
      state: 'streaming',
    });

    const after = useChatStore.getState().getThread(threadId);
    expect(after).toBe(before);
    expect(after?.messages.at(-1)).toEqual(
      expect.objectContaining({
        id: assistantId,
        content: '',
        state: 'stopped',
      }),
    );
  });

  it('stops an assistant message and marks the thread as stopped', () => {
    const threadId = useChatStore.getState().createThread({
      modelId: 'author/model-q4',
      presetId: null,
      presetSnapshot: {
        id: null,
        name: 'Default',
        systemPrompt: 'You are helpful.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 1024,
        seed: null,
      },
    });

    const assistantId = useChatStore.getState().createAssistantPlaceholder(threadId);
    useChatStore.getState().patchAssistantMessage(threadId, assistantId, {
      content: 'Partial reply',
      state: 'streaming',
    });

    useChatStore.getState().stopAssistantMessage(threadId, assistantId);

    const thread = useChatStore.getState().getThread(threadId);
    expect(thread?.status).toBe('stopped');
    expect(thread?.messages.at(-1)).toEqual(
      expect.objectContaining({
        id: assistantId,
        content: 'Partial reply',
        state: 'stopped',
      }),
    );
  });

  it('replaces the last assistant message for regeneration', () => {
    const threadId = useChatStore.getState().createThread({
      modelId: 'author/model-q4',
      presetId: null,
      presetSnapshot: {
        id: null,
        name: 'Default',
        systemPrompt: 'You are helpful.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 1024,
        seed: null,
      },
    });

    useChatStore.getState().appendMessage(threadId, {
      id: 'user-1',
      role: 'user',
      content: 'Hello there',
      createdAt: Date.now(),
      state: 'complete',
    });
    useChatStore.getState().appendMessage(threadId, {
      id: 'assistant-1',
      role: 'assistant',
      content: 'Original reply',
      createdAt: Date.now(),
      state: 'complete',
    });

    const replacementId = useChatStore.getState().replaceLastAssistantMessage(threadId);
    const thread = useChatStore.getState().getThread(threadId);
    const replacement = thread?.messages.at(-1);

    expect(replacementId).toBeTruthy();
    expect(thread?.status).toBe('generating');
    expect(replacement).toEqual(
      expect.objectContaining({
        id: replacementId,
        role: 'assistant',
        content: '',
        state: 'streaming',
        regeneratesMessageId: 'assistant-1',
        kind: 'message',
        modelId: 'author/model-q4',
      }),
    );
  });

  it('keeps the previous durable answer when regeneration crashes before first output', async () => {
    const durableThread = buildCompletedRegenerationThread('thread-regeneration-before-output');
    seedPersistedChatThread(durableThread);
    const persistedBefore = storage.getString(getChatThreadStorageKey(durableThread.id));
    const messageCountBefore = durableThread.messages.length;
    const appStorage = getAppStorage() as unknown as { set: jest.Mock };
    const originalSet = appStorage.set;
    const writtenKeys: string[] = [];
    appStorage.set = jest.fn(function setWithKeyCapture(this: unknown, key: string, value: unknown) {
      writtenKeys.push(key);
      return originalSet.call(this, key, value);
    });

    try {
      const replacementId = useChatStore.getState().replaceLastAssistantMessage(durableThread.id);

      expect(replacementId).toBeTruthy();
      expect(useChatStore.getState().threads[durableThread.id]).toBe(durableThread);
      expect(useChatStore.getState().threads[durableThread.id].messages).toBe(durableThread.messages);
      expect(useChatStore.getState().getThread(durableThread.id)).toEqual(expect.objectContaining({
        status: 'generating',
        messages: [
          durableThread.messages[0],
          expect.objectContaining({
            id: replacementId,
            content: '',
            state: 'streaming',
            regeneratesMessageId: `${durableThread.id}-assistant-original`,
          }),
        ],
      }));
      expect(storage.getString(getChatThreadStorageKey(durableThread.id))).toBe(persistedBefore);
      expect(readChatStreamingProgressRecord(storage, durableThread.id)).toEqual({
        ok: false,
        reason: 'missing',
      });
      expect(writtenKeys.filter((key) => key === getChatThreadStorageKey(durableThread.id))).toHaveLength(0);
      expect(writtenKeys.filter((key) => key === getChatStreamingProgressStorageKey(durableThread.id))).toHaveLength(0);
      expect(writtenKeys.filter((key) => key === CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY)).toHaveLength(0);
      expect(writtenKeys.filter((key) => key === CHAT_PERSISTENCE_INDEX_KEY)).toHaveLength(0);
    } finally {
      appStorage.set = originalSet;
    }

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    const recoveredThread = useChatStore.getState().getThread(durableThread.id);
    expect(recoveredThread?.messages).toHaveLength(messageCountBefore);
    expect(recoveredThread?.messages.at(-1)).toEqual(expect.objectContaining({
      id: `${durableThread.id}-assistant-original`,
      content: 'Original durable answer',
      state: 'complete',
    }));
    expect(recoveredThread?.messages.some((message) => message.state === 'stopped')).toBe(false);
  });

  it('recovers partial regenerated progress by replacing the original answer', async () => {
    const durableThread = buildCompletedRegenerationThread('thread-regeneration-partial-crash');
    seedPersistedChatThread(durableThread);

    const replacementId = useChatStore.getState().replaceLastAssistantMessage(durableThread.id);
    expect(replacementId).toBeTruthy();
    useChatStore.getState().patchAssistantMessage(durableThread.id, replacementId!, {
      content: 'Recovered regenerated partial',
      thoughtContent: 'Recovered regenerated reasoning',
      tokensPerSec: 6.5,
    });
    flushPendingChatPersistenceWrites('background');

    expect(readChatThreadRecord(storage, durableThread.id)).toEqual({
      ok: true,
      value: expect.objectContaining({
        thread: expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              id: `${durableThread.id}-assistant-original`,
              content: 'Original durable answer',
            }),
          ]),
        }),
      }),
    });
    expect(readChatStreamingProgressRecord(storage, durableThread.id)).toEqual({
      ok: true,
      value: expect.objectContaining({
        messageId: replacementId,
        content: 'Recovered regenerated partial',
        regeneratesMessageId: `${durableThread.id}-assistant-original`,
      }),
    });

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    const recoveredThread = useChatStore.getState().getThread(durableThread.id)!;
    expect(recoveredThread.messages).toHaveLength(durableThread.messages.length);
    expect(recoveredThread.messages.filter((message) => message.role === 'assistant')).toEqual([
      expect.objectContaining({
        id: replacementId,
        content: 'Recovered regenerated partial',
        thoughtContent: 'Recovered regenerated reasoning',
        tokensPerSec: 6.5,
        state: 'stopped',
        regeneratesMessageId: `${durableThread.id}-assistant-original`,
      }),
    ]);
    expect(storage.getString(getChatThreadStorageKey(durableThread.id))).not.toContain('Original durable answer');
    expect(readChatStreamingProgressRecord(storage, durableThread.id)).toEqual({
      ok: false,
      reason: 'missing',
    });
  });

  it('recovers regenerated progress when the durable target is future-dated', async () => {
    const baseThread = buildCompletedRegenerationThread('thread-regeneration-clock-rollback');
    const targetCreatedAt = 5_000;
    const durableThread: ChatThread = {
      ...baseThread,
      messages: baseThread.messages.map((message) => (
        message.role === 'assistant'
          ? { ...message, createdAt: targetCreatedAt }
          : message
      )),
      updatedAt: targetCreatedAt,
    };
    seedPersistedChatThread(durableThread, 100);
    const dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000);

    try {
      const replacementId = useChatStore.getState().replaceLastAssistantMessage(durableThread.id)!;
      expect(useChatStore.getState().getThread(durableThread.id)?.messages.at(-1)?.createdAt).toBe(
        targetCreatedAt,
      );
      useChatStore.getState().patchAssistantMessage(durableThread.id, replacementId, {
        content: 'Partial generated after a clock rollback',
      });
      flushPendingChatPersistenceWrites('background');
      expect(readChatStreamingProgressRecord(storage, durableThread.id)).toEqual({
        ok: true,
        value: expect.objectContaining({
          messageId: replacementId,
          createdAt: targetCreatedAt,
          regeneratesMessageId: `${durableThread.id}-assistant-original`,
        }),
      });

      useChatStore.setState({ threads: {}, activeThreadId: null });
      await useChatStore.persist.rehydrate();

      expect(useChatStore.getState().getThread(durableThread.id)?.messages.at(-1)).toEqual(
        expect.objectContaining({
          id: replacementId,
          content: 'Partial generated after a clock rollback',
          createdAt: targetCreatedAt,
          state: 'stopped',
        }),
      );
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it('atomically commits successful regenerated output', () => {
    const durableThread = buildCompletedRegenerationThread('thread-regeneration-success');
    seedPersistedChatThread(durableThread);
    const replacementId = useChatStore.getState().replaceLastAssistantMessage(durableThread.id)!;
    useChatStore.getState().patchAssistantMessage(durableThread.id, replacementId, {
      content: 'Buffered regenerated output',
    });
    flushPendingChatPersistenceWrites('background');

    const mutationCounter = createMutationCounter(useChatStore.subscribe);
    const appStorage = getAppStorage() as unknown as { set: jest.Mock };
    const originalSet = appStorage.set;
    const writtenKeys: string[] = [];
    appStorage.set = jest.fn(function setWithKeyCapture(this: unknown, key: string, value: unknown) {
      writtenKeys.push(key);
      return originalSet.call(this, key, value);
    });
    const previousEnabled = performanceMonitor.isEnabled();
    performanceMonitor.setEnabled(true);
    performanceMonitor.clear();

    try {
      expect(useChatStore.getState().finalizeAssistantTurn(durableThread.id, replacementId, {
        outcome: 'success',
        content: 'Final regenerated answer',
      })).toEqual({ status: 'committed' });

      const finalized = useChatStore.getState().getThread(durableThread.id)!;
      expect(mutationCounter.getCount()).toBe(1);
      expect(finalized.messages).toHaveLength(durableThread.messages.length);
      expect(finalized.messages.filter((message) => message.role === 'assistant')).toEqual([
        expect.objectContaining({
          id: replacementId,
          content: 'Final regenerated answer',
          state: 'complete',
          regeneratesMessageId: `${durableThread.id}-assistant-original`,
        }),
      ]);
      expect(storage.getString(getChatThreadStorageKey(durableThread.id))).not.toContain('Original durable answer');
      expect(writtenKeys.filter((key) => key === getChatThreadStorageKey(durableThread.id))).toHaveLength(1);
      expect(writtenKeys.filter((key) => key === CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY)).toHaveLength(1);
      expect(writtenKeys.filter((key) => key === CHAT_PERSISTENCE_INDEX_KEY)).toHaveLength(1);
      expect(readChatStreamingProgressRecord(storage, durableThread.id)).toEqual({
        ok: false,
        reason: 'missing',
      });
      expect(performanceMonitor.snapshot().counters).toEqual(expect.objectContaining({
        'chat.turn.storeMutations': 1,
        'chat.turn.persistenceTransactions': 1,
        'chat.persist.terminal': 1,
      }));
    } finally {
      appStorage.set = originalSet;
      mutationCounter.unsubscribe();
      performanceMonitor.clear();
      performanceMonitor.setEnabled(previousEnabled);
    }
  });

  it('keeps recovery data when regenerated terminal persistence fails', () => {
    const durableThread = buildCompletedRegenerationThread('thread-regeneration-terminal-failure');
    seedPersistedChatThread(durableThread);
    const replacementId = useChatStore.getState().replaceLastAssistantMessage(durableThread.id)!;
    useChatStore.getState().patchAssistantMessage(durableThread.id, replacementId, {
      content: 'Recoverable regenerated partial',
      thoughtContent: 'Recoverable regenerated thought',
    });
    flushPendingChatPersistenceWrites('background');

    const appStorage = getAppStorage() as unknown as { set: jest.Mock };
    const originalSet = appStorage.set;
    const writeError = new Error('simulated regenerated terminal write failure');
    let failed = false;
    appStorage.set = jest.fn(function setWithFailure(this: unknown, key: string, value: unknown) {
      if (
        !failed
        && key === getChatThreadStorageKey(durableThread.id)
        && typeof value === 'string'
        && value.includes('Regenerated final that fails')
      ) {
        failed = true;
        throw writeError;
      }
      return originalSet.call(this, key, value);
    });

    try {
      expect(useChatStore.getState().finalizeAssistantTurn(
        durableThread.id,
        replacementId,
        { outcome: 'success', content: 'Regenerated final that fails' },
      )).toEqual(expect.objectContaining({
        status: 'persistence_failed',
        error: writeError,
      }));

      expect(readChatThreadRecord(storage, durableThread.id)).toEqual({
        ok: true,
        value: expect.objectContaining({
          thread: expect.objectContaining({
            messages: expect.arrayContaining([
              expect.objectContaining({
                id: `${durableThread.id}-assistant-original`,
                content: 'Original durable answer',
              }),
            ]),
          }),
        }),
      });
      expect(readChatStreamingProgressRecord(storage, durableThread.id)).toEqual({
        ok: true,
        value: expect.objectContaining({
          messageId: replacementId,
          content: 'Recoverable regenerated partial',
          thoughtContent: 'Recoverable regenerated thought',
          regeneratesMessageId: `${durableThread.id}-assistant-original`,
        }),
      });
      expect(useChatStore.getState().threads[durableThread.id].messages.at(-1)).toBe(
        durableThread.messages.at(-1),
      );
      expect(useChatStore.getState().getThread(durableThread.id)?.messages.at(-1)).toEqual(
        expect.objectContaining({
          id: replacementId,
          content: 'Recoverable regenerated partial',
          state: 'streaming',
        }),
      );
    } finally {
      appStorage.set = originalSet;
      useChatStore.getState().stopAssistantMessage(durableThread.id, replacementId);
    }
  });

  it.each([
    { outcome: 'stopped' as const },
    {
      outcome: 'error' as const,
      errorCode: 'prompt_preparation_failed',
      errorMessage: 'Prompt preparation failed before output',
    },
  ])('restores the previous answer for $outcome before first regenerated output', (finalization) => {
    const durableThread = buildCompletedRegenerationThread(`thread-regeneration-${finalization.outcome}-empty`);
    seedPersistedChatThread(durableThread);
    const originalAssistant = durableThread.messages.at(-1);
    const durableRecord = storage.getString(getChatThreadStorageKey(durableThread.id));
    const replacementId = useChatStore.getState().replaceLastAssistantMessage(durableThread.id)!;
    const capture = captureChatPersistenceWrites();
    const previousEnabled = performanceMonitor.isEnabled();
    performanceMonitor.setEnabled(true);
    performanceMonitor.clear();

    try {
      expect(useChatStore.getState().finalizeAssistantTurn(
        durableThread.id,
        replacementId,
        finalization,
      )).toEqual({ status: 'restored_without_write' });

      expect(useChatStore.getState().threads[durableThread.id]).toBe(durableThread);
      const restored = useChatStore.getState().getThread(durableThread.id)!;
      expect(restored.status).toBe('idle');
      expect(restored.messages).toBe(durableThread.messages);
      expect(restored.messages.at(-1)).toBe(originalAssistant);
      expect(restored.messages.at(-1)).toEqual(expect.objectContaining({
        id: `${durableThread.id}-assistant-original`,
        content: 'Original durable answer',
        state: 'complete',
      }));
      expect(restored.messages.some((message) => message.id === replacementId)).toBe(false);
      expect(storage.getString(getChatThreadStorageKey(durableThread.id))).toBe(durableRecord);
      expect(capture.setKeys).not.toContain(getChatThreadStorageKey(durableThread.id));
      expect(capture.setKeys).not.toContain(CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY);
      expect(capture.setKeys).not.toContain(CHAT_PERSISTENCE_INDEX_KEY);
      const snapshot = performanceMonitor.snapshot();
      expect(snapshot.counters['chat.turn.persistenceTransactions'] ?? 0).toBe(0);
      expect(snapshot.counters['chat.persist.terminal'] ?? 0).toBe(0);
      expect(snapshot.events.filter(
        (event) => event.name === 'chat.persist.stringify' && event.meta?.recordKind === 'thread',
      )).toHaveLength(0);
      expect(readChatStreamingProgressRecord(storage, durableThread.id)).toEqual({
        ok: false,
        reason: 'missing',
      });

      useChatStore.getState().patchAssistantMessage(durableThread.id, replacementId, {
        content: 'Late direct replacement output',
      });
      expect(useChatStore.getState().finalizeAssistantTurn(
        durableThread.id,
        replacementId,
        { outcome: 'success', content: 'Late direct replacement terminal output' },
      )).toEqual({ status: 'stale' });
      expect(useChatStore.getState().threads[durableThread.id]).toBe(durableThread);
      expect(useChatStore.getState().threads[durableThread.id].messages.at(-1)).toBe(
        originalAssistant,
      );
    } finally {
      capture.restore();
      performanceMonitor.clear();
      performanceMonitor.setEnabled(previousEnabled);
    }
  });

  it('preserves the previous answer when direct regeneration succeeds without output', () => {
    const durableThread = buildCompletedRegenerationThread('thread-regeneration-success-empty');
    seedPersistedChatThread(durableThread);
    const replacementId = useChatStore.getState().replaceLastAssistantMessage(durableThread.id)!;

    expect(useChatStore.getState().finalizeAssistantTurn(
      durableThread.id,
      replacementId,
      {
        outcome: 'success',
        content: '',
        thoughtContent: null,
      },
    )).toEqual({ status: 'restored_without_write' });

    const restored = useChatStore.getState().getThread(durableThread.id)!;
    expect(restored.messages).toHaveLength(durableThread.messages.length);
    expect(restored.messages.at(-1)).toBe(durableThread.messages.at(-1));
    expect(restored.messages.at(-1)).toEqual(expect.objectContaining({
      id: `${durableThread.id}-assistant-original`,
      content: 'Original durable answer',
      state: 'complete',
    }));
    expect(restored.messages.some((message) => message.id === replacementId)).toBe(false);
  });

  it('ignores stale callbacks after a newer regeneration replaces the transient runtime', () => {
    const durableThread = buildCompletedRegenerationThread('thread-regeneration-stale-callback');
    seedPersistedChatThread(durableThread);
    const staleReplacementId = useChatStore.getState().replaceLastAssistantMessage(durableThread.id)!;
    expect(useChatStore.getState().replaceLastAssistantMessage(durableThread.id)).toBeNull();
    expect(useChatStore.getState().finalizeAssistantTurn(
      durableThread.id,
      staleReplacementId,
      { outcome: 'stopped' },
    )).toEqual({ status: 'restored_without_write' });
    const currentReplacementId = useChatStore.getState().replaceLastAssistantMessage(durableThread.id)!;

    useChatStore.getState().patchAssistantMessage(durableThread.id, staleReplacementId, {
      content: 'Stale output that must be ignored',
    });
    expect(useChatStore.getState().finalizeAssistantTurn(
      durableThread.id,
      staleReplacementId,
      { outcome: 'success', content: 'Stale terminal output' },
    )).toEqual({ status: 'stale' });

    expect(useChatStore.getState().getThread(durableThread.id)?.messages.at(-1)).toEqual(
      expect.objectContaining({
        id: currentReplacementId,
        content: '',
        state: 'streaming',
      }),
    );
    useChatStore.getState().patchAssistantMessage(durableThread.id, currentReplacementId, {
      content: 'Current regenerated output',
    });
    useChatStore.getState().stopAssistantMessage(durableThread.id, currentReplacementId);
  });

  it('does not create a regeneration overlay when private storage is unavailable', () => {
    const durableThread = buildCompletedRegenerationThread('thread-regeneration-storage-blocked');
    seedPersistedChatThread(durableThread);
    const persistedBefore = storage.getString(getChatThreadStorageKey(durableThread.id));
    const blockedError = new Error('private storage blocked');
    const writabilitySpy = jest
      .spyOn(privateStorageService, 'assertPrivateStorageWritable')
      .mockImplementation(() => {
        throw blockedError;
      });

    let thrown: unknown;
    try {
      useChatStore.getState().replaceLastAssistantMessage(durableThread.id);
    } catch (error) {
      thrown = error;
    }
    writabilitySpy.mockRestore();

    expect(thrown).toBe(blockedError);
    expect(useChatStore.getState().getThread(durableThread.id)).toBe(durableThread);
    expect(storage.getString(getChatThreadStorageKey(durableThread.id))).toBe(persistedBefore);
    expect(readChatStreamingProgressRecord(storage, durableThread.id)).toEqual({
      ok: false,
      reason: 'missing',
    });
  });

  it('discards regenerated progress and stale callbacks when the thread is deleted', () => {
    const durableThread = buildCompletedRegenerationThread('thread-regeneration-delete');
    seedPersistedChatThread(durableThread);
    const replacementId = useChatStore.getState().replaceLastAssistantMessage(durableThread.id)!;
    useChatStore.getState().patchAssistantMessage(durableThread.id, replacementId, {
      content: 'Partial output before deletion',
    });
    flushPendingChatPersistenceWrites('background');
    expect(readChatStreamingProgressRecord(storage, durableThread.id).ok).toBe(true);

    useChatStore.getState().deleteThread(durableThread.id);

    expect(useChatStore.getState().getThread(durableThread.id)).toBeNull();
    expect(readChatStreamingProgressRecord(storage, durableThread.id)).toEqual({
      ok: false,
      reason: 'missing',
    });
    expect(useChatStore.getState().finalizeAssistantTurn(
      durableThread.id,
      replacementId,
      { outcome: 'success', content: 'Late callback after deletion' },
    )).toEqual({ status: 'stale' });
  });

  it('replaces a message branch from a selected user turn', () => {
    const threadId = useChatStore.getState().createThread({
      modelId: 'author/model-q4',
      presetId: null,
      presetSnapshot: {
        id: null,
        name: 'Default',
        systemPrompt: 'You are helpful.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 1024,
        seed: null,
      },
    });

    useChatStore.getState().appendMessage(threadId, {
      id: 'user-1',
      role: 'user',
      content: 'First prompt',
      createdAt: 1,
      state: 'complete',
    });
    useChatStore.getState().appendMessage(threadId, {
      id: 'assistant-1',
      role: 'assistant',
      content: 'First reply',
      createdAt: 2,
      state: 'complete',
    });
    useChatStore.getState().appendMessage(threadId, {
      id: 'user-2',
      role: 'user',
      content: 'Second prompt',
      createdAt: 3,
      state: 'complete',
    });
    useChatStore.getState().appendMessage(threadId, {
      id: 'assistant-2',
      role: 'assistant',
      content: 'Second reply',
      createdAt: 4,
      state: 'complete',
    });

    const replacementAssistantId = useChatStore.getState().replaceBranchFromUserMessage(
      threadId,
      'user-1',
      'Edited first prompt',
    );

    expect(replacementAssistantId).toBeTruthy();
    expect(useChatStore.getState().getThread(threadId)?.messages).toEqual([
      expect.objectContaining({
        id: 'user-1',
        role: 'user',
        content: 'Edited first prompt',
        kind: 'message',
        modelId: 'author/model-q4',
      }),
      expect.objectContaining({
        id: replacementAssistantId,
        role: 'assistant',
        content: '',
        state: 'streaming',
        kind: 'message',
        modelId: 'author/model-q4',
      }),
    ]);
  });

  it('trims edited user branch content and rejects empty branch edits inside the store', () => {
    const threadId = useChatStore.getState().createThread({
      modelId: 'author/model-q4',
      presetId: null,
      presetSnapshot: {
        id: null,
        name: 'Default',
        systemPrompt: 'You are helpful.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 1024,
        seed: null,
      },
    });

    useChatStore.getState().appendMessage(threadId, {
      id: 'user-1',
      role: 'user',
      content: 'First prompt',
      createdAt: 1,
      state: 'complete',
    });
    useChatStore.getState().appendMessage(threadId, {
      id: 'assistant-1',
      role: 'assistant',
      content: 'First reply',
      createdAt: 2,
      state: 'complete',
    });

    const replacementAssistantId = useChatStore.getState().replaceBranchFromUserMessage(
      threadId,
      'user-1',
      '  Edited first prompt  ',
    );

    expect(replacementAssistantId).toBeTruthy();
    expect(useChatStore.getState().getThread(threadId)?.messages[0]).toEqual(
      expect.objectContaining({
        id: 'user-1',
        content: 'Edited first prompt',
      }),
    );

    const beforeEmptyEdit = useChatStore.getState().getThread(threadId);
    expect(useChatStore.getState().replaceBranchFromUserMessage(threadId, 'user-1', '   ')).toBeNull();
    expect(useChatStore.getState().getThread(threadId)).toBe(beforeEmptyEdit);
  });

  it('rejects oversized branch content before runtime creation while preserving the recoverable boundary', () => {
    const thread = buildTrailingModelSwitchThread('thread-branch-content-limit');
    seedPersistedChatThread(thread, 100);
    const rawThread = useChatStore.getState().threads[thread.id];
    const durableRecordBefore = storage.getString(getChatThreadStorageKey(thread.id));

    expect(useChatStore.getState().replaceBranchFromUserMessage(
      thread.id,
      `${thread.id}-user-1`,
      'x'.repeat(MAX_CHAT_BRANCH_REPLACEMENT_CONTENT_LENGTH + 1),
    )).toBeNull();
    expect(useChatStore.getState().threads[thread.id]).toBe(rawThread);
    expect(useChatStore.getState().getThread(thread.id)).toBe(rawThread);
    expect(storage.getString(getChatThreadStorageKey(thread.id))).toBe(durableRecordBefore);
    expectNoStreamingProgressArtifacts(thread.id);

    const assistantId = useChatStore.getState().replaceBranchFromUserMessage(
      thread.id,
      `${thread.id}-user-1`,
      'x'.repeat(MAX_CHAT_BRANCH_REPLACEMENT_CONTENT_LENGTH),
    )!;
    useChatStore.getState().patchAssistantMessage(thread.id, assistantId, {
      content: 'Recoverable output at the branch content boundary',
    });
    flushPendingChatPersistenceWrites('background');

    const progress = readChatStreamingProgressRecord(storage, thread.id);
    expect(progress.ok).toBe(true);
    if (!progress.ok) {
      throw new Error('Expected boundary-sized branch progress to remain parseable');
    }
    const persistedReplacementContent = progress.value.branchReplacement
      ?.replacementUserMessage.content;
    expect(persistedReplacementContent).toHaveLength(MAX_CHAT_BRANCH_REPLACEMENT_CONTENT_LENGTH);
    expect(persistedReplacementContent?.startsWith('x')).toBe(true);
    expect(persistedReplacementContent?.endsWith('x')).toBe(true);
    expect(storage.getString(getChatThreadStorageKey(thread.id))).toBe(durableRecordBefore);

    useChatStore.getState().stopAssistantMessage(thread.id, assistantId);
  });

  it('rejects a combined multi-byte branch operation before transient runtime creation', () => {
    const thread = buildTrailingModelSwitchThread('thread-branch-operation-utf8-overflow');
    const target = thread.messages[0];
    const oversizedOperationThread: ChatThread = {
      ...thread,
      messages: [{
        ...target,
        contentParts: [{ type: 'text', text: '界'.repeat(100_000) }],
      }, ...thread.messages.slice(1)],
    };
    seedPersistedChatThread(oversizedOperationThread, 100);
    const rawThread = useChatStore.getState().threads[thread.id];
    const durableRecordBefore = storage.getString(getChatThreadStorageKey(thread.id));

    expect(useChatStore.getState().replaceBranchFromUserMessage(
      thread.id,
      `${thread.id}-user-1`,
      '界'.repeat(100_000),
    )).toBeNull();
    expect(useChatStore.getState().threads[thread.id]).toBe(rawThread);
    expect(useChatStore.getState().getThread(thread.id)).toBe(rawThread);
    expect(storage.getString(getChatThreadStorageKey(thread.id))).toBe(durableRecordBefore);
    expectNoStreamingProgressArtifacts(thread.id);
  });

  it('rejects oversized or cyclic branch metadata before creating transient state', () => {
    const scenarios: Array<{
      name: string;
      mutateTarget: (target: ChatMessage) => ChatMessage;
    }> = [
      {
        name: 'attachment count',
        mutateTarget: (target) => ({
          ...target,
          attachments: Array.from(
            { length: MAX_CHAT_BRANCH_REPLACEMENT_ATTACHMENTS + 1 },
            (_unused, index) => buildStoredAttachment(
              target.id.split('-user-1')[0],
              target.id,
              `oversized-${index}.jpg`,
            ),
          ),
        }),
      },
      {
        name: 'attachment metadata bytes',
        mutateTarget: (target) => ({
          ...target,
          attachments: [{
            ...buildStoredAttachment(
              target.id.split('-user-1')[0],
              target.id,
              'oversized-metadata.jpg',
            ),
            fileName: 'x'.repeat(MAX_CHAT_BRANCH_REPLACEMENT_ATTACHMENT_METADATA_BYTES + 1),
          }],
        }),
      },
      {
        name: 'content part count',
        mutateTarget: (target) => ({
          ...target,
          contentParts: Array.from(
            { length: MAX_CHAT_BRANCH_REPLACEMENT_CONTENT_PARTS + 1 },
            () => ({ type: 'text' as const, text: 'bounded' }),
          ),
        }),
      },
      {
        name: 'aggregate content part text',
        mutateTarget: (target) => ({
          ...target,
          contentParts: [{
            type: 'text',
            text: 'x'.repeat(MAX_CHAT_BRANCH_REPLACEMENT_CONTENT_PART_TOTAL_CHARS + 1),
          }],
        }),
      },
      {
        name: 'malformed nested content part',
        mutateTarget: (target) => ({
          ...target,
          contentParts: [null] as unknown as ChatMessage['contentParts'],
        }),
      },
      {
        name: 'cyclic attachment metadata',
        mutateTarget: (target) => {
          const attachment = buildStoredAttachment(
            target.id.split('-user-1')[0],
            target.id,
            'cyclic.jpg',
          ) as ReturnType<typeof buildStoredAttachment> & { cycle?: unknown };
          attachment.cycle = attachment;
          return { ...target, attachments: [attachment] };
        },
      },
    ];

    scenarios.forEach(({ name, mutateTarget }, index) => {
      const thread = buildTrailingModelSwitchThread(`thread-branch-bounds-${index}`);
      seedPersistedChatThread(thread, 100);
      const durableRecordBefore = storage.getString(getChatThreadStorageKey(thread.id));
      const pollutedThread = {
        ...thread,
        messages: [mutateTarget(thread.messages[0]), ...thread.messages.slice(1)],
      };
      useChatStore.setState({
        threads: { [thread.id]: pollutedThread },
        activeThreadId: thread.id,
      });

      expect(useChatStore.getState().replaceBranchFromUserMessage(
        thread.id,
        `${thread.id}-user-1`,
        `Rejected ${name}`,
      )).toBeNull();
      expect(useChatStore.getState().threads[thread.id]).toBe(pollutedThread);
      expect(storage.getString(getChatThreadStorageKey(thread.id))).toBe(durableRecordBefore);
      expectNoStreamingProgressArtifacts(thread.id);
    });
  });

  it('preserves image-only user attachments when regenerating a branch with empty text', () => {
    const threadId = useChatStore.getState().createThread({
      modelId: 'author/model-q4',
      presetId: null,
      presetSnapshot: {
        id: null,
        name: 'Default',
        systemPrompt: 'You are helpful.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 1024,
        seed: null,
      },
    });
    const attachment = buildStoredAttachment(threadId, 'user-1', 'image-only.jpg');

    useChatStore.getState().appendMessage(threadId, {
      id: 'user-1',
      role: 'user',
      content: '',
      attachments: [attachment],
      createdAt: 1,
      state: 'complete',
    });
    useChatStore.getState().appendMessage(threadId, {
      id: 'assistant-1',
      role: 'assistant',
      content: 'First reply',
      createdAt: 2,
      state: 'complete',
    });

    const replacementAssistantId = useChatStore.getState().replaceBranchFromUserMessage(
      threadId,
      'user-1',
      '   ',
    );

    expect(replacementAssistantId).toBeTruthy();
    expect(useChatStore.getState().getThread(threadId)?.messages).toEqual([
      expect.objectContaining({
        id: 'user-1',
        role: 'user',
        content: '',
        attachments: [attachment],
      }),
      expect.objectContaining({
        id: replacementAssistantId,
        role: 'assistant',
        content: '',
        state: 'streaming',
      }),
    ]);
  });

  it('replaces an older user branch with the active switched model metadata', () => {
    const threadId = useChatStore.getState().createThread({
      modelId: 'author/model-q4',
      presetId: null,
      presetSnapshot: {
        id: null,
        name: 'Default',
        systemPrompt: 'You are helpful.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 1024,
        seed: null,
      },
    });

    useChatStore.getState().appendMessage(threadId, {
      id: 'user-1',
      role: 'user',
      content: 'First prompt',
      createdAt: 1,
      state: 'complete',
    });
    useChatStore.getState().appendMessage(threadId, {
      id: 'assistant-1',
      role: 'assistant',
      content: 'First reply',
      createdAt: 2,
      state: 'complete',
    });
    useChatStore.getState().appendMessage(threadId, {
      id: 'user-2',
      role: 'user',
      content: 'Second prompt',
      createdAt: 3,
      state: 'complete',
    });
    useChatStore.getState().appendMessage(threadId, {
      id: 'assistant-2',
      role: 'assistant',
      content: 'Second reply',
      createdAt: 4,
      state: 'complete',
    });

    useChatStore.getState().switchThreadModel(threadId, 'author/model-q8', 5);

    const replacementAssistantId = useChatStore.getState().replaceBranchFromUserMessage(
      threadId,
      'user-1',
      'Edited first prompt',
    );

    expect(replacementAssistantId).toBeTruthy();
    expect(useChatStore.getState().getThread(threadId)?.messages).toEqual([
      expect.objectContaining({
        id: 'user-1',
        role: 'user',
        content: 'Edited first prompt',
        kind: 'message',
        modelId: 'author/model-q8',
      }),
      expect.objectContaining({
        id: replacementAssistantId,
        role: 'assistant',
        content: '',
        state: 'streaming',
        kind: 'message',
        modelId: 'author/model-q8',
      }),
    ]);
  });

  it('inserts a replacement model switch when regenerating an older branch after multiple switches', () => {
    const threadId = useChatStore.getState().createThread({
      modelId: 'author/model-q4',
      presetId: null,
      presetSnapshot: {
        id: null,
        name: 'Default',
        systemPrompt: 'You are helpful.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 1024,
        seed: null,
      },
    });

    useChatStore.getState().appendMessage(threadId, {
      id: 'user-1',
      role: 'user',
      content: 'First prompt',
      createdAt: 1,
      state: 'complete',
    });
    useChatStore.getState().appendMessage(threadId, {
      id: 'assistant-1',
      role: 'assistant',
      content: 'First reply',
      createdAt: 2,
      state: 'complete',
    });

    const firstSwitchId = useChatStore.getState().switchThreadModel(threadId, 'author/model-q8', 3);

    useChatStore.getState().appendMessage(threadId, {
      id: 'user-2',
      role: 'user',
      content: 'Second prompt',
      createdAt: 4,
      state: 'complete',
    });
    useChatStore.getState().appendMessage(threadId, {
      id: 'assistant-2',
      role: 'assistant',
      content: 'Second reply',
      createdAt: 5,
      state: 'complete',
    });

    useChatStore.getState().switchThreadModel(threadId, 'author/model-q6', 6);

    const replacementAssistantId = useChatStore.getState().replaceBranchFromUserMessage(
      threadId,
      'user-2',
      'Edited second prompt',
    );

    const thread = useChatStore.getState().getThread(threadId);
    const modelSwitchMessages = thread?.messages.filter((message) => message.kind === 'model_switch') ?? [];

    expect(firstSwitchId).toBeTruthy();
    expect(replacementAssistantId).toBeTruthy();
    expect(thread?.activeModelId).toBe('author/model-q6');
    expect(modelSwitchMessages).toHaveLength(2);
    expect(modelSwitchMessages).toEqual([
      expect.objectContaining({
        id: firstSwitchId,
        switchFromModelId: 'author/model-q4',
        switchToModelId: 'author/model-q8',
      }),
      expect.objectContaining({
        switchFromModelId: 'author/model-q8',
        switchToModelId: 'author/model-q6',
      }),
    ]);
    expect(thread?.messages).toEqual([
      expect.objectContaining({
        id: 'user-1',
        role: 'user',
        content: 'First prompt',
        modelId: 'author/model-q4',
      }),
      expect.objectContaining({
        id: 'assistant-1',
        role: 'assistant',
        content: 'First reply',
        modelId: 'author/model-q4',
      }),
      expect.objectContaining({
        id: firstSwitchId,
        kind: 'model_switch',
        switchToModelId: 'author/model-q8',
      }),
      expect.objectContaining({
        kind: 'model_switch',
        switchFromModelId: 'author/model-q8',
        switchToModelId: 'author/model-q6',
      }),
      expect.objectContaining({
        id: 'user-2',
        role: 'user',
        content: 'Edited second prompt',
        kind: 'message',
        modelId: 'author/model-q6',
      }),
      expect.objectContaining({
        id: replacementAssistantId,
        role: 'assistant',
        content: '',
        state: 'streaming',
        kind: 'message',
        modelId: 'author/model-q6',
      }),
    ]);
  });

  it('does not start branch replacement without a durable base record', () => {
    const thread = buildTrailingModelSwitchThread('thread-branch-missing-durable-base');
    useChatStore.setState({
      threads: { [thread.id]: thread },
      activeThreadId: thread.id,
    });

    expect(useChatStore.getState().replaceBranchFromUserMessage(
      thread.id,
      `${thread.id}-user-1`,
      'Edited without a durable base',
    )).toBeNull();
    expect(useChatStore.getState().threads[thread.id]).toBe(thread);
    expect(useChatStore.getState().getThread(thread.id)).toBe(thread);
    expectNoStreamingProgressArtifacts(thread.id);
  });

  it('keeps the durable branch unchanged before first model-switch regeneration output', () => {
    const thread = buildTrailingModelSwitchThread('thread-branch-before-output');
    seedPersistedChatThread(thread, 100);
    const rawThreads = useChatStore.getState().threads;
    const rawThread = rawThreads[thread.id];
    const rawMessages = rawThread.messages;
    const rawAssistant = rawMessages[1];
    const durableRecordBefore = storage.getString(getChatThreadStorageKey(thread.id));
    const capture = captureChatPersistenceWrites();

    try {
      const assistantId = useChatStore.getState().replaceBranchFromUserMessage(
        thread.id,
        `${thread.id}-user-1`,
        'Edited prompt',
      );

      expect(assistantId).toBeTruthy();
      expect(useChatStore.getState().threads).toBe(rawThreads);
      expect(useChatStore.getState().threads[thread.id]).toBe(rawThread);
      expect(useChatStore.getState().threads[thread.id].messages).toBe(rawMessages);
      expect(useChatStore.getState().threads[thread.id].messages[1]).toBe(rawAssistant);
      expect(useChatStore.getState().getThread(thread.id)).toEqual(expect.objectContaining({
        status: 'generating',
        summary: undefined,
        activeModelId: 'author/model-q8',
        messages: [
          expect.objectContaining({
            id: `${thread.id}-user-1`,
            content: 'Edited prompt',
            modelId: 'author/model-q8',
          }),
          expect.objectContaining({
            id: assistantId,
            content: '',
            state: 'streaming',
            modelId: 'author/model-q8',
          }),
        ],
      }));
      expect(storage.getString(getChatThreadStorageKey(thread.id))).toBe(durableRecordBefore);
      expect(readChatStreamingProgressRecord(storage, thread.id)).toEqual({
        ok: false,
        reason: 'missing',
      });
      expect(capture.setKeys).not.toContain(getChatThreadStorageKey(thread.id));
      expect(capture.setKeys).not.toContain(CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY);
      expect(capture.setKeys).not.toContain(CHAT_PERSISTENCE_INDEX_KEY);
    } finally {
      capture.restore();
    }
  });

  it('restores the old branch after a crash before first output', async () => {
    const thread = buildTrailingModelSwitchThread('thread-branch-crash-before-output');
    seedPersistedChatThread(thread, 100);
    const originalMessageIds = thread.messages.map((message) => message.id);

    expect(useChatStore.getState().replaceBranchFromUserMessage(
      thread.id,
      `${thread.id}-user-1`,
      'Edited prompt that must stay transient',
    )).toBeTruthy();

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    const recovered = useChatStore.getState().getThread(thread.id)!;
    expect(recovered.messages.map((message) => message.id)).toEqual(originalMessageIds);
    expect(recovered.messages[1]).toEqual(expect.objectContaining({
      id: `${thread.id}-assistant-old`,
      content: 'Original durable answer',
      state: 'complete',
    }));
    expect(recovered.messages.at(-1)).toEqual(expect.objectContaining({
      id: `${thread.id}-switch-q8`,
      kind: 'model_switch',
    }));
    expect(recovered.messages.some((message) => message.state === 'stopped')).toBe(false);
  });

  it('persists bounded branch progress after partial output', () => {
    jest.useFakeTimers();
    const thread = buildPerformanceThread({
      historicalMessageCount: 1000,
      attachments: 'mixed',
      modelSwitchEvery: 125,
    });
    seedPersistedChatThread(thread, thread.updatedAt);
    const target = thread.messages.find((message, index) => message.role === 'user' && index > 100)!;
    const durableRecordBefore = storage.getString(getChatThreadStorageKey(thread.id))!;

    try {
      const assistantId = useChatStore.getState().replaceBranchFromUserMessage(
        thread.id,
        target.id,
        'Bounded edited prompt',
      )!;
      useChatStore.getState().patchAssistantMessage(thread.id, assistantId, {
        content: 'Recoverable visible output',
        thoughtContent: 'Recoverable thought output',
      });
      flushPendingChatPersistenceWrites('background');

      const progress = readChatStreamingProgressRecord(storage, thread.id);
      expect(storage.getString(getChatThreadStorageKey(thread.id))).toBe(durableRecordBefore);
      expect(progress).toEqual({
        ok: true,
        value: expect.objectContaining({
          messageId: assistantId,
          content: 'Recoverable visible output',
          branchReplacement: expect.objectContaining({
            targetUserMessageId: target.id,
            replacementUserMessage: expect.objectContaining({
              id: target.id,
              content: 'Bounded edited prompt',
            }),
          }),
        }),
      });
      const progressArtifacts = snapshotStreamingProgressArtifacts(thread.id);
      const serializedProgress = Array.from(progressArtifacts.values()).join('');
      const progressBytes = Array.from(progressArtifacts).reduce(
        (total, [key, value]) => total + key.length + value.length,
        0,
      );
      expect(progressBytes).toBeLessThan(durableRecordBefore.length);
      expect(serializedProgress).toContain('Bounded edited prompt');
      expect(serializedProgress).toContain('Recoverable visible output');
      expect(serializedProgress).not.toContain('message-history-0');
      expect(serializedProgress).not.toContain('Deterministic assistant message 999');
      expect(serializedProgress).not.toContain('message-history-999');
    } finally {
      useChatStore.getState().stopAssistantMessage(
        thread.id,
        useChatStore.getState().getThread(thread.id)?.messages.at(-1)?.id ?? '',
      );
      jest.useRealTimers();
    }
  });

  it('keeps 100 branch patches over 1000 messages structurally O(1)', () => {
    jest.useFakeTimers();
    const thread = buildPerformanceThread({
      historicalMessageCount: 1000,
      attachments: 'mixed',
      modelSwitchEvery: 125,
    });
    seedPersistedChatThread(thread, thread.updatedAt);
    const targetIndex = thread.messages.findIndex(
      (message, index) => index > 400 && message.role === 'user',
    );
    const target = thread.messages[targetIndex];
    const rawThreads = useChatStore.getState().threads;
    const rawThread = rawThreads[thread.id];
    const rawMessages = rawThread.messages;
    const rawMessageReferences = rawMessages.slice();
    const durableRecordBefore = storage.getString(getChatThreadStorageKey(thread.id));
    const assistantId = useChatStore.getState().replaceBranchFromUserMessage(
      thread.id,
      target.id,
      'Performance branch edit',
    )!;
    const presentationMessages = useChatStore.getState().getThread(thread.id)!.messages;
    const capture = captureChatPersistenceWrites();
    const previousEnabled = performanceMonitor.isEnabled();
    performanceMonitor.setEnabled(true);
    performanceMonitor.clear();

    try {
      for (let patchIndex = 1; patchIndex <= 100; patchIndex += 1) {
        useChatStore.getState().patchAssistantMessage(thread.id, assistantId, {
          content: `Branch partial ${patchIndex}`,
          thoughtContent: `Branch thought ${patchIndex}`,
          tokensPerSec: patchIndex / 2,
        });

        expect(useChatStore.getState().getThread(thread.id)?.messages).toBe(
          presentationMessages,
        );
      }

      expect(useChatStore.getState().threads).toBe(rawThreads);
      expect(useChatStore.getState().threads[thread.id]).toBe(rawThread);
      expect(useChatStore.getState().threads[thread.id].messages).toBe(rawMessages);
      expect(rawMessages.every((message, index) => message === rawMessageReferences[index])).toBe(true);
      expect(presentationMessages.slice(0, targetIndex).every(
        (message, index) => message === rawMessageReferences[index],
      )).toBe(true);
      expect(storage.getString(getChatThreadStorageKey(thread.id))).toBe(durableRecordBefore);
      expect(capture.setKeys.filter(
        (key) => key === getChatThreadStorageKey(thread.id),
      )).toHaveLength(0);
      let snapshot = performanceMonitor.snapshot();
      expect(snapshot.counters['chat.stream.patch']).toBe(100);
      expect(snapshot.counters['chat.persist.sanitize'] ?? 0).toBe(0);
      expect(snapshot.counters['chat.persist.stringify'] ?? 0).toBe(0);
      expect(snapshot.events.some((event) => event.name.startsWith('chat.prompt.'))).toBe(false);

      flushPendingChatPersistenceWrites('background');

      snapshot = performanceMonitor.snapshot();
      expect(capture.setKeys.filter(
        (key) => key === getChatStreamingProgressStorageKey(thread.id),
      )).toHaveLength(1);
      expect(capture.setKeys.filter(
        (key) => key === getChatThreadStorageKey(thread.id),
      )).toHaveLength(0);
      expect(snapshot.counters['chat.persist.sanitize'] ?? 0).toBe(0);
      expect(snapshot.counters['chat.persist.stringify']).toBe(3);
      expect(storage.getString(getChatStreamingProgressStorageKey(thread.id))!.length).toBeLessThan(
        durableRecordBefore!.length,
      );
    } finally {
      capture.restore();
      performanceMonitor.clear();
      performanceMonitor.setEnabled(previousEnabled);
      useChatStore.getState().stopAssistantMessage(thread.id, assistantId);
      jest.useRealTimers();
    }
  });

  it('recovers partial model-switch regeneration by replacing the old tail', async () => {
    const base = buildTrailingModelSwitchThread('thread-branch-partial-recovery');
    const thread: ChatThread = {
      ...base,
      messages: [
        {
          id: `${base.id}-prefix-user`,
          role: 'user',
          content: 'Prefix prompt',
          createdAt: 1,
          state: 'complete',
          kind: 'message',
          modelId: 'author/model-q4',
        },
        {
          id: `${base.id}-prefix-assistant`,
          role: 'assistant',
          content: 'Prefix answer',
          createdAt: 2,
          state: 'complete',
          kind: 'message',
          modelId: 'author/model-q4',
        },
        ...base.messages,
      ],
    };
    seedPersistedChatThread(thread, 100);
    const assistantId = useChatStore.getState().replaceBranchFromUserMessage(
      thread.id,
      `${thread.id}-user-1`,
      'Recovered edited prompt',
    )!;
    useChatStore.getState().patchAssistantMessage(thread.id, assistantId, {
      content: 'Recovered partial branch',
      thoughtContent: 'Recovered branch thought',
    });
    flushPendingChatPersistenceWrites('background');

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    const recovered = useChatStore.getState().getThread(thread.id)!;
    expect(recovered.messages.map((message) => message.id)).not.toContain(`${thread.id}-assistant-old`);
    expect(recovered.messages.map((message) => message.id)).not.toContain(`${thread.id}-switch-q8`);
    expect(recovered.messages.at(-1)).toEqual(expect.objectContaining({
      id: assistantId,
      content: 'Recovered partial branch',
      thoughtContent: 'Recovered branch thought',
      state: 'stopped',
    }));
    const replacementUserIndex = recovered.messages.findIndex(
      (message) => message.id === `${thread.id}-user-1`,
    );
    expect(recovered.messages[replacementUserIndex - 1]).toEqual(expect.objectContaining({
      kind: 'model_switch',
      switchFromModelId: 'author/model-q4',
      switchToModelId: 'author/model-q8',
    }));
    expect(recovered.messages.filter((message) => message.role === 'assistant' && message.id === assistantId)).toHaveLength(1);
    expect(readChatStreamingProgressRecord(storage, thread.id)).toEqual({
      ok: false,
      reason: 'missing',
    });
  });

  it('recovers attachment-bearing branch progress without losing sanitized metadata or document content', async () => {
    const threadId = 'thread-branch-attachment-recovery';
    const targetMessageId = `${threadId}-user-1`;
    const retainedImageAttachment = buildStoredAttachment(
      threadId,
      targetMessageId,
      'target-image.jpg',
    );
    const retainedAttachments: NonNullable<ChatThread['messages'][number]['attachments']> = [
      retainedImageAttachment,
      {
        id: 'target-audio',
        kind: 'audio',
        state: 'ready',
        threadId,
        messageId: targetMessageId,
        localUri: 'test-dir/chat-attachments/target-audio.mp3',
        pathCategory: 'chat_attachment',
        fileName: 'target-audio.mp3',
        mimeType: 'audio/mpeg',
        sizeBytes: 4_096,
        source: 'document_picker',
        createdAt: 11,
        audio: { format: 'mp3', durationMs: 2_000 },
      },
      {
        id: 'target-document',
        kind: 'document',
        state: 'ready',
        threadId,
        messageId: targetMessageId,
        localUri: 'test-dir/chat-attachments/target-document.txt',
        pathCategory: 'chat_attachment',
        fileName: 'target-document.txt',
        mimeType: 'text/plain',
        sizeBytes: 512,
        source: 'document_picker',
        createdAt: 12,
        document: {
          processorId: 'document-text',
          processorVersion: 1,
          contentHash: 'target-document-hash',
          extractedCharCount: 42,
          isScanned: false,
        },
      },
    ];
    const retainedContentParts: NonNullable<ChatThread['messages'][number]['contentParts']> = [{
      type: 'text',
      text: 'Recovered document extract with exact content.',
    }];
    const removedTailAttachment = buildStoredAttachment(
      threadId,
      `${threadId}-user-tail`,
      'removed-tail.jpg',
    );
    const base = buildTrailingModelSwitchThread(threadId, {
      oldTailAttachment: removedTailAttachment,
    });
    const thread: ChatThread = {
      ...base,
      messages: base.messages.map((message) => (
        message.id === targetMessageId
          ? {
              ...message,
              attachments: retainedAttachments,
              contentParts: retainedContentParts,
            }
          : message
      )),
    };
    seedPersistedChatThread(thread, 100);
    const assistantId = useChatStore.getState().replaceBranchFromUserMessage(
      thread.id,
      targetMessageId,
      'Edited prompt with retained multimodal context',
    )!;
    useChatStore.getState().patchAssistantMessage(thread.id, assistantId, {
      content: 'Recovered attachment-aware partial branch',
    });
    flushPendingChatPersistenceWrites('background');

    const progress = readChatStreamingProgressRecord(storage, thread.id);
    expect(progress).toEqual({
      ok: true,
      value: expect.objectContaining({
        branchReplacement: expect.objectContaining({
          replacementUserMessage: expect.objectContaining({
            id: targetMessageId,
            attachments: retainedAttachments,
            contentParts: retainedContentParts,
          }),
        }),
      }),
    });
    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();
    await flushAttachmentCleanup(8);

    const recovered = useChatStore.getState().getThread(thread.id)!;
    const recoveredReplacementUser = recovered.messages.find(
      (message) => message.id === targetMessageId,
    );
    expect(recoveredReplacementUser).toEqual(expect.objectContaining({
      content: 'Edited prompt with retained multimodal context',
      attachments: retainedAttachments,
      contentParts: retainedContentParts,
    }));
    expect(recovered.messages.at(-1)).toEqual(expect.objectContaining({
      id: assistantId,
      content: 'Recovered attachment-aware partial branch',
      state: 'stopped',
    }));
    expect(readChatStreamingProgressRecord(storage, thread.id)).toEqual({
      ok: false,
      reason: 'missing',
    });
    expect((FileSystem.deleteAsync as jest.Mock).mock.calls.filter(
      ([localUri]) => localUri === removedTailAttachment.localUri,
    )).toHaveLength(1);
    retainedAttachments.forEach((attachment) => {
      expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith(
        attachment.localUri,
        expect.anything(),
      );
    });
  });

  it('retains branch progress and the old branch when recovery durable write fails', async () => {
    const thread = buildTrailingModelSwitchThread('thread-branch-recovery-write-failure');
    seedPersistedChatThread(thread, 100);
    const assistantId = useChatStore.getState().replaceBranchFromUserMessage(
      thread.id,
      `${thread.id}-user-1`,
      'Edited recovery failure prompt',
    )!;
    useChatStore.getState().patchAssistantMessage(thread.id, assistantId, {
      content: 'Recoverable branch progress',
    });
    flushPendingChatPersistenceWrites('background');
    const progressBefore = snapshotStreamingProgressArtifacts(thread.id);
    const appStorage = getAppStorage() as unknown as { set: jest.Mock };
    const originalSet = appStorage.set;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    let didFailRecoveryWrite = false;
    appStorage.set = jest.fn(function failRecoveryWrite(this: unknown, key: string, value: unknown) {
      if (!didFailRecoveryWrite && key === getChatThreadStorageKey(thread.id)) {
        didFailRecoveryWrite = true;
        throw new Error('simulated recovery durable write failure');
      }
      return originalSet.call(this, key, value);
    });

    try {
      useChatStore.setState({ threads: {}, activeThreadId: null });
      await useChatStore.persist.rehydrate();
      expect(warnSpy).toHaveBeenCalledWith(
        '[ChatPersistence] Failed to durably commit recovered streaming progress',
        { errorName: 'Error' },
      );
    } finally {
      appStorage.set = originalSet;
      warnSpy.mockRestore();
    }

    const hydrated = useChatStore.getState().getThread(thread.id)!;
    expect(hydrated.messages.map((message) => message.id)).toEqual(
      thread.messages.map((message) => message.id),
    );
    expect(hydrated.messages[1]).toEqual(expect.objectContaining({
      id: `${thread.id}-assistant-old`,
      content: 'Original durable answer',
    }));
    expect(snapshotStreamingProgressArtifacts(thread.id)).toEqual(progressBefore);
  });

  it('discards orphaned branch progress without resurrecting a thread', async () => {
    const thread = buildTrailingModelSwitchThread('thread-orphan-branch-progress');
    seedPersistedChatThread(thread, 100);
    const assistantId = useChatStore.getState().replaceBranchFromUserMessage(
      thread.id,
      `${thread.id}-user-1`,
      'Orphaned branch edit',
    )!;
    useChatStore.getState().patchAssistantMessage(thread.id, assistantId, {
      content: 'Orphaned partial branch',
    });
    flushPendingChatPersistenceWrites('background');
    expect(readChatStreamingProgressRecord(storage, thread.id).ok).toBe(true);
    storage.remove(getChatThreadStorageKey(thread.id));
    storage.remove(CHAT_PERSISTENCE_INDEX_KEY);

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().getThread(thread.id)).toBeNull();
    expect(readChatStreamingProgressRecord(storage, thread.id)).toEqual({
      ok: false,
      reason: 'missing',
    });
  });

  it('cleans data-only progress slots after first-head publication is interrupted', async () => {
    const thread = buildThread('thread-progress-orphan-before-first-head', 10);
    seedPersistedChatThread(thread, 100);
    const appStorage = getAppStorage() as unknown as { set: jest.Mock };
    const originalSet = appStorage.set;
    const headKey = getChatStreamingProgressStorageKey(thread.id);
    appStorage.set = jest.fn(function failFirstHeadPublish(
      this: unknown,
      key: string,
      value: unknown,
    ) {
      if (key === headKey) {
        throw new Error('simulated first progress head failure');
      }
      return originalSet.call(this, key, value);
    });

    try {
      expect(() => writeChatStreamingProgressRecord(storage, {
        schemaVersion: CHAT_STREAM_PROGRESS_SCHEMA_VERSION,
        threadId: thread.id,
        messageId: `${thread.id}-assistant-progress`,
        modelId: thread.modelId,
        createdAt: 11,
        content: 'Unpublished partial response',
        state: 'streaming',
        persistedAt: 120,
        revision: 1,
      })).toThrow('simulated first progress head failure');
    } finally {
      appStorage.set = originalSet;
    }

    const unpublishedArtifacts = snapshotStreamingProgressArtifacts(thread.id);
    expect(unpublishedArtifacts.size).toBe(2);
    expect(unpublishedArtifacts.has(headKey)).toBe(false);

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().getThread(thread.id)?.messages.map((message) => message.id))
      .toEqual(thread.messages.map((message) => message.id));
    expectNoStreamingProgressArtifacts(thread.id);
  });

  it('starts a 1000-message branch from hydrated durable identity without reading or parsing the thread record', async () => {
    const thread = buildPerformanceThread({
      historicalMessageCount: 1000,
      attachments: 'mixed',
      modelSwitchEvery: 125,
    });
    writeChatThreadRecord(storage, thread, thread.updatedAt);
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: thread.id,
      threadIds: [thread.id],
      updatedAt: thread.updatedAt,
    });
    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    const hydratedThread = useChatStore.getState().threads[thread.id];
    const target = hydratedThread.messages.find((message, index) => (
      index > 500 && message.role === 'user'
    ))!;
    const getStringSpy = jest.spyOn(getAppStorage(), 'getString');
    const previousEnabled = performanceMonitor.isEnabled();
    performanceMonitor.setEnabled(true);
    performanceMonitor.clear();

    try {
      const assistantId = useChatStore.getState().replaceBranchFromUserMessage(
        thread.id,
        target.id,
        'Hot cached branch identity',
      );

      expect(assistantId).toBeTruthy();
      expect(getStringSpy.mock.calls.filter(
        ([key]) => key === getChatThreadStorageKey(thread.id),
      )).toHaveLength(0);
      const snapshot = performanceMonitor.snapshot();
      expect(snapshot.counters['chat.branch.identity.cacheHit']).toBe(1);
      expect(snapshot.counters['chat.branch.identity.fallbackRead'] ?? 0).toBe(0);
      expect(snapshot.counters['chat.persist.parse'] ?? 0).toBe(0);

      useChatStore.getState().stopAssistantMessage(thread.id, assistantId!);
    } finally {
      getStringSpy.mockRestore();
      performanceMonitor.clear();
      performanceMonitor.setEnabled(previousEnabled);
    }
  });

  it('uses one validated cold fallback read and caches it for the next branch start', () => {
    const thread = buildTrailingModelSwitchThread('thread-branch-cold-identity');
    seedPersistedChatThread(thread, 100);
    const targetId = `${thread.id}-user-1`;
    const getStringSpy = jest.spyOn(getAppStorage(), 'getString');
    const previousEnabled = performanceMonitor.isEnabled();
    performanceMonitor.setEnabled(true);
    performanceMonitor.clear();

    try {
      const firstAssistantId = useChatStore.getState().replaceBranchFromUserMessage(
        thread.id,
        targetId,
        'Cold validated branch',
      );
      expect(firstAssistantId).toBeTruthy();
      expect(getStringSpy.mock.calls.filter(
        ([key]) => key === getChatThreadStorageKey(thread.id),
      )).toHaveLength(1);
      let snapshot = performanceMonitor.snapshot();
      expect(snapshot.counters['chat.branch.identity.fallbackRead']).toBe(1);
      expect(snapshot.counters['chat.branch.identity.fallbackRejected'] ?? 0).toBe(0);
      expect(snapshot.counters['chat.persist.parse']).toBe(1);

      useChatStore.getState().stopAssistantMessage(thread.id, firstAssistantId!);
      getStringSpy.mockClear();
      performanceMonitor.clear();

      const secondAssistantId = useChatStore.getState().replaceBranchFromUserMessage(
        thread.id,
        targetId,
        'Cached validated branch',
      );
      expect(secondAssistantId).toBeTruthy();
      expect(getStringSpy.mock.calls.filter(
        ([key]) => key === getChatThreadStorageKey(thread.id),
      )).toHaveLength(0);
      snapshot = performanceMonitor.snapshot();
      expect(snapshot.counters['chat.branch.identity.cacheHit']).toBe(1);
      expect(snapshot.counters['chat.branch.identity.fallbackRead'] ?? 0).toBe(0);

      useChatStore.getState().stopAssistantMessage(thread.id, secondAssistantId!);
    } finally {
      getStringSpy.mockRestore();
      performanceMonitor.clear();
      performanceMonitor.setEnabled(previousEnabled);
    }
  });

  it('rejects stale cold fallback records without caching their metadata', () => {
    const thread = buildTrailingModelSwitchThread('thread-branch-stale-identity');
    const stalePersistedThread: ChatThread = {
      ...thread,
      messages: thread.messages.map((message) => (
        message.id === `${thread.id}-user-1`
          ? { ...message, content: 'Persisted content no longer matches memory' }
          : message
      )),
    };
    writeChatThreadRecord(storage, stalePersistedThread, 100);
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: thread.id,
      threadIds: [thread.id],
      updatedAt: 100,
    });
    useChatStore.setState({
      threads: { [thread.id]: thread },
      activeThreadId: thread.id,
    });
    const getStringSpy = jest.spyOn(getAppStorage(), 'getString');
    const previousEnabled = performanceMonitor.isEnabled();
    performanceMonitor.setEnabled(true);
    performanceMonitor.clear();

    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect(useChatStore.getState().replaceBranchFromUserMessage(
          thread.id,
          `${thread.id}-user-1`,
          'Must not start from stale storage',
        )).toBeNull();
      }

      expect(getStringSpy.mock.calls.filter(
        ([key]) => key === getChatThreadStorageKey(thread.id),
      )).toHaveLength(2);
      const snapshot = performanceMonitor.snapshot();
      expect(snapshot.counters['chat.branch.identity.fallbackRead']).toBe(2);
      expect(snapshot.counters['chat.branch.identity.fallbackRejected']).toBe(2);
      expect(snapshot.counters['chat.branch.identity.cacheHit'] ?? 0).toBe(0);
    } finally {
      getStringSpy.mockRestore();
      performanceMonitor.clear();
      performanceMonitor.setEnabled(previousEnabled);
    }
  });

  it('invalidates hydrated durable identity when a thread is deleted', async () => {
    const thread = buildTrailingModelSwitchThread('thread-branch-delete-invalidates-identity');
    writeChatThreadRecord(storage, thread, 100);
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: thread.id,
      threadIds: [thread.id],
      updatedAt: 100,
    });
    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();
    const hydratedThread = useChatStore.getState().threads[thread.id];

    useChatStore.getState().deleteThread(thread.id);
    useChatStore.setState({
      threads: { [thread.id]: hydratedThread },
      activeThreadId: thread.id,
    });
    const previousEnabled = performanceMonitor.isEnabled();
    performanceMonitor.setEnabled(true);
    performanceMonitor.clear();

    try {
      expect(useChatStore.getState().replaceBranchFromUserMessage(
        thread.id,
        `${thread.id}-user-1`,
        'Deleted identities must not be reused',
      )).toBeNull();
      expect(performanceMonitor.snapshot().counters).toEqual(expect.objectContaining({
        'chat.branch.identity.fallbackRead': 1,
        'chat.branch.identity.fallbackRejected': 1,
      }));
      expect(performanceMonitor.snapshot().counters['chat.branch.identity.cacheHit'] ?? 0).toBe(0);
    } finally {
      performanceMonitor.clear();
      performanceMonitor.setEnabled(previousEnabled);
    }
  });

  it('invalidates hydrated durable identities after clearing all threads', async () => {
    const thread = buildTrailingModelSwitchThread('thread-branch-clear-invalidates-identity');
    writeChatThreadRecord(storage, thread, 100);
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: thread.id,
      threadIds: [thread.id],
      updatedAt: 100,
    });
    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();
    const hydratedThread = useChatStore.getState().threads[thread.id];

    expect(useChatStore.getState().clearAllThreads()).toBe(1);
    useChatStore.setState({
      threads: { [thread.id]: hydratedThread },
      activeThreadId: thread.id,
    });
    const previousEnabled = performanceMonitor.isEnabled();
    performanceMonitor.setEnabled(true);
    performanceMonitor.clear();

    try {
      expect(useChatStore.getState().replaceBranchFromUserMessage(
        thread.id,
        `${thread.id}-user-1`,
        'Cleared identities must not be reused',
      )).toBeNull();
      expect(performanceMonitor.snapshot().counters).toEqual(expect.objectContaining({
        'chat.branch.identity.fallbackRead': 1,
        'chat.branch.identity.fallbackRejected': 1,
      }));
      expect(performanceMonitor.snapshot().counters['chat.branch.identity.cacheHit'] ?? 0).toBe(0);
    } finally {
      performanceMonitor.clear();
      performanceMonitor.setEnabled(previousEnabled);
    }
  });

  it('fails closed after a partial two-thread clear and a partial rollback failure', async () => {
    const firstThread = buildTrailingModelSwitchThread('thread-partial-clear-first');
    const secondThread = buildTrailingModelSwitchThread('thread-partial-clear-second');
    writeChatThreadRecord(storage, firstThread, 100);
    writeChatThreadRecord(storage, secondThread, 101);
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: firstThread.id,
      threadIds: [firstThread.id, secondThread.id],
      updatedAt: 101,
    });
    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();
    const hydratedFirstThread = useChatStore.getState().threads[firstThread.id];
    const appStorage = getAppStorage() as unknown as {
      remove: jest.Mock;
      set: jest.Mock;
    };
    const originalRemove = appStorage.remove;
    const originalSet = appStorage.set;
    const firstThreadKey = getChatThreadStorageKey(firstThread.id);
    const secondThreadKey = getChatThreadStorageKey(secondThread.id);
    const clearError = new Error('simulated partial clear failure');
    const rollbackError = new Error('simulated first-thread rollback failure');
    let didRemoveFirstThread = false;
    let didFailClear = false;
    let didFailRollback = false;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    appStorage.remove = jest.fn(function removeWithPartialClearFailure(this: unknown, key: string) {
      if (!didRemoveFirstThread && key === firstThreadKey) {
        didRemoveFirstThread = true;
        return originalRemove.call(this, key);
      }
      if (didRemoveFirstThread && !didFailClear && key === secondThreadKey) {
        didFailClear = true;
        throw clearError;
      }
      return originalRemove.call(this, key);
    });
    appStorage.set = jest.fn(function setWithPartialRollbackFailure(
      this: unknown,
      key: string,
      value: unknown,
    ) {
      if (didFailClear && !didFailRollback && key === firstThreadKey) {
        didFailRollback = true;
        throw rollbackError;
      }
      return originalSet.call(this, key, value);
    });

    try {
      expect(() => useChatStore.getState().clearAllThreads()).toThrow(clearError);
    } finally {
      appStorage.remove = originalRemove;
      appStorage.set = originalSet;
      warnSpy.mockRestore();
    }

    expect(didRemoveFirstThread).toBe(true);
    expect(didFailClear).toBe(true);
    expect(didFailRollback).toBe(true);
    expect(useChatStore.getState().threads[firstThread.id]).toBe(hydratedFirstThread);
    expect(storage.getString(firstThreadKey)).toBeUndefined();

    const previousEnabled = performanceMonitor.isEnabled();
    performanceMonitor.setEnabled(true);
    performanceMonitor.clear();
    try {
      expect(useChatStore.getState().replaceBranchFromUserMessage(
        firstThread.id,
        `${firstThread.id}-user-1`,
        'Must not trust a phantom durable identity',
      )).toBeNull();
      expect(performanceMonitor.snapshot().counters).toEqual(expect.objectContaining({
        'chat.branch.identity.fallbackRead': 1,
        'chat.branch.identity.fallbackRejected': 1,
      }));
      expect(performanceMonitor.snapshot().counters['chat.branch.identity.cacheHit'] ?? 0).toBe(0);
    } finally {
      performanceMonitor.clear();
      performanceMonitor.setEnabled(previousEnabled);
    }
  });

  it('retries data-only progress cleanup after a post-head removal failure', async () => {
    const thread = buildThread('thread-progress-orphan-after-head-removal', 10);
    seedPersistedChatThread(thread, 100);
    expect(writeChatStreamingProgressRecord(storage, {
      schemaVersion: CHAT_STREAM_PROGRESS_SCHEMA_VERSION,
      threadId: thread.id,
      messageId: `${thread.id}-assistant-progress`,
      modelId: thread.modelId,
      createdAt: 11,
      content: 'Published partial response',
      state: 'streaming',
      persistedAt: 120,
      revision: 1,
    })).toEqual({ status: 'written', kind: 'checkpoint' });
    const headKey = getChatStreamingProgressStorageKey(thread.id);
    const failedDataKey = Array.from(snapshotStreamingProgressArtifacts(thread.id).keys())
      .find((key) => key !== headKey)!;
    const appStorage = getAppStorage() as unknown as { remove: typeof storage.remove };
    const originalRemove = appStorage.remove;
    let didFailDataRemoval = false;
    appStorage.remove = jest.fn(function failOneDataRemoval(this: unknown, key: string) {
      if (!didFailDataRemoval && key === failedDataKey) {
        didFailDataRemoval = true;
        throw new Error('simulated progress data cleanup failure');
      }
      return originalRemove.call(this, key);
    });

    try {
      expect(() => removeChatStreamingProgressRecord(storage, thread.id))
        .toThrow('simulated progress data cleanup failure');
    } finally {
      appStorage.remove = originalRemove;
    }

    expect(didFailDataRemoval).toBe(true);
    expect(storage.getString(headKey)).toBeUndefined();
    expect(storage.getString(failedDataKey)).toBeDefined();

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().getThread(thread.id)?.messages.map((message) => message.id))
      .toEqual(thread.messages.map((message) => message.id));
    expectNoStreamingProgressArtifacts(thread.id);
  });

  it('keeps a clear tombstone authoritative over stale branch progress', async () => {
    const thread = buildTrailingModelSwitchThread('thread-cleared-branch-progress');
    seedPersistedChatThread(thread, 100);
    const assistantId = useChatStore.getState().replaceBranchFromUserMessage(
      thread.id,
      `${thread.id}-user-1`,
      'Cleared branch edit',
    )!;
    useChatStore.getState().patchAssistantMessage(thread.id, assistantId, {
      content: 'Progress before authoritative clear',
    });
    flushPendingChatPersistenceWrites('background');
    const staleProgress = snapshotStreamingProgressArtifacts(thread.id);

    expect(useChatStore.getState().clearAllThreads()).toBe(1);
    restoreStreamingProgressArtifacts(staleProgress);
    expect(readChatStreamingProgressRecord(storage, thread.id).ok).toBe(true);
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().threads).toEqual({});
    expect(readChatStreamingProgressRecord(storage, thread.id)).toEqual({
      ok: false,
      reason: 'missing',
    });
    expect(readPersistedChatIndex()).toEqual(expect.objectContaining({
      activeThreadId: null,
      threadIds: [],
      clearedAt: expect.any(Number),
    }));
  });

  it('atomically commits successful branch regeneration', () => {
    const thread = buildTrailingModelSwitchThread('thread-branch-atomic-success');
    seedPersistedChatThread(thread, 100);
    const assistantId = useChatStore.getState().replaceBranchFromUserMessage(
      thread.id,
      `${thread.id}-user-1`,
      'Atomically edited prompt',
    )!;
    useChatStore.getState().patchAssistantMessage(thread.id, assistantId, {
      content: 'Earlier partial',
    });
    flushPendingChatPersistenceWrites('background');
    const capture = captureChatPersistenceWrites();
    const mutationCounter = createMutationCounter(useChatStore.subscribe);
    const telemetry = {
      tokensPredicted: 24,
      tokensEvaluated: 8,
      predictedPerSecond: 6,
      timeToFirstTokenMs: 120,
      mtp: {
        requested: true,
        attempted: true,
        fallbackUsed: false,
        draftTokens: 12,
        draftTokensAccepted: 6,
        acceptanceRate: 0.5,
      },
    };

    try {
      expect(useChatStore.getState().finalizeAssistantTurn(thread.id, assistantId, {
        outcome: 'success',
        content: 'Final regenerated answer',
        inferenceMetrics: telemetry,
      })).toEqual({ status: 'committed' });

      expect(mutationCounter.getCount()).toBe(1);
      expect(capture.setKeys.filter((key) => key === getChatThreadStorageKey(thread.id))).toHaveLength(1);
      expect(capture.setKeys.filter((key) => key === CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY)).toHaveLength(1);
      expect(capture.setKeys.filter((key) => key === CHAT_PERSISTENCE_INDEX_KEY)).toHaveLength(1);
      expect(capture.removedKeys.filter((key) => key === getChatStreamingProgressStorageKey(thread.id))).toHaveLength(1);
      const committed = useChatStore.getState().threads[thread.id];
      expect(committed).toEqual(expect.objectContaining({
        title: 'Atomically edited prompt',
        titleSource: 'derived',
      }));
      expect(committed.messages).toHaveLength(2);
      expect(committed.messages.map((message) => message.id)).not.toContain(`${thread.id}-assistant-old`);
      expect(committed.messages.at(-1)).toEqual(expect.objectContaining({
        id: assistantId,
        content: 'Final regenerated answer',
        state: 'complete',
        inferenceMetrics: telemetry,
      }));
      expect(readChatStreamingProgressRecord(storage, thread.id)).toEqual({
        ok: false,
        reason: 'missing',
      });
    } finally {
      mutationCounter.unsubscribe();
      capture.restore();
    }
  });

  it('preserves a normalized manual title across branch replacement', () => {
    const base = buildTrailingModelSwitchThread('thread-branch-manual-title');
    const thread: ChatThread = {
      ...base,
      title: '  Project   Atlas  ',
      titleSource: 'manual',
    };
    seedPersistedChatThread(thread, 100);
    const assistantId = useChatStore.getState().replaceBranchFromUserMessage(
      thread.id,
      `${thread.id}-user-1`,
      'Edited prompt must not replace the manual title',
    )!;

    expect(useChatStore.getState().finalizeAssistantTurn(thread.id, assistantId, {
      outcome: 'success',
      content: 'Completed branch with manual title',
    })).toEqual({ status: 'committed' });
    expect(useChatStore.getState().threads[thread.id]).toEqual(expect.objectContaining({
      title: 'Project Atlas',
      titleSource: 'manual',
    }));
  });

  it('restores the old branch on stopped branch regeneration before output', () => {
    const thread = buildTrailingModelSwitchThread('thread-branch-empty-stop');
    seedPersistedChatThread(thread, 100);
    const oldMessageIds = thread.messages.map((message) => message.id);
    const durableRecord = storage.getString(getChatThreadStorageKey(thread.id));
    const assistantId = useChatStore.getState().replaceBranchFromUserMessage(
      thread.id,
      `${thread.id}-user-1`,
      'Transient edit',
    )!;
    const capture = captureChatPersistenceWrites();

    try {
      expect(useChatStore.getState().finalizeAssistantTurn(thread.id, assistantId, {
        outcome: 'stopped',
      })).toEqual({ status: 'restored_without_write' });
      expect(useChatStore.getState().threads[thread.id]).toBe(thread);
      expect(useChatStore.getState().getThread(thread.id)?.messages.map((message) => message.id)).toEqual(oldMessageIds);
      expect(useChatStore.getState().getThread(thread.id)?.status).toBe('idle');
      expect(storage.getString(getChatThreadStorageKey(thread.id))).toBe(durableRecord);
      expect(capture.setKeys).not.toContain(getChatThreadStorageKey(thread.id));
      expect(capture.setKeys).not.toContain(CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY);
      expect(capture.setKeys).not.toContain(CHAT_PERSISTENCE_INDEX_KEY);
      expect(useChatStore.getState().finalizeAssistantTurn(thread.id, assistantId, {
        outcome: 'success',
        content: 'Late output',
      })).toEqual({ status: 'stale' });
    } finally {
      capture.restore();
    }
  });

  it('restores the old branch on branch generation error before output', () => {
    const thread = buildTrailingModelSwitchThread('thread-branch-empty-error');
    seedPersistedChatThread(thread, 100);
    const oldMessages = thread.messages;
    const durableRecord = storage.getString(getChatThreadStorageKey(thread.id));
    const assistantId = useChatStore.getState().replaceBranchFromUserMessage(
      thread.id,
      `${thread.id}-user-1`,
      'Transient error edit',
    )!;
    const capture = captureChatPersistenceWrites();

    try {
      expect(useChatStore.getState().finalizeAssistantTurn(thread.id, assistantId, {
        outcome: 'error',
        errorCode: 'generation_failed',
        errorMessage: 'No output',
      })).toEqual({ status: 'restored_without_write' });
      expect(useChatStore.getState().threads[thread.id]).toBe(thread);
      expect(useChatStore.getState().getThread(thread.id)?.messages).toBe(oldMessages);
      expect(useChatStore.getState().getThread(thread.id)?.messages.some(
        (message) => message.id === assistantId,
      )).toBe(false);
      expect(storage.getString(getChatThreadStorageKey(thread.id))).toBe(durableRecord);
      expect(capture.setKeys).not.toContain(getChatThreadStorageKey(thread.id));
      expect(capture.setKeys).not.toContain(CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY);
      expect(capture.setKeys).not.toContain(CHAT_PERSISTENCE_INDEX_KEY);
    } finally {
      capture.restore();
    }
  });

  it('preserves and rehydrates the old branch after an empty successful regeneration', async () => {
    const thread = buildTrailingModelSwitchThread('thread-branch-empty-success');
    seedPersistedChatThread(thread, 100);
    const oldMessages = thread.messages;
    const assistantId = useChatStore.getState().replaceBranchFromUserMessage(
      thread.id,
      `${thread.id}-user-1`,
      'Authoritative empty-success edit',
    )!;
    const capture = captureChatPersistenceWrites();

    try {
      expect(useChatStore.getState().finalizeAssistantTurn(thread.id, assistantId, {
        outcome: 'success',
        content: '',
        thoughtContent: null,
      })).toEqual({ status: 'restored_without_write' });
      expect(useChatStore.getState().getThread(thread.id)?.messages).toEqual(oldMessages);
      expect(useChatStore.getState().getThread(thread.id)?.messages.some(
        (message) => message.id === assistantId,
      )).toBe(false);
      expect(capture.setKeys).not.toContain(getChatThreadStorageKey(thread.id));
      expect(capture.setKeys).not.toContain(CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY);
      expect(capture.setKeys).not.toContain(CHAT_PERSISTENCE_INDEX_KEY);
    } finally {
      capture.restore();
    }

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().getThread(thread.id)?.messages).toEqual(oldMessages);
  });

  it('recommits the old branch when persisted partial output is later cleared', () => {
    const thread = buildTrailingModelSwitchThread('thread-branch-cleared-persisted-output');
    seedPersistedChatThread(thread, 100);
    const assistantId = useChatStore.getState().replaceBranchFromUserMessage(
      thread.id,
      `${thread.id}-user-1`,
      'Transient edit with later-cleared output',
    )!;
    useChatStore.getState().patchAssistantMessage(thread.id, assistantId, {
      content: 'Persisted partial output',
      thoughtContent: 'Persisted partial thought',
    });
    flushPendingChatPersistenceWrites('background');
    const persistedProgress = readChatStreamingProgressRecord(storage, thread.id);
    expect(persistedProgress).toEqual({
      ok: true,
      value: expect.objectContaining({
        content: 'Persisted partial output',
        thoughtContent: 'Persisted partial thought',
      }),
    });
    expect(persistedProgress.ok).toBe(true);

    useChatStore.getState().patchAssistantMessage(thread.id, assistantId, {
      content: '',
      thoughtContent: undefined,
    });
    expect(useChatStore.getState().finalizeAssistantTurn(thread.id, assistantId, {
      outcome: 'stopped',
      content: '',
      thoughtContent: null,
    })).toEqual({ status: 'committed' });

    expect(useChatStore.getState().getThread(thread.id)?.messages).toEqual(thread.messages);
    expect(readChatStreamingProgressRecord(storage, thread.id)).toEqual({
      ok: false,
      reason: 'missing',
    });
    const durableRecord = readChatThreadRecord(storage, thread.id);
    expect(durableRecord).toEqual({
      ok: true,
      value: expect.objectContaining({
        thread: expect.objectContaining({ messages: thread.messages }),
      }),
    });
    if (durableRecord.ok && persistedProgress.ok) {
      expect(durableRecord.value.persistedAt).toBeGreaterThan(persistedProgress.value.persistedAt);
    }
  });

  it('commits partial stopped branch regeneration', () => {
    const thread = buildTrailingModelSwitchThread('thread-branch-partial-stop');
    seedPersistedChatThread(thread, 100);
    const assistantId = useChatStore.getState().replaceBranchFromUserMessage(
      thread.id,
      `${thread.id}-user-1`,
      'Edited stopped prompt',
    )!;
    useChatStore.getState().patchAssistantMessage(thread.id, assistantId, {
      content: 'Partial stopped answer',
      thoughtContent: 'Partial stopped thought',
    });

    expect(useChatStore.getState().finalizeAssistantTurn(thread.id, assistantId, {
      outcome: 'stopped',
    })).toEqual({ status: 'committed' });
    expect(useChatStore.getState().getThread(thread.id)?.messages).toEqual([
      expect.objectContaining({ content: 'Edited stopped prompt' }),
      expect.objectContaining({
        id: assistantId,
        content: 'Partial stopped answer',
        thoughtContent: 'Partial stopped thought',
        state: 'stopped',
      }),
    ]);
  });

  it('commits partial error branch regeneration', () => {
    const thread = buildTrailingModelSwitchThread('thread-branch-partial-error');
    seedPersistedChatThread(thread, 100);
    const assistantId = useChatStore.getState().replaceBranchFromUserMessage(
      thread.id,
      `${thread.id}-user-1`,
      'Edited error prompt',
    )!;
    useChatStore.getState().patchAssistantMessage(thread.id, assistantId, {
      content: 'Partial errored answer',
    });

    expect(useChatStore.getState().finalizeAssistantTurn(thread.id, assistantId, {
      outcome: 'error',
      errorCode: 'generation_failed',
      errorMessage: 'Completion failed after output',
    })).toEqual({ status: 'committed' });
    expect(useChatStore.getState().getThread(thread.id)?.messages.at(-1)).toEqual(expect.objectContaining({
      id: assistantId,
      content: 'Partial errored answer',
      state: 'error',
      errorCode: 'generation_failed',
    }));
  });

  it('keeps old branch and progress when terminal persistence fails', async () => {
    const removedAttachment = buildStoredAttachment(
      'thread-branch-terminal-failure',
      'thread-branch-terminal-failure-user-tail',
      'terminal-failure-old-tail.jpg',
    );
    const thread = buildTrailingModelSwitchThread('thread-branch-terminal-failure', {
      oldTailAttachment: removedAttachment,
    });
    seedPersistedChatThread(thread, 100);
    const assistantId = useChatStore.getState().replaceBranchFromUserMessage(
      thread.id,
      `${thread.id}-user-1`,
      'Edited prompt before failed commit',
    )!;
    useChatStore.getState().patchAssistantMessage(thread.id, assistantId, {
      content: 'Recoverable partial after failure',
    });
    flushPendingChatPersistenceWrites('background');
    const appStorage = getAppStorage() as unknown as { set: jest.Mock };
    const originalSet = appStorage.set;
    let didFail = false;
    appStorage.set = jest.fn(function failTerminalThreadWrite(this: unknown, key: string, value: unknown) {
      if (!didFail && key === getChatThreadStorageKey(thread.id)) {
        didFail = true;
        throw new Error('simulated branch terminal write failure');
      }
      return originalSet.call(this, key, value);
    });

    try {
      expect(useChatStore.getState().finalizeAssistantTurn(thread.id, assistantId, {
        outcome: 'success',
        content: 'Terminal output that cannot commit',
      })).toEqual(expect.objectContaining({
        status: 'persistence_failed',
        error: expect.objectContaining({ message: 'simulated branch terminal write failure' }),
      }));
    } finally {
      appStorage.set = originalSet;
    }

    expect(useChatStore.getState().threads[thread.id]).toBe(thread);
    expect(useChatStore.getState().getThread(thread.id)?.messages.at(-1)).toEqual(expect.objectContaining({
      id: assistantId,
      content: 'Recoverable partial after failure',
      state: 'streaming',
    }));
    expect(readChatThreadRecord(storage, thread.id)).toEqual({
      ok: true,
      value: expect.objectContaining({
        persistedAt: 100,
        thread: expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({ id: `${thread.id}-assistant-old` }),
          ]),
        }),
      }),
    });
    expect(readChatStreamingProgressRecord(storage, thread.id)).toEqual({
      ok: true,
      value: expect.objectContaining({
        messageId: assistantId,
        content: 'Recoverable partial after failure',
        branchReplacement: expect.any(Object),
      }),
    });
    await flushAttachmentCleanup();
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith(
      removedAttachment.localUri,
      expect.anything(),
    );

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    const recovered = useChatStore.getState().getThread(thread.id)!;
    expect(recovered.messages.map((message) => message.id)).not.toContain(
      `${thread.id}-assistant-old`,
    );
    expect(recovered.messages.at(-1)).toEqual(expect.objectContaining({
      id: assistantId,
      content: 'Recoverable partial after failure',
      state: 'stopped',
    }));
    expect(readChatStreamingProgressRecord(storage, thread.id)).toEqual({
      ok: false,
      reason: 'missing',
    });
    await flushAttachmentCleanup(4);
    expect((FileSystem.deleteAsync as jest.Mock).mock.calls.filter(
      ([localUri]) => localUri === removedAttachment.localUri,
    )).toHaveLength(1);
  });

  it('rejects branch progress for a stale target user', async () => {
    const thread = buildTrailingModelSwitchThread('thread-branch-stale-target');
    seedPersistedChatThread(thread, 100);
    const assistantId = useChatStore.getState().replaceBranchFromUserMessage(
      thread.id,
      `${thread.id}-user-1`,
      'Edited stale target',
    )!;
    useChatStore.getState().patchAssistantMessage(thread.id, assistantId, {
      content: 'Partial stale-target output',
    });
    flushPendingChatPersistenceWrites('background');
    const mutatedThread: ChatThread = {
      ...thread,
      messages: thread.messages.map((message) => (
        message.id === `${thread.id}-user-1`
          ? { ...message, createdAt: message.createdAt + 1 }
          : message
      )),
    };
    writeChatThreadRecord(storage, mutatedThread, 100);

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().getThread(thread.id)?.messages).toEqual(mutatedThread.messages);
    expect(readChatStreamingProgressRecord(storage, thread.id)).toEqual({
      ok: false,
      reason: 'missing',
    });
  });

  it('rejects branch progress after a newer durable thread mutation', async () => {
    const thread = buildTrailingModelSwitchThread('thread-branch-newer-durable');
    seedPersistedChatThread(thread, 100);
    const assistantId = useChatStore.getState().replaceBranchFromUserMessage(
      thread.id,
      `${thread.id}-user-1`,
      'Edited against old base',
    )!;
    useChatStore.getState().patchAssistantMessage(thread.id, assistantId, {
      content: 'Progress against old durable base',
    });
    flushPendingChatPersistenceWrites('background');
    const newerThread: ChatThread = {
      ...thread,
      title: 'Newer durable title',
      titleSource: 'manual',
      updatedAt: 200,
    };
    writeChatThreadRecord(storage, newerThread, 200, { commitRevision: 9 });

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().getThread(thread.id)).toEqual(expect.objectContaining({
      title: 'Newer durable title',
      messages: thread.messages,
    }));
    expect(readChatStreamingProgressRecord(storage, thread.id)).toEqual({
      ok: false,
      reason: 'missing',
    });
  });

  it('ignores late branch assistant callbacks', () => {
    const thread = buildTrailingModelSwitchThread('thread-branch-late-callback');
    seedPersistedChatThread(thread, 100);
    const oldIds = thread.messages.map((message) => message.id);
    const assistantId = useChatStore.getState().replaceBranchFromUserMessage(
      thread.id,
      `${thread.id}-user-1`,
      'Transient late callback edit',
    )!;
    useChatStore.getState().stopAssistantMessage(thread.id, assistantId);

    useChatStore.getState().patchAssistantMessage(thread.id, assistantId, {
      content: 'Late patch must not land',
    });
    expect(useChatStore.getState().finalizeAssistantTurn(thread.id, assistantId, {
      outcome: 'success',
      content: 'Late terminal must not land',
    })).toEqual({ status: 'stale' });
    expect(useChatStore.getState().getThread(thread.id)?.messages.map((message) => message.id)).toEqual(oldIds);
  });

  it('clears branch runtime and progress when the thread is deleted', async () => {
    const removedAttachment = buildStoredAttachment(
      'thread-branch-delete-runtime',
      'thread-branch-delete-runtime-user-tail',
      'delete-runtime-tail.jpg',
    );
    const thread = buildTrailingModelSwitchThread('thread-branch-delete-runtime', {
      oldTailAttachment: removedAttachment,
    });
    seedPersistedChatThread(thread, 100);
    const assistantId = useChatStore.getState().replaceBranchFromUserMessage(
      thread.id,
      `${thread.id}-user-1`,
      'Edited before delete',
    )!;
    useChatStore.getState().patchAssistantMessage(thread.id, assistantId, {
      content: 'Partial before delete',
    });
    flushPendingChatPersistenceWrites('background');
    await flushAttachmentCleanup();
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith(
      removedAttachment.localUri,
      expect.anything(),
    );

    useChatStore.getState().deleteThread(thread.id);
    await flushAttachmentCleanup(4);

    expect(useChatStore.getState().getThread(thread.id)).toBeNull();
    expect(readChatStreamingProgressRecord(storage, thread.id)).toEqual({
      ok: false,
      reason: 'missing',
    });
    expect(useChatStore.getState().finalizeAssistantTurn(thread.id, assistantId, {
      outcome: 'success',
      content: 'Late output',
    })).toEqual({ status: 'stale' });
    expect((FileSystem.deleteAsync as jest.Mock).mock.calls.filter(
      ([localUri]) => localUri === removedAttachment.localUri,
    )).toHaveLength(1);
  });

  it('clears branch runtime and progress on clearAllThreads', async () => {
    const removedAttachment = buildStoredAttachment(
      'thread-branch-clear-runtime',
      'thread-branch-clear-runtime-user-tail',
      'clear-runtime-tail.jpg',
    );
    const thread = buildTrailingModelSwitchThread('thread-branch-clear-runtime', {
      oldTailAttachment: removedAttachment,
    });
    seedPersistedChatThread(thread, 100);
    const assistantId = useChatStore.getState().replaceBranchFromUserMessage(
      thread.id,
      `${thread.id}-user-1`,
      'Edited before clear',
    )!;
    useChatStore.getState().patchAssistantMessage(thread.id, assistantId, {
      thoughtContent: 'Thought before clear',
    });
    flushPendingChatPersistenceWrites('background');
    await flushAttachmentCleanup();
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith(
      removedAttachment.localUri,
      expect.anything(),
    );

    expect(useChatStore.getState().clearAllThreads()).toBe(1);
    await flushAttachmentCleanup(4);
    expect(useChatStore.getState().threads).toEqual({});
    expect(readChatStreamingProgressRecord(storage, thread.id)).toEqual({
      ok: false,
      reason: 'missing',
    });
    expect(useChatStore.getState().finalizeAssistantTurn(thread.id, assistantId, {
      outcome: 'stopped',
    })).toEqual({ status: 'stale' });
    expect((FileSystem.deleteAsync as jest.Mock).mock.calls.filter(
      ([localUri]) => localUri === removedAttachment.localUri,
    )).toHaveLength(1);
  });

  it('preserves attachment references until successful branch commit', async () => {
    const removedAttachment = buildStoredAttachment(
      'thread-branch-attachment-preserve',
      'thread-branch-attachment-preserve-user-tail',
      'old-tail.jpg',
    );
    const thread = buildTrailingModelSwitchThread('thread-branch-attachment-preserve', {
      oldTailAttachment: removedAttachment,
    });
    seedPersistedChatThread(thread, 100);
    const assistantId = useChatStore.getState().replaceBranchFromUserMessage(
      thread.id,
      `${thread.id}-user-1`,
      'Edited while preserving old files',
    )!;
    useChatStore.getState().patchAssistantMessage(thread.id, assistantId, {
      content: 'Partial output while old branch is durable',
    });
    flushPendingChatPersistenceWrites('background');
    await flushAttachmentCleanup();

    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith(
      removedAttachment.localUri,
      expect.anything(),
    );
    expect(readChatThreadRecord(storage, thread.id)).toEqual({
      ok: true,
      value: expect.objectContaining({
        thread: expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              id: `${thread.id}-user-tail`,
              attachments: [expect.objectContaining({ localUri: removedAttachment.localUri })],
            }),
          ]),
        }),
      }),
    });
  });

  it('runs attachment cleanup once after successful branch replacement', async () => {
    const retainedAttachment = buildStoredAttachment(
      'thread-branch-attachment-cleanup',
      'thread-branch-attachment-cleanup-user-1',
      'shared-retained.jpg',
    );
    const removedAttachment = buildStoredAttachment(
      'thread-branch-attachment-cleanup',
      'thread-branch-attachment-cleanup-user-tail',
      'removed-once.jpg',
    );
    const sharedTailAttachment = {
      ...buildStoredAttachment(
        'thread-branch-attachment-cleanup',
        'thread-branch-attachment-cleanup-user-tail',
        'shared-tail-reference.jpg',
      ),
      localUri: retainedAttachment.localUri,
    };
    const base = buildTrailingModelSwitchThread('thread-branch-attachment-cleanup', {
      oldTailAttachment: removedAttachment,
    });
    const thread: ChatThread = {
      ...base,
      messages: base.messages.map((message) => (
        message.id === `${base.id}-user-1`
          ? { ...message, attachments: [retainedAttachment] }
          : message.id === `${base.id}-user-tail`
            ? { ...message, attachments: [sharedTailAttachment, removedAttachment] }
          : message
      )),
    };
    seedPersistedChatThread(thread, 100);
    const assistantId = useChatStore.getState().replaceBranchFromUserMessage(
      thread.id,
      `${thread.id}-user-1`,
      'Edited attachment prompt',
    )!;

    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
    useChatStore.getState().finalizeAssistantTurn(thread.id, assistantId, {
      outcome: 'success',
      content: 'Successful replacement',
    });
    await flushAttachmentCleanup(4);

    expect((FileSystem.deleteAsync as jest.Mock).mock.calls.filter(
      ([localUri]) => localUri === removedAttachment.localUri,
    )).toHaveLength(1);
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith(
      retainedAttachment.localUri,
      expect.anything(),
    );
  });

  it('handles clock rollback and future-dated target messages', () => {
    jest.useFakeTimers().setSystemTime(100);
    const thread = buildTrailingModelSwitchThread('thread-branch-future-target', {
      targetCreatedAt: 50_000,
    });
    seedPersistedChatThread(thread, 60_000);

    try {
      const assistantId = useChatStore.getState().replaceBranchFromUserMessage(
        thread.id,
        `${thread.id}-user-1`,
        'Future target edit',
      )!;
      const presentedAssistant = useChatStore.getState().getThread(thread.id)?.messages.at(-1);
      expect(presentedAssistant?.createdAt).toBeGreaterThanOrEqual(50_000);
      useChatStore.getState().patchAssistantMessage(thread.id, assistantId, {
        content: 'Future-safe partial',
      });
      flushPendingChatPersistenceWrites('background');
      const progress = readChatStreamingProgressRecord(storage, thread.id);
      expect(progress).toEqual({
        ok: true,
        value: expect.objectContaining({
          persistedAt: expect.any(Number),
          branchReplacement: expect.objectContaining({
            baseDurablePersistedAt: 60_000,
            targetUserCreatedAt: 50_000,
          }),
        }),
      });
      if (progress.ok) {
        expect(progress.value.persistedAt).toBeGreaterThan(60_000);
      }
      useChatStore.getState().finalizeAssistantTurn(thread.id, assistantId, {
        outcome: 'success',
        content: 'Future-safe final',
      });
      expect(readChatThreadRecord(storage, thread.id)).toEqual({
        ok: true,
        value: expect.objectContaining({
          persistedAt: expect.any(Number),
        }),
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not use a stale conversation summary in presented branch', () => {
    const thread = buildTrailingModelSwitchThread('thread-branch-stale-summary');
    seedPersistedChatThread(thread, 100);

    expect(useChatStore.getState().replaceBranchFromUserMessage(
      thread.id,
      `${thread.id}-user-1`,
      'Edited prompt without stale summary',
    )).toBeTruthy();

    expect(useChatStore.getState().threads[thread.id].summary?.content).toBe(
      'Stale summary from the old branch',
    );
    expect(useChatStore.getState().getThread(thread.id)?.summary).toBeUndefined();
    expect(getThreadInferenceWindow(useChatStore.getState().getThread(thread.id)!, {
      maxContextMessages: 100,
      maxContextTokens: 4096,
      responseReserveTokens: 256,
    }).messages.map((message) => message.content)).not.toContain(
      'Stale summary from the old branch',
    );
  });

  it('preserves current active model and canonical model-switch ordering', () => {
    const base = buildTrailingModelSwitchThread('thread-branch-switch-order');
    const thread: ChatThread = {
      ...base,
      messages: [
        {
          id: `${base.id}-prefix-user`,
          role: 'user',
          content: 'Prefix',
          createdAt: 1,
          state: 'complete',
          kind: 'message',
          modelId: 'author/model-q4',
        },
        {
          id: `${base.id}-prefix-assistant`,
          role: 'assistant',
          content: 'Prefix answer',
          createdAt: 2,
          state: 'complete',
          kind: 'message',
          modelId: 'author/model-q4',
        },
        ...base.messages,
      ],
    };
    seedPersistedChatThread(thread, 100);
    const assistantId = useChatStore.getState().replaceBranchFromUserMessage(
      thread.id,
      `${thread.id}-user-1`,
      'Canonical switch edit',
    )!;
    useChatStore.getState().finalizeAssistantTurn(thread.id, assistantId, {
      outcome: 'success',
      content: 'Canonical answer',
    });

    const committed = useChatStore.getState().getThread(thread.id)!;
    const replacementIndex = committed.messages.findIndex(
      (message) => message.id === `${thread.id}-user-1`,
    );
    expect(committed.activeModelId).toBe('author/model-q8');
    expect(committed.messages[replacementIndex - 1]).toEqual(expect.objectContaining({
      kind: 'model_switch',
      switchFromModelId: 'author/model-q4',
      switchToModelId: 'author/model-q8',
    }));
    expect(committed.messages[replacementIndex]).toEqual(expect.objectContaining({
      role: 'user',
      modelId: 'author/model-q8',
    }));
    expect(committed.messages[replacementIndex + 1]).toEqual(expect.objectContaining({
      id: assistantId,
      role: 'assistant',
      modelId: 'author/model-q8',
    }));
    expect(committed.messages.at(-1)?.kind).not.toBe('model_switch');
  });

  it('deletes a message branch and resets the thread to earlier messages', () => {
    const threadId = useChatStore.getState().createThread({
      modelId: 'author/model-q4',
      presetId: null,
      presetSnapshot: {
        id: null,
        name: 'Default',
        systemPrompt: 'You are helpful.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 1024,
        seed: null,
      },
    });

    useChatStore.getState().appendMessage(threadId, {
      id: 'user-1',
      role: 'user',
      content: 'First prompt',
      createdAt: 1,
      state: 'complete',
    });
    useChatStore.getState().appendMessage(threadId, {
      id: 'assistant-1',
      role: 'assistant',
      content: 'First reply',
      createdAt: 2,
      state: 'complete',
    });
    useChatStore.getState().appendMessage(threadId, {
      id: 'user-2',
      role: 'user',
      content: 'Second prompt',
      createdAt: 3,
      state: 'complete',
    });

    expect(useChatStore.getState().deleteMessageBranch(threadId, 'assistant-1')).toBe(true);
    expect(useChatStore.getState().getThread(threadId)?.messages).toEqual([
      expect.objectContaining({
        id: 'user-1',
        role: 'user',
        content: 'First prompt',
      }),
    ]);
  });

  it('cleans attachments removed by branch deletion without deleting surviving references', async () => {
    const retainedAttachment = buildStoredAttachment('thread-branch-cleanup', 'user-1', 'shared.jpg');
    const removedAttachment = buildStoredAttachment('thread-branch-cleanup', 'user-2', 'removed-branch.jpg');
    const thread: ChatThread = {
      ...buildThread('thread-branch-cleanup', 10),
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'Keep this image',
          createdAt: 10,
          state: 'complete',
          attachments: [retainedAttachment],
        },
        {
          id: 'assistant-1',
          role: 'assistant',
          content: 'First reply',
          createdAt: 11,
          state: 'complete',
        },
        {
          id: 'user-2',
          role: 'user',
          content: 'Remove this branch image',
          createdAt: 12,
          state: 'complete',
          attachments: [removedAttachment],
        },
      ],
    };

    seedPersistedChatThread(thread, 100);

    expect(useChatStore.getState().deleteMessageBranch(thread.id, 'user-2')).toBe(true);
    await flushAttachmentCleanup();

    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(removedAttachment.localUri, {
      idempotent: true,
    });
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith(retainedAttachment.localUri, expect.anything());
  });

  it('defers retry or edit branch attachment cleanup until terminal replacement', async () => {
    const retainedAttachment = buildStoredAttachment('thread-edit-cleanup', 'user-1', 'edited-kept.jpg');
    const removedAttachment = buildStoredAttachment('thread-edit-cleanup', 'user-2', 'edited-removed.jpg');
    const thread: ChatThread = {
      ...buildThread('thread-edit-cleanup', 10),
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'Original image prompt',
          createdAt: 10,
          state: 'complete',
          attachments: [retainedAttachment],
        },
        {
          id: 'assistant-1',
          role: 'assistant',
          content: 'First reply',
          createdAt: 11,
          state: 'complete',
        },
        {
          id: 'user-2',
          role: 'user',
          content: 'Later image prompt',
          createdAt: 12,
          state: 'complete',
          attachments: [removedAttachment],
        },
      ],
    };

    seedPersistedChatThread(thread, 100);

    const assistantId = useChatStore.getState().replaceBranchFromUserMessage(
      thread.id,
      'user-1',
      'Edited original image prompt',
    );
    expect(assistantId).toBeTruthy();
    await flushAttachmentCleanup();

    expect(useChatStore.getState().getThread(thread.id)?.messages[0]?.attachments).toEqual([retainedAttachment]);
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith(removedAttachment.localUri, expect.anything());

    useChatStore.getState().finalizeAssistantTurn(thread.id, assistantId!, {
      outcome: 'success',
      content: 'Replacement response',
    });
    await flushAttachmentCleanup();

    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(removedAttachment.localUri, {
      idempotent: true,
    });
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith(retainedAttachment.localUri, expect.anything());
  });

  it('recomputes activeModelId from the surviving history when deleting an older branch after multiple switches', () => {
    const threadId = useChatStore.getState().createThread({
      modelId: 'author/model-q4',
      presetId: null,
      presetSnapshot: {
        id: null,
        name: 'Default',
        systemPrompt: 'You are helpful.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 1024,
        seed: null,
      },
    });

    useChatStore.getState().appendMessage(threadId, {
      id: 'user-1',
      role: 'user',
      content: 'First prompt',
      createdAt: 1,
      state: 'complete',
    });
    useChatStore.getState().appendMessage(threadId, {
      id: 'assistant-1',
      role: 'assistant',
      content: 'First reply',
      createdAt: 2,
      state: 'complete',
    });
    useChatStore.getState().switchThreadModel(threadId, 'author/model-q8', 3);
    useChatStore.getState().appendMessage(threadId, {
      id: 'user-2',
      role: 'user',
      content: 'Second prompt',
      createdAt: 4,
      state: 'complete',
    });
    useChatStore.getState().appendMessage(threadId, {
      id: 'assistant-2',
      role: 'assistant',
      content: 'Second reply',
      createdAt: 5,
      state: 'complete',
    });
    useChatStore.getState().switchThreadModel(threadId, 'author/model-q6', 6);

    expect(useChatStore.getState().deleteMessageBranch(threadId, 'assistant-2')).toBe(true);

    const thread = useChatStore.getState().getThread(threadId);

    expect(thread?.activeModelId).toBe('author/model-q8');
    expect(thread?.messages).toEqual([
      expect.objectContaining({
        id: 'user-1',
        role: 'user',
        modelId: 'author/model-q4',
      }),
      expect.objectContaining({
        id: 'assistant-1',
        role: 'assistant',
        modelId: 'author/model-q4',
      }),
      expect.objectContaining({
        kind: 'model_switch',
        switchFromModelId: 'author/model-q4',
        switchToModelId: 'author/model-q8',
      }),
      expect.objectContaining({
        id: 'user-2',
        role: 'user',
        modelId: 'author/model-q8',
      }),
    ]);
  });

  it('deletes a thread and moves the active selection to the newest remaining thread', () => {
    const firstThreadId = useChatStore.getState().createThread({
      modelId: 'author/model-q4',
      presetId: null,
      presetSnapshot: {
        id: null,
        name: 'Default',
        systemPrompt: 'You are helpful.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 1024,
        seed: null,
      },
    });
    const secondThreadId = useChatStore.getState().createThread({
      modelId: 'author/model-q4',
      presetId: null,
      presetSnapshot: {
        id: null,
        name: 'Default',
        systemPrompt: 'You are helpful.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 1024,
        seed: null,
      },
    });

    useChatStore.getState().deleteThread(secondThreadId);

    expect(useChatStore.getState().getThread(secondThreadId)).toBeNull();
    expect(useChatStore.getState().activeThreadId).toBe(firstThreadId);
  });

  it('cleans attachment files when deleting full threads', async () => {
    const removedAttachment = buildStoredAttachment('thread-delete-cleanup', 'user-1', 'thread-delete.jpg');
    const retainedAttachment = buildStoredAttachment('thread-retained-cleanup', 'user-1', 'thread-retained.jpg');
    const removedThread: ChatThread = {
      ...buildThread('thread-delete-cleanup', 10),
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'Remove thread attachment',
          createdAt: 10,
          state: 'complete',
          attachments: [removedAttachment],
        },
      ],
    };
    const retainedThread: ChatThread = {
      ...buildThread('thread-retained-cleanup', 20),
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'Keep thread attachment',
          createdAt: 20,
          state: 'complete',
          attachments: [retainedAttachment],
        },
      ],
    };

    useChatStore.setState({
      threads: {
        [removedThread.id]: removedThread,
        [retainedThread.id]: retainedThread,
      },
      activeThreadId: removedThread.id,
    });

    useChatStore.getState().deleteThread(removedThread.id);
    await flushAttachmentCleanup();

    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(removedAttachment.localUri, {
      idempotent: true,
    });
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith(retainedAttachment.localUri, expect.anything());
  });

  it('persists an explicit blank active thread selection across rehydrate', async () => {
    const firstThreadId = useChatStore.getState().createThread({
      modelId: 'author/model-q4',
      presetId: null,
      presetSnapshot: {
        id: null,
        name: 'Default',
        systemPrompt: 'You are helpful.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 1024,
        seed: null,
      },
    });
    const secondThreadId = useChatStore.getState().createThread({
      modelId: 'author/model-q4',
      presetId: null,
      presetSnapshot: {
        id: null,
        name: 'Default',
        systemPrompt: 'You are helpful.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 1024,
        seed: null,
      },
    });

    useChatStore.getState().setActiveThread(null);

    expect(useChatStore.getState().activeThreadId).toBeNull();
    expect(readPersistedChatIndex()).toEqual(expect.objectContaining({
      activeThreadId: null,
      threadIds: [firstThreadId, secondThreadId],
    }));

    useChatStore.setState({ threads: {}, activeThreadId: secondThreadId });
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().getThread(firstThreadId)).toEqual(
      expect.objectContaining({ id: firstThreadId }),
    );
    expect(useChatStore.getState().getThread(secondThreadId)).toEqual(
      expect.objectContaining({ id: secondThreadId }),
    );
    expect(useChatStore.getState().activeThreadId).toBeNull();
    expect(readPersistedChatIndex().activeThreadId).toBeNull();
  });

  it('recovers a pending thread commit when the record was written before the index update', async () => {
    const thread = buildThread('thread-pending-record-first', 20);

    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: null,
      threadIds: [],
      updatedAt: 10,
      revision: 1,
    });
    writeChatThreadRecord(storage, thread, 21, { commitRevision: 2 });
    writeChatPendingIndexCommit(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      revision: 2,
      activeThreadId: thread.id,
      threadIds: [thread.id],
      updatedAt: 22,
      reason: 'thread_mutation',
      changedThreadIds: [thread.id],
    });

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().getThread(thread.id)).toEqual(
      expect.objectContaining({ id: thread.id }),
    );
    expect(useChatStore.getState().activeThreadId).toBe(thread.id);
    expect(readPersistedChatIndex()).toEqual(expect.objectContaining({
      activeThreadId: thread.id,
      threadIds: [thread.id],
      revision: 2,
    }));
    expect(storage.getString(CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY)).toBeUndefined();
  });

  it('cleans attachment files dropped while recovering a pending thread commit', async () => {
    const keptAttachment = buildStoredAttachment('thread-pending-sanitized-attachment', 'user-1', 'pending-kept.jpg');
    const droppedAttachment = {
      ...buildStoredAttachment('thread-pending-sanitized-attachment', 'user-1', 'pending-dropped.txt'),
      mediaType: 'text/plain',
    };
    const thread: ChatThread = {
      ...buildThread('thread-pending-sanitized-attachment', 20),
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'Pending sanitized attachment',
          createdAt: 20,
          state: 'complete',
          attachments: [keptAttachment, droppedAttachment],
        },
      ],
    };

    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: null,
      threadIds: [],
      updatedAt: 10,
      revision: 1,
    });
    storage.set(getChatThreadStorageKey(thread.id), JSON.stringify({
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      thread,
      persistedAt: 21,
      commitRevision: 2,
    }));
    writeChatPendingIndexCommit(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      revision: 2,
      activeThreadId: thread.id,
      threadIds: [thread.id],
      updatedAt: 22,
      reason: 'thread_mutation',
      changedThreadIds: [thread.id],
      requiresChangedThreadCommitRevision: true,
    });

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();
    await flushAttachmentCleanup();

    expect(useChatStore.getState().getThread(thread.id)?.messages[0]?.attachments).toEqual([keptAttachment]);
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(droppedAttachment.localUri, {
      idempotent: true,
    });
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith(keptAttachment.localUri, expect.anything());
  });

  it('recovers legacy pending commits whose changed records predate commit revision markers', async () => {
    const thread = buildThread('thread-pending-legacy-record', 20);

    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: null,
      threadIds: [],
      updatedAt: 10,
      revision: 1,
    });
    writeChatThreadRecord(storage, thread, 23);
    writeChatPendingIndexCommit(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      revision: 2,
      activeThreadId: thread.id,
      threadIds: [thread.id],
      updatedAt: 22,
      reason: 'thread_mutation',
      changedThreadIds: [thread.id],
    });

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().getThread(thread.id)).toEqual(
      expect.objectContaining({ id: thread.id }),
    );
    expect(useChatStore.getState().activeThreadId).toBe(thread.id);
    expect(readPersistedChatIndex()).toEqual(expect.objectContaining({
      activeThreadId: thread.id,
      threadIds: [thread.id],
      revision: 2,
    }));
    expect(storage.getString(getChatThreadStorageKey(thread.id))).toContain('"commitRevision":2');
    expect(storage.getString(CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY)).toBeUndefined();
  });

  it('falls back to the previous index when a legacy changed record predates the pending commit', async () => {
    const staleThread = {
      ...buildThread('thread-legacy-stale-record', 10),
      title: 'Old title',
    };

    writeChatThreadRecord(storage, staleThread, 11);
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: staleThread.id,
      threadIds: [staleThread.id],
      updatedAt: 12,
      revision: 1,
    });
    writeChatPendingIndexCommit(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      revision: 2,
      activeThreadId: staleThread.id,
      threadIds: [staleThread.id],
      updatedAt: 13,
      reason: 'thread_mutation',
      changedThreadIds: [staleThread.id],
    });

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().getThread(staleThread.id)).toEqual(
      expect.objectContaining({ title: 'Old title' }),
    );
    expect(readPersistedChatIndex()).toEqual(expect.objectContaining({
      activeThreadId: staleThread.id,
      threadIds: [staleThread.id],
      revision: 1,
    }));
    expect(storage.getString(getChatThreadStorageKey(staleThread.id))).not.toContain('"commitRevision"');
    expect(storage.getString(CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY)).toBeUndefined();
  });

  it('falls back to the previous index when a strict pending record lacks a commit revision marker', async () => {
    const staleThread = buildThread('thread-strict-record-without-revision', 10);

    writeChatThreadRecord(storage, staleThread, 11);
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: staleThread.id,
      threadIds: [staleThread.id],
      updatedAt: 12,
      revision: 1,
    });
    writeChatPendingIndexCommit(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      revision: 2,
      activeThreadId: staleThread.id,
      threadIds: [staleThread.id],
      updatedAt: 13,
      reason: 'thread_mutation',
      changedThreadIds: [staleThread.id],
      requiresChangedThreadCommitRevision: true,
    });

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().getThread(staleThread.id)).toEqual(
      expect.objectContaining({ id: staleThread.id }),
    );
    expect(readPersistedChatIndex()).toEqual(expect.objectContaining({
      activeThreadId: staleThread.id,
      threadIds: [staleThread.id],
      revision: 1,
    }));
    expect(storage.getString(getChatThreadStorageKey(staleThread.id))).not.toContain('"commitRevision"');
    expect(storage.getString(CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY)).toBeUndefined();
  });

  it('falls back to the previous index when a changed pending thread record is missing', async () => {
    const existingThread = buildThread('thread-existing', 10);
    const missingThreadId = 'thread-missing-record';

    writeChatThreadRecord(storage, existingThread, 11, { commitRevision: 1 });
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: existingThread.id,
      threadIds: [existingThread.id],
      updatedAt: 12,
      revision: 1,
    });
    writeChatPendingIndexCommit(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      revision: 2,
      activeThreadId: missingThreadId,
      threadIds: [existingThread.id, missingThreadId],
      updatedAt: 13,
      reason: 'thread_mutation',
      changedThreadIds: [missingThreadId],
    });

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().getThread(existingThread.id)).toEqual(
      expect.objectContaining({ id: existingThread.id }),
    );
    expect(useChatStore.getState().getThread(missingThreadId)).toBeNull();
    expect(useChatStore.getState().activeThreadId).toBe(existingThread.id);
    expect(readPersistedChatIndex()).toEqual(expect.objectContaining({
      activeThreadId: existingThread.id,
      threadIds: [existingThread.id],
      revision: 1,
    }));
    expect(readPersistedChatIndex()).not.toHaveProperty('corruptThreadIds');
    expect(storage.getString(CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY)).toBeUndefined();
  });

  it('does not apply pending removals when a mixed commit has no durable changed record', async () => {
    const retainedThread = buildThread('thread-mixed-retained', 10);
    const removedThread = buildThread('thread-mixed-removed', 20);
    const missingThreadId = 'thread-mixed-missing-record';

    writeChatThreadRecord(storage, retainedThread, 11, { commitRevision: 1 });
    writeChatThreadRecord(storage, removedThread, 21, { commitRevision: 1 });
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: removedThread.id,
      threadIds: [retainedThread.id, removedThread.id],
      updatedAt: 22,
      revision: 1,
    });
    writeChatPendingIndexCommit(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      revision: 2,
      activeThreadId: retainedThread.id,
      threadIds: [retainedThread.id, missingThreadId],
      updatedAt: 23,
      reason: 'thread_mutation',
      changedThreadIds: [missingThreadId],
      removedThreadIds: [removedThread.id],
      requiresChangedThreadCommitRevision: true,
    });

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().getThread(retainedThread.id)).toEqual(
      expect.objectContaining({ id: retainedThread.id }),
    );
    expect(useChatStore.getState().getThread(removedThread.id)).toEqual(
      expect.objectContaining({ id: removedThread.id }),
    );
    expect(useChatStore.getState().getThread(missingThreadId)).toBeNull();
    expect(readPersistedChatIndex()).toEqual(expect.objectContaining({
      activeThreadId: removedThread.id,
      threadIds: [retainedThread.id, removedThread.id],
      revision: 1,
    }));
    expect(storage.getString(getChatThreadStorageKey(removedThread.id))).toContain(removedThread.title);
    expect(storage.getString(CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY)).toBeUndefined();
  });

  it('falls back to the previous index when a changed pending thread record has an older commit revision', async () => {
    const staleThread = {
      ...buildThread('thread-stale-record', 10),
      title: 'Old title',
    };

    writeChatThreadRecord(storage, staleThread, 11, { commitRevision: 1 });
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: staleThread.id,
      threadIds: [staleThread.id],
      updatedAt: 12,
      revision: 1,
    });
    writeChatPendingIndexCommit(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      revision: 2,
      activeThreadId: staleThread.id,
      threadIds: [staleThread.id],
      updatedAt: 13,
      reason: 'thread_mutation',
      changedThreadIds: [staleThread.id],
    });

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().getThread(staleThread.id)).toEqual(
      expect.objectContaining({ title: 'Old title' }),
    );
    expect(readPersistedChatIndex()).toEqual(expect.objectContaining({
      activeThreadId: staleThread.id,
      threadIds: [staleThread.id],
      revision: 1,
    }));
    expect(storage.getString(getChatThreadStorageKey(staleThread.id))).toContain('"commitRevision":1');
    expect(storage.getString(CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY)).toBeUndefined();
  });

  it('removes unindexed changed records when their commit revision does not match the pending revision', async () => {
    const uncommittedThread = buildThread('thread-uncommitted-record', 10);

    writeChatThreadRecord(storage, uncommittedThread, 11, { commitRevision: 1 });
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: null,
      threadIds: [],
      updatedAt: 12,
      revision: 1,
    });
    writeChatPendingIndexCommit(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      revision: 2,
      activeThreadId: uncommittedThread.id,
      threadIds: [uncommittedThread.id],
      updatedAt: 13,
      reason: 'thread_mutation',
      changedThreadIds: [uncommittedThread.id],
    });

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().getThread(uncommittedThread.id)).toBeNull();
    expect(storage.getString(getChatThreadStorageKey(uncommittedThread.id))).toBeUndefined();
    expect(readPersistedChatIndex()).toEqual(expect.objectContaining({
      activeThreadId: null,
      threadIds: [],
      revision: 1,
    }));
    expect(storage.getString(CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY)).toBeUndefined();
  });

  it('removes unapplied changed records when discarding a pending commit without a trusted index', async () => {
    const unappliedThread = buildThread('thread-pending-indexless-record', 10);

    writeChatThreadRecord(storage, unappliedThread, 11, { commitRevision: 1 });
    writeChatPendingIndexCommit(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      revision: 2,
      activeThreadId: unappliedThread.id,
      threadIds: [unappliedThread.id],
      updatedAt: 13,
      reason: 'thread_mutation',
      changedThreadIds: [unappliedThread.id],
      requiresChangedThreadCommitRevision: true,
    });

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().getThread(unappliedThread.id)).toBeNull();
    expect(storage.getString(getChatThreadStorageKey(unappliedThread.id))).toBeUndefined();
    expect(storage.getString(CHAT_PERSISTENCE_INDEX_KEY)).toBeUndefined();
    expect(storage.getString(CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY)).toBeUndefined();
  });

  it('applies pending commits when changed records match the pending revision and unchanged records are older', async () => {
    const unchangedThread = buildThread('thread-unchanged-record', 10);
    const changedThread = {
      ...buildThread('thread-changed-record', 20),
      title: 'Changed title',
    };

    writeChatThreadRecord(storage, unchangedThread, 11, { commitRevision: 1 });
    writeChatThreadRecord(storage, changedThread, 21, { commitRevision: 2 });
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: unchangedThread.id,
      threadIds: [unchangedThread.id],
      updatedAt: 12,
      revision: 1,
    });
    writeChatPendingIndexCommit(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      revision: 2,
      activeThreadId: changedThread.id,
      threadIds: [unchangedThread.id, changedThread.id],
      updatedAt: 22,
      reason: 'thread_mutation',
      changedThreadIds: [changedThread.id],
    });

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().getThread(unchangedThread.id)).toEqual(
      expect.objectContaining({ id: unchangedThread.id }),
    );
    expect(useChatStore.getState().getThread(changedThread.id)).toEqual(
      expect.objectContaining({ title: 'Changed title' }),
    );
    expect(useChatStore.getState().activeThreadId).toBe(changedThread.id);
    expect(readPersistedChatIndex()).toEqual(expect.objectContaining({
      activeThreadId: changedThread.id,
      threadIds: [unchangedThread.id, changedThread.id],
      revision: 2,
    }));
    expect(storage.getString(CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY)).toBeUndefined();
  });

  it('applies pending removed thread ids before discovery can resurrect stale records', async () => {
    const staleThread = buildThread('thread-pending-stale', 5);
    const retainedThread = buildThread('thread-pending-retained', 20);

    writeChatThreadRecord(storage, staleThread, 6, { commitRevision: 1 });
    writeChatThreadRecord(storage, retainedThread, 21, { commitRevision: 1 });
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: retainedThread.id,
      threadIds: [staleThread.id, retainedThread.id],
      updatedAt: 22,
      revision: 1,
    });
    writeChatPendingIndexCommit(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      revision: 2,
      activeThreadId: retainedThread.id,
      threadIds: [retainedThread.id],
      updatedAt: 23,
      reason: 'retention_cleanup',
      removedThreadIds: [staleThread.id],
    });

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().getThread(staleThread.id)).toBeNull();
    expect(useChatStore.getState().getThread(retainedThread.id)).toEqual(
      expect.objectContaining({ id: retainedThread.id }),
    );
    expect(storage.getString(getChatThreadStorageKey(staleThread.id))).toBeUndefined();
    expect(readPersistedChatIndex()).toEqual(expect.objectContaining({
      activeThreadId: retainedThread.id,
      threadIds: [retainedThread.id],
      revision: 2,
    }));
    expect(storage.getString(CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY)).toBeUndefined();
  });

  it('ignores stale pending removals from an older revision', async () => {
    const currentThread = buildThread('thread-newer-revision', 30);

    writeChatThreadRecord(storage, currentThread, 31, { commitRevision: 3 });
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: currentThread.id,
      threadIds: [currentThread.id],
      updatedAt: 32,
      revision: 3,
    });
    writeChatPendingIndexCommit(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      revision: 2,
      activeThreadId: null,
      threadIds: [],
      updatedAt: 22,
      reason: 'retention_cleanup',
      removedThreadIds: [currentThread.id],
    });

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().getThread(currentThread.id)).toEqual(
      expect.objectContaining({ id: currentThread.id }),
    );
    expect(storage.getString(getChatThreadStorageKey(currentThread.id))).toContain(currentThread.title);
    expect(storage.getString(CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY)).toBeUndefined();
  });

  it('removes persisted v2 records when deleting the last thread', () => {
    const threadId = useChatStore.getState().createThread({
      modelId: 'author/model-q4',
      presetId: null,
      presetSnapshot: {
        id: null,
        name: 'Default',
        systemPrompt: 'You are helpful.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 1024,
        seed: null,
      },
    });

    expect(storage.getString(getChatThreadStorageKey(threadId))).toBeTruthy();
    expect(storage.getString(CHAT_PERSISTENCE_INDEX_KEY)).toBeTruthy();

    useChatStore.getState().deleteThread(threadId);

    expect(useChatStore.getState().getThread(threadId)).toBeNull();
    expect(storage.getString('chat-store')).toBeUndefined();
    expect(storage.getString(getChatThreadStorageKey(threadId))).toBeUndefined();
    expectPersistedChatClearTombstone();
  });

  it('removes persisted v2 records when clearing all threads', () => {
    const threadId = useChatStore.getState().createThread({
      modelId: 'author/model-q4',
      presetId: null,
      presetSnapshot: {
        id: null,
        name: 'Default',
        systemPrompt: 'You are helpful.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 1024,
        seed: null,
      },
    });

    expect(storage.getString(getChatThreadStorageKey(threadId))).toBeTruthy();
    expect(storage.getString(CHAT_PERSISTENCE_INDEX_KEY)).toBeTruthy();
    expect(useChatStore.getState().clearAllThreads()).toBe(1);
    expect(storage.getString('chat-store')).toBeUndefined();
    expect(storage.getString(getChatThreadStorageKey(threadId))).toBeUndefined();
    expectPersistedChatClearTombstone();
  });

  it('clearAllThreads writes one clear tombstone and cancels pending progress', () => {
    jest.useFakeTimers();
    const thread = buildThread('thread-single-clear-all', 10);
    seedPersistedChatThread(thread, 100);
    const messageId = useChatStore.getState().createAssistantPlaceholder(thread.id);
    useChatStore.getState().patchAssistantMessage(thread.id, messageId, {
      content: 'Pending partial before clear',
    });
    const streamingMessage = useChatStore.getState().getThread(thread.id)?.messages.at(-1);
    writeChatStreamingProgressRecord(storage, {
      schemaVersion: CHAT_STREAM_PROGRESS_SCHEMA_VERSION,
      threadId: thread.id,
      messageId,
      modelId: 'author/model-q4',
      createdAt: streamingMessage?.createdAt ?? 11,
      content: 'Persisted partial before clear',
      state: 'streaming',
      persistedAt: 101,
      revision: 1,
    });
    const revisionBefore = Number(readPersistedChatIndex().revision ?? 0);
    writeChatPendingIndexCommit(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      revision: revisionBefore + 1,
      activeThreadId: thread.id,
      threadIds: [thread.id],
      updatedAt: 102,
      reason: 'thread_mutation',
      changedThreadIds: [thread.id],
      requiresChangedThreadCommitRevision: true,
    });
    const capture = captureClearIndexWrites();

    try {
      expect(useChatStore.getState().clearAllThreads()).toBe(1);

      expect(capture.writes).toEqual([
        expect.objectContaining({
          threadIds: [],
          revision: revisionBefore + 1,
          clearedAt: expect.any(Number),
        }),
      ]);
      expect(storage.getString(getChatThreadStorageKey(thread.id))).toBeUndefined();
      expectNoStreamingProgressArtifacts(thread.id);
      expect(storage.getString(CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY)).toBeUndefined();

      jest.advanceTimersByTime(10_000);

      expect(capture.writes).toHaveLength(1);
      expectNoStreamingProgressArtifacts(thread.id);
    } finally {
      capture.restore();
      jest.useRealTimers();
    }
  });

  it('deleting the final thread performs one persistence clear', () => {
    const thread = buildThread('thread-single-clear-delete', 10);
    seedPersistedChatThread(thread, 100);
    const revisionBefore = Number(readPersistedChatIndex().revision ?? 0);
    const capture = captureClearIndexWrites();

    try {
      useChatStore.getState().deleteThread(thread.id);

      expect(capture.writes).toEqual([
        expect.objectContaining({
          threadIds: [],
          revision: revisionBefore + 1,
          clearedAt: expect.any(Number),
        }),
      ]);
      expect(useChatStore.getState().getThread(thread.id)).toBeNull();
      expect(storage.getString(getChatThreadStorageKey(thread.id))).toBeUndefined();
    } finally {
      capture.restore();
    }
  });

  it('retention pruning the final threads performs one persistence clear', () => {
    const now = 100 * 24 * 60 * 60 * 1000;
    const staleThread = buildThread(
      'thread-single-clear-retention',
      now - 95 * 24 * 60 * 60 * 1000,
    );
    seedPersistedChatThread(staleThread, 100);
    useChatStore.setState({ activeThreadId: null });
    const revisionBefore = Number(readPersistedChatIndex().revision ?? 0);
    const capture = captureClearIndexWrites();

    try {
      expect(useChatStore.getState().pruneExpiredThreads(90, now)).toBe(1);

      expect(capture.writes).toEqual([
        expect.objectContaining({
          threadIds: [],
          revision: revisionBefore + 1,
          clearedAt: expect.any(Number),
        }),
      ]);
      expect(useChatStore.getState().getThread(staleThread.id)).toBeNull();
      expect(storage.getString(getChatThreadStorageKey(staleThread.id))).toBeUndefined();
    } finally {
      capture.restore();
    }
  });

  it('clearing an already-empty store cleans corrupt and orphaned records once', () => {
    const orphanThreadId = 'thread-orphaned-empty-clear';
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: null,
      threadIds: [orphanThreadId],
      updatedAt: 40,
      revision: 7,
    });
    storage.set(getChatThreadStorageKey(orphanThreadId), '{broken thread');
    storage.set(getChatStreamingProgressStorageKey(orphanThreadId), '{broken progress');
    storage.set('chat-store', JSON.stringify({ stale: true }));
    writeChatPendingIndexCommit(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      revision: 8,
      activeThreadId: null,
      threadIds: [],
      updatedAt: 41,
      reason: 'thread_mutation',
      removedThreadIds: [orphanThreadId],
    });
    const capture = captureClearIndexWrites();

    try {
      expect(useChatStore.getState().clearAllThreads()).toBe(0);

      expect(capture.writes).toEqual([
        expect.objectContaining({
          threadIds: [],
          revision: 8,
          clearedAt: expect.any(Number),
        }),
      ]);
      expect(storage.getString(getChatThreadStorageKey(orphanThreadId))).toBeUndefined();
      expectNoStreamingProgressArtifacts(orphanThreadId);
      expect(storage.getString(CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY)).toBeUndefined();
      expect(storage.getString('chat-store')).toBeUndefined();
    } finally {
      capture.restore();
    }
  });

  it('does not run a second clear that can fail after the first clear succeeded', () => {
    const thread = buildThread('thread-no-second-clear-failure', 10);
    seedPersistedChatThread(thread, 100);
    const secondClearError = new Error('simulated second clear failure');
    const capture = captureClearIndexWrites({
      throwOnClearWrite: 2,
      error: secondClearError,
    });

    try {
      expect(useChatStore.getState().clearAllThreads()).toBe(1);
      expect(capture.writes).toHaveLength(1);
      expect(useChatStore.getState().getThread(thread.id)).toBeNull();
      expectPersistedChatClearTombstone();
    } finally {
      capture.restore();
    }
  });

  it('rolls back an empty-store transition when its single clear write fails', () => {
    const thread = buildThread('thread-single-clear-rollback', 10);
    seedPersistedChatThread(thread, 100);
    const clearError = new Error('simulated first clear failure');
    const capture = captureClearIndexWrites({
      throwOnClearWrite: 1,
      error: clearError,
    });

    try {
      expect(() => useChatStore.getState().clearAllThreads()).toThrow(clearError);
    } finally {
      capture.restore();
    }

    expect(useChatStore.getState().getThread(thread.id)).toEqual(thread);
    expect(storage.getString(getChatThreadStorageKey(thread.id))).toContain(thread.title);
    const rolledBackIndex = readPersistedChatIndex();
    expect(rolledBackIndex).toEqual(expect.objectContaining({
      activeThreadId: thread.id,
      threadIds: [thread.id],
    }));
    expect(rolledBackIndex).not.toHaveProperty('clearedAt');
  });

  it('cleans attachment files when clearing all chat history', async () => {
    const attachment = buildStoredAttachment('thread-clear-cleanup', 'user-1', 'clear-history.jpg');
    const thread: ChatThread = {
      ...buildThread('thread-clear-cleanup', 10),
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'Clear history image',
          createdAt: 10,
          state: 'complete',
          attachments: [attachment],
        },
      ],
    };

    useChatStore.setState({
      threads: { [thread.id]: thread },
      activeThreadId: thread.id,
    });

    expect(useChatStore.getState().clearAllThreads()).toBe(1);
    await flushAttachmentCleanup();

    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(attachment.localUri, {
      idempotent: true,
    });
    expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(1);
  });

  it('leaves a clear tombstone when resetting chat state for private storage recovery', () => {
    const threadId = useChatStore.getState().createThread({
      modelId: 'author/model-q4',
      presetId: null,
      presetSnapshot: {
        id: null,
        name: 'Default',
        systemPrompt: 'You are helpful.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 1024,
        seed: null,
      },
    });

    expect(storage.getString(getChatThreadStorageKey(threadId))).toBeTruthy();

    resetChatStoreForPrivateStorageReset();

    expect(useChatStore.getState().getThread(threadId)).toBeNull();
    expect(useChatStore.getState().activeThreadId).toBeNull();
    expect(storage.getString('chat-store')).toBeUndefined();
    expect(storage.getString(getChatThreadStorageKey(threadId))).toBeUndefined();
    expectPersistedChatClearTombstone();
  });

  it('captures preset and params snapshots immutably at thread creation', () => {
    const paramsSnapshot = {
      temperature: 0.7,
      topP: 0.9,
      maxTokens: 1024,
      seed: null,
    };
    const presetSnapshot = {
      id: 'preset-1',
      name: 'Helpful Assistant',
      systemPrompt: 'Be concise.',
    };

    const threadId = useChatStore.getState().createThread({
      modelId: 'author/model-q4',
      presetId: 'preset-1',
      presetSnapshot,
      paramsSnapshot,
    });

    paramsSnapshot.temperature = 1.8;
    presetSnapshot.name = 'Changed later';
    presetSnapshot.systemPrompt = 'Different prompt';

    expect(useChatStore.getState().getThread(threadId)).toEqual(
      expect.objectContaining({
        paramsSnapshot: expect.objectContaining({
          temperature: 0.7,
          topP: 0.9,
          topK: 40,
          minP: 0.05,
          repetitionPenalty: 1,
          maxTokens: 1024,
        }),
        presetSnapshot: {
          id: 'preset-1',
          name: 'Helpful Assistant',
          systemPrompt: 'Be concise.',
        },
      }),
    );
  });

  it('updates the preset snapshot for an existing thread', () => {
    const threadId = useChatStore.getState().createThread({
      modelId: 'author/model-q4',
      presetId: 'preset-1',
      presetSnapshot: {
        id: 'preset-1',
        name: 'Helpful Assistant',
        systemPrompt: 'Be concise.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 1024,
        seed: null,
      },
    });

    useChatStore.getState().updateThreadPresetSnapshot(threadId, 'preset-2', {
      id: 'preset-2',
      name: 'Research Analyst',
      systemPrompt: 'Organize findings clearly.',
    });

    expect(useChatStore.getState().getThread(threadId)).toEqual(
      expect.objectContaining({
        presetId: 'preset-2',
        presetSnapshot: {
          id: 'preset-2',
          name: 'Research Analyst',
          systemPrompt: 'Organize findings clearly.',
        },
      }),
    );
  });

  it('updates thread activity when params snapshot changes', () => {
    const threadId = useChatStore.getState().createThread({
      modelId: 'author/model-q4',
      presetId: 'preset-1',
      presetSnapshot: {
        id: 'preset-1',
        name: 'Helpful Assistant',
        systemPrompt: 'Be concise.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 1024,
        seed: null,
      },
    });
    const before = useChatStore.getState().getThread(threadId);
    expect(before).toBeTruthy();

    const originalDateNow = Date.now;
    Date.now = jest.fn(() => (before?.updatedAt ?? 0) + 5_000);

    try {
      useChatStore.getState().updateThreadParamsSnapshot(threadId, {
        temperature: 1.1,
        topP: 0.4,
        topK: 60,
        minP: 0.1,
        repetitionPenalty: 1.2,
        maxTokens: 512,
        reasoningEffort: 'high',
        seed: null,
      });
    } finally {
      Date.now = originalDateNow;
    }

    expect(useChatStore.getState().getThread(threadId)).toEqual(
      expect.objectContaining({
        updatedAt: (before?.updatedAt ?? 0) + 5_000,
        paramsSnapshot: {
          temperature: 1.1,
          topP: 0.4,
          topK: 60,
          minP: 0.1,
          repetitionPenalty: 1.2,
          maxTokens: 512,
          reasoningEffort: 'high',
          seed: null,
        },
      }),
    );
  });

  it('derives a stable truncated title from the first user message', () => {
    const threadId = useChatStore.getState().createThread({
      modelId: 'author/model-q4',
      presetId: null,
      presetSnapshot: {
        id: null,
        name: 'Default',
        systemPrompt: 'You are helpful.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 1024,
        seed: null,
      },
    });

    useChatStore.getState().appendMessage(threadId, {
      id: 'user-1',
      role: 'user',
      content: 'This is a long opening question that should become a shortened conversation title for history',
      createdAt: Date.now(),
      state: 'complete',
    });

    expect(useChatStore.getState().getThread(threadId)?.title).toBe(
      'This is a long opening question that should b...',
    );
  });

  it('keeps a manually renamed title after more messages are added', () => {
    const threadId = useChatStore.getState().createThread({
      modelId: 'author/model-q4',
      presetId: null,
      presetSnapshot: {
        id: null,
        name: 'Default',
        systemPrompt: 'You are helpful.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 1024,
        seed: null,
      },
    });

    useChatStore.getState().appendMessage(threadId, {
      id: 'user-1',
      role: 'user',
      content: 'Original opening prompt',
      createdAt: Date.now(),
      state: 'complete',
    });

    expect(useChatStore.getState().renameThread(threadId, 'Project Planning')).toBe(true);

    useChatStore.getState().appendMessage(threadId, {
      id: 'assistant-1',
      role: 'assistant',
      content: 'Let us outline the work.',
      createdAt: Date.now(),
      state: 'complete',
    });

    expect(useChatStore.getState().getThread(threadId)).toEqual(
      expect.objectContaining({
        title: 'Project Planning',
        titleSource: 'manual',
      }),
    );
  });

  it('does not schedule attachment cleanup for metadata-only thread mutations', async () => {
    const cleanupSpy = jest
      .spyOn(chatAttachmentStorageService, 'deleteUnreferencedAttachmentFilesDetailed')
      .mockImplementation(reportAllAttachmentCleanupCandidatesDeleted);
    const threadId = useChatStore.getState().createThread({
      modelId: 'author/model-q4',
      presetId: null,
      presetSnapshot: {
        id: null,
        name: 'Default',
        systemPrompt: 'You are helpful.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 1024,
        seed: null,
      },
    });
    useChatStore.getState().appendMessage(threadId, {
      id: 'user-with-attachment',
      role: 'user',
      content: 'Image prompt',
      createdAt: Date.now(),
      state: 'complete',
      attachments: [buildStoredAttachment(threadId, 'user-with-attachment', 'metadata-kept.jpg')],
    });
    await flushAttachmentCleanup();
    cleanupSpy.mockClear();

    expect(useChatStore.getState().renameThread(threadId, 'Renamed')).toBe(true);
    await flushAttachmentCleanup();

    expect(cleanupSpy).not.toHaveBeenCalled();
    cleanupSpy.mockRestore();
  });

  it('serializes overlapping unreferenced attachment cleanup requests', async () => {
    const firstCleanup = {
      resolve: null as ((results: ChatAttachmentFileCleanupResult[]) => void) | null,
    };
    const cleanupSpy = jest
      .spyOn(chatAttachmentStorageService, 'deleteUnreferencedAttachmentFilesDetailed')
      .mockImplementationOnce(() => new Promise<ChatAttachmentFileCleanupResult[]>((resolve) => {
        firstCleanup.resolve = resolve;
      }))
      .mockImplementation(reportAllAttachmentCleanupCandidatesDeleted);
    const firstAttachment = buildStoredAttachment('thread-cleanup-one', 'user-1', 'cleanup-one.jpg');
    const secondAttachment = buildStoredAttachment('thread-cleanup-two', 'user-1', 'cleanup-two.jpg');
    const firstThread: ChatThread = {
      ...buildThread('thread-cleanup-one', 10),
      messages: [{
        id: 'user-1',
        role: 'user',
        content: 'First image prompt',
        createdAt: 10,
        state: 'complete',
        attachments: [firstAttachment],
      }],
    };
    const secondThread: ChatThread = {
      ...buildThread('thread-cleanup-two', 20),
      messages: [{
        id: 'user-1',
        role: 'user',
        content: 'Second image prompt',
        createdAt: 20,
        state: 'complete',
        attachments: [secondAttachment],
      }],
    };

    try {
      useChatStore.setState({
        threads: {
          [firstThread.id]: firstThread,
          [secondThread.id]: secondThread,
        },
        activeThreadId: firstThread.id,
      });

      useChatStore.getState().deleteThread(firstThread.id);
      await flushAttachmentCleanup();

      expect(cleanupSpy).toHaveBeenCalledTimes(1);
      expect(cleanupSpy).toHaveBeenLastCalledWith(expect.objectContaining({
        candidateLocalUris: [firstAttachment.localUri],
        maxDeletes: 16,
      }));

      useChatStore.getState().deleteThread(secondThread.id);
      await flushAttachmentCleanup();

      expect(cleanupSpy).toHaveBeenCalledTimes(1);

      expect(firstCleanup.resolve).toEqual(expect.any(Function));
      firstCleanup.resolve?.([{ localUri: firstAttachment.localUri, status: 'deleted' }]);
      firstCleanup.resolve = null;
      await flushAttachmentCleanup(6);

      expect(cleanupSpy).toHaveBeenCalledTimes(2);
      expect(cleanupSpy).toHaveBeenLastCalledWith(expect.objectContaining({
        candidateLocalUris: [secondAttachment.localUri],
        maxDeletes: 16,
      }));
    } finally {
      if (firstCleanup.resolve) {
        firstCleanup.resolve([{ localUri: firstAttachment.localUri, status: 'deleted' }]);
      }
      cleanupSpy.mockRestore();
    }
  });

  it('does not delete a later cleanup candidate that becomes referenced mid-batch', async () => {
    const firstAttachment = buildStoredAttachment(
      'thread-cleanup-mid-batch-reference',
      'user-1',
      'cleanup-mid-batch-first.jpg',
    );
    const restoredAttachment = buildStoredAttachment(
      'thread-cleanup-mid-batch-reference',
      'user-2',
      'cleanup-mid-batch-restored.jpg',
    );
    const removedThread: ChatThread = {
      ...buildThread('thread-cleanup-mid-batch-reference', 10),
      messages: [firstAttachment, restoredAttachment].map((attachment, index) => ({
        id: `user-${index + 1}`,
        role: 'user' as const,
        content: `Mid-batch cleanup prompt ${index + 1}`,
        createdAt: 10 + index,
        state: 'complete' as const,
        attachments: [attachment],
      })),
    };
    const restoredThread: ChatThread = {
      ...removedThread,
      messages: [removedThread.messages[1]],
      updatedAt: 20,
    };
    const firstDelete = {
      release: null as (() => void) | null,
    };
    (FileSystem.deleteAsync as jest.Mock).mockImplementationOnce(() => new Promise<void>((resolve) => {
      firstDelete.release = resolve;
    }));

    try {
      useChatStore.setState({
        threads: { [removedThread.id]: removedThread },
        activeThreadId: removedThread.id,
      });
      useChatStore.getState().deleteThread(removedThread.id);
      await flushAttachmentCleanup(6);

      expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(1);
      expect(FileSystem.deleteAsync).toHaveBeenCalledWith(firstAttachment.localUri, {
        idempotent: true,
      });

      expect(useChatStore.getState().mergeImportedThreads([restoredThread])).toBe(1);
      firstDelete.release?.();
      firstDelete.release = null;
      await flushAttachmentCleanup(10);

      expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(1);
      expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith(
        restoredAttachment.localUri,
        expect.anything(),
      );
      expect(__getUnreferencedAttachmentCleanupStateForTests()).toEqual(expect.objectContaining({
        candidateCount: 0,
        retryScheduled: false,
      }));
    } finally {
      firstDelete.release?.();
      __resetUnreferencedAttachmentCleanupForTests();
    }
  });

  it('does not let stale queued references protect later orphaned attachments', async () => {
    const firstCleanup = {
      resolve: null as ((results: ChatAttachmentFileCleanupResult[]) => void) | null,
    };
    const cleanupSpy = jest
      .spyOn(chatAttachmentStorageService, 'deleteUnreferencedAttachmentFilesDetailed')
      .mockImplementationOnce(() => new Promise<ChatAttachmentFileCleanupResult[]>((resolve) => {
        firstCleanup.resolve = resolve;
      }))
      .mockImplementation(reportAllAttachmentCleanupCandidatesDeleted);
    const inFlightAttachment = buildStoredAttachment('thread-cleanup-in-flight', 'user-1', 'cleanup-in-flight.jpg');
    const queuedAttachment = buildStoredAttachment('thread-cleanup-queued', 'user-1', 'cleanup-queued.jpg');
    const laterOrphanedAttachment = buildStoredAttachment('thread-cleanup-later', 'user-1', 'cleanup-later.jpg');
    const inFlightThread: ChatThread = {
      ...buildThread('thread-cleanup-in-flight', 10),
      messages: [{
        id: 'user-1',
        role: 'user',
        content: 'In-flight cleanup image prompt',
        createdAt: 10,
        state: 'complete',
        attachments: [inFlightAttachment],
      }],
    };
    const queuedThread: ChatThread = {
      ...buildThread('thread-cleanup-queued', 20),
      messages: [{
        id: 'user-1',
        role: 'user',
        content: 'Queued cleanup image prompt',
        createdAt: 20,
        state: 'complete',
        attachments: [queuedAttachment],
      }],
    };
    const laterOrphanedThread: ChatThread = {
      ...buildThread('thread-cleanup-later', 30),
      messages: [{
        id: 'user-1',
        role: 'user',
        content: 'Later orphaned image prompt',
        createdAt: 30,
        state: 'complete',
        attachments: [laterOrphanedAttachment],
      }],
    };

    try {
      useChatStore.setState({
        threads: {
          [inFlightThread.id]: inFlightThread,
          [queuedThread.id]: queuedThread,
          [laterOrphanedThread.id]: laterOrphanedThread,
        },
        activeThreadId: inFlightThread.id,
      });

      useChatStore.getState().deleteThread(inFlightThread.id);
      await flushAttachmentCleanup();
      expect(cleanupSpy).toHaveBeenCalledTimes(1);

      useChatStore.getState().deleteThread(queuedThread.id);
      useChatStore.getState().deleteThread(laterOrphanedThread.id);
      await flushAttachmentCleanup();
      expect(cleanupSpy).toHaveBeenCalledTimes(1);

      expect(firstCleanup.resolve).toEqual(expect.any(Function));
      firstCleanup.resolve?.([{ localUri: inFlightAttachment.localUri, status: 'deleted' }]);
      firstCleanup.resolve = null;
      await flushAttachmentCleanup(6);

      expect(cleanupSpy).toHaveBeenCalledTimes(2);
      const secondCleanupRequest = cleanupSpy.mock.calls[1][0];
      expect(secondCleanupRequest).toEqual(expect.objectContaining({
        candidateLocalUris: [queuedAttachment.localUri, laterOrphanedAttachment.localUri],
        maxDeletes: 16,
      }));
      expect(secondCleanupRequest.referencedLocalUris).toBeDefined();
      expect(Array.from(secondCleanupRequest.referencedLocalUris!)).not.toContain(laterOrphanedAttachment.localUri);
    } finally {
      if (firstCleanup.resolve) {
        firstCleanup.resolve([{ localUri: inFlightAttachment.localUri, status: 'deleted' }]);
      }
      cleanupSpy.mockRestore();
    }
  });

  it('bounds large unreferenced attachment cleanup batches', async () => {
    const cleanupSpy = jest
      .spyOn(chatAttachmentStorageService, 'deleteUnreferencedAttachmentFilesDetailed')
      .mockImplementation(reportAllAttachmentCleanupCandidatesDeleted);
    const attachments = Array.from({ length: 18 }, (_, index) => (
      buildStoredAttachment('thread-cleanup-large', `user-${index}`, `cleanup-large-${index}.jpg`)
    ));
    const removedThread: ChatThread = {
      ...buildThread('thread-cleanup-large', 10),
      messages: attachments.map((attachment, index) => ({
        id: `user-${index}`,
        role: 'user' as const,
        content: `Large cleanup image prompt ${index}`,
        createdAt: 10 + index,
        state: 'complete' as const,
        attachments: [attachment],
      })),
    };

    useChatStore.setState({
      threads: {
        [removedThread.id]: removedThread,
      },
      activeThreadId: removedThread.id,
    });

    useChatStore.getState().deleteThread(removedThread.id);
    await flushAttachmentCleanup(8);

    expect(cleanupSpy).toHaveBeenCalledTimes(2);
    expect(cleanupSpy.mock.calls[0][0]).toEqual(expect.objectContaining({
      candidateLocalUris: attachments.slice(0, 16).map((attachment) => attachment.localUri),
      maxDeletes: 16,
    }));
    expect(cleanupSpy.mock.calls[1][0]).toEqual(expect.objectContaining({
      candidateLocalUris: attachments.slice(16).map((attachment) => attachment.localUri),
      maxDeletes: 16,
    }));
    cleanupSpy.mockRestore();
  });

  it('retries rejected unreferenced attachment cleanup without dropping failed or remaining candidates', async () => {
    const { callbacks, delays, setTimeoutSpy } = captureScheduledTimeouts();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(100_000);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const cleanupSpy = jest
      .spyOn(chatAttachmentStorageService, 'deleteUnreferencedAttachmentFilesDetailed')
      .mockRejectedValueOnce(new Error('cleanup unavailable'))
      .mockImplementation(reportAllAttachmentCleanupCandidatesDeleted);
    const attachments = Array.from({ length: 18 }, (_, index) => (
      buildStoredAttachment('thread-cleanup-retry', `user-${index}`, `cleanup-retry-${index}.jpg`)
    ));
    const removedThread: ChatThread = {
      ...buildThread('thread-cleanup-retry', 10),
      messages: attachments.map((attachment, index) => ({
        id: `user-${index}`,
        role: 'user' as const,
        content: `Retry cleanup image prompt ${index}`,
        createdAt: 10 + index,
        state: 'complete' as const,
        attachments: [attachment],
      })),
    };

    try {
      useChatStore.setState({
        threads: {
          [removedThread.id]: removedThread,
        },
        activeThreadId: removedThread.id,
      });

      useChatStore.getState().deleteThread(removedThread.id);
      await flushAttachmentCleanup(16);

      expect(cleanupSpy).toHaveBeenCalledTimes(2);
      expect(cleanupSpy.mock.calls[0][0]).toEqual(expect.objectContaining({
        candidateLocalUris: attachments.slice(0, 16).map((attachment) => attachment.localUri),
        maxDeletes: 16,
      }));
      expect(cleanupSpy.mock.calls[1][0]).toEqual(expect.objectContaining({
        candidateLocalUris: attachments.slice(16).map((attachment) => attachment.localUri),
        maxDeletes: 16,
      }));
      expect(callbacks.length).toBeGreaterThanOrEqual(1);
      expect(delays[0]).toBe(1000);

      callbacks.at(-1)?.();
      await flushAttachmentCleanup(10);

      expect(cleanupSpy).toHaveBeenCalledTimes(3);
      expect(cleanupSpy.mock.calls[2][0]).toEqual(expect.objectContaining({
        candidateLocalUris: attachments.slice(0, 16).map((attachment) => attachment.localUri),
        maxDeletes: 16,
      }));
      expect(warnSpy).toHaveBeenCalledWith('[chatStore] Failed to clean up chat attachments', { errorName: 'Error' });
    } finally {
      __resetUnreferencedAttachmentCleanupForTests();
      cleanupSpy.mockRestore();
      warnSpy.mockRestore();
      nowSpy.mockRestore();
      setTimeoutSpy.mockRestore();
    }
  });

  it('retries a candidate when per-file attachment deletion reports an incomplete batch', async () => {
    const { callbacks, delays, setTimeoutSpy } = captureScheduledTimeouts();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(100_000);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const attachment = buildStoredAttachment(
      'thread-cleanup-partial-failure',
      'user-1',
      'cleanup-partial-failure.jpg',
    );
    const removedThread: ChatThread = {
      ...buildThread('thread-cleanup-partial-failure', 10),
      messages: [{
        id: 'user-1',
        role: 'user',
        content: 'Per-file cleanup failure image prompt',
        createdAt: 10,
        state: 'complete',
        attachments: [attachment],
      }],
    };
    (FileSystem.deleteAsync as jest.Mock)
      .mockRejectedValueOnce(new Error('single file delete failed'))
      .mockResolvedValue(undefined);

    try {
      useChatStore.setState({
        threads: { [removedThread.id]: removedThread },
        activeThreadId: removedThread.id,
      });

      useChatStore.getState().deleteThread(removedThread.id);
      await flushAttachmentCleanup(8);

      expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(1);
      expect(FileSystem.deleteAsync).toHaveBeenLastCalledWith(attachment.localUri, {
        idempotent: true,
      });
      expect(callbacks).toHaveLength(1);
      expect(delays).toEqual([1000]);

      callbacks.shift()?.();
      await flushAttachmentCleanup(8);

      expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(2);
      expect(FileSystem.deleteAsync).toHaveBeenLastCalledWith(attachment.localUri, {
        idempotent: true,
      });
      expect(warnSpy).toHaveBeenCalledWith(
        '[chatStore] Failed to clean up chat attachments',
        { errorName: 'AttachmentCleanupIncompleteError', failedCount: 1 },
      );
    } finally {
      __resetUnreferencedAttachmentCleanupForTests();
      warnSpy.mockRestore();
      nowSpy.mockRestore();
      setTimeoutSpy.mockRestore();
    }
  });

  it('retries only the failed candidate after a partial attachment cleanup batch', async () => {
    const { callbacks, setTimeoutSpy } = captureScheduledTimeouts();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(100_000);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const failedAttachment = buildStoredAttachment(
      'thread-cleanup-partial-batch',
      'user-1',
      'cleanup-partial-batch-failed.jpg',
    );
    const deletedAttachment = buildStoredAttachment(
      'thread-cleanup-partial-batch',
      'user-2',
      'cleanup-partial-batch-deleted.jpg',
    );
    let failedAttachmentAttemptCount = 0;
    (FileSystem.deleteAsync as jest.Mock).mockImplementation(async (localUri: string) => {
      if (localUri === failedAttachment.localUri) {
        failedAttachmentAttemptCount += 1;
        if (failedAttachmentAttemptCount === 1) {
          throw new Error('first candidate failed');
        }
      }
    });
    const removedThread: ChatThread = {
      ...buildThread('thread-cleanup-partial-batch', 10),
      messages: [failedAttachment, deletedAttachment].map((attachment, index) => ({
        id: `user-${index + 1}`,
        role: 'user' as const,
        content: `Partial batch prompt ${index}`,
        createdAt: 10 + index,
        state: 'complete' as const,
        attachments: [attachment],
      })),
    };

    try {
      useChatStore.setState({
        threads: { [removedThread.id]: removedThread },
        activeThreadId: removedThread.id,
      });
      useChatStore.getState().deleteThread(removedThread.id);
      await flushAttachmentCleanup(10);

      expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(2);
      expect(__getUnreferencedAttachmentCleanupStateForTests()).toEqual(expect.objectContaining({
        candidateCount: 1,
        failureCounts: [1],
        retryScheduled: true,
      }));

      callbacks.shift()?.();
      await flushAttachmentCleanup(8);

      expect((FileSystem.deleteAsync as jest.Mock).mock.calls.filter(
        ([localUri]) => localUri === failedAttachment.localUri,
      )).toHaveLength(2);
      expect((FileSystem.deleteAsync as jest.Mock).mock.calls.filter(
        ([localUri]) => localUri === deletedAttachment.localUri,
      )).toHaveLength(1);
      expect(__getUnreferencedAttachmentCleanupStateForTests().candidateCount).toBe(0);
    } finally {
      __resetUnreferencedAttachmentCleanupForTests();
      warnSpy.mockRestore();
      nowSpy.mockRestore();
      setTimeoutSpy.mockRestore();
    }
  });

  it('preserves a queued candidate backoff when the same cleanup candidate is merged again', async () => {
    const { callbacks, delays, setTimeoutSpy } = captureScheduledTimeouts();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(100_000);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const cleanupSpy = jest
      .spyOn(chatAttachmentStorageService, 'deleteUnreferencedAttachmentFilesDetailed')
      .mockRejectedValueOnce(new Error('first cleanup failed'))
      .mockImplementation(reportAllAttachmentCleanupCandidatesDeleted);
    const attachment = buildStoredAttachment(
      'thread-cleanup-duplicate-merge',
      'user-1',
      'cleanup-duplicate-merge.jpg',
    );
    const removedThread: ChatThread = {
      ...buildThread('thread-cleanup-duplicate-merge', 10),
      messages: [{
        id: 'user-1',
        role: 'user',
        content: 'Duplicate cleanup candidate prompt',
        createdAt: 10,
        state: 'complete',
        attachments: [attachment],
      }],
    };

    try {
      useChatStore.setState({
        threads: { [removedThread.id]: removedThread },
        activeThreadId: removedThread.id,
      });
      useChatStore.getState().deleteThread(removedThread.id);
      await flushAttachmentCleanup(8);

      expect(cleanupSpy).toHaveBeenCalledTimes(1);
      expect(delays).toEqual([1_000]);
      expect(__getUnreferencedAttachmentCleanupStateForTests()).toEqual(expect.objectContaining({
        candidateCount: 1,
        failureCounts: [1],
        retryScheduled: true,
      }));

      useChatStore.setState({
        threads: { [removedThread.id]: removedThread },
        activeThreadId: removedThread.id,
      });
      useChatStore.getState().deleteThread(removedThread.id);
      await flushAttachmentCleanup(8);

      expect(cleanupSpy).toHaveBeenCalledTimes(1);
      expect(delays).toEqual([1_000]);
      expect(callbacks).toHaveLength(1);
      expect(__getUnreferencedAttachmentCleanupStateForTests()).toEqual(expect.objectContaining({
        candidateCount: 1,
        failureCounts: [1],
        retryScheduled: true,
      }));

      callbacks.shift()?.();
      await flushAttachmentCleanup(8);

      expect(cleanupSpy).toHaveBeenCalledTimes(2);
      expect(cleanupSpy.mock.calls[1][0]).toEqual(expect.objectContaining({
        candidateLocalUris: [attachment.localUri],
      }));
      expect(__getUnreferencedAttachmentCleanupStateForTests().candidateCount).toBe(0);
    } finally {
      __resetUnreferencedAttachmentCleanupForTests();
      cleanupSpy.mockRestore();
      warnSpy.mockRestore();
      nowSpy.mockRestore();
      setTimeoutSpy.mockRestore();
    }
  });

  it('drops a failed cleanup candidate when it becomes referenced during retry delay', async () => {
    const { callbacks, setTimeoutSpy } = captureScheduledTimeouts();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(100_000);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const attachment = buildStoredAttachment(
      'thread-cleanup-referenced-again',
      'user-1',
      'cleanup-referenced-again.jpg',
    );
    const restoredThread: ChatThread = {
      ...buildThread('thread-cleanup-referenced-again', 10),
      messages: [{
        id: 'user-1',
        role: 'user',
        content: 'Restore this attachment before retry',
        createdAt: 10,
        state: 'complete',
        attachments: [attachment],
      }],
    };
    (FileSystem.deleteAsync as jest.Mock)
      .mockRejectedValueOnce(new Error('transient cleanup failure'))
      .mockResolvedValue(undefined);

    try {
      useChatStore.setState({
        threads: { [restoredThread.id]: restoredThread },
        activeThreadId: restoredThread.id,
      });
      useChatStore.getState().deleteThread(restoredThread.id);
      await flushAttachmentCleanup(8);
      expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(1);
      expect(__getUnreferencedAttachmentCleanupStateForTests().candidateCount).toBe(1);

      expect(useChatStore.getState().mergeImportedThreads([restoredThread])).toBe(1);
      expect(__getUnreferencedAttachmentCleanupStateForTests()).toEqual(expect.objectContaining({
        candidateCount: 0,
        retryScheduled: false,
      }));
      callbacks.shift()?.();
      await flushAttachmentCleanup(8);

      expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(1);
      expect(__getUnreferencedAttachmentCleanupStateForTests()).toEqual(expect.objectContaining({
        candidateCount: 0,
        retryScheduled: false,
      }));
    } finally {
      __resetUnreferencedAttachmentCleanupForTests();
      warnSpy.mockRestore();
      nowSpy.mockRestore();
      setTimeoutSpy.mockRestore();
    }
  });

  it('bounds the attachment cleanup queue and ignores an in-flight result after private reset', async () => {
    const { maxQueueEntries } = __getUnreferencedAttachmentCleanupStateForTests();
    let resolveCleanup!: (results: ChatAttachmentFileCleanupResult[]) => void;
    const cleanupSpy = jest
      .spyOn(chatAttachmentStorageService, 'deleteUnreferencedAttachmentFilesDetailed')
      .mockImplementationOnce(() => new Promise<ChatAttachmentFileCleanupResult[]>((resolve) => {
        resolveCleanup = resolve;
      }));
    const attachments = Array.from({ length: maxQueueEntries + 32 }, (_, index) => (
      buildStoredAttachment(
        'thread-cleanup-queue-bound',
        `user-${index}`,
        `cleanup-queue-bound-${index}.jpg`,
      )
    ));
    const removedThread: ChatThread = {
      ...buildThread('thread-cleanup-queue-bound', 10),
      messages: attachments.map((attachment, index) => ({
        id: `user-${index}`,
        role: 'user' as const,
        content: `Bounded cleanup prompt ${index}`,
        createdAt: 10 + index,
        state: 'complete' as const,
        attachments: [attachment],
      })),
    };

    try {
      useChatStore.setState({
        threads: { [removedThread.id]: removedThread },
        activeThreadId: removedThread.id,
      });
      useChatStore.getState().deleteThread(removedThread.id);
      await flushAttachmentCleanup(4);

      expect(cleanupSpy).toHaveBeenCalledTimes(1);
      expect(__getUnreferencedAttachmentCleanupStateForTests().candidateCount).toBe(maxQueueEntries);

      resetChatStoreForPrivateStorageReset();
      expect(__getUnreferencedAttachmentCleanupStateForTests()).toEqual(expect.objectContaining({
        candidateCount: 0,
        retryScheduled: false,
      }));

      resolveCleanup([]);
      await flushAttachmentCleanup(8);
      expect(cleanupSpy).toHaveBeenCalledTimes(1);
      expect(__getUnreferencedAttachmentCleanupStateForTests().candidateCount).toBe(0);
    } finally {
      __resetUnreferencedAttachmentCleanupForTests();
      cleanupSpy.mockRestore();
    }
  });

  it('retains persistently failed attachment cleanup with bounded exponential backoff', async () => {
    const { callbacks, delays, setTimeoutSpy } = captureScheduledTimeouts();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(100_000);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const cleanupSpy = jest
      .spyOn(chatAttachmentStorageService, 'deleteUnreferencedAttachmentFilesDetailed')
      .mockRejectedValue(new Error('cleanup permanently unavailable'));
    const attachment = buildStoredAttachment(
      'thread-cleanup-retry-exhausted',
      'user-1',
      'cleanup-retry-exhausted.jpg',
    );
    const removedThread: ChatThread = {
      ...buildThread('thread-cleanup-retry-exhausted', 10),
      messages: [{
        id: 'user-1',
        role: 'user',
        content: 'Permanently failed cleanup image prompt',
        createdAt: 10,
        state: 'complete',
        attachments: [attachment],
      }],
    };

    try {
      useChatStore.setState({
        threads: { [removedThread.id]: removedThread },
        activeThreadId: removedThread.id,
      });

      useChatStore.getState().deleteThread(removedThread.id);
      await flushAttachmentCleanup(8);

      expect(cleanupSpy).toHaveBeenCalledTimes(1);
      expect(delays).toEqual([1_000]);
      expect(callbacks).toHaveLength(1);

      callbacks.shift()?.();
      await flushAttachmentCleanup(8);

      expect(cleanupSpy).toHaveBeenCalledTimes(2);
      expect(delays).toEqual([1_000, 2_000]);
      expect(callbacks).toHaveLength(1);

      callbacks.shift()?.();
      await flushAttachmentCleanup(8);

      expect(cleanupSpy).toHaveBeenCalledTimes(3);
      expect(delays).toEqual([1_000, 2_000, 4_000]);
      expect(callbacks).toHaveLength(1);
      expect(setTimeoutSpy).toHaveBeenCalledTimes(3);
      expect(warnSpy).toHaveBeenCalledTimes(3);
      expect(__getUnreferencedAttachmentCleanupStateForTests()).toEqual(expect.objectContaining({
        candidateCount: 1,
        failureCounts: [3],
        retryScheduled: true,
      }));

      while (cleanupSpy.mock.calls.length < 10) {
        callbacks.shift()?.();
        await flushAttachmentCleanup(8);
      }

      expect(delays).toEqual([
        1_000,
        2_000,
        4_000,
        8_000,
        16_000,
        32_000,
        64_000,
        128_000,
        256_000,
        300_000,
      ]);
      expect(warnSpy).toHaveBeenCalledTimes(10);
      expect(__getUnreferencedAttachmentCleanupStateForTests()).toEqual(expect.objectContaining({
        candidateCount: 1,
        failureCounts: [10],
        retryScheduled: true,
      }));
    } finally {
      __resetUnreferencedAttachmentCleanupForTests();
      cleanupSpy.mockRestore();
      warnSpy.mockRestore();
      nowSpy.mockRestore();
      setTimeoutSpy.mockRestore();
    }
  });

  it('runs a fresh cleanup candidate without inheriting an older retry backoff', async () => {
    const { callbacks, delays, setTimeoutSpy } = captureScheduledTimeouts();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(100_000);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let firstAttachmentAttemptCount = 0;
    const cleanupSpy = jest
      .spyOn(chatAttachmentStorageService, 'deleteUnreferencedAttachmentFilesDetailed')
      .mockImplementation(async (request) => {
        const candidateLocalUris = Array.from(request.candidateLocalUris);
        if (candidateLocalUris.includes(firstAttachment.localUri)) {
          firstAttachmentAttemptCount += 1;
          if (firstAttachmentAttemptCount <= 3) {
            throw new Error('cleanup unavailable');
          }
        }
        return reportAllAttachmentCleanupCandidatesDeleted(request);
      });
    const firstAttachment = buildStoredAttachment('thread-cleanup-retry-first', 'user-1', 'cleanup-retry-first.jpg');
    const secondAttachment = buildStoredAttachment('thread-cleanup-retry-second', 'user-1', 'cleanup-retry-second.jpg');
    const firstThread: ChatThread = {
      ...buildThread('thread-cleanup-retry-first', 10),
      messages: [{
        id: 'user-1',
        role: 'user',
        content: 'First retry image prompt',
        createdAt: 10,
        state: 'complete',
        attachments: [firstAttachment],
      }],
    };
    const secondThread: ChatThread = {
      ...buildThread('thread-cleanup-retry-second', 20),
      messages: [{
        id: 'user-1',
        role: 'user',
        content: 'Second retry image prompt',
        createdAt: 20,
        state: 'complete',
        attachments: [secondAttachment],
      }],
    };

    try {
      useChatStore.setState({
        threads: {
          [firstThread.id]: firstThread,
          [secondThread.id]: secondThread,
        },
        activeThreadId: firstThread.id,
      });

      useChatStore.getState().deleteThread(firstThread.id);
      await flushAttachmentCleanup(8);
      expect(cleanupSpy).toHaveBeenCalledTimes(1);
      expect(callbacks).toHaveLength(1);
      expect(delays[0]).toBe(1000);

      callbacks.shift()?.();
      await flushAttachmentCleanup(8);
      callbacks.shift()?.();
      await flushAttachmentCleanup(8);
      expect(cleanupSpy).toHaveBeenCalledTimes(3);
      expect(__getUnreferencedAttachmentCleanupStateForTests().failureCounts).toEqual([3]);

      useChatStore.getState().deleteThread(secondThread.id);
      await flushAttachmentCleanup(8);
      expect(cleanupSpy).toHaveBeenCalledTimes(4);
      expect(cleanupSpy.mock.calls[3][0]).toEqual(expect.objectContaining({
        candidateLocalUris: [secondAttachment.localUri],
        maxDeletes: 16,
      }));

      callbacks.at(-1)?.();
      await flushAttachmentCleanup(8);

      expect(cleanupSpy).toHaveBeenCalledTimes(5);
      expect(cleanupSpy.mock.calls[4][0]).toEqual(expect.objectContaining({
        candidateLocalUris: [firstAttachment.localUri],
        maxDeletes: 16,
      }));
      expect(warnSpy).toHaveBeenCalledWith('[chatStore] Failed to clean up chat attachments', { errorName: 'Error' });
    } finally {
      __resetUnreferencedAttachmentCleanupForTests();
      cleanupSpy.mockRestore();
      warnSpy.mockRestore();
      nowSpy.mockRestore();
      setTimeoutSpy.mockRestore();
    }
  });

  it('preserves live attachments dropped by persistence sanitization during store writes', async () => {
    const threadId = useChatStore.getState().createThread({
      modelId: 'author/model-q4',
      presetId: null,
      presetSnapshot: {
        id: null,
        name: 'Default',
        systemPrompt: 'You are helpful.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 1024,
        seed: null,
      },
    });
    const attachments = [
      buildStoredAttachment(threadId, 'user-over-limit', 'limit-kept-1.jpg'),
      buildStoredAttachment(threadId, 'user-over-limit', 'limit-kept-2.jpg'),
      buildStoredAttachment(threadId, 'user-over-limit', 'limit-kept-3.jpg'),
      buildStoredAttachment(threadId, 'user-over-limit', 'limit-kept-4.jpg'),
      buildStoredAttachment(threadId, 'user-over-limit', 'limit-dropped-5.jpg'),
    ];

    useChatStore.getState().appendMessage(threadId, {
      id: 'user-over-limit',
      role: 'user',
      content: 'Image prompt over the persistence limit',
      createdAt: Date.now(),
      state: 'complete',
      attachments,
    });
    await flushAttachmentCleanup();

    const persistedRecord = JSON.parse(storage.getString(getChatThreadStorageKey(threadId)) ?? '{}') as {
      thread?: ChatThread;
    };

    expect(useChatStore.getState().getThread(threadId)?.messages[0]?.attachments).toEqual(attachments);
    expect(persistedRecord.thread?.messages[0]?.attachments).toEqual(attachments.slice(0, 4));
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith(attachments[4].localUri, expect.anything());
    attachments.slice(0, 4).forEach((attachment) => {
      expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith(attachment.localUri, expect.anything());
    });
  });

  it('prunes inactive threads that fall outside the retention window', () => {
    const now = 100 * 24 * 60 * 60 * 1000;
    const staleThread = buildThread('thread-stale', now - 95 * 24 * 60 * 60 * 1000);
    const activeOldThread = buildThread('thread-active', now - 120 * 24 * 60 * 60 * 1000);
    const recentThread = buildThread('thread-recent', now - 10 * 24 * 60 * 60 * 1000);

    useChatStore.setState({
      threads: {
        [staleThread.id]: staleThread,
        [activeOldThread.id]: activeOldThread,
        [recentThread.id]: recentThread,
      },
      activeThreadId: activeOldThread.id,
    });

    const deletedCount = useChatStore.getState().pruneExpiredThreads(90, now);

    expect(deletedCount).toBe(1);
    expect(useChatStore.getState().getThread(staleThread.id)).toBeNull();
    expect(useChatStore.getState().getThread(activeOldThread.id)).toEqual(activeOldThread);
    expect(useChatStore.getState().getThread(recentThread.id)).toEqual(recentThread);
  });

  it('removes expired v2 records during retention cleanup without touching retained threads', () => {
    const now = 100 * 24 * 60 * 60 * 1000;
    const staleThread = buildThread('thread-stale-v2', now - 95 * 24 * 60 * 60 * 1000);
    const recentThread = buildThread('thread-recent-v2', now - 10 * 24 * 60 * 60 * 1000);

    writeChatThreadRecord(storage, staleThread, now);
    writeChatThreadRecord(storage, recentThread, now);
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: recentThread.id,
      threadIds: [staleThread.id, recentThread.id],
      updatedAt: now,
    });
    useChatStore.setState({
      threads: {
        [staleThread.id]: staleThread,
        [recentThread.id]: recentThread,
      },
      activeThreadId: recentThread.id,
    });

    expect(useChatStore.getState().pruneExpiredThreads(90, now)).toBe(1);

    const index = JSON.parse(storage.getString(CHAT_PERSISTENCE_INDEX_KEY) ?? '{}');
    expect(storage.getString(getChatThreadStorageKey(staleThread.id))).toBeUndefined();
    expect(storage.getString(getChatThreadStorageKey(recentThread.id))).toContain(recentThread.title);
    expect(index.threadIds).toEqual([recentThread.id]);
    expect(index.revision).toEqual(expect.any(Number));
    expect(storage.getString(CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY)).toBeUndefined();
  });

  it('cleans attachment files removed by retention pruning', async () => {
    const now = 100 * 24 * 60 * 60 * 1000;
    const staleAttachment = buildStoredAttachment('thread-stale-attachment', 'user-1', 'retention-stale.jpg');
    const recentAttachment = buildStoredAttachment('thread-recent-attachment', 'user-1', 'retention-recent.jpg');
    const staleThread: ChatThread = {
      ...buildThread('thread-stale-attachment', now - 95 * 24 * 60 * 60 * 1000),
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'Expired image prompt',
          createdAt: now - 95 * 24 * 60 * 60 * 1000,
          state: 'complete',
          attachments: [staleAttachment],
        },
      ],
    };
    const recentThread: ChatThread = {
      ...buildThread('thread-recent-attachment', now - 10 * 24 * 60 * 60 * 1000),
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'Recent image prompt',
          createdAt: now - 10 * 24 * 60 * 60 * 1000,
          state: 'complete',
          attachments: [recentAttachment],
        },
      ],
    };

    useChatStore.setState({
      threads: {
        [staleThread.id]: staleThread,
        [recentThread.id]: recentThread,
      },
      activeThreadId: recentThread.id,
    });

    expect(useChatStore.getState().pruneExpiredThreads(90, now)).toBe(1);
    await flushAttachmentCleanup();

    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(staleAttachment.localUri, {
      idempotent: true,
    });
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith(recentAttachment.localUri, expect.anything());
  });

  it('moves activeThreadId to the most recent remaining thread when pruning runs with a missing activeThreadId', () => {
    const now = 100 * 24 * 60 * 60 * 1000;
    const staleThread = buildThread('thread-stale', now - 95 * 24 * 60 * 60 * 1000);
    const recentThread = buildThread('thread-recent', now - 10 * 24 * 60 * 60 * 1000);

    useChatStore.setState({
      threads: {
        [staleThread.id]: staleThread,
        [recentThread.id]: recentThread,
      },
      activeThreadId: 'missing-thread',
    });

    const deletedCount = useChatStore.getState().pruneExpiredThreads(90, now);

    expect(deletedCount).toBe(1);
    expect(useChatStore.getState().activeThreadId).toBe(recentThread.id);
  });

  it('selects the most recent imported thread when merging into an empty store', () => {
    const importedA = buildThread('import-a', 10);
    const importedB = buildThread('import-b', 20);

    const importedCount = useChatStore.getState().mergeImportedThreads([importedA, importedB]);

    expect(importedCount).toBe(2);
    expect(useChatStore.getState().activeThreadId).toBe(importedB.id);
  });

  it('rehydrates to the most recent thread when persisted activeThreadId is missing', async () => {
    const older = buildThread('thread-older', 10);
    const newer = buildThread('thread-newer', 20);

    storage.set(
      'chat-store',
      JSON.stringify({
        state: {
          threads: {
            [older.id]: older,
            [newer.id]: newer,
          },
          activeThreadId: 'missing-thread',
        },
        version: 0,
      }),
    );

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().activeThreadId).toBe(newer.id);
  });

  it('migrates legacy hydrated threads by adding activeModelId and per-message model metadata', async () => {
    const legacyThread: ChatThread = {
      ...buildThread('thread-legacy', 10),
      messages: [
        {
          id: 'legacy-user-1',
          role: 'user',
          content: 'Legacy prompt',
          createdAt: 10,
          state: 'complete',
        },
        {
          id: 'legacy-assistant-1',
          role: 'assistant',
          content: 'Legacy reply',
          createdAt: 11,
          state: 'complete',
        },
      ],
    };

    storage.set(
      'chat-store',
      JSON.stringify({
        state: {
          threads: {
            [legacyThread.id]: legacyThread,
          },
          activeThreadId: legacyThread.id,
        },
        version: 0,
      }),
    );

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    const hydrated = useChatStore.getState().getThread(legacyThread.id);

    expect(hydrated?.activeModelId).toBe(legacyThread.modelId);
    expect(hydrated?.messages).toEqual([
      expect.objectContaining({
        id: 'legacy-user-1',
        kind: 'message',
        modelId: legacyThread.modelId,
      }),
      expect.objectContaining({
        id: 'legacy-assistant-1',
        kind: 'message',
        modelId: legacyThread.modelId,
      }),
    ]);
    expect(storage.getString(getChatThreadStorageKey(legacyThread.id))).toContain('Legacy prompt');
    expect(storage.getString('chat-store')).not.toContain('Legacy prompt');
  });

  it('migrates valid legacy threads while isolating invalid legacy records', async () => {
    const validThread = buildThread('thread-valid-legacy', 20);

    storage.set(
      'chat-store',
      JSON.stringify({
        state: {
          threads: {
            [validThread.id]: validThread,
            'thread-invalid-legacy': {
              id: 'thread-invalid-legacy',
              messages: [],
            },
          },
          activeThreadId: 'thread-invalid-legacy',
        },
        version: 0,
      }),
    );

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    const index = JSON.parse(storage.getString(CHAT_PERSISTENCE_INDEX_KEY) ?? '{}');

    expect(useChatStore.getState().getThread(validThread.id)).toEqual(
      expect.objectContaining({ id: validThread.id }),
    );
    expect(useChatStore.getState().getThread('thread-invalid-legacy')).toBeNull();
    expect(useChatStore.getState().activeThreadId).toBe(validThread.id);
    expect(storage.getString(getChatThreadStorageKey(validThread.id))).toContain(validThread.title);
    expect(index.threadIds).toEqual([validThread.id]);
    expect(index.corruptThreadIds).toEqual(['thread-invalid-legacy']);
  });

  it('does not let an empty v2 index shadow a valid legacy snapshot during migration', async () => {
    const validThread = buildThread('thread-shadowed-legacy', 30);

    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: null,
      threadIds: [],
      updatedAt: 1,
    });
    storage.set(
      'chat-store',
      JSON.stringify({
        state: {
          threads: {
            [validThread.id]: validThread,
          },
          activeThreadId: validThread.id,
        },
        version: 0,
      }),
    );

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().getThread(validThread.id)).toEqual(
      expect.objectContaining({ id: validThread.id }),
    );
    expect(storage.getString(getChatThreadStorageKey(validThread.id))).toContain(validThread.title);
  });

  it('treats a cleared v2 tombstone as authoritative over orphan records and stale legacy payloads', async () => {
    const orphanThread = buildThread('thread-cleared-orphan', 35);
    const clearedAt = 40;

    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: null,
      threadIds: [],
      updatedAt: clearedAt,
      clearedAt,
    });
    writeChatThreadRecord(storage, orphanThread, 39);
    storage.set(
      'chat-store',
      JSON.stringify({
        state: {
          threads: {
            [orphanThread.id]: orphanThread,
          },
          activeThreadId: orphanThread.id,
        },
        version: 0,
      }),
    );

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    const index = readPersistedChatIndex();
    expect(useChatStore.getState().getThread(orphanThread.id)).toBeNull();
    expect(useChatStore.getState().activeThreadId).toBeNull();
    expect(index.threadIds).toEqual([]);
    expect(index.clearedAt).toBe(clearedAt);
    expect(storage.getString('chat-store')).toBeUndefined();
    expect(storage.getString(getChatThreadStorageKey(orphanThread.id))).toBeUndefined();
  });

  it('recovers v2 records written after a clear tombstone without resurrecting stale payloads', async () => {
    const staleBeforeClearThread = buildThread('thread-before-clear', 35);
    const equalToClearThread = buildThread('thread-equal-clear', 40);
    const recoveredAfterClearThread = buildThread('thread-after-clear', 45);
    const staleLegacyThread = buildThread('thread-stale-legacy-after-clear', 30);
    const clearedAt = 40;

    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: null,
      threadIds: [],
      updatedAt: clearedAt,
      clearedAt,
    });
    writeChatThreadRecord(storage, staleBeforeClearThread, clearedAt - 1);
    writeChatThreadRecord(storage, equalToClearThread, clearedAt);
    writeChatThreadRecord(storage, recoveredAfterClearThread, clearedAt + 1);
    storage.set(
      'chat-store',
      JSON.stringify({
        state: {
          threads: {
            [staleLegacyThread.id]: staleLegacyThread,
          },
          activeThreadId: staleLegacyThread.id,
        },
        version: 0,
      }),
    );

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    const index = readPersistedChatIndex();
    expect(useChatStore.getState().getThread(staleBeforeClearThread.id)).toBeNull();
    expect(useChatStore.getState().getThread(equalToClearThread.id)).toBeNull();
    expect(useChatStore.getState().getThread(staleLegacyThread.id)).toBeNull();
    expect(useChatStore.getState().getThread(recoveredAfterClearThread.id)).toEqual(
      expect.objectContaining({ id: recoveredAfterClearThread.id }),
    );
    expect(useChatStore.getState().activeThreadId).toBe(recoveredAfterClearThread.id);
    expect(index.threadIds).toEqual([recoveredAfterClearThread.id]);
    expect(index.activeThreadId).toBe(recoveredAfterClearThread.id);
    expect(index.clearedAt).toBeUndefined();
    expect(storage.getString('chat-store') ?? '').not.toContain(staleLegacyThread.title);
    expect(storage.getString(getChatThreadStorageKey(staleBeforeClearThread.id))).toBeUndefined();
    expect(storage.getString(getChatThreadStorageKey(equalToClearThread.id))).toBeUndefined();
    expect(storage.getString(getChatThreadStorageKey(recoveredAfterClearThread.id))).toContain(recoveredAfterClearThread.title);
  });

  it('persists post-clear mutations after the tombstone timestamp when they share the same millisecond', async () => {
    const clearedAt = 40;
    const originalDateNow = Date.now;
    let threadId = '';

    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: null,
      threadIds: [],
      updatedAt: clearedAt,
      clearedAt,
    });

    Date.now = jest.fn(() => clearedAt);
    try {
      threadId = useChatStore.getState().createThread({
        modelId: 'author/model-q4',
        presetId: null,
        presetSnapshot: {
          id: null,
          name: 'Default',
          systemPrompt: 'You are helpful.',
        },
        paramsSnapshot: {
          temperature: 0.7,
          topP: 0.9,
          maxTokens: 1024,
          seed: null,
        },
      });
    } finally {
      Date.now = originalDateNow;
    }

    const record = JSON.parse(storage.getString(getChatThreadStorageKey(threadId)) ?? '{}') as { persistedAt?: unknown };
    expect(record.persistedAt).toBe(clearedAt + 1);

    // Simulate a crash after the thread record write but before the index rewrite
    // replaced the clear tombstone.
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: null,
      threadIds: [],
      updatedAt: clearedAt,
      clearedAt,
    });

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    const index = readPersistedChatIndex();
    expect(useChatStore.getState().getThread(threadId)).toEqual(
      expect.objectContaining({ id: threadId }),
    );
    expect(useChatStore.getState().activeThreadId).toBe(threadId);
    expect(index.threadIds).toEqual([threadId]);
    expect(index.clearedAt).toBeUndefined();
  });

  it('does not resurrect same-millisecond records when a later clear crashes before record removal', async () => {
    const firstClearedAt = 40;
    const originalDateNow = Date.now;
    let threadId = '';
    let rawRecord: string | undefined;

    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: null,
      threadIds: [],
      updatedAt: firstClearedAt,
      clearedAt: firstClearedAt,
    });

    Date.now = jest.fn(() => firstClearedAt);
    try {
      threadId = useChatStore.getState().createThread({
        modelId: 'author/model-q4',
        presetId: null,
        presetSnapshot: {
          id: null,
          name: 'Default',
          systemPrompt: 'You are helpful.',
        },
        paramsSnapshot: {
          temperature: 0.7,
          topP: 0.9,
          maxTokens: 1024,
          seed: null,
        },
      });
      rawRecord = storage.getString(getChatThreadStorageKey(threadId));

      expect(useChatStore.getState().clearAllThreads()).toBe(1);
    } finally {
      Date.now = originalDateNow;
    }

    const secondClearIndex = readPersistedChatIndex();
    expect(secondClearIndex.clearedAt).toBe(firstClearedAt + 2);
    expect(rawRecord).toBeTruthy();

    // Simulate a crash after the second clear tombstone was written but before
    // the old thread record was removed.
    storage.set(getChatThreadStorageKey(threadId), rawRecord ?? '');

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    const index = readPersistedChatIndex();
    expect(useChatStore.getState().getThread(threadId)).toBeNull();
    expect(useChatStore.getState().activeThreadId).toBeNull();
    expect(index.threadIds).toEqual([]);
    expect(index.clearedAt).toBe(firstClearedAt + 2);
    expect(storage.getString(getChatThreadStorageKey(threadId))).toBeUndefined();
  });

  it('keeps newer corrupt v2 records isolated after a clear tombstone', async () => {
    const staleLegacyThread = buildThread('thread-legacy-behind-corrupt-clear', 30);
    const corruptThreadId = 'thread-corrupt-after-clear';
    const corruptAttachment = buildStoredAttachment(corruptThreadId, 'user-1', 'corrupt-after-clear.jpg');
    const clearedAt = 40;

    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: null,
      threadIds: [],
      updatedAt: clearedAt,
      clearedAt,
    });
    storage.set(getChatThreadStorageKey(corruptThreadId), JSON.stringify({
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      thread: {
        id: corruptThreadId,
        messages: [
          {
            id: 'user-1',
            attachments: [corruptAttachment],
          },
        ],
      },
      persistedAt: clearedAt + 1,
    }));
    storage.set(
      'chat-store',
      JSON.stringify({
        state: {
          threads: {
            [staleLegacyThread.id]: staleLegacyThread,
          },
          activeThreadId: staleLegacyThread.id,
        },
        version: 0,
      }),
    );

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();
    await flushAttachmentCleanup();

    const index = readPersistedChatIndex();
    expect(useChatStore.getState().getThread(staleLegacyThread.id)).toBeNull();
    expect(useChatStore.getState().activeThreadId).toBeNull();
    expect(index.threadIds).toEqual([]);
    expect(index.activeThreadId).toBeNull();
    expect(index.clearedAt).toBeUndefined();
    expect(index.corruptThreadIds).toEqual([corruptThreadId]);
    expect(storage.getString('chat-store')).toBeUndefined();
    expect(storage.getString(getChatThreadStorageKey(corruptThreadId))).toContain(corruptThreadId);
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(corruptAttachment.localUri, {
      idempotent: true,
    });
  });

  it('recovers v2 thread records when the v2 index is missing', async () => {
    const recoveredThread = buildThread('thread-indexless-v2', 36);

    writeChatThreadRecord(storage, recoveredThread, 36);

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    const index = readPersistedChatIndex();
    expect(useChatStore.getState().getThread(recoveredThread.id)).toEqual(
      expect.objectContaining({ id: recoveredThread.id }),
    );
    expect(useChatStore.getState().activeThreadId).toBe(recoveredThread.id);
    expect(index.threadIds).toEqual([recoveredThread.id]);
    expect(index.clearedAt).toBeUndefined();
  });

  it('recovers v2 thread records when a non-tombstone v2 index is stale', async () => {
    const recoveredThread = buildThread('thread-stale-index-v2', 37);

    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: null,
      threadIds: [],
      updatedAt: 1,
    });
    writeChatThreadRecord(storage, recoveredThread, 37);

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    const index = readPersistedChatIndex();
    expect(useChatStore.getState().getThread(recoveredThread.id)).toEqual(
      expect.objectContaining({ id: recoveredThread.id }),
    );
    expect(useChatStore.getState().activeThreadId).toBe(recoveredThread.id);
    expect(index.threadIds).toEqual([recoveredThread.id]);
    expect(index.clearedAt).toBeUndefined();
  });

  it('merges legacy-only threads into existing v2 records during partial migration recovery', async () => {
    const v2Thread = {
      ...buildThread('thread-v2-partial', 40),
      title: 'V2 title should win',
    };
    const legacyDuplicate = {
      ...v2Thread,
      title: 'Legacy duplicate should not overwrite v2',
      updatedAt: 10,
    };
    const legacyOnlyThread = buildThread('thread-legacy-only-after-partial', 50);

    writeChatThreadRecord(storage, v2Thread, 40);
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: v2Thread.id,
      threadIds: [v2Thread.id],
      updatedAt: 40,
    });
    storage.set(
      'chat-store',
      JSON.stringify({
        state: {
          threads: {
            [legacyDuplicate.id]: legacyDuplicate,
            [legacyOnlyThread.id]: legacyOnlyThread,
          },
          activeThreadId: legacyOnlyThread.id,
        },
        version: 0,
      }),
    );

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    const index = JSON.parse(storage.getString(CHAT_PERSISTENCE_INDEX_KEY) ?? '{}');

    expect(useChatStore.getState().getThread(v2Thread.id)).toEqual(
      expect.objectContaining({
        id: v2Thread.id,
        title: 'V2 title should win',
      }),
    );
    expect(useChatStore.getState().getThread(legacyOnlyThread.id)).toEqual(
      expect.objectContaining({ id: legacyOnlyThread.id }),
    );
    expect(useChatStore.getState().activeThreadId).toBe(legacyOnlyThread.id);
    expect(storage.getString(getChatThreadStorageKey(legacyOnlyThread.id))).toContain(legacyOnlyThread.title);
    expect(index.threadIds).toEqual([v2Thread.id, legacyOnlyThread.id]);
    expect(storage.getString('chat-store')).not.toContain(legacyOnlyThread.title);
  });

  it('keeps the v2 active thread when a partial migration has a stale legacy active id', async () => {
    const v2Thread = buildThread('thread-v2-active-after-partial', 40);
    const newerLegacyOnlyThread = buildThread('thread-newer-legacy-only-after-partial', 60);

    writeChatThreadRecord(storage, v2Thread, 40);
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: v2Thread.id,
      threadIds: [v2Thread.id],
      updatedAt: 40,
    });
    storage.set(
      'chat-store',
      JSON.stringify({
        state: {
          threads: {
            [newerLegacyOnlyThread.id]: newerLegacyOnlyThread,
          },
          activeThreadId: 'missing-legacy-thread',
        },
        version: 0,
      }),
    );

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().getThread(newerLegacyOnlyThread.id)).toEqual(
      expect.objectContaining({ id: newerLegacyOnlyThread.id }),
    );
    expect(useChatStore.getState().activeThreadId).toBe(v2Thread.id);
  });

  it('hydrates valid v2 records when the legacy chat-store value is malformed', async () => {
    const validThread = buildThread('thread-v2-with-broken-legacy-anchor', 60);

    writeChatThreadRecord(storage, validThread, 60);
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: validThread.id,
      threadIds: [validThread.id],
      updatedAt: 60,
    });
    storage.set('chat-store', '{broken legacy json');

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().getThread(validThread.id)).toEqual(
      expect.objectContaining({ id: validThread.id }),
    );
    expect(useChatStore.getState().activeThreadId).toBe(validThread.id);
    expect(storage.getString('chat-store')).toBe('{broken legacy json');
  });

  it('hydrates valid v2 records when another v2 record is corrupt', async () => {
    const validThread = buildThread('thread-valid-v2', 20);

    writeChatThreadRecord(storage, validThread, 20);
    storage.set(
      getChatThreadStorageKey('thread-corrupt-v2'),
      JSON.stringify({
        schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
        thread: {
          id: 'thread-corrupt-v2',
        },
        persistedAt: 21,
      }),
    );
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: 'thread-corrupt-v2',
      threadIds: [validThread.id, 'thread-corrupt-v2'],
      updatedAt: 22,
    });

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    const index = JSON.parse(storage.getString(CHAT_PERSISTENCE_INDEX_KEY) ?? '{}');

    expect(useChatStore.getState().getThread(validThread.id)).toEqual(
      expect.objectContaining({ id: validThread.id }),
    );
    expect(useChatStore.getState().getThread('thread-corrupt-v2')).toBeNull();
    expect(useChatStore.getState().activeThreadId).toBe(validThread.id);
    expect(storage.getString(getChatThreadStorageKey('thread-corrupt-v2'))).toContain('thread-corrupt-v2');
    expect(index.threadIds).toEqual([validThread.id]);
    expect(index.corruptThreadIds).toEqual(['thread-corrupt-v2']);
  });

  it('cleans unreferenced attachment files from corrupt persisted thread recovery', async () => {
    const sharedAttachment = buildStoredAttachment('thread-valid-shared', 'user-1', 'shared-corrupt.jpg');
    const corruptOnlyAttachment = buildStoredAttachment('thread-corrupt-with-image', 'user-1', 'corrupt-only.jpg');
    const validThread: ChatThread = {
      ...buildThread('thread-valid-shared', 20),
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'Still references shared image',
          createdAt: 20,
          state: 'complete',
          attachments: [sharedAttachment],
        },
      ],
    };

    writeChatThreadRecord(storage, validThread, 20);
    storage.set(
      getChatThreadStorageKey('thread-corrupt-with-image'),
      JSON.stringify({
        schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
        thread: {
          id: 'thread-corrupt-with-image',
          messages: [
            {
              id: 'user-1',
              attachments: [sharedAttachment, corruptOnlyAttachment],
            },
          ],
        },
        persistedAt: 21,
      }),
    );
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: 'thread-corrupt-with-image',
      threadIds: [validThread.id, 'thread-corrupt-with-image'],
      updatedAt: 22,
    });

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();
    await flushAttachmentCleanup();

    expect(useChatStore.getState().getThread(validThread.id)).toEqual(
      expect.objectContaining({ id: validThread.id }),
    );
    expect(useChatStore.getState().getThread('thread-corrupt-with-image')).toBeNull();
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(corruptOnlyAttachment.localUri, {
      idempotent: true,
    });
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith(sharedAttachment.localUri, expect.anything());
  });

  it('cleans attachment files dropped by hydration sanitization', async () => {
    const validAttachment = buildStoredAttachment('thread-sanitized-attachments', 'user-1', 'kept.jpg');
    const droppedAttachment = {
      ...buildStoredAttachment('thread-sanitized-attachments', 'user-1', 'dropped.txt'),
      mediaType: 'text/plain',
    };
    const thread: ChatThread = {
      ...buildThread('thread-sanitized-attachments', 20),
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'Hydrate attachments',
          createdAt: 20,
          state: 'complete',
          attachments: [validAttachment, droppedAttachment],
        },
      ],
    };

    storage.set(getChatThreadStorageKey(thread.id), JSON.stringify({
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      thread,
      persistedAt: 20,
    }));
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: thread.id,
      threadIds: [thread.id],
      updatedAt: 21,
    });

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();
    await flushAttachmentCleanup();

    expect(useChatStore.getState().getThread(thread.id)?.messages[0]?.attachments).toEqual([validAttachment]);
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(droppedAttachment.localUri, {
      idempotent: true,
    });
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith(validAttachment.localUri, expect.anything());
  });

  it('reconciles the attachment directory on hydration with no referenced attachments', async () => {
    const reconcileSpy = jest
      .spyOn(chatAttachmentStorageService, 'reconcileAttachmentDirectory')
      .mockResolvedValue({
        deletedCount: 1,
        attemptedDeleteCount: 1,
        candidateCount: 1,
        hasMoreCandidates: false,
      });

    try {
      useChatStore.setState({ threads: {}, activeThreadId: null });
      await useChatStore.persist.rehydrate();
      await flushAttachmentCleanup();

      expect(reconcileSpy).toHaveBeenCalledTimes(1);
      expect(Array.from(reconcileSpy.mock.calls[0]?.[0] as Iterable<string>)).toEqual([]);
      expect(reconcileSpy.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
        preserveDraftsCreatedAtOrAfter: expect.any(Number),
        maxCandidates: 16,
        maxDeletes: 16,
      }));
    } finally {
      reconcileSpy.mockRestore();
    }
  });

  it('passes referenced attachment uris to hydration directory reconciliation', async () => {
    const referencedAttachment = buildStoredAttachment('thread-reconcile-referenced', 'user-1', 'preserve.jpg');
    const thread: ChatThread = {
      ...buildThread('thread-reconcile-referenced', 20),
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'Preserve this hydrated attachment',
          createdAt: 20,
          state: 'complete',
          attachments: [referencedAttachment],
        },
      ],
    };
    const reconcileSpy = jest
      .spyOn(chatAttachmentStorageService, 'reconcileAttachmentDirectory')
      .mockResolvedValue({
        deletedCount: 0,
        attemptedDeleteCount: 0,
        candidateCount: 0,
        hasMoreCandidates: false,
      });

    try {
      writeChatThreadRecord(storage, thread, 20);
      writeChatPersistenceIndex(storage, {
        schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
        activeThreadId: thread.id,
        threadIds: [thread.id],
        updatedAt: 21,
      });

      useChatStore.setState({ threads: {}, activeThreadId: null });
      await useChatStore.persist.rehydrate();
      await flushAttachmentCleanup();

      expect(reconcileSpy).toHaveBeenCalledTimes(1);
      expect(new Set(reconcileSpy.mock.calls[0]?.[0] as Iterable<string>)).toEqual(
        new Set([referencedAttachment.localUri]),
      );
      expect(reconcileSpy.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
        preserveDraftsCreatedAtOrAfter: expect.any(Number),
        maxCandidates: 16,
        maxDeletes: 16,
      }));
    } finally {
      reconcileSpy.mockRestore();
    }
  });

  it('schedules a later hydration directory reconciliation pass when candidates remain', async () => {
    const referencedAttachment = buildStoredAttachment('thread-reconcile-reschedule', 'user-1', 'keep.jpg');
    const thread: ChatThread = {
      ...buildThread('thread-reconcile-reschedule', 20),
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'Preserve referenced attachment during rescheduled cleanup',
          createdAt: 20,
          state: 'complete',
          attachments: [referencedAttachment],
        },
      ],
    };
    const reconcileSpy = jest
      .spyOn(chatAttachmentStorageService, 'reconcileAttachmentDirectory')
      .mockResolvedValueOnce({
        deletedCount: 16,
        attemptedDeleteCount: 16,
        candidateCount: 17,
        hasMoreCandidates: true,
      })
      .mockResolvedValue({
        deletedCount: 0,
        attemptedDeleteCount: 0,
        candidateCount: 0,
        hasMoreCandidates: false,
      });
    const { callbacks, delays, setTimeoutSpy } = captureScheduledTimeouts();

    try {
      writeChatThreadRecord(storage, thread, 20);
      writeChatPersistenceIndex(storage, {
        schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
        activeThreadId: thread.id,
        threadIds: [thread.id],
        updatedAt: 21,
      });

      useChatStore.setState({ threads: {}, activeThreadId: null });
      await useChatStore.persist.rehydrate();
      await flushAttachmentCleanup();

      expect(reconcileSpy).toHaveBeenCalledTimes(1);
      reconcileSpy.mock.calls.forEach(([referencedLocalUris, options]) => {
        expect(new Set(referencedLocalUris as Iterable<string>)).toEqual(
          new Set([referencedAttachment.localUri]),
        );
        expect(options).toEqual(expect.objectContaining({
          preserveDraftsCreatedAtOrAfter: expect.any(Number),
          maxCandidates: 16,
          maxDeletes: 16,
        }));
      });
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(delays[0]).toBe(1_000);
    } finally {
      const pendingRetry = callbacks.shift();
      if (pendingRetry) {
        pendingRetry();
        await flushAttachmentCleanup();
      }
      setTimeoutSpy.mockRestore();
      reconcileSpy.mockRestore();
    }
  });

  it('keeps the original draft cutoff across hydration directory reconciliation retries', async () => {
    let now = 100;
    const dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    (FileSystem.readDirectoryAsync as jest.Mock)
      .mockResolvedValueOnce(Array.from({ length: 17 }, (_, index) => `orphan-${index}.jpg`))
      .mockResolvedValueOnce(['draft-150-between.jpg']);
    const setTimeoutSpy = jest
      .spyOn(global, 'setTimeout')
      .mockImplementation((callback) => {
        now = 200;
        (callback as () => void)();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      });

    try {
      useChatStore.setState({ threads: {}, activeThreadId: null });
      await useChatStore.persist.rehydrate();
      await flushAttachmentCleanup(80);

      expect(FileSystem.readDirectoryAsync).toHaveBeenCalledTimes(2);
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(16);
      expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith(
        'test-dir/chat-attachments/draft-150-between.jpg',
        expect.anything(),
      );
    } finally {
      setTimeoutSpy.mockRestore();
      dateNowSpy.mockRestore();
    }
  });

  it('retries zero-progress hydration directory reconciliation only within a bounded budget', async () => {
    const reconcileSpy = jest
      .spyOn(chatAttachmentStorageService, 'reconcileAttachmentDirectory')
      .mockResolvedValue({
        deletedCount: 0,
        attemptedDeleteCount: 16,
        candidateCount: 17,
        hasMoreCandidates: true,
      });
    const { callbacks, delays, setTimeoutSpy } = captureScheduledTimeouts();

    try {
      useChatStore.setState({ threads: {}, activeThreadId: null });
      await useChatStore.persist.rehydrate();
      await flushAttachmentCleanup();

      expect(reconcileSpy).toHaveBeenCalledTimes(1);
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(delays[0]).toBe(1_000);

      callbacks.shift()?.();
      await flushAttachmentCleanup();

      expect(reconcileSpy).toHaveBeenCalledTimes(2);
      expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
      expect(delays[1]).toBe(2_000);

      callbacks.shift()?.();
      await flushAttachmentCleanup();

      expect(reconcileSpy).toHaveBeenCalledTimes(3);
      expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
      expect(callbacks).toHaveLength(0);
    } finally {
      while (callbacks.length > 0) {
        callbacks.shift()?.();
        await flushAttachmentCleanup();
      }
      setTimeoutSpy.mockRestore();
      reconcileSpy.mockRestore();
    }
  });

  it('retries transient final-batch hydration directory delete failures', async () => {
    const reconcileSpy = jest
      .spyOn(chatAttachmentStorageService, 'reconcileAttachmentDirectory')
      .mockResolvedValueOnce({
        deletedCount: 0,
        attemptedDeleteCount: 2,
        candidateCount: 2,
        hasMoreCandidates: false,
      })
      .mockResolvedValue({
        deletedCount: 2,
        attemptedDeleteCount: 2,
        candidateCount: 2,
        hasMoreCandidates: false,
      });
    const { callbacks, delays, setTimeoutSpy } = captureScheduledTimeouts();

    try {
      useChatStore.setState({ threads: {}, activeThreadId: null });
      await useChatStore.persist.rehydrate();
      await flushAttachmentCleanup();

      expect(reconcileSpy).toHaveBeenCalledTimes(1);
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(delays[0]).toBe(1_000);

      callbacks.shift()?.();
      await flushAttachmentCleanup();

      expect(reconcileSpy).toHaveBeenCalledTimes(2);
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    } finally {
      while (callbacks.length > 0) {
        callbacks.shift()?.();
        await flushAttachmentCleanup();
      }
      setTimeoutSpy.mockRestore();
      reconcileSpy.mockRestore();
    }
  });

  it('deduplicates hydration directory reconciliation retry timers across repeated rehydrate', async () => {
    const reconcileSpy = jest
      .spyOn(chatAttachmentStorageService, 'reconcileAttachmentDirectory')
      .mockResolvedValueOnce({
        deletedCount: 0,
        attemptedDeleteCount: 16,
        candidateCount: 17,
        hasMoreCandidates: true,
      })
      .mockResolvedValue({
        deletedCount: 0,
        attemptedDeleteCount: 0,
        candidateCount: 0,
        hasMoreCandidates: false,
      });
    const { callbacks, setTimeoutSpy } = captureScheduledTimeouts();

    try {
      useChatStore.setState({ threads: {}, activeThreadId: null });
      await useChatStore.persist.rehydrate();
      await flushAttachmentCleanup();

      expect(reconcileSpy).toHaveBeenCalledTimes(1);
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(callbacks).toHaveLength(1);

      await useChatStore.persist.rehydrate();
      await flushAttachmentCleanup();

      expect(reconcileSpy).toHaveBeenCalledTimes(1);
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(callbacks).toHaveLength(1);

      callbacks.shift()?.();
      await flushAttachmentCleanup();

      expect(reconcileSpy).toHaveBeenCalledTimes(2);
    } finally {
      while (callbacks.length > 0) {
        callbacks.shift()?.();
        await flushAttachmentCleanup();
      }
      setTimeoutSpy.mockRestore();
      reconcileSpy.mockRestore();
    }
  });

  it('uses current store threads when hydration directory reconciliation retries', async () => {
    const firstAttachment = buildStoredAttachment('thread-reconcile-first', 'user-1', 'first.jpg');
    const secondAttachment = buildStoredAttachment('thread-reconcile-second', 'user-1', 'second.jpg');
    const firstThread: ChatThread = {
      ...buildThread('thread-reconcile-first', 20),
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'First referenced attachment',
          createdAt: 20,
          state: 'complete',
          attachments: [firstAttachment],
        },
      ],
    };
    const secondThread: ChatThread = {
      ...buildThread('thread-reconcile-second', 30),
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'Second referenced attachment',
          createdAt: 30,
          state: 'complete',
          attachments: [secondAttachment],
        },
      ],
    };
    const reconcileSpy = jest
      .spyOn(chatAttachmentStorageService, 'reconcileAttachmentDirectory')
      .mockResolvedValueOnce({
        deletedCount: 16,
        attemptedDeleteCount: 16,
        candidateCount: 17,
        hasMoreCandidates: true,
      })
      .mockResolvedValue({
        deletedCount: 0,
        attemptedDeleteCount: 0,
        candidateCount: 0,
        hasMoreCandidates: false,
      });
    const { callbacks, setTimeoutSpy } = captureScheduledTimeouts();

    try {
      writeChatThreadRecord(storage, firstThread, 20);
      writeChatPersistenceIndex(storage, {
        schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
        activeThreadId: firstThread.id,
        threadIds: [firstThread.id],
        updatedAt: 21,
      });

      useChatStore.setState({ threads: {}, activeThreadId: null });
      await useChatStore.persist.rehydrate();
      await flushAttachmentCleanup();

      expect(new Set(reconcileSpy.mock.calls[0]?.[0] as Iterable<string>)).toEqual(
        new Set([firstAttachment.localUri]),
      );
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);

      useChatStore.setState({
        threads: { [secondThread.id]: secondThread },
        activeThreadId: secondThread.id,
      });

      callbacks.shift()?.();
      await flushAttachmentCleanup();

      expect(reconcileSpy).toHaveBeenCalledTimes(2);
      expect(new Set(reconcileSpy.mock.calls[1]?.[0] as Iterable<string>)).toEqual(
        new Set([secondAttachment.localUri]),
      );
    } finally {
      while (callbacks.length > 0) {
        callbacks.shift()?.();
        await flushAttachmentCleanup();
      }
      setTimeoutSpy.mockRestore();
      reconcileSpy.mockRestore();
    }
  });

  it('does not perform unbounded hydration attachment directory deletion in one scheduled pass', async () => {
    const fileNames = Array.from({ length: 40 }, (_, index) => `orphan-${index}.jpg`);
    (FileSystem.readDirectoryAsync as jest.Mock).mockResolvedValueOnce(fileNames);
    const { callbacks, delays, setTimeoutSpy } = captureScheduledTimeouts();

    try {
      useChatStore.setState({ threads: {}, activeThreadId: null });
      await useChatStore.persist.rehydrate();
      await flushAttachmentCleanup(80);

      expect(FileSystem.readDirectoryAsync).toHaveBeenCalledTimes(1);
      expect(FileSystem.readDirectoryAsync).toHaveBeenCalledWith('test-dir/chat-attachments/');
      expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(16);
      expect(FileSystem.deleteAsync).toHaveBeenCalledWith('test-dir/chat-attachments/orphan-15.jpg', {
        idempotent: true,
      });
      expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith('test-dir/chat-attachments/orphan-16.jpg', expect.anything());
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(delays[0]).toBe(1_000);
    } finally {
      const pendingRetry = callbacks.shift();
      if (pendingRetry) {
        pendingRetry();
        await flushAttachmentCleanup();
      }
      setTimeoutSpy.mockRestore();
    }
  });

  it('recovers hydrated streaming assistant messages as stopped while preserving partial content', async () => {
    const streamingThread: ChatThread = {
      ...buildThread('thread-streaming-v2', 20),
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'Prompt before crash',
          createdAt: 20,
          state: 'complete',
        },
        {
          id: 'assistant-1',
          role: 'assistant',
          content: 'Partial answer before crash',
          createdAt: 21,
          state: 'streaming',
        },
      ],
      status: 'generating',
    };

    writeChatThreadRecord(storage, streamingThread, 22);
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: streamingThread.id,
      threadIds: [streamingThread.id],
      updatedAt: 22,
    });

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().getThread(streamingThread.id)).toEqual(
      expect.objectContaining({
        status: 'stopped',
        messages: [
          expect.objectContaining({
            id: 'user-1',
            state: 'complete',
          }),
          expect.objectContaining({
            id: 'assistant-1',
            content: 'Partial answer before crash',
            state: 'stopped',
          }),
        ],
      }),
    );
  });

  it('reconstructs missing message modelId values using model_switch events during rehydration', async () => {
    const thread: ChatThread = {
      ...buildThread('thread-model-switch-migration', 10),
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'Before switch',
          createdAt: 1,
          state: 'complete',
        },
        {
          id: 'switch-1',
          role: 'system',
          kind: 'model_switch',
          content: '',
          createdAt: 2,
          state: 'complete',
          switchFromModelId: 'author/model-q4',
          switchToModelId: 'author/model-q8',
        },
        {
          id: 'assistant-1',
          role: 'assistant',
          content: 'After switch',
          createdAt: 3,
          state: 'complete',
        },
      ],
    };

    storage.set(
      'chat-store',
      JSON.stringify({
        state: {
          threads: {
            [thread.id]: thread,
          },
          activeThreadId: thread.id,
        },
        version: 0,
      }),
    );

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    const hydrated = useChatStore.getState().getThread(thread.id);

    expect(hydrated?.activeModelId).toBe('author/model-q8');
    expect(hydrated?.messages).toEqual([
      expect.objectContaining({
        id: 'user-1',
        kind: 'message',
        modelId: 'author/model-q4',
      }),
      expect.objectContaining({
        id: 'switch-1',
        kind: 'model_switch',
        modelId: 'author/model-q8',
        switchFromModelId: 'author/model-q4',
        switchToModelId: 'author/model-q8',
      }),
      expect.objectContaining({
        id: 'assistant-1',
        kind: 'message',
        modelId: 'author/model-q8',
      }),
    ]);
  });

  it('persists and rehydrates a saved thread', async () => {
    const threadId = useChatStore.getState().createThread({
      modelId: 'author/model-q4',
      presetId: 'preset-1',
      presetSnapshot: {
        id: 'preset-1',
        name: 'Helpful Assistant',
        systemPrompt: 'Be concise.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 1024,
        seed: null,
      },
    });

    useChatStore.getState().appendMessage(threadId, {
      id: 'user-1',
      role: 'user',
      content: 'Persist this thread',
      createdAt: 1,
      state: 'complete',
    });

    const persistedRecord = storage.getString(getChatThreadStorageKey(threadId));
    const persistedAnchor = storage.getString('chat-store');
    expect(persistedRecord).toContain('Persist this thread');
    expect(persistedAnchor).not.toContain('Persist this thread');

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().activeThreadId).toBe(threadId);
    expect(useChatStore.getState().getThread(threadId)).toEqual(
      expect.objectContaining({
        id: threadId,
        messages: [
          expect.objectContaining({
            id: 'user-1',
            content: 'Persist this thread',
          }),
        ],
      }),
    );
  });

  it('drops polluted empty streaming placeholders during v2 hydration instead of recovering phantom stopped messages', async () => {
    const pollutedThread: ChatThread = {
      ...buildThread('thread-empty-placeholder-v2', 20),
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'Prompt before a cold restart',
          createdAt: 20,
          state: 'complete',
        },
        {
          id: 'assistant-empty-1',
          role: 'assistant',
          content: '',
          createdAt: 21,
          state: 'streaming',
        },
      ],
      status: 'generating',
    };

    storage.set(getChatThreadStorageKey(pollutedThread.id), JSON.stringify({
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      thread: pollutedThread,
      persistedAt: 22,
    }));
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: pollutedThread.id,
      threadIds: [pollutedThread.id],
      updatedAt: 22,
    });

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().getThread(pollutedThread.id)).toEqual(
      expect.objectContaining({
        status: 'idle',
        messages: [
          expect.objectContaining({
            id: 'user-1',
            role: 'user',
            content: 'Prompt before a cold restart',
          }),
        ],
      }),
    );

    const recoveredRecord = JSON.parse(
      storage.getString(getChatThreadStorageKey(pollutedThread.id)) ?? '{}',
    ) as { thread: ChatThread };
    expect(recoveredRecord.thread.status).toBe('idle');
    expect(recoveredRecord.thread.messages).toEqual([
      expect.objectContaining({
        id: 'user-1',
        role: 'user',
      }),
    ]);
  });

  it('keeps 100 streaming patches over 1000 messages free of durable sanitize and serialization work', () => {
    jest.useFakeTimers();
    const durableThread = buildPerformanceThread({
      historicalMessageCount: 1000,
      attachments: 'mixed',
      modelSwitchEvery: 125,
    });
    const messageId = 'assistant-progress-1000';
    const streamingThread: ChatThread = {
      ...durableThread,
      messages: [
        ...durableThread.messages,
        {
          id: messageId,
          role: 'assistant',
          content: '',
          createdAt: durableThread.updatedAt + 1,
          state: 'streaming',
          kind: 'message',
          modelId: durableThread.activeModelId,
        },
      ],
      status: 'generating',
    };
    writeChatThreadRecord(storage, durableThread, durableThread.updatedAt);
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: durableThread.id,
      threadIds: [durableThread.id],
      updatedAt: durableThread.updatedAt,
    });
    useChatStore.setState({
      threads: { [streamingThread.id]: streamingThread },
      activeThreadId: streamingThread.id,
    });
    const durableRecordBefore = storage.getString(getChatThreadStorageKey(streamingThread.id));
    const previousEnabled = performanceMonitor.isEnabled();
    performanceMonitor.setEnabled(true);
    performanceMonitor.clear();

    try {
      for (let index = 1; index <= 100; index += 1) {
        useChatStore.getState().patchAssistantMessage(streamingThread.id, messageId, {
          content: `Latest bounded output ${index}`,
          thoughtContent: `Reasoning ${index}`,
          tokensPerSec: index,
          state: 'streaming',
        });
      }

      expect(performanceMonitor.snapshot().counters).toEqual(expect.objectContaining({
        'chat.stream.patch': 100,
      }));
      expect(performanceMonitor.snapshot().counters['chat.persist.sanitize'] ?? 0).toBe(0);
      expect(performanceMonitor.snapshot().counters['chat.persist.stringify'] ?? 0).toBe(0);
      expect(storage.getString(getChatThreadStorageKey(streamingThread.id))).toBe(durableRecordBefore);

      flushPendingChatPersistenceWrites('background');

      const snapshot = performanceMonitor.snapshot();
      const progressRaw = storage.getString(getChatStreamingProgressStorageKey(streamingThread.id));
      expect(snapshot.counters['chat.persist.sanitize'] ?? 0).toBe(0);
      expect(snapshot.counters['chat.persist.stringify']).toBe(3);
      expect(snapshot.counters['chat.persist.streaming']).toBe(1);
      expect(snapshot.events.filter((event) => event.name === 'chat.persist.stringify'))
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ meta: { recordKind: 'progress_operation' } }),
          expect.objectContaining({ meta: { recordKind: 'progress_checkpoint' } }),
          expect.objectContaining({ meta: { recordKind: 'progress_manifest' } }),
        ]));
      expect(storage.getString(getChatThreadStorageKey(streamingThread.id))).toBe(durableRecordBefore);
      expect(progressRaw).not.toContain('Deterministic user message');
      expect(progressRaw?.length ?? Number.MAX_SAFE_INTEGER).toBeLessThan(1_000);
      expect(readChatStreamingProgressRecord(storage, streamingThread.id)).toEqual({
        ok: true,
        value: expect.objectContaining({
          messageId,
          content: 'Latest bounded output 100',
          thoughtContent: 'Reasoning 100',
          tokensPerSec: 100,
          revision: 100,
          state: 'streaming',
        }),
      });
    } finally {
      performanceMonitor.clear();
      performanceMonitor.setEnabled(previousEnabled);
      useChatStore.getState().stopAssistantMessage(streamingThread.id, messageId);
      jest.useRealTimers();
    }
  });

  it('atomically finalizes the latest buffered output and MTP telemetry in one mutation and transaction', () => {
    const durableThread = buildPerformanceThread({
      historicalMessageCount: 1000,
      attachments: 'mixed',
      modelSwitchEvery: 125,
    });
    const messageId = 'assistant-terminal-1000';
    const streamingThread: ChatThread = {
      ...durableThread,
      messages: [
        ...durableThread.messages,
        {
          id: messageId,
          role: 'assistant',
          content: '',
          createdAt: durableThread.updatedAt + 1,
          state: 'streaming',
          kind: 'message',
          modelId: durableThread.activeModelId,
        },
      ],
      status: 'generating',
    };
    writeChatThreadRecord(storage, durableThread, durableThread.updatedAt);
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: streamingThread.id,
      threadIds: [streamingThread.id],
      updatedAt: durableThread.updatedAt,
    });
    useChatStore.setState({
      threads: { [streamingThread.id]: streamingThread },
      activeThreadId: streamingThread.id,
    });
    useChatStore.getState().patchAssistantMessage(streamingThread.id, messageId, {
      content: 'Older flushed output',
      thoughtContent: 'Older flushed reasoning',
      tokensPerSec: 1,
    });
    flushPendingChatPersistenceWrites('background');

    const telemetry = {
      tokensPredicted: 120,
      tokensEvaluated: 30,
      predictedPerSecond: 7.5,
      timeToFirstTokenMs: 640,
      mtp: {
        requested: true,
        attempted: true,
        fallbackUsed: false,
        draftTokens: 48,
        draftTokensAccepted: 24,
        acceptanceRate: 0.5,
      },
    };
    const observedTerminalStates: Array<{
      messageState: string | undefined;
      threadStatus: string | undefined;
      inferenceMetrics: unknown;
    }> = [];
    const unsubscribeStateCapture = useChatStore.subscribe((state) => {
      const thread = state.threads[streamingThread.id];
      observedTerminalStates.push({
        messageState: thread?.messages.at(-1)?.state,
        threadStatus: thread?.status,
        inferenceMetrics: thread?.messages.at(-1)?.inferenceMetrics,
      });
    });
    const mutationCounter = createMutationCounter(useChatStore.subscribe);
    const appStorage = getAppStorage() as unknown as { set: jest.Mock };
    const originalSet = appStorage.set;
    const writtenKeys: string[] = [];
    appStorage.set = jest.fn(function setWithKeyCapture(this: unknown, key: string, value: unknown) {
      writtenKeys.push(key);
      return originalSet.call(this, key, value);
    });
    const previousEnabled = performanceMonitor.isEnabled();
    performanceMonitor.setEnabled(true);
    performanceMonitor.clear();

    try {
      expect(useChatStore.getState().finalizeAssistantTurn(
        streamingThread.id,
        messageId,
        {
          outcome: 'success',
          content: 'Latest buffered final output',
          thoughtContent: 'Latest buffered final reasoning',
          tokensPerSec: 8.25,
          inferenceMetrics: telemetry,
        },
      )).toEqual({ status: 'committed' });

      const finalizedThread = useChatStore.getState().threads[streamingThread.id];
      expect(mutationCounter.getCount()).toBe(1);
      expect(observedTerminalStates).toEqual([{
        messageState: 'complete',
        threadStatus: 'idle',
        inferenceMetrics: telemetry,
      }]);
      expect(finalizedThread.updatedAt).toBe(finalizedThread.lastGeneratedAt);
      expect(finalizedThread.messages.at(-1)).toEqual(expect.objectContaining({
        id: messageId,
        content: 'Latest buffered final output',
        thoughtContent: 'Latest buffered final reasoning',
        tokensPerSec: 8.25,
        inferenceMetrics: telemetry,
        state: 'complete',
        errorCode: undefined,
        errorMessage: undefined,
      }));
      expect(writtenKeys.filter((key) => key === getChatThreadStorageKey(streamingThread.id))).toHaveLength(1);
      expect(writtenKeys.filter((key) => key === CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY)).toHaveLength(1);
      expect(writtenKeys.filter((key) => key === CHAT_PERSISTENCE_INDEX_KEY)).toHaveLength(1);
      expect(readChatStreamingProgressRecord(storage, streamingThread.id)).toEqual({ ok: false, reason: 'missing' });

      const countersAfterCommit = performanceMonitor.snapshot().counters;
      expect(countersAfterCommit).toEqual(expect.objectContaining({
        'chat.turn.finalize': 1,
        'chat.turn.storeMutations': 1,
        'chat.turn.persistenceTransactions': 1,
        'chat.persist.terminal': 1,
        'chat.persist.sanitize': 1,
      }));
      expect(performanceMonitor.snapshot().events.filter(
        (event) => event.name === 'chat.persist.stringify' && event.meta?.recordKind === 'thread',
      )).toHaveLength(1);

      const persistedAfterCommit = storage.getString(getChatThreadStorageKey(streamingThread.id));
      const writeCountAfterCommit = writtenKeys.length;
      expect(useChatStore.getState().finalizeAssistantTurn(
        streamingThread.id,
        messageId,
        { outcome: 'stopped', content: 'Duplicate terminal callback' },
      )).toEqual({ status: 'stale' });
      expect(useChatStore.getState().finalizeAssistantTurn(
        streamingThread.id,
        'stale-assistant-id',
        { outcome: 'error', errorCode: 'stale', errorMessage: 'Stale callback' },
      )).toEqual({ status: 'stale' });

      const countersAfterDuplicates = performanceMonitor.snapshot().counters;
      expect(mutationCounter.getCount()).toBe(1);
      expect(writtenKeys).toHaveLength(writeCountAfterCommit);
      expect(storage.getString(getChatThreadStorageKey(streamingThread.id))).toBe(persistedAfterCommit);
      expect(getCounterDelta(countersAfterCommit, countersAfterDuplicates, 'chat.turn.finalize')).toBe(0);
      expect(getCounterDelta(
        countersAfterCommit,
        countersAfterDuplicates,
        'chat.turn.persistenceTransactions',
      )).toBe(0);
    } finally {
      appStorage.set = originalSet;
      mutationCounter.unsubscribe();
      unsubscribeStateCapture();
      performanceMonitor.clear();
      performanceMonitor.setEnabled(previousEnabled);
    }
  });

  it('authoritatively clears stale thought content while retaining MTP telemetry after rehydrate', async () => {
    const durableThread = buildThread('thread-terminal-clear-thought', 10);
    const messageId = 'assistant-terminal-clear-thought';
    const streamingThread: ChatThread = {
      ...durableThread,
      messages: [
        ...durableThread.messages,
        {
          id: messageId,
          role: 'assistant',
          content: '',
          createdAt: 11,
          state: 'streaming',
          kind: 'message',
          modelId: 'author/model-q4',
        },
      ],
      status: 'generating',
    };
    writeChatThreadRecord(storage, durableThread, durableThread.updatedAt);
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: streamingThread.id,
      threadIds: [streamingThread.id],
      updatedAt: durableThread.updatedAt,
    });
    useChatStore.setState({
      threads: { [streamingThread.id]: streamingThread },
      activeThreadId: streamingThread.id,
    });
    useChatStore.getState().patchAssistantMessage(streamingThread.id, messageId, {
      content: 'Final visible answer',
      thoughtContent: 'stale thought',
    });
    flushPendingChatPersistenceWrites('background');
    expect(readChatStreamingProgressRecord(storage, streamingThread.id)).toEqual({
      ok: true,
      value: expect.objectContaining({
        messageId,
        thoughtContent: 'stale thought',
      }),
    });

    const telemetry = {
      tokensPredicted: 120,
      tokensEvaluated: 30,
      predictedPerSecond: 7.5,
      timeToFirstTokenMs: 640,
      mtp: {
        requested: true,
        attempted: true,
        fallbackUsed: false,
        draftTokens: 48,
        draftTokensAccepted: 24,
        acceptanceRate: 0.5,
      },
    };
    expect(useChatStore.getState().finalizeAssistantTurn(
      streamingThread.id,
      messageId,
      {
        outcome: 'success',
        thoughtContent: null,
        inferenceMetrics: telemetry,
      },
    )).toEqual({ status: 'committed' });

    expect(useChatStore.getState().getThread(streamingThread.id)?.messages.at(-1)).toEqual(
      expect.objectContaining({
        content: 'Final visible answer',
        thoughtContent: undefined,
        inferenceMetrics: telemetry,
        state: 'complete',
      }),
    );
    const persistedRecord = storage.getString(getChatThreadStorageKey(streamingThread.id));
    expect(persistedRecord).not.toContain('stale thought');
    expect(persistedRecord).not.toContain('"thoughtContent":""');
    expect(readChatStreamingProgressRecord(storage, streamingThread.id)).toEqual({
      ok: false,
      reason: 'missing',
    });

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    const rehydratedMessage = useChatStore
      .getState()
      .getThread(streamingThread.id)
      ?.messages.at(-1);
    expect(rehydratedMessage).toEqual(
      expect.objectContaining({
        content: 'Final visible answer',
        inferenceMetrics: telemetry,
        state: 'complete',
      }),
    );
    expect(rehydratedMessage).not.toHaveProperty('thoughtContent');
  });

  it.each(['success', 'stopped', 'error'] as const)(
    'preserves partial thought content when %s finalization omits the field',
    (outcome) => {
      const thread = buildThread(`thread-terminal-preserve-thought-${outcome}`, 10);
      const messageId = `assistant-terminal-preserve-thought-${outcome}`;
      const streamingThread: ChatThread = {
        ...thread,
        messages: [
          ...thread.messages,
          {
            id: messageId,
            role: 'assistant',
            content: 'Partial visible answer',
            thoughtContent: 'Partial thought survives',
            createdAt: 11,
            state: 'streaming',
          },
        ],
        status: 'generating',
      };
      useChatStore.setState({
        threads: { [streamingThread.id]: streamingThread },
        activeThreadId: streamingThread.id,
      });

      const didFinalize = outcome === 'error'
        ? useChatStore.getState().finalizeAssistantTurn(
            streamingThread.id,
            messageId,
            {
              outcome,
              errorCode: 'generation_failed',
              errorMessage: 'Generation failed safely',
            },
          )
        : useChatStore.getState().finalizeAssistantTurn(
            streamingThread.id,
            messageId,
            { outcome },
          );

      expect(didFinalize).toEqual({ status: 'committed' });
      expect(useChatStore.getState().getThread(streamingThread.id)?.messages.at(-1)).toEqual(
        expect.objectContaining({
          content: 'Partial visible answer',
          thoughtContent: 'Partial thought survives',
          state: outcome === 'success' ? 'complete' : outcome,
        }),
      );
    },
  );

  it.each([
    {
      outcome: 'success' as const,
      finalization: { outcome: 'success' as const, content: 'Complete answer' },
      expectedMessageState: 'complete',
      expectedThreadStatus: 'idle',
      expectedErrorCode: undefined,
    },
    {
      outcome: 'stopped' as const,
      finalization: { outcome: 'stopped' as const, content: 'Partial answer' },
      expectedMessageState: 'stopped',
      expectedThreadStatus: 'stopped',
      expectedErrorCode: undefined,
    },
    {
      outcome: 'error' as const,
      finalization: {
        outcome: 'error' as const,
        content: 'Partial answer before error',
        errorCode: 'generation_failed',
        errorMessage: 'Generation failed safely',
      },
      expectedMessageState: 'error',
      expectedThreadStatus: 'error',
      expectedErrorCode: 'generation_failed',
    },
  ])('enforces $outcome assistant and thread terminal invariants', ({
    finalization,
    expectedMessageState,
    expectedThreadStatus,
    expectedErrorCode,
  }) => {
    const thread = buildThread(`thread-terminal-${expectedMessageState}`, 10);
    const streamingThread: ChatThread = {
      ...thread,
      messages: [
        ...thread.messages,
        {
          id: `assistant-${expectedMessageState}`,
          role: 'assistant',
          content: 'Streaming content',
          createdAt: 11,
          state: 'streaming',
        },
      ],
      status: 'generating',
    };
    useChatStore.setState({
      threads: { [streamingThread.id]: streamingThread },
      activeThreadId: streamingThread.id,
    });

    expect(useChatStore.getState().finalizeAssistantTurn(
      streamingThread.id,
      `assistant-${expectedMessageState}`,
      finalization,
    )).toEqual({ status: 'committed' });

    const finalized = useChatStore.getState().threads[streamingThread.id];
    expect(finalized.status).toBe(expectedThreadStatus);
    expect(finalized.updatedAt).toBe(finalized.lastGeneratedAt);
    expect(finalized.messages.at(-1)).toEqual(expect.objectContaining({
      state: expectedMessageState,
      errorCode: expectedErrorCode,
    }));
  });

  it.each(TERMINAL_PERSISTENCE_MODES.flatMap((mode) => (
    TERMINAL_PERSISTENCE_OUTCOMES.flatMap((outcome) => (
      TERMINAL_TRANSACTION_FAULTS.map((fault) => ({ mode, outcome, fault }))
    ))
  )))(
    'returns recoverable failure for $mode $outcome when $fault fails and commits once on retry',
    ({ mode, outcome, fault }) => {
      const prepared = prepareTerminalPersistenceCase(mode, `${outcome}-${fault}`);
      const finalization = buildTerminalPersistenceFinalization(mode, outcome);
      const appStorage = getAppStorage() as unknown as { set: jest.Mock; remove: jest.Mock };
      const originalSet = appStorage.set;
      const originalRemove = appStorage.remove;
      const writeError = new Error(`simulated ${fault}`);
      let didFail = false;
      let result: AssistantTurnCommitResult;

      appStorage.set = jest.fn(function failTerminalSet(this: unknown, key: string, value: unknown) {
        const shouldFail = !didFail && (
          (fault === 'pending_write' && key === CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY)
          || (fault === 'thread_write' && key === getChatThreadStorageKey(prepared.threadId))
          || (fault === 'index_write' && key === CHAT_PERSISTENCE_INDEX_KEY)
        );
        if (shouldFail) {
          didFail = true;
          throw writeError;
        }
        return originalSet.call(this, key, value);
      });
      appStorage.remove = jest.fn(function failTerminalRemove(this: unknown, key: string) {
        if (!didFail && fault === 'pending_remove' && key === CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY) {
          didFail = true;
          throw writeError;
        }
        return originalRemove.call(this, key);
      });

      try {
        result = useChatStore.getState().finalizeAssistantTurn(
          prepared.threadId,
          prepared.messageId,
          finalization,
        );
      } finally {
        appStorage.set = originalSet;
        appStorage.remove = originalRemove;
      }

      expect(didFail).toBe(true);
      expect(result!).toEqual({
        status: 'persistence_failed',
        error: writeError,
        recovery: {
          threadId: prepared.threadId,
          messageId: prepared.messageId,
          finalization,
        },
      });
      expect(useChatStore.getState().getThread(prepared.threadId)?.messages.at(-1)).toEqual(
        expect.objectContaining({
          id: prepared.messageId,
          content: prepared.partialContent,
          state: 'streaming',
        }),
      );
      expect(storage.getString(getChatThreadStorageKey(prepared.threadId))).not.toContain(
        `Final ${mode} ${outcome} output`,
      );
      expect(readChatStreamingProgressRecord(storage, prepared.threadId)).toEqual({
        ok: true,
        value: expect.objectContaining({
          messageId: prepared.messageId,
          content: prepared.partialContent,
        }),
      });

      expect(useChatStore.getState().finalizeAssistantTurn(
        prepared.threadId,
        prepared.messageId,
        finalization,
      )).toEqual({ status: 'committed' });
      const committed = useChatStore.getState().getThread(prepared.threadId)!;
      expect(committed.status).toBe(outcome === 'success' ? 'idle' : outcome);
      expect(committed.messages.filter((message) => message.id === prepared.messageId)).toEqual([
        expect.objectContaining({
          content: `Final ${mode} ${outcome} output`,
          state: outcome === 'success' ? 'complete' : outcome,
        }),
      ]);
      expect(readChatStreamingProgressRecord(storage, prepared.threadId)).toEqual({
        ok: false,
        reason: 'missing',
      });
      expect(useChatStore.getState().finalizeAssistantTurn(
        prepared.threadId,
        prepared.messageId,
        finalization,
      )).toEqual({ status: 'stale' });
    },
  );

  it.each([
    { state: 'complete' as const, outcome: 'success' as const, threadStatus: 'idle' as const },
    { state: 'stopped' as const, outcome: 'stopped' as const, threadStatus: 'stopped' as const },
    { state: 'error' as const, outcome: 'error' as const, threadStatus: 'error' as const },
  ])(
    'forwards recoverable $state failures from the terminal patch compatibility API',
    ({ state, outcome, threadStatus }) => {
      const prepared = prepareTerminalPersistenceCase('append', `compatibility-${state}`);
      const content = `Compatibility ${state} output`;
      const finalization: AssistantTurnFinalization = outcome === 'error'
        ? {
            outcome,
            content,
            errorCode: 'compatibility_generation_failed',
            errorMessage: 'Compatibility generation failed',
          }
        : { outcome, content };
      const updates = state === 'error'
        ? {
            state,
            content,
            errorCode: finalization.outcome === 'error' ? finalization.errorCode : undefined,
            errorMessage: finalization.outcome === 'error' ? finalization.errorMessage : undefined,
          }
        : { state, content };
      const appStorage = getAppStorage() as unknown as { set: jest.Mock };
      const originalSet = appStorage.set;
      const writeError = new Error(`simulated compatibility ${state} index failure`);
      let didFail = false;
      let result: AssistantTurnCommitResult | undefined;

      appStorage.set = jest.fn(function failCompatibilityTerminalIndex(
        this: unknown,
        key: string,
        value: unknown,
      ) {
        if (!didFail && key === CHAT_PERSISTENCE_INDEX_KEY) {
          didFail = true;
          throw writeError;
        }
        return originalSet.call(this, key, value);
      });

      try {
        result = useChatStore.getState().patchAssistantMessage(
          prepared.threadId,
          prepared.messageId,
          updates,
        );
      } finally {
        appStorage.set = originalSet;
      }

      expect(didFail).toBe(true);
      expect(result).toEqual({
        status: 'persistence_failed',
        error: writeError,
        recovery: {
          threadId: prepared.threadId,
          messageId: prepared.messageId,
          finalization,
        },
      });
      expect(useChatStore.getState().getThread(prepared.threadId)?.messages.at(-1)).toEqual(
        expect.objectContaining({
          id: prepared.messageId,
          content: prepared.partialContent,
          state: 'streaming',
        }),
      );

      expect(useChatStore.getState().patchAssistantMessage(
        prepared.threadId,
        prepared.messageId,
        updates,
      )).toEqual({ status: 'committed' });
      expect(useChatStore.getState().getThread(prepared.threadId)).toEqual(expect.objectContaining({
        status: threadStatus,
        messages: expect.arrayContaining([
          expect.objectContaining({
            id: prepared.messageId,
            content,
            state,
          }),
        ]),
      }));
    },
  );

  it('rolls terminal failures back to the latest concurrent durable thread mutation', () => {
    const prepared = prepareTerminalPersistenceCase('append', 'concurrent-durable-mutation');
    expect(useChatStore.getState().renameThread(prepared.threadId, 'Durable manual title'))
      .toBe(true);
    const appStorage = getAppStorage() as unknown as { set: jest.Mock };
    const originalSet = appStorage.set;
    const terminalError = new Error('simulated terminal index failure after rename');
    let didFail = false;
    appStorage.set = jest.fn(function failTerminalIndexAfterRename(
      this: unknown,
      key: string,
      value: unknown,
    ) {
      if (!didFail && key === CHAT_PERSISTENCE_INDEX_KEY) {
        didFail = true;
        throw terminalError;
      }
      return originalSet.call(this, key, value);
    });

    try {
      expect(useChatStore.getState().finalizeAssistantTurn(
        prepared.threadId,
        prepared.messageId,
        { outcome: 'success', content: 'Final output after durable rename' },
      )).toEqual(expect.objectContaining({
        status: 'persistence_failed',
        error: terminalError,
      }));
    } finally {
      appStorage.set = originalSet;
    }

    expect(didFail).toBe(true);
    expect(readChatThreadRecord(storage, prepared.threadId)).toEqual({
      ok: true,
      value: expect.objectContaining({
        thread: expect.objectContaining({
          title: 'Durable manual title',
          titleSource: 'manual',
        }),
      }),
    });
    expect(useChatStore.getState().finalizeAssistantTurn(
      prepared.threadId,
      prepared.messageId,
      { outcome: 'success', content: 'Final output after durable rename' },
    )).toEqual({ status: 'committed' });
    expect(useChatStore.getState().getThread(prepared.threadId)).toEqual(expect.objectContaining({
      title: 'Durable manual title',
      titleSource: 'manual',
    }));
  });

  it('preserves the latest concurrent durable metadata across crash recovery after terminal failure', async () => {
    const prepared = prepareTerminalPersistenceCase('append', 'concurrent-durable-crash');
    expect(useChatStore.getState().renameThread(prepared.threadId, 'Crash-safe manual title'))
      .toBe(true);
    const appStorage = getAppStorage() as unknown as { set: jest.Mock };
    const originalSet = appStorage.set;
    const terminalError = new Error('simulated terminal index failure before crash');
    let didFail = false;
    appStorage.set = jest.fn(function failTerminalIndexBeforeCrash(
      this: unknown,
      key: string,
      value: unknown,
    ) {
      if (!didFail && key === CHAT_PERSISTENCE_INDEX_KEY) {
        didFail = true;
        throw terminalError;
      }
      return originalSet.call(this, key, value);
    });

    try {
      expect(useChatStore.getState().finalizeAssistantTurn(
        prepared.threadId,
        prepared.messageId,
        { outcome: 'success', content: 'Uncommitted terminal output' },
      )).toEqual(expect.objectContaining({
        status: 'persistence_failed',
        error: terminalError,
      }));
    } finally {
      appStorage.set = originalSet;
    }

    expect(didFail).toBe(true);
    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    const recovered = useChatStore.getState().getThread(prepared.threadId)!;
    expect(recovered).toEqual(expect.objectContaining({
      title: 'Crash-safe manual title',
      titleSource: 'manual',
      status: 'stopped',
    }));
    expect(recovered.messages.filter((message) => message.id === prepared.messageId))
      .toEqual([
        expect.objectContaining({
          content: prepared.partialContent,
          state: 'stopped',
        }),
      ]);
    expect(JSON.stringify(recovered)).not.toContain('Uncommitted terminal output');
  });

  it.each(TERMINAL_PERSISTENCE_MODES.flatMap((mode) => (
    TERMINAL_PERSISTENCE_OUTCOMES.map((outcome) => ({ mode, outcome }))
  )))(
    'treats $mode $outcome as committed when only obsolete progress cleanup fails',
    async ({ mode, outcome }) => {
      const prepared = prepareTerminalPersistenceCase(mode, `${outcome}-progress-remove`);
      const finalization = buildTerminalPersistenceFinalization(mode, outcome);
      const appStorage = getAppStorage() as unknown as { remove: jest.Mock };
      const originalRemove = appStorage.remove;
      const cleanupError = new Error('simulated progress cleanup failure');
      let didFailCleanup = false;
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      appStorage.remove = jest.fn(function failProgressCleanup(this: unknown, key: string) {
        if (!didFailCleanup && key === getChatStreamingProgressStorageKey(prepared.threadId)) {
          didFailCleanup = true;
          throw cleanupError;
        }
        return originalRemove.call(this, key);
      });

      try {
        expect(useChatStore.getState().finalizeAssistantTurn(
          prepared.threadId,
          prepared.messageId,
          finalization,
        )).toEqual({ status: 'committed' });
      } finally {
        appStorage.remove = originalRemove;
      }

      expect(didFailCleanup).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(
        '[ChatPersistence] Failed to remove superseded streaming progress',
        { errorName: cleanupError.name },
      );
      warnSpy.mockRestore();
      expect(storage.getString(getChatStreamingProgressStorageKey(prepared.threadId))).toBeDefined();

      useChatStore.setState({ threads: {}, activeThreadId: null });
      await useChatStore.persist.rehydrate();

      const recovered = useChatStore.getState().getThread(prepared.threadId)!;
      expect(recovered.status).toBe(outcome === 'success' ? 'idle' : outcome);
      expect(recovered.messages.filter((message) => message.id === prepared.messageId)).toHaveLength(1);
      expect(readChatStreamingProgressRecord(storage, prepared.threadId)).toEqual({
        ok: false,
        reason: 'missing',
      });
    },
  );

  it.each(TERMINAL_PERSISTENCE_MODES.flatMap((mode) => (
    TERMINAL_PERSISTENCE_OUTCOMES.flatMap((outcome) => ([
      { mode, outcome, rollbackFault: 'thread_restore' as const },
      { mode, outcome, rollbackFault: 'progress_restore' as const },
    ]))
  )))(
    'keeps $mode $outcome retryable when $rollbackFault also fails',
    ({ mode, outcome, rollbackFault }) => {
      const prepared = prepareTerminalPersistenceCase(mode, `${outcome}-${rollbackFault}`);
      const finalization = buildTerminalPersistenceFinalization(mode, outcome);
      const appStorage = getAppStorage() as unknown as { set: jest.Mock };
      const originalSet = appStorage.set;
      const primaryError = new Error('simulated terminal index failure');
      const rollbackError = new Error(`simulated ${rollbackFault}`);
      let didFailPrimary = false;
      let didFailRollback = false;
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      appStorage.set = jest.fn(function failTerminalAndRollbackSet(
        this: unknown,
        key: string,
        value: unknown,
      ) {
        if (!didFailPrimary && key === CHAT_PERSISTENCE_INDEX_KEY) {
          didFailPrimary = true;
          throw primaryError;
        }
        const rollbackKey = rollbackFault === 'thread_restore'
          ? getChatThreadStorageKey(prepared.threadId)
          : getChatStreamingProgressStorageKey(prepared.threadId);
        if (didFailPrimary && !didFailRollback && key === rollbackKey) {
          didFailRollback = true;
          throw rollbackError;
        }
        return originalSet.call(this, key, value);
      });

      let result: AssistantTurnCommitResult;
      try {
        result = useChatStore.getState().finalizeAssistantTurn(
          prepared.threadId,
          prepared.messageId,
          finalization,
        );
      } finally {
        appStorage.set = originalSet;
      }

      expect(didFailPrimary).toBe(true);
      expect(didFailRollback).toBe(true);
      expect(result!).toEqual(expect.objectContaining({
        status: 'persistence_failed',
        error: primaryError,
      }));
      expect(warnSpy).toHaveBeenCalledWith(
        '[ChatPersistence] Failed to fully roll back failed chat persistence mutation',
        { errorCount: 1, firstErrorName: rollbackError.name },
      );
      warnSpy.mockRestore();
      expect(useChatStore.getState().getThread(prepared.threadId)?.messages.at(-1)).toEqual(
        expect.objectContaining({
          id: prepared.messageId,
          content: prepared.partialContent,
          state: 'streaming',
        }),
      );

      expect(useChatStore.getState().finalizeAssistantTurn(
        prepared.threadId,
        prepared.messageId,
        finalization,
      )).toEqual({ status: 'committed' });
      expect(useChatStore.getState().getThread(prepared.threadId)?.messages.filter(
        (message) => message.id === prepared.messageId,
      )).toHaveLength(1);
    },
  );

  it.each(TERMINAL_PERSISTENCE_MODES.flatMap((mode) => (
    TERMINAL_PERSISTENCE_OUTCOMES.flatMap((outcome) => ([
      { mode, outcome, rollbackFault: 'thread_restore' as const },
      { mode, outcome, rollbackFault: 'progress_restore' as const },
    ]))
  )))(
    'recovers $mode $outcome deterministically after a crash with a $rollbackFault fault',
    async ({ mode, outcome, rollbackFault }) => {
      const prepared = prepareTerminalPersistenceCase(
        mode,
        `${outcome}-${rollbackFault}-crash`,
      );
      const finalization = buildTerminalPersistenceFinalization(mode, outcome);
      const appStorage = getAppStorage() as unknown as { set: jest.Mock };
      const originalSet = appStorage.set;
      const primaryError = new Error('simulated crash terminal index failure');
      const rollbackError = new Error(`simulated crash ${rollbackFault}`);
      let didFailPrimary = false;
      let didFailRollback = false;
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      appStorage.set = jest.fn(function failTerminalAndRollbackBeforeCrash(
        this: unknown,
        key: string,
        value: unknown,
      ) {
        if (!didFailPrimary && key === CHAT_PERSISTENCE_INDEX_KEY) {
          didFailPrimary = true;
          throw primaryError;
        }
        const rollbackKey = rollbackFault === 'thread_restore'
          ? getChatThreadStorageKey(prepared.threadId)
          : getChatStreamingProgressStorageKey(prepared.threadId);
        if (didFailPrimary && !didFailRollback && key === rollbackKey) {
          didFailRollback = true;
          throw rollbackError;
        }
        return originalSet.call(this, key, value);
      });

      try {
        expect(useChatStore.getState().finalizeAssistantTurn(
          prepared.threadId,
          prepared.messageId,
          finalization,
        )).toEqual(expect.objectContaining({
          status: 'persistence_failed',
          error: primaryError,
        }));
      } finally {
        appStorage.set = originalSet;
      }

      expect(didFailPrimary).toBe(true);
      expect(didFailRollback).toBe(true);
      expect(storage.getString(CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY)).toBeDefined();
      if (rollbackFault === 'thread_restore') {
        expect(storage.getString(getChatThreadStorageKey(prepared.threadId)))
          .toContain(`Final ${mode} ${outcome} output`);
      } else {
        expect(storage.getString(getChatThreadStorageKey(prepared.threadId)))
          .toBe(prepared.durableRecordBefore);
      }

      useChatStore.setState({ threads: {}, activeThreadId: null });
      await useChatStore.persist.rehydrate();

      const recovered = useChatStore.getState().getThread(prepared.threadId)!;
      const recoveredAssistant = recovered.messages.find(
        (message) => message.id === prepared.messageId,
      );
      expect(recovered.messages.filter((message) => message.id === prepared.messageId))
        .toHaveLength(1);
      if (rollbackFault === 'thread_restore') {
        expect(recovered.status).toBe(outcome === 'success' ? 'idle' : outcome);
        expect(recoveredAssistant).toEqual(expect.objectContaining({
          content: `Final ${mode} ${outcome} output`,
          state: outcome === 'success' ? 'complete' : outcome,
        }));
      } else {
        expect(recovered.status).toBe('stopped');
        expect(recoveredAssistant).toEqual(expect.objectContaining({
          content: prepared.partialContent,
          state: 'stopped',
        }));
      }
      expect(storage.getString(CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY)).toBeUndefined();
      expect(readChatStreamingProgressRecord(storage, prepared.threadId)).toEqual({
        ok: false,
        reason: 'missing',
      });
      warnSpy.mockRestore();
    },
  );

  it('keeps stale and duplicate terminal callbacks as no-ops when private storage is blocked', () => {
    const completedThread = buildThread('thread-terminal-duplicate-blocked', 10);
    const completedMessageId = 'assistant-terminal-completed';
    const completedStreamingThread: ChatThread = {
      ...completedThread,
      messages: [
        ...completedThread.messages,
        {
          id: completedMessageId,
          role: 'assistant',
          content: 'Completed before storage blocked',
          createdAt: 11,
          state: 'streaming',
        },
      ],
      status: 'generating',
    };
    const replacementThread = buildThread('thread-terminal-stale-blocked', 20);
    const currentMessageId = 'assistant-current-streaming';
    const replacementStreamingThread: ChatThread = {
      ...replacementThread,
      messages: [
        ...replacementThread.messages,
        {
          id: currentMessageId,
          role: 'assistant',
          content: 'Current response',
          createdAt: 21,
          state: 'streaming',
        },
      ],
      status: 'generating',
    };
    useChatStore.setState({
      threads: {
        [completedStreamingThread.id]: completedStreamingThread,
        [replacementStreamingThread.id]: replacementStreamingThread,
      },
      activeThreadId: replacementStreamingThread.id,
    });
    expect(useChatStore.getState().finalizeAssistantTurn(
      completedStreamingThread.id,
      completedMessageId,
      { outcome: 'success', content: 'Completed before storage blocked' },
    )).toEqual({ status: 'committed' });

    const blockedError = new Error('private storage blocked');
    const writabilitySpy = jest
      .spyOn(privateStorageService, 'assertPrivateStorageWritable')
      .mockImplementation(() => {
        throw blockedError;
      });

    try {
      expect(useChatStore.getState().finalizeAssistantTurn(
        completedStreamingThread.id,
        completedMessageId,
        { outcome: 'stopped' },
      )).toEqual({ status: 'stale' });
      expect(useChatStore.getState().finalizeAssistantTurn(
        replacementStreamingThread.id,
        'assistant-replaced-stale',
        { outcome: 'error', errorCode: 'stale', errorMessage: 'Stale callback' },
      )).toEqual({ status: 'stale' });
      expect(writabilitySpy).not.toHaveBeenCalled();

      expect(useChatStore.getState().finalizeAssistantTurn(
        replacementStreamingThread.id,
        currentMessageId,
        { outcome: 'stopped' },
      )).toEqual(expect.objectContaining({
        status: 'persistence_failed',
        error: blockedError,
      }));
      expect(writabilitySpy).toHaveBeenCalledTimes(1);
    } finally {
      writabilitySpy.mockRestore();
      useChatStore.getState().finalizeAssistantTurn(
        replacementStreamingThread.id,
        currentMessageId,
        { outcome: 'stopped' },
      );
    }
  });

  it('recovers newer bounded progress as stopped and preserves durable attachments and history', async () => {
    const threadId = 'thread-progress-hydration';
    const attachment = buildStoredAttachment(threadId, 'user-1', 'recovery-kept.jpg');
    const durableThread: ChatThread = {
      ...buildThread(threadId, 10),
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'Prompt before process death',
          createdAt: 10,
          state: 'complete',
          attachments: [attachment],
        },
      ],
      updatedAt: 10,
      status: 'idle',
    };
    writeChatThreadRecord(storage, durableThread, 100);
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: threadId,
      threadIds: [threadId],
      updatedAt: 100,
    });
    writeChatStreamingProgressRecord(storage, {
      schemaVersion: CHAT_STREAM_PROGRESS_SCHEMA_VERSION,
      threadId,
      messageId: 'assistant-recovered',
      modelId: 'author/model-q4',
      createdAt: 11,
      content: 'Recovered partial answer',
      thoughtContent: 'Recovered thought',
      tokensPerSec: 9.5,
      state: 'streaming',
      persistedAt: 101,
      revision: 7,
    });

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().getThread(threadId)).toEqual(expect.objectContaining({
      status: 'stopped',
      messages: [
        expect.objectContaining({
          id: 'user-1',
          attachments: [attachment],
        }),
        expect.objectContaining({
          id: 'assistant-recovered',
          content: 'Recovered partial answer',
          thoughtContent: 'Recovered thought',
          tokensPerSec: 9.5,
          state: 'stopped',
        }),
      ],
    }));
    expectNoStreamingProgressArtifacts(threadId);
    expect(storage.getString(getChatThreadStorageKey(threadId))).toContain('Recovered partial answer');
    expect(storage.getString(getChatThreadStorageKey(threadId))).toContain('recovery-kept.jpg');
  });

  it('refreshes progress after an unrelated durable thread mutation during generation', async () => {
    const durableThread = buildThread('thread-progress-rename', 10);
    const messageId = 'assistant-progress-rename';
    const streamingThread: ChatThread = {
      ...durableThread,
      messages: [
        ...durableThread.messages,
        {
          id: messageId,
          role: 'assistant',
          content: '',
          createdAt: 11,
          state: 'streaming',
          modelId: 'author/model-q4',
        },
      ],
      status: 'generating',
    };
    writeChatThreadRecord(storage, durableThread, 10);
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: durableThread.id,
      threadIds: [durableThread.id],
      updatedAt: 10,
    });
    useChatStore.setState({
      threads: { [streamingThread.id]: streamingThread },
      activeThreadId: streamingThread.id,
    });
    useChatStore.getState().patchAssistantMessage(streamingThread.id, messageId, {
      content: 'Partial survives rename',
    });
    flushPendingChatPersistenceWrites('background');

    expect(useChatStore.getState().renameThread(streamingThread.id, 'Renamed while generating')).toBe(true);

    const durableRecord = readChatThreadRecord(storage, streamingThread.id);
    const progressRecord = readChatStreamingProgressRecord(storage, streamingThread.id);
    expect(durableRecord.ok).toBe(true);
    expect(progressRecord.ok).toBe(true);
    expect(progressRecord.ok && durableRecord.ok
      ? progressRecord.value.persistedAt
      : 0).toBeGreaterThan(durableRecord.ok ? durableRecord.value.persistedAt : Number.MAX_SAFE_INTEGER);

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().getThread(streamingThread.id)).toEqual(expect.objectContaining({
      title: 'Renamed while generating',
      status: 'stopped',
      messages: expect.arrayContaining([
        expect.objectContaining({
          id: messageId,
          content: 'Partial survives rename',
          state: 'stopped',
        }),
      ]),
    }));
  });

  it('keeps the last bounded prefix and still allows durable and terminal commits after overflow', () => {
    const durableThread = buildThread('thread-progress-capacity', 10);
    const messageId = 'assistant-progress-capacity';
    const streamingThread: ChatThread = {
      ...durableThread,
      messages: [
        ...durableThread.messages,
        {
          id: messageId,
          role: 'assistant',
          content: '',
          createdAt: 11,
          state: 'streaming',
          modelId: 'author/model-q4',
        },
      ],
      status: 'generating',
    };
    writeChatThreadRecord(storage, durableThread, 10);
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: durableThread.id,
      threadIds: [durableThread.id],
      updatedAt: 10,
    });
    useChatStore.setState({
      threads: { [streamingThread.id]: streamingThread },
      activeThreadId: streamingThread.id,
    });
    useChatStore.getState().patchAssistantMessage(streamingThread.id, messageId, {
      content: 'last bounded prefix',
    });
    flushPendingChatPersistenceWrites('background');

    const oversizedContent = 'x'.repeat(MAX_ASSISTANT_PROGRESS_CONTENT_CHARS + 1);
    useChatStore.getState().patchAssistantMessage(streamingThread.id, messageId, {
      content: oversizedContent,
    });
    expect(() => flushPendingChatPersistenceWrites('background')).not.toThrow();
    expect(readChatStreamingProgressRecord(storage, streamingThread.id)).toEqual({
      ok: true,
      value: expect.objectContaining({ content: 'last bounded prefix' }),
    });

    expect(useChatStore.getState().renameThread(
      streamingThread.id,
      'Renamed after progress overflow',
    )).toBe(true);
    expect(readChatThreadRecord(storage, streamingThread.id)).toEqual({
      ok: true,
      value: expect.objectContaining({
        thread: expect.objectContaining({ title: 'Renamed after progress overflow' }),
      }),
    });

    expect(useChatStore.getState().finalizeAssistantMessage(
      streamingThread.id,
      messageId,
      oversizedContent,
    )).toEqual(expect.objectContaining({ status: 'committed' }));
    expect(useChatStore.getState().getThread(streamingThread.id)?.messages.at(-1)?.content)
      .toHaveLength(MAX_ASSISTANT_PROGRESS_CONTENT_CHARS + 1);
    expectNoStreamingProgressArtifacts(streamingThread.id);
  });

  it('recovers progress when process death interrupts a nonterminal durable mutation', async () => {
    const threadId = 'thread-progress-interrupted-mutation';
    const durableThread = buildThread(threadId, 10);
    const renamedThread: ChatThread = {
      ...durableThread,
      title: 'Renamed before process death',
      titleSource: 'manual',
      updatedAt: 20,
    };
    writeChatThreadRecord(storage, durableThread, 90, { commitRevision: 1 });
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: threadId,
      threadIds: [threadId],
      updatedAt: 90,
      revision: 1,
    });

    // This is the on-disk state after progress and the changed thread were
    // written, but before the pending mutation could publish its index.
    writeChatStreamingProgressRecord(storage, {
      schemaVersion: CHAT_STREAM_PROGRESS_SCHEMA_VERSION,
      threadId,
      messageId: 'assistant-interrupted-mutation',
      modelId: 'author/model-q4',
      createdAt: 11,
      content: 'Partial survives interrupted rename',
      state: 'streaming',
      persistedAt: 101,
      revision: 4,
    });
    writeChatPendingIndexCommit(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      revision: 2,
      activeThreadId: threadId,
      threadIds: [threadId],
      updatedAt: 100,
      reason: 'thread_mutation',
      changedThreadIds: [threadId],
      requiresChangedThreadCommitRevision: true,
    });
    writeChatThreadRecord(storage, renamedThread, 100, { commitRevision: 2 });

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    expect(storage.getString(CHAT_PERSISTENCE_PENDING_INDEX_COMMIT_KEY)).toBeUndefined();
    expectNoStreamingProgressArtifacts(threadId);
    expect(useChatStore.getState().getThread(threadId)).toEqual(expect.objectContaining({
      title: 'Renamed before process death',
      status: 'stopped',
      messages: expect.arrayContaining([
        expect.objectContaining({
          id: 'assistant-interrupted-mutation',
          content: 'Partial survives interrupted rename',
          state: 'stopped',
        }),
      ]),
    }));
  });

  it('clears corrupt and terminal-conflicting progress without overriding durable answers', async () => {
    const terminalThread: ChatThread = {
      ...buildThread('thread-terminal-progress', 10),
      messages: [
        {
          id: 'assistant-terminal',
          role: 'assistant',
          content: 'Durable final answer',
          createdAt: 11,
          state: 'complete',
          modelId: 'author/model-q4',
        },
      ],
    };
    const corruptThread = buildThread('thread-corrupt-progress', 20);
    writeChatThreadRecord(storage, terminalThread, 100);
    writeChatThreadRecord(storage, corruptThread, 100);
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: terminalThread.id,
      threadIds: [terminalThread.id, corruptThread.id],
      updatedAt: 100,
    });
    writeChatStreamingProgressRecord(storage, {
      schemaVersion: CHAT_STREAM_PROGRESS_SCHEMA_VERSION,
      threadId: terminalThread.id,
      messageId: 'assistant-terminal',
      modelId: 'author/model-q4',
      createdAt: 11,
      content: 'Stale partial must not win',
      state: 'streaming',
      persistedAt: 101,
      revision: 3,
    });
    storage.set(getChatStreamingProgressStorageKey(corruptThread.id), '{broken progress');

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().getThread(terminalThread.id)?.messages).toEqual([
      expect.objectContaining({ content: 'Durable final answer', state: 'complete' }),
    ]);
    expect(useChatStore.getState().getThread(corruptThread.id)).not.toBeNull();
    expectNoStreamingProgressArtifacts(terminalThread.id);
    expectNoStreamingProgressArtifacts(corruptThread.id);
  });

  it('removes progress on retention cleanup, delete, clear, and private-storage reset', () => {
    const now = 20 * 24 * 60 * 60 * 1_000;
    const oldThread = buildThread('thread-progress-expired', 1);
    const activeThread = buildThread('thread-progress-active', now);
    const withPlaceholder = (thread: ChatThread, messageId: string): ChatThread => ({
      ...thread,
      messages: [
        ...thread.messages,
        {
          id: messageId,
          role: 'assistant',
          content: '',
          createdAt: thread.updatedAt + 1,
          state: 'streaming',
          modelId: 'author/model-q4',
        },
      ],
      status: 'generating',
    });
    const oldStreaming = withPlaceholder(oldThread, 'assistant-old');
    const activeStreaming = withPlaceholder(activeThread, 'assistant-active');
    useChatStore.setState({
      threads: {
        [oldStreaming.id]: oldStreaming,
        [activeStreaming.id]: activeStreaming,
      },
      activeThreadId: activeStreaming.id,
    });
    useChatStore.getState().patchAssistantMessage(oldStreaming.id, 'assistant-old', { content: 'Old partial' });
    useChatStore.getState().patchAssistantMessage(activeStreaming.id, 'assistant-active', { content: 'Active partial' });
    flushPendingChatPersistenceWrites('background');

    expect(useChatStore.getState().pruneExpiredThreads(7, now)).toBe(1);
    expectNoStreamingProgressArtifacts(oldStreaming.id);
    expect(readChatStreamingProgressRecord(storage, activeStreaming.id)).toEqual({
      ok: true,
      value: expect.objectContaining({ content: 'Active partial' }),
    });

    useChatStore.getState().deleteThread(activeStreaming.id);
    expectNoStreamingProgressArtifacts(activeStreaming.id);

    storage.set(getChatStreamingProgressStorageKey('orphan-clear'), JSON.stringify({ orphan: true }));
    expect(useChatStore.getState().clearAllThreads()).toBe(0);
    expectNoStreamingProgressArtifacts('orphan-clear');

    storage.set(getChatStreamingProgressStorageKey('orphan-reset'), JSON.stringify({ orphan: true }));
    resetChatStoreForPrivateStorageReset();
    expectNoStreamingProgressArtifacts('orphan-reset');
  });

  it('retains latest progress when a terminal durable commit fails', () => {
    const thread = buildThread('thread-progress-terminal-failure', 10);
    const messageId = 'assistant-terminal-failure';
    const streamingThread: ChatThread = {
      ...thread,
      messages: [
        ...thread.messages,
        {
          id: messageId,
          role: 'assistant',
          content: '',
          createdAt: 11,
          state: 'streaming',
          modelId: 'author/model-q4',
        },
      ],
      status: 'generating',
    };
    writeChatThreadRecord(storage, thread, 10);
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: thread.id,
      threadIds: [thread.id],
      updatedAt: 10,
    });
    useChatStore.setState({
      threads: { [streamingThread.id]: streamingThread },
      activeThreadId: streamingThread.id,
    });
    useChatStore.getState().patchAssistantMessage(thread.id, messageId, {
      content: 'Partial that must survive',
      thoughtContent: 'Reasoning that must survive',
    });
    flushPendingChatPersistenceWrites('background');

    const appStorage = getAppStorage() as unknown as { set: jest.Mock };
    const originalSet = appStorage.set;
    const writeError = new Error('simulated terminal thread write failure');
    let failed = false;
    appStorage.set = jest.fn(function setWithFailure(this: unknown, key: string, value: unknown) {
      if (
        !failed
        && key === getChatThreadStorageKey(thread.id)
        && typeof value === 'string'
        && value.includes('Final answer that fails')
      ) {
        failed = true;
        throw writeError;
      }
      return originalSet.call(this, key, value);
    });

    try {
      expect(useChatStore.getState().finalizeAssistantMessage(
        thread.id,
        messageId,
        'Final answer that fails',
      )).toEqual(expect.objectContaining({
        status: 'persistence_failed',
        error: writeError,
      }));
    } finally {
      appStorage.set = originalSet;
    }

    expect(readChatStreamingProgressRecord(storage, thread.id)).toEqual({
      ok: true,
      value: expect.objectContaining({
        messageId,
        content: 'Partial that must survive',
        thoughtContent: 'Reasoning that must survive',
      }),
    });
    expect(useChatStore.getState().getThread(thread.id)?.messages.at(-1)).toEqual(expect.objectContaining({
      id: messageId,
      content: 'Partial that must survive',
      state: 'streaming',
    }));

    useChatStore.getState().stopAssistantMessage(thread.id, messageId);
  });

  it('debounces streaming patches to the active thread without rewriting unrelated records', () => {
    jest.useFakeTimers();
    const activeThread = {
      ...buildThread('thread-active', 20),
      messages: [
        {
          id: 'active-user-1',
          role: 'user' as const,
          content: 'Active prompt',
          createdAt: 20,
          state: 'complete' as const,
        },
        {
          id: 'active-assistant-1',
          role: 'assistant' as const,
          content: '',
          createdAt: 21,
          state: 'streaming' as const,
        },
      ],
      status: 'generating' as const,
    };
    const archivedThread = {
      ...buildThread('thread-archive', 10),
      messages: [
        {
          id: 'archive-user-1',
          role: 'user' as const,
          content: 'Archived prompt that should not be rewritten by active streaming',
          createdAt: 10,
          state: 'complete' as const,
        },
      ],
    };
    const secondArchivedThread = {
      ...buildThread('thread-archive-two', 11),
      messages: [
        {
          id: 'archive-two-user-1',
          role: 'user' as const,
          content: 'Second archived prompt that should also stay untouched',
          createdAt: 11,
          state: 'complete' as const,
        },
      ],
    };

    writeChatThreadRecord(storage, archivedThread, 10);
    writeChatThreadRecord(storage, secondArchivedThread, 11);
    writeChatPersistenceIndex(storage, {
      schemaVersion: CHAT_PERSISTENCE_SCHEMA_VERSION,
      activeThreadId: activeThread.id,
      threadIds: [activeThread.id, archivedThread.id, secondArchivedThread.id],
      updatedAt: 10,
    });
    const archivedRecordBefore = storage.getString(getChatThreadStorageKey(archivedThread.id));
    const secondArchivedRecordBefore = storage.getString(getChatThreadStorageKey(secondArchivedThread.id));

    useChatStore.setState({
      threads: {
        [activeThread.id]: activeThread,
        [archivedThread.id]: archivedThread,
        [secondArchivedThread.id]: secondArchivedThread,
      },
      activeThreadId: activeThread.id,
    });

    useChatStore.getState().patchAssistantMessage(activeThread.id, 'active-assistant-1', {
      content: 'Streaming token',
      state: 'streaming',
    });

    expect(storage.getString('chat-store')).not.toContain('Archived prompt that should not be rewritten by active streaming');
    expect(storage.getString('chat-store')).not.toContain('Second archived prompt that should also stay untouched');
    expect(storage.getString(getChatThreadStorageKey(activeThread.id))).toBeUndefined();
    expect(storage.getString(getChatThreadStorageKey(archivedThread.id))).toBe(archivedRecordBefore);
    expect(storage.getString(getChatThreadStorageKey(secondArchivedThread.id))).toBe(secondArchivedRecordBefore);

    jest.advanceTimersByTime(749);
    expect(storage.getString(getChatThreadStorageKey(activeThread.id))).toBeUndefined();
    expectNoStreamingProgressArtifacts(activeThread.id);

    flushPendingChatPersistenceWrites('background');
    expect(storage.getString(getChatThreadStorageKey(activeThread.id))).toBeUndefined();
    expect(readChatStreamingProgressRecord(storage, activeThread.id)).toEqual({
      ok: true,
      value: expect.objectContaining({ content: 'Streaming token' }),
    });
    expect(storage.getString(getChatThreadStorageKey(archivedThread.id))).toBe(archivedRecordBefore);
    expect(storage.getString(getChatThreadStorageKey(secondArchivedThread.id))).toBe(secondArchivedRecordBefore);

    useChatStore.getState().finalizeAssistantMessage(
      activeThread.id,
      'active-assistant-1',
      'Final answer',
    );

    expect(storage.getString(getChatThreadStorageKey(activeThread.id))).toContain('Final answer');
    expectNoStreamingProgressArtifacts(activeThread.id);
    expect(storage.getString(getChatThreadStorageKey(archivedThread.id))).toBe(archivedRecordBefore);
    expect(storage.getString(getChatThreadStorageKey(secondArchivedThread.id))).toBe(secondArchivedRecordBefore);
    jest.useRealTimers();
  });

  it('does not run attachment cleanup for streaming content patches when references are unchanged', async () => {
    const attachment = buildStoredAttachment('thread-streaming-attachment', 'user-1', 'streaming-kept.jpg');
    const thread: ChatThread = {
      ...buildThread('thread-streaming-attachment', 20),
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'Describe this image',
          createdAt: 20,
          state: 'complete',
          attachments: [attachment],
        },
        {
          id: 'assistant-1',
          role: 'assistant',
          content: '',
          createdAt: 21,
          state: 'streaming',
        },
      ],
      status: 'generating',
    };
    const cleanupSpy = jest
      .spyOn(chatAttachmentStorageService, 'deleteUnreferencedAttachmentFilesDetailed')
      .mockImplementation(reportAllAttachmentCleanupCandidatesDeleted);

    try {
      useChatStore.setState({
        threads: { [thread.id]: thread },
        activeThreadId: thread.id,
      });

      useChatStore.getState().patchAssistantMessage(thread.id, 'assistant-1', {
        content: 'Streaming token',
        state: 'streaming',
      });
      await flushAttachmentCleanup();

      expect(useChatStore.getState().getThread(thread.id)?.messages[0]?.attachments).toEqual([attachment]);
      expect(cleanupSpy).not.toHaveBeenCalled();
    } finally {
      cleanupSpy.mockRestore();
    }
  });

  it('persists activeModelId, model switches, and per-message model metadata across rehydration', async () => {
    const legacyThread: ChatThread = buildThread('thread-persist-switches', 10);

    storage.set(
      'chat-store',
      JSON.stringify({
        state: {
          threads: {
            [legacyThread.id]: legacyThread,
          },
          activeThreadId: legacyThread.id,
        },
        version: 0,
      }),
    );

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    const migratedBeforeSwitch = useChatStore.getState().getThread(legacyThread.id);
    expect(migratedBeforeSwitch?.activeModelId).toBe('author/model-q4');
    expect(migratedBeforeSwitch?.messages.at(0)).toEqual(
      expect.objectContaining({
        kind: 'message',
        modelId: 'author/model-q4',
      }),
    );

    useChatStore.getState().switchThreadModel(legacyThread.id, 'author/model-q8', 20);
    useChatStore.getState().switchThreadModel(legacyThread.id, 'author/model-q6', 30);
    useChatStore.getState().appendMessage(legacyThread.id, {
      id: 'user-after-switches',
      role: 'user',
      content: 'After switches',
      createdAt: 31,
      state: 'complete',
    });

    const afterSwitches = useChatStore.getState().getThread(legacyThread.id);
    expect(afterSwitches?.activeModelId).toBe('author/model-q6');
    expect(afterSwitches?.messages.filter((message) => message.kind === 'model_switch')).toHaveLength(2);
    expect(afterSwitches?.messages.find((message) => message.id === 'user-after-switches')).toEqual(
      expect.objectContaining({
        kind: 'message',
        modelId: 'author/model-q6',
      }),
    );
    expect(useChatStore.getState().getConversationIndex()[0]).toEqual(
      expect.objectContaining({
        id: legacyThread.id,
        modelId: 'author/model-q6',
        messageCount: 2,
        lastMessagePreview: 'After switches',
      }),
    );

    const persistedRecord = storage.getString(getChatThreadStorageKey(legacyThread.id));
    const persistedAnchor = storage.getString('chat-store');
    expect(persistedRecord).toContain('model_switch');
    expect(persistedRecord).toContain('author/model-q6');
    expect(persistedAnchor).not.toContain('model_switch');

    useChatStore.setState({ threads: {}, activeThreadId: null });
    await useChatStore.persist.rehydrate();

    const rehydrated = useChatStore.getState().getThread(legacyThread.id);
    expect(rehydrated?.activeModelId).toBe('author/model-q6');
    expect(rehydrated?.messages.filter((message) => message.kind === 'model_switch')).toHaveLength(2);
    expect(rehydrated?.messages.find((message) => message.id === 'user-after-switches')).toEqual(
      expect.objectContaining({
        kind: 'message',
        modelId: 'author/model-q6',
      }),
    );
    expect(useChatStore.getState().getConversationIndex()[0]).toEqual(
      expect.objectContaining({
        id: legacyThread.id,
        modelId: 'author/model-q6',
        messageCount: 2,
        lastMessagePreview: 'After switches',
      }),
    );
  });

  it('uses the visible assistant answer for conversation previews when thoughts are present', () => {
    const threadId = useChatStore.getState().createThread({
      modelId: 'author/model-q4',
      presetId: null,
      presetSnapshot: {
        id: null,
        name: 'Default',
        systemPrompt: 'You are helpful.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 1024,
        seed: null,
      },
    });

    useChatStore.getState().appendMessage(threadId, {
      id: 'user-1',
      role: 'user',
      content: 'Explain this',
      createdAt: 1,
      state: 'complete',
    });
    useChatStore.getState().appendMessage(threadId, {
      id: 'assistant-1',
      role: 'assistant',
      content: '<think>Hidden reasoning</think>\n\nVisible answer',
      createdAt: 2,
      state: 'complete',
    });

    expect(useChatStore.getState().getConversationIndex()[0]?.lastMessagePreview).toBe('Visible answer');
  });

  it('skips pure thought-only assistant messages when building conversation previews', () => {
    const threadId = useChatStore.getState().createThread({
      modelId: 'author/model-q4',
      presetId: null,
      presetSnapshot: {
        id: null,
        name: 'Default',
        systemPrompt: 'You are helpful.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 1024,
        seed: null,
      },
    });

    useChatStore.getState().appendMessage(threadId, {
      id: 'user-1',
      role: 'user',
      content: 'Explain this',
      createdAt: 1,
      state: 'complete',
    });
    useChatStore.getState().appendMessage(threadId, {
      id: 'assistant-1',
      role: 'assistant',
      content: '<think>Hidden reasoning only</think>',
      createdAt: 2,
      state: 'complete',
    });

    expect(useChatStore.getState().getConversationIndex()[0]?.lastMessagePreview).toBe('Explain this');
  });

  it('strips leading assistant thoughts from the inference window', () => {
    const thread: ChatThread = {
      id: 'thread-thoughts',
      title: 'Thought thread',
      modelId: 'author/model-q4',
      presetId: null,
      presetSnapshot: {
        id: null,
        name: 'Default',
        systemPrompt: 'You are helpful.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        topK: 40,
        minP: 0.05,
        repetitionPenalty: 1,
        maxTokens: 1024,
        seed: null,
      },
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'Explain this',
          createdAt: 1,
          state: 'complete',
        },
        {
          id: 'message-2',
          role: 'assistant',
          content: '<think>Hidden reasoning</think>\n\nVisible answer',
          createdAt: 2,
          state: 'complete',
        },
      ],
      createdAt: 1,
      updatedAt: 2,
      status: 'idle',
    };

    expect(getThreadInferenceWindow(thread, 24).messages).toEqual([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Explain this' },
      { role: 'assistant', content: 'Visible answer' },
    ]);
  });

  it('omits pure thought-only assistant turns from the inference window', () => {
    const thread: ChatThread = {
      id: 'thread-thoughts-only',
      title: 'Thought-only thread',
      modelId: 'author/model-q4',
      presetId: null,
      presetSnapshot: {
        id: null,
        name: 'Default',
        systemPrompt: 'You are helpful.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        topK: 40,
        minP: 0.05,
        repetitionPenalty: 1,
        maxTokens: 1024,
        seed: null,
      },
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'Explain this',
          createdAt: 1,
          state: 'complete',
        },
        {
          id: 'message-2',
          role: 'assistant',
          content: '<think>Hidden reasoning only</think>',
          createdAt: 2,
          state: 'complete',
        },
      ],
      createdAt: 1,
      updatedAt: 2,
      status: 'idle',
    };

    expect(getThreadInferenceWindow(thread, 24).messages).toEqual([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Explain this' },
    ]);
  });

  it('excludes model_switch system events from the inference window even when they have content', () => {
    const thread: ChatThread = {
      id: 'thread-model-switch-window',
      title: 'Switch thread',
      modelId: 'author/model-q4',
      presetId: null,
      presetSnapshot: {
        id: null,
        name: 'Default',
        systemPrompt: 'You are helpful.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        topK: 40,
        minP: 0.05,
        repetitionPenalty: 1,
        maxTokens: 1024,
        seed: null,
      },
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'Before',
          createdAt: 1,
          state: 'complete',
        },
        {
          id: 'switch-1',
          role: 'system',
          kind: 'model_switch',
          content: 'Model switched: q4 -> q8',
          modelId: 'author/model-q8',
          switchFromModelId: 'author/model-q4',
          switchToModelId: 'author/model-q8',
          createdAt: 2,
          state: 'complete',
        },
        {
          id: 'assistant-1',
          role: 'assistant',
          content: 'After',
          createdAt: 3,
          state: 'complete',
        },
      ],
      createdAt: 1,
      updatedAt: 3,
      status: 'idle',
    };

    expect(getThreadInferenceWindow(thread, 24).messages).toEqual([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Before' },
      { role: 'assistant', content: 'After' },
    ]);
  });

  it('keeps only the newest coherent turn when the response reserve squeezes prompt history', () => {
    const longMessage = 'A'.repeat(120);
    const thread: ChatThread = {
      id: 'thread-budget',
      title: 'Budget thread',
      modelId: 'author/model-q4',
      presetId: 'preset-1',
      presetSnapshot: {
        id: 'preset-1',
        name: 'Helpful Assistant',
        systemPrompt: 'Be concise.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        topK: 40,
        minP: 0.05,
        repetitionPenalty: 1,
        maxTokens: 70,
        seed: null,
      },
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: `${longMessage}-1`,
          createdAt: 1,
          state: 'complete',
        },
        {
          id: 'message-2',
          role: 'assistant',
          content: `${longMessage}-2`,
          createdAt: 2,
          state: 'complete',
        },
        {
          id: 'message-3',
          role: 'user',
          content: `${longMessage}-3`,
          createdAt: 3,
          state: 'complete',
        },
        {
          id: 'message-4',
          role: 'assistant',
          content: `${longMessage}-4`,
          createdAt: 4,
          state: 'complete',
        },
      ],
      createdAt: 1,
      updatedAt: 4,
      status: 'idle',
    };

    const { messages, truncatedMessageIds } = getThreadInferenceWindow(thread, {
      maxContextMessages: 24,
      maxContextTokens: 150,
      responseReserveTokens: 70,
      promptSafetyMarginTokens: 24,
    });

    expect(messages).toEqual([
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: `${longMessage}-3` },
      { role: 'assistant', content: `${longMessage}-4` },
    ]);
    expect(truncatedMessageIds).toEqual(['message-1', 'message-2']);
  });

  it('does not drop the last assistant message when the leading user message cannot fit the prompt budget', () => {
    const longUserMessage = 'A'.repeat(220);
    const thread: ChatThread = {
      id: 'thread-assistant-only-budget',
      title: 'Assistant-only budget thread',
      modelId: 'author/model-q4',
      presetId: 'preset-1',
      presetSnapshot: {
        id: 'preset-1',
        name: 'Helpful Assistant',
        systemPrompt: 'Be concise.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        topK: 40,
        minP: 0.05,
        repetitionPenalty: 1,
        maxTokens: 70,
        seed: null,
      },
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: longUserMessage,
          createdAt: 1,
          state: 'complete',
        },
        {
          id: 'message-2',
          role: 'assistant',
          content: 'ok',
          createdAt: 2,
          state: 'complete',
        },
      ],
      createdAt: 1,
      updatedAt: 2,
      status: 'idle',
    };

    const { messages, truncatedMessageIds } = getThreadInferenceWindow(thread, {
      maxContextMessages: 24,
      maxContextTokens: 19,
      responseReserveTokens: 0,
      promptSafetyMarginTokens: 0,
    });

    expect(messages).toEqual([
      { role: 'system', content: 'Be concise.' },
      { role: 'assistant', content: 'ok' },
    ]);
    expect(truncatedMessageIds).toEqual(['message-1']);
  });

  it('does not let a large response reserve evict short history from a roomy context window', () => {
    const thread: ChatThread = {
      id: 'thread-balanced-reserve',
      title: 'Balanced reserve thread',
      modelId: 'author/model-q4',
      presetId: 'preset-1',
      presetSnapshot: {
        id: 'preset-1',
        name: 'Helpful Assistant',
        systemPrompt: 'Be concise.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        topK: 40,
        minP: 0.05,
        repetitionPenalty: 1,
        maxTokens: 2048,
        seed: null,
      },
      messages: Array.from({ length: 12 }, (_, index) => ({
        id: `message-${index + 1}`,
        role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
        content: `m${index + 1}`,
        createdAt: index + 1,
        state: 'complete' as const,
      })),
      createdAt: 1,
      updatedAt: 12,
      status: 'idle',
    };

    const { messages, truncatedMessageIds } = getThreadInferenceWindow(thread, {
      maxContextMessages: 24,
      maxContextTokens: 2048,
      responseReserveTokens: 2048,
    });

    expect(messages).toEqual([
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'm1' },
      { role: 'assistant', content: 'm2' },
      { role: 'user', content: 'm3' },
      { role: 'assistant', content: 'm4' },
      { role: 'user', content: 'm5' },
      { role: 'assistant', content: 'm6' },
      { role: 'user', content: 'm7' },
      { role: 'assistant', content: 'm8' },
      { role: 'user', content: 'm9' },
      { role: 'assistant', content: 'm10' },
      { role: 'user', content: 'm11' },
      { role: 'assistant', content: 'm12' },
    ]);
    expect(truncatedMessageIds).toEqual([]);
  });
});

