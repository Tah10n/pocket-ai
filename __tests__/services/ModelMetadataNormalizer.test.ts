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

  it('normalizes catalog variants and preserves valid active variant selections', () => {
    const normalized = normalizePersistedModelMetadata({
      id: 'author/model-q4',
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      resolvedFileName: 'model.Q4_K_M.gguf',
      activeVariantId: 'model.Q4_K_M.gguf',
      variants: [
        {
          variantId: 'model.Q4_K_M.gguf',
          fileName: 'model.Q4_K_M.gguf',
          quantizationLabel: 'Q4_K_M',
          size: 4_000_000_000,
          sha256: `sha256:${VALID_SHA256.toUpperCase()}`,
          ramFit: 'fits_low_confidence',
          ramFitConfidence: 'low',
        },
        {
          variantId: '',
          fileName: '',
          quantizationLabel: 'broken',
          size: 0,
        },
      ],
    });

    expect(normalized.variants).toEqual([
      {
        variantId: 'model.Q4_K_M.gguf',
        fileName: 'model.Q4_K_M.gguf',
        quantizationLabel: 'Q4_K_M',
        size: 4_000_000_000,
        sha256: VALID_SHA256,
        ramFit: 'fits_low_confidence',
        ramFitConfidence: 'low',
      },
    ]);
    expect(normalized.activeVariantId).toBe('model.Q4_K_M.gguf');

    const mismatched = normalizePersistedModelMetadata({
      id: 'author/model-q4',
      activeVariantId: 'missing.gguf',
      variants: normalized.variants,
    });

    expect(mismatched.activeVariantId).toBeUndefined();

    const opaqueWithoutVariants = normalizePersistedModelMetadata({
      id: 'author/model-q4',
      activeVariantId: 'catalog-choice-q8',
    });

    expect(opaqueWithoutVariants.activeVariantId).toBe('catalog-choice-q8');
  });

  it('preserves multimodal model and variant metadata with valid projector candidates', () => {
    const normalized = normalizePersistedModelMetadata({
      id: 'author/vision-model',
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      resolvedFileName: 'vision-model.Q4_K_M.gguf',
      activeVariantId: 'vision-model.Q4_K_M.gguf',
      chatModalities: ['text', 'vision'],
      artifactRole: 'primary_chat_model',
      visionSource: 'tree_probe',
      visionConfidence: 'trusted',
      selectedProjectorId: 'projector-author-vision-model-main-vision-model.Q4_K_M.gguf-mmproj-vision-model-f16.gguf',
      projectorCandidates: [
        {
          id: 'projector-author-vision-model-main-vision-model.Q4_K_M.gguf-mmproj-vision-model-f16.gguf',
          ownerModelId: 'author/vision-model',
          ownerVariantId: 'vision-model.Q4_K_M.gguf',
          repoId: 'author/vision-model',
          fileName: 'mmproj-vision-model-f16.gguf',
          downloadUrl: 'https://huggingface.co/author/vision-model/resolve/main/mmproj-vision-model-f16.gguf',
          hfRevision: 'main',
          sha256: `sha256:${VALID_SHA256.toUpperCase()}`,
          size: 536_870_912,
          lifecycleStatus: 'downloaded',
          matchStatus: 'matched',
          matchReason: 'single_projector_candidate',
          localPath: 'mmproj-vision-model-f16.gguf',
        },
      ],
      variants: [
        {
          variantId: 'vision-model.Q4_K_M.gguf',
          fileName: 'vision-model.Q4_K_M.gguf',
          quantizationLabel: 'Q4_K_M',
          size: 4_000_000_000,
          chatModalities: ['text', 'vision'],
          artifactRole: 'primary_chat_model',
        },
      ],
    });

    expect(normalized).toEqual(expect.objectContaining({
      chatModalities: ['text', 'vision'],
      artifactRole: 'primary_chat_model',
      visionSource: 'tree_probe',
      visionConfidence: 'trusted',
      selectedProjectorId: 'projector-author-vision-model-main-vision-model.Q4_K_M.gguf-mmproj-vision-model-f16.gguf',
    }));
    expect(normalized.projectorCandidates).toEqual([
      expect.objectContaining({
        id: 'projector-author-vision-model-main-vision-model.Q4_K_M.gguf-mmproj-vision-model-f16.gguf',
        sha256: VALID_SHA256,
        lifecycleStatus: 'downloaded',
        matchStatus: 'matched',
      }),
    ]);
    expect(normalized.variants).toEqual([
      expect.objectContaining({
        variantId: 'vision-model.Q4_K_M.gguf',
        chatModalities: ['text', 'vision'],
        artifactRole: 'primary_chat_model',
      }),
    ]);
  });

  it('dedupes persisted variants by file while preserving active legacy variant metadata', () => {
    const normalized = normalizePersistedModelMetadata({
      id: 'author/model-q4',
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      resolvedFileName: 'model.Q8_0.gguf',
      activeVariantId: 'legacy-q8-selection',
      variants: [
        {
          variantId: 'model.Q8_0.gguf',
          fileName: 'model.Q8_0.gguf',
          quantizationLabel: 'Q8_0',
          size: 8_000_000_000,
          sha256: VALID_SHA256,
        },
        {
          variantId: 'legacy-q8-selection',
          fileName: 'model.Q8_0.gguf',
          quantizationLabel: 'Q8_0',
          size: 8_000_000_000,
          sha256: OTHER_VALID_SHA256,
        },
      ],
    });

    expect(normalized.variants).toEqual([
      {
        variantId: 'legacy-q8-selection',
        fileName: 'model.Q8_0.gguf',
        quantizationLabel: 'Q8_0',
        size: 8_000_000_000,
        sha256: OTHER_VALID_SHA256,
      },
    ]);
    expect(normalized.activeVariantId).toBe('legacy-q8-selection');
  });

  it('rejects non-GGUF, projector, and MTP persisted variants', () => {
    const normalized = normalizePersistedModelMetadata({
      id: 'author/model-q4',
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      activeVariantId: 'model.mmproj.gguf',
      variants: [
        {
          variantId: 'model.bin',
          fileName: 'model.bin',
          quantizationLabel: 'BIN',
          size: 4_000_000_000,
        },
        {
          variantId: 'model.mmproj.gguf',
          fileName: 'model.mmproj.gguf',
          quantizationLabel: 'Q4_K_M',
          size: 4_000_000_000,
        },
        {
          variantId: 'model.NextN.Q4_K_M.gguf',
          fileName: 'model.NextN.Q4_K_M.gguf',
          quantizationLabel: 'Q4_K_M',
          size: 4_000_000_000,
        },
        {
          variantId: 'model.Q4_K_M.gguf',
          fileName: 'model.Q4_K_M.gguf',
          quantizationLabel: 'Q4_K_M',
          size: 4_000_000_000,
        },
      ],
    });

    expect(normalized.variants).toEqual([
      {
        variantId: 'model.Q4_K_M.gguf',
        fileName: 'model.Q4_K_M.gguf',
        quantizationLabel: 'Q4_K_M',
        size: 4_000_000_000,
      },
    ]);
    expect(normalized.activeVariantId).toBeUndefined();
  });

  it('drops unsupported MTP variants from persisted catalog metadata', () => {
    const normalized = normalizePersistedModelMetadata({
      id: 'author/model-q4',
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      resolvedFileName: 'model.Q4_K_M.gguf',
      activeVariantId: 'model.NextN.Q4_K_M.gguf',
      variants: [
        {
          variantId: 'model.NextN.Q4_K_M.gguf',
          fileName: 'model.NextN.Q4_K_M.gguf',
          quantizationLabel: 'Q4_K_M',
          size: 4_000_000_000,
        },
        {
          variantId: 'model.Q4_K_M.gguf',
          fileName: 'model.Q4_K_M.gguf',
          quantizationLabel: 'Q4_K_M',
          size: 4_000_000_000,
        },
      ],
    });

    expect(normalized.variants).toEqual([
      {
        variantId: 'model.Q4_K_M.gguf',
        fileName: 'model.Q4_K_M.gguf',
        quantizationLabel: 'Q4_K_M',
        size: 4_000_000_000,
      },
    ]);
    expect(normalized.activeVariantId).toBe('model.Q4_K_M.gguf');
  });

  it('normalizes persisted resumeData to opaque native strings without auth material', () => {
    const legacySnapshot = JSON.stringify({
      url: 'https://huggingface.co/author/model/resolve/main/model.gguf',
      fileUri: 'file:///model.gguf',
      options: { headers: { Authorization: 'Bearer model-secret' } },
      resumeData: 'model-native-resume',
    });
    const projectorSnapshot = JSON.stringify({
      url: 'https://huggingface.co/author/model/resolve/main/mmproj-model.gguf',
      options: { headers: { Authorization: 'Bearer projector-secret' } },
      resumeData: 'projector-native-resume',
    });

    const normalized = normalizePersistedModelMetadata({
      id: 'author/vision-model',
      lifecycleStatus: LifecycleStatus.PAUSED,
      downloadProgress: 0.5,
      resumeData: legacySnapshot,
      projectorCandidates: [
        {
          id: 'projector-author-vision-model-main-mmproj-model.gguf',
          ownerModelId: 'author/vision-model',
          repoId: 'author/vision-model',
          fileName: 'mmproj-model.gguf',
          downloadUrl: 'https://huggingface.co/author/model/resolve/main/mmproj-model.gguf',
          size: null,
          lifecycleStatus: 'paused',
          matchStatus: 'matched',
          resumeData: projectorSnapshot,
        },
      ],
    });

    expect(normalized.resumeData).toBe('model-native-resume');
    expect(normalized.projectorCandidates?.[0]?.resumeData).toBe('projector-native-resume');
    expect(JSON.stringify(normalized)).not.toMatch(/Authorization|Bearer/);
  });

  it('drops persisted resumeData without native resumeData or with auth material', () => {
    const normalized = normalizePersistedModelMetadata({
      id: 'author/vision-model',
      lifecycleStatus: LifecycleStatus.PAUSED,
      downloadProgress: 0.5,
      resumeData: JSON.stringify({ url: 'https://example.com/model.gguf' }),
      projectorCandidates: [
        {
          id: 'projector-author-vision-model-main-mmproj-model.gguf',
          ownerModelId: 'author/vision-model',
          repoId: 'author/vision-model',
          fileName: 'mmproj-model.gguf',
          downloadUrl: 'https://huggingface.co/author/model/resolve/main/mmproj-model.gguf',
          size: null,
          lifecycleStatus: 'paused',
          matchStatus: 'matched',
          resumeData: 'Bearer projector-secret',
        },
      ],
    });

    expect(normalized.resumeData).toBeUndefined();
    expect(normalized.projectorCandidates?.[0]?.resumeData).toBeUndefined();
  });

  it('sanitizes persisted multimodal readiness failure reasons', () => {
    const normalized = normalizePersistedModelMetadata({
      id: 'author/vision-model',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
      multimodalReadiness: {
        modelId: 'author/vision-model',
        status: 'failed',
        support: ['vision'],
        failureReason: 'Native init failed for C:\\Users\\tester\\Project for Client\\mmproj file.gguf after retry',
        checkedAt: 10,
      },
    });

    expect(normalized.multimodalReadiness?.failureReason).toBe('Native init failed for [path] after retry');
    expect(JSON.stringify(normalized.multimodalReadiness)).not.toContain('Project for Client');
    expect(JSON.stringify(normalized.multimodalReadiness)).not.toContain('C:\\Users\\tester');

    const extensionless = normalizePersistedModelMetadata({
      id: 'author/vision-model',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
      multimodalReadiness: {
        modelId: 'author/vision-model',
        status: 'failed',
        support: ['vision'],
        failureReason: 'Native init failed for C:\\Users\\tester\\Project for Client',
        checkedAt: 11,
      },
    });

    expect(extensionless.multimodalReadiness?.failureReason).toBe('Native init failed for [path]');
    expect(JSON.stringify(extensionless.multimodalReadiness)).not.toContain('Project for Client');
    expect(JSON.stringify(extensionless.multimodalReadiness)).not.toContain('C:\\Users\\tester');
  });
});
