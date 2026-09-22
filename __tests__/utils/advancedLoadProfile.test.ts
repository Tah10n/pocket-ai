import type { ContextParams } from 'llama.rn';
import {
  assertAdvancedLoadParameterCombinations, buildAdvancedNativeLoadParams,
  getAdvancedLoadProfileIdentity, getLoraAdapterMemoryBytes, sanitizeAdvancedLoadParameters,
  type LoraProfileAdapter,
} from '../../src/utils/advancedLoadProfile';
import { resolveKvCacheTypes } from '../../src/utils/kvCache';
import { estimateAccurateMemoryFit } from '../../src/memory/estimator';
import { createCalibrationKey } from '../../src/memory/calibration';

const adapter: LoraProfileAdapter = {
  artifactId: 'adapter', artifactIdentity: 'sha:adapter', baseModelIdentity: 'model:variant-a', scale: 1, sizeBytes: 2000,
};

describe('advanced load profile', () => {
  it('keeps legacy settings absent and preserves meaningful zero, false and empty arrays', () => {
    expect(sanitizeAdvancedLoadParameters({ contextSize: 1024 })).toEqual({});
    const value = { ropeFreqBase: 0, ropeFreqScale: 0, noExtraBufts: false, swaFull: false,
      nCpuMoe: 0, specDraftNMin: 0, specDraftPMin: 0, specDraftPSplit: 0, loraAdapters: [] };
    expect(sanitizeAdvancedLoadParameters(value)).toEqual(value);
    expect(getAdvancedLoadProfileIdentity(value)).not.toBe(getAdvancedLoadProfileIdentity({}));
  });

  it('rejects invalid scalars, unsupported cache types and malformed adapter lists', () => {
    expect(sanitizeAdvancedLoadParameters({ cacheTypeK: 'bf16', ropeFreqScale: -1,
      specDraftPMin: 2, specDraftNMax: 1.5, nCpuMoe: Infinity, noExtraBufts: 1,
      loraAdapters: [adapter, adapter] })).toEqual({});
    expect(sanitizeAdvancedLoadParameters({ loraAdapters: [{ ...adapter, scale: NaN }] })).toEqual({});
    expect(() => assertAdvancedLoadParameterCombinations({ specDraftNMax: 0 }, true)).toThrow();
    expect(() => assertAdvancedLoadParameterCombinations({ specDraftNMax: 2, specDraftNMin: 3 })).toThrow();
  });

  it('maps declared native fields without aliases or resource paths', () => {
    const mapped = buildAdvancedNativeLoadParams({ cacheTypeK: 'q5_1', ropeFreqBase: 0,
      ropeFreqScale: 2, noExtraBufts: false, swaFull: true, nCpuMoe: 2, specDraftNMax: 3,
      specDraftNMin: 0, specDraftPMin: 0, specDraftPSplit: 0.5, specDraftNGpuLayers: 0,
      specDraftCacheTypeK: 'f16', specDraftCacheTypeV: 'f32', loraAdapters: [adapter] });
    const declared: Partial<ContextParams> = mapped;
    expect(declared).toEqual({ rope_freq_base: 0, rope_freq_scale: 2, no_extra_bufts: false,
      swa_full: true, n_cpu_moe: 2, spec_draft_n_max: 3, spec_draft_n_min: 0,
      spec_draft_p_min: 0, spec_draft_p_split: 0.5, spec_draft_n_gpu_layers: 0,
      spec_draft_cache_type_k: 'f16', spec_draft_cache_type_v: 'f32' });
  });

  it('resolves explicit K/V independently over the legacy common preference', () => {
    expect(resolveKvCacheTypes({ kvCacheType: 'q8_0', requestedContextTokens: 1024, cacheTypeK: 'f32' }))
      .toEqual({ cacheTypeK: 'f32', cacheTypeV: 'q8_0' });
    expect(resolveKvCacheTypes({ kvCacheType: 'f16', requestedContextTokens: 1024, cacheTypeV: 'iq4_nl' }))
      .toEqual({ cacheTypeK: 'f16', cacheTypeV: 'iq4_nl' });
  });

  it('identifies ordered adapters and scales without retaining caller-owned arrays', () => {
    const second = { ...adapter, artifactId: 'second' };
    const first = getAdvancedLoadProfileIdentity({ loraAdapters: [adapter, second] });
    expect(first).not.toBe(getAdvancedLoadProfileIdentity({ loraAdapters: [second, adapter] }));
    expect(first).not.toBe(getAdvancedLoadProfileIdentity({ loraAdapters: [{ ...adapter, scale: 0 }, second] }));
    const result = sanitizeAdvancedLoadParameters({ loraAdapters: [adapter] });
    result.loraAdapters![0].scale = 0;
    expect(adapter.scale).toBe(1);
    expect(getLoraAdapterMemoryBytes([adapter, second])).toBe(4000);
    expect(getLoraAdapterMemoryBytes([{ ...adapter, scale: 0, sizeBytes: undefined }])).toBeNull();
    expect(getLoraAdapterMemoryBytes([])).toBe(0);
  });

  it('keeps unknown LoRA allocation unknown and includes resident bytes under mmap', () => {
    const input = { modelSizeBytes: 1_000_000_000, verifiedFileSizeBytes: 1_000_000_000,
      metadataTrust: 'verified_local' as const, runtimeParams: { use_mmap: true } };
    const base = estimateAccurateMemoryFit({ input, totalMemoryBytes: 8_000_000_000 });
    const adapted = estimateAccurateMemoryFit({ input: { ...input, loraSizeBytes: 100_000_000 }, totalMemoryBytes: 8_000_000_000 });
    expect(adapted.breakdown.overheadBytes - base.breakdown.overheadBytes).toBe(100_000_000);
    expect(estimateAccurateMemoryFit({ input: { ...input, loraSizeBytes: null }, totalMemoryBytes: 8_000_000_000 }).decision).toBe('unknown');
  });

  it('budgets scale metadata in quantized K/V blocks independently', () => {
    const result = estimateAccurateMemoryFit({ totalMemoryBytes: 8_000_000_000, input: {
      modelSizeBytes: 1000, metadataTrust: 'verified_local',
      ggufMetadata: { 'general.architecture': 'llama', 'llama.block_count': 1,
        'llama.attention.head_count': 1, 'llama.attention.head_count_kv': 1,
        'llama.embedding_length': 32 },
      runtimeParams: { n_ctx: 32, cache_type_k: 'q4_1', cache_type_v: 'q8_0' },
    } });
    // Each token has one 32-element key (20 bytes) and value (34 bytes).
    expect(result.breakdown.kvCacheBytes).toBe(32 * (20 + 34));
  });

  it('separates calibration evidence for new allocations', () => {
    const input = { deviceModel: 'test', osMajor: '36', verifiedFileSizeBytes: 1000,
      contextTokens: 1024, gpuLayers: 0, cacheTypeK: 'f16', cacheTypeV: 'f16', useMmap: true,
      hasMmproj: false, stateCacheBudgetMb: 0, stateCacheMaxCheckpoints: 8, stateCachePolicyVersion: 1 };
    const allocationIdentity = getAdvancedLoadProfileIdentity({ loraAdapters: [adapter] });
    expect(createCalibrationKey({ ...input, allocationIdentity })).not.toEqual(createCalibrationKey(input));
    expect(createCalibrationKey({ ...input, allocationIdentity })?.allocationIdentity).toBe(allocationIdentity);
  });
});
