export const HF_BASE_URL = 'https://huggingface.co';
export const HF_HOSTNAME = 'huggingface.co';
export const HF_SHORT_HOSTNAME = 'hf.co';
export const DEFAULT_HF_REVISION = 'main';

export type RemoteProjectorIdentity = {
  repoId: string;
  revision: string;
  filePath: string;
};

const HUGGING_FACE_RESOLVE_HOSTNAMES = new Set([HF_HOSTNAME, HF_SHORT_HOSTNAME]);
const INVALID_REMOTE_PATH_SEGMENTS = new Set(['', '.', '..']);
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

export function hasHuggingFaceHostname(url: unknown): boolean {
  if (typeof url !== 'string') {
    return false;
  }

  try {
    const parsedHostname = new URL(url).hostname.toLowerCase();
    const hostname = parsedHostname.endsWith('.')
      ? parsedHostname.slice(0, -1)
      : parsedHostname;
    return (
      hostname === HF_HOSTNAME
      || hostname.endsWith(`.${HF_HOSTNAME}`)
      || hostname === HF_SHORT_HOSTNAME
      || hostname.endsWith(`.${HF_SHORT_HOSTNAME}`)
    );
  } catch {
    return false;
  }
}

function normalizeRemotePathSegments(segments: readonly string[]): string | null {
  if (
    segments.length === 0
    || segments.some((segment) => (
      INVALID_REMOTE_PATH_SEGMENTS.has(segment)
      || segment.trim().length === 0
      || CONTROL_CHARACTER_PATTERN.test(segment)
    ))
  ) {
    return null;
  }

  return segments.join('/');
}

function normalizeRemotePath(value: string): string | null {
  const trimmed = value.trim();
  if (
    !trimmed
    || trimmed.startsWith('/')
    || trimmed.endsWith('/')
    || /^[A-Za-z]:[\\/]/u.test(trimmed)
  ) {
    return null;
  }

  const normalized = trimmed
    .replace(/\\+/gu, '/')
    .replace(/\/+/gu, '/');
  return normalizeRemotePathSegments(normalized.split('/'));
}

function decodeUrlPathSegment(segment: string, options: { allowSlash?: boolean } = {}): string | null {
  try {
    const decoded = decodeURIComponent(segment);
    if (
      CONTROL_CHARACTER_PATTERN.test(decoded)
      || decoded.includes('\\')
      || (options.allowSlash !== true && decoded.includes('/'))
    ) {
      return null;
    }

    return decoded;
  } catch {
    return null;
  }
}

function normalizeResolvedRevision(value: string): string | null {
  const normalized = value.trim();
  if (!normalized || CONTROL_CHARACTER_PATTERN.test(normalized) || normalized.includes('\\')) {
    return null;
  }

  const segments = normalized.split('/');
  return segments.some((segment) => INVALID_REMOTE_PATH_SEGMENTS.has(segment))
    ? null
    : normalized;
}

function extractRawUrlPath(trimmedUrl: string): string | null {
  if (trimmedUrl.includes('\\') || CONTROL_CHARACTER_PATTERN.test(trimmedUrl)) {
    return null;
  }

  const schemeSeparatorIndex = trimmedUrl.indexOf('://');
  if (schemeSeparatorIndex <= 0) {
    return null;
  }

  const pathStartIndex = trimmedUrl.indexOf('/', schemeSeparatorIndex + 3);
  const suffixStartIndexes = [trimmedUrl.indexOf('?'), trimmedUrl.indexOf('#')]
    .filter((index) => index >= 0);
  const pathEndIndex = suffixStartIndexes.length > 0
    ? Math.min(...suffixStartIndexes)
    : trimmedUrl.length;
  const rawPath = pathStartIndex >= 0 && pathStartIndex < pathEndIndex
    ? trimmedUrl.slice(pathStartIndex, pathEndIndex)
    : '';
  return rawPath.startsWith('/') && !rawPath.endsWith('/')
    ? rawPath
    : null;
}

function decodeRawUrlFilePath(rawPath: string): string | null {
  const decodedSegments = rawPath
    .split('/')
    .filter(Boolean)
    .map((segment) => decodeUrlPathSegment(segment));
  return decodedSegments.some((segment) => segment === null)
    ? null
    : normalizeRemotePathSegments(decodedSegments as string[]);
}

export function normalizeHuggingFaceRepoId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const repoId = normalizeRemotePath(value);
  return repoId?.split('/').length === 2 ? repoId : null;
}

export function normalizeHuggingFaceFilePath(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  return normalizeRemotePath(value);
}

export function isHuggingFaceUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && hasHuggingFaceHostname(url);
  } catch {
    return false;
  }
}

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

export function resolveHuggingFaceResolveIdentity(url: unknown): RemoteProjectorIdentity | null {
  if (typeof url !== 'string') {
    return null;
  }

  try {
    const trimmedUrl = url.trim();
    const parsed = new URL(trimmedUrl);
    const hostname = parsed.hostname.toLowerCase();
    if (
      parsed.protocol !== 'https:'
      || !HUGGING_FACE_RESOLVE_HOSTNAMES.has(hostname)
      || parsed.username.length > 0
      || parsed.password.length > 0
      || (parsed.port.length > 0 && parsed.port !== '443')
    ) {
      return null;
    }

    const rawPath = extractRawUrlPath(trimmedUrl);
    if (!rawPath) {
      return null;
    }

    const encodedSegments = rawPath.split('/').filter(Boolean);
    if (encodedSegments.length < 5 || encodedSegments[2] !== 'resolve') {
      return null;
    }

    const owner = decodeUrlPathSegment(encodedSegments[0] as string);
    const repository = decodeUrlPathSegment(encodedSegments[1] as string);
    const revision = decodeUrlPathSegment(encodedSegments[3] as string, { allowSlash: true });
    const fileSegments = encodedSegments.slice(4).map((segment) => decodeUrlPathSegment(segment));
    if (!owner || !repository || !revision || fileSegments.some((segment) => segment === null)) {
      return null;
    }

    const repoId = normalizeRemotePathSegments([owner, repository]);
    const filePath = normalizeRemotePathSegments(fileSegments as string[]);
    const resolvedRevision = normalizeResolvedRevision(revision);
    if (!repoId || !filePath || !resolvedRevision) {
      return null;
    }

    return {
      repoId,
      revision: resolvedRevision,
      filePath,
    };
  } catch {
    return null;
  }
}

function resolveOrdinaryHttpRemoteFilePath(url: unknown): string | null {
  if (typeof url !== 'string') {
    return null;
  }

  try {
    const trimmedUrl = url.trim();
    const parsed = new URL(trimmedUrl);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || !parsed.hostname
      || parsed.username.length > 0
      || parsed.password.length > 0
    ) {
      return null;
    }

    const rawPath = extractRawUrlPath(trimmedUrl);
    return rawPath ? decodeRawUrlFilePath(rawPath) : null;
  } catch {
    return null;
  }
}

export function resolveRemoteFilePathFromDownloadUrl(url: unknown): string | null {
  if (hasHuggingFaceHostname(url)) {
    return resolveHuggingFaceResolveIdentity(url)?.filePath ?? null;
  }

  return resolveOrdinaryHttpRemoteFilePath(url);
}

export function resolveRemoteProjectorIdentity({
  repoId,
  revision,
  filePath,
  downloadUrl,
}: {
  repoId: unknown;
  revision?: string | null;
  filePath: unknown;
  downloadUrl: unknown;
}): RemoteProjectorIdentity | null {
  const normalizedRepoId = normalizeHuggingFaceRepoId(repoId);
  const normalizedFilePath = normalizeHuggingFaceFilePath(filePath);
  const resolvedRevision = normalizeResolvedRevision(resolveHuggingFaceRevision(revision));
  const urlIdentity = resolveHuggingFaceResolveIdentity(downloadUrl);
  if (
    !normalizedRepoId
    || !normalizedFilePath
    || !resolvedRevision
    || !urlIdentity
    || urlIdentity.repoId !== normalizedRepoId
    || urlIdentity.revision !== resolvedRevision
    || urlIdentity.filePath !== normalizedFilePath
  ) {
    return null;
  }

  return urlIdentity;
}

export function hasConsistentRemoteProjectorIdentity({
  repoId,
  revision,
  filePath,
  downloadUrl,
}: {
  repoId: unknown;
  revision?: string | null;
  filePath: unknown;
  downloadUrl: unknown;
}): boolean {
  const normalizedRepoId = normalizeHuggingFaceRepoId(repoId);
  const normalizedFilePath = normalizeHuggingFaceFilePath(filePath);
  const resolvedRevision = normalizeResolvedRevision(resolveHuggingFaceRevision(revision));
  if (!normalizedRepoId || !normalizedFilePath || !resolvedRevision) {
    return false;
  }

  if (hasHuggingFaceHostname(downloadUrl)) {
    return resolveRemoteProjectorIdentity({ repoId, revision, filePath, downloadUrl }) !== null;
  }

  return resolveOrdinaryHttpRemoteFilePath(downloadUrl) === normalizedFilePath;
}

export function remoteProjectorIdentitiesEqual(
  left: RemoteProjectorIdentity,
  right: RemoteProjectorIdentity,
): boolean {
  return left.repoId === right.repoId
    && left.revision === right.revision
    && left.filePath === right.filePath;
}

export function remoteProjectorIdentityKey(identity: RemoteProjectorIdentity): string {
  return JSON.stringify([identity.repoId, identity.revision, identity.filePath]);
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
