import {
  getQueuedDownloadFileNames,
  normalizePersistedDownloadQueue,
  useDownloadStore,
} from '../../src/store/downloadStore';
import { LifecycleStatus, ModelAccessState, type ModelMetadata } from '../../src/types/models';

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
});
