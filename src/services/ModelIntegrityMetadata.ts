import { LifecycleStatus, type ModelMetadata } from '../types/models';
import { normalizeSha256Digest } from '../utils/sha256';

type ShaIntegrityModel = Pick<ModelMetadata, 'downloadIntegrity' | 'metadataTrust' | 'sha256'>;

type LocalCatalogFileIdentity = Pick<
  ModelMetadata,
  'downloadIntegrity' | 'metadataTrust' | 'resolvedFileName' | 'sha256' | 'size'
>;

type RemoteCatalogFileIdentity = Partial<Pick<ModelMetadata, 'resolvedFileName' | 'sha256' | 'size'>>;

export type VerifiedLocalShaCompatibility = {
  remoteSha256: string | undefined;
  localIntegritySha256: string | undefined;
  localVerifiedSha256: string | undefined;
  hasRemoteFileNameConflict: boolean;
  canUseLocalVerifiedMetadata: boolean;
  canPreserveDownloadIntegrity: boolean;
  hasRemoteShaConflict: boolean;
  hasRemoteSizeConflict: boolean;
  hasRemoteIdentityConflict: boolean;
  shouldResetLocalDownloadState: boolean;
};

export type LocalDownloadStateCompatibilityPatch = Partial<Pick<
  ModelMetadata,
  | 'downloadErrorAt'
  | 'downloadErrorCode'
  | 'downloadErrorMessage'
  | 'downloadIntegrity'
  | 'downloadProgress'
  | 'downloadedAt'
  | 'lifecycleStatus'
  | 'localPath'
  | 'resumeData'
>>;

export function getSha256IntegrityMarkerDigest(
  marker: ModelMetadata['downloadIntegrity'],
): string | undefined {
  return marker?.kind === 'sha256'
    ? normalizeSha256Digest(marker.sha256)
    : undefined;
}

export function getVerifiedLocalSha256(model: ShaIntegrityModel): string | undefined {
  if (model.metadataTrust !== 'verified_local') {
    return undefined;
  }

  const modelSha256 = normalizeSha256Digest(model.sha256);
  const markerSha256 = getSha256IntegrityMarkerDigest(model.downloadIntegrity);

  return modelSha256 && markerSha256 && modelSha256 === markerSha256
    ? modelSha256
    : undefined;
}

function getIntegrityMarkerSizeBytes(marker: ModelMetadata['downloadIntegrity']): number | undefined {
  const sizeBytes = marker?.sizeBytes;
  return typeof sizeBytes === 'number' && Number.isFinite(sizeBytes) && sizeBytes > 0
    ? Math.round(sizeBytes)
    : undefined;
}

function normalizePositiveSize(value: ModelMetadata['size']): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined;
}

function normalizeFileName(value: ModelMetadata['resolvedFileName']): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function resolveVerifiedLocalShaCompatibility(
  localModel: LocalCatalogFileIdentity,
  remoteFile: RemoteCatalogFileIdentity,
): VerifiedLocalShaCompatibility {
  const normalizedRemoteSha256 = normalizeSha256Digest(remoteFile.sha256);
  const localModelSha256 = normalizeSha256Digest(localModel.sha256);
  const localIntegritySha256 = getSha256IntegrityMarkerDigest(localModel.downloadIntegrity);
  const localVerifiedSha256 = getVerifiedLocalSha256(localModel);
  const localSha256Identity = localIntegritySha256 ?? localModelSha256;
  const hasMatchingRemoteShaProof = Boolean(
    localIntegritySha256
    && normalizedRemoteSha256
    && localIntegritySha256 === normalizedRemoteSha256,
  );
  const hasRemoteShaConflict = Boolean(
    localSha256Identity
    && normalizedRemoteSha256
    && localSha256Identity !== normalizedRemoteSha256,
  );
  const localIntegritySizeBytes = getIntegrityMarkerSizeBytes(localModel.downloadIntegrity);
  const hasLocalIntegrityClaim = Boolean(
    localModelSha256
    || localIntegritySha256
    || localIntegritySizeBytes !== undefined
    || localModel.metadataTrust === 'verified_local',
  );
  const localResolvedFileName = normalizeFileName(localModel.resolvedFileName);
  const remoteResolvedFileName = normalizeFileName(remoteFile.resolvedFileName);
  const hasRemoteFileNameConflict = Boolean(
    !hasMatchingRemoteShaProof
    && hasLocalIntegrityClaim
    && localResolvedFileName
    && remoteResolvedFileName
    && localResolvedFileName !== remoteResolvedFileName,
  );
  const remoteSizeBytes = normalizePositiveSize(remoteFile.size ?? null);
  const hasRemoteSizeConflict = Boolean(
    !hasMatchingRemoteShaProof
    && localIntegritySizeBytes !== undefined
    && remoteSizeBytes !== undefined
    && localIntegritySizeBytes !== remoteSizeBytes,
  );
  const hasRemoteIdentityConflict = hasRemoteShaConflict
    || hasRemoteFileNameConflict
    || hasRemoteSizeConflict;
  const canPreserveDownloadIntegrity = localModel.downloadIntegrity !== undefined
    && !hasRemoteIdentityConflict;

  return {
    remoteSha256: normalizedRemoteSha256,
    localIntegritySha256,
    localVerifiedSha256,
    hasRemoteFileNameConflict,
    canUseLocalVerifiedMetadata: Boolean(localVerifiedSha256 && !hasRemoteIdentityConflict),
    canPreserveDownloadIntegrity,
    hasRemoteShaConflict,
    hasRemoteSizeConflict,
    hasRemoteIdentityConflict,
    shouldResetLocalDownloadState: hasRemoteIdentityConflict,
  };
}

export function getCompatibleLocalDownloadStatePatch(
  localModel: Pick<ModelMetadata, 'downloadIntegrity'>,
  compatibility: Pick<
    VerifiedLocalShaCompatibility,
    'canPreserveDownloadIntegrity' | 'shouldResetLocalDownloadState'
  >,
): LocalDownloadStateCompatibilityPatch {
  if (compatibility.shouldResetLocalDownloadState) {
    return {
      localPath: undefined,
      downloadedAt: undefined,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      resumeData: undefined,
      downloadErrorAt: undefined,
      downloadErrorCode: undefined,
      downloadErrorMessage: undefined,
      downloadIntegrity: undefined,
    };
  }

  return {
    downloadIntegrity: compatibility.canPreserveDownloadIntegrity
      ? localModel.downloadIntegrity
      : undefined,
  };
}
