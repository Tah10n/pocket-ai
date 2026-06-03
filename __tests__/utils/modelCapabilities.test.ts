import { LifecycleStatus, ModelAccessState } from '../../src/types/models';
import { normalizePersistedModelMetadata } from '../../src/services/ModelMetadataNormalizer';
import {
  UNKNOWN_MODEL_GPU_LAYERS_CEILING,
} from '../../src/services/SettingsStore';
import {
  buildModelCapabilitySnapshot,
  getModelVisionCapabilityBadgePresentation,
  getModelVisionCapabilityStatusLabelKey,
  modelSupportsVision,
  resolveModelCapabilitySnapshot,
} from '../../src/utils/modelCapabilities';

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
    expect(modelSupportsVision({
      artifactRole: 'primary_chat_model',
      selectedProjectorId: projector.id,
    })).toBe(true);
    expect(modelSupportsVision({
      artifactRole: 'primary_chat_model',
      multimodalReadiness: {
        modelId: 'author/model',
        status: 'missing_projector',
        support: [],
        checkedAt: 1,
      },
    })).toBe(true);
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
    expect(getModelVisionCapabilityStatusLabelKey({
      artifactRole: 'primary_chat_model',
      projectorCandidates: [projector],
    })).toBe('models.vision.capabilityNeedsProjector');
    expect(modelSupportsVision({
      artifactRole: 'projector_companion',
      projectorCandidates: [projector],
    })).toBe(false);
  });
});
