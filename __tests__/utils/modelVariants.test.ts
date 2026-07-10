import {
  applyDefaultCatalogModelVariantSelection,
  applyModelVariantSelection,
  applyModelVariantSelectionIfAvailable,
  canSelectModelVariant,
  getActiveModelVariant,
  getDefaultCatalogModelVariant,
} from '../../src/utils/modelVariants';
import { dedupeModelVariantsByIdentity } from '../../src/utils/modelVariantIdentity';
import { LifecycleStatus, ModelAccessState, type ModelMetadata } from '../../src/types/models';
import { resolveEffectiveActiveVariantNativeSupport } from '../../src/utils/modelCapabilities';

function createModel(overrides: Partial<ModelMetadata> = {}): ModelMetadata {
  return {
    id: 'org/model',
    name: 'Model',
    author: 'org',
    size: 4_000_000_000,
    downloadUrl: 'https://huggingface.co/org/model/resolve/main/model.Q4_K_M.gguf',
    resolvedFileName: 'model.Q4_K_M.gguf',
    activeVariantId: 'model.Q4_K_M.gguf',
    fitsInRam: true,
    memoryFitDecision: 'fits_low_confidence',
    memoryFitConfidence: 'medium',
    metadataTrust: 'trusted_remote',
    gguf: {
      sizeLabel: 'Q4_K_M',
      totalBytes: 4_000_000_000,
    },
    accessState: ModelAccessState.PUBLIC,
    isGated: false,
    isPrivate: false,
    lifecycleStatus: LifecycleStatus.AVAILABLE,
    downloadProgress: 0,
    variants: [
      {
        variantId: 'model.Q4_K_M.gguf',
        fileName: 'model.Q4_K_M.gguf',
        quantizationLabel: 'Q4_K_M',
        size: 4_000_000_000,
        sha256: 'a'.repeat(64),
      },
      {
        variantId: 'model.Q8_0.gguf',
        fileName: 'model.Q8_0.gguf',
        quantizationLabel: 'Q8_0',
        size: 8_000_000_000,
        sha256: 'b'.repeat(64),
        ramFit: 'likely_oom',
        ramFitConfidence: 'medium',
      },
    ],
    ...overrides,
  };
}

describe('modelVariants', () => {
  it('resolves the active variant from explicit selection or current file', () => {
    const model = createModel({ activeVariantId: undefined });

    expect(getActiveModelVariant(model)?.variantId).toBe('model.Q4_K_M.gguf');
  });

  it('resolves either active identity alias without falling back to the first stale variant', () => {
    const model = createModel({
      activeVariantId: 'model.Q8_0.gguf',
      resolvedFileName: 'stale.gguf',
      variants: [
        { ...createModel().variants![0], variantId: 'q4' },
        { ...createModel().variants![1], variantId: 'q8' },
      ],
    });

    expect(getActiveModelVariant(model)?.variantId).toBe('q8');
    expect(getActiveModelVariant({
      ...model,
      activeVariantId: 'missing-variant',
      resolvedFileName: 'model.Q8_0.gguf',
    })?.variantId).toBe('q8');
    expect(getActiveModelVariant({
      ...model,
      activeVariantId: 'missing-variant',
      resolvedFileName: 'missing-file.gguf',
    })).toBeUndefined();
  });

  it('selects an exact variant id before an earlier filename alias collision', () => {
    const selected = applyModelVariantSelectionIfAvailable(
      createModel({
        variants: [
          {
            variantId: 'legacy-audio',
            fileName: 'audio-q4.gguf',
            quantizationLabel: 'Q4_K_M',
            size: 1,
            chatModalities: ['text', 'vision'],
          },
          {
            variantId: 'audio-q4.gguf',
            fileName: 'audio-main.gguf',
            quantizationLabel: 'Q4_K_M',
            size: 2,
            chatModalities: ['text', 'audio'],
          },
        ],
      }),
      {
        activeVariantId: 'audio-q4.gguf',
        downloadedAt: 1,
      },
    );

    expect(selected.activeVariantId).toBe('audio-q4.gguf');
    expect(selected.resolvedFileName).toBe('audio-main.gguf');
  });

  it('selects an exact resolved filename before an earlier variant-id alias collision', () => {
    const selected = applyModelVariantSelectionIfAvailable(
      createModel({
        variants: [
          {
            variantId: 'audio-q4.gguf',
            fileName: 'audio-main.gguf',
            quantizationLabel: 'Q4_K_M',
            size: 2,
            chatModalities: ['text', 'audio'],
          },
          {
            variantId: 'legacy-audio',
            fileName: 'audio-q4.gguf',
            quantizationLabel: 'Q4_K_M',
            size: 1,
            chatModalities: ['text', 'vision'],
          },
        ],
      }),
      {
        resolvedFileName: 'audio-q4.gguf',
        size: 1,
        downloadedAt: 1,
      },
    );

    expect(selected.activeVariantId).toBe('legacy-audio');
    expect(selected.resolvedFileName).toBe('audio-q4.gguf');
  });

  it('defaults catalog selection to Q4_K_M when another variant is currently active', () => {
    const model = createModel({
      size: 8_000_000_000,
      downloadUrl: 'https://huggingface.co/org/model/resolve/main/model.Q8_0.gguf',
      resolvedFileName: 'model.Q8_0.gguf',
      activeVariantId: 'model.Q8_0.gguf',
      fitsInRam: false,
      memoryFitDecision: 'likely_oom',
      gguf: {
        sizeLabel: 'Q8_0',
        totalBytes: 8_000_000_000,
      },
      variants: [
        createModel().variants![1],
        {
          ...createModel().variants![0],
          ramFit: 'fits_low_confidence',
          ramFitConfidence: 'medium',
        },
      ],
    });

    expect(getDefaultCatalogModelVariant(model)?.variantId).toBe('model.Q4_K_M.gguf');

    const selected = applyDefaultCatalogModelVariantSelection(model);

    expect(selected).toEqual(expect.objectContaining({
      size: 4_000_000_000,
      resolvedFileName: 'model.Q4_K_M.gguf',
      activeVariantId: 'model.Q4_K_M.gguf',
      downloadUrl: 'https://huggingface.co/org/model/resolve/main/model.Q4_K_M.gguf',
      fitsInRam: true,
      memoryFitDecision: 'fits_low_confidence',
    }));
  });

  it('limits variant selection to available remote models', () => {
    expect(canSelectModelVariant(createModel())).toBe(true);
    expect(canSelectModelVariant(createModel({ lifecycleStatus: LifecycleStatus.FAILED }))).toBe(false);
    expect(canSelectModelVariant(createModel({ lifecycleStatus: LifecycleStatus.PAUSED }))).toBe(false);
    expect(canSelectModelVariant(createModel({ lifecycleStatus: LifecycleStatus.DOWNLOADED }))).toBe(false);
    expect(canSelectModelVariant(createModel({ variants: [createModel().variants![0]] }))).toBe(false);
  });

  it('applies the selected variant to download identity and clears stale runtime state', () => {
    const selected = applyModelVariantSelection(
      createModel({
        lifecycleStatus: LifecycleStatus.FAILED,
        downloadProgress: 0.5,
        resumeData: 'stale-resume',
        downloadErrorCode: 'download_http_error',
        gguf: {
          sizeLabel: 'Q4_K_M',
          totalBytes: 4_000_000_000,
          contextLengthTokens: 4096,
          architecture: 'llama',
        },
        maxContextTokens: 4096,
        hasVerifiedContextWindow: true,
        capabilitySnapshot: {
          heuristicVersion: 1,
          modelLayerCount: null,
          gpuLayersCeiling: 0,
          metadataTrust: 'trusted_remote',
          sizeBytes: 4_000_000_000,
        },
        multimodalReadiness: {
          modelId: 'org/model',
          variantId: 'model.Q4_K_M.gguf',
          status: 'ready',
          projectorId: 'projector-1',
          support: ['vision'],
          checkedAt: 1,
        },
        selectedProjectorId: 'projector-q4',
        projectorCandidates: [
          {
            id: 'projector-q4',
            ownerModelId: 'org/model',
            repoId: 'org/model',
            fileName: 'mmproj-q4.gguf',
            downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-q4.gguf',
            size: 1000,
            lifecycleStatus: 'downloaded',
            matchStatus: 'user_selected',
            matchReason: 'user_selected_projector',
          },
          {
            id: 'projector-q8',
            ownerModelId: 'org/model',
            repoId: 'org/model',
            fileName: 'mmproj-q8.gguf',
            downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-q8.gguf',
            size: 1000,
            lifecycleStatus: 'available',
            matchStatus: 'ambiguous',
          },
        ],
      }),
      'model.Q8_0.gguf',
    );

    expect(selected).toEqual(expect.objectContaining({
      size: 8_000_000_000,
      resolvedFileName: 'model.Q8_0.gguf',
      activeVariantId: 'model.Q8_0.gguf',
      downloadUrl: 'https://huggingface.co/org/model/resolve/main/model.Q8_0.gguf',
      sha256: 'b'.repeat(64),
      metadataTrust: 'trusted_remote',
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      resumeData: undefined,
      downloadErrorCode: undefined,
      fitsInRam: false,
      memoryFitDecision: 'likely_oom',
      memoryFitConfidence: 'medium',
      maxContextTokens: undefined,
      hasVerifiedContextWindow: false,
      capabilitySnapshot: undefined,
    }));
    expect(selected.multimodalReadiness).toBeUndefined();
    expect(selected.selectedProjectorId).toBeUndefined();
    expect(selected.projectorCandidates).toEqual([
      expect.objectContaining({
        id: 'projector-q4',
        matchStatus: 'ambiguous',
        matchReason: 'variant_selection_changed',
      }),
      expect.objectContaining({
        id: 'projector-q8',
        matchStatus: 'ambiguous',
      }),
    ]);
    expect(selected.gguf).toEqual(expect.objectContaining({
      sizeLabel: 'Q8_0',
      totalBytes: 8_000_000_000,
    }));
    expect(selected.gguf).not.toHaveProperty('contextLengthTokens');
    expect(selected.gguf).not.toHaveProperty('architecture');
  });

  it('preserves memory fit metadata when reselecting the active file', () => {
    const selected = applyModelVariantSelection(createModel(), 'model.Q4_K_M.gguf');

    expect(selected).toEqual(expect.objectContaining({
      resolvedFileName: 'model.Q4_K_M.gguf',
      activeVariantId: 'model.Q4_K_M.gguf',
      fitsInRam: true,
      memoryFitDecision: 'fits_low_confidence',
      memoryFitConfidence: 'medium',
    }));
  });

  it('preserves same-file trusted metadata when the variant entry is incomplete', () => {
    const selected = applyModelVariantSelection(
      createModel({
        size: 4_000_000_000,
        sha256: 'a'.repeat(64),
        metadataTrust: 'verified_local',
        downloadIntegrity: {
          kind: 'sha256',
          sizeBytes: 4_000_000_000,
          checkedAt: 123,
          sha256: 'a'.repeat(64),
        },
        lifecycleStatus: LifecycleStatus.DOWNLOADED,
        localPath: 'model.Q4_K_M.gguf',
        variants: [
          {
            variantId: 'model.Q4_K_M.gguf',
            fileName: 'model.Q4_K_M.gguf',
            quantizationLabel: 'Q4_K_M',
            size: null,
          },
          createModel().variants![1],
        ],
      }),
      'model.Q4_K_M.gguf',
    );

    expect(selected).toEqual(expect.objectContaining({
      size: 4_000_000_000,
      sha256: 'a'.repeat(64),
      metadataTrust: 'verified_local',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      localPath: 'model.Q4_K_M.gguf',
      fitsInRam: true,
      memoryFitDecision: 'fits_low_confidence',
      memoryFitConfidence: 'medium',
    }));
    expect(selected.gguf).toEqual(expect.objectContaining({
      sizeLabel: 'Q4_K_M',
      totalBytes: 4_000_000_000,
    }));
    expect(selected.downloadIntegrity).toEqual(expect.objectContaining({
      kind: 'sha256',
      sha256: 'a'.repeat(64),
    }));
  });

  it('falls back to a selected local file when remote variants are incomplete', () => {
    const selected = applyModelVariantSelectionIfAvailable(
      createModel({
        variants: [createModel().variants![0]],
        gguf: {
          sizeLabel: 'Q4_K_M',
          totalBytes: 4_000_000_000,
          contextLengthTokens: 4096,
          architecture: 'llama',
        },
        maxContextTokens: 4096,
        hasVerifiedContextWindow: true,
        capabilitySnapshot: {
          heuristicVersion: 1,
          modelLayerCount: null,
          gpuLayersCeiling: 0,
          metadataTrust: 'trusted_remote',
          sizeBytes: 4_000_000_000,
        },
      }),
      {
        resolvedFileName: 'model.Q8_0.gguf',
        activeVariantId: 'model.Q8_0.gguf',
        size: 8_000_000_000,
        sha256: 'b'.repeat(64),
        metadataTrust: 'verified_local',
        gguf: {
          sizeLabel: 'Q8_0',
          totalBytes: 8_000_000_000,
        },
      },
    );

    expect(selected).toEqual(expect.objectContaining({
      resolvedFileName: 'model.Q8_0.gguf',
      activeVariantId: 'model.Q8_0.gguf',
      size: 8_000_000_000,
      sha256: 'b'.repeat(64),
      maxContextTokens: undefined,
      hasVerifiedContextWindow: false,
      capabilitySnapshot: undefined,
    }));
    expect(selected.variants?.some((variant) => variant.fileName === 'model.Q8_0.gguf')).toBe(true);
  });

  it('uses the resolved catalog variant when a stale explicit active variant conflicts with it', () => {
    const selected = applyModelVariantSelectionIfAvailable(
      createModel(),
      {
        activeVariantId: 'model.Q8_0.gguf',
        resolvedFileName: 'model.Q4_K_M.gguf',
        size: 4_000_000_000,
        sha256: 'a'.repeat(64),
        metadataTrust: 'verified_local',
        gguf: {
          sizeLabel: 'Q4_K_M',
          totalBytes: 4_000_000_000,
        },
        downloadIntegrity: {
          kind: 'sha256',
          sizeBytes: 4_000_000_000,
          checkedAt: 123,
          sha256: 'a'.repeat(64),
        },
        downloadedAt: 123,
        lifecycleStatus: LifecycleStatus.DOWNLOADED,
      },
    );

    expect(selected).toEqual(expect.objectContaining({
      resolvedFileName: 'model.Q4_K_M.gguf',
      activeVariantId: 'model.Q4_K_M.gguf',
      size: 4_000_000_000,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
    }));
    expect(selected.sha256).toBe('a'.repeat(64));
    expect(selected.metadataTrust).toBe('trusted_remote');
    expect(selected.downloadIntegrity).toBeUndefined();
    expect(selected.variants?.some((variant) => variant.fileName === 'model.Q8_0.gguf')).toBe(true);
  });

  it('uses resolved filename variant matching before a stale gguf active variant fallback', () => {
    const selected = applyModelVariantSelectionIfAvailable(
      createModel(),
      {
        activeVariantId: 'old-or-missing.gguf',
        resolvedFileName: 'model.Q8_0.gguf',
        size: 8_000_000_000,
        sha256: 'b'.repeat(64),
        metadataTrust: 'verified_local',
        downloadedAt: 123,
      },
    );

    expect(selected).toEqual(expect.objectContaining({
      resolvedFileName: 'model.Q8_0.gguf',
      activeVariantId: 'model.Q8_0.gguf',
      downloadUrl: 'https://huggingface.co/org/model/resolve/main/model.Q8_0.gguf',
      size: 8_000_000_000,
      sha256: 'b'.repeat(64),
    }));
  });

  it('does not fall back to a stale explicit active variant when the durable resolved file is missing from refreshed variants', () => {
    const selected = applyModelVariantSelectionIfAvailable(
      createModel(),
      {
        activeVariantId: 'model.Q8_0.gguf',
        resolvedFileName: 'model.Q6_K.gguf',
        size: 6_000_000_000,
        sha256: 'c'.repeat(64),
        metadataTrust: 'verified_local',
        downloadedAt: 123,
        gguf: {
          sizeLabel: 'Q6_K',
          totalBytes: 6_000_000_000,
        },
      },
    );

    expect(selected).toEqual(expect.objectContaining({
      resolvedFileName: 'model.Q6_K.gguf',
      activeVariantId: 'model.Q6_K.gguf',
      downloadUrl: 'https://huggingface.co/org/model/resolve/main/model.Q6_K.gguf',
      size: 6_000_000_000,
      sha256: 'c'.repeat(64),
    }));
    expect(selected.variants?.find((variant) => variant.fileName === 'model.Q6_K.gguf')).toEqual(expect.objectContaining({
      variantId: 'model.Q6_K.gguf',
      quantizationLabel: 'Q6_K',
      size: 6_000_000_000,
    }));
  });

  it('preserves explicit active file metadata when older records have no resolved filename', () => {
    const selected = applyModelVariantSelectionIfAvailable(
      createModel({
        variants: [createModel().variants![0]],
      }),
      {
        activeVariantId: 'model.Q8_0.gguf',
        size: 8_000_000_000,
        sha256: 'b'.repeat(64),
        metadataTrust: 'trusted_remote',
        fitsInRam: false,
        memoryFitDecision: 'likely_oom',
        memoryFitConfidence: 'medium',
        downloadedAt: 123,
        gguf: {
          sizeLabel: 'Q8_0',
          totalBytes: 8_000_000_000,
        },
      },
    );

    expect(selected).toEqual(expect.objectContaining({
      resolvedFileName: 'model.Q8_0.gguf',
      activeVariantId: 'model.Q8_0.gguf',
      size: 8_000_000_000,
      sha256: 'b'.repeat(64),
      metadataTrust: 'trusted_remote',
      fitsInRam: false,
      memoryFitDecision: 'likely_oom',
      memoryFitConfidence: 'medium',
      gguf: expect.objectContaining({
        sizeLabel: 'Q8_0',
        totalBytes: 8_000_000_000,
      }),
    }));
  });

  it('does not synthesize a stale active variant fallback without durable local evidence', () => {
    const model = createModel({
      variants: [createModel().variants![0]],
    });

    const selected = applyModelVariantSelectionIfAvailable(
      model,
      {
        activeVariantId: 'missing.Q8_0.gguf',
        size: 8_000_000_000,
        sha256: 'b'.repeat(64),
        metadataTrust: 'trusted_remote',
      },
    );

    expect(selected).toBe(model);
    expect(selected.variants?.some((variant) => variant.fileName === 'missing.Q8_0.gguf')).toBe(false);
  });

  it('uses durable resolved filename fallback for older selected local variants when the catalog default is non-preferred', () => {
    const selected = applyModelVariantSelectionIfAvailable(
      createModel({
        size: 5_000_000_000,
        resolvedFileName: 'model.Q5_K_M.gguf',
        activeVariantId: 'model.Q5_K_M.gguf',
        variants: [
          {
            variantId: 'model.Q5_K_M.gguf',
            fileName: 'model.Q5_K_M.gguf',
            quantizationLabel: 'Q5_K_M',
            size: 5_000_000_000,
          },
        ],
      }),
      {
        resolvedFileName: 'model.Q8_0.gguf',
        size: 8_000_000_000,
        sha256: 'b'.repeat(64),
        metadataTrust: 'verified_local',
        downloadedAt: 123,
      },
    );

    expect(selected).toEqual(expect.objectContaining({
      resolvedFileName: 'model.Q8_0.gguf',
      activeVariantId: 'model.Q8_0.gguf',
      size: 8_000_000_000,
      sha256: 'b'.repeat(64),
    }));
  });

  it('does not match resolved filename variants when resolved fallback and variant matching are disabled', () => {
    const selected = applyModelVariantSelectionIfAvailable(
      createModel({
        size: 5_000_000_000,
        resolvedFileName: 'model.Q5_K_M.gguf',
        activeVariantId: 'model.Q5_K_M.gguf',
        variants: [
          {
            variantId: 'model.Q5_K_M.gguf',
            fileName: 'model.Q5_K_M.gguf',
            quantizationLabel: 'Q5_K_M',
            size: 5_000_000_000,
          },
          {
            variantId: 'model.Q8_0.gguf',
            fileName: 'model.Q8_0.gguf',
            quantizationLabel: 'Q8_0',
            size: 8_000_000_000,
          },
        ],
      }),
      {
        resolvedFileName: 'model.Q8_0.gguf',
        size: 8_000_000_000,
        metadataTrust: 'verified_local',
        downloadedAt: 123,
      },
      { allowResolvedFileNameFallback: false, allowResolvedFileNameVariantMatch: false },
    );

    expect(selected).toEqual(expect.objectContaining({
      resolvedFileName: 'model.Q5_K_M.gguf',
      activeVariantId: 'model.Q5_K_M.gguf',
      size: 5_000_000_000,
    }));
  });

  it('ignores unsupported projector/MTP variant selections and stale active fallbacks', () => {
    const model = createModel({
      variants: [
        createModel().variants![0],
        {
          variantId: 'model.mmproj.gguf',
          fileName: 'model.mmproj.gguf',
          quantizationLabel: 'GGUF',
          size: 512_000_000,
        },
        {
          variantId: 'model.NextN.Q4_K_M.gguf',
          fileName: 'model.NextN.Q4_K_M.gguf',
          quantizationLabel: 'Q4_K_M',
          size: 4_000_000_000,
        },
      ],
    });

    expect(getActiveModelVariant(createModel({
      activeVariantId: 'model.mmproj.gguf',
      resolvedFileName: 'model.mmproj.gguf',
      variants: [model.variants![1]],
    }))).toBeUndefined();
    expect(canSelectModelVariant(model)).toBe(false);
    expect(applyModelVariantSelection(model, 'model.mmproj.gguf')).toBe(model);
    expect(applyModelVariantSelection(model, 'model.NextN.Q4_K_M.gguf')).toBe(model);

    const selected = applyModelVariantSelectionIfAvailable(
      createModel({
        variants: [createModel().variants![0]],
      }),
      {
        activeVariantId: 'model.NextN.Q4_K_M.gguf',
        size: 4_000_000_000,
        metadataTrust: 'verified_local',
        downloadedAt: 123,
      },
    );

    expect(selected.resolvedFileName).toBe('model.Q4_K_M.gguf');
    expect(selected.variants?.some((variant) => variant.fileName.includes('NextN'))).toBe(false);
    expect(selected.variants?.some((variant) => variant.fileName.includes('mmproj'))).toBe(false);
  });

  it('uses resolved filename instead of an unmatched non-file active variant id', () => {
    const selected = applyModelVariantSelectionIfAvailable(
      createModel({
        variants: [
          createModel().variants![0],
          {
            variantId: 'model.Q8_0.gguf',
            fileName: 'model.Q8_0.gguf',
            quantizationLabel: 'Q8_0',
            size: 8_000_000_000,
            sha256: 'b'.repeat(64),
          },
        ],
      }),
      {
        activeVariantId: 'stale-q8-id',
        resolvedFileName: 'model.Q8_0.gguf',
        size: 8_000_000_000,
        sha256: 'b'.repeat(64),
        metadataTrust: 'verified_local',
        downloadedAt: 123,
      },
    );

    expect(selected).toEqual(expect.objectContaining({
      resolvedFileName: 'model.Q8_0.gguf',
      activeVariantId: 'model.Q8_0.gguf',
      downloadUrl: 'https://huggingface.co/org/model/resolve/main/model.Q8_0.gguf',
    }));
  });

  it('dedupes fallback variants that point to an existing catalog file', () => {
    const selected = applyModelVariantSelectionIfAvailable(
      createModel(),
      {
        activeVariantId: 'legacy-q8-selection',
        resolvedFileName: 'model.Q8_0.gguf',
        size: 8_000_000_000,
        sha256: 'c'.repeat(64),
        metadataTrust: 'verified_local',
        downloadedAt: 123,
        variants: [{
          variantId: 'legacy-q8-selection',
          fileName: 'model.Q8_0.gguf',
          quantizationLabel: 'Q8_0',
          size: 8_000_000_000,
          sha256: 'c'.repeat(64),
        }],
      },
      {
        allowResolvedFileNameFallback: true,
        allowResolvedFileNameVariantMatch: false,
      },
    );

    const q8Variants = selected.variants?.filter((variant) => variant.fileName === 'model.Q8_0.gguf') ?? [];
    expect(q8Variants).toHaveLength(1);
    expect(q8Variants[0]).toEqual(expect.objectContaining({
      variantId: 'legacy-q8-selection',
      fileName: 'model.Q8_0.gguf',
      sha256: 'c'.repeat(64),
    }));
    expect(selected).toEqual(expect.objectContaining({
      resolvedFileName: 'model.Q8_0.gguf',
      activeVariantId: 'legacy-q8-selection',
    }));
  });

  it('preserves audio modality when deduping duplicate variants for the same file', () => {
    expect(dedupeModelVariantsByIdentity([
      {
        variantId: 'model.Q4_K_M.gguf',
        fileName: 'model.Q4_K_M.gguf',
        quantizationLabel: 'Q4_K_M',
        size: 4_000_000_000,
        sha256: 'a'.repeat(64),
      },
      {
        variantId: 'audio-q4',
        fileName: 'model.Q4_K_M.gguf',
        quantizationLabel: 'Q4_K_M',
        size: null,
        chatModalities: ['text', 'audio'],
      },
    ])).toEqual([
      expect.objectContaining({
        variantId: 'audio-q4',
        size: 4_000_000_000,
        sha256: 'a'.repeat(64),
        chatModalities: ['text', 'audio'],
      }),
    ]);
  });

  it('keeps an explicit text-only preferred variant when fallback has audio metadata', () => {
    const audioProjector = {
      id: 'audio-projector',
      ownerModelId: 'org/model',
      repoId: 'org/model',
      fileName: 'mmproj-audio-model-f16.gguf',
      downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-audio-model-f16.gguf',
      size: 1024,
      lifecycleStatus: 'available' as const,
      matchStatus: 'matched' as const,
    };

    expect(dedupeModelVariantsByIdentity([
      {
        variantId: 'audio-q4',
        fileName: 'model.Q4_K_M.gguf',
        quantizationLabel: 'Q4_K_M',
        size: null,
        chatModalities: ['text', 'audio'],
        projectorCandidates: [audioProjector],
        selectedProjectorId: audioProjector.id,
      },
      {
        variantId: 'text-q4',
        fileName: 'model.Q4_K_M.gguf',
        quantizationLabel: 'Q4_K_M',
        size: 4_000_000_000,
        sha256: 'a'.repeat(64),
        chatModalities: ['text'],
      },
    ], { activeVariantId: 'text-q4' })).toEqual([
      expect.objectContaining({
        variantId: 'text-q4',
        chatModalities: ['text'],
        projectorCandidates: undefined,
        selectedProjectorId: undefined,
      }),
    ]);
  });

  it('keeps an explicit text-only preferred variant when fallback has vision metadata', () => {
    expect(dedupeModelVariantsByIdentity([
      {
        variantId: 'vision-q4',
        fileName: 'model.Q4_K_M.gguf',
        quantizationLabel: 'Q4_K_M',
        size: null,
        chatModalities: ['text', 'vision'],
      },
      {
        variantId: 'text-q4',
        fileName: 'model.Q4_K_M.gguf',
        quantizationLabel: 'Q4_K_M',
        size: 4_000_000_000,
        sha256: 'a'.repeat(64),
        chatModalities: ['text'],
      },
    ], { activeVariantId: 'text-q4' })).toEqual([
      expect.objectContaining({
        variantId: 'text-q4',
        chatModalities: ['text'],
      }),
    ]);
  });

  it('uses fallback modalities when the preferred variant has none', () => {
    const audioProjector = {
      id: 'audio-projector',
      ownerModelId: 'org/model',
      repoId: 'org/model',
      fileName: 'mmproj-audio-model-f16.gguf',
      downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-audio-model-f16.gguf',
      size: 1024,
      lifecycleStatus: 'available' as const,
      matchStatus: 'matched' as const,
    };

    expect(dedupeModelVariantsByIdentity([
      {
        variantId: 'preferred-q4',
        fileName: 'model.Q4_K_M.gguf',
        quantizationLabel: 'Q4_K_M',
        size: 4_000_000_000,
        sha256: 'a'.repeat(64),
      },
      {
        variantId: 'audio-q4',
        fileName: 'model.Q4_K_M.gguf',
        quantizationLabel: 'Q4_K_M',
        size: null,
        chatModalities: ['text', 'audio'],
        projectorCandidates: [audioProjector],
        selectedProjectorId: audioProjector.id,
      },
    ], { activeVariantId: 'preferred-q4' })).toEqual([
      expect.objectContaining({
        variantId: 'preferred-q4',
        chatModalities: ['text', 'audio'],
        projectorCandidates: [audioProjector],
        selectedProjectorId: audioProjector.id,
      }),
    ]);
  });

  it('does not add fallback vision metadata to an explicit audio preferred variant', () => {
    const visionProjector = {
      id: 'vision-projector',
      ownerModelId: 'org/model',
      repoId: 'org/model',
      fileName: 'mmproj-vision-model-f16.gguf',
      downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-vision-model-f16.gguf',
      size: 1024,
      lifecycleStatus: 'available' as const,
      matchStatus: 'matched' as const,
    };

    expect(dedupeModelVariantsByIdentity([
      {
        variantId: 'vision-q4',
        fileName: 'model.Q4_K_M.gguf',
        quantizationLabel: 'Q4_K_M',
        size: null,
        chatModalities: ['text', 'vision'],
        visionSource: 'catalog_metadata',
        visionConfidence: 'trusted',
        projectorCandidates: [visionProjector],
        selectedProjectorId: visionProjector.id,
      },
      {
        variantId: 'audio-q4',
        fileName: 'model.Q4_K_M.gguf',
        quantizationLabel: 'Q4_K_M',
        size: 4_000_000_000,
        sha256: 'a'.repeat(64),
        chatModalities: ['text', 'audio'],
      },
    ], { activeVariantId: 'audio-q4' })).toEqual([
      expect.objectContaining({
        variantId: 'audio-q4',
        chatModalities: ['text', 'audio'],
        visionSource: undefined,
        visionConfidence: undefined,
        projectorCandidates: undefined,
        selectedProjectorId: undefined,
      }),
    ]);
  });

  it('preserves an explicit audio preferred variant own projector metadata', () => {
    const audioProjector = {
      id: 'audio-projector',
      ownerModelId: 'org/model',
      repoId: 'org/model',
      fileName: 'mmproj-audio-model-f16.gguf',
      downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-audio-model-f16.gguf',
      size: 1024,
      lifecycleStatus: 'available' as const,
      matchStatus: 'matched' as const,
    };
    const visionProjector = {
      id: 'vision-projector',
      ownerModelId: 'org/model',
      repoId: 'org/model',
      fileName: 'mmproj-vision-model-f16.gguf',
      downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-vision-model-f16.gguf',
      size: 1024,
      lifecycleStatus: 'available' as const,
      matchStatus: 'matched' as const,
    };

    expect(dedupeModelVariantsByIdentity([
      {
        variantId: 'vision-q4',
        fileName: 'model.Q4_K_M.gguf',
        quantizationLabel: 'Q4_K_M',
        size: null,
        chatModalities: ['text', 'vision'],
        projectorCandidates: [visionProjector],
        selectedProjectorId: visionProjector.id,
      },
      {
        variantId: 'audio-q4',
        fileName: 'model.Q4_K_M.gguf',
        quantizationLabel: 'Q4_K_M',
        size: 4_000_000_000,
        sha256: 'a'.repeat(64),
        chatModalities: ['text', 'audio'],
        visionSource: 'gguf_metadata',
        visionConfidence: 'verified',
        projectorCandidates: [audioProjector],
        selectedProjectorId: audioProjector.id,
      },
    ], { activeVariantId: 'audio-q4' })).toEqual([
      expect.objectContaining({
        variantId: 'audio-q4',
        chatModalities: ['text', 'audio'],
        visionSource: undefined,
        visionConfidence: undefined,
        projectorCandidates: [audioProjector],
        selectedProjectorId: audioProjector.id,
      }),
    ]);
  });

  it('clears stale gguf total bytes when the selected variant has unknown size', () => {
    const selected = applyModelVariantSelection(
      createModel({
        variants: [
          createModel().variants![0],
          {
            variantId: 'model.unknown.gguf',
            fileName: 'model.unknown.gguf',
            quantizationLabel: 'GGUF',
            size: null,
          },
        ],
      }),
      'model.unknown.gguf',
    );

    expect(selected.size).toBeNull();
    expect(selected.metadataTrust).toBeUndefined();
    expect(selected.gguf).toEqual({ sizeLabel: 'GGUF' });
  });

  it('restores model fallback modalities after switching through an explicit audio variant', () => {
    const audioProjector = {
      id: 'audio-projector',
      ownerModelId: 'org/model',
      ownerVariantId: 'audio',
      repoId: 'org/model',
      fileName: 'mmproj-audio.gguf',
      downloadUrl: 'https://example.com/mmproj-audio.gguf',
      size: 100,
      lifecycleStatus: 'available' as const,
      matchStatus: 'matched' as const,
    };
    const model = createModel({
      chatModalities: ['text', 'vision'],
      activeVariantId: undefined,
      resolvedFileName: 'parent.gguf',
      variants: [
        {
          variantId: 'audio',
          fileName: 'audio.gguf',
          quantizationLabel: 'Q4_K_M',
          size: 1_000,
          chatModalities: ['text', 'audio'],
          projectorCandidates: [audioProjector],
        },
        {
          variantId: 'fallback',
          fileName: 'fallback.gguf',
          quantizationLabel: 'Q4_K_M',
          size: 2_000,
        },
      ],
    });

    const audioSelected = applyModelVariantSelection(model, 'audio');
    const selectedAfterTwoSwitches = applyModelVariantSelection(audioSelected, 'fallback');
    const directlySelectedFallback = applyModelVariantSelection(model, 'fallback');

    expect(audioSelected.chatModalities).toEqual(['text', 'vision']);
    expect(resolveEffectiveActiveVariantNativeSupport(audioSelected)).toEqual({ vision: false, audio: true });
    expect(selectedAfterTwoSwitches).toEqual(directlySelectedFallback);
    expect(selectedAfterTwoSwitches.chatModalities).toEqual(['text', 'vision']);
    expect(resolveEffectiveActiveVariantNativeSupport(selectedAfterTwoSwitches)).toEqual({ vision: true, audio: false });
  });
});
