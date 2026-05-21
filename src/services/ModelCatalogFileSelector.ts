import type { ModelMetadata, ModelVariant } from '../types/models';
import type {
  HuggingFaceModelConfig,
  HuggingFaceModelSummary,
  HuggingFaceSibling,
  HuggingFaceTreeEntry,
} from '../types/huggingFace';
import { normalizeSha256Digest } from '../utils/sha256';

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

const UNSUPPORTED_MTP_SIGNAL_PATTERNS = [
  /(?:^|[^a-z0-9])mtp(?:$|[^a-z0-9])/i,
  /(?:^|[^a-z0-9])next[-_ ]?n(?:$|[^a-z0-9])/i,
  /multi[-_ ]?token[-_ ]?prediction/i,
] as const;

const UNSUPPORTED_MTP_METADATA_KEYS = [
  'nextn_predict_layers',
  'next_n_predict_layers',
  'num_nextn_predict_layers',
  'num_next_n_predict_layers',
  'mtp_depth',
  'mtp_layers',
  'mtp_num_layers',
] as const;

export function filterCatalogSearchModels(models: ModelMetadata[]): ModelMetadata[] {
  return models.filter((model) => isCatalogModelSupported(model));
}

export function isCatalogSummarySupported(item: HuggingFaceModelSummary): boolean {
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
}): boolean {
  const pipelineTag = normalizeCatalogSignal(options.pipelineTag);
  if (pipelineTag && EXCLUDED_CATALOG_PIPELINE_TAGS.has(pipelineTag)) {
    return true;
  }

  if (
    hasUnsupportedMtpConfig(options.config)
    || hasUnsupportedMtpMetadata(options.ggufMetadata)
  ) {
    return true;
  }

  const signals = [
    ...normalizeCatalogSignals(options.identifiers),
    ...normalizeCatalogSignals(options.tags),
    ...normalizeCatalogSignals(options.modelTypes),
    ...normalizeCatalogSignals(options.architectures),
  ];

  return signals.some((signal) => (
    EXCLUDED_CATALOG_PIPELINE_TAGS.has(signal)
    || EXCLUDED_CATALOG_SIGNAL_EXACT_MATCHES.has(signal)
    || EXCLUDED_CATALOG_SIGNAL_FRAGMENTS.some((fragment) => signal.includes(fragment))
    || hasUnsupportedMtpSignal(signal)
  ));
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

function hasUnsupportedMtpSignal(value: string): boolean {
  return UNSUPPORTED_MTP_SIGNAL_PATTERNS.some((pattern) => pattern.test(value));
}

function hasPositiveNumericValue(value: unknown): boolean {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0;
  }

  if (typeof value === 'string') {
    const normalized = Number(value.trim());
    return Number.isFinite(normalized) && normalized > 0;
  }

  return false;
}

function normalizeMetadataKey(value: string): string {
  return value.trim().toLowerCase().replace(/[.\- ]/g, '_');
}

function isUnsupportedMtpMetadataKey(key: string): boolean {
  const normalizedKey = normalizeMetadataKey(key);
  return UNSUPPORTED_MTP_METADATA_KEYS.some((candidate) => (
    normalizedKey === candidate || normalizedKey.endsWith(`_${candidate}`)
  ));
}

function hasUnsupportedMtpMetadata(metadata: Record<string, unknown> | undefined): boolean {
  if (!metadata) {
    return false;
  }

  return Object.entries(metadata).some(([key, value]) => (
    isUnsupportedMtpMetadataKey(key) && hasPositiveNumericValue(value)
  ));
}

function hasUnsupportedMtpConfig(
  config: HuggingFaceModelConfig | undefined,
  seen: Set<HuggingFaceModelConfig> = new Set(),
): boolean {
  if (!config || seen.has(config)) {
    return false;
  }

  seen.add(config);

  if (hasUnsupportedMtpMetadata(config as Record<string, unknown>)) {
    return true;
  }

  return hasUnsupportedMtpConfig(config.text_config, seen);
}

export function selectTreeEntryForModel(model: ModelMetadata, entries: HuggingFaceTreeEntry[]): HuggingFaceTreeEntry | undefined {
  if (model.resolvedFileName) {
    const exactMatch = entries.find((entry) => getFileName(entry) === model.resolvedFileName);
    if (exactMatch && isEligibleGgufEntry(exactMatch)) {
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
    .filter((entry) => isEligibleGgufEntry(entry))
    .sort(compareCatalogGgufEntries);
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
    .filter((entry) => isEligibleGgufEntry(entry))
    .map((entry) => {
      const fileName = getFileName(entry);
      return {
        variantId: fileName,
        fileName,
        quantizationLabel: resolveQuantizationLabel(fileName) ?? 'GGUF',
        size: getFileSize(entry),
        sha256: getFileSha(entry),
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

export function isProjectorFileName(fileName: string): boolean {
  const normalizedPath = fileName.trim().toLowerCase();
  const normalized = normalizedPath.split(/[\\/]/).pop() ?? normalizedPath;
  return /(^|[._-])(mmproj|mm_projector|clip-projector|clip_projector)([._-]|$)/.test(normalized);
}

export function isUnsupportedMtpFileName(fileName: string): boolean {
  return hasUnsupportedMtpSignal(fileName.trim());
}

export function isSupportedGgufFileName(fileName: string): boolean {
  const normalized = fileName.trim();
  return normalized.toLowerCase().endsWith('.gguf')
    && !isProjectorFileName(normalized)
    && !isUnsupportedMtpFileName(normalized);
}

export function isEligibleGgufEntry(entry: HuggingFaceSibling | HuggingFaceTreeEntry): boolean {
  const name = getFileName(entry);
  if (!isSupportedGgufFileName(name)) {
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

