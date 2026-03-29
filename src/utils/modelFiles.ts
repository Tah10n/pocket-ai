import type { ModelMetadata } from '../types/models';

function sanitizeFileSegment(value: string, fallback: string): string {
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
  const repoName = sanitizeFileSegment(model.id.split('/').pop() ?? model.id, 'model');
  const revision = sanitizeFileSegment(model.hfRevision ?? 'main', 'main').slice(0, 16);
  const fingerprint = hashString([
    model.id,
    model.resolvedFileName ?? '',
    model.hfRevision ?? 'main',
  ].join('::'));

  return `${repoName}-${revision}-${fingerprint}${extension}`;
}

export function getLegacyModelDownloadFileName(modelId: string): string {
  return `${modelId.replace(/\//g, '_')}.gguf`;
}

export function getCandidateModelDownloadFileNames(
  model: Pick<ModelMetadata, 'id' | 'resolvedFileName' | 'hfRevision'>,
): string[] {
  return Array.from(new Set([
    getModelDownloadFileName(model),
    getLegacyModelDownloadFileName(model.id),
  ]));
}
