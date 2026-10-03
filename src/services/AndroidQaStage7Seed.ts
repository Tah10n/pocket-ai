import * as FileSystem from 'expo-file-system/legacy';
import RNFS from 'react-native-fs';
import DeviceInfo from 'react-native-device-info';
import inputManifest from '../../docs/validation/llama-rn-stage7/audio-input-fixtures.json';
import { LifecycleStatus, type ModelMetadata } from '../types/models';
import { validateGgufFileHeader } from '../utils/ggufValidation';
import { bindManagedCompanion } from '../utils/modelArtifacts';
import { getModelFileIdentity } from '../utils/modelRoles';
import { fileUriToNativePath, safeJoinModelPath } from '../utils/safeFilePath';
import { isAndroidQaDocumentModelBootstrapEnabled } from './AndroidQaDocumentModelBootstrap';
import { getAppCacheRootDir, getModelsDir } from './FileSystemSetup';
import { llmEngineService } from './LLMEngineService';
import { registry } from './LocalStorageRegistry';
import { getModelDownloadManager, runWithIdleModelDownloads } from './ModelDownloadManager';
import { assertPrivateStorageWritable } from './storage';
import { TTS_EXECUTION_PROFILES, type TtsSourceIdentity } from './TtsExecutionProfiles';
import { useDownloadStore } from '../store/downloadStore';

export const ANDROID_QA_STAGE7_SEED_SOURCE = 'host_provisioned_fixture' as const;
export type AndroidQaStage7SeedKind = 'ultravox' | 'neutts' | 'qwen3';
function check(value: unknown): asserts value { if (!value) throw new Error('stage7_seed_invalid'); }
const url = (source: TtsSourceIdentity) =>
  `https://huggingface.co/${source.repository}/resolve/${source.revision}/${source.filename}?download=true`;

function selectedPair(kind: AndroidQaStage7SeedKind) {
  if (kind === 'ultravox') {
    const source = inputManifest.audioInput;
    const identity = (part: typeof source.backbone): TtsSourceIdentity =>
      ({ repository: source.repository, revision: source.revision, ...part });
    return { id: 'pocket-ai/android-qa-ultravox-1b', backbone: identity(source.backbone),
      companion: identity(source.projector), projector: true };
  }
  const profileId = kind === 'neutts' ? 'neutts-nano-q4_k_m-neucodec-q8_0'
    : kind === 'qwen3' ? 'qwen3-tts-0.6b-q4_k_m-tokenizer-q8_0' : null;
  const profile = TTS_EXECUTION_PROFILES.find(item => item.id === profileId);
  check(profile);
  return { id: `pocket-ai/android-qa-tts-${profile.id}`, backbone: profile.backbone,
    companion: profile.codec, projector: false };
}

async function verify(uri: string, source: TtsSourceIdentity): Promise<void> {
  const info = await FileSystem.getInfoAsync(uri);
  check(info.exists && !info.isDirectory && info.size === source.bytes);
  await validateGgufFileHeader(uri, info);
  check((await RNFS.hash(fileUriToNativePath(uri), 'sha256')).toLowerCase() === source.sha256);
}
const localName = (source: TtsSourceIdentity) => `qa-stage7-${source.sha256}.gguf`;

/** Fixed public fixtures only. Publish after native SHA checks under the existing file leases. */
export async function prepareAndroidQaStage7Seed(
  kind: AndroidQaStage7SeedKind, desired: ModelMetadata,
): Promise<ModelMetadata | null> {
  if (!isAndroidQaDocumentModelBootstrapEnabled()
    || DeviceInfo.getBundleId() !== 'com.github.tah10n.pocketai.qa') return null;
  const cache = getAppCacheRootDir(); const models = getModelsDir();
  check(cache?.endsWith('/com.github.tah10n.pocketai.qa/cache/') && models);
  const pair = selectedPair(kind);
  const expected = { ...desired, id: pair.id, size: pair.backbone.bytes, sha256: pair.backbone.sha256,
    downloadUrl: url(pair.backbone), resolvedFileName: pair.backbone.filename, hfRevision: pair.backbone.revision };
  check(desired.id === pair.id && desired.downloadUrl === url(pair.backbone)
    && getModelFileIdentity(desired) === getModelFileIdentity(expected));
  const current = registry.getModel(pair.id);
  check(!current || getModelFileIdentity(current) === getModelFileIdentity(expected));
  const base = { ...desired, ...current };
  check(pair.projector || !base.artifacts?.some(item => item.kind === 'tts_codec' && item.selected
    && (item.sha256 !== pair.companion.sha256 || item.downloadUrl !== url(pair.companion))));
  const bound = pair.projector ? base : bindManagedCompanion(base, {
    kind: 'tts_codec', downloadUrl: url(pair.companion), sizeBytes: pair.companion.bytes, sha256: pair.companion.sha256 });
  const companion = bound.artifacts?.find(item => item.kind === (pair.projector ? 'multimodal_projector' : 'tts_codec')
    && item.sha256 === pair.companion.sha256 && item.remoteFileName === pair.companion.filename
    && item.hfRevision === pair.companion.revision && item.downloadUrl === url(pair.companion)
    && item.sizeBytes === pair.companion.bytes && (!pair.projector || item.id === bound.selectedProjectorId));
  check(companion);
  if (pair.projector) {
    const projector = bound.projectorCandidates?.find(item => item.id === companion.id);
    check(projector && projector.ownerModelId === pair.id && projector.fileName === pair.companion.filename
      && projector.hfRevision === pair.companion.revision && projector.sha256 === pair.companion.sha256
      && projector.size === pair.companion.bytes && projector.downloadUrl === url(pair.companion));
  }
  const sources = [pair.backbone, pair.companion];
  const seeds = sources.map(source => `${cache}stage7-model-fixtures/${source.sha256}.gguf`);
  const present = await Promise.all(seeds.map(uri => FileSystem.getInfoAsync(uri)));
  if (present.every(info => !info.exists)) return null;
  check(present.every(info => info.exists));
  for (let index = 0; index < sources.length; index++) await verify(seeds[index], sources[index]);

  const queued = useDownloadStore.getState().queue.find(item => item.id === pair.id);
  if (queued) {
    check(getModelFileIdentity(queued) === getModelFileIdentity(expected));
    const options = useDownloadStore.getState().downloadOptionsByModelId[pair.id];
    check(!options?.companionArtifactId || options.companionArtifactId === companion.id);
    const queuedCompanion = queued.artifacts?.find(item => item.id === companion.id);
    check(!queuedCompanion || (queuedCompanion.sha256 === pair.companion.sha256
      && queuedCompanion.downloadUrl === url(pair.companion) && queuedCompanion.sizeBytes === pair.companion.bytes));
    await getModelDownloadManager().cancelDownload(pair.id, { waitForDrain: true });
    check(!useDownloadStore.getState().queue.some(item => item.id === pair.id));
  }
  const targets = sources.map(source => safeJoinModelPath(models, localName(source))!);
  return runWithIdleModelDownloads(() => llmEngineService.runWithIdleModelResources(async () => {
    assertPrivateStorageWritable();
    const moved: number[] = [];
    let publicationStarted = false;
    try {
      await FileSystem.makeDirectoryAsync(models, { intermediates: true });
      for (let index = 0; index < sources.length; index++) {
        if (!(await FileSystem.getInfoAsync(targets[index])).exists) {
          assertPrivateStorageWritable();
          await FileSystem.moveAsync({ from: seeds[index], to: targets[index] }); moved.push(index);
        }
        await verify(targets[index], sources[index]);
      }
      assertPrivateStorageWritable();
      const checkedAt = Date.now();
      const integrity = (source: TtsSourceIdentity) => ({ kind: 'sha256' as const,
        sha256: source.sha256, sizeBytes: source.bytes, checkedAt });
      const verified = { ...bound, localPath: localName(pair.backbone), size: pair.backbone.bytes,
        downloadProgress: 1, resumeData: undefined, lifecycleStatus: LifecycleStatus.DOWNLOADED,
        metadataTrust: 'verified_local', downloadIntegrity: integrity(pair.backbone),
        downloadErrorCode: undefined, downloadErrorMessage: undefined, downloadErrorAt: undefined,
        artifacts: bound.artifacts?.map(item => item.id === companion.id ? { ...item,
          localPath: localName(pair.companion), installState: 'installed', downloadProgress: 1,
          resumeData: undefined, integrity: integrity(pair.companion), errorCode: undefined, errorMessage: undefined } : item),
        ...(pair.projector ? { projectorCandidates: bound.projectorCandidates?.map(item =>
          item.id === companion.id ? { ...item, localPath: localName(pair.companion),
            lifecycleStatus: 'downloaded', downloadProgress: 1, resumeData: undefined } : item) } : {}) } as ModelMetadata;
      assertPrivateStorageWritable();
      const latest = registry.getModel(pair.id);
      check(!latest || getModelFileIdentity(latest) === getModelFileIdentity(expected));
      publicationStarted = true;
      registry.updateModel(verified);
      return verified;
    } catch (error) {
      if (publicationStarted) throw error; // A failed registry write may already reference these verified files.
      for (const index of moved.reverse()) {
        if (!(await FileSystem.getInfoAsync(seeds[index])).exists)
          await FileSystem.moveAsync({ from: targets[index], to: seeds[index] });
      }
      throw error;
    }
  }, targets.map(fileUriToNativePath)));
}
