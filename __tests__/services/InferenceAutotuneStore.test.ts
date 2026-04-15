import { createStorage } from '../../src/services/storage';
import {
  readAutotuneResult,
  readBestStableAutotuneProfile,
  writeAutotuneResult,
} from '../../src/services/InferenceAutotuneStore';

function clearAutotuneStorage() {
  createStorage('pocket-ai-autotune', { tier: 'private' }).clearAll();
}

describe('InferenceAutotuneStore', () => {
  beforeEach(() => {
    clearAutotuneStorage();
  });

  it('returns null when no autotune result exists', () => {
    expect(readAutotuneResult({
      modelId: 'test/model',
      contextSize: 4096,
      kvCacheType: 'auto',
    })).toBeNull();
  });

  it('round-trips autotune results', () => {
    const payload = {
      createdAtMs: 123,
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
    })).toEqual(payload);
  });

  it('rejects results when the model signature does not match', () => {
    writeAutotuneResult({
      createdAtMs: 123,
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

  it('sanitizes the best stable profile', () => {
    writeAutotuneResult({
      createdAtMs: 123,
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

  it('does not throw when kvCacheType is missing', () => {
    expect(() => readAutotuneResult({
      modelId: 'test/model',
      contextSize: 4096,
      kvCacheType: undefined as any,
    })).not.toThrow();
  });
});
