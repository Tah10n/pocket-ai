import { getHuggingFaceModelUrl } from '@/services/ModelCatalogService';
import { ModelAccessState, LifecycleStatus, type ModelMetadata } from '@/types/models';
import { formatModelFileSize } from '@/utils/modelSize';

export type ModelDetailsTone = 'neutral' | 'primary' | 'info' | 'success' | 'warning' | 'error';

export interface ModelDetailsBadge {
  label: string;
  tone: 'neutral' | 'accent' | 'error' | 'success';
  iconName: string;
}

export interface ModelDetailsMetricItem {
  label: string;
  value: string;
  tone: ModelDetailsTone;
  iconName?: string;
}

export interface ModelDetailsMetadataItem {
  label: string;
  value: string;
}

type Translate = (key: string) => string;

export function getDetailToneTokens(tone: ModelDetailsTone) {
  if (tone === 'neutral') {
    return {
      shellClassName: 'border-outline-200 bg-background-0/80 dark:border-outline-700 dark:bg-background-950/55',
      iconWrapClassName: 'bg-background-100 dark:bg-background-800',
      iconClassName: 'text-typography-700 dark:text-typography-200',
      labelClassName: 'text-typography-600 dark:text-typography-300',
      valueClassName: 'text-typography-900 dark:text-typography-50',
    };
  }

  if (tone === 'success') {
    return {
      shellClassName: 'border-success-500/20 bg-success-500/10 dark:border-success-400/25 dark:bg-success-500/12',
      iconWrapClassName: 'bg-success-500/10 dark:bg-success-500/20',
      iconClassName: 'text-success-600 dark:text-success-300',
      labelClassName: 'text-success-700 dark:text-success-200',
      valueClassName: 'text-typography-900 dark:text-typography-50',
    };
  }

  if (tone === 'warning') {
    return {
      shellClassName: 'border-warning-300/80 bg-warning-50/95 dark:border-warning-800 dark:bg-warning-950/35',
      iconWrapClassName: 'bg-warning-100 dark:bg-warning-500/20',
      iconClassName: 'text-warning-700 dark:text-warning-200',
      labelClassName: 'text-warning-700 dark:text-warning-200',
      valueClassName: 'text-typography-900 dark:text-typography-50',
    };
  }

  if (tone === 'error') {
    return {
      shellClassName: 'border-error-500/20 bg-error-500/10 dark:border-error-400/25 dark:bg-error-500/12',
      iconWrapClassName: 'bg-error-500/10 dark:bg-error-500/20',
      iconClassName: 'text-error-600 dark:text-error-300',
      labelClassName: 'text-error-700 dark:text-error-200',
      valueClassName: 'text-typography-900 dark:text-typography-50',
    };
  }

  if (tone === 'info') {
    return {
      shellClassName: 'border-info-500/20 bg-info-500/10 dark:border-info-400/25 dark:bg-info-500/12',
      iconWrapClassName: 'bg-info-500/10 dark:bg-info-500/20',
      iconClassName: 'text-info-600 dark:text-info-300',
      labelClassName: 'text-info-700 dark:text-info-200',
      valueClassName: 'text-typography-900 dark:text-typography-50',
    };
  }

  return {
    shellClassName: 'border-primary-500/20 bg-primary-500/10 dark:border-primary-400/25 dark:bg-primary-500/12',
    iconWrapClassName: 'bg-primary-500/10 dark:bg-primary-500/20',
    iconClassName: 'text-primary-500',
    labelClassName: 'text-primary-700 dark:text-primary-200',
    valueClassName: 'text-typography-900 dark:text-typography-50',
  };
}

function formatCount(value: number | null | undefined, fallback: string): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return fallback;
  }

  return new Intl.NumberFormat().format(Math.round(value));
}

function extractModelParameterSizeLabel(signal: string): string | undefined {
  const normalizedSignal = signal.trim();
  if (!normalizedSignal) {
    return undefined;
  }

  const moeMatch = normalizedSignal.match(/(?:^|[^a-z0-9])(\d+x\d+(?:\.\d+)?)([bm])(?:[^a-z0-9]|$)/i);
  if (moeMatch) {
    return `${moeMatch[1]}${moeMatch[2].toUpperCase()}`;
  }

  const denseMatch = normalizedSignal.match(/(?:^|[^a-z0-9])(\d+(?:\.\d+)?)([bm])(?:[^a-z0-9]|$)/i);
  if (denseMatch) {
    return `${denseMatch[1]}${denseMatch[2].toUpperCase()}`;
  }

  return undefined;
}

function getModelParameterSizeLabel(model: ModelMetadata): string | undefined {
  const providedParameterSizeLabel = model.parameterSizeLabel?.trim();
  if (providedParameterSizeLabel) {
    return providedParameterSizeLabel;
  }

  const candidateSignals = [
    model.name,
    model.id,
    ...(model.baseModels ?? []),
  ];

  for (const signal of candidateSignals) {
    if (!signal) {
      continue;
    }

    const parameterSizeLabel = extractModelParameterSizeLabel(signal);
    if (parameterSizeLabel) {
      return parameterSizeLabel;
    }
  }

  return undefined;
}

function getModelTypeLabel(model: ModelMetadata): string | undefined {
  const normalizedModelType = model.modelType?.trim();
  return normalizedModelType && normalizedModelType.length > 0
    ? normalizedModelType
    : undefined;
}

function getArchitecturesLabel(model: ModelMetadata): string | undefined {
  const architectures = model.architectures
    ?.map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return architectures && architectures.length > 0
    ? architectures.join(', ')
    : undefined;
}

function getQuantFileLabel(model: ModelMetadata): string | undefined {
  const resolvedFileName = model.resolvedFileName?.trim();
  if (!resolvedFileName || resolvedFileName === 'model.gguf') {
    return undefined;
  }

  const fileNameSegments = resolvedFileName.split('/').filter(Boolean);
  return fileNameSegments[fileNameSegments.length - 1];
}

export function createModelDetailsPlaceholder(modelId: string): ModelMetadata {
  return {
    id: modelId,
    name: modelId.split('/').pop() || modelId,
    author: modelId.split('/')[0] || 'unknown',
    size: null,
    downloadUrl: getHuggingFaceModelUrl(modelId),
    fitsInRam: null,
    accessState: ModelAccessState.PUBLIC,
    isGated: false,
    isPrivate: false,
    lifecycleStatus: LifecycleStatus.AVAILABLE,
    downloadProgress: 0,
  };
}

export function getModelDetailsAccessStateLabel(
  accessState: ModelAccessState | undefined,
  t: Translate,
): string {
  if (accessState === ModelAccessState.AUTH_REQUIRED) {
    return t('models.requiresToken');
  }

  if (accessState === ModelAccessState.ACCESS_DENIED) {
    return t('models.accessDenied');
  }

  if (accessState === ModelAccessState.AUTHORIZED) {
    return t('models.accessAuthorized');
  }

  if (accessState === ModelAccessState.PUBLIC) {
    return t('models.accessPublic');
  }

  return t('models.statusUnknown');
}

export function getModelDetailsAccessBadge(
  accessState: ModelAccessState | undefined,
  t: Translate,
): ModelDetailsBadge {
  if (accessState === ModelAccessState.AUTH_REQUIRED) {
    return { label: t('models.requiresToken'), tone: 'accent', iconName: 'key' };
  }

  if (accessState === ModelAccessState.ACCESS_DENIED) {
    return { label: t('models.accessDenied'), tone: 'error', iconName: 'block' };
  }

  if (accessState === ModelAccessState.AUTHORIZED) {
    return { label: t('models.accessAuthorized'), tone: 'success', iconName: 'verified-user' };
  }

  if (accessState === ModelAccessState.PUBLIC) {
    return { label: t('models.accessPublic'), tone: 'neutral', iconName: 'public' };
  }

  return { label: t('models.statusUnknown'), tone: 'neutral', iconName: 'help-outline' };
}

export function buildModelDetailsHeroMetrics(
  model: ModelMetadata,
  t: Translate,
): ModelDetailsMetricItem[] {
  const accessStateLabel = getModelDetailsAccessStateLabel(model.accessState, t);
  const accessTone: ModelDetailsTone = model.accessState === ModelAccessState.ACCESS_DENIED
    ? 'warning'
    : model.accessState === ModelAccessState.AUTHORIZED
      ? 'success'
      : model.accessState === ModelAccessState.PUBLIC
        ? 'info'
        : 'primary';

  return [
    {
      label: t('models.fileSizeLabel'),
      value: formatModelFileSize(model.size, t('models.sizeUnknown')),
      iconName: 'storage',
      tone: 'success',
    },
    {
      label: t('models.accessLabel'),
      value: accessStateLabel,
      iconName: 'lock',
      tone: accessTone,
    },
    {
      label: t('models.downloadsLabel'),
      value: formatCount(model.downloads, t('models.metricUnavailable')),
      iconName: 'download',
      tone: 'info',
    },
    {
      label: t('models.likesLabel'),
      value: formatCount(model.likes, t('models.metricUnavailable')),
      iconName: 'favorite',
      tone: 'error',
    },
  ];
}

export function buildModelDetailsMetadataMetrics(
  model: ModelMetadata,
  t: Translate,
): ModelDetailsMetadataItem[] {
  return [
    { label: t('models.modelSizeLabel'), value: getModelParameterSizeLabel(model) },
    { label: t('models.quantFileLabel'), value: getQuantFileLabel(model) },
    { label: t('models.typeLabel'), value: getModelTypeLabel(model) },
    { label: t('models.architecturesLabel'), value: getArchitecturesLabel(model) },
    { label: t('models.baseModelsLabel'), value: model.baseModels?.join(', ') },
    { label: t('models.licenseLabel'), value: model.license },
    { label: t('models.languagesLabel'), value: model.languages?.join(', ') },
    { label: t('models.datasetsLabel'), value: model.datasets?.join(', ') },
    { label: t('models.quantizedByLabel'), value: model.quantizedBy },
    { label: t('models.modelCreatorLabel'), value: model.modelCreator },
  ].filter((item): item is ModelDetailsMetadataItem => (
    typeof item.value === 'string' && item.value.trim().length > 0
  ));
}

function normalizeTagValue(value: string): string {
  return value.trim().toLowerCase();
}

export function getModelDetailsTagTone(
  tag: string,
  datasets?: string[],
): 'neutral' | 'accent' | 'success' | 'info' | 'warning' {
  const normalized = normalizeTagValue(tag);
  const normalizedDatasetTag = normalized.startsWith('dataset:')
    ? normalized.slice('dataset:'.length)
    : normalized.startsWith('datasets:')
      ? normalized.slice('datasets:'.length)
      : normalized;
  const datasetValues = new Set((datasets ?? []).map(normalizeTagValue));

  if (
    normalized.startsWith('dataset:')
    || normalized.startsWith('datasets:')
    || datasetValues.has(normalized)
    || datasetValues.has(normalizedDatasetTag)
  ) {
    return 'warning';
  }

  const isFormatTag = normalized.includes('gguf')
    || normalized.includes('ggml')
    || normalized.includes('awq')
    || normalized.includes('gptq')
    || normalized.includes('exl2')
    || normalized.includes('mlx')
    || normalized.includes('quant')
    || normalized.includes('int4')
    || normalized.includes('int8')
    || normalized.includes('fp16')
    || normalized.includes('bf16')
    || /^q\d(_|$)/.test(normalized);

  if (isFormatTag) {
    return 'accent';
  }

  const isCapabilityTag = normalized.includes('chat')
    || normalized.includes('assistant')
    || normalized.includes('instruct')
    || normalized.includes('text-generation')
    || normalized.includes('conversational')
    || normalized.includes('tool')
    || normalized.includes('function')
    || normalized.includes('agent')
    || normalized.includes('coding')
    || normalized.includes('code')
    || normalized.includes('reasoning')
    || normalized.includes('roleplay');

  if (isCapabilityTag) {
    return 'success';
  }

  const languageTagValues = new Set([
    'en', 'de', 'fr', 'es', 'ru', 'zh', 'ja', 'ko', 'it', 'pt', 'tr', 'vi', 'id',
    'pl', 'uk', 'ar', 'hi', 'nl', 'cs', 'sv', 'ro', 'hu', 'fi', 'da', 'no',
    'english', 'german', 'french', 'spanish', 'russian', 'chinese', 'japanese',
    'korean', 'italian', 'portuguese', 'turkish', 'vietnamese', 'indonesian',
    'polish', 'ukrainian', 'arabic', 'hindi', 'dutch', 'czech', 'swedish',
    'romanian', 'hungarian', 'finnish', 'danish', 'norwegian', 'multilingual',
  ]);
  const languageValue = normalized.startsWith('language:')
    ? normalized.slice('language:'.length)
    : normalized;

  if (languageTagValues.has(languageValue)) {
    return 'info';
  }

  return 'neutral';
}
