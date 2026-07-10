import { LifecycleStatus, ModelAccessState, type ModelMetadata } from '../../src/types/models';
import type { ProjectorArtifact } from '../../src/types/multimodal';
import {
  getSelectedProjectorMemoryFitSignature,
  shouldClearProjectorScopedMemoryFit,
} from '../../src/utils/projectorMemoryFitInvalidation';

function makeProjector(overrides: Partial<ProjectorArtifact> = {}): ProjectorArtifact {
  return {
    id: 'org/model:mmproj-audio',
    ownerModelId: 'org/model',
    ownerVariantId: 'audio-variant',
    repoId: 'org/model',
    fileName: 'mmproj-audio.gguf',
    downloadUrl: 'https://example.com/mmproj-audio.gguf',
    size: 256,
    lifecycleStatus: 'downloaded',
    matchStatus: 'user_selected',
    ...overrides,
  };
}

function makeModel(projector: ProjectorArtifact, overrides: Partial<ModelMetadata> = {}): ModelMetadata {
  return {
    id: 'org/model',
    name: 'model',
    author: 'org',
    size: 1024,
    downloadUrl: 'https://example.com/model.gguf',
    resolvedFileName: 'audio.gguf',
    activeVariantId: 'audio-variant',
    fitsInRam: true,
    accessState: ModelAccessState.PUBLIC,
    isGated: false,
    isPrivate: false,
    lifecycleStatus: LifecycleStatus.DOWNLOADED,
    downloadProgress: 1,
    variants: [{
      variantId: 'audio-variant',
      fileName: 'audio.gguf',
      quantizationLabel: 'Q4_K_M',
      size: 1024,
      chatModalities: ['text', 'audio'],
      projectorCandidates: [projector],
      selectedProjectorId: projector.id,
    }],
    ...overrides,
  };
}

describe('projectorMemoryFitInvalidation', () => {
  it('invalidates memory fit when a variant-only selected projector identity changes', () => {
    const previous = makeModel(makeProjector());
    const next = makeModel(makeProjector({
      fileName: 'mmproj-audio-v2.gguf',
      downloadUrl: 'https://example.com/mmproj-audio-v2.gguf',
      size: 512,
    }));

    expect(getSelectedProjectorMemoryFitSignature(previous)).not.toBeNull();
    expect(shouldClearProjectorScopedMemoryFit(previous, next)).toBe(true);
  });

  it('ignores an inactive model-wide vision candidate while audio is active', () => {
    const audioProjector = makeProjector();
    const visionProjector = makeProjector({
      id: 'org/model:mmproj-vision',
      ownerVariantId: undefined,
      fileName: 'mmproj-vision.gguf',
      downloadUrl: 'https://example.com/mmproj-vision.gguf',
      size: 128,
      matchStatus: 'matched',
    });
    const previous = makeModel(audioProjector, { projectorCandidates: [visionProjector] });
    const next = makeModel(audioProjector, {
      projectorCandidates: [{ ...visionProjector, size: 1024 }],
    });

    expect(shouldClearProjectorScopedMemoryFit(previous, next)).toBe(false);
  });
});
