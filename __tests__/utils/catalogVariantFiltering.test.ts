import {
  createCatalogFilterVariantProjectionCache,
  getCatalogFilterModelForVariantState,
  shouldProjectCatalogVariantForFiltering,
} from '../../src/utils/catalogVariantFiltering';
import { LifecycleStatus, ModelAccessState, type ModelMetadata } from '../../src/types/models';
import type { ModelFilterCriteria } from '../../src/store/modelsStore';

const noVariantFilters: Pick<ModelFilterCriteria, 'fitsInRamOnly' | 'sizeRanges'> = {
  fitsInRamOnly: false,
  sizeRanges: [],
};

const ramFitFilter: Pick<ModelFilterCriteria, 'fitsInRamOnly' | 'sizeRanges'> = {
  fitsInRamOnly: true,
  sizeRanges: [],
};

function buildModel(overrides: Partial<ModelMetadata> = {}): ModelMetadata {
  return {
    id: 'org/model',
    name: 'Model',
    author: 'org',
    size: 8_000_000_000,
    downloadUrl: 'https://huggingface.co/org/model/resolve/main/model.Q8_0.gguf',
    resolvedFileName: 'model.Q8_0.gguf',
    activeVariantId: 'model.Q8_0.gguf',
    fitsInRam: false,
    memoryFitDecision: 'likely_oom',
    memoryFitConfidence: 'medium',
    accessState: ModelAccessState.PUBLIC,
    isGated: false,
    isPrivate: false,
    lifecycleStatus: LifecycleStatus.AVAILABLE,
    downloadProgress: 0,
    variants: [
      {
        variantId: 'model.Q8_0.gguf',
        fileName: 'model.Q8_0.gguf',
        quantizationLabel: 'Q8_0',
        size: 8_000_000_000,
        ramFit: 'likely_oom',
        ramFitConfidence: 'medium',
      },
      {
        variantId: 'model.Q4_K_M.gguf',
        fileName: 'model.Q4_K_M.gguf',
        quantizationLabel: 'Q4_K_M',
        size: 4_000_000_000,
        ramFit: 'fits_low_confidence',
        ramFitConfidence: 'medium',
      },
    ],
    ...overrides,
  };
}

describe('catalog variant filtering', () => {
  it('does not project catalog variants when filters cannot observe variant fields', () => {
    const model = buildModel();
    const cache = createCatalogFilterVariantProjectionCache();

    expect(shouldProjectCatalogVariantForFiltering(model, 'all', noVariantFilters, undefined)).toBe(false);
    expect(getCatalogFilterModelForVariantState(
      model,
      'all',
      noVariantFilters,
      undefined,
      cache,
    )).toBe(model);
    expect(getCatalogFilterModelForVariantState(
      model,
      'all',
      noVariantFilters,
      'model.Q4_K_M.gguf',
      cache,
    )).toBe(model);
  });

  it('projects selected variants when variant fields affect filtering', () => {
    const model = buildModel();
    const cache = createCatalogFilterVariantProjectionCache();

    const projected = getCatalogFilterModelForVariantState(
      model,
      'all',
      ramFitFilter,
      'model.Q4_K_M.gguf',
      cache,
    );

    expect(projected).not.toBe(model);
    expect(projected).toEqual(expect.objectContaining({
      resolvedFileName: 'model.Q4_K_M.gguf',
      activeVariantId: 'model.Q4_K_M.gguf',
      size: 4_000_000_000,
      memoryFitDecision: 'fits_low_confidence',
      fitsInRam: true,
    }));
  });

  it('reuses unchanged default projections across filter recomputations', () => {
    const model = buildModel();
    const cache = createCatalogFilterVariantProjectionCache();

    const firstProjection = getCatalogFilterModelForVariantState(
      model,
      'all',
      ramFitFilter,
      undefined,
      cache,
    );
    const secondProjection = getCatalogFilterModelForVariantState(
      model,
      'all',
      ramFitFilter,
      undefined,
      cache,
    );

    expect(firstProjection).not.toBe(model);
    expect(secondProjection).toBe(firstProjection);
    expect(secondProjection).toEqual(expect.objectContaining({
      resolvedFileName: 'model.Q4_K_M.gguf',
      activeVariantId: 'model.Q4_K_M.gguf',
      memoryFitDecision: 'fits_low_confidence',
    }));
  });

  it('invalidates cached projections when variant metadata changes', () => {
    const model = buildModel();
    const cache = createCatalogFilterVariantProjectionCache();

    const firstProjection = getCatalogFilterModelForVariantState(
      model,
      'all',
      ramFitFilter,
      undefined,
      cache,
    );

    model.variants = model.variants?.map((variant) => (
      variant.variantId === 'model.Q4_K_M.gguf'
        ? { ...variant, size: 5_000_000_000 }
        : variant
    ));

    const secondProjection = getCatalogFilterModelForVariantState(
      model,
      'all',
      ramFitFilter,
      undefined,
      cache,
    );

    expect(secondProjection).not.toBe(firstProjection);
    expect(secondProjection.size).toBe(5_000_000_000);
  });
});
