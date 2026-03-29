export const HF_BASE_URL = 'https://huggingface.co';
export const DEFAULT_HF_REVISION = 'main';

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

function encodePathSegments(path: string): string {
  return path
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

export function normalizeHuggingFaceRevision(revision: string | null | undefined): string | undefined {
  if (typeof revision !== 'string') {
    return undefined;
  }

  const trimmed = revision.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function resolveHuggingFaceRevision(revision: string | null | undefined): string {
  return normalizeHuggingFaceRevision(revision) ?? DEFAULT_HF_REVISION;
}

export function getHuggingFaceModelUrl(modelId: string): string {
  return `${HF_BASE_URL}/${encodePathSegments(modelId)}`;
}

export function buildHuggingFaceModelApiUrl(modelId: string): string {
  return `${HF_BASE_URL}/api/models/${encodePathSegments(modelId)}`;
}

export function buildHuggingFaceTreeUrl(
  modelId: string,
  revision: string | null | undefined,
): string {
  return `${buildHuggingFaceModelApiUrl(modelId)}/tree/${encodePathSegment(
    resolveHuggingFaceRevision(revision),
  )}?recursive=true`;
}

export function buildHuggingFaceResolveUrl(
  modelId: string,
  filePath: string,
  revision: string | null | undefined,
): string {
  return `${getHuggingFaceModelUrl(modelId)}/resolve/${encodePathSegment(
    resolveHuggingFaceRevision(revision),
  )}/${encodePathSegments(filePath)}`;
}

export function buildHuggingFaceRawUrl(
  modelId: string,
  filePath: string,
  revision: string | null | undefined,
): string {
  return `${getHuggingFaceModelUrl(modelId)}/raw/${encodePathSegment(
    resolveHuggingFaceRevision(revision),
  )}/${encodePathSegments(filePath)}`;
}
