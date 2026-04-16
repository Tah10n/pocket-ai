import { createStorage } from '../../src/services/storage';
import {
  DEFAULT_AUTOTUNE_MAX_AGE_MS,
  getCurrentNativeModuleVersion,
  readAutotuneResult,
  readBestStableAutotuneProfile,
  writeAutotuneResult,
} from '../../src/services/InferenceAutotuneStore';

function clearAutotuneStorage() {
  createStorage('pocket-ai-autotune', { tier: 'private' }).clearAll();
}

describe('InferenceAutotuneStore', () => {
  const nativeVersion = getCurrentNativeModuleVersion();
  let dateNowSpy: jest.SpyInstance | null = null;

  beforeEach(() => {
    clearAutotuneStorage();
    dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
  });

  afterEach(() => {
    dateNowSpy?.mockRestore();
    dateNowSpy = null;
  });

  it('returns null when no autotune result exists', () => {
    expect(readAutotuneResult({
      modelId: 'test/model',
      contextSize: 4096,
      kvCacheType: 'auto',
    })).toBeNull();
  });

  it('round-trips autotune results and stamps native version', () => {
    const payload = {
      createdAtMs: 1_700_000_000_000,
      modelId: 'test/model',
      contextSize: 4096,
      kvCacheType: 'f16',
      bestStable: { backendMode: 'gpu' as const, nGpuLayers: 12, devices: ['Adreno GPU'] },
      candidates: [],
    };

    writeAutotuneResult(payload);

    expect(readAutotuneResult({
      modelId: 'test/model',
      contextSize: 4096,
      kvCacheType: 'f16',
    })).toEqual({
      ...payload,
      nativeModuleVersion: nativeVersion,
    });
  });

  it('rejects results when the model signature does not match', () => {
    writeAutotuneResult({
      createdAtMs: 1_700_000_000_000,
      modelId: 'test/model',
      contextSize: 4096,
      kvCacheType: 'f16',
      modelFileSizeBytes: 2048,
      modelSha256: 'deadbeef',
      bestStable: { backendMode: 'gpu', nGpuLayers: 12 },
      candidates: [],
    });

    expect(readAutotuneResult({
      modelId: 'test/model',
      contextSize: 4096,
      kvCacheType: 'f16',
      modelFileSizeBytes: 1024,
    })).toBeNull();

    expect(readAutotuneResult({
      modelId: 'test/model',
      contextSize: 4096,
      kvCacheType: 'f16',
      modelSha256: 'cafebabe',
    })).toBeNull();

    expect(readAutotuneResult({
      modelId: 'test/model',
      contextSize: 4096,
      kvCacheType: 'f16',
      modelFileSizeBytes: 2048,
      modelSha256: 'deadbeef',
    })).toEqual(expect.objectContaining({
      modelFileSizeBytes: 2048,
      modelSha256: 'deadbeef',
    }));
  });

  it('rejects stale results past maxAgeMs', () => {
    writeAutotuneResult({
      createdAtMs: 1_700_000_000_000,
      modelId: 'test/model',
      contextSize: 4096,
      kvCacheType: 'f16',
      bestStable: { backendMode: 'cpu', nGpuLayers: 0 },
      candidates: [],
    });

    dateNowSpy?.mockReturnValue(1_700_000_000_000 + DEFAULT_AUTOTUNE_MAX_AGE_MS + 1);
    expect(readAutotuneResult({
      modelId: 'test/model',
      contextSize: 4096,
      kvCacheType: 'f16',
    })).toBeNull();
  });

  it('rejects results when native module version does not match', () => {
    writeAutotuneResult({
      createdAtMs: 1_700_000_000_000,
      modelId: 'test/model',
      contextSize: 4096,
      kvCacheType: 'f16',
      nativeModuleVersion: '0.1.0-old',
      bestStable: { backendMode: 'cpu', nGpuLayers: 0 },
      candidates: [],
    });

    expect(readAutotuneResult({
      modelId: 'test/model',
      contextSize: 4096,
      kvCacheType: 'f16',
      expectedNativeModuleVersion: '0.2.0-new',
    })).toBeNull();
  });

  it('sanitizes the best stable profile', () => {
    writeAutotuneResult({
      createdAtMs: 1_700_000_000_000,
      modelId: 'test/model',
      contextSize: 4096,
      kvCacheType: 'f16',
      bestStable: {
        backendMode: 'gpu',
        nGpuLayers: 12.7 as any,
        devices: [' Adreno GPU ', '', 'HTP0', '  '],
      },
      candidates: [],
    });

    expect(readBestStableAutotuneProfile({
      modelId: 'test/model',
      contextSize: 4096,
      kvCacheType: 'f16',
    })).toEqual({
      backendMode: 'gpu',
      nGpuLayers: 13,
      devices: ['Adreno GPU', 'HTP0'],
    });
  });

  it('does not persist restorationError to storage', () => {
    writeAutotuneResult({
      createdAtMs: 1_700_000_000_000,
      modelId: 'test/model',
      contextSize: 4096,
      kvCacheType: 'f16',
      bestStable: { backendMode: 'cpu', nGpuLayers: 0 },
      candidates: [],
      restorationError: 'native reload crashed',
    });

    expect(readAutotuneResult({
      modelId: 'test/model',
      contextSize: 4096,
      kvCacheType: 'f16',
    })?.restorationError).toBeUndefined();
  });

  it('does not throw when kvCacheType is missing', () => {
    expect(() => readAutotuneResult({
      modelId: 'test/model',
      contextSize: 4096,
      kvCacheType: undefined as any,
    })).not.toThrow();
  });
});
