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

jest.mock('llama.rn/package.json', () => ({
  version: '1.2.3-test',
}));

// Require after mocks to avoid transform/hoisting differences.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const lastGoodStore = require('../../src/services/InferenceLastGoodProfileStore') as typeof import('../../src/services/InferenceLastGoodProfileStore');
const { readLastGoodInferenceProfile, writeLastGoodInferenceProfile } = lastGoodStore;

function clearLastGoodStorage() {
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

describe('InferenceLastGoodProfileStore', () => {
  let dateNowSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    clearLastGoodStorage();
    let now = 1_000_000;
    dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => {
      now += 1000;
      return now;
    });
  });

  afterEach(() => {
    dateNowSpy?.mockRestore();
  });

  it('roundtrips a valid profile and normalizes fields', () => {
    writeLastGoodInferenceProfile({
      createdAtMs: Date.now(),
      modelId: ' test/model ',
      contextSize: 4096.4 as unknown as number,
      kvCacheType: 'F16',
      modelFileSizeBytes: 1234,
      modelSha256: 'ABCDEF',
      nativeModuleVersion: '1.2.3-test',
      backendMode: 'gpu',
      nGpuLayers: 12.9 as unknown as number,
      devices: ['HTP0'],
    });

    const read = readLastGoodInferenceProfile({
      modelId: 'test/model',
      contextSize: 4096,
      kvCacheType: 'f16',
      modelFileSizeBytes: 1234,
      modelSha256: 'abcdef',
      expectedNativeModuleVersion: '1.2.3-test',
    });

    expect(read).toEqual(expect.objectContaining({
      modelId: 'test/model',
      contextSize: 4096,
      kvCacheType: 'f16',
      backendMode: 'gpu',
      nGpuLayers: 13,
      nativeModuleVersion: '1.2.3-test',
    }));
    // Devices are only persisted for NPU.
    expect(read?.devices).toBeUndefined();
  });

  it('retries private profile storage creation after an early failure', () => {
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
      const isolatedStore = require('../../src/services/InferenceLastGoodProfileStore') as typeof import('../../src/services/InferenceLastGoodProfileStore');

      expect(() => isolatedStore.readLastGoodInferenceProfile({
        modelId: 'test/model',
        contextSize: 4096,
        kvCacheType: 'f16',
        expectedNativeModuleVersion: '1.2.3-test',
      })).toThrow(blockedError);
      expect(createStorageMock).toHaveBeenCalledTimes(1);

      isolatedStore.writeLastGoodInferenceProfile({
        createdAtMs: Date.now(),
        modelId: 'test/model',
        contextSize: 4096,
        kvCacheType: 'f16',
        nativeModuleVersion: '1.2.3-test',
        backendMode: 'gpu',
        nGpuLayers: 12,
      });

      expect(isolatedStore.readLastGoodInferenceProfile({
        modelId: 'test/model',
        contextSize: 4096,
        kvCacheType: 'f16',
        expectedNativeModuleVersion: '1.2.3-test',
      })).toEqual(expect.objectContaining({
        modelId: 'test/model',
        backendMode: 'gpu',
        nGpuLayers: 12,
      }));
      expect(createStorageMock).toHaveBeenCalledTimes(2);
    } finally {
      jest.dontMock('../../src/services/storage');
    }
  });

  it('clears corrupted JSON payloads and returns null', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    // Seed key via write to avoid relying on internal key builder.
    writeLastGoodInferenceProfile({
      createdAtMs: Date.now(),
      modelId: 'test/model',
      contextSize: 4096,
      kvCacheType: 'f16',
      nativeModuleVersion: '1.2.3-test',
      backendMode: 'cpu',
      nGpuLayers: 0,
    });

    const store = mockStorage;
    const [key] = store.getAllKeys();
    expect(typeof key).toBe('string');

    store.set(key, '{not-json');

    const read = readLastGoodInferenceProfile({
      modelId: 'test/model',
      contextSize: 4096,
      kvCacheType: 'f16',
      expectedNativeModuleVersion: '1.2.3-test',
    });

    expect(read).toBeNull();
    expect(store.contains(key)).toBe(false);

    warnSpy.mockRestore();
  });

  it('rejects mismatched native module versions', () => {
    writeLastGoodInferenceProfile({
      createdAtMs: Date.now(),
      modelId: 'test/model',
      contextSize: 4096,
      kvCacheType: 'f16',
      nativeModuleVersion: '1.0.0',
      backendMode: 'gpu',
      nGpuLayers: 12,
    });

    const store = mockStorage;
    const [key] = store.getAllKeys();

    const read = readLastGoodInferenceProfile({
      modelId: 'test/model',
      contextSize: 4096,
      kvCacheType: 'f16',
      expectedNativeModuleVersion: '2.0.0',
    });

    expect(read).toBeNull();
    expect(store.contains(key)).toBe(false);
  });

  it('enforces maxAgeMs', () => {
    const old = Date.now() - 10_000;
    writeLastGoodInferenceProfile({
      createdAtMs: old,
      modelId: 'test/model',
      contextSize: 4096,
      kvCacheType: 'f16',
      nativeModuleVersion: '1.2.3-test',
      backendMode: 'gpu',
      nGpuLayers: 12,
    });

    const read = readLastGoodInferenceProfile({
      modelId: 'test/model',
      contextSize: 4096,
      kvCacheType: 'f16',
      expectedNativeModuleVersion: '1.2.3-test',
      maxAgeMs: 1000,
    });

    expect(read).toBeNull();
  });

  it('sanitizes NPU device selectors and drops them for non-NPU profiles', () => {
    writeLastGoodInferenceProfile({
      createdAtMs: Date.now(),
      modelId: 'test/model',
      contextSize: 4096,
      kvCacheType: 'f16',
      nativeModuleVersion: '1.2.3-test',
      backendMode: 'npu',
      nGpuLayers: 12,
      devices: [' HTP0 ', 'HTP0', 'HTP 1', '', '   ', 'QNN0'],
    });

    const read = readLastGoodInferenceProfile({
      modelId: 'test/model',
      contextSize: 4096,
      kvCacheType: 'f16',
      expectedNativeModuleVersion: '1.2.3-test',
    });

    expect(read?.backendMode).toBe('npu');
    expect(read?.devices).toEqual(['HTP0', 'QNN0']);

    writeLastGoodInferenceProfile({
      createdAtMs: Date.now(),
      modelId: 'test/model',
      contextSize: 4096,
      kvCacheType: 'f16',
      nativeModuleVersion: '1.2.3-test',
      backendMode: 'gpu',
      nGpuLayers: 12,
      devices: ['HTP0'],
    });

    const readGpu = readLastGoodInferenceProfile({
      modelId: 'test/model',
      contextSize: 4096,
      kvCacheType: 'f16',
      expectedNativeModuleVersion: '1.2.3-test',
    });
    expect(readGpu?.backendMode).toBe('gpu');
    expect(readGpu?.devices).toBeUndefined();
  });
});
