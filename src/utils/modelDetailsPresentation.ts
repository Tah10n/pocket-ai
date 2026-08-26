import { getHuggingFaceModelUrl } from '@/services/ModelCatalogService';
import type { MaterialSymbolName } from '@/components/ui/MaterialSymbols';
import { ModelAccessState, LifecycleStatus, type ModelMetadata } from '@/types/models';
import {
  getModelVisionCapabilityStatusLabelKey,
  resolveEffectiveActiveVariantNativeSupport,
} from '@/utils/modelCapabilities';
import { getShortModelLabel } from '@/utils/modelLabel';
import {
  formatModelFileSize,
  getModelDisplayArtifactSizeBytes,
  getModelDisplayProjectorCandidates,
  getModelDisplaySelectedProjectorId,
} from '@/utils/modelSize';
import { getActiveModelVariant } from '@/utils/modelVariants';

export type ModelDetailsTone = 'neutral' | 'primary' | 'info' | 'success' | 'warning' | 'error';

export interface ModelDetailsBadge {
  label: string;
  tone: 'neutral' | 'accent' | 'error' | 'success';
  iconName: MaterialSymbolName;
}

export interface ModelDetailsMetricItem {
  label: string;
  value: string;
  tone: ModelDetailsTone;
  iconName?: MaterialSymbolName;
}

export interface ModelDetailsMetadataItem {
  label: string;
  value: string;
}

type Translate = (key: string) => string;

const MARKDOWN_TABLE_DELIMITER_ROW = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/u;

function findMarkdownTableStart(value: string): number | null {
  const lines = value.split('\n');
  let lineOffset = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const nextLine = lines[index + 1];
    const pipeCount = line.match(/\|/g)?.length ?? 0;

    if (pipeCount >= 1 && nextLine && MARKDOWN_TABLE_DELIMITER_ROW.test(nextLine)) {
      return lineOffset + line.search(/\S/u);
    }

    // Some catalog descriptions collapse table rows onto one line. In that form,
    // an empty boundary cell separates rows; ordinary prose with pipe separators does not.
    if (pipeCount >= 6 && /\|\s*\|/u.test(line)) {
      const firstPipeIndex = line.indexOf('|');
      return lineOffset + Math.max(0, firstPipeIndex);
    }

    lineOffset += line.length + 1;
  }

  return null;
}

export function formatModelDetailsDescription(
  description: string | null | undefined,
): string | undefined {
  const source = description?.trim();
  if (!source) {
    return undefined;
  }

  let formatted = source
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ');

  const tableStart = findMarkdownTableStart(formatted);
  if (tableStart !== null) {
    const proseBeforeTable = formatted.slice(0, tableStart).trim();
    const tableText = formatted.slice(tableStart);

    if (proseBeforeTable) {
      formatted = proseBeforeTable;
    } else {
      formatted = tableText
        .split('\n')
        .filter((row) => !MARKDOWN_TABLE_DELIMITER_ROW.test(row))
        .flatMap((row) => row.split('|'))
        .map((cell) => cell.trim())
        .filter((cell) => cell.length > 0)
        .slice(0, 4)
        .join(' · ');
    }
  }

  formatted = formatted
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-+*]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/```[^\n]*\n?/g, '')
    .replace(/`/g, '')
    .replace(/\*\*|__|~~/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return formatted || undefined;
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
    name: getShortModelLabel(modelId) || modelId,
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
  const displaySize = getModelDisplayArtifactSizeBytes(model);
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
      value: formatModelFileSize(displaySize, t('models.sizeUnknown')),
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
  const activeVariant = getActiveModelVariant(model);
  const projectorCandidates = getModelDisplayProjectorCandidates(model);
  const selectedProjectorId = getModelDisplaySelectedProjectorId(model, projectorCandidates);
  const capabilityPresentationModel = activeVariant
    ? {
        ...model,
        chatModalities: activeVariant.chatModalities ?? model.chatModalities,
        artifactRole: activeVariant.artifactRole ?? model.artifactRole,
        visionSource: activeVariant.visionSource ?? model.visionSource,
        visionConfidence: activeVariant.visionConfidence ?? model.visionConfidence,
        projectorCandidates,
        selectedProjectorId,
      }
    : model;
  const visionStatusLabelKey = getModelVisionCapabilityStatusLabelKey(capabilityPresentationModel);
  const nativeSupport = resolveEffectiveActiveVariantNativeSupport(capabilityPresentationModel);
  const shouldShowProjectorCandidates = (
    (nativeSupport.vision || nativeSupport.audio)
    && (projectorCandidates?.length ?? 0) > 0
  );
  const projectorCandidateNames = shouldShowProjectorCandidates
    ? projectorCandidates
      ?.map((candidate) => candidate.fileName.trim())
      .filter((fileName) => fileName.length > 0)
      .join(', ')
    : undefined;

  return [
    { label: t('models.vision.capabilityLabel'), value: visionStatusLabelKey ? t(visionStatusLabelKey) : undefined },
    { label: t('models.multimodal.projectorCandidates'), value: projectorCandidateNames },
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
