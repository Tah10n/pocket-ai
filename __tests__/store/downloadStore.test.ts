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
      ]),
    ).toEqual([
      expect.objectContaining({ id: 'queued', lifecycleStatus: LifecycleStatus.QUEUED }),
      expect.objectContaining({ id: 'downloading', lifecycleStatus: LifecycleStatus.QUEUED }),
      expect.objectContaining({ id: 'verifying', lifecycleStatus: LifecycleStatus.QUEUED }),
    ]);
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
});
