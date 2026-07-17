import {
  getQueuedDownloadFileNames,
  normalizePersistedDownloadQueue,
  useDownloadStore,
} from '../../src/store/downloadStore';
import { LifecycleStatus, ModelAccessState, type ModelMetadata } from '../../src/types/models';
import type { ProjectorArtifact } from '../../src/types/multimodal';
import { buildMainModelArtifactId } from '../../src/utils/modelArtifacts';
import { buildProjectorArtifactId } from '../../src/utils/modelProjectors';

function buildQueuedModel(
  id: string,
  lifecycleStatus: LifecycleStatus,
): ModelMetadata {
  return {
    id,
    name: id,
    author: 'author',
    size: 1024,
    downloadUrl: `https://example.com/${id}.gguf`,
    fitsInRam: true,
    accessState: ModelAccessState.PUBLIC,
    isGated: false,
    isPrivate: false,
    lifecycleStatus,
    downloadProgress: 0.5,
  };
}

function buildProjector(overrides: Partial<ProjectorArtifact> = {}): ProjectorArtifact {
  const fileName = overrides.fileName ?? 'mmproj-model.gguf';
  return {
    id: 'vision/model:mmproj',
    ownerModelId: 'vision/model',
    repoId: 'vision/model',
    fileName,
    downloadUrl: `https://example.com/${fileName}`,
    size: 256,
    lifecycleStatus: 'available',
    matchStatus: 'matched',
    ...overrides,
  };
}

function getCanonicalProjectorId(
  fileName = 'mmproj-model.gguf',
  ownerVariantId?: string,
): string {
  return buildProjectorArtifactId({
    repoId: 'vision/model',
    hfRevision: 'main',
    fileName,
    ownerVariantId,
  });
}

describe('downloadStore', () => {
  beforeEach(() => {
    useDownloadStore.setState({ queue: [], activeDownloadId: null });
  });

  it('normalizes in-flight persisted downloads back to queued state', () => {
    expect(
      normalizePersistedDownloadQueue([
        buildQueuedModel('queued', LifecycleStatus.QUEUED),
        buildQueuedModel('downloading', LifecycleStatus.DOWNLOADING),
        buildQueuedModel('verifying', LifecycleStatus.VERIFYING),
        buildQueuedModel('paused', LifecycleStatus.PAUSED),
      ]),
    ).toEqual([
      expect.objectContaining({ id: 'queued', lifecycleStatus: LifecycleStatus.QUEUED }),
      expect.objectContaining({ id: 'downloading', lifecycleStatus: LifecycleStatus.QUEUED }),
      expect.objectContaining({ id: 'verifying', lifecycleStatus: LifecycleStatus.QUEUED }),
      expect.objectContaining({ id: 'paused', lifecycleStatus: LifecycleStatus.PAUSED }),
    ]);
  });

  it('normalizes in-flight persisted projector state on rehydrate', () => {
    const queued = normalizePersistedDownloadQueue([
      {
        ...buildQueuedModel('vision/model', LifecycleStatus.DOWNLOADING),
        projectorCandidates: [
          buildProjector({
            id: 'vision/model:mmproj-no-resume',
            fileName: 'mmproj-no-resume.gguf',
            lifecycleStatus: 'downloading',
            downloadProgress: 0.64,
          }),
          buildProjector({
            id: 'vision/model:mmproj-resumable',
            fileName: 'mmproj-resumable.gguf',
            lifecycleStatus: 'downloading',
            downloadProgress: 0.42,
            resumeData: JSON.stringify({ resumeData: 'projector-resume-data' }),
          }),
        ],
      },
    ]);

    expect(queued[0]).toEqual(expect.objectContaining({
      lifecycleStatus: LifecycleStatus.QUEUED,
    }));
    expect(queued[0].projectorCandidates).toEqual([
      expect.objectContaining({
        id: getCanonicalProjectorId('mmproj-no-resume.gguf'),
        lifecycleStatus: 'queued',
      }),
      expect.objectContaining({
        id: getCanonicalProjectorId('mmproj-resumable.gguf'),
        lifecycleStatus: 'paused',
        resumeData: 'projector-resume-data',
      }),
    ]);
    expect(queued[0].projectorCandidates?.[0]).not.toHaveProperty('downloadProgress');
    expect(queued[0].projectorCandidates?.[1]).not.toHaveProperty('downloadProgress');
  });

  it('normalizes queued persisted projector resume state to paused on rehydrate', () => {
    const queued = normalizePersistedDownloadQueue([
      {
        ...buildQueuedModel('vision/model', LifecycleStatus.QUEUED),
        projectorCandidates: [
          buildProjector({
            id: 'vision/model:mmproj-queued-resumable',
            fileName: 'mmproj-queued-resumable.gguf',
            lifecycleStatus: 'queued',
            downloadProgress: 0.37,
            resumeData: JSON.stringify({ resumeData: 'queued-projector-resume-data' }),
          }),
          buildProjector({
            id: 'vision/model:mmproj-queued-no-resume',
            fileName: 'mmproj-queued-no-resume.gguf',
            lifecycleStatus: 'queued',
            downloadProgress: 0.12,
          }),
          buildProjector({
            id: 'vision/model:mmproj-failed-no-resume',
            fileName: 'mmproj-failed-no-resume.gguf',
            lifecycleStatus: 'failed',
          }),
          buildProjector({
            id: 'vision/model:mmproj-downloaded-no-resume',
            fileName: 'mmproj-downloaded-no-resume.gguf',
            lifecycleStatus: 'downloaded',
          }),
          buildProjector({
            id: 'vision/model:mmproj-available-no-resume',
            fileName: 'mmproj-available-no-resume.gguf',
            lifecycleStatus: 'available',
          }),
        ],
      },
    ]);

    expect(queued[0].projectorCandidates).toEqual([
      expect.objectContaining({
        id: getCanonicalProjectorId('mmproj-available-no-resume.gguf'),
        lifecycleStatus: 'available',
      }),
      expect.objectContaining({
        id: getCanonicalProjectorId('mmproj-downloaded-no-resume.gguf'),
        lifecycleStatus: 'downloaded',
      }),
      expect.objectContaining({
        id: getCanonicalProjectorId('mmproj-failed-no-resume.gguf'),
        lifecycleStatus: 'failed',
      }),
      expect.objectContaining({
        id: getCanonicalProjectorId('mmproj-queued-no-resume.gguf'),
        lifecycleStatus: 'queued',
      }),
      expect.objectContaining({
        id: getCanonicalProjectorId('mmproj-queued-resumable.gguf'),
        lifecycleStatus: 'paused',
        resumeData: 'queued-projector-resume-data',
      }),
    ]);
    expect(queued[0].projectorCandidates?.[3]).not.toHaveProperty('downloadProgress');
    expect(queued[0].projectorCandidates?.[4]).not.toHaveProperty('downloadProgress');
  });

  it('normalizes in-flight speculative draft state on rehydrate without disturbing installed drafts', () => {
    const queued = normalizePersistedDownloadQueue([
      {
        ...buildQueuedModel('gemma/model', LifecycleStatus.DOWNLOADING),
        artifacts: [
          {
            id: 'gemma/model:mtp-draft',
            kind: 'speculative_draft',
            requiredFor: ['text'],
            remoteFileName: 'gemma-MTP-Q4_K_M.gguf',
            downloadUrl: 'https://example.com/gemma-MTP-Q4_K_M.gguf',
            sizeBytes: 512,
            localPath: 'gemma-mtp.partial.gguf',
            installState: 'downloading',
            downloadProgress: 0.42,
            resumeData: JSON.stringify({ resumeData: 'mtp-resume-data' }),
          },
          {
            id: 'gemma/model:installed-mtp-draft',
            kind: 'speculative_draft',
            requiredFor: ['text'],
            remoteFileName: 'gemma-MTP-F16.gguf',
            downloadUrl: 'https://example.com/gemma-MTP-F16.gguf',
            sizeBytes: 1024,
            localPath: 'gemma-mtp-installed.gguf',
            installState: 'installed',
            downloadProgress: 1,
          },
        ],
      },
    ]);

    expect(queued[0].lifecycleStatus).toBe(LifecycleStatus.QUEUED);
    const queuedDraft = queued[0].artifacts?.find((artifact) => artifact.id === 'gemma/model:mtp-draft');
    const installedDraft = queued[0].artifacts?.find((artifact) => (
      artifact.id === 'gemma/model:installed-mtp-draft'
    ));
    expect(queuedDraft).toEqual(expect.objectContaining({
      id: 'gemma/model:mtp-draft',
      installState: 'queued',
      resumeData: 'mtp-resume-data',
    }));
    expect(queuedDraft).not.toHaveProperty('downloadProgress');
    expect(installedDraft).toEqual(expect.objectContaining({
      id: 'gemma/model:installed-mtp-draft',
      installState: 'installed',
      downloadProgress: 1,
    }));
  });

  it('re-queues paused downloads when the user taps download again', () => {
    useDownloadStore.setState({
      queue: [
        {
          ...buildQueuedModel('paused', LifecycleStatus.PAUSED),
          resumeData: 'resume-data',
          downloadProgress: 0.42,
          localPath: 'paused.partial.gguf',
          allowUnknownSizeDownload: true,
          downloadIntegrity: {
            kind: 'size',
            sizeBytes: 1024,
            checkedAt: 123,
          },
        },
      ],
      activeDownloadId: null,
    });

    useDownloadStore.getState().addToQueue(buildQueuedModel('paused', LifecycleStatus.AVAILABLE));

    const entry = useDownloadStore.getState().queue.find((model) => model.id === 'paused');
    expect(entry).toBeDefined();
    expect(entry?.lifecycleStatus).toBe(LifecycleStatus.QUEUED);
    expect(entry?.resumeData).toBe('resume-data');
    expect(entry?.downloadProgress).toBe(0.42);
    expect(entry?.localPath).toBe('paused.partial.gguf');
    expect(entry?.allowUnknownSizeDownload).toBe(true);
    expect(entry?.downloadIntegrity).toEqual({
      kind: 'size',
      sizeBytes: 1024,
      checkedAt: 123,
    });
  });

  it('preserves resumable MTP draft state only for the current catalog artifact identity', () => {
    const pausedDraft = {
      id: 'gemma/model:mtp-draft-v1',
      kind: 'speculative_draft' as const,
      requiredFor: ['text' as const],
      hfRevision: 'revision-a',
      remoteFileName: 'MTP/gemma-MTP-Q8_0.gguf',
      downloadUrl: 'https://huggingface.co/gemma/model/resolve/revision-a/MTP/gemma-MTP-Q8_0.gguf',
      sizeBytes: 512,
      localPath: 'gemma-mtp.partial.gguf',
      installState: 'queued' as const,
      downloadProgress: 0.41,
      resumeData: 'mtp-resume-data',
    };
    useDownloadStore.setState({
      queue: [{
        ...buildQueuedModel('gemma/model', LifecycleStatus.PAUSED),
        artifacts: [pausedDraft],
      }],
      activeDownloadId: null,
    });

    useDownloadStore.getState().addToQueue({
      ...buildQueuedModel('gemma/model', LifecycleStatus.AVAILABLE),
      artifacts: [{
        ...pausedDraft,
        localPath: undefined,
        installState: 'remote',
        downloadProgress: undefined,
        resumeData: undefined,
      }],
    });

    const resumed = useDownloadStore.getState().queue[0].artifacts?.[0];
    expect(resumed).toEqual(expect.objectContaining({
      id: pausedDraft.id,
      installState: 'queued',
      localPath: 'gemma-mtp.partial.gguf',
      downloadProgress: 0.41,
      resumeData: 'mtp-resume-data',
    }));

    useDownloadStore.setState({
      queue: [{
        ...buildQueuedModel('gemma/model', LifecycleStatus.PAUSED),
        artifacts: [pausedDraft],
      }],
      activeDownloadId: null,
    });
    const replacementDraft = {
      ...pausedDraft,
      id: 'gemma/model:mtp-draft-v2',
      hfRevision: 'revision-b',
      remoteFileName: 'MTP/gemma-MTP-Q4_0.gguf',
      downloadUrl: 'https://huggingface.co/gemma/model/resolve/revision-b/MTP/gemma-MTP-Q4_0.gguf',
      localPath: undefined,
      installState: 'remote' as const,
      downloadProgress: undefined,
      resumeData: undefined,
    };
    useDownloadStore.getState().addToQueue({
      ...buildQueuedModel('gemma/model', LifecycleStatus.AVAILABLE),
      artifacts: [replacementDraft],
    });

    expect(useDownloadStore.getState().queue[0].artifacts?.filter((artifact) => (
      artifact.kind === 'speculative_draft'
    ))).toEqual([replacementDraft]);
  });

  it('preserves compatible paused projector resume state when re-queuing a catalog model', () => {
    useDownloadStore.setState({
      queue: [
        {
          ...buildQueuedModel('vision/model', LifecycleStatus.PAUSED),
          selectedProjectorId: 'vision/model:mmproj-v1',
          multimodalReadiness: {
            modelId: 'vision/model',
            status: 'ready',
            projectorId: 'vision/model:mmproj-v1',
            projectorSize: 256,
            support: ['vision'],
            checkedAt: 123,
          },
          projectorCandidates: [buildProjector({
            id: 'vision/model:mmproj-v1',
            localPath: 'partial-mmproj-model.gguf',
            resumeData: JSON.stringify({ resumeData: 'projector-resume-data' }),
            lifecycleStatus: 'paused',
            matchStatus: 'user_selected',
            matchReason: 'user_selected_projector',
          })],
        },
      ],
      activeDownloadId: null,
    });

    useDownloadStore.getState().addToQueue({
      ...buildQueuedModel('vision/model', LifecycleStatus.AVAILABLE),
      projectorCandidates: [buildProjector({
        id: 'vision/model:mmproj-v2',
        lifecycleStatus: 'available',
        matchStatus: 'matched',
        matchReason: 'single_projector_candidate',
      })],
    });

    const entry = useDownloadStore.getState().queue.find((model) => model.id === 'vision/model');
    const projector = entry?.projectorCandidates?.[0];
    expect(entry?.lifecycleStatus).toBe(LifecycleStatus.QUEUED);
    expect(projector).toEqual(expect.objectContaining({
      id: getCanonicalProjectorId(),
      localPath: 'partial-mmproj-model.gguf',
      resumeData: 'projector-resume-data',
      lifecycleStatus: 'paused',
      matchStatus: 'user_selected',
      matchReason: 'user_selected_projector',
    }));
    expect(entry?.selectedProjectorId).toBe(getCanonicalProjectorId());
    expect(entry?.multimodalReadiness?.projectorId).toBe(getCanonicalProjectorId());
  });

  it('preserves and remaps variant-only projector retry state through variant aliases', () => {
    const runtimeProjector = buildProjector({
      id: 'vision/model:mmproj-runtime',
      ownerVariantId: 'model-audio.gguf',
      localPath: 'partial-mmproj-audio.gguf',
      resumeData: JSON.stringify({ resumeData: 'variant-projector-resume' }),
      lifecycleStatus: 'paused',
      matchStatus: 'user_selected',
      matchReason: 'user_selected_projector',
    });
    useDownloadStore.setState({
      queue: [{
        ...buildQueuedModel('vision/model', LifecycleStatus.PAUSED),
        resolvedFileName: 'model-audio.gguf',
        activeVariantId: 'model-audio.gguf',
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
          modelId: 'vision/model',
          variantId: 'model-audio.gguf',
          status: 'ready',
          projectorId: runtimeProjector.id,
          support: ['audio'],
          checkedAt: 123,
        },
      }],
      activeDownloadId: null,
    });
    const catalogProjector = buildProjector({
      id: 'vision/model:mmproj-catalog',
      ownerVariantId: 'audio-q4',
    });

    useDownloadStore.getState().addToQueue({
      ...buildQueuedModel('vision/model', LifecycleStatus.AVAILABLE),
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
    });

    const entry = useDownloadStore.getState().queue[0];
    const canonicalProjectorId = getCanonicalProjectorId('mmproj-model.gguf', 'audio-q4');
    expect(entry.projectorCandidates).toBeUndefined();
    expect(entry.selectedProjectorId).toBeUndefined();
    expect(entry.variants?.[0]).toEqual(expect.objectContaining({
      selectedProjectorId: canonicalProjectorId,
      projectorCandidates: [expect.objectContaining({
        id: canonicalProjectorId,
        localPath: 'partial-mmproj-audio.gguf',
        resumeData: 'variant-projector-resume',
        lifecycleStatus: 'paused',
        matchStatus: 'user_selected',
      })],
    }));
    expect(entry.multimodalReadiness).toEqual(expect.objectContaining({
      projectorId: canonicalProjectorId,
      support: ['audio'],
    }));
  });

  it('does not union projector runtime scope when the incoming active variant changes', () => {
    const runtimeProjector = buildProjector({
      id: 'vision/model:mmproj-q4',
      ownerVariantId: 'q4',
      localPath: 'partial-q4.gguf',
      resumeData: 'q4-resume',
      lifecycleStatus: 'paused',
    });
    useDownloadStore.setState({
      queue: [{
        ...buildQueuedModel('vision/model', LifecycleStatus.PAUSED),
        activeVariantId: 'q4',
        resolvedFileName: undefined,
        variants: [{
          variantId: 'q4',
          fileName: 'model-q4.gguf',
          quantizationLabel: 'Q4_K_M',
          size: 1024,
          chatModalities: ['text', 'vision'],
          projectorCandidates: [runtimeProjector],
        }],
      }],
      activeDownloadId: null,
    });
    const incomingProjector = buildProjector({
      id: 'vision/model:mmproj-q8',
      ownerVariantId: 'q8',
      fileName: 'mmproj-q8.gguf',
      downloadUrl: 'https://example.com/mmproj-q8.gguf',
    });

    useDownloadStore.getState().addToQueue({
      ...buildQueuedModel('vision/model', LifecycleStatus.AVAILABLE),
      activeVariantId: 'q8',
      resolvedFileName: undefined,
      variants: [{
        variantId: 'q8',
        fileName: 'model-q8.gguf',
        quantizationLabel: 'Q8_0',
        size: 1024,
        chatModalities: ['text', 'vision'],
        projectorCandidates: [incomingProjector],
      }],
    });

    const entry = useDownloadStore.getState().queue[0];
    expect(entry.variants?.[0].projectorCandidates).toEqual([
      expect.objectContaining({
        id: getCanonicalProjectorId('mmproj-q8.gguf', 'q8'),
        lifecycleStatus: 'available',
      }),
    ]);
    expect(entry.variants?.[0].projectorCandidates?.[0].localPath).toBeUndefined();
    expect(entry.variants?.[0].projectorCandidates?.[0].resumeData).toBeUndefined();
  });

  it('treats an unresolved incoming active id as authoritative over a stale resolved file alias', () => {
    const runtimeProjector = buildProjector({
      id: 'vision/model:mmproj-runtime',
      ownerVariantId: 'q4',
      localPath: 'partial-q4.gguf',
      resumeData: 'q4-resume',
      lifecycleStatus: 'paused',
    });
    useDownloadStore.setState({
      queue: [{
        ...buildQueuedModel('vision/model', LifecycleStatus.PAUSED),
        activeVariantId: 'q4',
        resolvedFileName: 'model-q4.gguf',
        projectorCandidates: [runtimeProjector],
      }],
      activeDownloadId: null,
    });
    const incomingProjector = buildProjector({
      id: 'vision/model:mmproj-catalog',
      ownerVariantId: 'q8',
    });

    useDownloadStore.getState().addToQueue({
      ...buildQueuedModel('vision/model', LifecycleStatus.AVAILABLE),
      activeVariantId: 'q8',
      // Deliberately stale. Without an actual variant record it is not proven
      // to be an alias for the explicit incoming active id.
      resolvedFileName: 'model-q4.gguf',
      projectorCandidates: [incomingProjector],
    });

    const entry = useDownloadStore.getState().queue[0];
    expect(entry.projectorCandidates).toEqual([
      expect.objectContaining({
        id: getCanonicalProjectorId('mmproj-model.gguf', 'q8'),
        ownerVariantId: 'q8',
        lifecycleStatus: 'available',
      }),
    ]);
    expect(entry.projectorCandidates?.[0].localPath).toBeUndefined();
    expect(entry.projectorCandidates?.[0].resumeData).toBeUndefined();
  });

  it('normalizes re-queued projector resume state from queued to paused', () => {
    useDownloadStore.setState({
      queue: [
        {
          ...buildQueuedModel('vision/model', LifecycleStatus.PAUSED),
          projectorCandidates: [buildProjector({
            id: 'vision/model:mmproj',
            lifecycleStatus: 'queued',
            downloadProgress: 0.55,
            resumeData: JSON.stringify({ resumeData: 'queued-projector-resume-data' }),
          })],
        },
      ],
      activeDownloadId: null,
    });

    useDownloadStore.getState().addToQueue({
      ...buildQueuedModel('vision/model', LifecycleStatus.AVAILABLE),
      projectorCandidates: [buildProjector({
        id: 'vision/model:mmproj',
        lifecycleStatus: 'available',
      })],
    });

    const entry = useDownloadStore.getState().queue.find((model) => model.id === 'vision/model');
    const projector = entry?.projectorCandidates?.[0];
    expect(projector).toEqual(expect.objectContaining({
      id: getCanonicalProjectorId(),
      lifecycleStatus: 'paused',
      resumeData: 'queued-projector-resume-data',
    }));
    expect(projector).not.toHaveProperty('downloadProgress');
  });

  it('does not preserve same-id incompatible projector state when re-queuing a catalog model', () => {
    useDownloadStore.setState({
      queue: [
        {
          ...buildQueuedModel('vision/model', LifecycleStatus.PAUSED),
          selectedProjectorId: 'vision/model:mmproj',
          multimodalReadiness: {
            modelId: 'vision/model',
            status: 'ready',
            projectorId: 'vision/model:mmproj',
            projectorSize: 256,
            support: ['vision'],
            checkedAt: 123,
          },
          projectorCandidates: [buildProjector({
            fileName: 'stale-mmproj.gguf',
            localPath: 'partial-stale-mmproj.gguf',
            resumeData: JSON.stringify({ resumeData: 'stale-projector-resume' }),
            lifecycleStatus: 'paused',
            matchStatus: 'user_selected',
            matchReason: 'user_selected_projector',
          })],
        },
      ],
      activeDownloadId: null,
    });

    useDownloadStore.getState().addToQueue({
      ...buildQueuedModel('vision/model', LifecycleStatus.AVAILABLE),
      projectorCandidates: [buildProjector({
        fileName: 'fresh-mmproj.gguf',
        lifecycleStatus: 'available',
        matchStatus: 'matched',
        matchReason: 'single_projector_candidate',
      })],
    });

    const entry = useDownloadStore.getState().queue.find((model) => model.id === 'vision/model');
    const projector = entry?.projectorCandidates?.[0];
    expect(entry?.lifecycleStatus).toBe(LifecycleStatus.QUEUED);
    expect(projector).toEqual(expect.objectContaining({
      id: getCanonicalProjectorId('fresh-mmproj.gguf'),
      fileName: 'fresh-mmproj.gguf',
      lifecycleStatus: 'available',
      matchStatus: 'matched',
    }));
    expect(projector?.localPath).toBeUndefined();
    expect(projector?.resumeData).toBeUndefined();
    expect(entry?.selectedProjectorId).toBeUndefined();
    expect(entry?.multimodalReadiness).toBeUndefined();
  });

  it('keeps the current incoming selection when a stale same-id runtime artifact has another exact scope', () => {
    useDownloadStore.setState({
      queue: [
        {
          ...buildQueuedModel('vision/model', LifecycleStatus.PAUSED),
          selectedProjectorId: 'vision/model:mmproj',
          projectorCandidates: [buildProjector({
            fileName: 'stale-mmproj.gguf',
            localPath: 'partial-stale-mmproj.gguf',
            resumeData: JSON.stringify({ resumeData: 'stale-projector-resume' }),
            lifecycleStatus: 'paused',
            matchStatus: 'user_selected',
            matchReason: 'user_selected_projector',
          })],
        },
      ],
      activeDownloadId: null,
    });

    useDownloadStore.getState().addToQueue({
      ...buildQueuedModel('vision/model', LifecycleStatus.AVAILABLE),
      selectedProjectorId: 'vision/model:mmproj',
      projectorCandidates: [buildProjector({
        fileName: 'fresh-mmproj.gguf',
        lifecycleStatus: 'available',
        matchStatus: 'matched',
        matchReason: 'single_projector_candidate',
      })],
    });

    const entry = useDownloadStore.getState().queue.find((model) => model.id === 'vision/model');
    expect(entry?.projectorCandidates?.[0]).toEqual(expect.objectContaining({
      id: getCanonicalProjectorId('fresh-mmproj.gguf'),
      fileName: 'fresh-mmproj.gguf',
      lifecycleStatus: 'available',
    }));
    expect(entry?.selectedProjectorId).toBe(getCanonicalProjectorId('fresh-mmproj.gguf'));
    expect(entry?.multimodalReadiness).toBeUndefined();
  });

  it('preserves compatible runtime state while the current incoming id owns its exact scope', () => {
    useDownloadStore.setState({
      queue: [
        {
          ...buildQueuedModel('vision/model', LifecycleStatus.PAUSED),
          selectedProjectorId: 'vision/model:mmproj-legacy',
          multimodalReadiness: {
            modelId: 'vision/model',
            status: 'ready',
            projectorId: 'vision/model:mmproj-legacy',
            projectorSize: 256,
            support: ['vision'],
            checkedAt: 123,
          },
          projectorCandidates: [
            buildProjector({
              id: 'vision/model:mmproj',
              fileName: 'stale-mmproj.gguf',
              downloadUrl: 'https://example.com/stale-mmproj.gguf',
              localPath: 'partial-stale-mmproj.gguf',
              resumeData: JSON.stringify({ resumeData: 'stale-projector-resume' }),
              lifecycleStatus: 'paused',
              matchStatus: 'user_selected',
              matchReason: 'user_selected_projector',
            }),
            buildProjector({
              id: 'vision/model:mmproj-legacy',
              fileName: 'fresh-mmproj.gguf',
              downloadUrl: 'https://example.com/fresh-mmproj.gguf',
              localPath: 'fresh-mmproj.gguf',
              lifecycleStatus: 'downloaded',
              matchStatus: 'user_selected',
              matchReason: 'user_selected_projector',
            }),
          ],
        },
      ],
      activeDownloadId: null,
    });

    useDownloadStore.getState().addToQueue({
      ...buildQueuedModel('vision/model', LifecycleStatus.AVAILABLE),
      selectedProjectorId: 'vision/model:mmproj',
      multimodalReadiness: {
        modelId: 'vision/model',
        status: 'ready',
        projectorId: 'vision/model:mmproj',
        projectorSize: 256,
        support: ['vision'],
        checkedAt: 456,
      },
      projectorCandidates: [buildProjector({
        id: 'vision/model:mmproj',
        fileName: 'fresh-mmproj.gguf',
        downloadUrl: 'https://example.com/fresh-mmproj.gguf',
        lifecycleStatus: 'available',
        matchStatus: 'matched',
        matchReason: 'single_projector_candidate',
      })],
    });

    const entry = useDownloadStore.getState().queue.find((model) => model.id === 'vision/model');
    expect(entry?.projectorCandidates?.[0]).toEqual(expect.objectContaining({
      id: getCanonicalProjectorId('fresh-mmproj.gguf'),
      fileName: 'fresh-mmproj.gguf',
      localPath: 'fresh-mmproj.gguf',
      lifecycleStatus: 'downloaded',
      matchStatus: 'user_selected',
    }));
    expect(entry?.selectedProjectorId).toBe(getCanonicalProjectorId('fresh-mmproj.gguf'));
    expect(entry?.multimodalReadiness).toEqual(expect.objectContaining({
      status: 'ready',
      projectorId: getCanonicalProjectorId('fresh-mmproj.gguf'),
      checkedAt: 456,
    }));
  });

  it('keeps the current incoming selection instead of falling back to another exact scope', () => {
    useDownloadStore.setState({
      queue: [
        {
          ...buildQueuedModel('vision/model', LifecycleStatus.PAUSED),
          selectedProjectorId: 'vision/model:mmproj-a',
          multimodalReadiness: {
            modelId: 'vision/model',
            status: 'ready',
            projectorId: 'vision/model:mmproj-a',
            projectorSize: 256,
            support: ['vision'],
            checkedAt: 123,
          },
          projectorCandidates: [
            buildProjector({
              id: 'vision/model:mmproj-a',
              fileName: 'mmproj-a.gguf',
              localPath: 'partial-mmproj-a.gguf',
              resumeData: JSON.stringify({ resumeData: 'projector-a-resume' }),
              lifecycleStatus: 'paused',
              matchStatus: 'user_selected',
              matchReason: 'user_selected_projector',
            }),
            buildProjector({
              id: 'vision/model:mmproj-b',
              fileName: 'stale-mmproj-b.gguf',
              localPath: 'partial-stale-mmproj-b.gguf',
              resumeData: JSON.stringify({ resumeData: 'stale-projector-b-resume' }),
              lifecycleStatus: 'paused',
            }),
          ],
        },
      ],
      activeDownloadId: null,
    });

    useDownloadStore.getState().addToQueue({
      ...buildQueuedModel('vision/model', LifecycleStatus.AVAILABLE),
      selectedProjectorId: 'vision/model:mmproj-b',
      projectorCandidates: [
        buildProjector({
          id: 'vision/model:mmproj-a',
          fileName: 'mmproj-a.gguf',
          lifecycleStatus: 'available',
          matchStatus: 'matched',
        }),
        buildProjector({
          id: 'vision/model:mmproj-b',
          fileName: 'fresh-mmproj-b.gguf',
          lifecycleStatus: 'available',
          matchStatus: 'matched',
        }),
      ],
    });

    const entry = useDownloadStore.getState().queue.find((model) => model.id === 'vision/model');
    const projectorAId = getCanonicalProjectorId('mmproj-a.gguf');
    const projectorBId = getCanonicalProjectorId('fresh-mmproj-b.gguf');
    const projectorA = entry?.projectorCandidates?.find((projector) => projector.id === projectorAId);
    const projectorB = entry?.projectorCandidates?.find((projector) => projector.id === projectorBId);
    expect(projectorA).toEqual(expect.objectContaining({
      id: projectorAId,
      localPath: 'partial-mmproj-a.gguf',
    }));
    expect(projectorB).toEqual(expect.objectContaining({
      id: projectorBId,
      fileName: 'fresh-mmproj-b.gguf',
    }));
    expect(projectorB?.localPath).toBeUndefined();
    expect(entry?.selectedProjectorId).toBe(projectorBId);
    expect(entry?.multimodalReadiness).toBeUndefined();
  });

  it('preserves runtime projector candidates when re-queuing a model without catalog candidates', () => {
    useDownloadStore.setState({
      queue: [
        {
          ...buildQueuedModel('vision/model', LifecycleStatus.FAILED),
          selectedProjectorId: 'vision/model:mmproj',
          projectorCandidates: [buildProjector({
            localPath: 'partial-mmproj-model.gguf',
            resumeData: 'projector-resume-data',
            lifecycleStatus: 'paused',
            matchStatus: 'user_selected',
            matchReason: 'user_selected_projector',
          })],
        },
      ],
      activeDownloadId: null,
    });

    useDownloadStore.getState().addToQueue(buildQueuedModel('vision/model', LifecycleStatus.AVAILABLE));

    const entry = useDownloadStore.getState().queue.find((model) => model.id === 'vision/model');
    expect(entry?.lifecycleStatus).toBe(LifecycleStatus.QUEUED);
    expect(entry?.selectedProjectorId).toBe(getCanonicalProjectorId());
    expect(entry?.projectorCandidates).toEqual([
      expect.objectContaining({
        id: getCanonicalProjectorId(),
        localPath: 'partial-mmproj-model.gguf',
        resumeData: 'projector-resume-data',
        lifecycleStatus: 'paused',
        matchStatus: 'user_selected',
      }),
    ]);
  });

  it('clears runtime projector state when re-queuing an authoritative empty catalog result', () => {
    useDownloadStore.setState({
      queue: [
        {
          ...buildQueuedModel('vision/model', LifecycleStatus.FAILED),
          selectedProjectorId: 'vision/model:mmproj',
          multimodalReadiness: {
            modelId: 'vision/model',
            status: 'ready',
            projectorId: 'vision/model:mmproj',
            projectorSize: 256,
            support: ['vision'],
            checkedAt: 123,
          },
          projectorCandidates: [buildProjector({
            localPath: 'partial-mmproj-model.gguf',
            resumeData: 'projector-resume-data',
            lifecycleStatus: 'paused',
            matchStatus: 'user_selected',
            matchReason: 'user_selected_projector',
          })],
        },
      ],
      activeDownloadId: null,
    });

    useDownloadStore.getState().addToQueue({
      ...buildQueuedModel('vision/model', LifecycleStatus.AVAILABLE),
      projectorCandidates: [],
    });

    const entry = useDownloadStore.getState().queue.find((model) => model.id === 'vision/model');
    expect(entry?.lifecycleStatus).toBe(LifecycleStatus.QUEUED);
    expect(entry?.projectorCandidates).toEqual([]);
    expect(entry?.selectedProjectorId).toBeUndefined();
    expect(entry?.multimodalReadiness).toBeUndefined();
  });

  it('does not preserve variant-scoped projector candidates for another active variant when re-queuing without catalog candidates', () => {
    useDownloadStore.setState({
      queue: [
        {
          ...buildQueuedModel('vision/model', LifecycleStatus.FAILED),
          resolvedFileName: 'model.Q8_0.gguf',
          activeVariantId: 'model.Q8_0.gguf',
          selectedProjectorId: 'vision/model:mmproj-q4',
          multimodalReadiness: {
            modelId: 'vision/model',
            variantId: 'model.Q4_K_M.gguf',
            status: 'ready',
            projectorId: 'vision/model:mmproj-q4',
            support: ['vision'],
            checkedAt: 123,
          },
          projectorCandidates: [buildProjector({
            id: 'vision/model:mmproj-q4',
            ownerVariantId: 'model.Q4_K_M.gguf',
            localPath: 'partial-mmproj-q4.gguf',
            resumeData: 'projector-resume-data',
            lifecycleStatus: 'paused',
            matchStatus: 'user_selected',
            matchReason: 'user_selected_projector',
          })],
        },
      ],
      activeDownloadId: null,
    });

    useDownloadStore.getState().addToQueue({
      ...buildQueuedModel('vision/model', LifecycleStatus.AVAILABLE),
      resolvedFileName: 'model.Q8_0.gguf',
      activeVariantId: 'model.Q8_0.gguf',
    });

    const entry = useDownloadStore.getState().queue.find((model) => model.id === 'vision/model');
    expect(entry?.lifecycleStatus).toBe(LifecycleStatus.QUEUED);
    expect(entry?.projectorCandidates).toBeUndefined();
    expect(entry?.selectedProjectorId).toBeUndefined();
    expect(entry?.multimodalReadiness).toBeUndefined();
  });

  it('clears resumable state for legacy entries lacking file identity when another variant is queued', () => {
    useDownloadStore.setState({
      queue: [
        {
          ...buildQueuedModel('legacy-variant', LifecycleStatus.PAUSED),
          size: null,
          downloadUrl: undefined as unknown as string,
          hfRevision: 'main',
          resumeData: 'legacy-resume-data',
          downloadProgress: 0.64,
          localPath: 'legacy-variant.Q4_K_M.partial.gguf',
          allowUnknownSizeDownload: true,
          downloadIntegrity: {
            kind: 'size',
            sizeBytes: 4 * 1024 * 1024 * 1024,
            checkedAt: 456,
          },
        },
      ],
      activeDownloadId: null,
    });

    useDownloadStore.getState().addToQueue({
      ...buildQueuedModel('legacy-variant', LifecycleStatus.AVAILABLE),
      size: null,
      downloadUrl: 'https://example.com/legacy-variant.Q8_0.gguf',
      resolvedFileName: 'legacy-variant.Q8_0.gguf',
      hfRevision: 'main',
      downloadProgress: 0,
      allowUnknownSizeDownload: false,
    });

    const entry = useDownloadStore.getState().queue.find((model) => model.id === 'legacy-variant');
    expect(entry).toEqual(expect.objectContaining({
      lifecycleStatus: LifecycleStatus.QUEUED,
      size: null,
      downloadUrl: 'https://example.com/legacy-variant.Q8_0.gguf',
      resolvedFileName: 'legacy-variant.Q8_0.gguf',
      hfRevision: 'main',
      downloadProgress: 0,
      allowUnknownSizeDownload: false,
    }));
    expect(entry?.resumeData).toBeUndefined();
    expect(entry?.localPath).toBeUndefined();
    expect(entry?.downloadIntegrity).toBeUndefined();
  });

  it.each([
    LifecycleStatus.PAUSED,
    LifecycleStatus.FAILED,
    LifecycleStatus.AVAILABLE,
  ])('clears resumable state when re-queuing a %s entry for another variant', (lifecycleStatus) => {
    const oldSha256 = 'a'.repeat(64);
    const newSha256 = 'b'.repeat(64);

    useDownloadStore.setState({
      queue: [
        {
          ...buildQueuedModel('variant', lifecycleStatus),
          size: 4 * 1024 * 1024 * 1024,
          downloadUrl: 'https://example.com/variant.Q4_K_M.gguf',
          resolvedFileName: 'variant.Q4_K_M.gguf',
          sha256: oldSha256,
          metadataTrust: 'trusted_remote',
          gguf: {
            totalBytes: 4 * 1024 * 1024 * 1024,
            sizeLabel: 'Q4_K_M',
            contextLengthTokens: 4096,
          },
          memoryFitDecision: 'fits_high_confidence',
          memoryFitConfidence: 'high',
          maxContextTokens: 4096,
          hasVerifiedContextWindow: true,
          capabilitySnapshot: {
            heuristicVersion: 1,
            modelLayerCount: null,
            gpuLayersCeiling: 0,
            metadataTrust: 'trusted_remote',
            sizeBytes: 4 * 1024 * 1024 * 1024,
            sha256: oldSha256,
          },
          resumeData: 'resume-data',
          downloadProgress: 0.42,
          localPath: 'variant.Q4_K_M.partial.gguf',
          allowUnknownSizeDownload: true,
          downloadIntegrity: {
            kind: 'sha256',
            sizeBytes: 4 * 1024 * 1024 * 1024,
            sha256: oldSha256,
            checkedAt: 123,
          },
        },
      ],
      activeDownloadId: null,
    });

    useDownloadStore.getState().addToQueue({
      ...buildQueuedModel('variant', LifecycleStatus.AVAILABLE),
      size: 8 * 1024 * 1024 * 1024,
      downloadUrl: 'https://example.com/variant.Q8_0.gguf',
      resolvedFileName: 'variant.Q8_0.gguf',
      sha256: newSha256,
      downloadProgress: 0,
      allowUnknownSizeDownload: false,
    });

    const entry = useDownloadStore.getState().queue.find((model) => model.id === 'variant');
    expect(entry).toEqual(expect.objectContaining({
      lifecycleStatus: LifecycleStatus.QUEUED,
      size: 8 * 1024 * 1024 * 1024,
      downloadUrl: 'https://example.com/variant.Q8_0.gguf',
      resolvedFileName: 'variant.Q8_0.gguf',
      sha256: newSha256,
      downloadProgress: 0,
      allowUnknownSizeDownload: false,
    }));
    expect(entry?.resumeData).toBeUndefined();
    expect(entry?.localPath).toBeUndefined();
    expect(entry?.downloadIntegrity).toBeUndefined();
    expect(entry?.metadataTrust).toBeUndefined();
    expect(entry?.gguf).toBeUndefined();
    expect(entry?.memoryFitDecision).toBeUndefined();
    expect(entry?.memoryFitConfidence).toBeUndefined();
    expect(entry?.maxContextTokens).toBeUndefined();
    expect(entry?.hasVerifiedContextWindow).toBe(false);
    expect(entry?.capabilitySnapshot).toBeUndefined();
  });

  it('adds new models to the queue as QUEUED', () => {
    useDownloadStore.getState().addToQueue(buildQueuedModel('new', LifecycleStatus.AVAILABLE));
    const entry = useDownloadStore.getState().queue.find((model) => model.id === 'new');
    expect(entry?.lifecycleStatus).toBe(LifecycleStatus.QUEUED);
  });

  it('keeps queued main artifact runtime state synchronized with queue updates', () => {
    const resolvedFileName = 'artifact-model.Q4_K_M.gguf';
    const modelId = 'artifact/model';
    const mainArtifactId = buildMainModelArtifactId({
      id: modelId,
      hfRevision: 'main',
      resolvedFileName,
    });

    useDownloadStore.getState().addToQueue({
      ...buildQueuedModel(modelId, LifecycleStatus.AVAILABLE),
      hfRevision: 'main',
      resolvedFileName,
      artifacts: [
        {
          id: mainArtifactId,
          kind: 'main_model',
          requiredFor: ['text'],
          hfRevision: 'main',
          remoteFileName: resolvedFileName,
          downloadUrl: 'https://example.com/artifact-model.Q4_K_M.gguf',
          sizeBytes: 1024,
          installState: 'remote',
        },
      ],
    });

    useDownloadStore.getState().updateModelInQueue(modelId, {
      lifecycleStatus: LifecycleStatus.DOWNLOADING,
      downloadProgress: 0.5,
      resumeData: 'main-resume-data',
    });

    const entry = useDownloadStore.getState().queue.find((model) => model.id === modelId);
    const mainArtifact = entry?.artifacts?.find((artifact) => artifact.id === mainArtifactId);
    expect(mainArtifact).toEqual(expect.objectContaining({
      installState: 'downloading',
      downloadProgress: 0.5,
      resumeData: 'main-resume-data',
    }));
  });

  it('ignores addToQueue when the model is already queued or in-flight', () => {
    useDownloadStore.setState({
      queue: [
        buildQueuedModel('q', LifecycleStatus.QUEUED),
        buildQueuedModel('d', LifecycleStatus.DOWNLOADING),
        buildQueuedModel('v', LifecycleStatus.VERIFYING),
      ],
      activeDownloadId: null,
    });

    const before = useDownloadStore.getState().queue;
    useDownloadStore.getState().addToQueue(buildQueuedModel('q', LifecycleStatus.AVAILABLE));
    useDownloadStore.getState().addToQueue(buildQueuedModel('d', LifecycleStatus.AVAILABLE));
    useDownloadStore.getState().addToQueue(buildQueuedModel('v', LifecycleStatus.AVAILABLE));
    expect(useDownloadStore.getState().queue).toBe(before);
  });

  it('re-queues available entries (previous failures) when tapped again', () => {
    useDownloadStore.setState({
      queue: [
        {
          ...buildQueuedModel('avail', LifecycleStatus.AVAILABLE),
          resumeData: 'resume-data',
          downloadProgress: 0.12,
        },
      ],
      activeDownloadId: null,
    });

    useDownloadStore.getState().addToQueue(buildQueuedModel('avail', LifecycleStatus.AVAILABLE));
    const entry = useDownloadStore.getState().queue.find((model) => model.id === 'avail');
    expect(entry?.lifecycleStatus).toBe(LifecycleStatus.QUEUED);
    expect(entry?.resumeData).toBe('resume-data');
    expect(entry?.downloadProgress).toBe(0.12);
  });

  it('re-queues failed entries while clearing the visible failure state', () => {
    useDownloadStore.setState({
      queue: [
        {
          ...buildQueuedModel('failed', LifecycleStatus.FAILED),
          downloadErrorAt: 123,
          downloadErrorCode: 'download_size_unknown',
          downloadErrorMessage: 'MODEL_SIZE_UNKNOWN',
        },
      ],
      activeDownloadId: null,
    });

    useDownloadStore.getState().addToQueue(buildQueuedModel('failed', LifecycleStatus.AVAILABLE));
    const entry = useDownloadStore.getState().queue.find((model) => model.id === 'failed');
    expect(entry?.lifecycleStatus).toBe(LifecycleStatus.QUEUED);
    expect(entry?.downloadErrorAt).toBeUndefined();
    expect(entry?.downloadErrorCode).toBeUndefined();
    expect(entry?.downloadErrorMessage).toBeUndefined();
  });

  it('removeFromQueue clears activeDownloadId when removing the active entry', () => {
    useDownloadStore.setState({
      queue: [buildQueuedModel('active', LifecycleStatus.QUEUED)],
      activeDownloadId: 'active',
    });

    useDownloadStore.getState().removeFromQueue('active');
    expect(useDownloadStore.getState().activeDownloadId).toBeNull();
    expect(useDownloadStore.getState().queue).toEqual([]);
  });

  it('partialize zeroes progress for DOWNLOADING/VERIFYING entries only', () => {
    const options = (useDownloadStore as any).persist?.getOptions?.();
    expect(options?.partialize).toEqual(expect.any(Function));

    const state = {
      queue: [
        { ...buildQueuedModel('a', LifecycleStatus.DOWNLOADING), downloadProgress: 0.9 },
        { ...buildQueuedModel('b', LifecycleStatus.VERIFYING), downloadProgress: 0.8 },
        { ...buildQueuedModel('c', LifecycleStatus.PAUSED), downloadProgress: 0.7 },
      ],
      activeDownloadId: 'a',
    };

    const partial = options.partialize(state);
    expect(partial.queue.find((m: any) => m.id === 'a')?.downloadProgress).toBe(0);
    expect(partial.queue.find((m: any) => m.id === 'b')?.downloadProgress).toBe(0);
    expect(partial.queue.find((m: any) => m.id === 'c')?.downloadProgress).toBe(0.7);
  });

  it('onRehydrateStorage resets activeDownloadId and normalizes persisted in-flight entries', () => {
    const options = (useDownloadStore as any).persist?.getOptions?.();
    expect(options?.onRehydrateStorage).toEqual(expect.any(Function));

    const persisted = {
      queue: [buildQueuedModel('d', LifecycleStatus.DOWNLOADING)],
      activeDownloadId: 'd',
    };

    const handler = options.onRehydrateStorage();
    handler(persisted);

    expect(persisted.activeDownloadId).toBeNull();
    expect(persisted.queue[0].lifecycleStatus).toBe(LifecycleStatus.QUEUED);
  });

  it('normalizes legacy queue entries with zero size to unknown size defaults', () => {
    const [normalized] = normalizePersistedDownloadQueue([
      {
        ...buildQueuedModel('legacy', LifecycleStatus.QUEUED),
        size: 0,
        fitsInRam: true,
      },
    ]);

    expect(normalized.size).toBeNull();
    expect(normalized.fitsInRam).toBeNull();
    expect(normalized.accessState).toBe(ModelAccessState.PUBLIC);
  });

  it('keeps both revision-aware and legacy partial filenames queued during bootstrap', () => {
    useDownloadStore.setState({
      queue: [
        {
          ...buildQueuedModel('legacy/model', LifecycleStatus.QUEUED),
          resolvedFileName: 'model.Q4_K_M.gguf',
          hfRevision: 'cafebabe1234',
        },
      ],
      activeDownloadId: null,
    });

    const queuedFileNames = getQueuedDownloadFileNames();

    expect(queuedFileNames).toContain('legacy_model.gguf');
    expect(
      queuedFileNames.some((fileName) => fileName.startsWith('model-cafebabe1234-') && fileName.endsWith('.gguf')),
    ).toBe(true);
  });

  it('keeps queued localPath filenames protected from quarantine scans', () => {
    useDownloadStore.setState({
      queue: [
        {
          ...buildQueuedModel('legacy/model', LifecycleStatus.PAUSED),
          localPath: 'custom-partial.gguf',
        },
        {
          ...buildQueuedModel('bad/model', LifecycleStatus.FAILED),
          localPath: '../bad.gguf',
        },
      ],
      activeDownloadId: null,
    });

    const queuedFileNames = getQueuedDownloadFileNames();

    expect(queuedFileNames).toContain('custom-partial.gguf');
    expect(queuedFileNames).not.toContain('../bad.gguf');
  });

  it('keeps queued projector file names protected from quarantine scans', () => {
    useDownloadStore.setState({
      queue: [
        {
          ...buildQueuedModel('vision/model', LifecycleStatus.QUEUED),
          projectorCandidates: [
            {
              id: 'vision/model:projector',
              ownerModelId: 'vision/model',
              repoId: 'vision/model',
              fileName: 'mmproj-model.gguf',
              downloadUrl: 'https://example.com/mmproj-model.gguf',
              size: 256,
              localPath: 'queued-mmproj-model.gguf',
              lifecycleStatus: 'queued',
              matchStatus: 'matched',
            },
            {
              id: 'vision/model:bad-projector',
              ownerModelId: 'vision/model',
              repoId: 'vision/model',
              fileName: '../bad-mmproj.gguf',
              downloadUrl: 'https://example.com/bad-mmproj.gguf',
              size: 256,
              localPath: '../bad-local-mmproj.gguf',
              lifecycleStatus: 'queued',
              matchStatus: 'matched',
            },
          ],
        },
        {
          ...buildQueuedModel('audio/model', LifecycleStatus.QUEUED),
          activeVariantId: 'audio-q4',
          resolvedFileName: 'audio-model.gguf',
          variants: [{
            variantId: 'audio-q4',
            fileName: 'audio-model.gguf',
            quantizationLabel: 'Q4_K_M',
            size: 1024,
            chatModalities: ['text', 'audio'],
            projectorCandidates: [buildProjector({
              id: 'audio/model:projector',
              ownerModelId: 'audio/model',
              ownerVariantId: 'audio-q4',
              repoId: 'audio/model',
              fileName: 'mmproj-audio.gguf',
              downloadUrl: 'https://example.com/mmproj-audio.gguf',
              localPath: 'queued-mmproj-audio.gguf',
              lifecycleStatus: 'queued',
            })],
          }],
        },
      ],
      activeDownloadId: null,
    });

    const queuedFileNames = getQueuedDownloadFileNames();

    expect(queuedFileNames).toContain('mmproj-model.gguf');
    expect(
      queuedFileNames.some((fileName) => /^model-mmproj-model-main-[a-z0-9]+\.gguf$/.test(fileName)),
    ).toBe(true);
    expect(queuedFileNames).toContain('queued-mmproj-model.gguf');
    expect(queuedFileNames).toContain('mmproj-audio.gguf');
    expect(queuedFileNames).toContain('queued-mmproj-audio.gguf');
    expect(queuedFileNames).not.toContain('../bad-mmproj.gguf');
    expect(queuedFileNames).not.toContain('../bad-local-mmproj.gguf');
  });

  it('keeps queued speculative draft file names protected from quarantine scans', () => {
    useDownloadStore.setState({
      queue: [
        {
          ...buildQueuedModel('gemma/model', LifecycleStatus.PAUSED),
          hfRevision: 'revision-1',
          artifacts: [
            {
              id: 'gemma/model:mtp-draft',
              kind: 'speculative_draft',
              requiredFor: ['text'],
              hfRevision: 'revision-1',
              remoteFileName: 'gemma-MTP-Q4_K_M.gguf',
              downloadUrl: 'https://example.com/gemma-MTP-Q4_K_M.gguf',
              sizeBytes: 512,
              localPath: 'queued-gemma-mtp.gguf',
              installState: 'queued',
            },
            {
              id: 'gemma/model:bad-mtp-draft',
              kind: 'speculative_draft',
              requiredFor: ['text'],
              remoteFileName: '../bad-MTP.gguf',
              downloadUrl: 'https://example.com/bad-MTP.gguf',
              sizeBytes: 512,
              localPath: '../bad-local-MTP.gguf',
              installState: 'queued',
            },
          ],
        },
      ],
      activeDownloadId: null,
    });

    const queuedFileNames = getQueuedDownloadFileNames();

    expect(queuedFileNames).toContain('queued-gemma-mtp.gguf');
    expect(
      queuedFileNames.some((fileName) => /^model-gemma-MTP-Q4_K_M-revision-1-[a-z0-9]+\.gguf$/.test(fileName)),
    ).toBe(true);
    expect(queuedFileNames).not.toContain('../bad-MTP.gguf');
    expect(queuedFileNames).not.toContain('../bad-local-MTP.gguf');
  });
});
