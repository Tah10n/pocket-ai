import type {
  ModelArtifactMetadata,
  ModelMetadata,
  ModelSpeculativeDecodingConfig,
} from '../types/models';
import { resolveActiveModelVariant } from './activeModelVariant';

const MTP_SIGNAL_PATTERNS = [
  /(?:^|[^a-z0-9])mtp(?:$|[^a-z0-9])/iu,
  /(?:^|[^a-z0-9])next[-_ ]?n(?:$|[^a-z0-9])/iu,
  /multi[-_ ]?token[-_ ]?prediction/iu,
] as const;

const MTP_METADATA_KEYS = [
  'nextn_predict_layers',
  'next_n_predict_layers',
  'num_nextn_predict_layers',
  'num_next_n_predict_layers',
  'nextn_block_count',
  'next_n_block_count',
  'mtp_block_count',
  'mtp_depth',
  'mtp_layers',
  'mtp_num_layers',
] as const;

function normalizeMetadataKey(value: string): string {
  return value.trim().toLowerCase().replace(/[.\- ]/gu, '_');
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

function normalizeFilePath(value: string): string {
  return value.trim().replace(/\\/gu, '/');
}

function getBaseFileName(value: string): string {
  return normalizeFilePath(value).split('/').filter(Boolean).at(-1) ?? '';
}

function hashString(value: string): string {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
}

export function hasMtpSignal(value: string | null | undefined): boolean {
  if (typeof value !== 'string') {
    return false;
  }

  return MTP_SIGNAL_PATTERNS.some((pattern) => pattern.test(value.trim()));
}

export function isMtpGgufFileName(fileName: string): boolean {
  const normalized = normalizeFilePath(fileName);
  return normalized.toLowerCase().endsWith('.gguf') && hasMtpSignal(normalized);
}

export function isExplicitMtpDraftFileName(fileName: string): boolean {
  const normalizedPath = normalizeFilePath(fileName).toLowerCase();
  const segments = normalizedPath.split('/').filter(Boolean);
  const baseName = segments.at(-1) ?? '';
  const directorySegments = segments.slice(0, -1);

  return directorySegments.some((segment) => segment === 'mtp' || segment === 'nextn' || segment === 'draft')
    || /^(?:mtp|nextn|draft|drafter)[-_.]/iu.test(baseName)
    || /(?:^|[-_.])(?:assistant|drafter)(?:[-_.]|$)/iu.test(baseName);
}

export function hasMtpMetadata(
  value: unknown,
  seen: Set<object> = new Set(),
): boolean {
  if (!value || typeof value !== 'object' || seen.has(value)) {
    return false;
  }

  seen.add(value);
  const record = value as Record<string, unknown>;
  if (Object.entries(record).some(([key, entry]) => {
    const normalizedKey = normalizeMetadataKey(key);
    return MTP_METADATA_KEYS.some((candidate) => (
      normalizedKey === candidate || normalizedKey.endsWith(`_${candidate}`)
    )) && hasPositiveNumericValue(entry);
  })) {
    return true;
  }

  return hasMtpMetadata(record.text_config, seen);
}

export function resolveMtpMaxDraftTokens(fileName: string | null | undefined): number {
  const baseName = getBaseFileName(fileName ?? '').toUpperCase();
  if (/(?:^|[._-])(?:IQ[1-7]|Q[1-7](?:_|[.-]))/u.test(baseName)) {
    return 1;
  }

  return 3;
}

export function buildMtpDraftArtifactId({
  repoId,
  hfRevision,
  fileName,
}: {
  repoId: string;
  hfRevision?: string;
  fileName: string;
}): string {
  const identity = [repoId.trim(), hfRevision?.trim() ?? 'main', normalizeFilePath(fileName)].join('::');
  return `mtp-draft-${hashString(identity)}`;
}

export function buildEmbeddedMtpConfig(
  fileName: string,
  enabled = true,
): ModelSpeculativeDecodingConfig {
  return {
    type: 'mtp',
    mode: 'embedded',
    enabled,
    maxDraftTokens: resolveMtpMaxDraftTokens(fileName),
  };
}

export function buildDraftModelMtpConfig(
  artifact: Pick<ModelArtifactMetadata, 'id' | 'remoteFileName'>,
  enabled = true,
): ModelSpeculativeDecodingConfig {
  return {
    type: 'mtp',
    mode: 'draft_model',
    enabled,
    maxDraftTokens: resolveMtpMaxDraftTokens(artifact.remoteFileName),
    draftArtifactId: artifact.id,
  };
}

export function normalizeModelSpeculativeDecodingConfig(
  value: unknown,
): ModelSpeculativeDecodingConfig | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const mode = record.mode === 'embedded' || record.mode === 'draft_model'
    ? record.mode
    : undefined;
  const maxDraftTokens = typeof record.maxDraftTokens === 'number' && Number.isFinite(record.maxDraftTokens)
    ? Math.max(1, Math.min(8, Math.round(record.maxDraftTokens)))
    : undefined;
  const draftArtifactId = typeof record.draftArtifactId === 'string' && record.draftArtifactId.trim().length > 0
    ? record.draftArtifactId.trim()
    : undefined;
  const enabled = record.enabled === undefined
    ? true
    : typeof record.enabled === 'boolean'
      ? record.enabled
      : false;
  if (
    record.type !== 'mtp'
    || !mode
    || maxDraftTokens === undefined
    || (mode === 'draft_model' && !draftArtifactId)
  ) {
    return undefined;
  }

  return {
    type: 'mtp',
    mode,
    // Older records did not persist this field, so absence keeps the historical
    // catalog default. Any present non-boolean value fails closed instead of
    // being re-enabled later by legacy draft-artifact capability recovery.
    enabled,
    maxDraftTokens,
    ...(mode === 'draft_model' && draftArtifactId ? { draftArtifactId } : {}),
  };
}

export function resolveEffectiveSpeculativeDecoding(
  model: Partial<Pick<
    ModelMetadata,
    'activeVariantId' | 'artifacts' | 'resolvedFileName' | 'variants' | 'speculativeDecoding'
  >>,
): ModelSpeculativeDecodingConfig | undefined {
  const activeVariant = resolveActiveModelVariant({
    activeVariantId: model.activeVariantId,
    resolvedFileName: model.resolvedFileName,
    variants: model.variants,
  });
  const explicitConfig = activeVariant
    ? activeVariant.speculativeDecoding
    : model.speculativeDecoding;
  if (explicitConfig) {
    return explicitConfig;
  }

  // Older persisted records can retain the canonical companion artifact while
  // missing the derived per-variant config. A single speculative-draft artifact
  // is already an explicit capability signal, so reconstruct the derived config
  // instead of hiding a companion that the runtime can load. Do not guess when
  // corrupt or future metadata contains more than one unassociated draft.
  const draftArtifacts = model.artifacts?.filter((artifact) => artifact.kind === 'speculative_draft') ?? [];
  if (draftArtifacts.length !== 1) {
    return undefined;
  }

  const [draftArtifact] = draftArtifacts;
  const persistedDraftConfig = model.speculativeDecoding?.mode === 'draft_model'
    && model.speculativeDecoding.draftArtifactId === draftArtifact.id
    ? model.speculativeDecoding
    : undefined;
  return buildDraftModelMtpConfig(draftArtifact, persistedDraftConfig?.enabled ?? true);
}

export function resolveSpeculativeDecodingWithEnabledOverride(
  model: Parameters<typeof resolveEffectiveSpeculativeDecoding>[0],
  enabledOverride?: boolean,
): ModelSpeculativeDecodingConfig | undefined {
  const config = resolveEffectiveSpeculativeDecoding(model);
  if (!config || typeof enabledOverride !== 'boolean') {
    return config;
  }

  return {
    ...config,
    enabled: enabledOverride,
  };
}

export function getConfiguredMtpDraftArtifact(
  model: Pick<ModelMetadata, 'artifacts'> & Partial<Pick<
    ModelMetadata,
    'activeVariantId' | 'resolvedFileName' | 'variants' | 'speculativeDecoding'
  >>,
): ModelArtifactMetadata | undefined {
  const config = resolveEffectiveSpeculativeDecoding(model);
  if (config?.mode !== 'draft_model' || !config.draftArtifactId) {
    return undefined;
  }

  return model.artifacts?.find((artifact) => (
    artifact.kind === 'speculative_draft' && artifact.id === config.draftArtifactId
  ));
}

export function getSelectedMtpDraftArtifact(
  model: Parameters<typeof getConfiguredMtpDraftArtifact>[0],
  enabledOverride?: boolean,
): ModelArtifactMetadata | undefined {
  const config = resolveSpeculativeDecodingWithEnabledOverride(model, enabledOverride);
  return config?.enabled === true
    ? getConfiguredMtpDraftArtifact(model)
    : undefined;
}

export function isMtpDraftArtifactReady(
  model: Parameters<typeof getSelectedMtpDraftArtifact>[0],
  enabledOverride?: boolean,
): boolean {
  return getSelectedMtpDraftArtifact(model, enabledOverride)?.installState === 'installed';
}

/**
 * A persisted RAM decision may have been calculated with an optional MTP draft
 * that the current load can omit. Callers may skip the stale early block only
 * when a real draft association exists; the engine must still run its accurate
 * base-model memory policy before native initialization.
 */
export function canRecalculateMemoryFitWithoutOptionalMtpDraft(
  model: Parameters<typeof getConfiguredMtpDraftArtifact>[0],
  enabledOverride?: boolean,
): boolean {
  const catalogConfig = resolveEffectiveSpeculativeDecoding(model);
  const effectiveConfig = resolveSpeculativeDecodingWithEnabledOverride(model, enabledOverride);

  return catalogConfig?.mode === 'draft_model'
    && getConfiguredMtpDraftArtifact(model) !== undefined
    && (catalogConfig.enabled === true || effectiveConfig?.enabled === true);
}
