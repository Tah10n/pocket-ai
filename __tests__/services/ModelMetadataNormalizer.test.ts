import { normalizePersistedModelMetadata } from '../../src/services/ModelMetadataNormalizer';
import { LifecycleStatus, ModelAccessState } from '../../src/types/models';
import { buildMainModelArtifactId } from '../../src/utils/modelArtifacts';
import { resolveEffectiveActiveVariantNativeSupport } from '../../src/utils/modelCapabilities';
import {
  buildLegacyProjectorArtifactId,
  buildProjectorArtifactId,
} from '../../src/utils/modelProjectors';

const VALID_SHA256 = 'a'.repeat(64);
const OTHER_VALID_SHA256 = 'b'.repeat(64);

function buildAvailableProjectorCandidate(modelId: string, id: string, fileName: string) {
  return {
    id,
    ownerModelId: modelId,
    repoId: modelId,
    fileName,
    downloadUrl: `https://huggingface.co/${modelId}/resolve/main/${fileName}`,
    hfRevision: 'main',
    size: 1_000_000,
    lifecycleStatus: 'available' as const,
    matchStatus: 'matched' as const,
  };
}

function buildRemoteProjectorArtifact(
  candidate: ReturnType<typeof buildAvailableProjectorCandidate>,
  requiredFor: Array<'image' | 'audio'>,
) {
  return {
    id: candidate.id,
    kind: 'multimodal_projector' as const,
    requiredFor,
    hfRevision: candidate.hfRevision,
    remoteFileName: candidate.fileName,
    downloadUrl: candidate.downloadUrl,
    sizeBytes: candidate.size,
    installState: 'remote' as const,
  };
}

describe('ModelMetadataNormalizer', () => {
  it('preserves native multimodal readiness when no projector evidence exists', () => {
    const modelId = 'author/native-vision-model';
    const normalized = normalizePersistedModelMetadata({
      id: modelId,
      chatModalities: ['text', 'vision'],
      multimodalReadiness: {
        modelId,
        status: 'ready',
        support: ['vision'],
        requestedSupport: ['vision'],
        checkedAt: 10,
      },
    });

    expect(normalized.multimodalReadiness).toEqual(expect.objectContaining({
      modelId,
      status: 'ready',
      support: ['vision'],
      requestedSupport: ['vision'],
    }));
  });

  it('remaps a legacy-only readiness scope and removes support outside the requested modality set', () => {
    const modelId = 'legacy/audio-model';
    const projectorIdentity = {
      repoId: modelId,
      fileName: 'Projectors/MMProj-Audio.GGUF',
    };
    const legacyProjectorId = buildLegacyProjectorArtifactId(projectorIdentity);
    const currentProjectorId = buildProjectorArtifactId(projectorIdentity);
    const projector = buildAvailableProjectorCandidate(
      modelId,
      legacyProjectorId,
      projectorIdentity.fileName,
    );
    const normalized = normalizePersistedModelMetadata({
      id: modelId,
      projectorCandidates: [projector],
      selectedProjectorId: legacyProjectorId,
      multimodalReadiness: {
        modelId,
        status: 'ready',
        projectorId: legacyProjectorId,
        support: ['vision', 'audio'],
        requestedSupport: ['audio'],
        checkedAt: 10,
      },
    });

    expect(normalized.multimodalReadiness).toEqual(expect.objectContaining({
      support: ['audio'],
      requestedSupport: ['audio'],
      projectorId: currentProjectorId,
    }));
    expect(normalized.selectedProjectorId).toBe(currentProjectorId);
    expect(normalized.projectorCandidates?.map((candidate) => candidate.id)).toEqual([
      currentProjectorId,
    ]);
  });

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
      resolvedFileName: 'legacy_model.gguf',
      size: 2048,
      downloadUrl: 'https://huggingface.co/legacy/model/resolve/main/legacy_model.gguf',
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
    expect(normalized.artifacts).toEqual([
      expect.objectContaining({
        kind: 'main_model',
        requiredFor: ['text'],
        remoteFileName: 'legacy_model.gguf',
        localPath: 'legacy_model.gguf',
        installState: 'installed',
        integrity: {
          kind: 'size',
          sizeBytes: 2048,
          checkedAt: 10,
        },
      }),
    ]);
  });

  it('syncs main artifact runtime state from normalized legacy download fields', () => {
    const resolvedFileName = 'legacy_model.Q4_K_M.gguf';
    const mainArtifactId = buildMainModelArtifactId({
      id: 'legacy/model',
      hfRevision: 'main',
      resolvedFileName,
    });

    const normalized = normalizePersistedModelMetadata({
      id: 'legacy/model',
      hfRevision: 'main',
      resolvedFileName,
      lifecycleStatus: LifecycleStatus.DOWNLOADING,
      downloadProgress: 0.58,
      resumeData: JSON.stringify({ resumeData: 'fresh-main-resume' }),
      artifacts: [
        {
          id: mainArtifactId,
          kind: 'main_model',
          requiredFor: ['text'],
          hfRevision: 'main',
          remoteFileName: resolvedFileName,
          downloadUrl: 'https://example.com/legacy_model.Q4_K_M.gguf',
          sizeBytes: 2048,
          localPath: 'stale-partial.gguf',
          installState: 'remote',
          downloadProgress: 0.9,
          resumeData: 'stale-main-resume',
          errorCode: 'download_http_error',
          errorMessage: 'stale failure',
          updatedAt: 20,
        },
      ],
    });

    const mainArtifact = normalized.artifacts?.find((artifact) => artifact.id === mainArtifactId);
    expect(mainArtifact).toEqual(expect.objectContaining({
      installState: 'downloading',
      downloadProgress: 0.58,
      resumeData: 'fresh-main-resume',
    }));
    expect(mainArtifact?.localPath).toBeUndefined();
    expect(mainArtifact?.errorCode).toBeUndefined();
    expect(mainArtifact?.errorMessage).toBeUndefined();
    expect(mainArtifact?.updatedAt).toBeUndefined();
  });

  it('fails closed when persisted projector runtime points at a different exact path', () => {
    const projectorIdentity = {
      repoId: 'author/vision-model',
      fileName: 'fresh-mmproj.gguf',
    };
    const projectorId = buildProjectorArtifactId(projectorIdentity);
    const normalized = normalizePersistedModelMetadata({
      id: 'author/vision-model',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
      localPath: 'vision-model.Q4_K_M.gguf',
      resolvedFileName: 'vision-model.Q4_K_M.gguf',
      artifacts: [
        {
          id: 'projector-a',
          kind: 'multimodal_projector',
          requiredFor: ['image'],
          remoteFileName: 'stale-mmproj.gguf',
          downloadUrl: 'https://example.com/stale-mmproj.gguf',
          sizeBytes: 100,
          localPath: 'stale-partial-mmproj.gguf',
          installState: 'downloading',
          downloadProgress: 0.9,
          resumeData: 'stale-projector-resume',
        },
      ],
      projectorCandidates: [
        {
          id: 'projector-a',
          ownerModelId: 'author/vision-model',
          repoId: 'author/vision-model',
          fileName: 'fresh-mmproj.gguf',
          downloadUrl: 'https://example.com/fresh-mmproj.gguf',
          size: 200,
          lifecycleStatus: 'failed',
          matchStatus: 'failed',
          matchReason: 'projector download failed',
        },
      ],
    });

    expect(projectorId).not.toBe('projector-a');
    expect(normalized.projectorCandidates).toEqual([]);
    expect(normalized.artifacts?.filter((artifact) => artifact.kind === 'multimodal_projector'))
      .toEqual([]);
  });

  it('uses normalized audio chat modalities when deriving projector artifact requirements', () => {
    const projectorId = buildProjectorArtifactId({
      repoId: 'author/audio-model',
      fileName: 'mmproj-audio-model-f16.gguf',
    });
    const normalized = normalizePersistedModelMetadata({
      id: 'author/audio-model',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
      localPath: 'audio-model.Q4_K_M.gguf',
      resolvedFileName: 'audio-model.Q4_K_M.gguf',
      chatModalities: ['text', 'audio'],
      projectorCandidates: [
        {
          id: 'projector-audio',
          ownerModelId: 'author/audio-model',
          repoId: 'author/audio-model',
          fileName: 'mmproj-audio-model-f16.gguf',
          downloadUrl: 'https://example.com/mmproj-audio-model-f16.gguf',
          size: 200,
          lifecycleStatus: 'available',
          matchStatus: 'matched',
        },
      ],
    });

    const projectorArtifact = normalized.artifacts?.find((artifact) => artifact.id === projectorId);
    expect(projectorArtifact).toEqual(expect.objectContaining({
      kind: 'multimodal_projector',
      requiredFor: ['audio'],
    }));
  });

  it('migrates a persisted synthetic image requirement without dropping independent image evidence', () => {
    const modelId = 'author/audio-model-stale-image-artifact';
    const projector = buildAvailableProjectorCandidate(
      modelId,
      'projector-audio-stale-image',
      'mmproj-audio-model-f16.gguf',
    );
    const staleArtifact = buildRemoteProjectorArtifact(projector, ['image', 'audio']);
    const canonicalProjectorId = buildProjectorArtifactId(projector);
    const baseModel = {
      id: modelId,
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
      localPath: 'audio-model.Q4_K_M.gguf',
      resolvedFileName: 'audio-model.Q4_K_M.gguf',
      chatModalities: ['text', 'audio'] as Array<'text' | 'audio'>,
      projectorCandidates: [projector],
      selectedProjectorId: projector.id,
      artifacts: [staleArtifact],
      multimodalReadiness: {
        modelId,
        status: 'ready' as const,
        projectorId: projector.id,
        support: ['audio' as const],
        requestedSupport: ['vision' as const, 'audio' as const],
        checkedAt: 1,
      },
    };

    const migrated = normalizePersistedModelMetadata(baseModel);

    expect(migrated.artifacts?.find((artifact) => artifact.id === canonicalProjectorId)?.requiredFor)
      .toEqual(['audio']);
    expect(resolveEffectiveActiveVariantNativeSupport(migrated)).toEqual({
      vision: false,
      audio: true,
    });

    const withIndependentImageDeclaration = normalizePersistedModelMetadata({
      ...baseModel,
      inputCapabilities: {
        detectedAt: 1,
        declared: {
          image: 'supported',
          audio: 'supported',
          video: 'unknown',
        },
        evidence: [{ source: 'config', value: 'vision', confidence: 'high' }],
      },
    });
    expect(withIndependentImageDeclaration.artifacts?.find(
      (artifact) => artifact.id === canonicalProjectorId,
    )?.requiredFor).toEqual(['audio', 'image']);
    expect(resolveEffectiveActiveVariantNativeSupport(withIndependentImageDeclaration)).toEqual({
      vision: true,
      audio: true,
    });
  });

  it('preserves split vision and audio projector requirements during audio-only runtime readiness', () => {
    const modelId = 'author/split-projector-audio-runtime';
    const visionProjector = buildAvailableProjectorCandidate(
      modelId,
      'projector-split-vision',
      'mmproj-vision-f16.gguf',
    );
    const audioProjector = buildAvailableProjectorCandidate(
      modelId,
      'projector-split-audio',
      'mmproj-audio-f16.gguf',
    );
    const normalized = normalizePersistedModelMetadata({
      id: modelId,
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
      localPath: 'audio-model.Q4_K_M.gguf',
      resolvedFileName: 'audio-model.Q4_K_M.gguf',
      chatModalities: ['text', 'audio'],
      projectorCandidates: [visionProjector, audioProjector],
      selectedProjectorId: audioProjector.id,
      artifacts: [
        buildRemoteProjectorArtifact(visionProjector, ['image']),
        buildRemoteProjectorArtifact(audioProjector, ['audio']),
      ],
      multimodalReadiness: {
        modelId,
        status: 'ready',
        projectorId: audioProjector.id,
        support: ['audio'],
        requestedSupport: ['vision', 'audio'],
        checkedAt: 1,
      },
    });

    expect(normalized.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: buildProjectorArtifactId(visionProjector),
        requiredFor: ['image'],
      }),
      expect.objectContaining({
        id: buildProjectorArtifactId(audioProjector),
        requiredFor: ['audio'],
      }),
    ]));
    expect(resolveEffectiveActiveVariantNativeSupport(normalized)).toEqual({
      vision: false,
      audio: true,
    });
  });

  it('migrates legacy and current artifact duplicates for one stable audio projector', () => {
    const modelId = 'author/audio-projector-id-migration';
    const projectorIdentity = {
      repoId: modelId,
      hfRevision: 'main',
      ownerVariantId: 'Audio-Model.Q4_K_M.gguf',
      fileName: 'Projectors/MMProj-Audio.GGUF',
    };
    const currentProjectorId = buildProjectorArtifactId(projectorIdentity);
    const legacyProjectorId = buildLegacyProjectorArtifactId(projectorIdentity);
    const projector = {
      ...buildAvailableProjectorCandidate(
        modelId,
        currentProjectorId,
        projectorIdentity.fileName,
      ),
      hfRevision: projectorIdentity.hfRevision,
      ownerVariantId: projectorIdentity.ownerVariantId,
    };
    const currentArtifact = buildRemoteProjectorArtifact(projector, ['image', 'audio']);
    const legacyArtifact = {
      ...currentArtifact,
      id: legacyProjectorId,
      localPath: 'MMProj-Audio.GGUF',
      installState: 'installed' as const,
      downloadProgress: 1,
      integrity: {
        kind: 'size' as const,
        sizeBytes: projector.size,
        checkedAt: 10,
      },
    };
    const normalized = normalizePersistedModelMetadata({
      id: modelId,
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
      localPath: projectorIdentity.ownerVariantId,
      resolvedFileName: projectorIdentity.ownerVariantId,
      activeVariantId: projectorIdentity.ownerVariantId,
      chatModalities: ['text', 'audio'],
      variants: [{
        variantId: projectorIdentity.ownerVariantId,
        fileName: projectorIdentity.ownerVariantId,
        quantizationLabel: 'Q4_K_M',
        size: 1,
        chatModalities: ['text', 'audio'],
        projectorCandidates: [projector],
        selectedProjectorId: currentProjectorId,
      }],
      projectorCandidates: [projector],
      selectedProjectorId: currentProjectorId,
      artifacts: [legacyArtifact, currentArtifact],
      multimodalReadiness: {
        modelId,
        variantId: projectorIdentity.ownerVariantId,
        status: 'ready',
        projectorId: legacyProjectorId,
        support: ['audio'],
        requestedSupport: ['vision', 'audio'],
        checkedAt: 1,
      },
    });
    const projectorArtifacts = normalized.artifacts?.filter((artifact) => (
      artifact.kind === 'multimodal_projector'
    ));

    expect(currentProjectorId).not.toBe(legacyProjectorId);
    expect(projectorArtifacts).toEqual([
      expect.objectContaining({
        id: currentProjectorId,
        requiredFor: ['audio'],
        installState: 'installed',
        localPath: 'MMProj-Audio.GGUF',
      }),
    ]);
    expect(normalized.selectedProjectorId).toBe(currentProjectorId);
    expect(normalized.multimodalReadiness?.projectorId).toBe(currentProjectorId);
    expect(resolveEffectiveActiveVariantNativeSupport(normalized)).toEqual({
      vision: false,
      audio: true,
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
    expect(normalized.artifacts).toBeUndefined();
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

  it('keeps exact active variant ids authoritative over earlier filename aliases', () => {
    const normalized = normalizePersistedModelMetadata({
      id: 'org/variant-id-alias-collision',
      resolvedFileName: 'audio-main.gguf',
      activeVariantId: 'audio-q4.gguf',
      variants: [
        {
          variantId: 'legacy-audio',
          fileName: 'audio-q4.gguf',
          quantizationLabel: 'Q4_K_M',
          size: 1,
          chatModalities: ['text', 'vision'],
        },
        {
          variantId: 'audio-q4.gguf',
          fileName: 'audio-main.gguf',
          quantizationLabel: 'Q4_K_M',
          size: 2,
          chatModalities: ['text', 'audio'],
        },
      ],
    });

    expect(normalized.activeVariantId).toBe('audio-q4.gguf');
    expect(normalized.variants?.find((variant) => variant.variantId === normalized.activeVariantId)?.fileName)
      .toBe('audio-main.gguf');
  });

  it('keeps exact resolved filenames authoritative over earlier variant-id aliases', () => {
    const normalized = normalizePersistedModelMetadata({
      id: 'org/resolved-file-alias-collision',
      resolvedFileName: 'audio-q4.gguf',
      variants: [
        {
          variantId: 'audio-q4.gguf',
          fileName: 'audio-main.gguf',
          quantizationLabel: 'Q4_K_M',
          size: 2,
          chatModalities: ['text', 'audio'],
        },
        {
          variantId: 'legacy-audio',
          fileName: 'audio-q4.gguf',
          quantizationLabel: 'Q4_K_M',
          size: 1,
          chatModalities: ['text', 'vision'],
        },
      ],
    });

    expect(normalized.activeVariantId).toBe('legacy-audio');
    expect(normalized.variants?.find((variant) => variant.variantId === normalized.activeVariantId)?.fileName)
      .toBe('audio-q4.gguf');
  });

  it('drops stale vision provenance from an explicit audio-only variant', () => {
    const normalized = normalizePersistedModelMetadata({
      id: 'org/audio-variant-stale-vision',
      activeVariantId: 'audio',
      resolvedFileName: 'audio.gguf',
      variants: [{
        variantId: 'audio',
        fileName: 'audio.gguf',
        quantizationLabel: 'Q4_K_M',
        size: 1,
        chatModalities: ['text', 'audio'],
        visionSource: 'gguf_metadata',
        visionConfidence: 'verified',
      }],
    });

    expect(normalized.variants?.[0]?.visionSource).toBeUndefined();
    expect(normalized.variants?.[0]?.visionConfidence).toBeUndefined();
  });

  it('retains projector candidates whose physical filenames differ only by case', () => {
    const modelId = 'author/case-sensitive-projectors';
    const fileNames = ['MMProj.gguf', 'mmproj.gguf'];
    const normalized = normalizePersistedModelMetadata({
      id: modelId,
      projectorCandidates: fileNames.map((fileName) => ({
        id: buildProjectorArtifactId({ repoId: modelId, fileName }),
        ownerModelId: modelId,
        repoId: modelId,
        fileName,
        downloadUrl: `https://huggingface.co/${modelId}/resolve/main/${fileName}`,
        size: 1,
        lifecycleStatus: 'available',
        matchStatus: 'ambiguous',
      })),
    });

    expect(normalized.projectorCandidates?.map((projector) => projector.fileName)).toEqual(
      expect.arrayContaining(fileNames),
    );
    expect(normalized.projectorCandidates).toHaveLength(2);
    expect(new Set(normalized.projectorCandidates?.map((projector) => projector.id)).size).toBe(2);
  });

  it('preserves rejected explicit projector metadata as authoritative empty state', () => {
    const modelId = 'author/conflicting-projectors';
    const projectorIdentity = {
      repoId: modelId,
      hfRevision: 'main',
      fileName: 'projectors/mmproj-conflicting.gguf',
    };
    const projectorId = buildProjectorArtifactId(projectorIdentity);
    const projector = {
      ...buildAvailableProjectorCandidate(modelId, projectorId, projectorIdentity.fileName),
      sha256: VALID_SHA256,
    };
    const normalized = normalizePersistedModelMetadata({
      id: modelId,
      projectorCandidates: [
        projector,
        { ...projector, sha256: OTHER_VALID_SHA256 },
      ],
      selectedProjectorId: projectorId,
      multimodalReadiness: {
        modelId,
        status: 'ready',
        projectorId,
        support: ['vision'],
        requestedSupport: ['vision'],
        checkedAt: 10,
      },
    });

    expect(normalized.projectorCandidates).toEqual([]);
    expect(normalized.selectedProjectorId).toBeUndefined();
    expect(normalized.multimodalReadiness).toBeUndefined();
  });

  it('preserves multimodal model and variant metadata with valid projector candidates', () => {
    const projectorIdentity = {
      repoId: 'author/vision-model',
      hfRevision: 'main',
      ownerVariantId: 'vision-model.Q4_K_M.gguf',
      fileName: 'mmproj-vision-model-f16.gguf',
    };
    const canonicalProjectorId = buildProjectorArtifactId(projectorIdentity);
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
      inputCapabilities: {
        detectedAt: 123.8,
        declared: {
          image: 'supported',
          audio: 'maybe' as never,
          video: 'unsupported',
        },
        evidence: [
          { source: 'pipeline_tag', value: ' image-text-to-text ', confidence: 'high' },
          { source: 'pipeline_tag', value: 'image-text-to-text', confidence: 'high' },
          { source: 'unknown_source' as never, value: 'vision', confidence: 'high' },
        ],
      },
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
      inputCapabilities: {
        detectedAt: 124,
        declared: {
          image: 'supported',
          audio: 'unknown',
          video: 'unsupported',
        },
        evidence: [
          { source: 'pipeline_tag', value: 'image-text-to-text', confidence: 'high' },
        ],
      },
      selectedProjectorId: canonicalProjectorId,
    }));
    expect(normalized.projectorCandidates).toEqual([
      expect.objectContaining({
        id: canonicalProjectorId,
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
    expect(normalized.artifacts).toEqual([
      expect.objectContaining({
        kind: 'multimodal_projector',
        id: canonicalProjectorId,
        requiredFor: ['image'],
        remoteFileName: 'mmproj-vision-model-f16.gguf',
        localPath: 'mmproj-vision-model-f16.gguf',
        installState: 'installed',
        sizeBytes: 536_870_912,
      }),
    ]);
  });

  it('repairs legacy downloaded Gemma 4 E2B audio metadata without flattened architecture fields', () => {
    const modelId = 'unsloth/gemma-4-E2B-it-GGUF';
    const modelFileName = 'gemma-4-E2B-it-Q4_K_M.gguf';
    const projectorId = 'projector-gemma-4-e2b-mmproj-bf16';
    const projectorFileName = 'mmproj-BF16.gguf';
    const projectorUrl = `https://huggingface.co/${modelId}/resolve/main/${projectorFileName}`;
    const normalized = normalizePersistedModelMetadata({
      id: modelId,
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
      localPath: modelFileName,
      resolvedFileName: modelFileName,
      activeVariantId: modelFileName,
      chatModalities: ['text', 'vision'],
      artifactRole: 'primary_chat_model',
      inputCapabilities: {
        detectedAt: 100,
        declared: {
          image: 'supported',
          audio: 'unknown',
          video: 'unknown',
        },
        evidence: [
          { source: 'config', value: 'gemma4_vision', confidence: 'medium' },
        ],
      },
      projectorCandidates: [
        {
          id: projectorId,
          ownerModelId: modelId,
          ownerVariantId: modelFileName,
          repoId: modelId,
          fileName: projectorFileName,
          downloadUrl: projectorUrl,
          hfRevision: 'main',
          size: 1_000_000,
          lifecycleStatus: 'downloaded',
          matchStatus: 'matched',
          localPath: projectorFileName,
        },
      ],
      artifacts: [
        {
          id: projectorId,
          kind: 'multimodal_projector',
          requiredFor: ['image'],
          hfRevision: 'main',
          remoteFileName: projectorFileName,
          downloadUrl: projectorUrl,
          sizeBytes: 1_000_000,
          localPath: projectorFileName,
          installState: 'installed',
        },
      ],
      variants: [
        {
          variantId: modelFileName,
          fileName: modelFileName,
          quantizationLabel: 'Q4_K_M',
          size: 3_000_000_000,
          chatModalities: ['text', 'vision'],
          artifactRole: 'primary_chat_model',
        },
      ],
    });

    expect(normalized.chatModalities).toEqual(['text', 'vision', 'audio']);
    expect(normalized.inputCapabilities).toEqual(expect.objectContaining({
      detectedAt: 100,
      declared: expect.objectContaining({ audio: 'supported' }),
      evidence: expect.arrayContaining([
        {
          source: 'repository_tree',
          value: 'gemma4-e2b-audio-profile',
          confidence: 'high',
        },
      ]),
    }));
    expect(normalized.variants?.[0]?.chatModalities).toEqual(['text', 'vision', 'audio']);
    expect(normalized.artifacts?.find((artifact) => artifact.id === buildProjectorArtifactId({
      repoId: modelId,
      hfRevision: 'main',
      ownerVariantId: modelFileName,
      fileName: projectorFileName,
    }))?.requiredFor)
      .toEqual(['audio', 'image']);
    expect(resolveEffectiveActiveVariantNativeSupport(normalized)).toEqual({
      vision: true,
      audio: true,
    });
  });

  it('repairs legacy Voxtral metadata as audio-only without retaining projector-derived vision', () => {
    const modelId = 'community/Voxtral-Mini-3B-GGUF';
    const modelFileName = 'Voxtral-Mini-3B-Q4_K_M.gguf';
    const projectorId = 'projector-voxtral-mmproj-f16';
    const projectorFileName = 'mmproj-Voxtral-Mini-3B-f16.gguf';
    const projectorUrl = `https://huggingface.co/${modelId}/resolve/main/${projectorFileName}`;
    const normalized = normalizePersistedModelMetadata({
      id: modelId,
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
      localPath: modelFileName,
      resolvedFileName: modelFileName,
      activeVariantId: modelFileName,
      chatModalities: ['text', 'vision'],
      artifactRole: 'primary_chat_model',
      visionSource: 'tree_probe',
      visionConfidence: 'trusted',
      inputCapabilities: {
        detectedAt: 100,
        declared: {
          image: 'supported',
          audio: 'unknown',
          video: 'unknown',
        },
        evidence: [
          { source: 'tag', value: 'vision', confidence: 'medium' },
        ],
      },
      projectorCandidates: [
        {
          id: projectorId,
          ownerModelId: modelId,
          ownerVariantId: modelFileName,
          repoId: modelId,
          fileName: projectorFileName,
          downloadUrl: projectorUrl,
          hfRevision: 'main',
          size: 1_000_000,
          lifecycleStatus: 'downloaded',
          matchStatus: 'matched',
          localPath: projectorFileName,
        },
      ],
      artifacts: [
        {
          id: projectorId,
          kind: 'multimodal_projector',
          requiredFor: ['image'],
          hfRevision: 'main',
          remoteFileName: projectorFileName,
          downloadUrl: projectorUrl,
          sizeBytes: 1_000_000,
          localPath: projectorFileName,
          installState: 'installed',
        },
      ],
      variants: [
        {
          variantId: modelFileName,
          fileName: modelFileName,
          quantizationLabel: 'Q4_K_M',
          size: 3_000_000_000,
          chatModalities: ['text', 'vision'],
          artifactRole: 'primary_chat_model',
          visionSource: 'tree_probe',
          visionConfidence: 'trusted',
        },
      ],
    });

    expect(normalized.chatModalities).toEqual(['text', 'audio']);
    expect(normalized.inputCapabilities).toEqual(expect.objectContaining({
      detectedAt: 100,
      declared: {
        image: 'unknown',
        audio: 'supported',
        video: 'unknown',
      },
      evidence: expect.arrayContaining([
        {
          source: 'repository_tree',
          value: 'voxtral-audio-profile',
          confidence: 'high',
        },
      ]),
    }));
    expect(normalized.inputCapabilities?.evidence).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ value: 'vision' }),
    ]));
    expect(normalized.visionSource).toBeUndefined();
    expect(normalized.visionConfidence).toBeUndefined();
    expect(normalized.variants?.[0]).toEqual(expect.objectContaining({
      chatModalities: ['text', 'audio'],
      visionSource: undefined,
      visionConfidence: undefined,
    }));
    expect(normalized.artifacts?.find((artifact) => artifact.id === buildProjectorArtifactId({
      repoId: modelId,
      hfRevision: 'main',
      ownerVariantId: modelFileName,
      fileName: projectorFileName,
    }))?.requiredFor)
      .toEqual(['audio']);
    expect(resolveEffectiveActiveVariantNativeSupport(normalized)).toEqual({
      vision: false,
      audio: true,
    });
  });

  it('keeps explicit text-only variants authoritative during trusted profile repair', () => {
    const modelId = 'community/Phi-4-multimodal-instruct-GGUF';
    const textVariantFileName = 'Phi-4-text-Q4_K_M.gguf';
    const legacyVariantFileName = 'Phi-4-legacy-Q5_K_M.gguf';
    const projector = buildAvailableProjectorCandidate(
      modelId,
      'projector-phi-4-mmproj-f16',
      'mmproj-Phi-4-multimodal-f16.gguf',
    );
    const normalized = normalizePersistedModelMetadata({
      id: modelId,
      modelType: 'phi4mm',
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      resolvedFileName: textVariantFileName,
      activeVariantId: 'text-only',
      chatModalities: ['text'],
      projectorCandidates: [projector],
      artifacts: [buildRemoteProjectorArtifact(projector, ['image', 'audio'])],
      variants: [
        {
          variantId: 'text-only',
          fileName: textVariantFileName,
          quantizationLabel: 'Q4_K_M',
          size: 2_000_000_000,
          chatModalities: ['text'],
        },
        {
          variantId: 'legacy-unknown',
          fileName: legacyVariantFileName,
          quantizationLabel: 'Q5_K_M',
          size: 2_500_000_000,
        },
      ],
    });

    expect(normalized.chatModalities).toEqual(['text', 'vision', 'audio']);
    expect(normalized.variants?.find((variant) => variant.variantId === 'text-only')?.chatModalities)
      .toEqual(['text']);
    expect(normalized.variants?.find((variant) => variant.variantId === 'legacy-unknown')?.chatModalities)
      .toEqual(['text', 'vision', 'audio']);
    expect(resolveEffectiveActiveVariantNativeSupport(normalized)).toEqual({
      vision: false,
      audio: false,
    });
  });

  it('repairs a known audio profile when its projector exists only on the active variant', () => {
    const modelId = 'community/Voxtral-Mini-3B-GGUF';
    const variantId = 'voxtral-audio-q4';
    const modelFileName = 'Voxtral-Mini-3B-Q4_K_M.gguf';
    const projectorFileName = 'projectors/mmproj-Voxtral-Mini-3B-f16.gguf';
    const projector = {
      ...buildAvailableProjectorCandidate(
        modelId,
        buildProjectorArtifactId({
          repoId: modelId,
          hfRevision: 'main',
          ownerVariantId: variantId,
          fileName: projectorFileName,
        }),
        projectorFileName,
      ),
      ownerVariantId: variantId,
    };
    const normalized = normalizePersistedModelMetadata({
      id: modelId,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      resolvedFileName: modelFileName,
      activeVariantId: variantId,
      chatModalities: ['text'],
      variants: [{
        variantId,
        fileName: modelFileName,
        quantizationLabel: 'Q4_K_M',
        size: 2_000_000_000,
        projectorCandidates: [projector],
      }],
    });

    expect(normalized.projectorCandidates).toBeUndefined();
    expect(normalized.variants?.[0]).toEqual(expect.objectContaining({
      variantId,
      chatModalities: ['text', 'audio'],
      projectorCandidates: [expect.objectContaining({ id: projector.id })],
    }));
    expect(normalized.inputCapabilities?.evidence).toEqual(expect.arrayContaining([
      {
        source: 'repository_tree',
        value: 'voxtral-audio-profile',
        confidence: 'high',
      },
    ]));
    expect(resolveEffectiveActiveVariantNativeSupport(normalized)).toEqual({
      vision: false,
      audio: true,
    });
  });

  it('preserves separate image and audio projector requirements for trusted dual-modality profiles', () => {
    const modelId = 'community/Phi-4-multimodal-instruct-GGUF';
    const imageProjector = buildAvailableProjectorCandidate(
      modelId,
      'projector-phi-4-vision',
      'vision-projector-f16.gguf',
    );
    const audioProjector = buildAvailableProjectorCandidate(
      modelId,
      'projector-phi-4-audio',
      'audio-projector-f16.gguf',
    );
    const normalized = normalizePersistedModelMetadata({
      id: modelId,
      modelType: 'phi4mm',
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      chatModalities: ['text', 'vision', 'audio'],
      projectorCandidates: [imageProjector, audioProjector],
      artifacts: [
        buildRemoteProjectorArtifact(imageProjector, ['image']),
        buildRemoteProjectorArtifact(audioProjector, ['audio']),
      ],
    });

    expect(normalized.artifacts?.find(
      (artifact) => artifact.id === buildProjectorArtifactId(imageProjector),
    )?.requiredFor)
      .toEqual(['image']);
    expect(normalized.artifacts?.find(
      (artifact) => artifact.id === buildProjectorArtifactId(audioProjector),
    )?.requiredFor)
      .toEqual(['audio']);
  });

  it('preserves separate projector requirements during an audio-only family fallback', () => {
    const modelId = 'community/Voxtral-Mini-3B-GGUF';
    const imageProjector = buildAvailableProjectorCandidate(
      modelId,
      'projector-voxtral-vision',
      'vision-projector-f16.gguf',
    );
    const audioProjector = buildAvailableProjectorCandidate(
      modelId,
      'projector-voxtral-audio',
      'audio-projector-f16.gguf',
    );
    const normalized = normalizePersistedModelMetadata({
      id: modelId,
      modelType: 'voxtral',
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      chatModalities: ['text', 'vision'],
      projectorCandidates: [imageProjector, audioProjector],
      artifacts: [
        buildRemoteProjectorArtifact(imageProjector, ['image']),
        buildRemoteProjectorArtifact(audioProjector, ['audio']),
      ],
    });

    expect(normalized.chatModalities).toEqual(['text', 'audio']);
    expect(normalized.artifacts?.find(
      (artifact) => artifact.id === buildProjectorArtifactId(imageProjector),
    )?.requiredFor)
      .toEqual(['image']);
    expect(normalized.artifacts?.find(
      (artifact) => artifact.id === buildProjectorArtifactId(audioProjector),
    )?.requiredFor)
      .toEqual(['audio']);
    expect(resolveEffectiveActiveVariantNativeSupport(normalized)).toEqual({
      vision: false,
      audio: true,
    });
  });

  it.each([
    ['config', { source: 'config', value: 'vision_config', confidence: 'medium' }],
    ['architecture', {
      source: 'architecture',
      value: 'qwen2vlforconditionalgeneration',
      confidence: 'high',
    }],
    ['runtime', { source: 'runtime', value: 'vision', confidence: 'high' }],
  ] as const)('keeps explicit %s vision evidence stronger than an audio-only family fallback', (
    _evidenceKind,
    imageEvidence,
  ) => {
    const modelId = 'community/Voxtral-Mini-3B-GGUF';
    const projector = buildAvailableProjectorCandidate(
      modelId,
      'projector-voxtral-vision-audio',
      'mmproj-Voxtral-Mini-3B-f16.gguf',
    );
    const normalized = normalizePersistedModelMetadata({
      id: modelId,
      modelType: 'voxtral',
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      chatModalities: ['text', 'vision'],
      visionSource: 'tree_probe',
      visionConfidence: 'trusted',
      inputCapabilities: {
        detectedAt: 100,
        declared: {
          image: 'supported',
          audio: 'unknown',
          video: 'unknown',
        },
        evidence: [
          imageEvidence,
        ],
      },
      projectorCandidates: [projector],
      artifacts: [buildRemoteProjectorArtifact(projector, ['image'])],
    });

    expect(normalized.chatModalities).toEqual(['text', 'vision', 'audio']);
    expect(normalized.inputCapabilities).toEqual(expect.objectContaining({
      declared: {
        image: 'supported',
        audio: 'supported',
        video: 'unknown',
      },
      evidence: expect.arrayContaining([
        imageEvidence,
        { source: 'config', value: 'voxtral', confidence: 'high' },
      ]),
    }));
    expect(normalized.visionSource).toBe('tree_probe');
    expect(normalized.visionConfidence).toBe('trusted');
    expect(resolveEffectiveActiveVariantNativeSupport(normalized)).toEqual({
      vision: true,
      audio: true,
    });
  });

  it('keeps verified vision provenance stronger than an audio-only family fallback', () => {
    const modelId = 'community/Voxtral-Mini-3B-GGUF';
    const projector = buildAvailableProjectorCandidate(
      modelId,
      'projector-voxtral-user-verified',
      'mmproj-Voxtral-user-verified-f16.gguf',
    );
    const normalized = normalizePersistedModelMetadata({
      id: modelId,
      modelType: 'voxtral',
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      chatModalities: ['text', 'vision'],
      visionSource: 'user_selected_projector',
      visionConfidence: 'verified',
      projectorCandidates: [projector],
      artifacts: [buildRemoteProjectorArtifact(projector, ['image'])],
    });

    expect(normalized.chatModalities).toEqual(['text', 'vision', 'audio']);
    expect(normalized.visionSource).toBe('user_selected_projector');
    expect(normalized.visionConfidence).toBe('verified');
    expect(resolveEffectiveActiveVariantNativeSupport(normalized)).toEqual({
      vision: true,
      audio: true,
    });
  });

  it('does not repair a known audio family from its model id without matching projector artifacts', () => {
    const normalized = normalizePersistedModelMetadata({
      id: 'community/Voxtral-Mini-3B-GGUF',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      localPath: 'Voxtral-Mini-3B-Q4_K_M.gguf',
      resolvedFileName: 'Voxtral-Mini-3B-Q4_K_M.gguf',
      chatModalities: ['text'],
    });

    expect(normalized.chatModalities).toEqual(['text']);
    expect(normalized.inputCapabilities).toBeUndefined();
    expect(resolveEffectiveActiveVariantNativeSupport(normalized)).toEqual({
      vision: false,
      audio: false,
    });
  });

  it('keeps legacy Gemma 4 31B metadata vision-only', () => {
    const normalized = normalizePersistedModelMetadata({
      id: 'unsloth/gemma-4-31B-it-GGUF',
      modelType: 'gemma4',
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      chatModalities: ['text', 'vision'],
      projectorCandidates: [
        {
          id: 'projector-gemma-4-31b',
          ownerModelId: 'unsloth/gemma-4-31B-it-GGUF',
          repoId: 'unsloth/gemma-4-31B-it-GGUF',
          fileName: 'mmproj-BF16.gguf',
          downloadUrl: 'https://example.com/mmproj-BF16.gguf',
          size: 1_000_000,
          lifecycleStatus: 'available',
          matchStatus: 'matched',
        },
      ],
    });

    expect(normalized.chatModalities).toEqual(['text', 'vision']);
    expect(normalized.inputCapabilities).toBeUndefined();
    expect(resolveEffectiveActiveVariantNativeSupport(normalized)).toEqual({
      vision: true,
      audio: false,
    });
  });

  it('preserves audio chat modalities on models and variants', () => {
    const normalized = normalizePersistedModelMetadata({
      id: 'author/audio-model',
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      chatModalities: ['text', 'audio', 'audio'],
      variants: [
        {
          variantId: 'audio-model.Q4_K_M.gguf',
          fileName: 'audio-model.Q4_K_M.gguf',
          quantizationLabel: 'Q4_K_M',
          size: 2_000_000_000,
          chatModalities: ['text', 'vision', 'audio'],
        },
      ],
    });

    expect(normalized.chatModalities).toEqual(['text', 'audio']);
    expect(normalized.variants?.[0]?.chatModalities).toEqual(['text', 'vision', 'audio']);
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
          downloadUrl: 'https://huggingface.co/author/vision-model/resolve/main/mmproj-model.gguf',
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
          downloadUrl: 'https://huggingface.co/author/vision-model/resolve/main/mmproj-model.gguf',
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
    const modelId = 'author/vision-model';
    const projector = buildAvailableProjectorCandidate(
      modelId,
      'projector-readiness-sanitization',
      'mmproj-vision-model.gguf',
    );
    const normalized = normalizePersistedModelMetadata({
      id: modelId,
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
      projectorCandidates: [projector],
      selectedProjectorId: projector.id,
      multimodalReadiness: {
        modelId,
        status: 'failed',
        projectorId: projector.id,
        support: ['vision'],
        failureReason: 'Native init failed for C:\\Users\\tester\\Project for Client\\mmproj file.gguf after retry',
        checkedAt: 10,
      },
    });

    expect(normalized.multimodalReadiness?.failureReason).toBe('Native init failed for [path] after retry');
    expect(JSON.stringify(normalized.multimodalReadiness)).not.toContain('Project for Client');
    expect(JSON.stringify(normalized.multimodalReadiness)).not.toContain('C:\\Users\\tester');

    const extensionless = normalizePersistedModelMetadata({
      id: modelId,
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
      projectorCandidates: [projector],
      selectedProjectorId: projector.id,
      multimodalReadiness: {
        modelId,
        status: 'failed',
        projectorId: projector.id,
        support: ['vision'],
        failureReason: 'Native init failed for C:\\Users\\tester\\Project for Client',
        checkedAt: 11,
      },
    });

    expect(extensionless.multimodalReadiness?.failureReason).toBe('Native init failed for [path]');
    expect(JSON.stringify(extensionless.multimodalReadiness)).not.toContain('Project for Client');
    expect(JSON.stringify(extensionless.multimodalReadiness)).not.toContain('C:\\Users\\tester');
  });

  it('normalizes requested multimodal support on persisted readiness snapshots', () => {
    const modelId = 'author/vision-model';
    const projector = buildAvailableProjectorCandidate(
      modelId,
      'projector-readiness-support',
      'mmproj-vision-model.gguf',
    );
    const normalized = normalizePersistedModelMetadata({
      id: modelId,
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
      projectorCandidates: [projector],
      selectedProjectorId: projector.id,
      multimodalReadiness: {
        modelId,
        status: 'ready',
        projectorId: projector.id,
        support: ['vision', 'bogus' as never, 'vision'],
        requestedSupport: ['vision', 'audio', 'bogus' as never, 'audio'],
        checkedAt: 10,
      },
    });

    expect(normalized.multimodalReadiness?.support).toEqual(['vision']);
    expect(normalized.multimodalReadiness?.requestedSupport).toEqual(['vision', 'audio']);
  });
});
