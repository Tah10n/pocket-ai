import type { ModelMetadata, ModelVariant } from '../types/models';
import type {
  HuggingFaceModelConfig,
  HuggingFaceModelSummary,
  HuggingFaceSibling,
  HuggingFaceTreeEntry,
} from '../types/huggingFace';
import {
  isProjectorFileName,
} from '../utils/modelProjectors';
import {
  buildEmbeddedMtpConfig,
  isExplicitMtpDraftFileName,
  isMtpGgufFileName,
} from '../utils/modelSpeculativeDecoding';
import { normalizeSha256Digest } from '../utils/sha256';

export { isProjectorFileName } from '../utils/modelProjectors';

const MIN_GGUF_BYTES = 50 * 1024 * 1024;

// Default catalog policy: prefer balanced mobile-friendly K-quants, then
// smaller low-bit files, and leave full-precision files as explicit choices.
const DEFAULT_QUANTIZATION_RANK: Record<string, number> = {
  Q4_K_M: 0,
  Q4_K_S: 1,
  Q4_0: 2,
  Q5_K_M: 3,
  Q5_K_S: 4,
  Q3_K_M: 5,
  Q3_K_S: 6,
  Q2_K: 7,
  Q6_K: 8,
  Q8_0: 9,
  F16: 10,
  FP16: 10,
  BF16: 11,
  F32: 12,
  FP32: 12,
};
const DEFAULT_TREE_STOP_MAX_RANK = 0;
const UNKNOWN_QUANTIZATION_RANK = 50;
const UNKNOWN_FILE_RANK = 100;
export const CATALOG_SEARCH_VARIANT_LIMIT = 12;

const INTELLIGENT_QUANTIZATION_RANK_BY_BITS: Record<number, number> = {
  5: 4.5,
  4: 3.5,
  3: 6.5,
  2: 7.5,
  1: 9.5,
};

const QUANTIZATION_LABEL_PATTERNS = [
  /(?:^|[._/-])(IQ\d(?:_[A-Z0-9]+)+)(?=[._/-]|$)/i,
  /(?:^|[._/-])(Q\d_K_[A-Z])(?=[._/-]|$)/i,
  /(?:^|[._/-])(Q\d_\d)(?=[._/-]|$)/i,
  /(?:^|[._/-])(Q\d_K)(?=[._/-]|$)/i,
  /(?:^|[._/-])((?:BF|FP|F)(?:16|32))(?=[._/-]|$)/i,
] as const;

const EXCLUDED_CATALOG_PIPELINE_TAGS = new Set([
  'text-to-image',
  'image-to-image',
  'image-text-to-text',
  'image-classification',
  'image-segmentation',
  'zero-shot-image-classification',
  'object-detection',
  'depth-estimation',
  'visual-question-answering',
  'document-question-answering',
  'video-classification',
  'video-text-to-text',
  'text-to-video',
  'image-to-video',
  'text-to-audio',
  'audio-to-audio',
  'audio-classification',
  'automatic-speech-recognition',
]);

const MULTIMODAL_CHAT_PIPELINE_TAGS = new Set([
  'image-text-to-text',
  'visual-question-answering',
  'document-question-answering',
  'audio-text-to-text',
  'automatic-speech-recognition',
  'video-text-to-text',
]);

const EXCLUDED_CATALOG_SIGNAL_EXACT_MATCHES = new Set([
  'diffusers',
  'stable-diffusion',
  'image-generation',
  'clip-vision-model',
]);

const EXCLUDED_CATALOG_SIGNAL_FRAGMENTS = [
  'stable-diffusion',
  'sdxl',
  'diffusion',
  'flux',
];

export function filterCatalogSearchModels(models: ModelMetadata[]): ModelMetadata[] {
  return models.filter((model) => isCatalogModelSupported(model));
}

export function isCatalogSummarySupported(item: HuggingFaceModelSummary): boolean {
  const allowMultimodalChatPipelineTag = hasGgufSummarySignal(item);

  return !hasUnsupportedCatalogSignals({
    identifiers: [item.id, item.modelId],
    pipelineTag: item.pipeline_tag,
    tags: item.tags,
    modelTypes: [
      item.config?.model_type,
      item.cardData?.model_type,
      item.gguf?.architecture,
    ],
    architectures: item.config?.architectures,
    config: item.config,
    allowMultimodalChatPipelineTag,
  });
}

export function isCatalogModelSupported(model: ModelMetadata): boolean {
  return !hasUnsupportedCatalogSignals({
    identifiers: [model.id, model.name, model.resolvedFileName, model.activeVariantId],
    tags: model.tags,
    modelTypes: [model.modelType],
    architectures: model.architectures,
    ggufMetadata: model.gguf,
  });
}

function hasUnsupportedCatalogSignals(options: {
  identifiers?: (string | undefined)[];
  pipelineTag?: string;
  tags?: string[];
  modelTypes?: (string | undefined)[];
  architectures?: string[];
  config?: HuggingFaceModelConfig;
  ggufMetadata?: Record<string, unknown>;
  allowMultimodalChatPipelineTag?: boolean;
}): boolean {
  const pipelineTag = normalizeCatalogSignal(options.pipelineTag);
  if (pipelineTag && isExcludedCatalogPipelineSignal(pipelineTag, options.allowMultimodalChatPipelineTag)) {
    return true;
  }

  const signals = [
    ...normalizeCatalogSignals(options.identifiers),
    ...normalizeCatalogSignals(options.tags),
    ...normalizeCatalogSignals(options.modelTypes),
    ...normalizeCatalogSignals(options.architectures),
  ];

  return signals.some((signal) => (
    isExcludedCatalogPipelineSignal(signal, options.allowMultimodalChatPipelineTag)
    || EXCLUDED_CATALOG_SIGNAL_EXACT_MATCHES.has(signal)
    || EXCLUDED_CATALOG_SIGNAL_FRAGMENTS.some((fragment) => signal.includes(fragment))
  ));
}

function isExcludedCatalogPipelineSignal(signal: string, allowMultimodalChatPipelineTag: boolean | undefined): boolean {
  return EXCLUDED_CATALOG_PIPELINE_TAGS.has(signal)
    && !(allowMultimodalChatPipelineTag === true && MULTIMODAL_CHAT_PIPELINE_TAGS.has(signal));
}

function normalizeCatalogSignal(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function normalizeCatalogSignals(values: (string | undefined)[] | undefined): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .map((value) => normalizeCatalogSignal(value))
    .filter((value): value is string => value !== null);
}

export function selectTreeEntryForModel(model: ModelMetadata, entries: HuggingFaceTreeEntry[]): HuggingFaceTreeEntry | undefined {
  if (model.resolvedFileName) {
    const exactMatch = entries.find((entry) => getFileName(entry) === model.resolvedFileName);
    if (exactMatch && isEligibleGgufEntry(exactMatch, entries)) {
      return exactMatch;
    }
  }

  return selectPreferredGgufEntry(entries);
}

export function shouldRevalidateCatalogSummarySelection(selectedEntry: HuggingFaceSibling): boolean {
  return getFileSize(selectedEntry) === null;
}

export function selectPreferredGgufEntry<T extends HuggingFaceSibling | HuggingFaceTreeEntry>(entries: T[]): T | undefined {
  return rankCatalogGgufEntries(entries)[0];
}

export function isPreferredQuantFileName(fileName: string): boolean {
  const label = resolveQuantizationLabel(fileName);
  return label !== null && getDefaultQuantizationRank(label) <= DEFAULT_TREE_STOP_MAX_RANK;
}

export function buildCatalogModelVariants(
  entries: (HuggingFaceSibling | HuggingFaceTreeEntry)[],
  options?: {
    limit?: number | null;
    includeFileNames?: (string | undefined | null)[];
    includeVariantIds?: (string | undefined | null)[];
  },
): ModelVariant[] {
  return buildCatalogModelVariantsFromRankedEntries(rankCatalogGgufEntries(entries), options);
}

export function rankCatalogGgufEntries<T extends HuggingFaceSibling | HuggingFaceTreeEntry>(entries: T[]): T[] {
  return entries
    .filter((entry) => isEligibleGgufEntry(entry, entries))
    .sort(compareCatalogGgufEntries);
}

function hasGgufSummarySignal(item: HuggingFaceModelSummary): boolean {
  if (item.gguf) {
    return true;
  }

  const directSignals = [
    item.id,
    item.modelId,
    ...(item.tags ?? []),
  ];
  if (directSignals.some((value) => normalizeCatalogSignal(value)?.includes('gguf'))) {
    return true;
  }

  return (item.siblings ?? []).some((entry) => getFileName(entry).toLowerCase().endsWith('.gguf'));
}

export function getProjectorCompanionEntries<T extends HuggingFaceSibling | HuggingFaceTreeEntry>(entries: T[]): T[] {
  return entries.filter((entry) => isProjectorFileName(getFileName(entry)));
}

export function hasProjectorCompanionEntries(entries: (HuggingFaceSibling | HuggingFaceTreeEntry)[]): boolean {
  return getProjectorCompanionEntries(entries).length > 0;
}

export function buildCatalogModelVariantsFromRankedEntries(
  rankedEntries: (HuggingFaceSibling | HuggingFaceTreeEntry)[],
  options?: {
    limit?: number | null;
    includeFileNames?: (string | undefined | null)[];
    includeVariantIds?: (string | undefined | null)[];
  },
): ModelVariant[] {
  const variants = rankedEntries
    .filter((entry) => isEligibleGgufEntry(entry, rankedEntries))
    .map((entry) => {
      const fileName = getFileName(entry);
      return {
        variantId: fileName,
        fileName,
        quantizationLabel: resolveQuantizationLabel(fileName) ?? 'GGUF',
        size: getFileSize(entry),
        sha256: getFileSha(entry),
        ...(isMtpGgufFileName(fileName)
          ? { speculativeDecoding: buildEmbeddedMtpConfig(fileName) }
          : {}),
      };
    });

  const seen = new Set<string>();
  const dedupedVariants = variants.filter((variant) => {
    const key = variant.fileName.trim();
    if (!key || seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });

  return limitModelVariants(dedupedVariants, options) ?? [];
}

export function limitModelVariants(
  variants: ModelVariant[] | undefined,
  options?: {
    limit?: number | null;
    includeFileNames?: (string | undefined | null)[];
    includeVariantIds?: (string | undefined | null)[];
  },
): ModelVariant[] | undefined {
  if (!variants || variants.length === 0) {
    return variants;
  }

  const limit = options?.limit;
  if (limit === null || limit === undefined) {
    return variants;
  }

  if (!Number.isFinite(limit)) {
    return variants;
  }

  const normalizedLimit = Math.max(0, Math.floor(limit));
  if (variants.length <= normalizedLimit) {
    return variants;
  }

  const pinnedFileNames = new Set(
    (options?.includeFileNames ?? [])
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );
  const pinnedVariantIds = new Set(
    (options?.includeVariantIds ?? [])
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );
  const selectedIndexes = new Set<number>();
  const addIndex = (index: number): boolean => {
    if (selectedIndexes.size >= normalizedLimit) {
      return false;
    }

    selectedIndexes.add(index);
    return selectedIndexes.size < normalizedLimit;
  };

  const addFirstMatchingPinnedValue = (
    value: string,
    matches: (variant: ModelVariant, value: string) => boolean,
  ): void => {
    if (selectedIndexes.size >= normalizedLimit) {
      return;
    }

    const index = variants.findIndex((variant) => matches(variant, value));
    if (index >= 0) {
      addIndex(index);
    }
  };

  pinnedFileNames.forEach((fileName) => {
    addFirstMatchingPinnedValue(fileName, (variant, value) => variant.fileName === value);
  });

  pinnedVariantIds.forEach((variantId) => {
    addFirstMatchingPinnedValue(variantId, (variant, value) => variant.variantId === value);
  });

  variants.forEach((variant, index) => {
    if (selectedIndexes.size >= normalizedLimit) {
      return;
    }

    if (variant.isLocal === true) {
      addIndex(index);
    }
  });

  for (let index = 0; index < variants.length && selectedIndexes.size < normalizedLimit; index += 1) {
    addIndex(index);
  }

  return variants.filter((_variant, index) => selectedIndexes.has(index));
}

export function resolveQuantizationLabel(fileName: string): string | null {
  const normalizedFileName = getBaseFileName(fileName);

  for (const pattern of QUANTIZATION_LABEL_PATTERNS) {
    const match = normalizedFileName.match(pattern);
    if (match?.[1]) {
      return match[1].toUpperCase();
    }
  }

  return null;
}

export function isMtpFileName(fileName: string): boolean {
  return isMtpGgufFileName(fileName);
}

export function isMtpDraftCompanionFileName(fileName: string): boolean {
  return isExplicitMtpDraftFileName(fileName);
}

export function isSupportedGgufFileName(fileName: string): boolean {
  const normalized = fileName.trim();
  return normalized.toLowerCase().endsWith('.gguf')
    && !isProjectorFileName(normalized)
    && !isMtpDraftCompanionFileName(normalized);
}

export function isMtpDraftCompanionEntry<T extends HuggingFaceSibling | HuggingFaceTreeEntry>(
  entry: T,
  entries: readonly T[],
): boolean {
  const fileName = getFileName(entry);
  if (isMtpDraftCompanionFileName(fileName)) {
    return true;
  }
  if (!isMtpGgufFileName(fileName)) {
    return false;
  }

  const nonMtpMainSizes = entries.flatMap((candidate) => {
    const candidateFileName = getFileName(candidate);
    if (
      !candidateFileName.toLowerCase().endsWith('.gguf')
      || isProjectorFileName(candidateFileName)
      || isMtpGgufFileName(candidateFileName)
    ) {
      return [];
    }

    const size = getFileSize(candidate);
    return size !== null && size >= MIN_GGUF_BYTES ? [size] : [];
  });
  const entrySize = getFileSize(entry);
  const smallestMainSize = nonMtpMainSizes.length > 0 ? Math.min(...nonMtpMainSizes) : null;
  const hasDraftSuffix = /(?:^|[-_.])mtp(?=\.gguf$)/iu.test(fileName.trim());

  return hasDraftSuffix
    && entrySize !== null
    && smallestMainSize !== null
    && entrySize < smallestMainSize * 0.5;
}

export function getMtpDraftCompanionEntries<T extends HuggingFaceSibling | HuggingFaceTreeEntry>(
  entries: T[],
): T[] {
  return entries.filter((entry) => isMtpDraftCompanionEntry(entry, entries));
}

export function isEligibleGgufEntry(
  entry: HuggingFaceSibling | HuggingFaceTreeEntry,
  entries: readonly (HuggingFaceSibling | HuggingFaceTreeEntry)[] = [entry],
): boolean {
  const name = getFileName(entry);
  if (!isSupportedGgufFileName(name) || isMtpDraftCompanionEntry(entry, entries)) {
    return false;
  }

  const size = getFileSize(entry);
  return size === null || size >= MIN_GGUF_BYTES;
}

export function getFileName(entry: HuggingFaceSibling | HuggingFaceTreeEntry): string {
  return entry.rfilename || entry.filename || ('path' in entry ? entry.path : '') || '';
}

export function getFileSize(entry: HuggingFaceSibling | HuggingFaceTreeEntry | undefined): number | null {
  const size = typeof entry?.size === 'number'
    ? entry.size
    : typeof entry?.lfs?.size === 'number'
      ? entry.lfs.size
      : undefined;

  return typeof size === 'number' && Number.isFinite(size) && size >= 0
    ? Math.round(size)
    : null;
}

export function getFileSha(entry: HuggingFaceSibling | HuggingFaceTreeEntry): string | undefined {
  const lfs = entry.lfs as { sha256?: string; oid?: string } | undefined;
  return normalizeSha256Digest(lfs?.sha256) ?? normalizeSha256Digest(lfs?.oid);
}

function compareCatalogGgufEntries(
  left: HuggingFaceSibling | HuggingFaceTreeEntry,
  right: HuggingFaceSibling | HuggingFaceTreeEntry,
): number {
  const leftName = getFileName(left);
  const rightName = getFileName(right);
  const leftIsMtp = isMtpGgufFileName(leftName);
  const rightIsMtp = isMtpGgufFileName(rightName);
  if (leftIsMtp !== rightIsMtp) {
    // Keep the mature non-speculative variant as the automatic default whenever
    // a repository offers both. MTP stays selectable and is the default in
    // MTP-only repositories.
    return leftIsMtp ? 1 : -1;
  }
  const leftRank = getDefaultQuantizationRank(resolveQuantizationLabel(leftName));
  const rightRank = getDefaultQuantizationRank(resolveQuantizationLabel(rightName));
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }

  const leftSize = getPositiveSizeForSort(left);
  const rightSize = getPositiveSizeForSort(right);
  if (leftSize !== rightSize) {
    return leftSize - rightSize;
  }

  return leftName.localeCompare(rightName);
}

function getBaseFileName(fileName: string): string {
  const normalizedPath = fileName.trim();
  return normalizedPath.split(/[\\/]/).pop() ?? normalizedPath;
}

function getDefaultQuantizationRank(label: string | null): number {
  if (!label) {
    return UNKNOWN_FILE_RANK;
  }

  const normalized = label.trim().toUpperCase();
  const exactRank = DEFAULT_QUANTIZATION_RANK[normalized];
  if (exactRank !== undefined) {
    return exactRank;
  }

  const intelligentQuantizationRank = getIntelligentQuantizationRank(normalized);
  if (intelligentQuantizationRank !== null) {
    return intelligentQuantizationRank;
  }

  return UNKNOWN_QUANTIZATION_RANK;
}

function getIntelligentQuantizationRank(label: string): number | null {
  const match = label.match(/^IQ(\d)(?:_[A-Z0-9]+)+$/);
  if (!match?.[1]) {
    return null;
  }

  const bits = Number(match[1]);
  if (!Number.isFinite(bits)) {
    return null;
  }

  return INTELLIGENT_QUANTIZATION_RANK_BY_BITS[bits] ?? UNKNOWN_QUANTIZATION_RANK - 1;
}

function getPositiveSizeForSort(entry: HuggingFaceSibling | HuggingFaceTreeEntry): number {
  const size = getFileSize(entry);
  return typeof size === 'number' && size > 0 ? size : Number.MAX_SAFE_INTEGER;
}

