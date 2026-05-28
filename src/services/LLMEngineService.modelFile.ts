import * as FileSystem from 'expo-file-system/legacy';
import { getModelsDir } from './FileSystemSetup';
import { safeJoinModelPath } from '../utils/safeFilePath';
import { AppError } from './AppError';
import type { ProjectorArtifact } from '../types/multimodal';
import { getCandidateProjectorDownloadFileNames } from '../utils/modelFiles';

type ExistingFileInfo = FileSystem.FileInfo & { exists: true; size?: number | null };

function toCandidateFileLabel(value: string): string {
  return value
    .split(/[\\/]/u)
    .filter(Boolean)
    .at(-1) ?? '[unknown]';
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
