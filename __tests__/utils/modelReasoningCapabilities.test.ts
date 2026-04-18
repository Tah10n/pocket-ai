import {
  clampReasoningEffort,
  normalizeReasoningPreference,
  resolveReasoningRuntimeConfig,
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
      autoEffort: 'off',
      preferredReasoningFormat: 'auto',
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
      autoEffort: 'off',
      preferredReasoningFormat: 'auto',
    });
  });

  it('auto-enables moderate effort for explicit thinking Qwen3 variants', () => {
    expect(resolveModelReasoningCapability({
      id: 'mradermacher/ReD-Qwen3-4B-Thinking-Search-GGUF',
      name: 'ReD-Qwen3-4B-Thinking-Search-GGUF',
      modelType: 'qwen3',
      architectures: ['Qwen3ForCausalLM'],
      baseModels: ['jiulaikankan/ReD-Qwen3-4B-Thinking-Search'],
      tags: ['gguf', 'thinking'],
    })).toEqual({
      supportsReasoning: true,
      requiresReasoning: false,
      autoEffort: 'medium',
      preferredReasoningFormat: 'auto',
    });
  });

  it('treats explicit reasoning models as supporting optional reasoning', () => {
    expect(resolveModelReasoningCapability({
      id: 'mistralai/Ministral-3B-Reasoning-GGUF',
      name: 'Ministral-3B-Reasoning-GGUF',
      modelType: 'mistral',
      architectures: ['MistralForCausalLM'],
      baseModels: ['mistralai/Ministral-3B-Instruct'],
      tags: ['gguf', 'reasoning'],
    })).toEqual({
      supportsReasoning: true,
      requiresReasoning: false,
      autoEffort: 'medium',
      preferredReasoningFormat: 'auto',
    });
  });

  it('treats R1-family models as requiring reasoning by default', () => {
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
      autoEffort: 'medium',
      preferredReasoningFormat: 'deepseek',
    });
  });

  it('treats missing model metadata as not supporting reasoning', () => {
    expect(resolveModelReasoningCapability(undefined, 'author/model-q4', 'mystery-model')).toEqual({
      supportsReasoning: false,
      requiresReasoning: false,
      autoEffort: 'off',
      preferredReasoningFormat: 'auto',
    });
  });

  it('infers reasoning support from fallback labels when metadata is missing', () => {
    expect(resolveModelReasoningCapability(undefined, 'deepseek-ai/DeepSeek-R1', 'DeepSeek-R1')).toEqual({
      supportsReasoning: true,
      requiresReasoning: true,
      autoEffort: 'medium',
      preferredReasoningFormat: 'deepseek',
    });
  });

  it('treats QwQ-family models as requiring reasoning by default', () => {
    expect(resolveModelReasoningCapability({
      id: 'Qwen/QwQ-32B-GGUF',
      name: 'QwQ-32B-GGUF',
      tags: ['gguf', 'reasoning'],
    })).toEqual({
      supportsReasoning: true,
      requiresReasoning: true,
      autoEffort: 'medium',
      preferredReasoningFormat: 'auto',
    });
  });

  it('honors persisted thinking capability when it disallows disabling thinking', () => {
    expect(resolveModelReasoningCapability({
      id: 'author/thinking-model',
      name: 'thinking-model',
      tags: ['gguf', 'chat'],
      thinkingCapability: {
        detectedAt: Date.now(),
        supportsThinking: true,
        canDisableThinking: false,
        thinkingStartTag: '<think>',
        thinkingEndTag: '</think>',
      },
    })).toEqual({
      supportsReasoning: true,
      requiresReasoning: true,
      autoEffort: 'medium',
      preferredReasoningFormat: 'auto',
    });
  });

  it('treats incomplete model metadata as not supporting reasoning', () => {
    expect(resolveModelReasoningCapability({
      id: 'author/model-q4',
      name: 'custom-local-model',
    })).toEqual({
      supportsReasoning: false,
      requiresReasoning: false,
      autoEffort: 'off',
      preferredReasoningFormat: 'auto',
    });
  });

  it('treats modelType-only metadata as incomplete and does not support reasoning', () => {
    expect(resolveModelReasoningCapability({
      id: 'author/model-q4',
      name: 'custom-local-model',
      modelType: 'mystery-model-type',
    })).toEqual({
      supportsReasoning: false,
      requiresReasoning: false,
      autoEffort: 'off',
      preferredReasoningFormat: 'auto',
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
      autoEffort: 'off',
      preferredReasoningFormat: 'auto',
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
      autoEffort: 'off',
      preferredReasoningFormat: 'auto',
    });
  });

  it('clamps reasoning effort back to auto for unsupported models', () => {
    const capability = { supportsReasoning: false, requiresReasoning: false, autoEffort: 'off' as const, preferredReasoningFormat: 'auto' as const };
    const params = { reasoningEffort: 'high' as const, topP: 0.9 };

    expect(clampReasoningEffort('high', capability)).toBe('auto');
    expect(normalizeReasoningPreference(params, capability)).toEqual({
      reasoningEffort: 'auto',
      topP: 0.9,
    });
  });

  it('preserves explicit effort for reasoning-capable models', () => {
    const capability = { supportsReasoning: true, requiresReasoning: true, autoEffort: 'medium' as const, preferredReasoningFormat: 'auto' as const };
    const params = { reasoningEffort: 'high' as const, topP: 0.9 };

    expect(clampReasoningEffort('high', capability)).toBe('high');
    expect(normalizeReasoningPreference(params, capability)).toEqual({
      reasoningEffort: 'high',
      topP: 0.9,
    });
  });

  it('maps auto effort to a disabled runtime config for plain chat models', () => {
    const config = resolveReasoningRuntimeConfig({
      reasoningEffort: 'auto',
      capability: { supportsReasoning: false, requiresReasoning: false, autoEffort: 'off', preferredReasoningFormat: 'auto' },
      maxTokens: 512,
    });

    expect(config).toEqual({
      selectedEffort: 'auto',
      effectiveEffort: 'off',
      enableThinking: false,
      reasoningFormat: 'none',
      thinkingBudgetTokens: 0,
      responseReserveTokens: 512,
    });
  });

  it('maps medium effort to native thinking budget tokens', () => {
    const config = resolveReasoningRuntimeConfig({
      reasoningEffort: 'medium',
      capability: { supportsReasoning: true, requiresReasoning: false, autoEffort: 'off', preferredReasoningFormat: 'auto' },
      maxTokens: 512,
    });

    expect(config).toEqual({
      selectedEffort: 'medium',
      effectiveEffort: 'medium',
      enableThinking: true,
      reasoningFormat: 'auto',
      thinkingBudgetTokens: 384,
      responseReserveTokens: 896,
    });
  });

  it('uses deepseek reasoning format for DeepSeek R1 auto thinking', () => {
    const capability = resolveModelReasoningCapability(undefined, 'deepseek-ai/DeepSeek-R1', 'DeepSeek-R1');
    const config = resolveReasoningRuntimeConfig({
      reasoningEffort: 'auto',
      capability,
      maxTokens: 512,
    });

    expect(config.enableThinking).toBe(true);
    expect(config.reasoningFormat).toBe('deepseek');
  });

  it('allows turning reasoning fully off for optional reasoning models', () => {
    const capability = resolveModelReasoningCapability({
      id: 'Qwen/Qwen3-4B-Instruct-GGUF',
      name: 'Qwen3-4B-Instruct-GGUF',
      modelType: 'qwen3',
      architectures: ['QwenForCausalLM'],
      baseModels: ['Qwen/Qwen3-4B-Instruct'],
      tags: ['gguf', 'chat'],
    });

    expect(clampReasoningEffort('off', capability)).toBe('off');
    expect(resolveReasoningRuntimeConfig({ reasoningEffort: 'off', capability, maxTokens: 512 })).toEqual(expect.objectContaining({
      enableThinking: false,
      reasoningFormat: 'none',
      thinkingBudgetTokens: 0,
      responseReserveTokens: 512,
    }));
  });

  it('prevents turning reasoning off for required reasoning models', () => {
    const capability = resolveModelReasoningCapability({
      id: 'author/thinking-model',
      name: 'thinking-model',
      tags: ['gguf', 'chat'],
      thinkingCapability: {
        detectedAt: Date.now(),
        supportsThinking: true,
        canDisableThinking: false,
      },
    });
    expect(clampReasoningEffort('off', capability)).toBe('auto');
  });
});
