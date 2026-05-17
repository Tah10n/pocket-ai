import type { ModelMetadata } from '../types/models';
import { normalizeSha256Digest } from '../utils/sha256';

type ShaIntegrityModel = Pick<ModelMetadata, 'downloadIntegrity' | 'metadataTrust' | 'sha256'>;

export type VerifiedLocalShaCompatibility = {
  remoteSha256: string | undefined;
  localVerifiedSha256: string | undefined;
  canUseLocalVerifiedMetadata: boolean;
  hasRemoteShaConflict: boolean;
};

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

export function resolveVerifiedLocalShaCompatibility(
  localModel: ShaIntegrityModel,
  remoteSha256: string | undefined,
): VerifiedLocalShaCompatibility {
  const normalizedRemoteSha256 = normalizeSha256Digest(remoteSha256);
  const localVerifiedSha256 = getVerifiedLocalSha256(localModel);
  const hasRemoteShaConflict = Boolean(
    localVerifiedSha256
    && normalizedRemoteSha256
    && localVerifiedSha256 !== normalizedRemoteSha256,
  );

  return {
    remoteSha256: normalizedRemoteSha256,
    localVerifiedSha256,
    canUseLocalVerifiedMetadata: Boolean(localVerifiedSha256 && !hasRemoteShaConflict),
    hasRemoteShaConflict,
  };
}
