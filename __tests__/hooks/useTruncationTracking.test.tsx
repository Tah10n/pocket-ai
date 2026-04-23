import React, { useEffect } from 'react';
import { render, waitFor } from '@testing-library/react-native';
import { registry } from '../../src/services/LocalStorageRegistry';
import { useTruncationTracking } from '../../src/hooks/useTruncationTracking';
import { type ChatThread } from '../../src/types/chat';
import { createTruncationState, getThreadInferenceWindow, resolveThreadInferenceWindowOptions } from '../../src/utils/inferenceWindow';
import { resolveModelReasoningCapability, resolveReasoningRuntimeConfig } from '../../src/utils/modelReasoningCapabilities';

jest.mock('../../src/services/LocalStorageRegistry', () => ({
  registry: {
    getModel: jest.fn(),
  },
}));

jest.mock('../../src/hooks/useModelRegistryRevision', () => ({
  useModelRegistryRevision: () => 0,
}));

jest.mock('../../src/utils/inferenceWindow', () => {
  const actual = jest.requireActual('../../src/utils/inferenceWindow');

  return {
    ...actual,
    buildInferenceWindowWithAccurateTokenCounts: jest.fn(() => Promise.reject({ code: 'engine_busy' })),
  };
});

describe('useTruncationTracking', () => {
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
    (registry.getModel as jest.Mock).mockImplementation((modelId: string) => getMockModel(modelId));
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
});
