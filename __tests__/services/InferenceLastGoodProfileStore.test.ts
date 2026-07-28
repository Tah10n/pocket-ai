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
const {
  MAX_MODEL_INIT_FAILURE_BOUND_ENTRIES,
  readLastGoodInferenceProfile,
  readModelInitFailureBound,
  reconcileModelInitFailureBoundSuccess,
  recordModelInitFailureBound,
  writeLastGoodInferenceProfile,
} = lastGoodStore;
type ModelInitFailureBoundIdentity = import('../../src/services/InferenceLastGoodProfileStore').ModelInitFailureBoundIdentity;

function createFailureBoundIdentity(
  overrides: Partial<ModelInitFailureBoundIdentity> = {},
): ModelInitFailureBoundIdentity {
  return {
    modelId: 'test/model',
    modelFileSizeBytes: 1_234_567,
    modelSha256: 'model-sha',
    modelDownloadMarker: 123,
    modelVariantId: 'variant-a',
    modelResolvedFileName: 'model-a.gguf',
    modelRevision: 'main',
    deviceModel: 'Pixel Test',
    deviceAbis: ['arm64-v8a', 'armeabi-v7a'],
    totalMemoryBytes: 8_000_000_000,
    platform: 'android',
    platformVersion: '36',
    osBuildId: 'BP2A.250605.031',
    appVersion: '1.6.0',
    nativeModuleVersion: '1.2.3-test',
    nativeRuntimeBuild: '{"number":"42","commit":"abc123"}',
    backendMode: 'gpu',
    devices: ['GPU1', 'GPU0'],
    contextSize: 4096,
    cacheTypeK: 'f16',
    cacheTypeV: 'q8_0',
    nThreads: 6,
    cpuMask: 'ff',
    cpuStrict: true,
    flashAttnType: 'on',
    useMmap: true,
    useMlock: false,
    nBatch: 512,
    nUbatch: 256,
    noExtraBufts: false,
    kvUnified: false,
    nParallel: 1,
    projector: {
      id: 'projector-a',
      sizeBytes: 1000,
      sha256: 'projector-sha',
      downloadMarker: 'integrity:projector-a',
    },
    speculative: {
      mode: 'draft_model',
      maxDraftTokens: 3,
      draft: {
        id: 'draft-a',
        sizeBytes: 2000,
        sha256: 'draft-sha',
        downloadMarker: 'updated:789',
      },
    },
    ...overrides,
  };
}

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

  it('persists the lowest learned OOM bound and canonicalizes ABI/device ordering', () => {
    const identity = createFailureBoundIdentity();

    expect(recordModelInitFailureBound(identity, 12)).toEqual(expect.objectContaining({
      oomUpperBoundGpuLayers: 12,
    }));
    expect(recordModelInitFailureBound({
      ...identity,
      deviceAbis: [...identity.deviceAbis].reverse(),
      devices: [...(identity.devices ?? [])].reverse(),
    }, 9)).toEqual(expect.objectContaining({
      oomUpperBoundGpuLayers: 9,
    }));

    expect(readModelInitFailureBound(identity)).toEqual(expect.objectContaining({
      oomUpperBoundGpuLayers: 9,
    }));
  });

  it.each([
    ['model size', (identity: ModelInitFailureBoundIdentity) => ({ ...identity, modelFileSizeBytes: 2_000_000 })],
    ['model SHA', (identity: ModelInitFailureBoundIdentity) => ({ ...identity, modelSha256: 'new-model-sha' })],
    ['download marker', (identity: ModelInitFailureBoundIdentity) => ({ ...identity, modelDownloadMarker: 999 })],
    ['active model variant', (identity: ModelInitFailureBoundIdentity) => ({ ...identity, modelVariantId: 'variant-b' })],
    ['resolved model filename', (identity: ModelInitFailureBoundIdentity) => ({ ...identity, modelResolvedFileName: 'model-b.gguf' })],
    ['model revision', (identity: ModelInitFailureBoundIdentity) => ({ ...identity, modelRevision: 'revision-b' })],
    ['device model', (identity: ModelInitFailureBoundIdentity) => ({ ...identity, deviceModel: 'Pixel Changed' })],
    ['device ABI', (identity: ModelInitFailureBoundIdentity) => ({ ...identity, deviceAbis: ['x86_64'] })],
    ['total memory', (identity: ModelInitFailureBoundIdentity) => ({ ...identity, totalMemoryBytes: 12_000_000_000 })],
    ['OS build', (identity: ModelInitFailureBoundIdentity) => ({ ...identity, osBuildId: 'BP3A.changed' })],
    ['backend mode', (identity: ModelInitFailureBoundIdentity) => ({ ...identity, backendMode: 'npu' as const })],
    ['backend devices', (identity: ModelInitFailureBoundIdentity) => ({ ...identity, devices: ['HTP0'] })],
    ['context size', (identity: ModelInitFailureBoundIdentity) => ({ ...identity, contextSize: 8192 })],
    ['resolved K cache type', (identity: ModelInitFailureBoundIdentity) => ({ ...identity, cacheTypeK: 'q8_0' })],
    ['resolved V cache type', (identity: ModelInitFailureBoundIdentity) => ({ ...identity, cacheTypeV: 'f16' })],
    ['batch', (identity: ModelInitFailureBoundIdentity) => ({ ...identity, nBatch: 256 })],
    ['ubatch', (identity: ModelInitFailureBoundIdentity) => ({ ...identity, nUbatch: 128 })],
    ['low-memory native buffers mode', (identity: ModelInitFailureBoundIdentity) => ({ ...identity, noExtraBufts: true })],
    ['mmap', (identity: ModelInitFailureBoundIdentity) => ({ ...identity, useMmap: false })],
    ['mlock', (identity: ModelInitFailureBoundIdentity) => ({ ...identity, useMlock: true })],
    ['Flash Attention', (identity: ModelInitFailureBoundIdentity) => ({ ...identity, flashAttnType: 'off' as const })],
    ['projector', (identity: ModelInitFailureBoundIdentity) => ({
      ...identity,
      projector: { ...identity.projector!, downloadMarker: 'integrity:projector-b' },
    })],
    ['speculative draft', (identity: ModelInitFailureBoundIdentity) => ({
      ...identity,
      speculative: {
        ...identity.speculative!,
        draft: { ...identity.speculative!.draft!, downloadMarker: 'updated:999' },
      },
    })],
    ['app version', (identity: ModelInitFailureBoundIdentity) => ({ ...identity, appVersion: '1.7.0' })],
    ['native runtime version', (identity: ModelInitFailureBoundIdentity) => ({ ...identity, nativeModuleVersion: '2.0.0' })],
    ['native runtime build', (identity: ModelInitFailureBoundIdentity) => ({ ...identity, nativeRuntimeBuild: '{"number":"43","commit":"def456"}' })],
  ] as [string, (identity: ModelInitFailureBoundIdentity) => ModelInitFailureBoundIdentity][])('invalidates a failure bound when %s changes', (_label, mutate) => {
    const identity = createFailureBoundIdentity();
    recordModelInitFailureBound(identity, 12);

    expect(readModelInitFailureBound(mutate(identity))).toBeNull();
    expect(readModelInitFailureBound(identity)?.oomUpperBoundGpuLayers).toBe(12);
  });

  it('expires learned bounds after the requested TTL', () => {
    const identity = createFailureBoundIdentity();
    recordModelInitFailureBound(identity, 12);

    expect(readModelInitFailureBound(identity, 500)).toBeNull();
    expect(mockStorage.getAllKeys().filter((key) => key.startsWith('init-oom-bound:'))).toHaveLength(0);
  });

  it('expires a bound recorded implausibly in the future after clock rollback', () => {
    const identity = createFailureBoundIdentity();
    dateNowSpy.mockReturnValueOnce(10_000_000).mockReturnValue(1_000_000);
    recordModelInitFailureBound(identity, 12);

    expect(readModelInitFailureBound(identity, 0)).toBeNull();
    expect(mockStorage.getAllKeys().filter((key) => key.startsWith('init-oom-bound:'))).toHaveLength(0);
  });

  it('persists an exact CPU speculative OOM marker without poisoning base-only CPU identity', () => {
    const speculativeIdentity = createFailureBoundIdentity({
      backendMode: 'cpu',
      devices: [],
      speculative: { mode: 'embedded', maxDraftTokens: 3, draft: null },
    });
    const baseIdentity = { ...speculativeIdentity, speculative: null };

    expect(recordModelInitFailureBound(speculativeIdentity, 0)?.oomUpperBoundGpuLayers).toBe(0);
    expect(readModelInitFailureBound(speculativeIdentity)?.oomUpperBoundGpuLayers).toBe(0);
    expect(readModelInitFailureBound(baseIdentity)).toBeNull();
  });

  it('clears only a bound contradicted by an equal-or-higher successful profile', () => {
    const identity = createFailureBoundIdentity();
    recordModelInitFailureBound(identity, 9);

    expect(reconcileModelInitFailureBoundSuccess(identity, 8)).toBe(false);
    expect(readModelInitFailureBound(identity)?.oomUpperBoundGpuLayers).toBe(9);
    expect(reconcileModelInitFailureBoundSuccess(identity, 9)).toBe(true);
    expect(readModelInitFailureBound(identity)).toBeNull();
  });

  it('bounds persisted failure records and evicts the oldest entries deterministically', () => {
    const firstIdentity = createFailureBoundIdentity({ modelId: 'test/model-0' });
    for (let index = 0; index <= MAX_MODEL_INIT_FAILURE_BOUND_ENTRIES; index += 1) {
      recordModelInitFailureBound(createFailureBoundIdentity({ modelId: `test/model-${index}` }), 12);
    }

    const failureKeys = mockStorage.getAllKeys().filter((key) => key.startsWith('init-oom-bound:'));
    expect(failureKeys).toHaveLength(MAX_MODEL_INIT_FAILURE_BOUND_ENTRIES);
    expect(readModelInitFailureBound(firstIdentity)).toBeNull();
    expect(readModelInitFailureBound(createFailureBoundIdentity({
      modelId: `test/model-${MAX_MODEL_INIT_FAILURE_BOUND_ENTRIES}`,
    }))?.oomUpperBoundGpuLayers).toBe(12);
  });

  it('keeps legacy FNV-32 collision identities in separate widened-digest records', () => {
    const firstIdentity = createFailureBoundIdentity({ modelId: 'owner/ful8jip0' });
    const secondIdentity = createFailureBoundIdentity({ modelId: 'owner/8bmhgz6d' });

    recordModelInitFailureBound(firstIdentity, 12);
    recordModelInitFailureBound(secondIdentity, 9);

    expect(readModelInitFailureBound(firstIdentity)?.oomUpperBoundGpuLayers).toBe(12);
    expect(readModelInitFailureBound(secondIdentity)?.oomUpperBoundGpuLayers).toBe(9);
    expect(mockStorage.getAllKeys().filter((key) => key.startsWith('init-oom-bound:'))).toHaveLength(2);
  });

  it('removes corrupted failure-bound payloads without exposing their contents', () => {
    const identity = createFailureBoundIdentity();
    recordModelInitFailureBound(identity, 12);
    const failureKey = mockStorage.getAllKeys().find((key) => key.startsWith('init-oom-bound:'))!;
    mockStorage.set(failureKey, '{private-path:C:\\Users\\someone');

    expect(readModelInitFailureBound(identity)).toBeNull();
    expect(mockStorage.contains(failureKey)).toBe(false);
  });
});
