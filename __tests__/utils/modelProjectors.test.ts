import {
  buildProjectorArtifactId,
  isProjectorFileName,
  resolveDeterministicProjectorCandidate,
  resolveModelArtifactRole,
} from '../../src/utils/modelProjectors';
import {
  alternateProjectorFileName,
  projectorFileName,
  visionModelFileName,
} from '../fixtures/multimodalCatalogFixtures';

function createProjector(fileName: string) {
  return {
    id: buildProjectorArtifactId({
      repoId: 'test-org/vision-chat-model',
      hfRevision: 'main',
      fileName,
    }),
    ownerModelId: 'test-org/vision-chat-model',
    repoId: 'test-org/vision-chat-model',
    fileName,
    downloadUrl: `https://huggingface.co/test-org/vision-chat-model/resolve/main/${fileName}`,
    size: 1_000,
    lifecycleStatus: 'available' as const,
    matchStatus: 'matched' as const,
  };
}

describe('modelProjectors', () => {
  it('classifies projector companion filenames separately from primary chat models', () => {
    expect(isProjectorFileName(projectorFileName)).toBe(true);
    expect(isProjectorFileName('nested/clip_projector-vision-chat.gguf')).toBe(true);
    expect(isProjectorFileName(visionModelFileName)).toBe(false);

    expect(resolveModelArtifactRole(projectorFileName)).toBe('projector_companion');
    expect(resolveModelArtifactRole(visionModelFileName)).toBe('primary_chat_model');
  });

  it.each([
    'mmproj-config.json',
    'clip_projector.txt',
    'adapter.mmproj.safetensors',
    'nested/mmproj-model.bin',
  ])('does not classify non-GGUF projector-like file %s as a projector companion', (fileName) => {
    expect(isProjectorFileName(fileName)).toBe(false);
    expect(resolveModelArtifactRole(fileName)).toBe('primary_chat_model');
  });

  it('builds stable projector artifact ids from repo, revision, variant, and filename', () => {
    expect(buildProjectorArtifactId({
      repoId: 'Test-Org/Vision-Chat-Model',
      hfRevision: 'Main',
      ownerVariantId: visionModelFileName,
      fileName: projectorFileName,
    })).toBe('projector-test-org-vision-chat-model-main-vision-chat-q4_k_m.gguf-mmproj-vision-chat-f16.gguf');
  });

  it('keeps projector artifact ids distinct for equal basenames in different directories', () => {
    const firstId = buildProjectorArtifactId({
      repoId: 'test-org/vision-chat-model',
      hfRevision: 'main',
      fileName: 'variant-a/mmproj.gguf',
    });
    const secondId = buildProjectorArtifactId({
      repoId: 'test-org/vision-chat-model',
      hfRevision: 'main',
      fileName: 'variant-b/mmproj.gguf',
    });

    expect(firstId).not.toBe(secondId);
    expect(firstId).toContain('path-');
    expect(secondId).toContain('path-');
  });

  it('does not collapse path separators into hyphen-equivalent projector artifact ids', () => {
    const nestedPathId = buildProjectorArtifactId({
      repoId: 'test-org/vision-chat-model',
      hfRevision: 'main',
      fileName: 'a/b/mmproj.gguf',
    });
    const hyphenPathId = buildProjectorArtifactId({
      repoId: 'test-org/vision-chat-model',
      hfRevision: 'main',
      fileName: 'a-b/mmproj.gguf',
    });

    expect(nestedPathId).not.toBe(hyphenPathId);
  });

  it('selects a deterministic projector only when one candidate has stronger model affinity', () => {
    const matchingProjector = createProjector(projectorFileName);
    const unrelatedProjector = createProjector('mmproj-unrelated-model-f16.gguf');

    expect(resolveDeterministicProjectorCandidate(
      visionModelFileName,
      [unrelatedProjector, matchingProjector],
    )).toBe(matchingProjector);

    expect(resolveDeterministicProjectorCandidate(
      visionModelFileName,
      [
        matchingProjector,
        createProjector(alternateProjectorFileName),
      ],
    )).toBeNull();
  });
});
