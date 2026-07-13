import { LifecycleStatus, ModelAccessState } from '../../src/types/models';
import { normalizePersistedModelMetadata } from '../../src/services/ModelMetadataNormalizer';
import {
  UNKNOWN_MODEL_GPU_LAYERS_CEILING,
} from '../../src/services/SettingsStore';
import {
  buildModelCapabilitySnapshot,
  getModelAudioCapabilityBadgePresentation,
  getEffectiveActiveVariantProjectorCandidates,
  getEffectiveActiveVariantSelectedProjectorId,
  getModelVisionCapabilityBadgePresentation,
  getModelVisionCapabilityStatusLabelKey,
  modelSupportsAudio,
  modelSupportsVision,
  projectorArtifactMatchesCandidate,
  resolveModelChatModalities,
  resolveModelCapabilitySnapshot,
  resolveEffectiveActiveVariantNativeSupport,
  resolveModelNativeMultimodalSupport,
} from '../../src/utils/modelCapabilities';
import {
  buildLegacyProjectorArtifactId,
  buildProjectorArtifactId,
} from '../../src/utils/modelProjectors';

const VALID_SHA256 = 'a'.repeat(64);

describe('modelCapabilities', () => {
  it('builds a stable snapshot from model metadata when none is persisted', () => {
    const result = resolveModelCapabilitySnapshot({
      size: 2_000_000_000,
      metadataTrust: 'verified_local',
      gguf: {
        totalBytes: 2_000_000_000,
        architecture: 'llama',
        nLayers: 32,
      },
      maxContextTokens: 8192,
      hasVerifiedContextWindow: true,
      sha256: VALID_SHA256,
      lastModifiedAt: 1700000000000,
      capabilitySnapshot: undefined,
    });

    expect(result.isCurrentPersisted).toBe(false);
    expect(result.snapshot).toEqual(expect.objectContaining({
      heuristicVersion: 1,
      modelLayerCount: 32,
      gpuLayersCeiling: 32,
      metadataTrust: 'verified_local',
      sizeBytes: 2_000_000_000,
      verifiedFileSizeBytes: 2_000_000_000,
      verifiedMaxContextTokens: 8192,
      sha256: VALID_SHA256,
      lastModifiedAt: 1700000000000,
    }));
  });

  it('reuses the persisted snapshot when the model inputs are unchanged', () => {
    const capabilitySnapshot = buildModelCapabilitySnapshot({
      size: 3_000_000_000,
      metadataTrust: 'verified_local',
      gguf: {
        totalBytes: 3_000_000_000,
        architecture: 'llama',
        nLayers: 40,
      },
      maxContextTokens: 4096,
      hasVerifiedContextWindow: true,
      sha256: VALID_SHA256,
      lastModifiedAt: 1700000000001,
    });

    const result = resolveModelCapabilitySnapshot({
      size: 3_000_000_000,
      metadataTrust: 'verified_local',
      gguf: {
        totalBytes: 3_000_000_000,
        architecture: 'llama',
        nLayers: 40,
      },
      maxContextTokens: 4096,
      hasVerifiedContextWindow: true,
      sha256: VALID_SHA256,
      lastModifiedAt: 1700000000001,
      capabilitySnapshot,
    });

    expect(result.isCurrentPersisted).toBe(true);
    expect(result.snapshot).toEqual(capabilitySnapshot);
  });

  it('drops a stale persisted snapshot when GGUF capability metadata changes', () => {
    const staleSnapshot = buildModelCapabilitySnapshot({
      size: 1_500_000_000,
      metadataTrust: 'verified_local',
      gguf: {
        totalBytes: 1_500_000_000,
        architecture: 'llama',
        nLayers: 16,
      },
      maxContextTokens: 4096,
      hasVerifiedContextWindow: true,
      sha256: VALID_SHA256,
      lastModifiedAt: 1700000000002,
    });

    const normalized = normalizePersistedModelMetadata({
      id: 'author/model-q4',
      name: 'Model Q4',
      author: 'Author',
      size: 1_500_000_000,
      downloadUrl: 'https://example.com/model.gguf',
      fitsInRam: null,
      metadataTrust: 'verified_local',
      gguf: {
        totalBytes: 1_500_000_000,
        architecture: 'llama',
        nLayers: 24,
      },
      accessState: ModelAccessState.PUBLIC,
      isGated: false,
      isPrivate: false,
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
      maxContextTokens: 4096,
      hasVerifiedContextWindow: true,
      sha256: VALID_SHA256,
      lastModifiedAt: 1700000000002,
      capabilitySnapshot: staleSnapshot,
    });

    expect(normalized.capabilitySnapshot).toBeUndefined();
  });

  it('falls back to the generous unknown-model ceiling when layer metadata is missing', () => {
    const result = resolveModelCapabilitySnapshot({
      size: 900_000_000,
      metadataTrust: 'unknown',
      gguf: {
        architecture: 'llama',
      },
      maxContextTokens: undefined,
      hasVerifiedContextWindow: false,
      sha256: undefined,
      lastModifiedAt: undefined,
      capabilitySnapshot: undefined,
    });

    expect(result.snapshot.modelLayerCount).toBeNull();
    expect(result.snapshot.gpuLayersCeiling).toBe(UNKNOWN_MODEL_GPU_LAYERS_CEILING);
  });

  it('presents vision capability only for primary chat models', () => {
    const visionModel = {
      artifactRole: 'primary_chat_model' as const,
      chatModalities: ['text', 'vision'] as Array<'text' | 'vision'>,
      projectorCandidates: [{
        id: 'projector-1',
        ownerModelId: 'author/model',
        repoId: 'author/model',
        fileName: 'mmproj-model-f16.gguf',
        downloadUrl: 'https://huggingface.co/author/model/resolve/main/mmproj-model-f16.gguf',
        size: 1,
        lifecycleStatus: 'available' as const,
        matchStatus: 'matched' as const,
      }],
    };

    expect(modelSupportsVision(visionModel)).toBe(true);
    expect(getModelVisionCapabilityStatusLabelKey(visionModel)).toBe('models.vision.capabilityNeedsProjector');
    expect(getModelVisionCapabilityBadgePresentation(visionModel)).toEqual({
      labelKey: 'models.vision.badge',
      tone: 'warning',
      iconName: 'visibility',
    });
    expect(modelSupportsVision({
      ...visionModel,
      artifactRole: 'projector_companion',
    })).toBe(false);
  });

  it('presents audio capability only for primary chat models', () => {
    const audioProjector = {
      id: 'projector-audio',
      ownerModelId: 'author/model',
      repoId: 'author/model',
      fileName: 'mmproj-audio-model-f16.gguf',
      downloadUrl: 'https://huggingface.co/author/model/resolve/main/mmproj-audio-model-f16.gguf',
      size: 1,
      lifecycleStatus: 'available' as const,
      matchStatus: 'matched' as const,
    };
    const audioModel = {
      artifactRole: 'primary_chat_model' as const,
      chatModalities: ['text', 'audio'] as Array<'text' | 'audio'>,
      projectorCandidates: [audioProjector],
    };

    expect(modelSupportsAudio(audioModel)).toBe(true);
    expect(getModelAudioCapabilityBadgePresentation(audioModel)).toEqual({
      labelKey: 'models.audio.badge',
      tone: 'info',
      iconName: 'graphic-eq',
    });
    expect(modelSupportsAudio({
      ...audioModel,
      artifactRole: 'projector_companion',
    })).toBe(false);
    expect(getModelAudioCapabilityBadgePresentation({
      artifactRole: 'primary_chat_model',
      chatModalities: ['text'],
      inputCapabilities: {
        detectedAt: 1,
        declared: {
          image: 'unknown',
          audio: 'supported',
          video: 'unknown',
        },
        evidence: [{ source: 'tag', value: 'audio', confidence: 'medium' }],
      },
    })).toBeNull();
  });

  it('treats requested audio readiness as audio support when catalog modalities are stale', () => {
    expect(resolveModelNativeMultimodalSupport({
      artifactRole: 'primary_chat_model',
      multimodalReadiness: {
        modelId: 'author/model',
        status: 'unsupported',
        projectorId: 'projector-audio',
        support: [],
        requestedSupport: ['audio'],
        checkedAt: 1,
      },
    }).audio).toBe(true);
    expect(resolveModelChatModalities({
      artifactRole: 'primary_chat_model',
      multimodalReadiness: {
        modelId: 'author/model',
        status: 'unsupported',
        projectorId: 'projector-audio',
        support: [],
        requestedSupport: ['audio'],
        checkedAt: 1,
      },
    })).toEqual(['text', 'audio']);
    expect(modelSupportsAudio({
      artifactRole: 'primary_chat_model',
      chatModalities: ['text'],
      multimodalReadiness: {
        modelId: 'author/model',
        status: 'unsupported',
        projectorId: 'projector-audio',
        support: [],
        requestedSupport: ['audio'],
        checkedAt: 1,
      },
    })).toBe(false);
    expect(modelSupportsAudio({
      artifactRole: 'primary_chat_model',
      chatModalities: ['text', 'vision'],
      multimodalReadiness: {
        modelId: 'author/model',
        status: 'unsupported',
        projectorId: 'projector-audio',
        support: [],
        requestedSupport: ['audio'],
        checkedAt: 1,
      },
    })).toBe(false);
    expect(resolveModelChatModalities({
      artifactRole: 'primary_chat_model',
      chatModalities: ['text', 'vision'],
      multimodalReadiness: {
        modelId: 'author/model',
        status: 'ready',
        projectorId: 'projector-audio',
        support: ['audio'],
        requestedSupport: ['audio'],
        checkedAt: 1,
      },
    })).toEqual(['text', 'vision']);
  });

  it('treats persisted projector evidence as vision support when modalities are stale', () => {
    const projector = {
      id: 'projector-1',
      ownerModelId: 'author/model',
      repoId: 'author/model',
      fileName: 'mmproj-model-f16.gguf',
      downloadUrl: 'https://huggingface.co/author/model/resolve/main/mmproj-model-f16.gguf',
      size: 1,
      lifecycleStatus: 'available' as const,
      matchStatus: 'matched' as const,
    };

    expect(modelSupportsVision({
      artifactRole: 'primary_chat_model',
      projectorCandidates: [projector],
    })).toBe(true);
    expect(resolveModelNativeMultimodalSupport({
      artifactRole: 'primary_chat_model',
      selectedProjectorId: projector.id,
    }).vision).toBe(true);
    const legacyReadinessOnlyModel = {
      artifactRole: 'primary_chat_model' as const,
      multimodalReadiness: {
        modelId: 'author/model',
        status: 'missing_projector' as const,
        support: [],
        checkedAt: 1,
      },
    };
    expect(resolveModelNativeMultimodalSupport(legacyReadinessOnlyModel).vision).toBe(true);
    expect(modelSupportsVision(legacyReadinessOnlyModel)).toBe(false);
    expect(modelSupportsVision({
      artifactRole: 'primary_chat_model',
      chatModalities: ['text'],
      projectorCandidates: [projector],
    })).toBe(false);
    expect(modelSupportsVision({
      artifactRole: 'primary_chat_model',
      chatModalities: ['text'],
      selectedProjectorId: projector.id,
    })).toBe(false);
    expect(modelSupportsVision({
      artifactRole: 'primary_chat_model',
      chatModalities: ['text'],
      multimodalReadiness: {
        modelId: 'author/model',
        status: 'ready',
        projectorId: projector.id,
        support: ['vision'],
        checkedAt: 1,
      },
    })).toBe(false);
    expect(modelSupportsVision({
      artifactRole: 'primary_chat_model',
      chatModalities: ['text', 'audio'] as Array<'text' | 'audio'>,
      selectedProjectorId: projector.id,
      multimodalReadiness: {
        modelId: 'author/model',
        status: 'ready',
        projectorId: projector.id,
        support: ['audio'],
        requestedSupport: ['audio'],
        checkedAt: 1,
      },
    })).toBe(false);
    expect(getModelVisionCapabilityStatusLabelKey({
      artifactRole: 'primary_chat_model',
      projectorCandidates: [projector],
    })).toBe('models.vision.capabilityNeedsProjector');
    expect(modelSupportsVision({
      artifactRole: 'projector_companion',
      projectorCandidates: [projector],
    })).toBe(false);
  });

  it('keeps normalized sparse audio-only readiness from inheriting legacy vision support', () => {
    const modelId = 'author/sparse-audio-only';
    const modelFileName = 'sparse-audio-only.Q4_K_M.gguf';
    const projectorFileName = 'mmproj-sparse-audio-only-f16.gguf';
    const projector = {
      id: buildProjectorArtifactId({
        repoId: modelId,
        hfRevision: 'main',
        ownerVariantId: modelFileName,
        fileName: projectorFileName,
      }),
      ownerModelId: modelId,
      ownerVariantId: modelFileName,
      repoId: modelId,
      hfRevision: 'main',
      fileName: projectorFileName,
      downloadUrl: `https://huggingface.co/${modelId}/resolve/main/${projectorFileName}`,
      size: 100,
      localPath: `models/${projectorFileName}`,
      downloadProgress: 1,
      lifecycleStatus: 'downloaded' as const,
      matchStatus: 'matched' as const,
    };
    const normalized = normalizePersistedModelMetadata({
      id: modelId,
      name: 'Sparse audio-only model',
      author: 'Author',
      size: 1_000,
      downloadUrl: `https://huggingface.co/${modelId}/resolve/main/${modelFileName}`,
      hfRevision: 'main',
      resolvedFileName: modelFileName,
      localPath: `models/${modelFileName}`,
      fitsInRam: true,
      accessState: ModelAccessState.PUBLIC,
      isGated: false,
      isPrivate: false,
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
      activeVariantId: modelFileName,
      variants: [{
        variantId: modelFileName,
        fileName: modelFileName,
        quantizationLabel: 'Q4_K_M',
        size: 1_000,
      }],
      artifactRole: 'primary_chat_model',
      projectorCandidates: [projector],
      selectedProjectorId: projector.id,
      multimodalReadiness: {
        modelId,
        variantId: modelFileName,
        status: 'ready',
        projectorId: projector.id,
        support: ['audio'],
        requestedSupport: ['audio'],
        checkedAt: 1,
      },
    });

    expect(normalized.chatModalities).toBeUndefined();
    expect(normalized.variants?.[0]?.chatModalities).toBeUndefined();
    expect(resolveEffectiveActiveVariantNativeSupport(normalized)).toEqual({
      vision: false,
      audio: true,
    });
    expect(modelSupportsVision(normalized)).toBe(false);
    expect(getModelVisionCapabilityBadgePresentation(normalized)).toBeNull();
  });

  it('preserves independent image evidence alongside audio-only readiness', () => {
    const projector = {
      id: 'audio-projector-with-image-evidence',
      ownerModelId: 'author/model',
      repoId: 'author/model',
      fileName: 'mmproj-audio.gguf',
      downloadUrl: 'https://example.com/mmproj-audio.gguf',
      size: 1,
      lifecycleStatus: 'downloaded' as const,
      matchStatus: 'matched' as const,
    };
    const base = {
      id: 'author/model',
      artifactRole: 'primary_chat_model' as const,
      projectorCandidates: [projector],
      selectedProjectorId: projector.id,
      multimodalReadiness: {
        modelId: 'author/model',
        status: 'ready' as const,
        projectorId: projector.id,
        support: ['audio' as const],
        requestedSupport: ['audio' as const],
        checkedAt: 1,
      },
    };

    expect(resolveEffectiveActiveVariantNativeSupport({
      ...base,
      chatModalities: ['text', 'vision'],
    }).vision).toBe(true);
    expect(resolveEffectiveActiveVariantNativeSupport({
      ...base,
      inputCapabilities: {
        detectedAt: 1,
        declared: {
          image: 'supported',
          audio: 'supported',
          video: 'unknown',
        },
        evidence: [{ source: 'tag', value: 'vision', confidence: 'medium' }],
      },
    }).vision).toBe(true);
    expect(resolveEffectiveActiveVariantNativeSupport({
      ...base,
      artifacts: [{
        id: projector.id,
        kind: 'multimodal_projector',
        requiredFor: ['image', 'audio'],
        remoteFileName: projector.fileName,
        downloadUrl: projector.downloadUrl,
        sizeBytes: projector.size,
        installState: 'installed',
      }],
    }).vision).toBe(true);
  });

  it('unions explicit native modalities with newly discovered native evidence', () => {
    const projector = {
      id: 'projector-1',
      ownerModelId: 'author/model',
      repoId: 'author/model',
      fileName: 'mmproj-model-f16.gguf',
      downloadUrl: 'https://huggingface.co/author/model/resolve/main/mmproj-model-f16.gguf',
      size: 1,
      lifecycleStatus: 'available' as const,
      matchStatus: 'matched' as const,
    };
    const audioCapabilities = {
      detectedAt: 1,
      declared: {
        image: 'unknown' as const,
        audio: 'supported' as const,
        video: 'unknown' as const,
      },
      evidence: [{ source: 'tag' as const, value: 'audio', confidence: 'medium' as const }],
    };
    const imageCapabilities = {
      detectedAt: 1,
      declared: {
        image: 'supported' as const,
        audio: 'unknown' as const,
        video: 'unknown' as const,
      },
      evidence: [{ source: 'tag' as const, value: 'vision', confidence: 'medium' as const }],
    };

    expect(resolveModelChatModalities({
      artifactRole: 'primary_chat_model',
      chatModalities: ['text', 'vision'] as Array<'text' | 'vision'>,
      inputCapabilities: audioCapabilities,
    })).toEqual(['text', 'vision']);
    expect(resolveModelChatModalities({
      artifactRole: 'primary_chat_model',
      chatModalities: ['text', 'vision'] as Array<'text' | 'vision'>,
      inputCapabilities: audioCapabilities,
      projectorCandidates: [projector],
    })).toEqual(['text', 'vision', 'audio']);
    expect(resolveModelChatModalities({
      artifactRole: 'primary_chat_model',
      chatModalities: ['text', 'audio'] as Array<'text' | 'audio'>,
      projectorCandidates: [projector],
    })).toEqual(['text', 'audio']);
    expect(resolveModelChatModalities({
      artifactRole: 'primary_chat_model',
      chatModalities: ['text', 'audio'] as Array<'text' | 'audio'>,
      inputCapabilities: imageCapabilities,
    })).toEqual(['text', 'vision', 'audio']);
    expect(resolveModelChatModalities({
      artifactRole: 'primary_chat_model',
      inputCapabilities: audioCapabilities,
      projectorCandidates: [projector],
    })).toEqual(['text', 'audio']);
    expect(resolveModelChatModalities({
      artifactRole: 'primary_chat_model',
      chatModalities: ['text'] as Array<'text'>,
      inputCapabilities: audioCapabilities,
      projectorCandidates: [projector],
    })).toEqual(['text']);
  });

  it('does not present inactive variant-scoped projector downloads as ready', () => {
    const inactiveProjector = {
      id: 'projector-q4',
      ownerModelId: 'author/model',
      ownerVariantId: 'model.Q4_K_M.gguf',
      repoId: 'author/model',
      fileName: 'mmproj-model-f16.gguf',
      downloadUrl: 'https://huggingface.co/author/model/resolve/main/mmproj-model-f16.gguf',
      size: 1,
      lifecycleStatus: 'downloaded' as const,
      matchStatus: 'matched' as const,
    };
    const model = {
      id: 'author/model',
      artifactRole: 'primary_chat_model' as const,
      chatModalities: ['text', 'vision'] as Array<'text' | 'vision'>,
      activeVariantId: 'model.Q8_0.gguf',
      resolvedFileName: 'model.Q8_0.gguf',
      variants: [
        { variantId: 'model.Q4_K_M.gguf', fileName: 'model.Q4_K_M.gguf', quantizationLabel: 'Q4_K_M', size: 1 },
        { variantId: 'model.Q8_0.gguf', fileName: 'model.Q8_0.gguf', quantizationLabel: 'Q8_0', size: 2 },
      ],
      projectorCandidates: [inactiveProjector],
      selectedProjectorId: inactiveProjector.id,
      multimodalReadiness: {
        modelId: 'author/model',
        variantId: 'model.Q4_K_M.gguf',
        status: 'ready' as const,
        projectorId: inactiveProjector.id,
        support: ['vision' as const],
        checkedAt: 1,
      },
    };

    expect(modelSupportsVision(model)).toBe(true);
    expect(getModelVisionCapabilityStatusLabelKey(model)).toBe('models.vision.projectorMissing');
    expect(getModelVisionCapabilityBadgePresentation(model)).toEqual({
      labelKey: 'models.vision.badge',
      tone: 'warning',
      iconName: 'visibility',
    });
  });

  it('keeps model-wide downloaded projectors ready across variant selections', () => {
    const modelWideProjector = {
      id: 'projector-wide',
      ownerModelId: 'author/model',
      repoId: 'author/model',
      fileName: 'mmproj-model-f16.gguf',
      downloadUrl: 'https://huggingface.co/author/model/resolve/main/mmproj-model-f16.gguf',
      size: 1,
      lifecycleStatus: 'downloaded' as const,
      matchStatus: 'matched' as const,
    };

    expect(getModelVisionCapabilityStatusLabelKey({
      id: 'author/model',
      artifactRole: 'primary_chat_model',
      chatModalities: ['text', 'vision'],
      activeVariantId: 'model.Q8_0.gguf',
      resolvedFileName: 'model.Q8_0.gguf',
      projectorCandidates: [modelWideProjector],
    })).toBe('models.vision.capabilityReady');
  });

  it('keeps scoped projector downloads ready when active variant scope is unavailable', () => {
    expect(getModelVisionCapabilityStatusLabelKey({
      id: 'author/model',
      artifactRole: 'primary_chat_model',
      chatModalities: ['text', 'vision'],
      projectorCandidates: [{
        id: 'projector-q4',
        ownerModelId: 'author/model',
        ownerVariantId: 'model.Q4_K_M.gguf',
        repoId: 'author/model',
        fileName: 'mmproj-model-f16.gguf',
        downloadUrl: 'https://huggingface.co/author/model/resolve/main/mmproj-model-f16.gguf',
        size: 1,
        lifecycleStatus: 'downloaded',
        matchStatus: 'matched',
      }],
    })).toBe('models.vision.capabilityReady');
  });

  it('keeps catalog inference separate while active text-only modalities are authoritative', () => {
    const model = {
      id: 'author/model',
      chatModalities: ['text', 'vision', 'audio'] as Array<'text' | 'vision' | 'audio'>,
      activeVariantId: 'text',
      resolvedFileName: 'text.gguf',
      variants: [{
        variantId: 'text',
        fileName: 'text.gguf',
        quantizationLabel: 'Q4_K_M',
        size: 1,
        chatModalities: ['text'] as Array<'text'>,
      }],
    };

    expect(resolveModelNativeMultimodalSupport(model)).toEqual({ vision: true, audio: true });
    expect(resolveEffectiveActiveVariantNativeSupport(model)).toEqual({ vision: false, audio: false });
  });

  it('uses explicit active audio modalities without inheriting parent vision evidence', () => {
    const audioProjector = {
      id: 'audio-projector',
      ownerModelId: 'author/model',
      repoId: 'author/model',
      fileName: 'mmproj-audio.gguf',
      downloadUrl: 'https://example.com/mmproj-audio.gguf',
      size: 1,
      lifecycleStatus: 'available' as const,
      matchStatus: 'matched' as const,
    };
    const model = {
      id: 'author/model',
      chatModalities: ['text', 'vision'] as Array<'text' | 'vision'>,
      inputCapabilities: {
        detectedAt: 1,
        declared: { image: 'supported' as const, audio: 'unknown' as const, video: 'unknown' as const },
        evidence: [{ source: 'tag' as const, value: 'vision', confidence: 'high' as const }],
      },
      activeVariantId: 'audio',
      resolvedFileName: 'audio.gguf',
      variants: [{
        variantId: 'audio',
        fileName: 'audio.gguf',
        quantizationLabel: 'Q4_K_M',
        size: 1,
        chatModalities: ['text', 'audio'] as Array<'text' | 'audio'>,
      }],
      projectorCandidates: [audioProjector],
      artifacts: [{
        id: audioProjector.id,
        kind: 'multimodal_projector' as const,
        requiredFor: ['audio'] as Array<'audio'>,
        remoteFileName: audioProjector.fileName,
        downloadUrl: audioProjector.downloadUrl,
        sizeBytes: 1,
        installState: 'remote' as const,
      }],
    };

    expect(resolveEffectiveActiveVariantNativeSupport(model)).toEqual({ vision: false, audio: true });
  });

  it('uses explicit active vision modalities without inheriting parent audio support', () => {
    const model = {
      id: 'author/model',
      chatModalities: ['text', 'audio'] as Array<'text' | 'audio'>,
      activeVariantId: 'vision',
      resolvedFileName: 'vision.gguf',
      variants: [{
        variantId: 'vision',
        fileName: 'vision.gguf',
        quantizationLabel: 'Q4_K_M',
        size: 1,
        chatModalities: ['text', 'vision'] as Array<'text' | 'vision'>,
      }],
    };

    expect(resolveEffectiveActiveVariantNativeSupport(model)).toEqual({ vision: true, audio: false });
    expect(getModelVisionCapabilityStatusLabelKey(model)).toBe('models.vision.projectorMissing');
  });

  it('does not inherit sibling audio artifact evidence when active variant modalities are sparse', () => {
    const visionProjector = {
      id: 'vision-projector',
      ownerModelId: 'author/model',
      ownerVariantId: 'vision',
      repoId: 'author/model',
      fileName: 'mmproj-vision.gguf',
      downloadUrl: 'https://example.com/mmproj-vision.gguf',
      size: 1,
      lifecycleStatus: 'available' as const,
      matchStatus: 'matched' as const,
    };
    const audioProjector = {
      id: 'audio-projector',
      ownerModelId: 'author/model',
      ownerVariantId: 'audio',
      repoId: 'author/model',
      fileName: 'mmproj-audio.gguf',
      downloadUrl: 'https://example.com/mmproj-audio.gguf',
      size: 1,
      lifecycleStatus: 'available' as const,
      matchStatus: 'matched' as const,
    };
    const model = {
      id: 'author/model',
      chatModalities: ['text', 'vision', 'audio'] as Array<'text' | 'vision' | 'audio'>,
      activeVariantId: 'vision',
      resolvedFileName: 'vision.gguf',
      variants: [
        {
          variantId: 'vision',
          fileName: 'vision.gguf',
          quantizationLabel: 'Q4_K_M',
          size: 1,
          projectorCandidates: [visionProjector],
        },
        {
          variantId: 'audio',
          fileName: 'audio.gguf',
          quantizationLabel: 'Q4_K_M',
          size: 1,
          projectorCandidates: [audioProjector],
        },
      ],
      projectorCandidates: [visionProjector, audioProjector],
      artifacts: [{
        id: audioProjector.id,
        kind: 'multimodal_projector' as const,
        requiredFor: ['audio'] as Array<'audio'>,
        remoteFileName: audioProjector.fileName,
        downloadUrl: audioProjector.downloadUrl,
        sizeBytes: audioProjector.size,
        installState: 'remote' as const,
      }],
    };

    expect(resolveModelNativeMultimodalSupport(model)).toEqual({ vision: true, audio: true });
    expect(getEffectiveActiveVariantProjectorCandidates(model)).toEqual([visionProjector]);
    expect(resolveEffectiveActiveVariantNativeSupport(model)).toEqual({ vision: true, audio: false });
    expect(modelSupportsAudio(model)).toBe(false);
    expect(resolveEffectiveActiveVariantNativeSupport({
      ...model,
      activeVariantId: 'audio',
      resolvedFileName: 'audio.gguf',
    })).toEqual({ vision: false, audio: true });
  });

  it('falls back to model inference when the active variant has no explicit modalities', () => {
    expect(resolveEffectiveActiveVariantNativeSupport({
      id: 'author/model',
      chatModalities: ['text', 'vision'],
      activeVariantId: 'fallback',
      resolvedFileName: 'fallback.gguf',
      variants: [{
        variantId: 'fallback',
        fileName: 'fallback.gguf',
        quantizationLabel: 'Q4_K_M',
        size: 1,
      }],
    })).toEqual({ vision: true, audio: false });
  });

  it.each([
    {
      label: 'readiness owned by another model',
      readiness: {
        modelId: 'other/model',
        status: 'ready' as const,
        projectorId: 'projector',
        support: ['audio' as const],
        requestedSupport: ['audio' as const],
        checkedAt: 1,
      },
    },
    {
      label: 'support outside the checked request',
      readiness: {
        modelId: 'author/model',
        status: 'ready' as const,
        projectorId: 'projector',
        support: ['audio' as const],
        requestedSupport: ['vision' as const],
        checkedAt: 1,
      },
    },
    {
      label: 'ready state with empty support',
      readiness: {
        modelId: 'author/model',
        status: 'ready' as const,
        projectorId: 'projector',
        support: [],
        requestedSupport: ['audio' as const],
        checkedAt: 1,
      },
    },
  ])('does not widen effective support from $label', ({ readiness }) => {
    const projector = {
      id: 'projector',
      ownerModelId: 'author/model',
      repoId: 'author/model',
      fileName: 'mmproj.gguf',
      downloadUrl: 'https://example.com/mmproj.gguf',
      size: 1,
      lifecycleStatus: 'downloaded' as const,
      matchStatus: 'matched' as const,
    };
    const model = {
      id: 'author/model',
      projectorCandidates: [projector],
      selectedProjectorId: projector.id,
      multimodalReadiness: readiness,
    };

    expect(resolveEffectiveActiveVariantNativeSupport(model)).toEqual({
      vision: true,
      audio: false,
    });
    expect(modelSupportsAudio(model)).toBe(false);
  });

  it('requires an audio-compatible projector path for an explicit active audio variant', () => {
    const visionProjector = {
      id: 'projector',
      ownerModelId: 'author/model',
      repoId: 'author/model',
      fileName: 'mmproj-shared.gguf',
      downloadUrl: 'https://example.com/mmproj-shared.gguf',
      size: 1,
      lifecycleStatus: 'available' as const,
      matchStatus: 'matched' as const,
    };
    const base = {
      id: 'author/model',
      activeVariantId: 'audio',
      resolvedFileName: 'audio.gguf',
      variants: [{
        variantId: 'audio',
        fileName: 'audio.gguf',
        quantizationLabel: 'Q4_K_M',
        size: 1,
        chatModalities: ['text', 'audio'] as Array<'text' | 'audio'>,
      }],
    };

    expect(resolveEffectiveActiveVariantNativeSupport(base)).toEqual({ vision: false, audio: false });
    expect(resolveEffectiveActiveVariantNativeSupport({
      ...base,
      projectorCandidates: [visionProjector],
      artifacts: [{
        id: visionProjector.id,
        kind: 'multimodal_projector',
        requiredFor: ['image'],
        remoteFileName: visionProjector.fileName,
        downloadUrl: visionProjector.downloadUrl,
        sizeBytes: 1,
        installState: 'remote',
      }],
    })).toEqual({ vision: false, audio: false });
  });

  it('uses only the resolved active variant aliases for projector compatibility', () => {
    const staleProjector = {
      id: 'stale-projector',
      ownerModelId: 'author/model',
      ownerVariantId: 'stale-active-id',
      repoId: 'author/model',
      fileName: 'mmproj-stale.gguf',
      downloadUrl: 'https://example.com/mmproj-stale.gguf',
      size: 1,
      lifecycleStatus: 'available' as const,
      matchStatus: 'matched' as const,
    };

    expect(getEffectiveActiveVariantProjectorCandidates({
      id: 'author/model',
      activeVariantId: 'stale-active-id',
      resolvedFileName: 'vision.gguf',
      variants: [{
        variantId: 'vision',
        fileName: 'vision.gguf',
        quantizationLabel: 'Q4_K_M',
        size: 1,
        chatModalities: ['text', 'vision'],
      }],
      projectorCandidates: [staleProjector],
    })).toEqual([]);
  });

  it('treats an explicit empty active-variant projector list as authoritative', () => {
    const staleParentProjector = {
      id: 'stale-parent-projector',
      ownerModelId: 'author/model',
      ownerVariantId: 'vision',
      repoId: 'author/model',
      fileName: 'mmproj-stale.gguf',
      downloadUrl: 'https://example.com/mmproj-stale.gguf',
      size: 1,
      lifecycleStatus: 'downloaded' as const,
      matchStatus: 'matched' as const,
    };

    expect(getEffectiveActiveVariantProjectorCandidates({
      id: 'author/model',
      activeVariantId: 'vision',
      resolvedFileName: 'vision.gguf',
      variants: [{
        variantId: 'vision',
        fileName: 'vision.gguf',
        quantizationLabel: 'Q4_K_M',
        size: 1,
        chatModalities: ['text', 'vision'],
        projectorCandidates: [],
      }],
      projectorCandidates: [staleParentProjector],
      selectedProjectorId: staleParentProjector.id,
    })).toEqual([]);
  });

  it('does not let an invalid duplicate suppress a later compatible candidate', () => {
    const candidate = {
      id: 'shared-projector',
      repoId: 'author/model',
      fileName: 'mmproj-audio.gguf',
      downloadUrl: 'https://example.com/mmproj-audio.gguf',
      size: 1,
      lifecycleStatus: 'available' as const,
      matchStatus: 'matched' as const,
    };
    const validCandidate = { ...candidate, ownerModelId: 'author/model', ownerVariantId: 'audio' };

    expect(getEffectiveActiveVariantProjectorCandidates({
      id: 'author/model',
      activeVariantId: 'audio',
      resolvedFileName: 'audio.gguf',
      variants: [{
        variantId: 'audio',
        fileName: 'audio.gguf',
        quantizationLabel: 'Q4_K_M',
        size: 1,
        chatModalities: ['text', 'audio'],
      }],
      projectorCandidates: [
        { ...candidate, ownerModelId: 'other/model' },
        validCandidate,
      ],
    })).toEqual([validCandidate]);
  });

  it.each([
    {
      modality: 'audio' as const,
      requiredFor: 'audio' as const,
      expectedSupport: { vision: false, audio: true },
    },
    {
      modality: 'vision' as const,
      requiredFor: 'image' as const,
      expectedSupport: { vision: true, audio: false },
    },
  ])('filters model-wide projectors to explicit $modality support', ({
    modality,
    requiredFor,
    expectedSupport,
  }) => {
    const audioProjector = {
      id: 'audio-projector',
      ownerModelId: 'author/model',
      repoId: 'author/model',
      fileName: 'mmproj-audio.gguf',
      downloadUrl: 'https://example.com/mmproj-audio.gguf',
      size: 100,
      lifecycleStatus: 'available' as const,
      matchStatus: 'matched' as const,
    };
    const visionProjector = {
      ...audioProjector,
      id: 'vision-projector',
      fileName: 'mmproj-vision.gguf',
      downloadUrl: 'https://example.com/mmproj-vision.gguf',
    };
    const expectedProjector = modality === 'audio' ? audioProjector : visionProjector;
    const incompatibleProjector = modality === 'audio' ? visionProjector : audioProjector;
    const model = {
      id: 'author/model',
      chatModalities: ['text', modality] as Array<'text' | 'vision' | 'audio'>,
      projectorCandidates: [audioProjector, visionProjector],
      selectedProjectorId: incompatibleProjector.id,
      artifacts: [
        {
          id: expectedProjector.id,
          kind: 'multimodal_projector' as const,
          requiredFor: [requiredFor],
          remoteFileName: expectedProjector.fileName,
          downloadUrl: expectedProjector.downloadUrl,
          sizeBytes: expectedProjector.size,
          installState: 'remote' as const,
        },
        {
          id: incompatibleProjector.id,
          kind: 'multimodal_projector' as const,
          requiredFor: [requiredFor === 'audio' ? 'image' as const : 'audio' as const],
          remoteFileName: incompatibleProjector.fileName,
          downloadUrl: incompatibleProjector.downloadUrl,
          sizeBytes: incompatibleProjector.size,
          installState: 'remote' as const,
        },
      ],
    };

    expect(getEffectiveActiveVariantProjectorCandidates(model)).toEqual([expectedProjector]);
    expect(getEffectiveActiveVariantSelectedProjectorId(model)).toBeUndefined();
    expect(resolveEffectiveActiveVariantNativeSupport(model)).toEqual(expectedSupport);
  });

  it('merges model-level runtime state into the active-variant projector and remaps selection', () => {
    const activeVariantProjector = {
      id: 'catalog-projector',
      ownerModelId: 'author/model',
      ownerVariantId: 'audio',
      repoId: 'author/model',
      fileName: 'mmproj-audio.gguf',
      downloadUrl: 'https://example.com/mmproj-audio.gguf',
      size: 100,
      lifecycleStatus: 'available' as const,
      matchStatus: 'matched' as const,
    };
    const runtimeProjector = {
      ...activeVariantProjector,
      id: 'runtime-projector',
      localPath: 'models/mmproj-audio.gguf',
      lifecycleStatus: 'downloaded' as const,
      downloadProgress: 1,
    };
    const model = {
      id: 'author/model',
      activeVariantId: 'audio',
      resolvedFileName: 'audio.gguf',
      variants: [{
        variantId: 'audio',
        fileName: 'audio.gguf',
        quantizationLabel: 'Q4_K_M',
        size: 1,
        chatModalities: ['text', 'audio'] as Array<'text' | 'audio'>,
        projectorCandidates: [activeVariantProjector],
      }],
      projectorCandidates: [runtimeProjector],
      selectedProjectorId: runtimeProjector.id,
    };

    expect(getEffectiveActiveVariantProjectorCandidates(model)).toEqual([
      expect.objectContaining({
        id: activeVariantProjector.id,
        localPath: runtimeProjector.localPath,
        lifecycleStatus: 'downloaded',
        downloadProgress: 1,
      }),
    ]);
    expect(getEffectiveActiveVariantSelectedProjectorId(model)).toBe(activeVariantProjector.id);
    expect(resolveEffectiveActiveVariantNativeSupport(model)).toEqual({ vision: false, audio: true });
  });

  it('rejects conflicting model and active-variant projector identities with the same id', () => {
    const activeVariantProjector = {
      id: 'shared-projector',
      ownerModelId: 'author/model',
      ownerVariantId: 'audio',
      repoId: 'author/model',
      fileName: 'mmproj-audio.gguf',
      downloadUrl: 'https://example.com/mmproj-audio.gguf',
      size: 100,
      lifecycleStatus: 'available' as const,
      matchStatus: 'matched' as const,
    };
    const model = {
      id: 'author/model',
      activeVariantId: 'audio',
      resolvedFileName: 'audio.gguf',
      variants: [{
        variantId: 'audio',
        fileName: 'audio.gguf',
        quantizationLabel: 'Q4_K_M',
        size: 1,
        chatModalities: ['text', 'audio'] as Array<'text' | 'audio'>,
        projectorCandidates: [activeVariantProjector],
      }],
      projectorCandidates: [{
        ...activeVariantProjector,
        fileName: 'mmproj-conflicting.gguf',
        downloadUrl: 'https://example.com/mmproj-conflicting.gguf',
        localPath: 'models/mmproj-conflicting.gguf',
        lifecycleStatus: 'downloaded' as const,
      }],
      selectedProjectorId: activeVariantProjector.id,
    };

    expect(getEffectiveActiveVariantProjectorCandidates(model)).toEqual([]);
    expect(getEffectiveActiveVariantSelectedProjectorId(model)).toBeUndefined();
    expect(resolveEffectiveActiveVariantNativeSupport(model)).toEqual({ vision: false, audio: false });
  });

  it('keeps case-distinct physical projector paths separate in the effective active variant', () => {
    const modelId = 'author/case-sensitive-projectors';
    const fileNames = ['Visual/MMProj.gguf', 'visual/mmproj.gguf'];
    const candidates = fileNames.map((fileName) => ({
      id: buildProjectorArtifactId({ repoId: modelId, fileName }),
      ownerModelId: modelId,
      ownerVariantId: 'vision',
      repoId: modelId,
      fileName,
      downloadUrl: `https://huggingface.co/${modelId}/resolve/main/${fileName}`,
      size: 100,
      lifecycleStatus: 'available' as const,
      matchStatus: 'matched' as const,
    }));
    const model = {
      id: modelId,
      activeVariantId: 'vision',
      resolvedFileName: 'vision.gguf',
      variants: [{
        variantId: 'vision',
        fileName: 'vision.gguf',
        quantizationLabel: 'Q4_K_M',
        size: 1,
        chatModalities: ['text', 'vision'] as Array<'text' | 'vision'>,
        projectorCandidates: candidates,
      }],
      projectorCandidates: candidates,
      selectedProjectorId: candidates[0].id,
      artifacts: candidates.map((candidate) => ({
        id: candidate.id,
        kind: 'multimodal_projector' as const,
        requiredFor: ['image' as const],
        remoteFileName: candidate.fileName,
        downloadUrl: candidate.downloadUrl,
        sizeBytes: candidate.size,
        installState: 'remote' as const,
      })),
    };

    expect(getEffectiveActiveVariantProjectorCandidates(model)).toEqual(candidates);
    expect(getEffectiveActiveVariantSelectedProjectorId(model)).toBe(candidates[0].id);
    expect(resolveEffectiveActiveVariantNativeSupport(model)).toEqual({ vision: true, audio: false });
  });

  it('migrates an exact-path legacy projector artifact to a case-sensitive candidate id', () => {
    const modelId = 'author/legacy-projector-migration';
    const modelFileName = 'Model.Q4_K_M.gguf';
    const projectorFileName = 'Projectors/MMProj-Audio.GGUF';
    const identity = {
      repoId: modelId,
      hfRevision: 'main',
      ownerVariantId: modelFileName,
      fileName: projectorFileName,
    };
    const candidate = {
      ...identity,
      id: buildProjectorArtifactId(identity),
      ownerModelId: modelId,
      downloadUrl: 'https://example.com/shared-projector.gguf',
      size: 100,
      localPath: 'stored-MMProj-Audio.GGUF',
      lifecycleStatus: 'downloaded' as const,
      matchStatus: 'matched' as const,
    };
    const legacyArtifact = {
      id: buildLegacyProjectorArtifactId(identity),
      kind: 'multimodal_projector' as const,
      requiredFor: ['audio' as const],
      hfRevision: 'main',
      remoteFileName: projectorFileName,
      downloadUrl: candidate.downloadUrl,
      sizeBytes: candidate.size,
      localPath: candidate.localPath,
      installState: 'installed' as const,
    };
    const model = {
      id: modelId,
      activeVariantId: modelFileName,
      resolvedFileName: modelFileName,
      variants: [{
        variantId: modelFileName,
        fileName: modelFileName,
        quantizationLabel: 'Q4_K_M',
        size: 1,
        chatModalities: ['text', 'audio'] as ('text' | 'audio')[],
      }],
      projectorCandidates: [candidate],
      artifacts: [legacyArtifact],
    };

    expect(candidate.id).not.toBe(legacyArtifact.id);
    expect(projectorArtifactMatchesCandidate(legacyArtifact, candidate)).toBe(true);
    expect(getEffectiveActiveVariantProjectorCandidates(model)).toEqual([candidate]);
    expect(resolveEffectiveActiveVariantNativeSupport(model)).toEqual({ vision: false, audio: true });
  });

  it('does not alias a legacy id collision across case-distinct remote paths', () => {
    const modelId = 'author/legacy-projector-collision';
    const upperIdentity = {
      repoId: modelId,
      hfRevision: 'main',
      ownerVariantId: 'Model.Q4_K_M.gguf',
      fileName: 'Projectors/MMProj.GGUF',
    };
    const lowerIdentity = {
      repoId: modelId,
      hfRevision: 'main',
      ownerVariantId: 'model.q4_k_m.gguf',
      fileName: 'projectors/mmproj.gguf',
    };
    const lowerCandidate = {
      ...lowerIdentity,
      id: buildProjectorArtifactId(lowerIdentity),
      ownerModelId: modelId,
      downloadUrl: 'https://example.com/shared-projector.gguf',
      size: 100,
      lifecycleStatus: 'available' as const,
      matchStatus: 'matched' as const,
    };
    const upperLegacyArtifact = {
      id: buildLegacyProjectorArtifactId(upperIdentity),
      kind: 'multimodal_projector' as const,
      requiredFor: ['image' as const],
      hfRevision: 'main',
      remoteFileName: upperIdentity.fileName,
      downloadUrl: lowerCandidate.downloadUrl,
      sizeBytes: lowerCandidate.size,
      installState: 'installed' as const,
    };
    const model = {
      id: modelId,
      activeVariantId: lowerIdentity.ownerVariantId,
      resolvedFileName: lowerIdentity.ownerVariantId,
      variants: [{
        variantId: lowerIdentity.ownerVariantId,
        fileName: lowerIdentity.ownerVariantId,
        quantizationLabel: 'Q4_K_M',
        size: 1,
        chatModalities: ['text', 'vision'] as ('text' | 'vision')[],
      }],
      projectorCandidates: [lowerCandidate],
      artifacts: [upperLegacyArtifact],
    };

    expect(upperLegacyArtifact.id).toBe(lowerCandidate.id);
    expect(projectorArtifactMatchesCandidate(upperLegacyArtifact, lowerCandidate)).toBe(false);
    expect(getEffectiveActiveVariantProjectorCandidates(model)).toEqual([]);
  });

  it('does not alias a legacy id collision across case-distinct owner variants', () => {
    const modelId = 'author/legacy-owner-variant-collision';
    const projectorFileName = 'projectors/mmproj-shared.gguf';
    const upperIdentity = {
      repoId: modelId,
      hfRevision: 'main',
      ownerVariantId: 'Model.Q4_K_M.gguf',
      fileName: projectorFileName,
    };
    const lowerIdentity = {
      ...upperIdentity,
      ownerVariantId: 'model.q4_k_m.gguf',
    };
    const makeCandidate = (identity: typeof upperIdentity) => ({
      ...identity,
      id: buildProjectorArtifactId(identity),
      ownerModelId: modelId,
      downloadUrl: 'https://example.com/shared-projector.gguf',
      size: 100,
      lifecycleStatus: 'available' as const,
      matchStatus: 'matched' as const,
    });
    const upperCandidate = makeCandidate(upperIdentity);
    const lowerCandidate = makeCandidate(lowerIdentity);
    const upperLegacyArtifact = {
      id: buildLegacyProjectorArtifactId(upperIdentity),
      kind: 'multimodal_projector' as const,
      requiredFor: ['image' as const],
      hfRevision: 'main',
      remoteFileName: projectorFileName,
      downloadUrl: lowerCandidate.downloadUrl,
      sizeBytes: lowerCandidate.size,
      installState: 'installed' as const,
    };
    const model = {
      id: modelId,
      activeVariantId: lowerIdentity.ownerVariantId,
      resolvedFileName: lowerIdentity.ownerVariantId,
      variants: [
        {
          variantId: upperIdentity.ownerVariantId,
          fileName: upperIdentity.ownerVariantId,
          quantizationLabel: 'Q4_K_M',
          size: 1,
          chatModalities: ['text', 'vision'] as ('text' | 'vision')[],
          projectorCandidates: [upperCandidate],
        },
        {
          variantId: lowerIdentity.ownerVariantId,
          fileName: lowerIdentity.ownerVariantId,
          quantizationLabel: 'Q4_K_M',
          size: 1,
          chatModalities: ['text', 'vision'] as ('text' | 'vision')[],
          projectorCandidates: [lowerCandidate],
        },
      ],
      projectorCandidates: [upperCandidate, lowerCandidate],
      artifacts: [upperLegacyArtifact],
    };

    expect(upperCandidate.id).not.toBe(lowerCandidate.id);
    expect(upperLegacyArtifact.id).toBe(lowerCandidate.id);
    expect(projectorArtifactMatchesCandidate(upperLegacyArtifact, lowerCandidate)).toBe(true);
    expect(getEffectiveActiveVariantProjectorCandidates(model)).toEqual([]);

    const upperCurrentArtifact = {
      ...upperLegacyArtifact,
      id: upperCandidate.id,
    };
    const upperActiveModel = {
      ...model,
      activeVariantId: upperIdentity.ownerVariantId,
      resolvedFileName: upperIdentity.ownerVariantId,
      artifacts: [upperLegacyArtifact, upperCurrentArtifact],
    };
    expect(getEffectiveActiveVariantProjectorCandidates(upperActiveModel).map(({ id }) => id))
      .toEqual([upperCandidate.id]);
  });

  it('preserves legacy artifact provenance when normalization creates a current-id duplicate', () => {
    const modelId = 'author/legacy-projector-duplicate';
    const modelFileName = 'Model.Q4_K_M.gguf';
    const projectorFileName = 'Projectors/MMProj-Audio.GGUF';
    const identity = {
      repoId: modelId,
      hfRevision: 'main',
      ownerVariantId: modelFileName,
      fileName: projectorFileName,
    };
    const candidate = {
      ...identity,
      id: buildProjectorArtifactId(identity),
      ownerModelId: modelId,
      downloadUrl: 'https://example.com/shared-projector.gguf',
      size: 100,
      localPath: 'stored-MMProj-Audio.GGUF',
      downloadProgress: 1,
      lifecycleStatus: 'downloaded' as const,
      matchStatus: 'matched' as const,
    };
    const legacyArtifact = {
      id: buildLegacyProjectorArtifactId(identity),
      kind: 'multimodal_projector' as const,
      requiredFor: ['audio' as const],
      hfRevision: 'main',
      remoteFileName: projectorFileName,
      downloadUrl: candidate.downloadUrl,
      sizeBytes: candidate.size,
      localPath: candidate.localPath,
      installState: 'installed' as const,
    };
    const normalized = normalizePersistedModelMetadata({
      id: modelId,
      name: 'Legacy projector duplicate',
      author: 'Author',
      size: 1_000,
      downloadUrl: `https://example.com/${modelFileName}`,
      hfRevision: 'main',
      resolvedFileName: modelFileName,
      fitsInRam: true,
      accessState: ModelAccessState.PUBLIC,
      isGated: false,
      isPrivate: false,
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
      activeVariantId: modelFileName,
      variants: [{
        variantId: modelFileName,
        fileName: modelFileName,
        quantizationLabel: 'Q4_K_M',
        size: 1_000,
        chatModalities: ['text', 'audio'],
      }],
      chatModalities: ['text', 'vision', 'audio'],
      artifactRole: 'primary_chat_model',
      artifacts: [legacyArtifact],
      projectorCandidates: [candidate],
      selectedProjectorId: candidate.id,
    });
    const projectorArtifacts = normalized.artifacts?.filter((artifact) => (
      artifact.kind === 'multimodal_projector'
    )) ?? [];

    expect(projectorArtifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: legacyArtifact.id,
        requiredFor: ['audio'],
        localPath: legacyArtifact.localPath,
        installState: 'installed',
      }),
      expect.objectContaining({
        id: candidate.id,
        requiredFor: ['image', 'audio'],
        localPath: candidate.localPath,
        installState: 'installed',
      }),
    ]));
    expect(getEffectiveActiveVariantProjectorCandidates(normalized)).toEqual([
      expect.objectContaining({
        id: candidate.id,
        localPath: candidate.localPath,
        lifecycleStatus: 'downloaded',
      }),
    ]);
    expect(getEffectiveActiveVariantProjectorCandidates({
      ...normalized,
      variants: normalized.variants?.map((variant) => ({
        ...variant,
        chatModalities: ['text', 'vision'],
      })),
    })).toEqual([]);
  });

  it('accepts projector artifact modality only for exact id, normalized filename, and revision identity', () => {
    const candidate = {
      id: 'audio-projector',
      ownerModelId: 'author/model',
      ownerVariantId: 'audio',
      repoId: 'author/model',
      fileName: 'MMProj-Audio.GGUF',
      downloadUrl: 'https://huggingface.co/author/model/resolve/main/mmproj-audio.gguf',
      hfRevision: 'main',
      sha256: `sha256:${'a'.repeat(64).toUpperCase()}`,
      size: 100,
      lifecycleStatus: 'available' as const,
      matchStatus: 'matched' as const,
    };
    const model = {
      id: 'author/model',
      activeVariantId: 'audio',
      resolvedFileName: 'audio.gguf',
      variants: [{
        variantId: 'audio',
        fileName: 'audio.gguf',
        quantizationLabel: 'Q4_K_M',
        size: 1,
        chatModalities: ['text', 'audio'] as Array<'text' | 'audio'>,
        projectorCandidates: [candidate],
      }],
      artifacts: [{
        id: candidate.id,
        kind: 'multimodal_projector' as const,
        requiredFor: ['audio'] as Array<'audio'>,
        hfRevision: ' main ',
        remoteFileName: `nested/${candidate.fileName.toLowerCase()}`,
        downloadUrl: candidate.downloadUrl,
        sizeBytes: candidate.size,
        sha256: 'a'.repeat(64),
        installState: 'remote' as const,
      }],
    };

    expect(getEffectiveActiveVariantProjectorCandidates(model)).toEqual([candidate]);
    expect(resolveEffectiveActiveVariantNativeSupport(model)).toEqual({ vision: false, audio: true });
  });

  it.each([
    {
      label: 'same id with a different filename',
      artifact: { remoteFileName: 'mmproj-other.gguf' },
    },
    {
      label: 'same filename with a different id',
      artifact: { id: 'different-projector' },
    },
    {
      label: 'different revision',
      artifact: { hfRevision: 'refs/pr/1' },
    },
    {
      label: 'different hash',
      artifact: { sha256: 'b'.repeat(64) },
    },
    {
      label: 'different size',
      artifact: { sizeBytes: 101 },
    },
    {
      label: 'different download URL',
      artifact: { downloadUrl: 'https://huggingface.co/author/model/resolve/main/mmproj-other.gguf' },
    },
  ])('rejects projector modality evidence with $label', ({ artifact: artifactOverrides }) => {
    const candidate = {
      id: 'audio-projector',
      ownerModelId: 'author/model',
      ownerVariantId: 'audio',
      repoId: 'author/model',
      fileName: 'mmproj-audio.gguf',
      downloadUrl: 'https://huggingface.co/author/model/resolve/main/mmproj-audio.gguf',
      hfRevision: 'main',
      sha256: 'a'.repeat(64),
      size: 100,
      lifecycleStatus: 'available' as const,
      matchStatus: 'matched' as const,
    };
    const artifact = {
      id: candidate.id,
      kind: 'multimodal_projector' as const,
      requiredFor: ['audio'] as Array<'audio'>,
      hfRevision: candidate.hfRevision,
      remoteFileName: candidate.fileName,
      downloadUrl: candidate.downloadUrl,
      sizeBytes: candidate.size,
      sha256: candidate.sha256,
      installState: 'remote' as const,
      ...artifactOverrides,
    };
    const model = {
      id: 'author/model',
      activeVariantId: 'audio',
      resolvedFileName: 'audio.gguf',
      variants: [{
        variantId: 'audio',
        fileName: 'audio.gguf',
        quantizationLabel: 'Q4_K_M',
        size: 1,
        chatModalities: ['text', 'audio'] as Array<'text' | 'audio'>,
        projectorCandidates: [candidate],
      }],
      artifacts: [artifact],
    };

    expect(getEffectiveActiveVariantProjectorCandidates(model)).toEqual([]);
    expect(resolveEffectiveActiveVariantNativeSupport(model)).toEqual({ vision: false, audio: false });
  });

  it.each([
    { label: 'text', modalities: ['text'] as Array<'text'>, expected: { vision: false, audio: false } },
    { label: 'vision', modalities: ['text', 'vision'] as Array<'text' | 'vision'>, expected: { vision: true, audio: false } },
    { label: 'audio', modalities: ['text', 'audio'] as Array<'text' | 'audio'>, expected: { vision: false, audio: true } },
    {
      label: 'mixed',
      modalities: ['text', 'vision', 'audio'] as Array<'text' | 'vision' | 'audio'>,
      expected: { vision: true, audio: true },
    },
  ])('resolves explicit active $label variant support', ({ modalities, expected }) => {
    const audioProjector = {
      id: 'audio-projector',
      ownerModelId: 'author/model',
      ownerVariantId: 'active',
      repoId: 'author/model',
      fileName: 'mmproj-audio.gguf',
      downloadUrl: 'https://example.com/mmproj-audio.gguf',
      size: 1,
      lifecycleStatus: 'available' as const,
      matchStatus: 'matched' as const,
    };
    const visionProjector = {
      ...audioProjector,
      id: 'vision-projector',
      fileName: 'mmproj-vision.gguf',
      downloadUrl: 'https://example.com/mmproj-vision.gguf',
    };
    const projectorCandidates = modalities.includes('audio')
      ? [audioProjector, ...(modalities.includes('vision') ? [visionProjector] : [])]
      : [];

    expect(resolveEffectiveActiveVariantNativeSupport({
      id: 'author/model',
      activeVariantId: 'active',
      resolvedFileName: 'active.gguf',
      variants: [{
        variantId: 'active',
        fileName: 'active.gguf',
        quantizationLabel: 'Q4_K_M',
        size: 1,
        chatModalities: modalities,
        projectorCandidates,
      }],
      projectorCandidates,
      artifacts: projectorCandidates.map((candidate) => ({
        id: candidate.id,
        kind: 'multimodal_projector' as const,
        requiredFor: [candidate.id === 'audio-projector' ? 'audio' as const : 'image' as const],
        remoteFileName: candidate.fileName,
        downloadUrl: candidate.downloadUrl,
        sizeBytes: candidate.size,
        installState: 'remote' as const,
      })),
    })).toEqual(expected);
  });
});
