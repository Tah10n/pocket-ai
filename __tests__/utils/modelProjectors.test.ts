import type { ModelArtifactMetadata } from '../../src/types/models';
import type { ProjectorArtifact } from '../../src/types/multimodal';
import { buildHuggingFaceResolveUrl } from '../../src/utils/huggingFaceUrls';
import {
  buildLegacyProjectorArtifactId,
  buildProjectorArtifactId,
  isProjectorFileName,
  resolveDeterministicProjectorCandidate,
  resolveModelArtifactRole,
} from '../../src/utils/modelProjectors';
import { canonicalizeProjectorCandidateAliases } from '../../src/utils/projectorIdentity';
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

function createExactProjector(
  identity: {
    repoId: string;
    hfRevision?: string;
    fileName: string;
    ownerVariantId?: string;
  },
  overrides: Partial<ProjectorArtifact> = {},
): ProjectorArtifact {
  const ownerModelId = overrides.ownerModelId ?? identity.repoId;
  return {
    id: buildProjectorArtifactId(identity),
    ownerModelId,
    ...(identity.ownerVariantId ? { ownerVariantId: identity.ownerVariantId } : {}),
    repoId: identity.repoId,
    hfRevision: identity.hfRevision ?? 'main',
    fileName: identity.fileName,
    downloadUrl: buildHuggingFaceResolveUrl(
      identity.repoId,
      identity.fileName,
      identity.hfRevision,
    ),
    size: 1_000,
    lifecycleStatus: 'available',
    matchStatus: 'matched',
    ...overrides,
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

  it.each(['current-first', 'legacy-first'] as const)(
    'canonicalizes current and legacy aliases for one exact projector independent of order (%s)',
    (order) => {
      const identity = {
        repoId: 'test-org/alias-model',
        hfRevision: 'main',
        fileName: 'Projectors/MMProj+Audio.gguf',
      };
      const currentId = buildProjectorArtifactId(identity);
      const legacyId = buildLegacyProjectorArtifactId(identity);
      const current = createExactProjector(identity, { id: currentId });
      const legacy = createExactProjector(identity, { id: legacyId });
      const result = canonicalizeProjectorCandidateAliases(
        order === 'current-first' ? [current, legacy] : [legacy, current],
      );

      expect(currentId).not.toBe(legacyId);
      expect(result.candidates).toEqual([expect.objectContaining({ id: currentId })]);
      expect(result.aliasToCanonicalId.get(legacyId)).toBe(currentId);
      expect(result.blockedScopeKeys.size).toBe(0);
    },
  );

  it('migrates a legacy-only exact projector while preserving downloaded runtime state', () => {
    const identity = {
      repoId: 'test-org/legacy-only-model',
      hfRevision: 'refs/pr/7',
      fileName: 'Projectors/MMProj+Audio.gguf',
    };
    const legacyId = buildLegacyProjectorArtifactId(identity);
    const currentId = buildProjectorArtifactId(identity);
    const result = canonicalizeProjectorCandidateAliases([
      createExactProjector(identity, {
        id: legacyId,
        lifecycleStatus: 'downloaded',
        localPath: 'legacy-mmproj.gguf',
        matchStatus: 'user_selected',
        matchReason: 'user_selected_projector',
      }),
    ]);

    expect(result.candidates).toEqual([
      expect.objectContaining({
        id: currentId,
        lifecycleStatus: 'downloaded',
        localPath: 'legacy-mmproj.gguf',
        matchStatus: 'user_selected',
      }),
    ]);
    expect(result.aliasToCanonicalId.get(legacyId)).toBe(currentId);
  });

  it.each(['sha256', 'size'] as const)(
    'blocks an exact projector scope when aliases conflict on %s',
    (field) => {
      const identity = {
        repoId: 'test-org/conflicting-alias-model',
        hfRevision: 'main',
        fileName: 'Projectors/MMProj+Audio.gguf',
      };
      const current = createExactProjector(identity, {
        id: buildProjectorArtifactId(identity),
        ...(field === 'sha256' ? { sha256: 'a'.repeat(64) } : { size: 1_000 }),
      });
      const legacy = createExactProjector(identity, {
        id: buildLegacyProjectorArtifactId(identity),
        ...(field === 'sha256' ? { sha256: 'b'.repeat(64) } : { size: 2_000 }),
      });
      const result = canonicalizeProjectorCandidateAliases([current, legacy]);

      expect(result.candidates).toEqual([]);
      expect(result.blockedScopeKeys.size).toBe(1);
    },
  );

  it('blocks aliases whose exact artifacts have conflicting modality requirements', () => {
    const identity = {
      repoId: 'test-org/artifact-conflict-model',
      hfRevision: 'main',
      fileName: 'Projectors/MMProj+Audio.gguf',
    };
    const current = createExactProjector(identity);
    const legacyId = buildLegacyProjectorArtifactId(identity);
    const makeArtifact = (
      id: string,
      requiredFor: ModelArtifactMetadata['requiredFor'],
    ): ModelArtifactMetadata => ({
      id,
      kind: 'multimodal_projector',
      requiredFor,
      hfRevision: identity.hfRevision,
      remoteFileName: identity.fileName,
      downloadUrl: current.downloadUrl,
      sizeBytes: current.size,
      installState: 'remote',
    });
    const result = canonicalizeProjectorCandidateAliases(
      [current, { ...current, id: legacyId }],
      [
        makeArtifact(current.id, ['image']),
        makeArtifact(legacyId, ['audio']),
      ],
    );

    expect(result.candidates).toEqual([]);
    expect(result.artifacts).toEqual([]);
  });

  it.each(['current-first', 'legacy-first', 'mixed-first'] as const)(
    'uses an explicit mixed artifact to resolve compatible alias requirements independent of order (%s)',
    (order) => {
      const identity = {
        repoId: 'test-org/explicit-mixed-artifact-model',
        hfRevision: 'main',
        fileName: 'Projectors/MMProj+Audio.gguf',
      };
      const current = createExactProjector(identity);
      const legacyId = buildLegacyProjectorArtifactId(identity);
      const makeArtifact = (
        id: string,
        requiredFor: ModelArtifactMetadata['requiredFor'],
      ): ModelArtifactMetadata => ({
        id,
        kind: 'multimodal_projector',
        requiredFor,
        hfRevision: identity.hfRevision,
        remoteFileName: identity.fileName,
        downloadUrl: current.downloadUrl,
        sizeBytes: current.size,
        installState: 'remote',
      });
      const currentArtifact = makeArtifact(current.id, ['image']);
      const legacyArtifact = makeArtifact(legacyId, ['audio']);
      const mixedArtifact = makeArtifact(current.id, ['audio', 'image']);
      const artifacts = order === 'current-first'
        ? [currentArtifact, legacyArtifact, mixedArtifact]
        : order === 'legacy-first'
          ? [legacyArtifact, mixedArtifact, currentArtifact]
          : [mixedArtifact, currentArtifact, legacyArtifact];

      const result = canonicalizeProjectorCandidateAliases(
        [current, { ...current, id: legacyId }],
        artifacts,
      );

      expect(result.candidates).toEqual([expect.objectContaining({ id: current.id })]);
      expect(result.artifacts).toEqual([
        expect.objectContaining({
          id: current.id,
          requiredFor: ['audio', 'image'],
        }),
      ]);
    },
  );

  it('blocks a shared raw id used by different exact paths', () => {
    const first = createExactProjector({
      repoId: 'test-org/shared-id-model',
      fileName: 'first/mmproj.gguf',
    }, { id: 'shared-projector-id' });
    const second = createExactProjector({
      repoId: 'test-org/shared-id-model',
      fileName: 'second/mmproj.gguf',
    }, { id: 'shared-projector-id' });

    expect(canonicalizeProjectorCandidateAliases([first, second]).candidates).toEqual([]);
    expect(canonicalizeProjectorCandidateAliases([second, first]).candidates).toEqual([]);
  });

  it('keeps case-distinct exact paths as separate physical scopes', () => {
    const upper = createExactProjector({
      repoId: 'test-org/case-model',
      fileName: 'Projectors/MMProj.GGUF',
    });
    const lower = createExactProjector({
      repoId: 'test-org/case-model',
      fileName: 'projectors/mmproj.gguf',
    });

    const result = canonicalizeProjectorCandidateAliases([lower, upper]);
    expect(result.candidates.map((candidate) => candidate.id)).toEqual(
      [upper.id, lower.id].sort(),
    );
  });

  it('keeps model-wide and variant-owned projectors in separate exact scopes', () => {
    const identity = {
      repoId: 'test-org/variant-scope-model',
      fileName: 'mmproj.gguf',
    };
    const modelWide = createExactProjector(identity);
    const variantOwned = createExactProjector({
      ...identity,
      ownerVariantId: 'model.Q4_K_M.gguf',
    });

    expect(canonicalizeProjectorCandidateAliases([modelWide, variantOwned]).candidates).toHaveLength(2);
  });

  it('accepts an opaque local owner model id while keeping the repo identity exact', () => {
    const projector = createExactProjector({
      repoId: 'test-org/local-owner-model',
      hfRevision: 'refs/pr/11',
      fileName: 'Projectors/MMProj-Local.GGUF',
    }, {
      ownerModelId: 'local-model-a',
    });

    expect(canonicalizeProjectorCandidateAliases([projector]).candidates).toEqual([
      expect.objectContaining({
        ownerModelId: 'local-model-a',
        repoId: 'test-org/local-owner-model',
        hfRevision: 'refs/pr/11',
        fileName: 'Projectors/MMProj-Local.GGUF',
      }),
    ]);
  });
});
