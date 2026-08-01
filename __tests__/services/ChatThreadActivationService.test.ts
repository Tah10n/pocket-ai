jest.mock('../../src/services/SettingsStore', () => ({
  getGenerationParametersForModel: jest.fn(),
}));

jest.mock('../../src/services/LLMEngineService', () => ({
  llmEngineService: {
    cancelActiveContextOperations: jest.fn().mockResolvedValue('drained'),
    hasActiveCompletion: jest.fn().mockReturnValue(false),
    interruptActiveCompletion: jest.fn().mockResolvedValue(undefined),
    stopCompletion: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../../src/services/BackgroundTaskService', () => ({
  backgroundTaskService: {
    isTaskActive: jest.fn().mockReturnValue(false),
    stopBackgroundTask: jest.fn().mockResolvedValue(undefined),
  },
}));

import { activateThreadForNavigation } from '../../src/services/ChatThreadActivationService';
import * as ChatGenerationService from '../../src/services/ChatGenerationService';
import { getGenerationParametersForModel } from '../../src/services/SettingsStore';
import { getChatThreadStorageKey } from '../../src/store/chatPersistence';
import {
  flushPendingChatPersistenceWrites,
  useChatStore,
} from '../../src/store/chatStore';
import { getAppStorage, storage } from '../../src/store/storage';

const STORED_PARAMS = {
  temperature: 0.7,
  topP: 0.9,
  topK: 40,
  minP: 0.05,
  repetitionPenalty: 1,
  maxTokens: 1024,
  reasoningEffort: 'auto' as const,
  seed: null,
};

const SYNCHRONIZED_PARAMS = {
  temperature: 0.25,
  topP: 0.8,
  topK: 24,
  minP: 0.02,
  repetitionPenalty: 1.1,
  maxTokens: 1536,
  reasoningEffort: 'high' as const,
  seed: 7,
};

function createThread(modelId = 'author/model-q4'): string {
  return useChatStore.getState().createThread({
    modelId,
    presetId: null,
    presetSnapshot: {
      id: null,
      name: 'Default',
      systemPrompt: 'You are helpful.',
    },
    paramsSnapshot: STORED_PARAMS,
  });
}

function setThreadStatus(threadId: string, status: 'idle' | 'generating'): void {
  const state = useChatStore.getState();
  const thread = state.threads[threadId];
  useChatStore.setState({
    threads: {
      ...state.threads,
      [threadId]: {
        ...thread,
        status,
      },
    },
  });
}

describe('ChatThreadActivationService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    flushPendingChatPersistenceWrites('background');
    useChatStore.setState({
      threads: {},
      activeThreadId: null,
      inferenceRevision: 0,
    });
    storage.getAllKeys().forEach((key) => storage.remove(key));
    ChatGenerationService.__resetChatGenerationServiceForTests();
    (getGenerationParametersForModel as jest.Mock).mockReturnValue(
      SYNCHRONIZED_PARAMS,
    );
  });

  afterEach(() => {
    ChatGenerationService.__resetChatGenerationServiceForTests();
  });

  it('opens an idle existing thread and synchronizes its parameters atomically', () => {
    const threadA = createThread();
    const threadB = createThread();
    useChatStore.getState().setActiveThread(threadA);
    const revisionBefore = useChatStore.getState().inferenceRevision;

    expect(activateThreadForNavigation(threadB)).toEqual({
      status: 'opened',
      threadId: threadB,
    });

    const state = useChatStore.getState();
    expect(state.activeThreadId).toBe(threadB);
    expect(state.threads[threadB].paramsSnapshot).toEqual(SYNCHRONIZED_PARAMS);
    expect(state.inferenceRevision).toBe(revisionBefore + 1);
  });

  it('returns already_active without invoking the persistence command', () => {
    const threadId = createThread();
    const state = useChatStore.getState();
    const commitSpy = jest.spyOn(state, 'commitThreadActivation');
    const revisionBefore = state.inferenceRevision;

    try {
      expect(activateThreadForNavigation(threadId)).toEqual({
        status: 'already_active',
        threadId,
      });
      expect(commitSpy).not.toHaveBeenCalled();
      expect(useChatStore.getState().inferenceRevision).toBe(revisionBefore);
    } finally {
      commitSpy.mockRestore();
    }
  });

  it('returns missing without changing the active thread', () => {
    const threadA = createThread();

    expect(activateThreadForNavigation('missing-thread')).toEqual({
      status: 'missing',
    });
    expect(useChatStore.getState().activeThreadId).toBe(threadA);
  });

  it('blocks cross-thread activation when the active thread is persisted as generating', () => {
    const threadA = createThread();
    const threadB = createThread();
    useChatStore.getState().setActiveThread(threadA);
    setThreadStatus(threadA, 'generating');
    const targetBefore = useChatStore.getState().threads[threadB];

    expect(activateThreadForNavigation(threadB)).toEqual({
      status: 'generation_busy',
    });
    expect(useChatStore.getState().activeThreadId).toBe(threadA);
    expect(useChatStore.getState().threads[threadB]).toBe(targetBefore);
  });

  it('blocks cross-thread activation during pre-native generation work', () => {
    const threadA = createThread();
    const threadB = createThread();
    useChatStore.getState().setActiveThread(threadA);
    const work = ChatGenerationService.beginChatGenerationWork(
      'activation_pre_native',
    );

    try {
      expect(useChatStore.getState().threads[threadA].status).toBe('idle');
      expect(activateThreadForNavigation(threadB)).toEqual({
        status: 'generation_busy',
      });
      expect(useChatStore.getState().activeThreadId).toBe(threadA);
    } finally {
      work.finish();
    }
  });

  it('blocks cross-thread activation while native completion is registered', () => {
    const threadA = createThread();
    const threadB = createThread();
    useChatStore.getState().setActiveThread(threadA);
    const unregister = ChatGenerationService.registerActiveChatGenerationStop({
      hasNativeCompletion: () => true,
      stop: jest.fn().mockResolvedValue(undefined),
    });

    try {
      expect(activateThreadForNavigation(threadB)).toEqual({
        status: 'generation_busy',
      });
      expect(useChatStore.getState().activeThreadId).toBe(threadA);
    } finally {
      unregister();
    }
  });

  it('blocks cross-thread activation while stop and terminal drain are settling', async () => {
    const threadA = createThread();
    const threadB = createThread();
    useChatStore.getState().setActiveThread(threadA);
    let resolveStop!: () => void;
    const stopDeferred = new Promise<void>((resolve) => {
      resolveStop = resolve;
    });
    const unregister = ChatGenerationService.registerActiveChatGenerationStop({
      hasNativeCompletion: () => false,
      stop: () => stopDeferred,
    });
    const stopPromise = ChatGenerationService.stopAllGenerationWork();
    unregister();

    expect(activateThreadForNavigation(threadB)).toEqual({
      status: 'generation_busy',
    });
    expect(useChatStore.getState().activeThreadId).toBe(threadA);

    resolveStop();
    await expect(stopPromise).resolves.toBe('drained');
  });

  it('rolls active thread, target parameters, and inference revision back on persistence failure', () => {
    const threadA = createThread();
    const threadB = createThread();
    useChatStore.getState().setActiveThread(threadA);
    const targetBefore = useChatStore.getState().threads[threadB];
    const revisionBefore = useChatStore.getState().inferenceRevision;
    const appStorage = getAppStorage() as unknown as { set: jest.Mock };
    const originalSet = appStorage.set;
    const writeError = new Error('simulated activation persistence failure');
    let didFail = false;
    appStorage.set = jest.fn(function setWithFailure(
      this: unknown,
      key: string,
      value: unknown,
    ) {
      if (!didFail && key === getChatThreadStorageKey(threadB)) {
        didFail = true;
        throw writeError;
      }
      return originalSet.call(this, key, value);
    });

    try {
      expect(activateThreadForNavigation(threadB)).toEqual({
        status: 'persistence_failed',
        error: writeError,
      });
    } finally {
      appStorage.set = originalSet;
    }

    const state = useChatStore.getState();
    expect(didFail).toBe(true);
    expect(state.activeThreadId).toBe(threadA);
    expect(state.threads[threadB]).toBe(targetBefore);
    expect(state.inferenceRevision).toBe(revisionBefore);
  });

  it('returns stale when the active thread changes between guard and commit', () => {
    const threadA = createThread();
    const threadB = createThread();
    const threadC = createThread();
    useChatStore.getState().setActiveThread(threadA);
    const targetBefore = useChatStore.getState().threads[threadB];
    const guardSpy = jest.spyOn(
      ChatGenerationService,
      'hasActiveChatGenerationWork',
    ).mockImplementationOnce(() => {
      useChatStore.getState().setActiveThread(threadC);
      return false;
    });

    try {
      expect(activateThreadForNavigation(threadB)).toEqual({
        status: 'stale',
      });
    } finally {
      guardSpy.mockRestore();
    }

    expect(useChatStore.getState().activeThreadId).toBe(threadC);
    expect(useChatStore.getState().threads[threadB]).toBe(targetBefore);
  });

  it('allows reopening the active generating thread without changing generation state', () => {
    const threadA = createThread();
    setThreadStatus(threadA, 'generating');
    const work = ChatGenerationService.beginChatGenerationWork(
      'activation_same_thread',
    );
    const stateBefore = useChatStore.getState();
    const targetBefore = stateBefore.threads[threadA];

    try {
      expect(activateThreadForNavigation(threadA)).toEqual({
        status: 'already_active',
        threadId: threadA,
      });
      const stateAfter = useChatStore.getState();
      expect(stateAfter.activeThreadId).toBe(threadA);
      expect(stateAfter.threads[threadA]).toBe(targetBefore);
      expect(stateAfter.inferenceRevision).toBe(stateBefore.inferenceRevision);
      expect(ChatGenerationService.hasActiveChatGenerationWork()).toBe(true);
    } finally {
      work.finish();
    }
  });
});
