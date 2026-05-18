import { mergeModelWithRuntimeState } from '../../src/utils/modelRuntimeState';
import { LifecycleStatus, ModelAccessState, type ModelMetadata } from '../../src/types/models';

const LOCAL_SHA256 = 'b'.repeat(64);
const REMOTE_SHA256 = 'c'.repeat(64);

function makeModel(overrides: Partial<ModelMetadata> = {}): ModelMetadata {
  return {
    id: 'org/model',
    name: 'Model',
    author: 'org',
    size: null,
    downloadUrl: 'https://huggingface.co/org/model/resolve/main/model.gguf',
    fitsInRam: null,
    accessState: ModelAccessState.PUBLIC,
    isGated: false,
    isPrivate: false,
    lifecycleStatus: LifecycleStatus.AVAILABLE,
    downloadProgress: 0,
    ...overrides,
  };
}

describe('modelRuntimeState', () => {
  it('preserves incoming runtime fields when no local model is present', () => {
    const merged = mergeModelWithRuntimeState(
      makeModel({
        lifecycleStatus: LifecycleStatus.DOWNLOADED,
        downloadProgress: 1,
        localPath: '/models/model.gguf',
        downloadedAt: 123,
        resumeData: JSON.stringify({ resumeData: 'opaque' }),
      }),
      {},
    );

    expect(merged.lifecycleStatus).toBe(LifecycleStatus.DOWNLOADED);
    expect(merged.downloadProgress).toBe(1);
    expect(merged.localPath).toBe('/models/model.gguf');
    expect(merged.downloadedAt).toBe(123);
    expect(merged.resumeData).toBe(JSON.stringify({ resumeData: 'opaque' }));
  });

  it('preserves enriched registry metadata when the incoming model is sparse', () => {
    const merged = mergeModelWithRuntimeState(
      makeModel(),
      {
        localModel: makeModel({
          localPath: '/models/model.gguf',
          lifecycleStatus: LifecycleStatus.DOWNLOADED,
          parameterSizeLabel: '8B',
          baseModels: ['meta-llama/Llama-3.1-8B-Instruct'],
          license: 'llama3.1',
          languages: ['en', 'de'],
          datasets: ['ultrachat_200k'],
          quantizedBy: 'bartowski',
          modelCreator: 'Meta',
        }),
      },
    );

    expect(merged.localPath).toBe('/models/model.gguf');
    expect(merged.lifecycleStatus).toBe(LifecycleStatus.DOWNLOADED);
    expect(merged.parameterSizeLabel).toBe('8B');
    expect(merged.baseModels).toEqual(['meta-llama/Llama-3.1-8B-Instruct']);
    expect(merged.license).toBe('llama3.1');
    expect(merged.languages).toEqual(['en', 'de']);
    expect(merged.datasets).toEqual(['ultrachat_200k']);
    expect(merged.quantizedBy).toBe('bartowski');
    expect(merged.modelCreator).toBe('Meta');
  });

  it('preserves local integrity and failure runtime fields', () => {
    const merged = mergeModelWithRuntimeState(
      makeModel(),
      {
        localModel: makeModel({
          lifecycleStatus: LifecycleStatus.FAILED,
          downloadIntegrity: {
            kind: 'size',
            sizeBytes: 2048,
            checkedAt: 123,
          },
          downloadErrorAt: 456,
          downloadErrorCode: 'download_http_error',
          downloadErrorMessage: 'HTTP status 500',
        }),
      },
    );

    expect(merged.downloadIntegrity).toEqual({
      kind: 'size',
      sizeBytes: 2048,
      checkedAt: 123,
    });
    expect(merged.downloadErrorAt).toBe(456);
    expect(merged.downloadErrorCode).toBe('download_http_error');
    expect(merged.downloadErrorMessage).toBe('HTTP status 500');
  });

  it('does not overwrite richer incoming metadata with local fallbacks', () => {
    const merged = mergeModelWithRuntimeState(
      makeModel({
        parameterSizeLabel: '14B',
        baseModels: ['upstream/model'],
        license: 'apache-2.0',
        languages: ['en'],
        datasets: ['custom-dataset'],
        quantizedBy: 'maintainer',
        modelCreator: 'Open Source Lab',
      }),
      {
        localModel: makeModel({
          parameterSizeLabel: '8B',
          baseModels: ['meta-llama/Llama-3.1-8B-Instruct'],
          license: 'llama3.1',
          languages: ['de'],
          datasets: ['ultrachat_200k'],
          quantizedBy: 'bartowski',
          modelCreator: 'Meta',
        }),
      },
    );

    expect(merged.parameterSizeLabel).toBe('14B');
    expect(merged.baseModels).toEqual(['upstream/model']);
    expect(merged.license).toBe('apache-2.0');
    expect(merged.languages).toEqual(['en']);
    expect(merged.datasets).toEqual(['custom-dataset']);
    expect(merged.quantizedBy).toBe('maintainer');
    expect(merged.modelCreator).toBe('Open Source Lab');
  });

  it('does not reattach stale local runtime state when incoming remote identity conflicts', () => {
    const merged = mergeModelWithRuntimeState(
      makeModel({
        size: 3 * 1024 * 1024 * 1024,
        resolvedFileName: 'model.Q4_K_M.gguf',
        sha256: REMOTE_SHA256,
        metadataTrust: 'trusted_remote',
      }),
      {
        localModel: makeModel({
          size: 4 * 1024 * 1024 * 1024,
          resolvedFileName: 'model.Q4_K_M.gguf',
          localPath: 'model.Q4_K_M.gguf',
          downloadedAt: 123,
          sha256: LOCAL_SHA256,
          metadataTrust: 'verified_local',
          downloadIntegrity: {
            kind: 'sha256',
            sizeBytes: 4 * 1024 * 1024 * 1024,
            checkedAt: 123,
            sha256: LOCAL_SHA256,
          },
          lifecycleStatus: LifecycleStatus.DOWNLOADED,
          downloadProgress: 1,
          resumeData: JSON.stringify({ resumeData: 'stale' }),
        }),
      },
    );

    expect(merged).toEqual(expect.objectContaining({
      size: 3 * 1024 * 1024 * 1024,
      localPath: undefined,
      downloadedAt: undefined,
      sha256: REMOTE_SHA256,
      downloadIntegrity: undefined,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      resumeData: undefined,
    }));
  });

  it('does not reattach stale queued runtime state when the selected filename changed', () => {
    const merged = mergeModelWithRuntimeState(
      makeModel({
        size: 3 * 1024 * 1024 * 1024,
        resolvedFileName: 'model.Q5_K_M.gguf',
        metadataTrust: 'trusted_remote',
      }),
      {
        queuedItem: makeModel({
          size: 4 * 1024 * 1024 * 1024,
          resolvedFileName: 'model.Q4_K_M.gguf',
          localPath: 'model.Q4_K_M.gguf',
          downloadedAt: 123,
          lifecycleStatus: LifecycleStatus.PAUSED,
          downloadProgress: 0.5,
          resumeData: JSON.stringify({ resumeData: 'stale' }),
          downloadErrorAt: 456,
          downloadErrorCode: 'download_network_unavailable',
          downloadErrorMessage: 'Offline',
        }),
      },
    );

    expect(merged).toEqual(expect.objectContaining({
      size: 3 * 1024 * 1024 * 1024,
      resolvedFileName: 'model.Q5_K_M.gguf',
      localPath: undefined,
      downloadedAt: undefined,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      resumeData: undefined,
      downloadErrorAt: undefined,
      downloadErrorCode: undefined,
      downloadErrorMessage: undefined,
    }));
  });

  it('does not reattach stale queued resume state when the selected file size changed', () => {
    const merged = mergeModelWithRuntimeState(
      makeModel({
        size: 3 * 1024 * 1024 * 1024,
        resolvedFileName: 'model.Q4_K_M.gguf',
        sha256: REMOTE_SHA256,
        metadataTrust: 'trusted_remote',
      }),
      {
        queuedItem: makeModel({
          size: 4 * 1024 * 1024 * 1024,
          resolvedFileName: 'model.Q4_K_M.gguf',
          sha256: REMOTE_SHA256,
          downloadIntegrity: {
            kind: 'sha256',
            sizeBytes: 4 * 1024 * 1024 * 1024,
            checkedAt: 123,
            sha256: REMOTE_SHA256,
          },
          lifecycleStatus: LifecycleStatus.PAUSED,
          downloadProgress: 0.5,
          resumeData: JSON.stringify({ resumeData: 'stale' }),
        }),
      },
    );

    expect(merged).toEqual(expect.objectContaining({
      size: 3 * 1024 * 1024 * 1024,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      resumeData: undefined,
    }));
  });
});
