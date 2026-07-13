import {
  DECIMAL_GIGABYTE,
  UNKNOWN_PROJECTOR_MEMORY_FIT_FALLBACK_BYTES,
  formatModelFileSize,
  getModelDisplayArtifactSizeBytes,
  getModelDisplayProjectorCandidates,
  getModelStoredMemoryFitSizeBytes,
  getModelStoredArtifactsSizeBytes,
  getModelDisplaySelectedProjectorId,
  getProjectorMemoryFitSizeBytes,
  getProjectorArtifactsSizeBytes,
  getStoredProjectorMemoryFitSizeBytes,
  getStoredProjectorArtifactsSizeBytes,
  normalizePositiveByteSize,
} from '../../src/utils/modelSize';

describe('modelSize', () => {
  it('normalizes positive byte sizes and rejects invalid values', () => {
    expect(normalizePositiveByteSize(10.4)).toBe(10);
    expect(normalizePositiveByteSize(null)).toBeNull();
    expect(normalizePositiveByteSize(Number.NaN)).toBeNull();
    expect(normalizePositiveByteSize(0)).toBeNull();
    expect(normalizePositiveByteSize(-1)).toBeNull();
  });

  it('formats positive model file sizes as decimal GB with two decimals', () => {
    expect(formatModelFileSize(DECIMAL_GIGABYTE, 'Unknown')).toBe('1.00 GB');
    expect(formatModelFileSize(1.5 * DECIMAL_GIGABYTE, 'Unknown')).toBe('1.50 GB');
  });

  it('returns the unknown label for invalid values', () => {
    expect(formatModelFileSize(null, 'Unknown')).toBe('Unknown');
    expect(formatModelFileSize(undefined, 'Unknown')).toBe('Unknown');
    expect(formatModelFileSize(NaN, 'Unknown')).toBe('Unknown');
    expect(formatModelFileSize(0, 'Unknown')).toBe('Unknown');
    expect(formatModelFileSize(-10, 'Unknown')).toBe('Unknown');
  });

  it('sums projector artifact sizes only when storage should count them', () => {
    expect(getProjectorArtifactsSizeBytes([
      { size: 100.4 },
      { size: null },
      { size: 25 },
    ])).toBe(125);

    expect(getStoredProjectorArtifactsSizeBytes([
      { lifecycleStatus: 'downloaded', size: 100 },
      { lifecycleStatus: 'active', size: 50 },
      { lifecycleStatus: 'available', size: 999 },
      { lifecycleStatus: 'failed', size: 999 },
    ])).toBe(150);
  });

  it('uses a memory-only fallback for stored projectors with unknown size', () => {
    const projectorCandidates = [
      { id: 'known', lifecycleStatus: 'downloaded' as const, localPath: 'known.gguf', size: 100 },
      { id: 'unknown', lifecycleStatus: 'active' as const, localPath: 'unknown.gguf', size: null },
      { id: 'available', lifecycleStatus: 'available' as const, localPath: 'available.gguf', size: null },
    ];

    expect(getStoredProjectorArtifactsSizeBytes(projectorCandidates)).toBe(100);
    expect(getStoredProjectorMemoryFitSizeBytes(projectorCandidates)).toBe(
      100 + UNKNOWN_PROJECTOR_MEMORY_FIT_FALLBACK_BYTES,
    );
    expect(getModelStoredMemoryFitSizeBytes({
      size: 1_000,
      projectorCandidates: projectorCandidates.map((projector) => ({
        ...projector,
        ownerModelId: 'model-a',
        repoId: 'org/repo',
        fileName: projector.localPath,
        downloadUrl: `https://example.com/${projector.localPath}`,
        matchStatus: 'matched' as const,
      })),
    })).toBe(1_100 + UNKNOWN_PROJECTOR_MEMORY_FIT_FALLBACK_BYTES);
  });

  it('includes downloaded projector artifacts in stored model artifact totals', () => {
    expect(getModelStoredArtifactsSizeBytes({
      size: 1_000,
      projectorCandidates: [
        {
          id: 'projector-a',
          ownerModelId: 'model-a',
          repoId: 'org/repo',
          fileName: 'projector-a.gguf',
          downloadUrl: 'https://example.com/projector-a.gguf',
          size: 250,
          lifecycleStatus: 'downloaded',
          matchStatus: 'matched',
        },
        {
          id: 'projector-b',
          ownerModelId: 'model-a',
          repoId: 'org/repo',
          fileName: 'projector-b.gguf',
          downloadUrl: 'https://example.com/projector-b.gguf',
          size: 500,
          lifecycleStatus: 'available',
          matchStatus: 'matched',
        },
      ],
    })).toBe(1_250);
  });

  it('uses the selected or matched projector size for display and memory-fit totals', () => {
    const projectorCandidates = [
      {
        id: 'projector-a',
        ownerModelId: 'model-a',
        repoId: 'org/repo',
        fileName: 'projector-a.gguf',
        downloadUrl: 'https://example.com/projector-a.gguf',
        size: 250,
        lifecycleStatus: 'available' as const,
        matchStatus: 'matched' as const,
      },
      {
        id: 'projector-b',
        ownerModelId: 'model-a',
        repoId: 'org/repo',
        fileName: 'projector-b.gguf',
        downloadUrl: 'https://example.com/projector-b.gguf',
        size: 500,
        lifecycleStatus: 'available' as const,
        matchStatus: 'ambiguous' as const,
      },
    ];

    expect(getProjectorMemoryFitSizeBytes(projectorCandidates)).toBe(250);
    expect(getModelDisplayArtifactSizeBytes({
      size: 1_000,
      projectorCandidates,
    })).toBe(1_250);
    expect(getProjectorMemoryFitSizeBytes(projectorCandidates, 'projector-b')).toBe(500);
    expect(getModelDisplayArtifactSizeBytes({
      size: 1_000,
      projectorCandidates,
      selectedProjectorId: 'projector-b',
    })).toBe(1_500);
  });

  it('scopes display projector size to the active variant and ignores stale selections from another variant', () => {
    const model: Parameters<typeof getModelDisplayArtifactSizeBytes>[0] = {
      size: 1_000,
      activeVariantId: 'model.Q4_K_M.gguf',
      resolvedFileName: 'model.Q4_K_M.gguf',
      selectedProjectorId: 'projector-q8',
      variants: [
        {
          variantId: 'model.Q4_K_M.gguf',
          fileName: 'model.Q4_K_M.gguf',
          quantizationLabel: 'Q4_K_M',
          size: 1_000,
          selectedProjectorId: 'projector-q8',
        },
        {
          variantId: 'model.Q8_0.gguf',
          fileName: 'model.Q8_0.gguf',
          quantizationLabel: 'Q8_0',
          size: 2_000,
        },
      ],
      projectorCandidates: [
        {
          id: 'projector-q4',
          ownerModelId: 'model-a',
          ownerVariantId: 'model.Q4_K_M.gguf',
          repoId: 'org/repo',
          fileName: 'mmproj-q4.gguf',
          downloadUrl: 'https://example.com/mmproj-q4.gguf',
          size: 250,
          lifecycleStatus: 'available',
          matchStatus: 'matched',
        },
        {
          id: 'projector-q8',
          ownerModelId: 'model-a',
          ownerVariantId: 'model.Q8_0.gguf',
          repoId: 'org/repo',
          fileName: 'mmproj-q8.gguf',
          downloadUrl: 'https://example.com/mmproj-q8.gguf',
          size: 500,
          lifecycleStatus: 'available',
          matchStatus: 'user_selected',
        },
      ],
    };

    expect(getModelDisplaySelectedProjectorId(model)).toBeUndefined();
    expect(getModelDisplayArtifactSizeBytes(model)).toBe(1_250);
  });

  it('shows only the audio-compatible projector and size for an active audio-only variant', () => {
    const audioProjector = {
      id: 'projector-audio',
      ownerModelId: 'model-a',
      ownerVariantId: 'audio-q4',
      repoId: 'org/model-a',
      fileName: 'mmproj-audio.gguf',
      downloadUrl: 'https://example.com/mmproj-audio.gguf',
      hfRevision: 'main',
      size: 200,
      lifecycleStatus: 'available' as const,
      matchStatus: 'matched' as const,
    };
    const visionProjector = {
      ...audioProjector,
      id: 'projector-vision',
      fileName: 'mmproj-vision.gguf',
      downloadUrl: 'https://example.com/mmproj-vision.gguf',
      size: 500,
      matchStatus: 'user_selected' as const,
    };
    const model: Parameters<typeof getModelDisplayArtifactSizeBytes>[0] = {
      id: 'model-a',
      size: 1_000,
      activeVariantId: 'audio-q4',
      resolvedFileName: 'audio.Q4.gguf',
      selectedProjectorId: visionProjector.id,
      variants: [{
        variantId: 'audio-q4',
        fileName: 'audio.Q4.gguf',
        quantizationLabel: 'Q4_K_M',
        size: 1_000,
        chatModalities: ['text', 'audio'],
        projectorCandidates: [audioProjector, visionProjector],
      }],
      projectorCandidates: [audioProjector, visionProjector],
      artifacts: [
        {
          id: audioProjector.id,
          kind: 'multimodal_projector',
          requiredFor: ['audio'],
          hfRevision: 'main',
          remoteFileName: audioProjector.fileName,
          downloadUrl: audioProjector.downloadUrl,
          sizeBytes: audioProjector.size,
          installState: 'remote',
        },
        {
          id: visionProjector.id,
          kind: 'multimodal_projector',
          requiredFor: ['image'],
          hfRevision: 'main',
          remoteFileName: visionProjector.fileName,
          downloadUrl: visionProjector.downloadUrl,
          sizeBytes: visionProjector.size,
          installState: 'remote',
        },
      ],
    };

    expect(getModelDisplayProjectorCandidates(model)).toEqual([audioProjector]);
    expect(getModelDisplaySelectedProjectorId(model)).toBeUndefined();
    expect(getModelDisplayArtifactSizeBytes(model)).toBe(1_200);
  });

  it('resolves activeVariantId when it contains the active variant filename alias', () => {
    const projector = {
      id: 'projector-audio',
      ownerModelId: 'model-a',
      ownerVariantId: 'audio-q4',
      repoId: 'org/model-a',
      fileName: 'mmproj-audio.gguf',
      downloadUrl: 'https://example.com/mmproj-audio.gguf',
      size: 250,
      lifecycleStatus: 'available' as const,
      matchStatus: 'user_selected' as const,
    };
    const model: Parameters<typeof getModelDisplayArtifactSizeBytes>[0] = {
      id: 'model-a',
      size: 1_000,
      activeVariantId: 'audio.Q4.gguf',
      variants: [{
        variantId: 'audio-q4',
        fileName: 'audio.Q4.gguf',
        quantizationLabel: 'Q4_K_M',
        size: 1_000,
        selectedProjectorId: projector.id,
        projectorCandidates: [projector],
      }],
    };

    expect(getModelDisplayProjectorCandidates(model)).toEqual([projector]);
    expect(getModelDisplaySelectedProjectorId(model)).toBe(projector.id);
    expect(getModelDisplayArtifactSizeBytes(model)).toBe(1_250);
  });

  it('uses fresh resolved variant aliases instead of a stale active id for display size', () => {
    const staleProjector = {
      id: 'projector-q4',
      ownerModelId: 'model-a',
      ownerVariantId: 'stale-active',
      repoId: 'org/model-a',
      fileName: 'mmproj-q4.gguf',
      downloadUrl: 'https://example.com/mmproj-q4.gguf',
      size: 250,
      lifecycleStatus: 'available' as const,
      matchStatus: 'user_selected' as const,
    };
    const freshProjector = {
      ...staleProjector,
      id: 'projector-q8',
      ownerVariantId: 'q8',
      fileName: 'mmproj-q8.gguf',
      downloadUrl: 'https://example.com/mmproj-q8.gguf',
      size: 500,
    };
    const model: Parameters<typeof getModelDisplayArtifactSizeBytes>[0] = {
      id: 'model-a',
      size: 1_000,
      activeVariantId: 'stale-active',
      resolvedFileName: 'model.Q8.gguf',
      selectedProjectorId: staleProjector.id,
      variants: [
        {
          variantId: 'q4',
          fileName: 'model.Q4.gguf',
          quantizationLabel: 'Q4_K_M',
          size: 1_000,
        },
        {
          variantId: 'q8',
          fileName: 'model.Q8.gguf',
          quantizationLabel: 'Q8_0',
          size: 2_000,
          selectedProjectorId: freshProjector.id,
          projectorCandidates: [freshProjector],
        },
      ],
      projectorCandidates: [staleProjector, freshProjector],
    };

    expect(getModelDisplayProjectorCandidates(model)).toEqual([freshProjector]);
    expect(getModelDisplaySelectedProjectorId(model)).toBe(freshProjector.id);
    expect(getModelDisplayArtifactSizeBytes(model)).toBe(2_500);
  });

  it('enriches active variant projector candidates with matching top-level runtime state', () => {
    const model: Parameters<typeof getModelDisplayArtifactSizeBytes>[0] = {
      size: 1_000,
      activeVariantId: 'model.Q4_K_M.gguf',
      resolvedFileName: 'model.Q4_K_M.gguf',
      selectedProjectorId: 'runtime-projector-q4',
      variants: [
        {
          variantId: 'model.Q4_K_M.gguf',
          fileName: 'model.Q4_K_M.gguf',
          quantizationLabel: 'Q4_K_M',
          size: 1_000,
          projectorCandidates: [
            {
              id: 'variant-projector-q4',
              ownerModelId: 'model-a',
              ownerVariantId: 'model.Q4_K_M.gguf',
              repoId: 'org/repo',
              fileName: 'mmproj-q4.gguf',
              downloadUrl: 'https://example.com/mmproj-q4.gguf',
              size: 250,
              lifecycleStatus: 'available',
              matchStatus: 'matched',
            },
          ],
        },
      ],
      projectorCandidates: [
        {
          id: 'runtime-projector-q4',
          ownerModelId: 'model-a',
          repoId: 'org/repo',
          fileName: 'mmproj-q4.gguf',
          downloadUrl: 'https://example.com/mmproj-q4.gguf',
          size: 250,
          lifecycleStatus: 'downloaded',
          matchStatus: 'user_selected',
          matchReason: 'user_selected_projector',
          localPath: 'mmproj-q4.gguf',
          downloadProgress: 1,
        },
      ],
    };

    const displayProjectorCandidates = getModelDisplayProjectorCandidates(model);

    expect(displayProjectorCandidates).toEqual([
      expect.objectContaining({
        id: 'variant-projector-q4',
        lifecycleStatus: 'downloaded',
        localPath: 'mmproj-q4.gguf',
        matchStatus: 'user_selected',
      }),
    ]);
    expect(getModelDisplaySelectedProjectorId(model)).toBe('variant-projector-q4');
    expect(getModelDisplaySelectedProjectorId(model, displayProjectorCandidates)).toBe('variant-projector-q4');
    expect(getModelDisplayArtifactSizeBytes(model)).toBe(1_250);
  });

  it('keeps a compatible selected model-wide projector beside active-variant candidates', () => {
    const variantProjector = {
      id: 'variant-projector-q4',
      ownerModelId: 'model-a',
      ownerVariantId: 'q4',
      repoId: 'org/model-a',
      fileName: 'mmproj-variant-q4.gguf',
      downloadUrl: 'https://example.com/mmproj-variant-q4.gguf',
      size: 250,
      lifecycleStatus: 'available' as const,
      matchStatus: 'matched' as const,
    };
    const modelWideProjector = {
      id: 'model-wide-projector',
      ownerModelId: 'model-a',
      repoId: 'org/model-a',
      fileName: 'mmproj-model-wide.gguf',
      downloadUrl: 'https://example.com/mmproj-model-wide.gguf',
      size: 500,
      lifecycleStatus: 'downloaded' as const,
      matchStatus: 'user_selected' as const,
      localPath: 'mmproj-model-wide.gguf',
    };
    const model: Parameters<typeof getModelDisplayArtifactSizeBytes>[0] = {
      id: 'model-a',
      size: 1_000,
      activeVariantId: 'q4',
      resolvedFileName: 'model.Q4_K_M.gguf',
      selectedProjectorId: modelWideProjector.id,
      variants: [{
        variantId: 'q4',
        fileName: 'model.Q4_K_M.gguf',
        quantizationLabel: 'Q4_K_M',
        size: 1_000,
        chatModalities: ['text', 'vision'],
        projectorCandidates: [variantProjector],
      }],
      projectorCandidates: [modelWideProjector],
      artifacts: [{
        id: modelWideProjector.id,
        kind: 'multimodal_projector',
        requiredFor: ['image'],
        remoteFileName: modelWideProjector.fileName,
        downloadUrl: modelWideProjector.downloadUrl,
        sizeBytes: modelWideProjector.size,
        installState: 'installed',
        localPath: modelWideProjector.localPath,
      }],
    };

    expect(getModelDisplayProjectorCandidates(model)).toEqual([
      variantProjector,
      modelWideProjector,
    ]);
    expect(getModelDisplaySelectedProjectorId(model)).toBe(modelWideProjector.id);
    expect(getModelDisplayArtifactSizeBytes(model)).toBe(1_500);
  });

  it('enriches projector runtime state across active variant id and filename aliases', () => {
    const model: Parameters<typeof getModelDisplayArtifactSizeBytes>[0] = {
      size: 1_000,
      activeVariantId: 'q4',
      resolvedFileName: 'model.Q4_K_M.gguf',
      selectedProjectorId: 'runtime-projector-q4',
      variants: [{
        variantId: 'q4',
        fileName: 'model.Q4_K_M.gguf',
        quantizationLabel: 'Q4_K_M',
        size: 1_000,
        projectorCandidates: [{
          id: 'variant-projector-q4',
          ownerModelId: 'model-a',
          ownerVariantId: 'q4',
          repoId: 'org/repo',
          fileName: 'mmproj-q4.gguf',
          downloadUrl: 'https://example.com/mmproj-q4.gguf',
          size: 250,
          lifecycleStatus: 'available',
          matchStatus: 'matched',
        }],
      }],
      projectorCandidates: [{
        id: 'runtime-projector-q4',
        ownerModelId: 'model-a',
        ownerVariantId: 'model.Q4_K_M.gguf',
        repoId: 'org/repo',
        fileName: 'mmproj-q4.gguf',
        downloadUrl: 'https://example.com/mmproj-q4.gguf',
        size: 250,
        lifecycleStatus: 'downloaded',
        matchStatus: 'user_selected',
        matchReason: 'user_selected_projector',
        localPath: 'mmproj-q4.gguf',
        downloadProgress: 1,
      }],
    };

    expect(getModelDisplayProjectorCandidates(model)).toEqual([
      expect.objectContaining({
        id: 'variant-projector-q4',
        lifecycleStatus: 'downloaded',
        localPath: 'mmproj-q4.gguf',
      }),
    ]);
    expect(getModelDisplaySelectedProjectorId(model)).toBe('variant-projector-q4');
    expect(getModelDisplayArtifactSizeBytes(model)).toBe(1_250);
  });

  it('uses a conservative memory-only fallback for resolvable projectors with unknown size', () => {
    const projectorCandidates = [
      {
        id: 'projector-a',
        ownerModelId: 'model-a',
        repoId: 'org/repo',
        fileName: 'projector-a.gguf',
        downloadUrl: 'https://example.com/projector-a.gguf',
        size: null,
        lifecycleStatus: 'downloaded' as const,
        matchStatus: 'matched' as const,
        localPath: 'projector-a.gguf',
      },
    ];

    expect(getProjectorMemoryFitSizeBytes(projectorCandidates)).toBe(UNKNOWN_PROJECTOR_MEMORY_FIT_FALLBACK_BYTES);
    expect(getModelDisplayArtifactSizeBytes({
      size: 1_000,
      projectorCandidates,
    })).toBe(1_000);
  });
});

