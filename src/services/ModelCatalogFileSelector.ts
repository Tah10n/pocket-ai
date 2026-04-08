import type { ModelMetadata } from '../types/models';
import type { HuggingFaceModelSummary, HuggingFaceSibling, HuggingFaceTreeEntry } from '../types/huggingFace';

const MIN_GGUF_BYTES = 50 * 1024 * 1024;

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

export function filterCatalogSearchModels(models: ModelMetadata[]): ModelMetadata[] {
  return models.filter((model) => isCatalogModelSupported(model));
}

export function isCatalogSummarySupported(item: HuggingFaceModelSummary): boolean {
  return !hasUnsupportedCatalogSignals({
    pipelineTag: item.pipeline_tag,
    tags: item.tags,
    modelTypes: [
      item.config?.model_type,
      item.cardData?.model_type,
      item.gguf?.architecture,
    ],
    architectures: item.config?.architectures,
  });
}

export function isCatalogModelSupported(model: ModelMetadata): boolean {
  return !hasUnsupportedCatalogSignals({
    tags: model.tags,
    modelTypes: [model.modelType],
    architectures: model.architectures,
  });
}

function hasUnsupportedCatalogSignals(options: {
  pipelineTag?: string;
  tags?: string[];
  modelTypes?: (string | undefined)[];
  architectures?: string[];
}): boolean {
  const pipelineTag = normalizeCatalogSignal(options.pipelineTag);
  if (pipelineTag && EXCLUDED_CATALOG_PIPELINE_TAGS.has(pipelineTag)) {
    return true;
  }

  const signals = [
    ...normalizeCatalogSignals(options.tags),
    ...normalizeCatalogSignals(options.modelTypes),
    ...normalizeCatalogSignals(options.architectures),
  ];

  return signals.some((signal) => (
    EXCLUDED_CATALOG_PIPELINE_TAGS.has(signal)
    || EXCLUDED_CATALOG_SIGNAL_EXACT_MATCHES.has(signal)
    || EXCLUDED_CATALOG_SIGNAL_FRAGMENTS.some((fragment) => signal.includes(fragment))
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

export function selectTreeEntryForModel(model: ModelMetadata, entries: HuggingFaceTreeEntry[]): HuggingFaceTreeEntry | undefined {
  if (model.requiresTreeProbe !== true && model.resolvedFileName) {
    const exactMatch = entries.find((entry) => getFileName(entry) === model.resolvedFileName);
    if (exactMatch) {
      return exactMatch;
    }
  }

  return selectPreferredGgufEntry(entries);
}

export function shouldRevalidateCatalogSummarySelection(selectedEntry: HuggingFaceSibling): boolean {
  return getFileSize(selectedEntry) === null;
}

export function selectPreferredGgufEntry<T extends HuggingFaceSibling | HuggingFaceTreeEntry>(entries: T[]): T | undefined {
  const ggufs = entries.filter((entry) => isEligibleGgufEntry(entry));

  return ggufs.find((entry) => isPreferredQuantFileName(getFileName(entry))) ?? ggufs[0];
}

export function isPreferredQuantFileName(fileName: string): boolean {
  return fileName.toUpperCase().includes('Q4_K_M');
}

export function isProjectorFileName(fileName: string): boolean {
  const normalized = fileName.trim().toLowerCase();
  return /(^|[._-])(mmproj|mm_projector|clip-projector|clip_projector)([._-]|$)/.test(normalized);
}

export function isEligibleGgufEntry(entry: HuggingFaceSibling | HuggingFaceTreeEntry): boolean {
  const name = getFileName(entry);
  if (!name.toLowerCase().endsWith('.gguf')) {
    return false;
  }

  if (isProjectorFileName(name)) {
    return false;
  }
  const size = getFileSize(entry);
  return size === null || size >= MIN_GGUF_BYTES;
}

export function getFileName(entry: HuggingFaceSibling | HuggingFaceTreeEntry): string {
  return entry.rfilename || entry.filename || ('path' in entry ? entry.path : '') || '';
}

export function getFileSize(entry: HuggingFaceSibling | HuggingFaceTreeEntry | undefined): number | null {
  const size = entry?.size || entry?.lfs?.size;
  return typeof size === 'number' && size > 0 ? size : null;
}

export function getFileSha(entry: HuggingFaceSibling | HuggingFaceTreeEntry): string | undefined {
  const lfs = entry.lfs as { sha256?: string; oid?: string } | undefined;
  return lfs?.sha256 || lfs?.oid;
}

