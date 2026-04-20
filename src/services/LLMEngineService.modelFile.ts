import * as FileSystem from 'expo-file-system/legacy';
import { getModelsDir } from './FileSystemSetup';
import { safeJoinModelPath } from '../utils/safeFilePath';
import { AppError } from './AppError';

export async function resolveModelFilePathOrThrow({
  modelId,
  localPath,
}: {
  modelId: string;
  localPath: string;
}): Promise<{ modelPath: string; fileInfo: (FileSystem.FileInfo & { exists: true; size?: number | null }) }> {
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
    throw new AppError('download_file_missing', `Model file not found at ${modelPath}`, {
      details: { modelId, modelPath },
    });
  }

  return { modelPath, fileInfo: fileInfo as (FileSystem.FileInfo & { exists: true; size?: number | null }) };
}
