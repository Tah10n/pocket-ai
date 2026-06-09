import type { ProjectorArtifact } from '../types/multimodal';
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

function sanitizePreviousModelFileSegment(value: string, fallback: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '_')
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

function getPreviousModelDownloadFileName(
  model: Pick<ModelMetadata, 'id' | 'resolvedFileName' | 'hfRevision'>,
): string | undefined {
  // Keep paused downloads from earlier builds resumable after tightening filename sanitation.
  const extensionMatch = model.resolvedFileName?.match(/(\.[A-Za-z0-9]+)$/);
  const extension = extensionMatch?.[1]?.toLowerCase() ?? '.gguf';
  const repoName = sanitizePreviousModelFileSegment(getShortModelLabel(model.id) || model.id, 'model');
  const revision = sanitizePreviousModelFileSegment(model.hfRevision ?? 'main', 'main').slice(0, 16);
  const fingerprint = hashString([
    model.id,
    model.resolvedFileName ?? '',
    model.hfRevision ?? 'main',
  ].join('::'));
  const candidate = `${repoName}-${revision}-${fingerprint}${extension}`;

  return isValidLocalFileName(candidate) ? candidate : undefined;
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
  const previousGeneratedName = getPreviousModelDownloadFileName(model);
  const classicLegacyName = getClassicLegacyModelDownloadFileName(model.id);

  return Array.from(new Set([
    getModelDownloadFileName(model),
    ...(previousGeneratedName ? [previousGeneratedName] : []),
    ...(classicLegacyName ? [classicLegacyName] : []),
    getSanitizedLegacyModelDownloadFileName(model.id),
  ])).filter(isValidLocalFileName);
}

export function getProjectorDownloadFileName(
  projector: Pick<ProjectorArtifact, 'id' | 'repoId' | 'fileName' | 'hfRevision' | 'ownerModelId' | 'ownerVariantId'>,
): string {
  const extensionMatch = projector.fileName.match(/(\.[A-Za-z0-9]+)$/);
  const extension = extensionMatch?.[1]?.toLowerCase() ?? '.gguf';
  const fileBase = sanitizeModelFileSegment(
    projector.fileName.replace(/(\.[A-Za-z0-9]+)$/, ''),
    'projector',
  ).slice(0, 48);
  const repoName = sanitizeModelFileSegment(getShortModelLabel(projector.repoId) || projector.repoId, 'projector');
  const revision = sanitizeModelFileSegment(projector.hfRevision ?? 'main', 'main').slice(0, 16);
  const fingerprint = hashString([
    projector.id,
    projector.repoId,
    projector.ownerModelId,
    projector.ownerVariantId ?? '',
    projector.fileName,
    projector.hfRevision ?? 'main',
  ].join('::'));

  return `${repoName}-${fileBase}-${revision}-${fingerprint}${extension}`;
}

export function getCandidateProjectorDownloadFileNames(
  projector: Pick<ProjectorArtifact, 'id' | 'repoId' | 'fileName' | 'hfRevision' | 'ownerModelId' | 'ownerVariantId'>,
  options: { includeRawFileName?: boolean } = {},
): string[] {
  const includeRawFileName = options.includeRawFileName !== false;

  return Array.from(new Set([
    getProjectorDownloadFileName(projector),
    ...(includeRawFileName ? [projector.fileName] : []),
  ])).filter(isValidLocalFileName);
}
