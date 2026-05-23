import type { ModelsCatalogTab } from '../store/modelsCatalogTabs';
import type { ModelFilterCriteria } from '../store/modelsStore';
import { LifecycleStatus, type ModelMetadata } from '../types/models';
import { applyDefaultCatalogModelVariantSelection, applyModelVariantSelection } from './modelVariants';

type CatalogFilterProjectionCacheEntry = {
  value: ModelMetadata;
  variantsRef: ModelMetadata['variants'];
  resolvedFileName: ModelMetadata['resolvedFileName'];
  activeVariantId: ModelMetadata['activeVariantId'];
  size: ModelMetadata['size'];
  lifecycleStatus: ModelMetadata['lifecycleStatus'];
  fitsInRam: ModelMetadata['fitsInRam'];
  memoryFitDecision: ModelMetadata['memoryFitDecision'];
  memoryFitConfidence: ModelMetadata['memoryFitConfidence'];
};

export type CatalogFilterVariantProjectionCache = WeakMap<ModelMetadata, Map<string, CatalogFilterProjectionCacheEntry>>;

const DEFAULT_VARIANT_CACHE_KEY = '__default_catalog_variant__';

export function createCatalogFilterVariantProjectionCache(): CatalogFilterVariantProjectionCache {
  return new WeakMap();
}

function hasVariantSensitiveFilters(filters: Pick<ModelFilterCriteria, 'fitsInRamOnly' | 'sizeRanges'>): boolean {
  return filters.fitsInRamOnly || filters.sizeRanges.length > 0;
}

export function shouldProjectCatalogVariantForFiltering(
  model: Pick<ModelMetadata, 'lifecycleStatus'>,
  activeTab: ModelsCatalogTab,
  filters: Pick<ModelFilterCriteria, 'fitsInRamOnly' | 'sizeRanges'>,
  selectedVariantId: string | undefined,
): boolean {
  const variantSensitiveFilters = hasVariantSensitiveFilters(filters);

  if (selectedVariantId) {
    return model.lifecycleStatus === LifecycleStatus.AVAILABLE && (
      activeTab === 'downloaded' || variantSensitiveFilters
    );
  }

  return activeTab === 'all'
    && model.lifecycleStatus === LifecycleStatus.AVAILABLE
    && variantSensitiveFilters;
}

function getProjectionCacheKey(activeTab: ModelsCatalogTab, selectedVariantId: string | undefined): string {
  return `${activeTab}:${selectedVariantId ?? DEFAULT_VARIANT_CACHE_KEY}`;
}

function isCacheEntryFresh(entry: CatalogFilterProjectionCacheEntry, model: ModelMetadata): boolean {
  return entry.variantsRef === model.variants
    && entry.resolvedFileName === model.resolvedFileName
    && entry.activeVariantId === model.activeVariantId
    && entry.size === model.size
    && entry.lifecycleStatus === model.lifecycleStatus
    && entry.fitsInRam === model.fitsInRam
    && entry.memoryFitDecision === model.memoryFitDecision
    && entry.memoryFitConfidence === model.memoryFitConfidence;
}

function buildCacheEntry(model: ModelMetadata, value: ModelMetadata): CatalogFilterProjectionCacheEntry {
  return {
    value,
    variantsRef: model.variants,
    resolvedFileName: model.resolvedFileName,
    activeVariantId: model.activeVariantId,
    size: model.size,
    lifecycleStatus: model.lifecycleStatus,
    fitsInRam: model.fitsInRam,
    memoryFitDecision: model.memoryFitDecision,
    memoryFitConfidence: model.memoryFitConfidence,
  };
}

function projectCatalogVariantForFiltering(
  model: ModelMetadata,
  activeTab: ModelsCatalogTab,
  selectedVariantId: string | undefined,
): ModelMetadata {
  if (selectedVariantId) {
    return applyModelVariantSelection(model, selectedVariantId);
  }

  if (activeTab === 'all' && model.lifecycleStatus === LifecycleStatus.AVAILABLE) {
    return applyDefaultCatalogModelVariantSelection(model);
  }

  return model;
}

export function getCatalogFilterModelForVariantState(
  model: ModelMetadata,
  activeTab: ModelsCatalogTab,
  filters: Pick<ModelFilterCriteria, 'fitsInRamOnly' | 'sizeRanges'>,
  selectedVariantId: string | undefined,
  cache: CatalogFilterVariantProjectionCache,
): ModelMetadata {
  if (!shouldProjectCatalogVariantForFiltering(model, activeTab, filters, selectedVariantId)) {
    return model;
  }

  const cacheKey = getProjectionCacheKey(activeTab, selectedVariantId);
  let modelCache = cache.get(model);
  if (!modelCache) {
    modelCache = new Map();
    cache.set(model, modelCache);
  }

  const cached = modelCache.get(cacheKey);
  if (cached && isCacheEntryFresh(cached, model)) {
    return cached.value;
  }

  const value = projectCatalogVariantForFiltering(model, activeTab, selectedVariantId);
  modelCache.set(cacheKey, buildCacheEntry(model, value));
  return value;
}
