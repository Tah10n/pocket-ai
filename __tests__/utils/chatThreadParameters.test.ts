import type { GenerationParameters } from '../../src/services/SettingsStore';
import type { ChatThread } from '../../src/types/chat';
import { syncThreadParameters } from '../../src/utils/chatThreadParameters';

const mockGetGenerationParametersForModel = jest.fn();

jest.mock('../../src/services/SettingsStore', () => ({
  getGenerationParametersForModel: (modelId: string | null | undefined) => mockGetGenerationParametersForModel(modelId),
}));

function createParams(overrides: Partial<GenerationParameters> = {}): GenerationParameters {
  return {
    temperature: 0.7,
    topP: 0.9,
    topK: 40,
    minP: 0.05,
    repetitionPenalty: 1,
    maxTokens: 512,
    reasoningEffort: 'auto',
    seed: null,
    ...overrides,
  };
}

function createThread(overrides: Partial<ChatThread> = {}): ChatThread {
  return {
    id: 'thread-1',
    title: 'Thread 1',
    modelId: 'author/base-model',
    activeModelId: undefined,
    presetId: null,
    presetSnapshot: {
      id: null,
      name: 'Default',
      systemPrompt: '',
    },
    paramsSnapshot: createParams(),
    messages: [],
    createdAt: 1,
    updatedAt: 1,
    status: 'idle',
    ...overrides,
  };
}

describe('syncThreadParameters', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the same thread without persisting when parameters are unchanged', () => {
    const thread = createThread({
      paramsSnapshot: createParams({
        reasoningEffort: undefined,
        seed: null,
      }),
    });
    const nextParams = createParams({
      reasoningEffort: undefined,
      seed: null,
    });
    const updateThreadParamsSnapshot = jest.fn();

    const result = syncThreadParameters(thread, updateThreadParamsSnapshot, nextParams);

    expect(result).toBe(thread);
    expect(updateThreadParamsSnapshot).not.toHaveBeenCalled();
    expect(mockGetGenerationParametersForModel).not.toHaveBeenCalled();
  });

  it('loads model parameters from the active model and persists them when they changed', () => {
    const thread = createThread({
      modelId: 'author/base-model',
      activeModelId: 'author/active-model',
      paramsSnapshot: createParams({ maxTokens: 256, reasoningEffort: 'low' }),
    });
    const resolvedParams = createParams({ maxTokens: 1024, reasoningEffort: 'high', seed: 7 });
    const updateThreadParamsSnapshot = jest.fn();
    mockGetGenerationParametersForModel.mockReturnValue(resolvedParams);

    const result = syncThreadParameters(thread, updateThreadParamsSnapshot);

    expect(mockGetGenerationParametersForModel).toHaveBeenCalledWith('author/active-model');
    expect(updateThreadParamsSnapshot).toHaveBeenCalledWith('thread-1', resolvedParams);
    expect(result).toEqual({
      ...thread,
      paramsSnapshot: resolvedParams,
    });
  });
});
