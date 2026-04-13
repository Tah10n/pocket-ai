import { LifecycleStatus, ModelAccessState } from '../../src/types/models';
import { normalizePersistedModelMetadata } from '../../src/services/ModelMetadataNormalizer';
import {
  UNKNOWN_MODEL_GPU_LAYERS_CEILING,
} from '../../src/services/SettingsStore';
import {
  buildModelCapabilitySnapshot,
  resolveModelCapabilitySnapshot,
} from '../../src/utils/modelCapabilities';

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
      sha256: 'abc123',
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
      sha256: 'abc123',
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
      sha256: 'same-sha',
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
      sha256: 'same-sha',
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
      sha256: 'same-sha',
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
      sha256: 'same-sha',
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
});
