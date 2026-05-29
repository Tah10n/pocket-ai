import { mergeModelWithRuntimeState } from '../../src/utils/modelRuntimeState';
import { LifecycleStatus, ModelAccessState, type ModelMetadata } from '../../src/types/models';
import type { ProjectorArtifact } from '../../src/types/multimodal';

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

function makeProjector(overrides: Partial<ProjectorArtifact> = {}): ProjectorArtifact {
  return {
    id: 'org/model:mmproj',
    ownerModelId: 'org/model',
    repoId: 'org/model',
    fileName: 'mmproj-model.gguf',
    downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-model.gguf',
    size: 256,
    lifecycleStatus: 'available',
    matchStatus: 'matched',
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

  it('does not use resolved filename fallback for stale queued variants without an explicit active variant', () => {
    const merged = mergeModelWithRuntimeState(
      makeModel({
        size: 3 * 1024 * 1024 * 1024,
        resolvedFileName: 'model.Q4_K_M.gguf',
        activeVariantId: 'model.Q4_K_M.gguf',
        metadataTrust: 'trusted_remote',
        variants: [
          { variantId: 'model.Q4_K_M.gguf', fileName: 'model.Q4_K_M.gguf', quantizationLabel: 'Q4_K_M', size: 3 * 1024 * 1024 * 1024 },
        ],
      }),
      {
        queuedItem: makeModel({
          size: 8 * 1024 * 1024 * 1024,
          resolvedFileName: 'model.Q8_0.gguf',
          localPath: 'partial-model.Q8_0.gguf',
          lifecycleStatus: LifecycleStatus.PAUSED,
          downloadProgress: 0.5,
          resumeData: JSON.stringify({ resumeData: 'stale' }),
        }),
      },
    );

    expect(merged).toEqual(expect.objectContaining({
      size: 3 * 1024 * 1024 * 1024,
      resolvedFileName: 'model.Q4_K_M.gguf',
      activeVariantId: 'model.Q4_K_M.gguf',
      localPath: undefined,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      resumeData: undefined,
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

  it('surfaces downloaded runtime state for a non-default catalog variant', () => {
    const merged = mergeModelWithRuntimeState(
      makeModel({
        size: 3 * 1024 * 1024 * 1024,
        resolvedFileName: 'model.Q4_K_M.gguf',
        activeVariantId: 'model.Q4_K_M.gguf',
        sha256: REMOTE_SHA256,
        metadataTrust: 'trusted_remote',
        variants: [
          { variantId: 'model.Q4_K_M.gguf', fileName: 'model.Q4_K_M.gguf', quantizationLabel: 'Q4_K_M', size: 3 * 1024 * 1024 * 1024, sha256: REMOTE_SHA256 },
          { variantId: 'model.Q8_0.gguf', fileName: 'model.Q8_0.gguf', quantizationLabel: 'Q8_0', size: 8 * 1024 * 1024 * 1024, sha256: LOCAL_SHA256 },
        ],
      }),
      {
        localModel: makeModel({
          size: 8 * 1024 * 1024 * 1024,
          resolvedFileName: 'model.Q8_0.gguf',
          activeVariantId: 'model.Q8_0.gguf',
          localPath: 'model.Q8_0.gguf',
          downloadedAt: 123,
          sha256: LOCAL_SHA256,
          metadataTrust: 'verified_local',
          downloadIntegrity: {
            kind: 'sha256',
            sizeBytes: 8 * 1024 * 1024 * 1024,
            checkedAt: 456,
            sha256: LOCAL_SHA256,
          },
          lifecycleStatus: LifecycleStatus.DOWNLOADED,
          downloadProgress: 1,
        }),
      },
    );

    expect(merged).toEqual(expect.objectContaining({
      size: 8 * 1024 * 1024 * 1024,
      resolvedFileName: 'model.Q8_0.gguf',
      activeVariantId: 'model.Q8_0.gguf',
      localPath: 'model.Q8_0.gguf',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
      sha256: LOCAL_SHA256,
    }));
  });

  it('preserves legacy downloaded variant selections without activeVariantId when the catalog default is non-preferred', () => {
    const merged = mergeModelWithRuntimeState(
      makeModel({
        size: 5 * 1024 * 1024 * 1024,
        resolvedFileName: 'model.Q5_K_M.gguf',
        activeVariantId: 'model.Q5_K_M.gguf',
        metadataTrust: 'trusted_remote',
        variants: [
          { variantId: 'model.Q5_K_M.gguf', fileName: 'model.Q5_K_M.gguf', quantizationLabel: 'Q5_K_M', size: 5 * 1024 * 1024 * 1024 },
        ],
      }),
      {
        localModel: makeModel({
          size: 8 * 1024 * 1024 * 1024,
          resolvedFileName: 'model.Q8_0.gguf',
          localPath: 'model.Q8_0.gguf',
          downloadedAt: 123,
          sha256: LOCAL_SHA256,
          metadataTrust: 'verified_local',
          downloadIntegrity: {
            kind: 'sha256',
            sizeBytes: 8 * 1024 * 1024 * 1024,
            checkedAt: 456,
            sha256: LOCAL_SHA256,
          },
          lifecycleStatus: LifecycleStatus.DOWNLOADED,
          downloadProgress: 1,
        }),
      },
    );

    expect(merged).toEqual(expect.objectContaining({
      size: 8 * 1024 * 1024 * 1024,
      resolvedFileName: 'model.Q8_0.gguf',
      activeVariantId: 'model.Q8_0.gguf',
      localPath: 'model.Q8_0.gguf',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
      sha256: LOCAL_SHA256,
    }));
  });

  it('does not preserve same-size legacy local files when a fresh catalog result selects a different filename', () => {
    const merged = mergeModelWithRuntimeState(
      makeModel({
        size: 4 * 1024 * 1024 * 1024,
        resolvedFileName: 'model.Q5_K_M.gguf',
        activeVariantId: 'model.Q5_K_M.gguf',
        metadataTrust: 'trusted_remote',
        variants: [
          { variantId: 'model.Q5_K_M.gguf', fileName: 'model.Q5_K_M.gguf', quantizationLabel: 'Q5_K_M', size: 4 * 1024 * 1024 * 1024 },
          { variantId: 'model.Q4_K_M.gguf', fileName: 'model.Q4_K_M.gguf', quantizationLabel: 'Q4_K_M', size: 4 * 1024 * 1024 * 1024 },
        ],
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
            checkedAt: 456,
            sha256: LOCAL_SHA256,
          },
          lifecycleStatus: LifecycleStatus.DOWNLOADED,
          downloadProgress: 1,
        }),
      },
    );

    expect(merged).toEqual(expect.objectContaining({
      size: 4 * 1024 * 1024 * 1024,
      resolvedFileName: 'model.Q5_K_M.gguf',
      activeVariantId: 'model.Q5_K_M.gguf',
      localPath: undefined,
      downloadedAt: undefined,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      sha256: undefined,
    }));
  });

  it('surfaces queued runtime state for a non-default catalog variant', () => {
    const merged = mergeModelWithRuntimeState(
      makeModel({
        size: 3 * 1024 * 1024 * 1024,
        resolvedFileName: 'model.Q4_K_M.gguf',
        activeVariantId: 'model.Q4_K_M.gguf',
        metadataTrust: 'trusted_remote',
        variants: [
          { variantId: 'model.Q4_K_M.gguf', fileName: 'model.Q4_K_M.gguf', quantizationLabel: 'Q4_K_M', size: 3 * 1024 * 1024 * 1024 },
        ],
      }),
      {
        queuedItem: makeModel({
          size: 8 * 1024 * 1024 * 1024,
          resolvedFileName: 'model.Q8_0.gguf',
          activeVariantId: 'model.Q8_0.gguf',
          localPath: 'partial-model.Q8_0.gguf',
          lifecycleStatus: LifecycleStatus.PAUSED,
          downloadProgress: 0.5,
          resumeData: JSON.stringify({ resumeData: 'resume' }),
        }),
      },
    );

    expect(merged).toEqual(expect.objectContaining({
      size: 8 * 1024 * 1024 * 1024,
      resolvedFileName: 'model.Q8_0.gguf',
      activeVariantId: 'model.Q8_0.gguf',
      localPath: 'partial-model.Q8_0.gguf',
      lifecycleStatus: LifecycleStatus.PAUSED,
      downloadProgress: 0.5,
      resumeData: JSON.stringify({ resumeData: 'resume' }),
    }));
  });

  it('preserves compatible queued projector resume state across catalog refreshes', () => {
    const merged = mergeModelWithRuntimeState(
      makeModel({
        size: 3 * 1024 * 1024 * 1024,
        resolvedFileName: 'model.Q4_K_M.gguf',
        projectorCandidates: [makeProjector({ id: 'org/model:mmproj-v2' })],
      }),
      {
        queuedItem: makeModel({
          size: 3 * 1024 * 1024 * 1024,
          resolvedFileName: 'model.Q4_K_M.gguf',
          lifecycleStatus: LifecycleStatus.PAUSED,
          downloadProgress: 0.5,
          selectedProjectorId: 'org/model:mmproj-v1',
          multimodalReadiness: {
            modelId: 'org/model',
            status: 'ready',
            projectorId: 'org/model:mmproj-v1',
            projectorSize: 256,
            support: ['vision'],
            checkedAt: 123,
          },
          projectorCandidates: [makeProjector({
            id: 'org/model:mmproj-v1',
            localPath: 'partial-mmproj-model.gguf',
            resumeData: JSON.stringify({ resumeData: 'projector-resume' }),
            downloadProgress: 0.42,
            lifecycleStatus: 'paused',
            matchStatus: 'user_selected',
            matchReason: 'user_selected_projector',
          })],
        }),
      },
    );

    expect(merged.projectorCandidates?.[0]).toEqual(expect.objectContaining({
      id: 'org/model:mmproj-v2',
      localPath: 'partial-mmproj-model.gguf',
      resumeData: 'projector-resume',
      downloadProgress: 0.42,
      lifecycleStatus: 'paused',
      matchStatus: 'user_selected',
      matchReason: 'user_selected_projector',
    }));
    expect(merged.selectedProjectorId).toBe('org/model:mmproj-v2');
    expect(merged.multimodalReadiness).toEqual(expect.objectContaining({
      status: 'ready',
      projectorId: 'org/model:mmproj-v2',
    }));
  });

  it('preserves runtime projector candidates when the refreshed model lacks candidates', () => {
    const merged = mergeModelWithRuntimeState(
      makeModel({
        size: 3 * 1024 * 1024 * 1024,
        resolvedFileName: 'model.Q4_K_M.gguf',
      }),
      {
        localModel: makeModel({
          size: 3 * 1024 * 1024 * 1024,
          resolvedFileName: 'model.Q4_K_M.gguf',
          lifecycleStatus: LifecycleStatus.DOWNLOADED,
          downloadProgress: 1,
          selectedProjectorId: 'org/model:mmproj-runtime',
          multimodalReadiness: {
            modelId: 'org/model',
            status: 'ready',
            projectorId: 'org/model:mmproj-runtime',
            projectorSize: 256,
            support: ['vision'],
            checkedAt: 456,
          },
          projectorCandidates: [makeProjector({
            id: 'org/model:mmproj-runtime',
            localPath: 'mmproj-model.gguf',
            lifecycleStatus: 'downloaded',
            matchStatus: 'user_selected',
            matchReason: 'user_selected_projector',
          })],
        }),
      },
    );

    expect(merged.projectorCandidates).toEqual([
      expect.objectContaining({
        id: 'org/model:mmproj-runtime',
        localPath: 'mmproj-model.gguf',
        lifecycleStatus: 'downloaded',
        matchStatus: 'user_selected',
      }),
    ]);
    expect(merged.selectedProjectorId).toBe('org/model:mmproj-runtime');
    expect(merged.multimodalReadiness?.projectorId).toBe('org/model:mmproj-runtime');
  });

  it('does not inherit projector resume state when projector identity conflicts', () => {
    const merged = mergeModelWithRuntimeState(
      makeModel({
        size: 3 * 1024 * 1024 * 1024,
        resolvedFileName: 'model.Q4_K_M.gguf',
        projectorCandidates: [makeProjector({
          fileName: 'mmproj-new.gguf',
          downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-new.gguf',
          sha256: 'd'.repeat(64),
        })],
      }),
      {
        queuedItem: makeModel({
          size: 3 * 1024 * 1024 * 1024,
          resolvedFileName: 'model.Q4_K_M.gguf',
          lifecycleStatus: LifecycleStatus.PAUSED,
          downloadProgress: 0.5,
          selectedProjectorId: 'org/model:mmproj',
          multimodalReadiness: {
            modelId: 'org/model',
            status: 'ready',
            projectorId: 'org/model:mmproj',
            support: ['vision'],
            checkedAt: 123,
          },
          projectorCandidates: [makeProjector({
            fileName: 'mmproj-old.gguf',
            downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-old.gguf',
            sha256: 'e'.repeat(64),
            localPath: 'partial-mmproj-old.gguf',
            resumeData: JSON.stringify({ resumeData: 'stale-projector-resume' }),
            lifecycleStatus: 'paused',
          })],
        }),
      },
    );

    expect(merged.projectorCandidates?.[0]).toEqual(expect.objectContaining({
      fileName: 'mmproj-new.gguf',
      downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-new.gguf',
      lifecycleStatus: 'available',
    }));
    expect(merged.projectorCandidates?.[0]?.resumeData).toBeUndefined();
    expect(merged.projectorCandidates?.[0]?.localPath).toBeUndefined();
    expect(merged.selectedProjectorId).toBeUndefined();
    expect(merged.multimodalReadiness).toBeUndefined();
  });

  it('does not preserve projector readiness when runtime metadata conflicts for the same projector id', () => {
    const merged = mergeModelWithRuntimeState(
      makeModel({
        size: 3 * 1024 * 1024 * 1024,
        resolvedFileName: 'model.Q4_K_M.gguf',
        projectorCandidates: [makeProjector({
          sha256: 'd'.repeat(64),
        })],
      }),
      {
        queuedItem: makeModel({
          size: 3 * 1024 * 1024 * 1024,
          resolvedFileName: 'model.Q4_K_M.gguf',
          lifecycleStatus: LifecycleStatus.PAUSED,
          downloadProgress: 0.5,
          selectedProjectorId: 'org/model:mmproj',
          multimodalReadiness: {
            modelId: 'org/model',
            status: 'ready',
            projectorId: 'org/model:mmproj',
            support: ['vision'],
            checkedAt: 123,
          },
          projectorCandidates: [makeProjector({
            sha256: 'e'.repeat(64),
            localPath: 'partial-mmproj.gguf',
            resumeData: JSON.stringify({ resumeData: 'stale-projector-resume' }),
            lifecycleStatus: 'paused',
          })],
        }),
      },
    );

    expect(merged.projectorCandidates?.[0]).toEqual(expect.objectContaining({
      lifecycleStatus: 'available',
      sha256: 'd'.repeat(64),
    }));
    expect(merged.projectorCandidates?.[0]?.resumeData).toBeUndefined();
    expect(merged.projectorCandidates?.[0]?.localPath).toBeUndefined();
    expect(merged.selectedProjectorId).toBe('org/model:mmproj');
    expect(merged.multimodalReadiness).toBeUndefined();
  });
});
