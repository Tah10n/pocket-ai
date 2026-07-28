const mockStorageValues = new Map<string, unknown>();
const mockStorage = {
  set: jest.fn((key: string, value: unknown) => {
    mockStorageValues.set(key, value);
  }),
  getString: jest.fn((key: string) => {
    const value = mockStorageValues.get(key);
    return typeof value === 'string' ? value : undefined;
  }),
  remove: jest.fn((key: string) => {
    mockStorageValues.delete(key);
  }),
  clearAll: jest.fn(() => {
    mockStorageValues.clear();
  }),
  contains: jest.fn((key: string) => mockStorageValues.has(key)),
  getAllKeys: jest.fn(() => Array.from(mockStorageValues.keys())),
};
const mockCreateStorage = jest.fn((_id?: string, _options?: unknown) => mockStorage);

jest.mock('../../src/services/storage', () => ({
  assertPrivateStorageWritable: jest.fn(),
  createStorage: (id?: string, options?: unknown) => mockCreateStorage(id, options),
}));

import {
  DEFAULT_AUTOTUNE_MAX_AGE_MS,
  getCurrentNativeModuleVersion,
  readAutotuneResult,
  readBestStableAutotuneProfile,
  writeAutotuneResult,
} from '../../src/services/InferenceAutotuneStore';

function clearAutotuneStorage() {
  mockStorage.clearAll();
}

function createMockStorage() {
  const values = new Map<string, unknown>();

  return {
    set: jest.fn((key: string, value: unknown) => {
      values.set(key, value);
    }),
    getString: jest.fn((key: string) => {
      const value = values.get(key);
      return typeof value === 'string' ? value : undefined;
    }),
    remove: jest.fn((key: string) => {
      values.delete(key);
    }),
    clearAll: jest.fn(() => {
      values.clear();
    }),
    contains: jest.fn((key: string) => values.has(key)),
    getAllKeys: jest.fn(() => Array.from(values.keys())),
  };
}

describe('InferenceAutotuneStore', () => {
  const nativeVersion = getCurrentNativeModuleVersion();
  let dateNowSpy: jest.SpyInstance | null = null;

  beforeEach(() => {
    jest.clearAllMocks();
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

  it('retries private autotune storage creation after an early failure', () => {
    const blockedError = Object.assign(new Error('private storage blocked'), {
      name: 'PrivateStorageUnavailableError',
    });
    const mockStorage = createMockStorage();
    const createStorageMock = jest.fn()
      .mockImplementationOnce(() => {
        throw blockedError;
      })
      .mockReturnValue(mockStorage);

    try {
      jest.resetModules();
      jest.doMock('../../src/services/storage', () => ({
        assertPrivateStorageWritable: jest.fn(),
        createStorage: createStorageMock,
      }));
      const isolatedStore = require('../../src/services/InferenceAutotuneStore') as typeof import('../../src/services/InferenceAutotuneStore');

      expect(() => isolatedStore.readAutotuneResult({
        modelId: 'test/model',
        contextSize: 4096,
        kvCacheType: 'f16',
        expectedNativeModuleVersion: nativeVersion,
      })).toThrow(blockedError);
      expect(createStorageMock).toHaveBeenCalledTimes(1);

      isolatedStore.writeAutotuneResult({
        createdAtMs: 1_700_000_000_000,
        modelId: 'test/model',
        contextSize: 4096,
        kvCacheType: 'f16',
        nativeModuleVersion: nativeVersion,
        bestStable: { backendMode: 'gpu', nGpuLayers: 12 },
        candidates: [],
      });

      expect(isolatedStore.readAutotuneResult({
        modelId: 'test/model',
        contextSize: 4096,
        kvCacheType: 'f16',
        expectedNativeModuleVersion: nativeVersion,
      })).toEqual(expect.objectContaining({
        modelId: 'test/model',
        bestStable: { backendMode: 'gpu', nGpuLayers: 12 },
      }));
      expect(createStorageMock).toHaveBeenCalledTimes(2);
    } finally {
      jest.dontMock('../../src/services/storage');
    }
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

  it('migrates legacy candidate diagnostics to counts and fixed categories', () => {
    const sentinel = 'hf_PRIVATE_LEGACY_AUTOTUNE_SENTINEL';
    mockStorageValues.set('autotune:test/model:4096:f16', JSON.stringify({
      createdAtMs: 1_700_000_000_000,
      modelId: 'test/model',
      contextSize: 4096,
      kvCacheType: 'f16',
      nativeModuleVersion: nativeVersion,
      bestStable: {
        backendMode: 'npu',
        nGpuLayers: 12,
        devices: ['HTP0'],
      },
      candidates: [{
        profile: {
          backendMode: 'npu',
          nGpuLayers: 12,
          devices: [sentinel],
        },
        success: false,
        initDevices: [sentinel, 'C:\\Users\\private\\device'],
        reasonNoGPU: sentinel,
        error: sentinel,
      }],
    }));

    const result = readAutotuneResult({
      modelId: 'test/model',
      contextSize: 4096,
      kvCacheType: 'f16',
    });

    expect(result).toEqual(expect.objectContaining({
      bestStable: {
        backendMode: 'npu',
        nGpuLayers: 12,
        devices: ['HTP0'],
      },
      candidates: [{
        profile: {
          backendMode: 'npu',
          nGpuLayers: 12,
          deviceCount: 1,
        },
        success: false,
        initDeviceCount: 2,
        reasonNoGPU: 'native_error',
        error: 'operation_failed',
      }],
    }));
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(JSON.stringify(result)).not.toContain('C:\\Users\\private');
  });

  it('logs only a strict error identifier for corrupt payloads', () => {
    const warningSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sentinel = 'hf_PRIVATE_CORRUPT_JSON_SENTINEL';
    mockStorageValues.set('autotune:test/model:4096:f16', `{${sentinel}`);

    try {
      expect(readAutotuneResult({
        modelId: 'test/model',
        contextSize: 4096,
        kvCacheType: 'f16',
      })).toBeNull();

      expect(warningSpy).toHaveBeenCalledWith(
        '[InferenceAutotuneStore] Corrupted autotune payload, clearing.',
        { errorName: 'SyntaxError' },
      );
      expect(JSON.stringify(warningSpy.mock.calls)).not.toContain(sentinel);
      expect(mockStorage.remove).toHaveBeenCalledWith('autotune:test/model:4096:f16');
    } finally {
      warningSpy.mockRestore();
    }
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
