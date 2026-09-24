import * as FileSystem from 'expo-file-system/legacy';
import * as RNFS from 'react-native-fs';
import type { ModelMetadata } from '../types/models';
import { getCompanionBindingIdentity, getCompanionSourceIdentity } from '../utils/modelArtifacts';
import { sanitizeLoraProfileAdapters, type LoraProfileAdapter } from '../utils/advancedLoadProfile';
import { validateGgufFileHeader } from '../utils/ggufValidation';
import { normalizeSha256Digest } from '../utils/sha256';
import { fileUriToNativePath, safeJoinModelPath } from '../utils/safeFilePath';
import { getModelsDir } from './FileSystemSetup';
import { loadLlamaModelInfo } from './LlamaRuntimeAdapter';
import { AppError } from './AppError';

export interface ResolvedLoraProfile {
  adapters: { path: string; scaled: number }[];
  sizeBytes: number;
  profile: LoraProfileAdapter[];
}

/** Caller owns native lifecycle and file/download mutation leases for the entire operation. */
export async function resolveLoraProfileForLoad(
  model: ModelMetadata,
  selection: readonly LoraProfileAdapter[] | undefined,
): Promise<ResolvedLoraProfile> {
  const profile = selection === undefined ? [] : sanitizeLoraProfileAdapters(selection);
  if (!profile) throw new AppError('model_incompatible', 'Invalid adapter configuration.');
  const result: ResolvedLoraProfile = { adapters: [], profile: [], sizeBytes: 0 };
  if (profile.length === 0) return result;
  const baseIdentity = getCompanionBindingIdentity(model);
  const modelsDir = getModelsDir();
  const baseUri = modelsDir && model.localPath ? safeJoinModelPath(modelsDir, model.localPath) : null;
  if (!baseUri) throw new AppError('model_incompatible', 'The base model file is unavailable.');
  try {
    const baseMetadata = await loadLlamaModelInfo(fileUriToNativePath(baseUri));
    const architecture = baseMetadata['general.architecture'];
    if (typeof architecture !== 'string' || !architecture) throw new Error('Unknown base architecture');
    const paths = new Set<string>();
    for (const entry of profile) {
      const artifact = model.artifacts?.find(item => item.id === entry.artifactId);
      if (!artifact || artifact.kind !== 'lora_adapter' || artifact.installState !== 'installed'
        || artifact.boundToModelIdentity !== baseIdentity || entry.baseModelIdentity !== baseIdentity
        || getCompanionSourceIdentity(artifact) !== entry.artifactIdentity) throw new Error('Stale adapter binding');
      const uri = modelsDir && artifact.localPath ? safeJoinModelPath(modelsDir, artifact.localPath) : null;
      if (!uri) throw new Error('Missing adapter file');
      const nativePath = fileUriToNativePath(uri);
      if (paths.has(nativePath)) throw new Error('Duplicate adapter file');
      paths.add(nativePath);
      const info = await FileSystem.getInfoAsync(uri);
      if (!info.exists || info.isDirectory || !Number.isSafeInteger(info.size) || info.size <= 0
        || artifact.sizeBytes !== info.size || (entry.sizeBytes !== undefined && entry.sizeBytes !== info.size)) {
        throw new Error('Adapter size mismatch');
      }
      await validateGgufFileHeader(uri, info);
      const expectedHash = normalizeSha256Digest(artifact.sha256)
        ?? (artifact.integrity?.kind === 'sha256' ? normalizeSha256Digest(artifact.integrity.sha256) : undefined);
      if (!expectedHash || normalizeSha256Digest(await RNFS.hash(nativePath, 'sha256')) !== expectedHash) {
        throw new Error('Adapter checksum mismatch');
      }
      const metadata = await loadLlamaModelInfo(nativePath);
      if (metadata['general.type'] !== 'adapter' || metadata['adapter.type'] !== 'lora'
        || metadata['general.architecture'] !== architecture) throw new Error('Incompatible adapter metadata');
      result.sizeBytes += info.size;
      if (!Number.isSafeInteger(result.sizeBytes)) throw new Error('Invalid adapter size');
      result.adapters.push({ path: nativePath, scaled: entry.scale });
      result.profile.push({ ...entry, sizeBytes: info.size });
    }
    return result;
  } catch {
    // Native metadata and filesystem errors may contain private paths. Keep them out of UI/logs.
    throw new AppError('model_incompatible', 'Adapter verification failed. Check its base model, variant, metadata and checksum.');
  }
}
