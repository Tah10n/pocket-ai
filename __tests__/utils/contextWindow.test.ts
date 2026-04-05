import {
  CONTEXT_WINDOW_STEP_TOKENS,
  MIN_CONTEXT_WINDOW_TOKENS,
  resolveContextWindowCeiling,
  clampContextWindowTokens,
} from '../../src/utils/contextWindow';
import { estimateAccurateMemoryFit } from '../../src/memory/estimator';

describe('contextWindow utilities', () => {
  it('respects the model-reported context ceiling', () => {
    expect(resolveContextWindowCeiling({
      modelMaxContextTokens: 4096,
      totalMemoryBytes: 8 * 1024 * 1024 * 1024,
      input: {
        modelSizeBytes: 512 * 1024 * 1024,
        verifiedFileSizeBytes: 512 * 1024 * 1024,
        metadataTrust: 'verified_local',
        ggufMetadata: {
          architecture: 'llama',
          n_layers: 32,
          n_head_kv: 8,
          n_embd_head_k: 64,
          n_embd_head_v: 64,
        },
        runtimeParams: {
          gpuLayers: 0,
          cacheTypeK: 'f16',
          cacheTypeV: 'f16',
          useMmap: true,
        },
      },
    })).toBe(4096);
  });

  it('reduces the ceiling when the effective budget is tighter than the model limit', () => {
    const totalMemoryBytes = 8 * 1024 * 1024 * 1024;
    const modelSizeBytes = 4 * 1024 * 1024 * 1024;

    const ceiling = resolveContextWindowCeiling({
      modelMaxContextTokens: 8192,
      totalMemoryBytes,
      input: {
        modelSizeBytes,
        verifiedFileSizeBytes: modelSizeBytes,
        metadataTrust: 'verified_local',
        ggufMetadata: {
          architecture: 'llama',
          n_layers: 32,
          n_head_kv: 16,
          n_embd_head_k: 128,
          n_embd_head_v: 128,
        },
        runtimeParams: {
          gpuLayers: 0,
          cacheTypeK: 'f16',
          cacheTypeV: 'f16',
          useMmap: true,
        },
      },
    });

    expect(ceiling).toBeGreaterThanOrEqual(MIN_CONTEXT_WINDOW_TOKENS);
    expect(ceiling).toBeLessThan(8192);

    const fitAtCeiling = estimateAccurateMemoryFit({
      input: {
        modelSizeBytes,
        verifiedFileSizeBytes: modelSizeBytes,
        metadataTrust: 'verified_local',
        ggufMetadata: {
          architecture: 'llama',
          n_layers: 32,
          n_head_kv: 16,
          n_embd_head_k: 128,
          n_embd_head_v: 128,
        },
        runtimeParams: {
          contextTokens: ceiling,
          gpuLayers: 0,
          cacheTypeK: 'f16',
          cacheTypeV: 'f16',
          useMmap: true,
        },
      },
      totalMemoryBytes,
    });

    expect(fitAtCeiling.requiredBytes).toBeLessThanOrEqual(fitAtCeiling.effectiveBudgetBytes);
    expect(fitAtCeiling.decision).toMatch(/^fits_/);

    const nextTokens = ceiling + CONTEXT_WINDOW_STEP_TOKENS;
    if (nextTokens <= 8192) {
      const fitAbove = estimateAccurateMemoryFit({
        input: {
          modelSizeBytes,
          verifiedFileSizeBytes: modelSizeBytes,
          metadataTrust: 'verified_local',
          ggufMetadata: {
            architecture: 'llama',
            n_layers: 32,
            n_head_kv: 16,
            n_embd_head_k: 128,
            n_embd_head_v: 128,
          },
          runtimeParams: {
            contextTokens: nextTokens,
            gpuLayers: 0,
            cacheTypeK: 'f16',
            cacheTypeV: 'f16',
            useMmap: true,
          },
        },
        totalMemoryBytes,
      });

      expect(fitAbove.decision).toMatch(/^(borderline|likely_oom)$/);
    }
  });

  it('allows ceilings above 8192 when the model and budget support it', () => {
    expect(resolveContextWindowCeiling({
      modelMaxContextTokens: 32768,
      totalMemoryBytes: 12 * 1024 * 1024 * 1024,
      input: {
        modelSizeBytes: 512 * 1024 * 1024,
        verifiedFileSizeBytes: 512 * 1024 * 1024,
        metadataTrust: 'verified_local',
        ggufMetadata: {
          architecture: 'llama',
          n_layers: 32,
          n_head_kv: 8,
          n_embd_head_k: 64,
          n_embd_head_v: 64,
        },
        runtimeParams: {
          gpuLayers: 0,
          cacheTypeK: 'f16',
          cacheTypeV: 'f16',
          useMmap: true,
        },
      },
    })).toBe(32768);
  });

  it('clamps requested values down to the resolved ceiling', () => {
    expect(clampContextWindowTokens(8192, 4096)).toBe(4096);
    expect(clampContextWindowTokens(3000, 4096)).toBe(2560);
  });
});
