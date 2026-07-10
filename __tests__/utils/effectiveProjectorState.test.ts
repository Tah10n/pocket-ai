import { LifecycleStatus, ModelAccessState, type ModelMetadata } from '../../src/types/models';
import type { ProjectorArtifact } from '../../src/types/multimodal';
import {
  applyEffectiveProjectorState,
  updateEffectiveProjectorCandidate,
} from '../../src/utils/effectiveProjectorState';
import { mergeProjectorCandidatesWithRuntimeStateAndIdMap } from '../../src/utils/projectorRuntimeState';

function makeProjector(overrides: Partial<ProjectorArtifact> = {}): ProjectorArtifact {
  return {
    id: 'org/model:mmproj',
    ownerModelId: 'org/model',
    ownerVariantId: 'audio-variant',
    repoId: 'org/model',
    fileName: 'mmproj-audio.gguf',
    downloadUrl: 'https://example.com/mmproj-audio.gguf',
    hfRevision: 'main',
    size: 256,
    lifecycleStatus: 'available',
    matchStatus: 'matched',
    ...overrides,
  };
}

function makeModel(overrides: Partial<ModelMetadata> = {}): ModelMetadata {
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
    lifecycleStatus: LifecycleStatus.AVAILABLE,
    downloadProgress: 0,
    variants: [{
      variantId: 'audio-variant',
      fileName: 'audio.gguf',
      quantizationLabel: 'Q4_K_M',
      size: 1024,
      chatModalities: ['text', 'audio'],
      projectorCandidates: [makeProjector()],
      selectedProjectorId: 'org/model:mmproj',
    }],
    ...overrides,
  };
}

describe('effectiveProjectorState', () => {
  it('updates only the stable effective identity while preserving an incompatible model-wide candidate', () => {
    const staleTopLevel = makeProjector({
      id: 'org/model:mmproj-stale',
      ownerVariantId: undefined,
      fileName: 'mmproj-stale.gguf',
      downloadUrl: 'https://example.com/mmproj-stale.gguf',
    });
    const updated = updateEffectiveProjectorCandidate(makeModel({
      projectorCandidates: [staleTopLevel],
    }), 'org/model:mmproj', {
      lifecycleStatus: 'downloading',
      downloadProgress: 0.5,
    });

    expect(updated.projectorCandidates?.[0]).toEqual(staleTopLevel);
    expect(updated.variants?.[0].projectorCandidates?.[0]).toEqual(expect.objectContaining({
      fileName: 'mmproj-audio.gguf',
      lifecycleStatus: 'downloading',
      downloadProgress: 0.5,
    }));
  });

  it('rejects a stale async update when the current same-id artifact has another stable identity', () => {
    const originalProjector = makeProjector();
    const replacementProjector = makeProjector({
      fileName: 'mmproj-audio-v2.gguf',
      downloadUrl: 'https://example.com/mmproj-audio-v2.gguf',
    });
    const model = makeModel({
      variants: [{
        ...makeModel().variants![0],
        projectorCandidates: [replacementProjector],
        selectedProjectorId: replacementProjector.id,
      }],
    });

    const updated = updateEffectiveProjectorCandidate(model, originalProjector.id, {
      lifecycleStatus: 'downloading',
      downloadProgress: 0.5,
    }, originalProjector);

    expect(updated).toBe(model);
    expect(updated.variants?.[0].projectorCandidates).toEqual([replacementProjector]);
  });

  it.each([
    {
      label: 'sha256',
      runtime: { sha256: 'a'.repeat(64) },
      incoming: { sha256: 'b'.repeat(64) },
    },
    {
      label: 'size',
      runtime: { size: 256 },
      incoming: { size: 512 },
    },
    {
      label: 'download URL',
      runtime: { downloadUrl: 'https://example.com/mmproj-audio.gguf' },
      incoming: { downloadUrl: 'https://cdn.example.com/mmproj-audio.gguf' },
    },
  ])('does not carry runtime state through an id remap with a $label conflict', ({ runtime, incoming }) => {
    const runtimeProjector = makeProjector({
      id: 'org/model:mmproj-runtime',
      localPath: 'partial-mmproj-audio.gguf',
      resumeData: 'audio-resume',
      lifecycleStatus: 'paused',
      ...runtime,
    });
    const incomingProjector = makeProjector({
      id: 'org/model:mmproj-catalog',
      ...incoming,
    });

    const merged = mergeProjectorCandidatesWithRuntimeStateAndIdMap(
      [incomingProjector],
      [runtimeProjector],
      { activeVariantIds: ['audio-variant', 'audio.gguf'] },
    );

    expect(merged.projectorCandidates).toEqual([incomingProjector]);
    expect(merged.projectorCandidates?.[0]).not.toHaveProperty('localPath');
    expect(merged.projectorCandidates?.[0]).not.toHaveProperty('resumeData');
    expect(merged.projectorCandidates?.[0].lifecycleStatus).toBe('available');
  });

  it('remaps a stable variant-only artifact id and clears a stale model-level selection', () => {
    const remapped = makeProjector({ id: 'org/model:mmproj-v2' });
    const updated = applyEffectiveProjectorState(makeModel({
      selectedProjectorId: 'org/model:stale-other-variant',
    }), {
      projectorCandidates: [{
        ...remapped,
        lifecycleStatus: 'paused',
        resumeData: 'resume-v2',
      }],
      selectedProjectorId: remapped.id,
    });

    expect(updated.selectedProjectorId).toBeUndefined();
    expect(updated.variants?.[0]).toEqual(expect.objectContaining({
      selectedProjectorId: remapped.id,
      projectorCandidates: [expect.objectContaining({
        id: remapped.id,
        fileName: remapped.fileName,
        lifecycleStatus: 'paused',
        resumeData: 'resume-v2',
      })],
    }));
  });

  it('treats an empty effective state as authoritative while preserving inactive variants', () => {
    const inactiveProjector = makeProjector({
      id: 'org/model:mmproj-vision',
      ownerVariantId: 'vision-variant',
      fileName: 'mmproj-vision.gguf',
      downloadUrl: 'https://example.com/mmproj-vision.gguf',
    });
    const updated = applyEffectiveProjectorState(makeModel({
      projectorCandidates: [makeProjector()],
      variants: [
        ...makeModel().variants!,
        {
          variantId: 'vision-variant',
          fileName: 'vision.gguf',
          quantizationLabel: 'Q4_K_M',
          size: 1024,
          chatModalities: ['text', 'vision'],
          projectorCandidates: [inactiveProjector],
          selectedProjectorId: inactiveProjector.id,
        },
      ],
    }), {
      projectorCandidates: undefined,
      selectedProjectorId: undefined,
    });

    expect(updated.projectorCandidates).toBeUndefined();
    expect(updated.variants?.[0].projectorCandidates).toBeUndefined();
    expect(updated.variants?.[0].selectedProjectorId).toBeUndefined();
    expect(updated.variants?.[1].projectorCandidates).toEqual([inactiveProjector]);
    expect(updated.variants?.[1].selectedProjectorId).toBe(inactiveProjector.id);
  });

  it('replaces a conflicting active artifact instead of retaining the stale same-id file', () => {
    const replacement = makeProjector({
      fileName: 'mmproj-audio-v2.gguf',
      downloadUrl: 'https://example.com/mmproj-audio-v2.gguf',
    });
    const updated = applyEffectiveProjectorState(makeModel(), {
      projectorCandidates: [replacement],
      selectedProjectorId: replacement.id,
    });

    expect(updated.variants?.[0].projectorCandidates).toEqual([replacement]);
    expect(updated.variants?.[0].projectorCandidates).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ fileName: 'mmproj-audio.gguf' }),
    ]));
  });

  it('preserves a model-wide candidate incompatible with the active audio-only variant', () => {
    const visionProjector = makeProjector({
      id: 'org/model:mmproj-vision',
      ownerVariantId: undefined,
      fileName: 'mmproj-vision.gguf',
      downloadUrl: 'https://example.com/mmproj-vision.gguf',
    });
    const audioProjector = makeProjector();
    const updated = applyEffectiveProjectorState(makeModel({
      projectorCandidates: [visionProjector],
    }), {
      projectorCandidates: [{ ...audioProjector, lifecycleStatus: 'downloaded' }],
      selectedProjectorId: audioProjector.id,
    });

    expect(updated.projectorCandidates).toEqual([visionProjector]);
    expect(updated.variants?.[0].projectorCandidates).toEqual([
      expect.objectContaining({
        id: audioProjector.id,
        lifecycleStatus: 'downloaded',
      }),
    ]);
  });
});
