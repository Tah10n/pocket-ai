import { mergeModelWithRuntimeState } from '../../src/utils/modelRuntimeState';
import { LifecycleStatus, ModelAccessState, type ModelMetadata } from '../../src/types/models';
import type { ProjectorArtifact } from '../../src/types/multimodal';
import {
  buildLegacyProjectorArtifactId,
  buildProjectorArtifactId,
} from '../../src/utils/modelProjectors';

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
  const repoId = overrides.repoId ?? 'org/model';
  const fileName = overrides.fileName ?? 'mmproj-model.gguf';
  const hfRevision = overrides.hfRevision ?? 'main';
  return {
    id: 'org/model:mmproj',
    ownerModelId: 'org/model',
    repoId,
    fileName,
    downloadUrl: `https://huggingface.co/${repoId}/resolve/${hfRevision}/${fileName}`,
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
    const currentProjector = makeProjector();
    currentProjector.id = buildProjectorArtifactId(currentProjector);
    const legacyProjector = makeProjector({
      id: buildLegacyProjectorArtifactId(currentProjector),
    });
    const merged = mergeModelWithRuntimeState(
      makeModel({
        size: 3 * 1024 * 1024 * 1024,
        resolvedFileName: 'model.Q4_K_M.gguf',
        projectorCandidates: [currentProjector],
      }),
      {
        queuedItem: makeModel({
          size: 3 * 1024 * 1024 * 1024,
          resolvedFileName: 'model.Q4_K_M.gguf',
          lifecycleStatus: LifecycleStatus.PAUSED,
          downloadProgress: 0.5,
          selectedProjectorId: legacyProjector.id,
          multimodalReadiness: {
            modelId: 'org/model',
            status: 'ready',
            projectorId: legacyProjector.id,
            projectorSize: 256,
            support: ['vision'],
            checkedAt: 123,
          },
          projectorCandidates: [{
            ...legacyProjector,
            localPath: 'partial-mmproj-model.gguf',
            resumeData: JSON.stringify({ resumeData: 'projector-resume' }),
            downloadProgress: 0.42,
            lifecycleStatus: 'paused',
            matchStatus: 'user_selected',
            matchReason: 'user_selected_projector',
          }],
        }),
      },
    );

    expect(merged.projectorCandidates?.[0]).toEqual(expect.objectContaining({
      id: currentProjector.id,
      localPath: 'partial-mmproj-model.gguf',
      resumeData: 'projector-resume',
      downloadProgress: 0.42,
      lifecycleStatus: 'paused',
      matchStatus: 'user_selected',
      matchReason: 'user_selected_projector',
    }));
    expect(merged.selectedProjectorId).toBe(currentProjector.id);
    expect(merged.multimodalReadiness).toEqual(expect.objectContaining({
      status: 'ready',
      projectorId: currentProjector.id,
    }));
  });

  it('preserves runtime projector candidates when the refreshed model lacks candidates', () => {
    const canonicalProjectorId = buildProjectorArtifactId(makeProjector());
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
        id: canonicalProjectorId,
        localPath: 'mmproj-model.gguf',
        lifecycleStatus: 'downloaded',
        matchStatus: 'user_selected',
      }),
    ]);
    expect(merged.selectedProjectorId).toBe(canonicalProjectorId);
    expect(merged.multimodalReadiness?.projectorId).toBe(canonicalProjectorId);
  });

  it('clears variant runtime projector state for an authoritative empty candidate list', () => {
    const modelFileName = 'model.Q4_K_M.gguf';
    const runtimeProjector = makeProjector({
      id: 'org/model:mmproj-runtime',
      ownerVariantId: modelFileName,
      localPath: 'mmproj-model.gguf',
      lifecycleStatus: 'downloaded',
      matchStatus: 'user_selected',
      matchReason: 'user_selected_projector',
    });
    const merged = mergeModelWithRuntimeState(
      makeModel({
        size: 3 * 1024 * 1024 * 1024,
        resolvedFileName: modelFileName,
        activeVariantId: modelFileName,
        variants: [{
          variantId: modelFileName,
          fileName: modelFileName,
          quantizationLabel: 'Q4_K_M',
          size: 3 * 1024 * 1024 * 1024,
          projectorCandidates: [],
        }],
      }),
      {
        localModel: makeModel({
          size: 3 * 1024 * 1024 * 1024,
          resolvedFileName: modelFileName,
          activeVariantId: modelFileName,
          lifecycleStatus: LifecycleStatus.DOWNLOADED,
          downloadProgress: 1,
          fitsInRam: true,
          memoryFitDecision: 'fits_high_confidence',
          memoryFitConfidence: 'high',
          multimodalReadiness: {
            modelId: 'org/model',
            variantId: modelFileName,
            status: 'ready',
            projectorId: runtimeProjector.id,
            projectorSize: 256,
            support: ['vision'],
            checkedAt: 456,
          },
          variants: [{
            variantId: modelFileName,
            fileName: modelFileName,
            quantizationLabel: 'Q4_K_M',
            size: 3 * 1024 * 1024 * 1024,
            ramFit: 'fits_high_confidence',
            ramFitConfidence: 'high',
            selectedProjectorId: runtimeProjector.id,
            projectorCandidates: [runtimeProjector],
          }],
        }),
      },
    );

    expect(merged.projectorCandidates).toBeUndefined();
    expect(merged.selectedProjectorId).toBeUndefined();
    expect(merged.multimodalReadiness).toBeUndefined();
    expect(merged.variants?.[0]?.projectorCandidates).toEqual([]);
    expect(merged.variants?.[0]?.selectedProjectorId).toBeUndefined();
    expect(merged.variants?.[0]?.ramFit).toBeUndefined();
    expect(merged.variants?.[0]?.ramFitConfidence).toBeUndefined();
    expect(merged.fitsInRam).toBeNull();
    expect(merged.memoryFitDecision).toBeUndefined();
    expect(merged.memoryFitConfidence).toBeUndefined();
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

    expect(merged.projectorCandidates ?? []).toEqual([]);
    expect(merged.selectedProjectorId).toBeUndefined();
    expect(merged.multimodalReadiness).toBeUndefined();
  });

  it('fails closed on conflicting runtime projector metadata', () => {
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

    expect(merged.projectorCandidates ?? []).toEqual([]);
    expect(merged.selectedProjectorId).toBeUndefined();
    expect(merged.multimodalReadiness).toBeUndefined();
  });

  it('preserves projector-scoped memory fit when a legacy projector id remaps to the same artifact', () => {
    const projectorSha = 'd'.repeat(64);
    const merged = mergeModelWithRuntimeState(
      makeModel({
        size: 3 * 1024 * 1024 * 1024,
        resolvedFileName: 'model.Q4_K_M.gguf',
        projectorCandidates: [makeProjector({
          id: 'org/model:mmproj-current',
          sha256: projectorSha,
          size: 256,
        })],
      }),
      {
        queuedItem: makeModel({
          size: 3 * 1024 * 1024 * 1024,
          resolvedFileName: 'model.Q4_K_M.gguf',
          lifecycleStatus: LifecycleStatus.PAUSED,
          downloadProgress: 0.5,
          fitsInRam: true,
          memoryFitDecision: 'fits_high_confidence',
          memoryFitConfidence: 'high',
          variants: [{
            variantId: 'model.Q4_K_M.gguf',
            fileName: 'model.Q4_K_M.gguf',
            quantizationLabel: 'Q4_K_M',
            size: 3 * 1024 * 1024 * 1024,
            ramFit: 'fits_high_confidence',
            ramFitConfidence: 'high',
          }],
          selectedProjectorId: 'org/model:mmproj-legacy',
          projectorCandidates: [makeProjector({
            id: 'org/model:mmproj-legacy',
            sha256: projectorSha,
            size: 256,
            localPath: 'partial-mmproj.gguf',
            resumeData: JSON.stringify({ resumeData: 'projector-resume' }),
            lifecycleStatus: 'paused',
          })],
        }),
      },
    );

    expect(merged.selectedProjectorId).toBe(buildProjectorArtifactId(makeProjector()));
    expect(merged.fitsInRam).toBe(true);
    expect(merged.memoryFitDecision).toBe('fits_high_confidence');
    expect(merged.memoryFitConfidence).toBe('high');
    expect(merged.variants?.[0]).toEqual(expect.objectContaining({
      ramFit: 'fits_high_confidence',
      ramFitConfidence: 'high',
    }));
  });

  it('clears legacy runtime projector selection on stable metadata conflict', () => {
    const merged = mergeModelWithRuntimeState(
      makeModel({
        size: 3 * 1024 * 1024 * 1024,
        resolvedFileName: 'model.Q4_K_M.gguf',
        projectorCandidates: [makeProjector({
          id: 'org/model:mmproj-current',
          sha256: 'd'.repeat(64),
          size: 512,
          downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-model.gguf',
        })],
      }),
      {
        queuedItem: makeModel({
          size: 3 * 1024 * 1024 * 1024,
          resolvedFileName: 'model.Q4_K_M.gguf',
          lifecycleStatus: LifecycleStatus.PAUSED,
          downloadProgress: 0.5,
          fitsInRam: false,
          memoryFitDecision: 'likely_oom',
          memoryFitConfidence: 'high',
          variants: [{
            variantId: 'model.Q4_K_M.gguf',
            fileName: 'model.Q4_K_M.gguf',
            quantizationLabel: 'Q4_K_M',
            size: 3 * 1024 * 1024 * 1024,
            ramFit: 'likely_oom',
            ramFitConfidence: 'high',
          }],
          selectedProjectorId: 'org/model:mmproj-legacy',
          multimodalReadiness: {
            modelId: 'org/model',
            status: 'ready',
            projectorId: 'org/model:mmproj-legacy',
            support: ['vision'],
            checkedAt: 123,
          },
          projectorCandidates: [makeProjector({
            id: 'org/model:mmproj-legacy',
            sha256: 'e'.repeat(64),
            size: 256,
            downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-model.gguf',
            localPath: 'partial-mmproj.gguf',
            resumeData: JSON.stringify({ resumeData: 'stale-projector-resume' }),
            lifecycleStatus: 'paused',
          })],
        }),
      },
    );

    expect(merged.projectorCandidates ?? []).toEqual([]);
    expect(merged.selectedProjectorId).toBeUndefined();
    expect(merged.multimodalReadiness).toBeUndefined();
    expect(merged.fitsInRam).toBeNull();
    expect(merged.memoryFitDecision).toBeUndefined();
    expect(merged.memoryFitConfidence).toBeUndefined();
    expect(merged.variants?.[0]).toEqual(expect.objectContaining({
      ramFit: undefined,
      ramFitConfidence: undefined,
    }));
  });

  it('clears projector-scoped memory fit when a same-id projector artifact changes', () => {
    const merged = mergeModelWithRuntimeState(
      makeModel({
        size: 3 * 1024 * 1024 * 1024,
        resolvedFileName: 'model.Q4_K_M.gguf',
        selectedProjectorId: 'org/model:mmproj',
        projectorCandidates: [makeProjector({
          sha256: 'd'.repeat(64),
          size: 512,
          matchStatus: 'user_selected',
          matchReason: 'user_selected_projector',
        })],
      }),
      {
        localModel: makeModel({
          size: 3 * 1024 * 1024 * 1024,
          resolvedFileName: 'model.Q4_K_M.gguf',
          lifecycleStatus: LifecycleStatus.DOWNLOADED,
          downloadProgress: 1,
          localPath: 'model.gguf',
          fitsInRam: true,
          memoryFitDecision: 'fits_high_confidence',
          memoryFitConfidence: 'high',
          variants: [{
            variantId: 'model.Q4_K_M.gguf',
            fileName: 'model.Q4_K_M.gguf',
            quantizationLabel: 'Q4_K_M',
            size: 3 * 1024 * 1024 * 1024,
            ramFit: 'fits_high_confidence',
            ramFitConfidence: 'high',
          }],
          selectedProjectorId: 'org/model:mmproj',
          projectorCandidates: [makeProjector({
            sha256: 'e'.repeat(64),
            size: 256,
            localPath: 'stale-mmproj.gguf',
            lifecycleStatus: 'downloaded',
            matchStatus: 'user_selected',
            matchReason: 'user_selected_projector',
          })],
        }),
      },
    );

    expect(merged.selectedProjectorId).toBeUndefined();
    expect(merged.projectorCandidates ?? []).toEqual([]);
    expect(merged.fitsInRam).toBeNull();
    expect(merged.memoryFitDecision).toBeUndefined();
    expect(merged.memoryFitConfidence).toBeUndefined();
    expect(merged.variants?.[0]).toEqual(expect.objectContaining({
      ramFit: undefined,
      ramFitConfidence: undefined,
    }));
  });

  it('clears explicit runtime projector selection on stable metadata conflict', () => {
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
            matchStatus: 'user_selected',
            matchReason: 'user_selected_projector',
          })],
        }),
      },
    );

    expect(merged.projectorCandidates ?? []).toEqual([]);
    expect(merged.selectedProjectorId).toBeUndefined();
    expect(merged.multimodalReadiness).toBeUndefined();
  });

  it('hydrates variant-only projector runtime state through active variant id and filename aliases', () => {
    const catalogProjector = makeProjector({
      id: 'org/model:mmproj-catalog',
      ownerVariantId: 'audio-q4',
    });
    const runtimeProjector = makeProjector({
      id: 'org/model:mmproj-runtime',
      ownerVariantId: 'model-audio.gguf',
      localPath: 'partial-mmproj-audio.gguf',
      resumeData: JSON.stringify({ resumeData: 'runtime-audio-resume' }),
      downloadProgress: 0.6,
      lifecycleStatus: 'paused',
      matchStatus: 'user_selected',
      matchReason: 'user_selected_projector',
    });
    const merged = mergeModelWithRuntimeState(
      makeModel({
        size: 1024,
        resolvedFileName: 'model-audio.gguf',
        activeVariantId: 'audio-q4',
        variants: [{
          variantId: 'audio-q4',
          fileName: 'model-audio.gguf',
          quantizationLabel: 'Q4_K_M',
          size: 1024,
          chatModalities: ['text', 'audio'],
          projectorCandidates: [catalogProjector],
          selectedProjectorId: catalogProjector.id,
        }],
      }),
      {
        queuedItem: makeModel({
          size: 1024,
          resolvedFileName: 'model-audio.gguf',
          activeVariantId: 'model-audio.gguf',
          lifecycleStatus: LifecycleStatus.PAUSED,
          downloadProgress: 0.5,
          variants: [{
            variantId: 'audio-q4',
            fileName: 'model-audio.gguf',
            quantizationLabel: 'Q4_K_M',
            size: 1024,
            chatModalities: ['text', 'audio'],
            projectorCandidates: [runtimeProjector],
            selectedProjectorId: runtimeProjector.id,
          }],
          multimodalReadiness: {
            modelId: 'org/model',
            variantId: 'model-audio.gguf',
            status: 'ready',
            projectorId: runtimeProjector.id,
            support: ['audio'],
            checkedAt: 123,
          },
        }),
      },
    );

    expect(merged.projectorCandidates).toBeUndefined();
    expect(merged.selectedProjectorId).toBeUndefined();
    const canonicalCatalogProjectorId = buildProjectorArtifactId(catalogProjector);
    expect(merged.variants?.[0]).toEqual(expect.objectContaining({
      selectedProjectorId: canonicalCatalogProjectorId,
      projectorCandidates: [expect.objectContaining({
        id: canonicalCatalogProjectorId,
        localPath: 'partial-mmproj-audio.gguf',
        resumeData: 'runtime-audio-resume',
        downloadProgress: 0.6,
        lifecycleStatus: 'paused',
        matchStatus: 'user_selected',
      })],
    }));
    expect(merged.multimodalReadiness).toEqual(expect.objectContaining({
      variantId: 'model-audio.gguf',
      projectorId: canonicalCatalogProjectorId,
      support: ['audio'],
    }));
  });

  it('does not hydrate Q4 projector state through a stale resolved alias when Q8 is explicitly active', () => {
    const incomingProjector = makeProjector({
      id: 'org/model:mmproj-q8',
      ownerVariantId: 'q8',
    });
    const runtimeProjector = makeProjector({
      id: 'org/model:mmproj-q4',
      ownerVariantId: 'q4',
      localPath: 'partial-mmproj-q4.gguf',
      resumeData: 'q4-resume',
      lifecycleStatus: 'paused',
    });
    const merged = mergeModelWithRuntimeState(
      makeModel({
        size: 1024,
        activeVariantId: 'q8',
        resolvedFileName: 'model-q4.gguf',
        projectorCandidates: [incomingProjector],
      }),
      {
        queuedItem: makeModel({
          size: 1024,
          activeVariantId: 'q4',
          resolvedFileName: 'model-q4.gguf',
          lifecycleStatus: LifecycleStatus.PAUSED,
          projectorCandidates: [runtimeProjector],
        }),
      },
    );

    expect(merged.projectorCandidates).toEqual([
      expect.objectContaining({
        id: buildProjectorArtifactId(incomingProjector),
        ownerVariantId: 'q8',
        lifecycleStatus: 'available',
      }),
    ]);
    expect(merged.projectorCandidates?.[0].localPath).toBeUndefined();
    expect(merged.projectorCandidates?.[0].resumeData).toBeUndefined();
  });

  it('does not preserve variant-scoped projector runtime state for a different active variant without catalog candidates', () => {
    const merged = mergeModelWithRuntimeState(
      makeModel({
        size: 8 * 1024 * 1024 * 1024,
        resolvedFileName: 'model.Q8_0.gguf',
        activeVariantId: 'model.Q8_0.gguf',
        variants: [
          { variantId: 'model.Q4_K_M.gguf', fileName: 'model.Q4_K_M.gguf', quantizationLabel: 'Q4_K_M', size: 3 * 1024 * 1024 * 1024 },
          { variantId: 'model.Q8_0.gguf', fileName: 'model.Q8_0.gguf', quantizationLabel: 'Q8_0', size: 8 * 1024 * 1024 * 1024 },
        ],
      }),
      {
        queuedItem: makeModel({
          size: 8 * 1024 * 1024 * 1024,
          resolvedFileName: 'model.Q8_0.gguf',
          lifecycleStatus: LifecycleStatus.PAUSED,
          downloadProgress: 0.5,
          selectedProjectorId: 'org/model:mmproj-q4',
          multimodalReadiness: {
            modelId: 'org/model',
            variantId: 'model.Q4_K_M.gguf',
            status: 'ready',
            projectorId: 'org/model:mmproj-q4',
            support: ['vision'],
            checkedAt: 123,
          },
          projectorCandidates: [makeProjector({
            id: 'org/model:mmproj-q4',
            ownerVariantId: 'model.Q4_K_M.gguf',
            localPath: 'partial-mmproj-q4.gguf',
            resumeData: JSON.stringify({ resumeData: 'stale-projector-resume' }),
            lifecycleStatus: 'paused',
            matchStatus: 'user_selected',
            matchReason: 'user_selected_projector',
          })],
        }),
      },
    );

    expect(merged.projectorCandidates).toBeUndefined();
    expect(merged.selectedProjectorId).toBeUndefined();
    expect(merged.multimodalReadiness).toBeUndefined();
  });

  it('does not preserve explicit runtime projector selection when stable artifact identity conflicts', () => {
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
            sha256: 'd'.repeat(64),
            localPath: 'partial-mmproj-old.gguf',
            resumeData: JSON.stringify({ resumeData: 'stale-projector-resume' }),
            lifecycleStatus: 'paused',
            matchStatus: 'user_selected',
            matchReason: 'user_selected_projector',
          })],
        }),
      },
    );

    expect(merged.projectorCandidates ?? []).toEqual([]);
    expect(merged.selectedProjectorId).toBeUndefined();
    expect(merged.multimodalReadiness).toBeUndefined();
  });

  it('clears a selected projector when a same-id stable artifact conflict blocks the candidate', () => {
    const merged = mergeModelWithRuntimeState(
      makeModel({
        size: 3 * 1024 * 1024 * 1024,
        resolvedFileName: 'model.Q4_K_M.gguf',
        selectedProjectorId: 'org/model:mmproj',
        visionSource: 'user_selected_projector',
        projectorCandidates: [makeProjector({
          fileName: 'mmproj-new.gguf',
          downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-new.gguf',
          sha256: 'd'.repeat(64),
          matchStatus: 'user_selected',
          matchReason: 'user_selected_projector',
        })],
      }),
      {
        localModel: makeModel({
          size: 3 * 1024 * 1024 * 1024,
          resolvedFileName: 'model.Q4_K_M.gguf',
          lifecycleStatus: LifecycleStatus.DOWNLOADED,
          downloadProgress: 1,
          localPath: 'model.gguf',
          selectedProjectorId: 'org/model:mmproj',
          projectorCandidates: [makeProjector({
            fileName: 'mmproj-old.gguf',
            downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-old.gguf',
            sha256: 'e'.repeat(64),
            localPath: 'stale-mmproj-old.gguf',
            lifecycleStatus: 'downloaded',
            matchStatus: 'user_selected',
            matchReason: 'user_selected_projector',
          })],
        }),
      },
    );

    expect(merged.projectorCandidates ?? []).toEqual([]);
    expect(merged.selectedProjectorId).toBeUndefined();
    expect(merged.multimodalReadiness).toBeUndefined();
  });

  it('does not fall back to a different runtime projector when the incoming selection is blocked', () => {
    const merged = mergeModelWithRuntimeState(
      makeModel({
        size: 3 * 1024 * 1024 * 1024,
        resolvedFileName: 'model.Q4_K_M.gguf',
        selectedProjectorId: 'org/model:mmproj-b',
        projectorCandidates: [
          makeProjector({
            id: 'org/model:mmproj-a',
            fileName: 'mmproj-a.gguf',
          }),
          makeProjector({
            id: 'org/model:mmproj-b',
            fileName: 'fresh-mmproj-b.gguf',
          }),
        ],
      }),
      {
        queuedItem: makeModel({
          size: 3 * 1024 * 1024 * 1024,
          resolvedFileName: 'model.Q4_K_M.gguf',
          lifecycleStatus: LifecycleStatus.PAUSED,
          downloadProgress: 0.5,
          selectedProjectorId: 'org/model:mmproj-a',
          multimodalReadiness: {
            modelId: 'org/model',
            status: 'ready',
            projectorId: 'org/model:mmproj-a',
            support: ['vision'],
            checkedAt: 123,
          },
          projectorCandidates: [
            makeProjector({
              id: 'org/model:mmproj-a',
              fileName: 'mmproj-a.gguf',
              localPath: 'partial-mmproj-a.gguf',
              resumeData: JSON.stringify({ resumeData: 'projector-a-resume' }),
              lifecycleStatus: 'paused',
              matchStatus: 'user_selected',
              matchReason: 'user_selected_projector',
            }),
            makeProjector({
              id: 'org/model:mmproj-b',
              fileName: 'stale-mmproj-b.gguf',
              localPath: 'partial-stale-mmproj-b.gguf',
              resumeData: JSON.stringify({ resumeData: 'stale-projector-b-resume' }),
              lifecycleStatus: 'paused',
            }),
          ],
        }),
      },
    );

    const projectorAId = buildProjectorArtifactId(makeProjector({ fileName: 'mmproj-a.gguf' }));
    const projectorBId = buildProjectorArtifactId(makeProjector({ fileName: 'fresh-mmproj-b.gguf' }));
    const projectorA = merged.projectorCandidates?.find((projector) => projector.id === projectorAId);
    const projectorB = merged.projectorCandidates?.find((projector) => projector.id === projectorBId);
    expect(projectorA).toEqual(expect.objectContaining({
      id: projectorAId,
      localPath: 'partial-mmproj-a.gguf',
    }));
    expect(projectorB).toBeUndefined();
    expect(merged.selectedProjectorId).toBeUndefined();
    expect(merged.multimodalReadiness).toBeUndefined();
  });

  it('fails closed when one alias conflicts even if another runtime alias is compatible', () => {
    const merged = mergeModelWithRuntimeState(
      makeModel({
        size: 3 * 1024 * 1024 * 1024,
        resolvedFileName: 'model.Q4_K_M.gguf',
        selectedProjectorId: 'org/model:mmproj',
        multimodalReadiness: {
          modelId: 'org/model',
          status: 'ready',
          projectorId: 'org/model:mmproj',
          support: ['vision'],
          checkedAt: 456,
        },
        projectorCandidates: [makeProjector({
          id: 'org/model:mmproj',
          fileName: 'mmproj-new.gguf',
          downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-new.gguf',
          sha256: 'd'.repeat(64),
        })],
      }),
      {
        localModel: makeModel({
          size: 3 * 1024 * 1024 * 1024,
          resolvedFileName: 'model.Q4_K_M.gguf',
          lifecycleStatus: LifecycleStatus.DOWNLOADED,
          downloadProgress: 1,
          localPath: 'model.gguf',
          selectedProjectorId: 'org/model:mmproj-legacy',
          multimodalReadiness: {
            modelId: 'org/model',
            status: 'ready',
            projectorId: 'org/model:mmproj-legacy',
            support: ['vision'],
            checkedAt: 123,
          },
          projectorCandidates: [
            makeProjector({
              id: 'org/model:mmproj',
              fileName: 'mmproj-old-conflict.gguf',
              downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-old-conflict.gguf',
              sha256: 'e'.repeat(64),
              localPath: 'stale-mmproj-old.gguf',
              lifecycleStatus: 'downloaded',
            }),
            makeProjector({
              id: 'org/model:mmproj-legacy',
              fileName: 'mmproj-new.gguf',
              downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-new.gguf',
              sha256: 'd'.repeat(64),
              localPath: 'mmproj-new.gguf',
              lifecycleStatus: 'downloaded',
              matchStatus: 'user_selected',
              matchReason: 'user_selected_projector',
            }),
          ],
        }),
      },
    );

    expect(merged.projectorCandidates ?? []).toEqual([]);
    expect(merged.selectedProjectorId).toBeUndefined();
    expect(merged.multimodalReadiness).toBeUndefined();
  });
});
