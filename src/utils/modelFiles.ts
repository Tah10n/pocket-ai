import type { ModelMetadata } from '../types/models';
import { getShortModelLabel } from './modelLabel';
import { isValidLocalFileName } from './safeFilePath';

export function sanitizeModelFileSegment(value: string, fallback: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  return sanitized.length > 0 ? sanitized : fallback;
}

function hashString(value: string): string {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
}

export function getModelDownloadFileName(
  model: Pick<ModelMetadata, 'id' | 'resolvedFileName' | 'hfRevision'>,
): string {
  const extensionMatch = model.resolvedFileName?.match(/(\.[A-Za-z0-9]+)$/);
  const extension = extensionMatch?.[1]?.toLowerCase() ?? '.gguf';
  const repoName = sanitizeModelFileSegment(getShortModelLabel(model.id) || model.id, 'model');
  const revision = sanitizeModelFileSegment(model.hfRevision ?? 'main', 'main').slice(0, 16);
  const fingerprint = hashString([
    model.id,
    model.resolvedFileName ?? '',
    model.hfRevision ?? 'main',
  ].join('::'));

  return `${repoName}-${revision}-${fingerprint}${extension}`;
}

function getClassicLegacyModelDownloadFileName(modelId: string): string | undefined {
  const legacyBase = modelId.replace(/\//g, '_');
  const candidate = `${legacyBase}.gguf`;

  return isValidLocalFileName(candidate) ? candidate : undefined;
}

function getSanitizedLegacyModelDownloadFileName(modelId: string): string {
  const legacyBase = modelId.replace(/\//g, '_');
  const sanitizedBase = sanitizeModelFileSegment(legacyBase, 'model');
  const candidate = `${sanitizedBase}.gguf`;

  if (sanitizedBase === legacyBase && isValidLocalFileName(candidate)) {
    return candidate;
  }

  return `${sanitizedBase}-${hashString(modelId)}.gguf`;
}

export function getLegacyModelDownloadFileName(modelId: string): string {
  return getClassicLegacyModelDownloadFileName(modelId) ?? getSanitizedLegacyModelDownloadFileName(modelId);
}

export function getCandidateModelDownloadFileNames(
  model: Pick<ModelMetadata, 'id' | 'resolvedFileName' | 'hfRevision'>,
): string[] {
  const classicLegacyName = getClassicLegacyModelDownloadFileName(model.id);

  return Array.from(new Set([
    getModelDownloadFileName(model),
    ...(classicLegacyName ? [classicLegacyName] : []),
    getSanitizedLegacyModelDownloadFileName(model.id),
  ])).filter(isValidLocalFileName);
}
