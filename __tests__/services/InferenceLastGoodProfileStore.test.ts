import { createStorage } from '../../src/services/storage';

jest.mock('llama.rn/package.json', () => ({
  version: '1.2.3-test',
}));

// Require after mocks to avoid transform/hoisting differences.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const lastGoodStore = require('../../src/services/InferenceLastGoodProfileStore') as typeof import('../../src/services/InferenceLastGoodProfileStore');
const { readLastGoodInferenceProfile, writeLastGoodInferenceProfile } = lastGoodStore;

function clearLastGoodStorage() {
  createStorage('pocket-ai-last-good-profiles', { tier: 'private' }).clearAll();
}

describe('InferenceLastGoodProfileStore', () => {
  let dateNowSpy: jest.SpyInstance;

  beforeEach(() => {
    clearLastGoodStorage();
    jest.clearAllMocks();
    let now = 1_000_000;
    dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => {
      now += 1000;
      return now;
    });
  });

  afterEach(() => {
    dateNowSpy.mockRestore();
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

    const store = createStorage('pocket-ai-last-good-profiles', { tier: 'private' });
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

    const store = createStorage('pocket-ai-last-good-profiles', { tier: 'private' });
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
