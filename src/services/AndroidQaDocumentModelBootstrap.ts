import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import RNFS from 'react-native-fs';

import { LifecycleStatus, ModelAccessState, type ModelMetadata } from '../types/models';
import { fileUriToNativePath, safeJoinModelPath } from '../utils/safeFilePath';
import { getModelsDir, setupFileSystem } from './FileSystemSetup';
import { registry } from './LocalStorageRegistry';
import { updateSettings } from './SettingsStore';

export const ANDROID_QA_DOCUMENT_MODEL_ID = 'pocket-ai/android-qa-smollm2-135m-instruct-q8';
export const ANDROID_QA_DOCUMENT_MODEL_FILE = 'android-qa-smollm2-135m-instruct-q8.gguf';
export const ANDROID_QA_DOCUMENT_MODEL_SHA256 = 'bc64cce8e1c11e4ed870633b557e04af718249c817c4cf8a6784116144ec3e28';
export const ANDROID_QA_DOCUMENT_MODEL_URL =
  'https://huggingface.co/Mungert/SmolLM2-135M-Instruct-GGUF/resolve/980b4318b34b2f20e60c89d8f8a98283ec83cbd6/SmolLM2-135M-Instruct-q8_0.gguf?download=true';

type AndroidQaEnvironment = Record<string, string | undefined>;

function getDefaultAndroidQaEnvironment(): AndroidQaEnvironment {
  return {
    // Expo release bundles inline direct EXPO_PUBLIC_* property reads. Keep these
    // references explicit instead of reading through a process.env alias.
    EXPO_PUBLIC_ANDROID_QA: process.env.EXPO_PUBLIC_ANDROID_QA,
    EXPO_PUBLIC_ANDROID_QA_DOCUMENTS: process.env.EXPO_PUBLIC_ANDROID_QA_DOCUMENTS,
  };
}

export function isAndroidQaDocumentModelBootstrapEnabled(
  env?: AndroidQaEnvironment,
  platform = Platform.OS,
): boolean {
  const effectiveEnvironment = env ?? getDefaultAndroidQaEnvironment();
  return platform === 'android'
    && effectiveEnvironment.EXPO_PUBLIC_ANDROID_QA === '1'
    && effectiveEnvironment.EXPO_PUBLIC_ANDROID_QA_DOCUMENTS === '1';
}

function createVerifiedModel(sizeBytes: number, checkedAt: number): ModelMetadata {
  return {
    id: ANDROID_QA_DOCUMENT_MODEL_ID,
    name: 'Android QA SmolLM2 135M Instruct',
    author: 'Mungert / HuggingFaceTB',
    size: sizeBytes,
    downloadUrl: ANDROID_QA_DOCUMENT_MODEL_URL,
    localPath: ANDROID_QA_DOCUMENT_MODEL_FILE,
    resolvedFileName: 'SmolLM2-135M-Instruct-q8_0.gguf',
    sha256: ANDROID_QA_DOCUMENT_MODEL_SHA256,
    lifecycleStatus: LifecycleStatus.DOWNLOADED,
    downloadProgress: 1,
    downloadIntegrity: {
      kind: 'sha256',
      sha256: ANDROID_QA_DOCUMENT_MODEL_SHA256,
      sizeBytes,
      checkedAt,
    },
    metadataTrust: 'verified_local',
    accessState: ModelAccessState.PUBLIC,
    isGated: false,
    isPrivate: false,
    fitsInRam: true,
  };
}

async function readVerifiedModelSize(modelUri: string): Promise<number | null> {
  const info = await FileSystem.getInfoAsync(modelUri);
  if (!info.exists || !('size' in info) || typeof info.size !== 'number' || info.size <= 0) {
    return null;
  }
  const digest = (await RNFS.hash(fileUriToNativePath(modelUri), 'sha256')).toLowerCase();
  return digest === ANDROID_QA_DOCUMENT_MODEL_SHA256 ? info.size : null;
}

/**
 * Provision one public, commit-pinned model only for the hosted Android document pack.
 * Production builds reject both QA environment flags before Gradle is invoked.
 */
export async function provisionAndroidQaDocumentModel(): Promise<boolean> {
  if (!isAndroidQaDocumentModelBootstrapEnabled()) {
    return false;
  }

  await setupFileSystem();
  const modelsDir = getModelsDir();
  const modelUri = modelsDir ? safeJoinModelPath(modelsDir, ANDROID_QA_DOCUMENT_MODEL_FILE) : null;
  const partialUri = modelsDir
    ? safeJoinModelPath(modelsDir, `${ANDROID_QA_DOCUMENT_MODEL_FILE}.partial`)
    : null;
  if (!modelUri || !partialUri) {
    throw new Error('Android document QA model storage is unavailable.');
  }

  let sizeBytes = await readVerifiedModelSize(modelUri);
  if (sizeBytes == null) {
    await FileSystem.deleteAsync(modelUri, { idempotent: true });
    await FileSystem.deleteAsync(partialUri, { idempotent: true });
    const resumable = FileSystem.createDownloadResumable(
      ANDROID_QA_DOCUMENT_MODEL_URL,
      partialUri,
      { headers: { Accept: 'application/octet-stream' } },
    );
    const download = await resumable.downloadAsync();
    if (!download || download.status < 200 || download.status >= 300) {
      await FileSystem.deleteAsync(partialUri, { idempotent: true });
      throw new Error('Android document QA model download failed.');
    }
    sizeBytes = await readVerifiedModelSize(partialUri);
    if (sizeBytes == null) {
      await FileSystem.deleteAsync(partialUri, { idempotent: true });
      throw new Error('Android document QA model integrity verification failed.');
    }
    await FileSystem.moveAsync({ from: partialUri, to: modelUri });
  }

  registry.updateModel(createVerifiedModel(sizeBytes, Date.now()));
  updateSettings({ activeModelId: ANDROID_QA_DOCUMENT_MODEL_ID });
  return true;
}
