import { normalizePersistedModelMetadata } from '../../src/services/ModelMetadataNormalizer';
import { LifecycleStatus, ModelAccessState } from '../../src/types/models';

describe('ModelMetadataNormalizer', () => {
  it('maps zero-size legacy metadata to unknown size and nullable RAM fit', () => {
    const normalized = normalizePersistedModelMetadata({
      id: 'legacy/model',
      name: 'Legacy model',
      author: 'legacy',
      size: 0,
      downloadUrl: 'https://huggingface.co/legacy/model/resolve/main/model.gguf',
      fitsInRam: true,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
    });

    expect(normalized.size).toBeNull();
    expect(normalized.fitsInRam).toBeNull();
  });

  it('fills auth defaults for persisted records that predate gated-model support', () => {
    const normalized = normalizePersistedModelMetadata({
      id: 'legacy/model',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
    });

    expect(normalized.accessState).toBe(ModelAccessState.PUBLIC);
    expect(normalized.isGated).toBe(false);
    expect(normalized.isPrivate).toBe(false);
  });

  it('preserves the verified context-window marker when present', () => {
    const normalized = normalizePersistedModelMetadata({
      id: 'legacy/model',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
      hasVerifiedContextWindow: true,
    });

    expect(normalized.hasVerifiedContextWindow).toBe(true);
  });

  it('preserves valid local download integrity markers', () => {
    const normalized = normalizePersistedModelMetadata({
      id: 'legacy/model',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
      downloadIntegrity: {
        kind: 'size',
        sizeBytes: 2048,
        checkedAt: 10,
      },
    });

    expect(normalized.downloadIntegrity).toEqual({
      kind: 'size',
      sizeBytes: 2048,
      checkedAt: 10,
    });
  });

  it('drops invalid sha integrity markers without a digest', () => {
    const normalized = normalizePersistedModelMetadata({
      id: 'legacy/model',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
      downloadIntegrity: {
        kind: 'sha256',
        sizeBytes: 2048,
        checkedAt: 10,
      },
    });

    expect(normalized.downloadIntegrity).toBeUndefined();
  });

  it('drops unsafe persisted local paths', () => {
    const normalized = normalizePersistedModelMetadata({
      id: 'legacy/model',
      localPath: '../escape.gguf',
    });

    expect(normalized.localPath).toBeUndefined();
  });

  it('preserves prefixed GGUF metadata keys needed by memory-fit estimation', () => {
    const normalized = normalizePersistedModelMetadata({
      id: 'llama/model',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
      gguf: {
        architecture: 'llama',
        'general.architecture': 'llama',
        'llama.block_count': 32,
        'llama.attention.head_count': 32,
        'llama.attention.head_count_kv': 8,
        'llama.embedding_length': 4096,
      },
    });

    expect(normalized.gguf).toEqual(expect.objectContaining({
      architecture: 'llama',
      'general.architecture': 'llama',
      'llama.block_count': 32,
      'llama.attention.head_count': 32,
      'llama.attention.head_count_kv': 8,
      'llama.embedding_length': 4096,
    }));
  });

  it('falls back to the short repo label when persisted metadata has no name', () => {
    const normalized = normalizePersistedModelMetadata({
      id: 'author/model-q4',
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
    });

    expect(normalized.name).toBe('model-q4');
    expect(normalized.author).toBe('author');
  });
});
