import type { HuggingFaceModelSummary } from '../types/huggingFace';
import type { ModelRole, ModelRoleEvidence, ModelRoleValidation } from '../types/modelRoles';
import type { ModelGgufMetadata, ModelMetadata } from '../types/models';
import { resolveActiveModelVariant } from './activeModelVariant';
import { resolveHuggingFaceResolveIdentity } from './huggingFaceUrls';
import { normalizeSha256Digest } from './sha256';
import { isManagedCompanionFileName } from './modelProjectors';

export const MODEL_ROLES: readonly ModelRole[] = ['chat', 'embedding', 'reranker', 'tts'];
const sources = new Set<ModelRoleEvidence['source']>([
  'pipeline_tag', 'model_card', 'gguf_metadata', 'architecture', 'tag', 'filename', 'manual',
]);
const fileSources = new Set<ModelRoleEvidence['source']>(['filename', 'gguf_metadata']);

export function normalizeModelRoleEvidence(value: unknown): ModelRoleEvidence[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const result: ModelRoleEvidence[] = [];
  for (const entry of value.slice(0, 64)) {
    if (!entry || typeof entry !== 'object' || !MODEL_ROLES.includes(entry.role)
      || !sources.has(entry.source)
      || (entry.confidence !== 'declared' && entry.confidence !== 'inferred')) continue;
    // User choices and name/tag matches must never acquire metadata authority.
    const confidence = ['manual', 'filename', 'tag'].includes(entry.source)
      ? 'inferred' : entry.confidence;
    const fileIdentity = typeof entry.fileIdentity === 'string' && entry.fileIdentity.trim()
      && entry.fileIdentity.length <= 4096 ? entry.fileIdentity : undefined;
    // Legacy file evidence has no provable scope. Recompute from current file
    // data instead of promoting it to repository evidence or rebinding it.
    if (fileSources.has(entry.source) && !fileIdentity) continue;
    const key = `${entry.role}:${entry.source}:${confidence}:${fileIdentity ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ role: entry.role, source: entry.source, confidence,
      ...(fileIdentity ? { fileIdentity } : {}),
      ...(typeof entry.value === 'string' ? { value: entry.value.slice(0, 160) } : {}) });
  }
  return result.length ? result : undefined;
}

export function mergeModelRoleEvidence(...values: unknown[]): ModelRoleEvidence[] | undefined {
  const seenSources = new Set<string>();
  const merged: ModelRoleEvidence[] = [];
  for (const value of values) {
    const entries = normalizeModelRoleEvidence(value) ?? [];
    const scopeKey = (entry: ModelRoleEvidence) => `${entry.source}:${entry.fileIdentity ?? ''}`;
    merged.push(...entries.filter((entry) => !seenSources.has(scopeKey(entry))));
    entries.forEach((entry) => seenSources.add(scopeKey(entry)));
  }
  return normalizeModelRoleEvidence(merged);
}

/** Remote source identity, never a display name or private device path. */
export function getModelFileIdentity(model: Pick<ModelMetadata,
  'id' | 'downloadUrl' | 'hfRevision' | 'resolvedFileName' | 'sha256' | 'size'>): string {
  const remote = resolveHuggingFaceResolveIdentity(model.downloadUrl);
  return JSON.stringify([
    remote?.repoId ?? model.id,
    remote?.revision ?? null,
    remote?.filePath ?? model.downloadUrl,
    model.hfRevision ?? remote?.revision ?? 'main',
    model.resolvedFileName ?? remote?.filePath ?? model.downloadUrl,
    normalizeSha256Digest(model.sha256) ?? null,
    model.size ?? null,
  ]);
}

export function normalizeModelRoleValidation(
  value: unknown,
  model: Parameters<typeof getModelFileIdentity>[0],
): ModelRoleValidation[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const identity = getModelFileIdentity(model);
  const result = value.slice(0, 16).flatMap((entry): ModelRoleValidation[] => {
    if (!entry || typeof entry !== 'object' || !MODEL_ROLES.includes(entry.role)
      || entry.status !== 'passed' || entry.fileIdentity !== identity
      || typeof entry.runtimeVersion !== 'string' || entry.runtimeVersion.length > 80
      || !entry.runtimeVersion.trim() || !Number.isFinite(entry.checkedAt) || entry.checkedAt < 0
      || (entry.operation !== 'load' && entry.operation !== 'embedding')
      || (entry.operation === 'embedding' && entry.role !== 'embedding')) return [];
    return [{ role: entry.role, fileIdentity: identity, runtimeVersion: entry.runtimeVersion,
      checkedAt: entry.checkedAt, operation: entry.operation, status: 'passed' }];
  });
  return result.length ? result : undefined;
}

export function filterModelRoleEvidenceForFile(
  value: unknown, model: Parameters<typeof getModelFileIdentity>[0],
): ModelRoleEvidence[] | undefined {
  const identity = getModelFileIdentity(model);
  return normalizeModelRoleEvidence(normalizeModelRoleEvidence(value)?.filter((entry) => (
    entry.fileIdentity === undefined || entry.fileIdentity === identity
  )));
}

export function hasStaleModelGgufRoleEvidence(
  value: unknown, model: Parameters<typeof getModelFileIdentity>[0],
): boolean {
  if (!Array.isArray(value)) return false;
  // Inspect legacy entries before normalization drops missing identities. Raw
  // metadata beside those entries has no stronger provenance than the entries.
  const entries = value.filter((entry) => entry && typeof entry === 'object'
    && entry.source === 'gguf_metadata');
  const identity = getModelFileIdentity(model);
  return entries.length > 0 && !entries.some((entry) => entry.fileIdentity === identity);
}

function taskRole(value: string): ModelRole | undefined {
  switch (value.toLowerCase()) {
    case 'text-generation': case 'conversational': return 'chat';
    case 'feature-extraction': case 'sentence-similarity': case 'embedding': return 'embedding';
    case 'text-ranking': case 'reranking': case 'reranker': return 'reranker';
    case 'text-to-speech': case 'text-to-audio': case 'tts': return 'tts';
    default: return undefined;
  }
}

function nameRole(value: string): ModelRole | undefined {
  return /rerank/iu.test(value) ? 'reranker'
    : /embed|sentence[-_ ]?transformer/iu.test(value) ? 'embedding'
      : /(?:^|[-_ ])tts(?:[-_ .]|$)|texttospeech/iu.test(value) ? 'tts' : undefined;
}

/** Preserve unrelated GGUF metadata without recycling file-specific purpose. */
export function withoutModelGgufRoleMetadata(gguf: ModelGgufMetadata | undefined): ModelGgufMetadata | undefined {
  if (!gguf) return undefined;
  return Object.fromEntries(Object.entries(gguf).filter(([key, value]) => (
    key !== 'general.task' && key !== 'general.finetune' && !key.endsWith('.pooling_type')
    && !((key === 'architecture' || key === 'general.architecture')
      && typeof value === 'string' && nameRole(value))
  )));
}

export function inferModelRoleEvidence(
  model: Partial<ModelMetadata>,
  summary?: HuggingFaceModelSummary,
): ModelRoleEvidence[] | undefined {
  const evidence: ModelRoleEvidence[] = [];
  const addTask = (value: unknown, source: ModelRoleEvidence['source'], confidence: ModelRoleEvidence['confidence']) => {
    if (typeof value !== 'string') return;
    const role = taskRole(value);
    if (role) evidence.push({ role, source, confidence, value });
  };
  addTask(summary?.pipeline_tag, 'pipeline_tag', 'declared');
  addTask(summary?.cardData?.pipeline_tag, 'model_card', 'declared');
  addTask(model.gguf?.['general.finetune'], 'gguf_metadata', 'inferred');
  // Only an explicit GGUF task declaration is authoritative; architecture alone
  // cannot distinguish, for example, a chat decoder from its embedding variant.
  addTask(model.gguf?.['general.task'], 'gguf_metadata', 'declared');
  const architecture = model.gguf?.architecture ?? model.gguf?.['general.architecture'];
  const poolingType = typeof architecture === 'string' ? model.gguf?.[`${architecture}.pooling_type`] : undefined;
  // llama.rn 0.13.0-rc.3 bundles these llama_pooling_type values in cpp/llama.h.
  // A declared pooling head establishes purpose, not successful native execution.
  if (poolingType === 1 || poolingType === 2 || poolingType === 3 || poolingType === 4) {
    evidence.push({ role: poolingType === 4 ? 'reranker' : 'embedding',
      source: 'gguf_metadata', confidence: 'declared', value: `${architecture}.pooling_type=${poolingType}` });
  }
  for (const tag of summary?.tags ?? model.tags ?? []) addTask(tag, 'tag', 'inferred');
  const names: [unknown, ModelRoleEvidence['source']][] = [
    [model.resolvedFileName, 'filename'],
    ...((summary?.config?.architectures ?? model.architectures ?? []).map((name) => [name, 'architecture'] as [string, 'architecture'])),
    [summary?.cardData?.model_type ?? model.modelType, 'model_card'],
    [architecture, 'gguf_metadata'],
  ];
  for (const [value, source] of names) {
    if (typeof value !== 'string') continue;
    const role = nameRole(value);
    if (role) evidence.push({ role, source, confidence: 'inferred', value });
  }
  const fileIdentity = model.id && model.downloadUrl ? getModelFileIdentity({
    id: model.id, downloadUrl: model.downloadUrl, hfRevision: model.hfRevision,
    resolvedFileName: model.resolvedFileName, sha256: model.sha256, size: model.size ?? null,
  }) : undefined;
  return normalizeModelRoleEvidence(evidence.map((entry) => (
    fileIdentity && (entry.source === 'gguf_metadata' || entry.source === 'filename')
      ? { ...entry, fileIdentity } : entry
  )));
}

export function getModelRoleEvidence(model: ModelMetadata): ModelRoleEvidence[] {
  const variant = resolveActiveModelVariant(model);
  // Explicit variant evidence is more specific than the repository purpose.
  return filterModelRoleEvidenceForFile(
    mergeModelRoleEvidence(filterModelRoleEvidenceForFile(variant?.roleEvidence ?? model.roleEvidence, model),
      inferModelRoleEvidence(model)), model,
  ) ?? [];
}

export function isChatModelEligible(model: ModelMetadata): boolean {
  if (model.artifactRole === 'projector_companion') return false;
  if (model.resolvedFileName && isManagedCompanionFileName(model.resolvedFileName)) return false;
  const evidence = getModelRoleEvidence(model);
  if (evidence.some((entry) => entry.role === 'chat' && entry.confidence === 'declared')) return true;
  return !evidence.some((entry) => entry.role !== 'chat' && entry.confidence === 'declared');
}
