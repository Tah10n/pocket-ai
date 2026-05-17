import { normalizePersistedModelMetadata } from '../../src/services/ModelMetadataNormalizer';
import { LifecycleStatus, ModelAccessState } from '../../src/types/models';

const VALID_SHA256 = 'a'.repeat(64);
const OTHER_VALID_SHA256 = 'b'.repeat(64);

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
      localPath: 'legacy_model.gguf',
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

  it('canonicalizes valid sha digests and drops malformed sha integrity markers', () => {
    const normalized = normalizePersistedModelMetadata({
      id: 'legacy/model',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
      localPath: 'legacy_model.gguf',
      sha256: `sha256:${VALID_SHA256.toUpperCase()}`,
      downloadIntegrity: {
        kind: 'sha256',
        sizeBytes: 2048,
        checkedAt: 10,
        sha256: `sha256:${VALID_SHA256.toUpperCase()}`,
      },
    });

    expect(normalized.sha256).toBe(VALID_SHA256);
    expect(normalized.downloadIntegrity).toEqual({
      kind: 'sha256',
      sizeBytes: 2048,
      checkedAt: 10,
      sha256: VALID_SHA256,
    });

    const malformed = normalizePersistedModelMetadata({
      id: 'legacy/model',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
      sha256: 'sha256:',
      downloadIntegrity: {
        kind: 'sha256',
        sizeBytes: 2048,
        checkedAt: 10,
        sha256: 'abc123',
      },
    });

    expect(malformed.sha256).toBeUndefined();
    expect(malformed.downloadIntegrity).toBeUndefined();
  });

  it('clears verified local trust and sha markers when persisted digests disagree', () => {
    const normalized = normalizePersistedModelMetadata({
      id: 'legacy/model',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
      localPath: 'legacy_model.gguf',
      metadataTrust: 'verified_local',
      sha256: OTHER_VALID_SHA256,
      downloadIntegrity: {
        kind: 'sha256',
        sizeBytes: 2048,
        checkedAt: 10,
        sha256: VALID_SHA256,
      },
      gguf: { totalBytes: 2048 },
      maxContextTokens: 8192,
      hasVerifiedContextWindow: true,
    });

    expect(normalized.sha256).toBe(OTHER_VALID_SHA256);
    expect(normalized.downloadIntegrity).toBeUndefined();
    expect(normalized.metadataTrust).toBeUndefined();
    expect(normalized.gguf).toBeUndefined();
    expect(normalized.fitsInRam).toBeNull();
    expect(normalized.maxContextTokens).toBeUndefined();
    expect(normalized.hasVerifiedContextWindow).toBe(false);
  });

  it('drops unsafe persisted local paths', () => {
    const normalized = normalizePersistedModelMetadata({
      id: 'legacy/model',
      localPath: '../escape.gguf',
    });

    expect(normalized.localPath).toBeUndefined();
  });

  it('resets downloaded state when persisted local paths are unsafe', () => {
    const normalized = normalizePersistedModelMetadata({
      id: 'legacy/model',
      localPath: '../escape.gguf',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
      downloadedAt: 123,
      metadataTrust: 'verified_local',
      resumeData: JSON.stringify({ resumeData: 'stale-resume-data' }),
      downloadErrorAt: 456,
      downloadErrorCode: 'download_http_error',
      downloadErrorMessage: 'HTTP status 500',
      downloadIntegrity: {
        kind: 'size',
        sizeBytes: 2048,
        checkedAt: 10,
      },
    });

    expect(normalized.localPath).toBeUndefined();
    expect(normalized.lifecycleStatus).toBe(LifecycleStatus.AVAILABLE);
    expect(normalized.downloadProgress).toBe(0);
    expect(normalized.downloadedAt).toBeUndefined();
    expect(normalized.metadataTrust).toBeUndefined();
    expect(normalized.downloadIntegrity).toBeUndefined();
    expect(normalized.resumeData).toBeUndefined();
    expect(normalized.downloadErrorAt).toBeUndefined();
    expect(normalized.downloadErrorCode).toBeUndefined();
    expect(normalized.downloadErrorMessage).toBeUndefined();
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
