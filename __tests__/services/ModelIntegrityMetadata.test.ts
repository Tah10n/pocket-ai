import {
  getCompatibleLocalDownloadStatePatch,
  resolveVerifiedLocalShaCompatibility,
} from '../../src/services/ModelIntegrityMetadata';
import { LifecycleStatus, type ModelMetadata } from '../../src/types/models';

const LOCAL_SHA256 = 'b'.repeat(64);
const REMOTE_SHA256 = 'c'.repeat(64);
const LOCAL_SIZE = 4 * 1024 * 1024 * 1024;

function makeLocalIdentity(overrides: Partial<ModelMetadata> = {}) {
  return {
    size: LOCAL_SIZE,
    sha256: LOCAL_SHA256,
    resolvedFileName: 'model.Q4_K_M.gguf',
    metadataTrust: 'verified_local' as const,
    downloadIntegrity: {
      kind: 'sha256' as const,
      sizeBytes: LOCAL_SIZE,
      checkedAt: 123,
      sha256: LOCAL_SHA256,
    },
    ...overrides,
  };
}

describe('ModelIntegrityMetadata', () => {
  it('requires a local reset when the remote digest conflicts with local integrity', () => {
    const compatibility = resolveVerifiedLocalShaCompatibility(makeLocalIdentity(), {
      sha256: REMOTE_SHA256,
      resolvedFileName: 'model.Q4_K_M.gguf',
      size: LOCAL_SIZE,
    });

    expect(compatibility).toEqual(expect.objectContaining({
      hasRemoteShaConflict: true,
      hasRemoteIdentityConflict: true,
      shouldResetLocalDownloadState: true,
      canUseLocalVerifiedMetadata: false,
      canPreserveDownloadIntegrity: false,
    }));
  });

  it('drops verified local trust when the selected filename changes without remote sha proof', () => {
    const compatibility = resolveVerifiedLocalShaCompatibility(makeLocalIdentity(), {
      resolvedFileName: 'model.Q5_K_M.gguf',
      size: LOCAL_SIZE,
    });

    expect(compatibility).toEqual(expect.objectContaining({
      hasRemoteFileNameConflict: true,
      hasRemoteIdentityConflict: true,
      shouldResetLocalDownloadState: true,
      canUseLocalVerifiedMetadata: false,
      canPreserveDownloadIntegrity: false,
    }));
  });

  it('keeps size-only integrity markers for the same selected file without promoting local metadata', () => {
    const localModel = makeLocalIdentity({
      sha256: undefined,
      metadataTrust: 'trusted_remote',
      downloadIntegrity: {
        kind: 'size',
        sizeBytes: LOCAL_SIZE,
        checkedAt: 123,
      },
    });

    const compatibility = resolveVerifiedLocalShaCompatibility(localModel, {
      resolvedFileName: 'model.Q4_K_M.gguf',
      size: LOCAL_SIZE,
    });

    expect(compatibility).toEqual(expect.objectContaining({
      hasRemoteIdentityConflict: false,
      shouldResetLocalDownloadState: false,
      canUseLocalVerifiedMetadata: false,
      canPreserveDownloadIntegrity: true,
    }));
  });

  it('treats stored local sha as an identity conflict source for size-only markers', () => {
    const compatibility = resolveVerifiedLocalShaCompatibility(makeLocalIdentity({
      metadataTrust: 'trusted_remote',
      downloadIntegrity: {
        kind: 'size',
        sizeBytes: LOCAL_SIZE,
        checkedAt: 123,
      },
    }), {
      sha256: REMOTE_SHA256,
      resolvedFileName: 'model.Q4_K_M.gguf',
      size: LOCAL_SIZE,
    });

    expect(compatibility).toEqual(expect.objectContaining({
      hasRemoteShaConflict: true,
      hasRemoteIdentityConflict: true,
      shouldResetLocalDownloadState: true,
      canPreserveDownloadIntegrity: false,
    }));
  });

  it('resets local state when size-only integrity conflicts with remote size', () => {
    const compatibility = resolveVerifiedLocalShaCompatibility(makeLocalIdentity({
      sha256: undefined,
      metadataTrust: 'trusted_remote',
      downloadIntegrity: {
        kind: 'size',
        sizeBytes: LOCAL_SIZE,
        checkedAt: 123,
      },
    }), {
      resolvedFileName: 'model.Q4_K_M.gguf',
      size: LOCAL_SIZE - 1,
    });

    expect(compatibility).toEqual(expect.objectContaining({
      hasRemoteSizeConflict: true,
      shouldResetLocalDownloadState: true,
      canPreserveDownloadIntegrity: false,
    }));
  });

  it('builds a local download-state reset patch for incompatible files', () => {
    const compatibility = resolveVerifiedLocalShaCompatibility(makeLocalIdentity(), {
      sha256: REMOTE_SHA256,
      resolvedFileName: 'model.Q4_K_M.gguf',
      size: LOCAL_SIZE,
    });

    expect(getCompatibleLocalDownloadStatePatch(makeLocalIdentity(), compatibility)).toEqual({
      localPath: undefined,
      downloadedAt: undefined,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      resumeData: undefined,
      downloadErrorAt: undefined,
      downloadErrorCode: undefined,
      downloadErrorMessage: undefined,
      downloadIntegrity: undefined,
    });
  });
});
