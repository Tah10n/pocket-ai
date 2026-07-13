import {
  buildLegacyProjectorArtifactId,
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

  it('keeps case-distinct projector paths and owner variants physically distinct', () => {
    const upperIdentity = {
      repoId: 'test-org/vision-chat-model',
      hfRevision: 'main',
      ownerVariantId: 'Model.Q4_K_M.gguf',
      fileName: 'Projectors/MMProj.gguf',
    };
    const lowerIdentity = {
      repoId: 'test-org/vision-chat-model',
      hfRevision: 'main',
      ownerVariantId: 'model.q4_k_m.gguf',
      fileName: 'projectors/mmproj.gguf',
    };
    const upperPathId = buildProjectorArtifactId(upperIdentity);
    const lowerPathId = buildProjectorArtifactId(lowerIdentity);

    expect(upperPathId).not.toBe(lowerPathId);
    expect(upperPathId).toContain('-exact-path-');
    expect(buildLegacyProjectorArtifactId(upperIdentity)).toBe(lowerPathId);
    expect(buildLegacyProjectorArtifactId(upperIdentity))
      .toBe(buildLegacyProjectorArtifactId(lowerIdentity));
  });

  it('keeps punctuation-distinct projector basenames separate behind one lossy migration alias', () => {
    const identities = ['+', '-', ' ', ':'].map((separator) => ({
      repoId: 'test-org/vision-chat-model',
      hfRevision: 'main',
      fileName: `mmproj-model${separator}audio.gguf`,
    }));
    const currentIds = identities.map((identity) => buildProjectorArtifactId(identity));
    const legacyIds = identities.map((identity) => buildLegacyProjectorArtifactId(identity));

    expect(new Set(currentIds).size).toBe(identities.length);
    expect(new Set(legacyIds).size).toBe(1);
    expect(currentIds[1]).toBe(legacyIds[1]);
    expect(currentIds[0]).not.toBe(legacyIds[0]);
    expect(currentIds[2]).not.toBe(legacyIds[2]);
    expect(currentIds[3]).not.toBe(legacyIds[3]);
  });

  it('keeps punctuation-distinct owner variants separate behind one ambiguous legacy alias', () => {
    const identities = ['+', '-', ' ', ':'].map((separator) => ({
      repoId: 'test-org/vision-chat-model',
      hfRevision: 'main',
      ownerVariantId: `model${separator}audio.gguf`,
      fileName: 'mmproj-shared.gguf',
    }));
    const currentIds = identities.map((identity) => buildProjectorArtifactId(identity));
    const legacyIds = identities.map((identity) => buildLegacyProjectorArtifactId(identity));

    expect(new Set(currentIds).size).toBe(identities.length);
    expect(new Set(legacyIds).size).toBe(1);
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
