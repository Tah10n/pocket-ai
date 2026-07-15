import { LifecycleStatus, ModelAccessState, type ModelMetadata } from '../../src/types/models';
import type { ProjectorArtifact } from '../../src/types/multimodal';
import {
  applyEffectiveProjectorState,
  updateEffectiveProjectorCandidate,
} from '../../src/utils/effectiveProjectorState';
import { getEffectiveActiveVariantProjectorCandidates } from '../../src/utils/modelCapabilities';
import { buildProjectorArtifactId } from '../../src/utils/modelProjectors';
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

  it('updates only the variant exact scope when a model-wide runtime artifact has the same file evidence', () => {
    const currentProjector = makeProjector({
      id: 'org/model:mmproj-current',
      lifecycleStatus: 'available',
      downloadProgress: 0,
    });
    const runtimeAlias = makeProjector({
      id: 'org/model:mmproj-runtime-alias',
      ownerVariantId: undefined,
      lifecycleStatus: 'paused',
      downloadProgress: 0.2,
      resumeData: 'runtime-resume-data',
    });
    const inactiveAlias = makeProjector({
      id: 'org/model:mmproj-inactive-alias',
      ownerVariantId: 'vision-variant',
      lifecycleStatus: 'paused',
      downloadProgress: 0.1,
    });
    const model = makeModel({
      projectorCandidates: [runtimeAlias],
      variants: [
        {
          ...makeModel().variants![0],
          projectorCandidates: [currentProjector],
          selectedProjectorId: currentProjector.id,
        },
        {
          variantId: 'vision-variant',
          fileName: 'vision.gguf',
          quantizationLabel: 'Q4_K_M',
          size: 1024,
          chatModalities: ['text', 'vision'],
          projectorCandidates: [inactiveAlias],
          selectedProjectorId: inactiveAlias.id,
        },
      ],
    });

    const variantProjectorId = buildProjectorArtifactId({
      repoId: currentProjector.repoId,
      hfRevision: currentProjector.hfRevision,
      ownerVariantId: currentProjector.ownerVariantId,
      fileName: currentProjector.fileName,
    });
    expect(getEffectiveActiveVariantProjectorCandidates(model)).toEqual([
      expect.objectContaining({
        id: variantProjectorId,
        lifecycleStatus: 'available',
        downloadProgress: 0,
      }),
    ]);

    const updated = updateEffectiveProjectorCandidate(model, currentProjector.id, {
      ...currentProjector,
      lifecycleStatus: 'downloading',
      downloadProgress: 0.6,
    }, currentProjector);

    expect(updated.projectorCandidates).toEqual([
      expect.objectContaining({
        id: runtimeAlias.id,
        ownerVariantId: undefined,
        lifecycleStatus: 'paused',
        downloadProgress: 0.2,
      }),
    ]);
    expect(updated.variants?.[0].projectorCandidates).toEqual([
      expect.objectContaining({
        id: currentProjector.id,
        lifecycleStatus: 'downloading',
        downloadProgress: 0.6,
      }),
    ]);
    expect(updated.variants?.[1].projectorCandidates).toEqual([inactiveAlias]);
    expect(getEffectiveActiveVariantProjectorCandidates(updated)).toEqual([
      expect.objectContaining({
        id: variantProjectorId,
        lifecycleStatus: 'downloading',
        downloadProgress: 0.6,
      }),
    ]);
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
  ])('blocks the whole exact scope when an id remap has a $label conflict', ({ runtime, incoming }) => {
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

    expect(merged.projectorCandidates).toEqual([]);
    expect(merged.blockedRuntimeProjectorIds).toContain(runtimeProjector.id);
    expect(merged.blockedNextProjectorIds).toContain(incomingProjector.id);
    expect(merged.blockedRuntimeReadinessProjectorIds).toContain(runtimeProjector.id);
    expect(merged.blockedNextReadinessProjectorIds).toContain(incomingProjector.id);
  });

  it('distinguishes missing projector metadata from an authoritative empty candidate list', () => {
    const runtimeProjector = makeProjector({
      localPath: 'partial-mmproj-audio.gguf',
      resumeData: 'audio-resume',
      lifecycleStatus: 'paused',
      matchStatus: 'user_selected',
    });

    const missingMetadataMerge = mergeProjectorCandidatesWithRuntimeStateAndIdMap(
      undefined,
      [runtimeProjector],
      { activeVariantIds: ['audio-variant', 'audio.gguf'] },
    );
    const authoritativeEmptyMerge = mergeProjectorCandidatesWithRuntimeStateAndIdMap(
      [],
      [runtimeProjector],
      {
        activeVariantIds: ['audio-variant', 'audio.gguf'],
        emptyNextProjectorsAreAuthoritative: true,
      },
    );

    const canonicalRuntimeProjectorId = buildProjectorArtifactId({
      repoId: runtimeProjector.repoId,
      hfRevision: runtimeProjector.hfRevision,
      ownerVariantId: runtimeProjector.ownerVariantId,
      fileName: runtimeProjector.fileName,
    });
    expect(missingMetadataMerge.projectorCandidates).toEqual([
      expect.objectContaining({
        ...runtimeProjector,
        id: canonicalRuntimeProjectorId,
      }),
    ]);
    expect(missingMetadataMerge.runtimeToNextProjectorIds.get(runtimeProjector.id)).toBe(canonicalRuntimeProjectorId);
    expect(authoritativeEmptyMerge.projectorCandidates).toEqual([]);
    expect(authoritativeEmptyMerge.runtimeToNextProjectorIds).toEqual(new Map());
    expect(authoritativeEmptyMerge.blockedRuntimeProjectorIds).toEqual(new Set([runtimeProjector.id]));
    expect(authoritativeEmptyMerge.blockedRuntimeReadinessProjectorIds).toEqual(new Set([runtimeProjector.id]));
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
