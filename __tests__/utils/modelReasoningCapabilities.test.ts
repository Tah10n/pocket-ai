import {
  clampReasoningEnabled,
  normalizeReasoningPreference,
  resolveModelReasoningCapability,
} from '../../src/utils/modelReasoningCapabilities';

describe('modelReasoningCapabilities', () => {
  it('treats plain chat models as not supporting reasoning', () => {
    expect(resolveModelReasoningCapability({
      id: 'bartowski/gemma-2-2b-it-GGUF',
      name: 'gemma-2-2b-it-GGUF',
      modelType: 'gemma2',
      architectures: ['GemmaForCausalLM'],
      baseModels: ['google/gemma-2-2b-it'],
      tags: ['gguf', 'chat'],
    })).toEqual({
      supportsReasoning: false,
      requiresReasoning: false,
    });
  });

  it('treats Qwen3 models as supporting optional reasoning', () => {
    expect(resolveModelReasoningCapability({
      id: 'Qwen/Qwen3-4B-Instruct-GGUF',
      name: 'Qwen3-4B-Instruct-GGUF',
      modelType: 'qwen3',
      architectures: ['QwenForCausalLM'],
      baseModels: ['Qwen/Qwen3-4B-Instruct'],
      tags: ['gguf', 'chat'],
    })).toEqual({
      supportsReasoning: true,
      requiresReasoning: false,
    });
  });

  it('treats R1-family models as requiring reasoning', () => {
    expect(resolveModelReasoningCapability({
      id: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B-GGUF',
      name: 'DeepSeek-R1-Distill-Qwen-7B-GGUF',
      modelType: 'deepseek-r1',
      architectures: ['QwenForCausalLM'],
      baseModels: ['deepseek-ai/DeepSeek-R1'],
      tags: ['gguf', 'reasoning'],
    })).toEqual({
      supportsReasoning: true,
      requiresReasoning: true,
    });
  });

  it('treats missing model metadata as supporting optional reasoning', () => {
    expect(resolveModelReasoningCapability(undefined, 'author/model-q4', 'mystery-model')).toEqual({
      supportsReasoning: true,
      requiresReasoning: false,
    });
  });

  it('infers reasoning requirement from fallback labels when metadata is missing', () => {
    expect(resolveModelReasoningCapability(undefined, 'deepseek-ai/DeepSeek-R1', 'DeepSeek-R1')).toEqual({
      supportsReasoning: true,
      requiresReasoning: true,
    });
  });

  it('treats incomplete model metadata as supporting optional reasoning', () => {
    expect(resolveModelReasoningCapability({
      id: 'author/model-q4',
      name: 'custom-local-model',
    })).toEqual({
      supportsReasoning: true,
      requiresReasoning: false,
    });
  });

  it('treats modelType-only metadata as incomplete and supports optional reasoning', () => {
    expect(resolveModelReasoningCapability({
      id: 'author/model-q4',
      name: 'custom-local-model',
      modelType: 'mystery-model-type',
    })).toEqual({
      supportsReasoning: true,
      requiresReasoning: false,
    });
  });

  it('treats known non-reasoning model types as not supporting reasoning with sparse metadata', () => {
    expect(resolveModelReasoningCapability({
      id: 'bartowski/gemma-2-2b-it-GGUF',
      name: 'gemma-2-2b-it-GGUF',
      modelType: 'gemma2',
    })).toEqual({
      supportsReasoning: false,
      requiresReasoning: false,
    });
  });

  it('treats structured metadata without reasoning hints as not supporting reasoning', () => {
    expect(resolveModelReasoningCapability({
      id: 'author/vanilla-chat',
      name: 'vanilla-instruct',
      architectures: ['VanillaForCausalLM'],
      baseModels: ['author/vanilla-instruct'],
      tags: ['gguf', 'chat'],
    })).toEqual({
      supportsReasoning: false,
      requiresReasoning: false,
    });
  });

  it('clamps reasoning off for unsupported models', () => {
    const capability = { supportsReasoning: false, requiresReasoning: false };

    expect(clampReasoningEnabled(true, capability)).toBe(false);
    expect(normalizeReasoningPreference({ reasoningEnabled: true, topP: 0.9 }, capability)).toEqual({
      reasoningEnabled: false,
      topP: 0.9,
    });
  });

  it('clamps reasoning on for required models', () => {
    const capability = { supportsReasoning: true, requiresReasoning: true };

    expect(clampReasoningEnabled(false, capability)).toBe(true);
    expect(normalizeReasoningPreference({ reasoningEnabled: false, topP: 0.9 }, capability)).toEqual({
      reasoningEnabled: true,
      topP: 0.9,
    });
  });
});
