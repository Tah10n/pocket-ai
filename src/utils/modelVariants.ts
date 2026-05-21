import { LifecycleStatus, type ModelMetadata, type ModelVariant } from '../types/models';
import { buildHuggingFaceResolveUrl } from './huggingFaceUrls';
import { normalizePersistedModelMetadata } from '../services/ModelMetadataNormalizer';
import { isSupportedGgufFileName } from '../services/ModelCatalogFileSelector';

type ModelVariantSelectionSource = Pick<ModelMetadata, 'activeVariantId' | 'resolvedFileName'> & Partial<Pick<
  ModelMetadata,
  | 'downloadedAt'
  | 'downloadProgress'
  | 'downloadIntegrity'
  | 'fitsInRam'
  | 'gguf'
  | 'lifecycleStatus'
  | 'localPath'
  | 'memoryFitConfidence'
  | 'memoryFitDecision'
  | 'metadataTrust'
  | 'resumeData'
  | 'sha256'
  | 'size'
  | 'variants'
>>;

export const DEFAULT_CATALOG_QUANTIZATION_LABEL = 'Q4_K_M';

interface ApplyModelVariantSelectionOptions {
  allowResolvedFileNameFallback?: boolean;
  allowResolvedFileNameVariantMatch?: boolean;
}

export function getActiveModelVariant(model: Pick<ModelMetadata, 'activeVariantId' | 'resolvedFileName' | 'variants'>): ModelVariant | undefined {
  const variants = (model.variants ?? []).filter((variant) => isGgufFileName(variant.fileName));
  if (variants.length === 0) {
    return undefined;
  }

  return variants.find((variant) => variant.variantId === model.activeVariantId)
    ?? variants.find((variant) => variant.fileName === model.resolvedFileName)
    ?? variants[0];
}

export function canSelectModelVariant(model: Pick<ModelMetadata, 'lifecycleStatus' | 'variants'>): boolean {
  const variants = (model.variants ?? []).filter((variant) => isGgufFileName(variant.fileName));
  if (variants.length <= 1) {
    return false;
  }

  return model.lifecycleStatus === LifecycleStatus.AVAILABLE
    || model.lifecycleStatus === LifecycleStatus.FAILED
    || model.lifecycleStatus === LifecycleStatus.PAUSED;
}

function findVariantByIdOrFileName(
  model: Pick<ModelMetadata, 'variants'>,
  variantIdOrFileName: string,
): ModelVariant | undefined {
  const variants = (model.variants ?? []).filter((variant) => isGgufFileName(variant.fileName));
  if (variants.length === 0) {
    return undefined;
  }

  const normalized = variantIdOrFileName.trim();
  if (normalized.length === 0) {
    return undefined;
  }

  return variants.find((variant) => variant.variantId === normalized || variant.fileName === normalized);
}

function buildFallbackVariant(
  selection: Partial<ModelVariantSelectionSource>,
  fileName: string,
  size: ModelMetadata['size'],
): ModelVariant {
  const activeVariantId = typeof selection.activeVariantId === 'string'
    ? selection.activeVariantId.trim()
    : '';
  const matchingActiveVariant = (selection.variants ?? []).find((variant) => variant.variantId === activeVariantId);
  const variantId = activeVariantId.length > 0 && (
    activeVariantId === fileName
    || matchingActiveVariant?.fileName === fileName
  )
    ? activeVariantId
    : fileName;
  const sizeLabel = typeof selection.gguf?.sizeLabel === 'string' && selection.gguf.sizeLabel.trim().length > 0
    ? selection.gguf.sizeLabel.trim()
    : 'GGUF';

  return {
    variantId,
    fileName,
    quantizationLabel: sizeLabel,
    size,
    ...(selection.sha256 ? { sha256: selection.sha256 } : {}),
    ...(selection.memoryFitDecision ? { ramFit: selection.memoryFitDecision } : {}),
    ...(selection.memoryFitConfidence ? { ramFitConfidence: selection.memoryFitConfidence } : {}),
  };
}

function hasDurableResolvedFileNameSelectionEvidence(selection: ModelVariantSelectionSource): boolean {
  return selection.metadataTrust === 'verified_local'
    || selection.downloadIntegrity !== undefined
    || typeof selection.downloadedAt === 'number'
    || typeof selection.localPath === 'string'
    || typeof selection.resumeData === 'string'
    || (typeof selection.downloadProgress === 'number' && selection.downloadProgress > 0)
    || selection.lifecycleStatus === LifecycleStatus.DOWNLOADED
    || selection.lifecycleStatus === LifecycleStatus.ACTIVE;
}

function normalizePositiveSize(value: ModelMetadata['size'] | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined;
}

function hasResolvedFileNameFallbackIdentityEvidence(
  model: ModelMetadata,
  selection: ModelVariantSelectionSource,
  resolvedSelectionFileName: string,
): boolean {
  const selectedSize = normalizePositiveSize(selection.size);
  const modelSize = normalizePositiveSize(model.size);
  if (selectedSize !== undefined && modelSize !== undefined) {
    return selectedSize !== modelSize;
  }

  if (selectedSize !== undefined && modelSize === undefined) {
    return true;
  }

  return (selection.variants ?? []).some((variant) => (
    variant.fileName === resolvedSelectionFileName
    || variant.variantId === resolvedSelectionFileName
  ));
}

function isGgufFileName(value: string): boolean {
  return isSupportedGgufFileName(value);
}

export function getDefaultCatalogModelVariant(model: Pick<ModelMetadata, 'variants'>): ModelVariant | undefined {
  const variants = (model.variants ?? []).filter((variant) => isGgufFileName(variant.fileName));
  if (variants.length === 0) {
    return undefined;
  }

  return variants.find((variant) => variant.quantizationLabel === DEFAULT_CATALOG_QUANTIZATION_LABEL)
    ?? variants[0];
}

export function applyDefaultCatalogModelVariantSelection(model: ModelMetadata): ModelMetadata {
  const defaultVariant = getDefaultCatalogModelVariant(model);
  if (!defaultVariant) {
    return model;
  }

  return applyModelVariantSelection(model, defaultVariant.variantId);
}

export function applyModelVariantSelectionIfAvailable(
  model: ModelMetadata,
  selection: ModelVariantSelectionSource | undefined,
  options: ApplyModelVariantSelectionOptions = {},
): ModelMetadata {
  if (!selection) {
    return model;
  }

  const explicitVariantId = typeof selection.activeVariantId === 'string'
    ? selection.activeVariantId.trim()
    : '';
  const resolvedSelectionFileName = typeof selection.resolvedFileName === 'string'
    ? selection.resolvedFileName.trim()
    : '';
  const canUseExplicitFallback = explicitVariantId.length > 0 && isGgufFileName(explicitVariantId);

  const allowResolvedFileNameFallback = options.allowResolvedFileNameFallback
    ?? (
      hasDurableResolvedFileNameSelectionEvidence(selection)
      && hasResolvedFileNameFallbackIdentityEvidence(model, selection, resolvedSelectionFileName)
    );
  const allowResolvedFileNameVariantMatch = options.allowResolvedFileNameVariantMatch
    ?? (
      hasDurableResolvedFileNameSelectionEvidence(selection)
      && (
        canUseExplicitFallback
        || hasResolvedFileNameFallbackIdentityEvidence(model, selection, resolvedSelectionFileName)
      )
    );
  const shouldPreferResolvedVariantMatch = canUseExplicitFallback
    && resolvedSelectionFileName.length > 0
    && resolvedSelectionFileName !== explicitVariantId
    && allowResolvedFileNameVariantMatch;
  if (shouldPreferResolvedVariantMatch) {
    const resolvedVariant = findVariantByIdOrFileName(model, resolvedSelectionFileName);
    if (resolvedVariant) {
      return applyModelVariantSelection(model, resolvedVariant.variantId);
    }
  }

  if (!shouldPreferResolvedVariantMatch && explicitVariantId.length > 0) {
    const explicitVariant = findVariantByIdOrFileName(model, explicitVariantId);
    if (explicitVariant) {
      return applyModelVariantSelection(model, explicitVariant.variantId);
    }
  }

  if (allowResolvedFileNameVariantMatch) {
    const resolvedVariant = findVariantByIdOrFileName(model, resolvedSelectionFileName);
    if (resolvedVariant) {
      return applyModelVariantSelection(model, resolvedVariant.variantId);
    }
  }

  const canUseResolvedFallback = resolvedSelectionFileName.length > 0 && isGgufFileName(resolvedSelectionFileName) && (
    resolvedSelectionFileName !== model.resolvedFileName
    && allowResolvedFileNameFallback
  );
  const canUseActiveVariantFallback = canUseExplicitFallback
    && !shouldPreferResolvedVariantMatch
    && hasDurableResolvedFileNameSelectionEvidence(selection);
  if (!canUseActiveVariantFallback && !canUseResolvedFallback) {
    return model;
  }

  const selectedFileName = canUseResolvedFallback ? resolvedSelectionFileName : explicitVariantId;
  if (!selectedFileName) {
    return model;
  }

  const isDifferentFile = model.resolvedFileName !== selectedFileName;
  const canUseSelectionFileMetadata = selectedFileName === resolvedSelectionFileName
    || (selectedFileName === explicitVariantId && resolvedSelectionFileName.length === 0);
  const selectionFileMetadata = canUseSelectionFileMetadata ? selection : {};
  const nextSize = canUseSelectionFileMetadata && selection.size !== undefined
    ? selection.size
    : !isDifferentFile ? model.size : null;
  const fallbackVariant = buildFallbackVariant(selectionFileMetadata, selectedFileName, nextSize);
  const variants = [
    ...(model.variants ?? []).filter((entry) => entry.variantId !== fallbackVariant.variantId),
    fallbackVariant,
  ];

  return normalizePersistedModelMetadata({
    ...model,
    size: nextSize,
    downloadUrl: buildHuggingFaceResolveUrl(model.id, selectedFileName, model.hfRevision),
    resolvedFileName: selectedFileName,
    sha256: canUseSelectionFileMetadata
      ? selection.sha256 ?? (!isDifferentFile ? model.sha256 : undefined)
      : !isDifferentFile ? model.sha256 : undefined,
    activeVariantId: fallbackVariant.variantId,
    metadataTrust: canUseSelectionFileMetadata
      ? selection.metadataTrust ?? (!isDifferentFile ? model.metadataTrust : undefined)
      : !isDifferentFile ? model.metadataTrust : undefined,
    fitsInRam: canUseSelectionFileMetadata
      ? selection.fitsInRam ?? (!isDifferentFile ? model.fitsInRam : null)
      : !isDifferentFile ? model.fitsInRam : null,
    memoryFitDecision: canUseSelectionFileMetadata
      ? selection.memoryFitDecision ?? (!isDifferentFile ? model.memoryFitDecision : undefined)
      : !isDifferentFile ? model.memoryFitDecision : undefined,
    memoryFitConfidence: canUseSelectionFileMetadata
      ? selection.memoryFitConfidence ?? (!isDifferentFile ? model.memoryFitConfidence : undefined)
      : !isDifferentFile ? model.memoryFitConfidence : undefined,
    gguf: canUseSelectionFileMetadata
      ? selection.gguf ?? (!isDifferentFile ? model.gguf : undefined)
      : !isDifferentFile ? model.gguf : undefined,
    variants,
    ...(isDifferentFile ? {
      allowUnknownSizeDownload: false,
      localPath: undefined,
      downloadedAt: undefined,
      downloadIntegrity: undefined,
      resumeData: undefined,
      downloadErrorAt: undefined,
      downloadErrorCode: undefined,
      downloadErrorMessage: undefined,
      maxContextTokens: undefined,
      hasVerifiedContextWindow: false,
      capabilitySnapshot: undefined,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
    } : {}),
  });
}

function getVariantMemoryFitPatch(
  model: ModelMetadata,
  variant: ModelVariant,
  isDifferentFitIdentity: boolean,
): Pick<ModelMetadata, 'fitsInRam' | 'memoryFitDecision' | 'memoryFitConfidence'> {
  if (!isDifferentFitIdentity) {
    return {
      fitsInRam: model.fitsInRam,
      memoryFitDecision: model.memoryFitDecision,
      memoryFitConfidence: model.memoryFitConfidence,
    };
  }

  if (variant.size === null) {
    return {
      fitsInRam: null,
      memoryFitDecision: undefined,
      memoryFitConfidence: undefined,
    };
  }

  if (variant.ramFit) {
    return {
      fitsInRam: variant.ramFit === 'unknown'
        ? null
        : variant.ramFit === 'fits_high_confidence' || variant.ramFit === 'fits_low_confidence',
      memoryFitDecision: variant.ramFit,
      memoryFitConfidence: variant.ramFitConfidence,
    };
  }

  return {
    fitsInRam: null,
    memoryFitDecision: 'unknown',
    memoryFitConfidence: undefined,
  };
}

export function applyModelVariantSelection(model: ModelMetadata, variantId: string): ModelMetadata {
  const variant = model.variants?.find((entry) => entry.variantId === variantId);
  if (!variant || !isGgufFileName(variant.fileName)) {
    return model;
  }

  const selectedSize = variant.size;
  const isDifferentFile = model.resolvedFileName !== variant.fileName;
  const nextSize = selectedSize ?? (!isDifferentFile ? model.size : null);
  const isDifferentFitIdentity = isDifferentFile || model.size !== nextSize;
  const { totalBytes: _staleTotalBytes, ...existingGguf } = model.gguf ?? {};
  const nextGguf = isDifferentFile
    ? {
        sizeLabel: variant.quantizationLabel,
        ...(nextSize !== null ? { totalBytes: nextSize } : {}),
      }
    : {
        ...existingGguf,
        sizeLabel: variant.quantizationLabel,
        ...(nextSize !== null ? { totalBytes: nextSize } : {}),
      };
  const memoryFitPatch = getVariantMemoryFitPatch(model, variant, isDifferentFitIdentity);

  return normalizePersistedModelMetadata({
    ...model,
    size: nextSize,
    downloadUrl: buildHuggingFaceResolveUrl(model.id, variant.fileName, model.hfRevision),
    resolvedFileName: variant.fileName,
    sha256: variant.sha256 ?? (!isDifferentFile ? model.sha256 : undefined),
    activeVariantId: variant.variantId,
    metadataTrust: !isDifferentFile && model.metadataTrust
      ? model.metadataTrust
      : selectedSize !== null ? 'trusted_remote' : undefined,
    ...memoryFitPatch,
    gguf: nextGguf,
    ...(isDifferentFile ? {
      allowUnknownSizeDownload: false,
      localPath: undefined,
      downloadedAt: undefined,
      downloadIntegrity: undefined,
      resumeData: undefined,
      downloadErrorAt: undefined,
      downloadErrorCode: undefined,
      downloadErrorMessage: undefined,
      maxContextTokens: undefined,
      hasVerifiedContextWindow: false,
      capabilitySnapshot: undefined,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
    } : {}),
  });
}
