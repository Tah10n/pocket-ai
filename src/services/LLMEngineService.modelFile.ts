import * as FileSystem from 'expo-file-system/legacy';
import * as RNFS from 'react-native-fs';
import { getModelsDir } from './FileSystemSetup';
import { fileUriToNativePath, safeJoinModelPath } from '../utils/safeFilePath';
import { AppError } from './AppError';
import type { ProjectorArtifact } from '../types/multimodal';
import { getCandidateProjectorDownloadFileNames } from '../utils/modelFiles';
import { normalizeSha256Digest } from '../utils/sha256';

type ExistingFileInfo = FileSystem.FileInfo & { exists: true; size?: number | null };

function toCandidateFileLabel(value: string): string {
  return value
    .split(/[\\/]/u)
    .filter(Boolean)
    .at(-1) ?? '[unknown]';
}

async function verifyProjectorRawFileIdentity(
  projectorPath: string,
  expectedSha256: string,
): Promise<boolean> {
  let actualSha256: string | undefined;
  try {
    actualSha256 = normalizeSha256Digest(
      await RNFS.hash(fileUriToNativePath(projectorPath), 'sha256'),
    );
  } catch {
    return false;
  }

  return actualSha256 === expectedSha256;
}

export async function resolveModelFilePathOrThrow({
  modelId,
  localPath,
}: {
  modelId: string;
  localPath: string;
}): Promise<{ modelPath: string; fileInfo: ExistingFileInfo }> {
  const modelsDir = getModelsDir();
  if (!modelsDir) {
    throw new AppError('action_failed', 'Local file system is unavailable on this platform.', {
      details: { modelId },
    });
  }

  const modelPath = safeJoinModelPath(modelsDir, localPath);
  if (!modelPath) {
    throw new AppError('action_failed', `Invalid model file path for ${modelId}`, {
      details: { modelId },
    });
  }

  const fileInfo = await FileSystem.getInfoAsync(modelPath);
  if (!fileInfo.exists) {
    throw new AppError('download_file_missing', 'Model file is not available locally.', {
      details: { modelId, pathCategory: 'models' },
    });
  }

  return { modelPath, fileInfo: fileInfo as ExistingFileInfo };
}

export async function resolveProjectorFilePathOrThrow({
  modelId,
  projector,
}: {
  modelId: string;
  projector: ProjectorArtifact;
}): Promise<{ projectorPath: string; localPath: string; fileInfo: ExistingFileInfo }> {
  const modelsDir = getModelsDir();
  if (!modelsDir) {
    throw new AppError('action_failed', 'Local file system is unavailable on this platform.', {
      details: { modelId, projectorId: projector.id },
    });
  }

  const explicitLocalPath = isValidProjectorLocalPath(projector.localPath) ? projector.localPath : undefined;
  const rawFileName = projector.fileName;
  const expectedSha256 = normalizeSha256Digest(projector.sha256);
  const candidates = Array.from(new Set([
    ...(typeof projector.localPath === 'string' ? [projector.localPath] : []),
    ...getCandidateProjectorDownloadFileNames(projector),
  ]));

  for (const candidate of candidates) {
    const projectorPath = safeJoinModelPath(modelsDir, candidate);
    if (!projectorPath) {
      continue;
    }

    const fileInfo = await FileSystem.getInfoAsync(projectorPath);
    if (fileInfo.exists) {
      const isRawUpstreamName = candidate === rawFileName;
      const isExplicitLocalPath = explicitLocalPath === candidate;
      if (isRawUpstreamName && expectedSha256) {
        const isVerifiedRawFile = await verifyProjectorRawFileIdentity(
          projectorPath,
          expectedSha256,
        );
        if (!isVerifiedRawFile) {
          continue;
        }
      } else if (isRawUpstreamName && !isExplicitLocalPath) {
        continue;
      }

      return {
        projectorPath,
        localPath: candidate,
        fileInfo: fileInfo as ExistingFileInfo,
      };
    }
  }

  throw new AppError('download_file_missing', 'Projector file is not available locally.', {
    details: {
      modelId,
      projectorId: projector.id,
      candidates: candidates.map(toCandidateFileLabel),
    },
  });
}

function isValidProjectorLocalPath(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
