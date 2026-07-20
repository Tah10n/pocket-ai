import React, { useEffect } from 'react';
import { act, render, waitFor } from '@testing-library/react-native';
import { registry } from '../../src/services/LocalStorageRegistry';
import { llmEngineService } from '../../src/services/LLMEngineService';
import { performanceMonitor } from '../../src/services/PerformanceMonitor';
import { exactPromptTokenCache } from '../../src/services/ExactPromptTokenCache';
import { useTruncationTracking } from '../../src/hooks/useTruncationTracking';
import { type ChatThread, type LlmChatMessage } from '../../src/types/chat';
import {
  buildInferenceWindowWithAccurateTokenCounts,
  createTruncationState,
  getThreadInferenceWindow,
  resolveThreadInferenceWindowOptions,
} from '../../src/utils/inferenceWindow';
import { resolveModelReasoningCapability, resolveReasoningRuntimeConfig } from '../../src/utils/modelReasoningCapabilities';
import { buildPerformanceThread } from '../fixtures/chatPerformanceFixtures';

jest.mock('../../src/services/LocalStorageRegistry', () => ({
  registry: {
    getModel: jest.fn(),
  },
}));

jest.mock('../../src/hooks/useModelRegistryRevision', () => ({
  useModelRegistryRevision: () => 0,
}));

jest.mock('../../src/services/LLMEngineService', () => ({
  llmEngineService: {
    countPromptTokens: jest.fn(),
    getPromptContextIdentity: jest.fn(),
    subscribe: jest.fn(),
  },
}));

jest.mock('../../src/utils/inferenceWindow', () => {
  const actual = jest.requireActual('../../src/utils/inferenceWindow');

  return {
    ...actual,
    buildInferenceWindowWithAccurateTokenCounts: jest.fn(() => Promise.reject({ code: 'engine_busy' })),
    getThreadInferenceWindow: jest.fn(actual.getThreadInferenceWindow),
  };
});

describe('useTruncationTracking', () => {
  let notifyEngineStateChange: (() => void) | undefined;

  function getMockModel(modelId: string) {
    if (modelId === 'author/model-q8') {
      return {
        id: 'author/model-q8',
        name: 'Qwen3-4B-Instruct-GGUF',
        modelType: 'qwen3',
        architectures: ['QwenForCausalLM'],
        tags: ['gguf', 'chat'],
      };
    }

    return {
      id: 'author/model-q4',
      name: 'Model Q4',
      tags: ['gguf', 'chat'],
    };
  }

  function buildThread(activeModelId?: string): ChatThread {
    const mediumMessage = 'A'.repeat(100);

    return {
      id: 'thread-1',
      title: 'Thread',
      modelId: 'author/model-q4',
      activeModelId,
      presetId: null,
      presetSnapshot: {
        id: null,
        name: 'Default',
        systemPrompt: 'Be concise.',
      },
      paramsSnapshot: {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 512,
        reasoningEffort: 'auto',
        seed: null,
      },
      messages: Array.from({ length: 28 }, (_, index) => ({
        id: `message-${index + 1}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `${mediumMessage}-${index + 1}`,
        createdAt: index + 1,
        state: 'complete',
      })),
      createdAt: 1,
      updatedAt: 2,
      status: 'idle',
    };
  }

  function renderHookHarness(activeThread: ChatThread | null, activeContextTokenBudget: number | undefined) {
    let currentValue: ReturnType<typeof useTruncationTracking> | null = null;

    const Harness = ({ thread, tokenBudget }: { thread: ChatThread | null; tokenBudget: number | undefined }) => {
      const value = useTruncationTracking(thread, tokenBudget);

      useEffect(() => {
        currentValue = value;
      }, [value]);

      return null;
    };

    const rendered = render(<Harness thread={activeThread} tokenBudget={activeContextTokenBudget} />);

    return {
      getState: () => currentValue,
      rerender: (thread: ChatThread | null, tokenBudget: number | undefined) => {
        rendered.rerender(<Harness thread={thread} tokenBudget={tokenBudget} />);
      },
    };
  }

  function getExpectedTruncationState(thread: ChatThread, budget: number) {
    const modelId = thread.activeModelId ?? thread.modelId;
    const model = getMockModel(modelId);
    const capability = resolveModelReasoningCapability(model, modelId, model?.name);
    const runtimeConfig = resolveReasoningRuntimeConfig({
      reasoningEffort: thread.paramsSnapshot.reasoningEffort,
      capability,
      maxTokens: thread.paramsSnapshot.maxTokens,
    });
    const { truncatedMessageIds } = getThreadInferenceWindow(thread, resolveThreadInferenceWindowOptions(thread, {
      maxContextTokens: budget,
      responseReserveTokens: runtimeConfig.responseReserveTokens,
    }));

    return createTruncationState(truncatedMessageIds);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    (buildInferenceWindowWithAccurateTokenCounts as jest.Mock)
      .mockReset()
      .mockRejectedValue({ code: 'engine_busy' });
    notifyEngineStateChange = undefined;
    performanceMonitor.clear();
    performanceMonitor.setEnabled(true);
    exactPromptTokenCache.clear();
    (registry.getModel as jest.Mock).mockImplementation((modelId: string) => getMockModel(modelId));
    (llmEngineService.countPromptTokens as jest.Mock).mockResolvedValue(64);
    (llmEngineService.getPromptContextIdentity as jest.Mock).mockReturnValue(
      'context-generation:1\u0001author/model-q4',
    );
    (llmEngineService.subscribe as jest.Mock).mockImplementation((listener: () => void) => {
      notifyEngineStateChange = listener;
      return () => {
        if (notifyEngineStateChange === listener) {
          notifyEngineStateChange = undefined;
        }
      };
    });
  });

  it('uses the active thread model when computing truncation state', async () => {
    const tokenBudget = 1600;
    const baseThread = buildThread('author/model-q4');
    const switchedThread = buildThread('author/model-q8');
    const expectedBaseState = getExpectedTruncationState(baseThread, tokenBudget);
    const expectedSwitchedState = getExpectedTruncationState(switchedThread, tokenBudget);
    const hook = renderHookHarness(switchedThread, tokenBudget);

    await waitFor(() => {
      expect(hook.getState()).toEqual(expectedSwitchedState);
    });
    expect(registry.getModel).toHaveBeenCalledWith('author/model-q8');

    hook.rerender(baseThread, tokenBudget);

    await waitFor(() => {
      expect(hook.getState()).toEqual(expectedBaseState);
    });
    expect(registry.getModel).toHaveBeenCalledWith('author/model-q4');
  });

  it('recomputes accurate truncation after same-model context recreation without a thread rerender', async () => {
    const buildAccurateWindow = buildInferenceWindowWithAccurateTokenCounts as jest.Mock;
    let probeRun = 0;
    buildAccurateWindow.mockImplementation(async (
      _thread: unknown,
      _options: unknown,
      countPromptTokens: (messages: LlmChatMessage[]) => Promise<number>,
    ) => {
      await countPromptTokens([{ role: 'user', content: 'Context identity probe' }]);
      probeRun += 1;
      const truncatedMessageIds = probeRun === 1
        ? ['message-1']
        : ['message-1', 'message-2'];
      return { messages: [], promptTokens: 64, promptSafetyMarginTokens: 0, truncatedMessageIds };
    });
    const thread = buildThread('author/model-q4');
    const hook = renderHookHarness(thread, 1600);

    await waitFor(() => {
      expect(hook.getState()).toEqual(createTruncationState(['message-1']));
      expect(llmEngineService.countPromptTokens).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      (llmEngineService.getPromptContextIdentity as jest.Mock).mockReturnValue(
        'context-generation:2\u0001author/model-q4',
      );
      notifyEngineStateChange?.();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(hook.getState()).toEqual(createTruncationState(['message-1', 'message-2']));
      expect(llmEngineService.countPromptTokens).toHaveBeenCalledTimes(2);
    });
  });

  it('reuses exact passive probe counts when only thread metadata changes', async () => {
    const buildAccurateWindow = buildInferenceWindowWithAccurateTokenCounts as jest.Mock;
    let probeRun = 0;
    buildAccurateWindow.mockImplementation(async (
      _thread: unknown,
      _options: unknown,
      countPromptTokens: (messages: LlmChatMessage[]) => Promise<number>,
    ) => {
      await countPromptTokens([{ role: 'user', content: 'Stable passive probe' }]);
      probeRun += 1;
      return {
        messages: [],
        promptTokens: 64,
        promptSafetyMarginTokens: 0,
        truncatedMessageIds: probeRun === 1 ? ['message-1'] : ['message-1', 'message-2'],
      };
    });
    const thread = buildThread('author/model-q4');
    const hook = renderHookHarness(thread, 1600);

    await waitFor(() => {
      expect(buildAccurateWindow).toHaveBeenCalledTimes(1);
      expect(llmEngineService.countPromptTokens).toHaveBeenCalledTimes(1);
      expect(hook.getState()).toEqual(createTruncationState(['message-1']));
    });

    await act(async () => {
      hook.rerender({ ...thread, updatedAt: thread.updatedAt + 1 }, 1600);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(buildAccurateWindow).toHaveBeenCalledTimes(2);
      expect(hook.getState()).toEqual(createTruncationState(['message-1', 'message-2']));
    });
    expect(llmEngineService.countPromptTokens).toHaveBeenCalledTimes(1);
  });

  it('marks passive accurate truncation probes as non-chat-blocking', async () => {
    const buildAccurateWindow = buildInferenceWindowWithAccurateTokenCounts as jest.Mock;
    buildAccurateWindow.mockImplementationOnce(async (
      _thread: unknown,
      _options: unknown,
      countPromptTokens: (messages: Array<{ role: 'user'; content: string }>) => Promise<number>,
    ) => {
      await countPromptTokens([{ role: 'user', content: 'Probe' }]);
      return { messages: [], promptTokens: 64, promptSafetyMarginTokens: 0, truncatedMessageIds: [] };
    });

    renderHookHarness(buildThread('author/model-q4'), 1600);

    await waitFor(() => {
      expect(llmEngineService.countPromptTokens).toHaveBeenCalledWith(expect.objectContaining({
        chatBlocking: false,
        allowMediaFallback: true,
      }));
    });
  });

  it('passes multimodal readiness and expected model id to passive media token probes', async () => {
    const readiness = {
      modelId: 'author/model-q4',
      status: 'ready',
      projectorId: 'author/model-q4-mmproj',
      support: ['vision'],
      checkedAt: 1,
    };
    (registry.getModel as jest.Mock).mockImplementation((modelId: string) => ({
      ...getMockModel(modelId),
      multimodalReadiness: readiness,
    }));
    const buildAccurateWindow = buildInferenceWindowWithAccurateTokenCounts as jest.Mock;
    buildAccurateWindow.mockImplementationOnce(async (
      _thread: unknown,
      _options: unknown,
      countPromptTokens: (messages: Array<{ role: 'user'; content: string; mediaPaths?: string[] }>) => Promise<number>,
    ) => {
      await countPromptTokens([{ role: 'user', content: 'Probe image', mediaPaths: ['file:///chat-attachments/image.jpg'] }]);
      return { messages: [], promptTokens: 64, promptSafetyMarginTokens: 0, truncatedMessageIds: [] };
    });

    renderHookHarness(buildThread('author/model-q4'), 1600);

    await waitFor(() => {
      expect(llmEngineService.countPromptTokens).toHaveBeenCalledWith(expect.objectContaining({
        expectedModelId: 'author/model-q4',
        multimodalReadiness: readiness,
        chatBlocking: false,
        allowMediaFallback: true,
      }));
    });
  });

  it('passes cancellation control to stale accurate truncation probes', async () => {
    const buildAccurateWindow = buildInferenceWindowWithAccurateTokenCounts as jest.Mock;
    let firstProbeControl: { throwIfCancelled?: () => void } | undefined;
    buildAccurateWindow.mockImplementationOnce(async (
      _thread: unknown,
      _options: unknown,
      _countPromptTokens: unknown,
      control: { throwIfCancelled?: () => void },
    ) => {
      firstProbeControl = control;
      return new Promise(() => undefined);
    });

    const hook = renderHookHarness(buildThread('author/model-q4'), 1600);

    await waitFor(() => {
      expect(firstProbeControl?.throwIfCancelled).toEqual(expect.any(Function));
    });

    hook.rerender(buildThread('author/model-q8'), 1600);

    expect(() => firstProbeControl?.throwIfCancelled?.()).toThrow('Accurate truncation probe was cancelled.');
  });

  it('does not traverse 1000-message history during streaming patches and recounts once at terminal state', async () => {
    const getWindow = getThreadInferenceWindow as jest.MockedFunction<typeof getThreadInferenceWindow>;
    const idleThread = buildPerformanceThread({ historicalMessageCount: 1000 });
    const hook = renderHookHarness(idleThread, 4096);

    await waitFor(() => {
      expect(getWindow).toHaveBeenCalled();
    });
    const callsAfterIdle = getWindow.mock.calls.length;
    const historicalMessages = idleThread.messages;
    const streamingAssistant = {
      id: 'message-streaming-assistant',
      role: 'assistant' as const,
      content: '',
      createdAt: idleThread.updatedAt + 1,
      state: 'streaming' as const,
      modelId: idleThread.activeModelId,
    };
    let generatingThread: ChatThread = {
      ...idleThread,
      status: 'generating',
      updatedAt: idleThread.updatedAt + 1,
      messages: [...historicalMessages, streamingAssistant],
    };

    hook.rerender(generatingThread, 4096);
    expect(getWindow).toHaveBeenCalledTimes(callsAfterIdle);

    for (let patchIndex = 1; patchIndex <= 100; patchIndex += 1) {
      generatingThread = {
        ...generatingThread,
        updatedAt: generatingThread.updatedAt + 1,
        messages: [
          ...historicalMessages,
          {
            ...streamingAssistant,
            content: `stream-patch-${patchIndex}`,
          },
        ],
      };
      hook.rerender(generatingThread, 4096);
    }

    expect(getWindow).toHaveBeenCalledTimes(callsAfterIdle);

    const terminalThread: ChatThread = {
      ...generatingThread,
      status: 'idle',
      updatedAt: generatingThread.updatedAt + 1,
      messages: [
        ...historicalMessages,
        {
          ...streamingAssistant,
          content: 'terminal assistant response',
          state: 'complete',
        },
      ],
    };
    hook.rerender(terminalThread, 4096);

    await waitFor(() => {
      expect(getWindow).toHaveBeenCalledTimes(callsAfterIdle + 1);
    });

    const performanceSnapshot = performanceMonitor.snapshot();
    expect(performanceSnapshot.counters['chat.stream.historyTraversal'] ?? 0).toBe(0);
    expect(performanceSnapshot.events.filter((event) => event.name === 'chat.prompt.window.heuristic')).toHaveLength(2);
  });
});
