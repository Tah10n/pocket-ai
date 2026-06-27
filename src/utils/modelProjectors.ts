import type { ModelArtifactRole, ProjectorArtifact } from '../types/multimodal';

const PROJECTOR_FILE_NAME_PATTERN =
  /(^|[._-])(mmproj|mm_projector|clip-projector|clip_projector)([._-]|$)/u;
const GGUF_EXTENSION_PATTERN = /\.gguf$/iu;
const QUANTIZATION_TOKEN_PATTERN =
  /^(q\d(?:_[a-z0-9]+)*|iq\d(?:_[a-z0-9]+)*|f16|fp16|bf16|q8(?:_[a-z0-9]+)?)$/iu;

function getBaseFileName(fileName: string): string {
  const normalizedPath = fileName.trim();
  return normalizedPath.split(/[\\/]/u).pop() ?? normalizedPath;
}

function normalizeFileName(fileName: string): string {
  return getBaseFileName(fileName).trim().toLowerCase();
}

function encodeProjectorPathIdentity(normalizedPath: string): string {
  const encodedPath = Array.from(normalizedPath)
    .map((character) => character.codePointAt(0)?.toString(16).padStart(2, '0') ?? '')
    .join('_');

  return `path-${encodedPath}`;
}

function normalizeProjectorArtifactFileIdentity(fileName: string): string | null {
  const normalized = fileName
    .trim()
    .replace(/\\+/gu, '/')
    .replace(/\/+/gu, '/')
    .replace(/^\/+|\/+$/gu, '')
    .toLowerCase();

  if (normalized.length === 0) {
    return null;
  }

  return normalized.includes('/') ? encodeProjectorPathIdentity(normalized) : normalized;
}

function toMatchTokens(fileName: string): string[] {
  const withoutExtension = normalizeFileName(fileName).replace(GGUF_EXTENSION_PATTERN, '');
  return withoutExtension
    .replace(/mm_projector|clip-projector|clip_projector|mmproj/giu, ' ')
    .split(/[^a-z0-9]+/iu)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0 && !QUANTIZATION_TOKEN_PATTERN.test(token));
}

function intersectCount(left: Set<string>, right: Set<string>): number {
  let count = 0;
  left.forEach((token) => {
    if (right.has(token)) {
      count += 1;
    }
  });
  return count;
}

export function normalizeProjectorFileName(fileName: string): string | null {
  const normalized = normalizeFileName(fileName);
  return normalized.length > 0 ? normalized : null;
}

export function isProjectorFileName(fileName: string): boolean {
  const normalized = normalizeProjectorFileName(fileName);
  return normalized !== null
    && GGUF_EXTENSION_PATTERN.test(normalized)
    && PROJECTOR_FILE_NAME_PATTERN.test(normalized);
}

export function resolveModelArtifactRole(fileName: string): ModelArtifactRole {
  return isProjectorFileName(fileName) ? 'projector_companion' : 'primary_chat_model';
}

export function buildProjectorArtifactId({
  repoId,
  hfRevision,
  fileName,
  ownerVariantId,
}: {
  repoId: string;
  hfRevision?: string;
  fileName: string;
  ownerVariantId?: string;
}): string {
  const parts = [
    repoId.trim().toLowerCase(),
    (hfRevision ?? 'main').trim().toLowerCase(),
    ownerVariantId?.trim().toLowerCase() ?? '',
    normalizeProjectorArtifactFileIdentity(fileName)
      ?? normalizeProjectorFileName(fileName)
      ?? fileName.trim().toLowerCase(),
  ];
  const stable = parts.join('|').replace(/[^a-z0-9._-]+/giu, '-').replace(/^-+|-+$/gu, '');
  return `projector-${stable}`;
}

export function getProjectorMatchKey(fileName: string): string {
  return toMatchTokens(fileName).join('-');
}

export function scoreProjectorCandidateForModel(
  modelFileName: string,
  projectorFileName: string,
): number {
  if (!isProjectorFileName(projectorFileName)) {
    return 0;
  }

  const modelTokens = new Set(toMatchTokens(modelFileName));
  const projectorTokens = new Set(toMatchTokens(projectorFileName));
  if (modelTokens.size === 0 || projectorTokens.size === 0) {
    return 1;
  }

  const sharedTokens = intersectCount(modelTokens, projectorTokens);
  if (sharedTokens === 0) {
    return 1;
  }

  return 1 + sharedTokens * 10;
}

export function rankProjectorCandidatesForModel<T extends Pick<ProjectorArtifact, 'fileName'>>(
  modelFileName: string,
  candidates: readonly T[],
): T[] {
  return [...candidates].sort((left, right) => {
    const rightScore = scoreProjectorCandidateForModel(modelFileName, right.fileName);
    const leftScore = scoreProjectorCandidateForModel(modelFileName, left.fileName);
    if (rightScore !== leftScore) {
      return rightScore - leftScore;
    }

    return left.fileName.localeCompare(right.fileName);
  });
}

export function resolveDeterministicProjectorCandidate<T extends Pick<ProjectorArtifact, 'fileName'>>(
  modelFileName: string,
  candidates: readonly T[],
): T | null {
  const ranked = rankProjectorCandidatesForModel(modelFileName, candidates);
  const first = ranked[0];
  if (!first) {
    return null;
  }

  const firstScore = scoreProjectorCandidateForModel(modelFileName, first.fileName);
  const second = ranked[1];
  const secondScore = second ? scoreProjectorCandidateForModel(modelFileName, second.fileName) : 0;
  return firstScore > 1 && firstScore > secondScore ? first : null;
}
