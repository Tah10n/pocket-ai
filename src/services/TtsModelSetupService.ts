import { AppState } from 'react-native';
import { useDownloadStore } from '../store/downloadStore';
import { LifecycleStatus, ModelAccessState, type ModelArtifactMetadata, type ModelMetadata } from '../types/models';
import { bindManagedCompanion, getSelectedManagedCompanions } from '../utils/modelArtifacts';
import { getModelFileIdentity, mergeModelRoleEvidence } from '../utils/modelRoles';
import { isValidLocalFileName } from '../utils/safeFilePath';
import { normalizeSha256Digest } from '../utils/sha256';
import { selectAuxiliaryModel } from './AuxiliaryModelService';
import { registry } from './LocalStorageRegistry';
import { getModelDownloadManager } from './ModelDownloadManager';
import { getSettings, subscribeSettings } from './SettingsStore';
import { assertPrivateStorageWritable, isPrivateStorageWritable } from './storage';
import { DEFAULT_TTS_PROFILE_ID, TTS_EXECUTION_PROFILES, type TtsSourceIdentity } from './TtsExecutionProfiles';

const profile = TTS_EXECUTION_PROFILES.find(entry => entry.id === DEFAULT_TTS_PROFILE_ID)!;
const totalBytes = profile.backbone.bytes + profile.codec.bytes;
const SETUP_TIMEOUT_MS = 30 * 60 * 1000;
const DRAIN_TIMEOUT_MS = 30 * 1000;
export const RECOMMENDED_TTS_MODEL_ID = 'pocket-ai/default-tts-outetts-0.3-q4_0';
export const RECOMMENDED_TTS_DOWNLOAD_MIB = Math.round(totalBytes / (1024 * 1024));

export type TtsModelSetupPhase = 'idle' | 'checking' | 'downloading_model' | 'downloading_codec'
  | 'selecting' | 'ready' | 'cancelling' | 'cancelled' | 'error';
export type TtsModelSetupErrorCode = 'download_failed' | 'timeout' | 'conflict' | 'selection_changed'
  | 'storage_failed' | 'cleanup_failed';
export interface TtsModelSetupState {
  readonly phase: TtsModelSetupPhase;
  readonly progress: number;
  readonly errorCode?: TtsModelSetupErrorCode;
}
export class TtsModelSetupError extends Error {
  constructor(readonly code: TtsModelSetupErrorCode | 'cancelled') { super(code); this.name = 'TtsModelSetupError'; }
}
type OwnedJob = { modelId: string; fileIdentity: string; companionArtifactId?: string; removed: boolean };
type Request = {
  binding: string; isCurrent: () => boolean; deadline: number; owned: OwnedJob[];
  cancelled?: 'cancelled' | 'selection_changed'; committing?: boolean; wake?: () => void;
};
const sourceUrl = (source: TtsSourceIdentity) =>
  `https://huggingface.co/${source.repository}/resolve/${source.revision}/${source.filename}?download=true`;
const bindingIdentity = () => JSON.stringify([getSettings().auxiliaryModels?.tts ?? null, getSettings().autoSelectTtsModel ?? true]);

/** Pinned public weights. Merely reading this metadata never queues a download. */
export function getRecommendedTtsModelMetadata(): ModelMetadata {
  return { id: RECOMMENDED_TTS_MODEL_ID, name: 'OuteTTS 0.3 (0.5B)', author: 'OuteAI',
    size: profile.backbone.bytes, sha256: profile.backbone.sha256, downloadUrl: sourceUrl(profile.backbone),
    resolvedFileName: profile.backbone.filename, hfRevision: profile.backbone.revision,
    lifecycleStatus: LifecycleStatus.AVAILABLE, fitsInRam: null, downloadProgress: 0, metadataTrust: 'trusted_remote',
    accessState: ModelAccessState.PUBLIC, isPrivate: false, isGated: false,
    languages: [...profile.languages], parameterSizeLabel: '0.5B', license: 'cc-by-sa-4.0',
    roleEvidence: [{ role: 'tts', source: 'model_card', confidence: 'declared' }] };
}
function verifiedBackbone(model: ModelMetadata): boolean {
  return [LifecycleStatus.DOWNLOADED, LifecycleStatus.ACTIVE].includes(model.lifecycleStatus)
    && isValidLocalFileName(model.localPath) && model.size === profile.backbone.bytes
    && normalizeSha256Digest(model.sha256) === profile.backbone.sha256
    && model.downloadIntegrity?.kind === 'sha256'
    && normalizeSha256Digest(model.downloadIntegrity.sha256) === profile.backbone.sha256
    && model.downloadIntegrity.sizeBytes === profile.backbone.bytes;
}
function verifiedCodec(codec: ModelArtifactMetadata | undefined): boolean {
  return codec?.kind === 'tts_codec' && codec.installState === 'installed' && isValidLocalFileName(codec.localPath)
    && codec.sizeBytes === profile.codec.bytes && normalizeSha256Digest(codec.sha256) === profile.codec.sha256
    && codec.integrity?.kind === 'sha256' && normalizeSha256Digest(codec.integrity.sha256) === profile.codec.sha256
    && codec.integrity.sizeBytes === profile.codec.bytes;
}
function recommendedCodec(model: ModelMetadata): ModelArtifactMetadata | undefined {
  return getSelectedManagedCompanions(model).find(artifact => artifact.kind === 'tts_codec');
}
/** Installed metadata lookup only; TtsService still verifies files and admits memory. */
export function getInstalledRecommendedTtsModel(): ModelMetadata | undefined {
  if (!isPrivateStorageWritable()) return undefined;
  return registry.getModels().filter(model => verifiedBackbone(model) && verifiedCodec(recommendedCodec(model)))
    .sort((left, right) => left.id.localeCompare(right.id))[0];
}
function withTtsEvidence(model: ModelMetadata): ModelMetadata {
  return { ...model, roleEvidence: mergeModelRoleEvidence(
    [{ role: 'tts', source: 'model_card', confidence: 'declared', fileIdentity: getModelFileIdentity(model) }], model.roleEvidence) };
}

/** One explicit setup owner per sheet; existing queue jobs keep their original owner. */
export class TtsModelSetupService {
  private state: TtsModelSetupState = { phase: 'idle', progress: 0 };
  private readonly listeners = new Set<() => void>();
  private active: Promise<void> | null = null;
  private request: Request | null = null;
  readonly getState = (): TtsModelSetupState => this.state;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  };
  private publish(state: TtsModelSetupState): void {
    if (JSON.stringify(state) === JSON.stringify(this.state)) return;
    this.state = state; this.listeners.forEach(listener => listener());
  }
  startRecommended(isCurrent: () => boolean): Promise<void> {
    if (this.active) return this.active;
    if (this.state.errorCode === 'cleanup_failed') return Promise.reject(new TtsModelSetupError('cleanup_failed'));
    const request: Request = { binding: bindingIdentity(), isCurrent, deadline: Date.now() + SETUP_TIMEOUT_MS, owned: [] };
    this.request = request;
    this.publish({ phase: 'checking', progress: 0 });
    const work = Promise.resolve().then(() => this.execute(request));
    this.active = work.finally(() => { if (this.request === request) { this.request = null; this.active = null; } });
    return this.active;
  }
  async cancel(): Promise<void> {
    const request = this.request;
    if (!request || !this.active) return;
    request.cancelled ??= 'cancelled';
    this.publish({ phase: 'cancelling', progress: this.state.progress });
    request.wake?.();
    try { await this.active; }
    catch (error) { if (error instanceof TtsModelSetupError && error.code === 'cleanup_failed') throw error; }
  }
  private assertCurrent(request: Request): void {
    if (!request.cancelled && bindingIdentity() !== request.binding) request.cancelled = 'selection_changed';
    if (request.cancelled) throw new TtsModelSetupError(request.cancelled);
    if (!request.isCurrent()) throw new TtsModelSetupError('cancelled');
    if (AppState.currentState && AppState.currentState !== 'active') throw new TtsModelSetupError('cancelled');
    if (Date.now() >= request.deadline) throw new TtsModelSetupError('timeout');
    assertPrivateStorageWritable();
  }
  private matchingQueue(model: ModelMetadata, companionArtifactId?: string): ModelMetadata | undefined {
    const state = useDownloadStore.getState();
    const queued = state.queue.find(item => item.id === model.id);
    if (queued && (getModelFileIdentity(queued) !== getModelFileIdentity(model)
      || state.downloadOptionsByModelId[model.id]?.companionArtifactId !== companionArtifactId)) {
      throw new TtsModelSetupError('conflict');
    }
    return queued;
  }
  private async waitFor(request: Request, model: ModelMetadata, companionArtifactId?: string): Promise<ModelMetadata> {
    while (true) {
      this.assertCurrent(request);
      const queued = this.matchingQueue(model, companionArtifactId);
      const current = registry.getModel(model.id);
      if (current && getModelFileIdentity(current) !== getModelFileIdentity(model)) throw new TtsModelSetupError('conflict');
      const codec = current && recommendedCodec(current);
      if (companionArtifactId && codec?.id !== companionArtifactId) throw new TtsModelSetupError('selection_changed');
      const ready = current && verifiedBackbone(current) && (!companionArtifactId || verifiedCodec(codec));
      if (ready && !queued) return current;
      if (!queued || [LifecycleStatus.FAILED, LifecycleStatus.PAUSED].includes(queued.lifecycleStatus)
        || (companionArtifactId && codec?.installState === 'failed')) throw new TtsModelSetupError('download_failed');
      const progress = companionArtifactId
        ? (profile.backbone.bytes + Math.max(0, Math.min(1, queued.artifacts?.find(item => item.id === companionArtifactId)?.downloadProgress ?? 0)) * profile.codec.bytes) / totalBytes
        : Math.max(0, Math.min(1, queued.downloadProgress)) * profile.backbone.bytes / totalBytes;
      this.publish({ phase: companionArtifactId ? 'downloading_codec' : 'downloading_model', progress });
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 250);
        request.wake = () => { clearTimeout(timer); resolve(); };
      });
      request.wake = undefined;
    }
  }
  private claim(request: Request, model: ModelMetadata, companionArtifactId?: string): boolean {
    this.assertCurrent(request);
    if (this.matchingQueue(model, companionArtifactId)) return false;
    request.owned.push({ modelId: model.id, fileIdentity: getModelFileIdentity(model), companionArtifactId, removed: false });
    return true;
  }
  private async cleanup(request: Request): Promise<void> {
    for (const job of [...request.owned].reverse()) {
      const state = useDownloadStore.getState();
      const queued = state.queue.find(item => item.id === job.modelId);
      if (job.removed || !queued) continue;
      // A replacement belongs to its new queue owner, even when this request fails.
      if (getModelFileIdentity(queued) !== job.fileIdentity
        || state.downloadOptionsByModelId[job.modelId]?.companionArtifactId !== job.companionArtifactId) continue;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([getModelDownloadManager().cancelDownload(job.modelId, { waitForDrain: true }),
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new TtsModelSetupError('cleanup_failed')), DRAIN_TIMEOUT_MS); })]);
        if (useDownloadStore.getState().queue.some(item => item.id === job.modelId)) throw new TtsModelSetupError('cleanup_failed');
      } finally { if (timer) clearTimeout(timer); }
    }
  }
  private async execute(request: Request): Promise<void> {
    const removeSettings = subscribeSettings(() => {
      if (!request.committing && bindingIdentity() !== request.binding) {
        request.cancelled = 'selection_changed'; request.wake?.();
      }
    });
    const removeQueue = useDownloadStore.subscribe(state => {
      request.owned.forEach(job => { if (!state.queue.some(item => item.id === job.modelId)) job.removed = true; });
    });
    const appState = AppState.addEventListener('change', next => {
      if (next !== 'active') void this.cancel().catch(() => undefined);
    });
    try {
      this.assertCurrent(request);
      const manager = getModelDownloadManager(); // Start the ordinary queue consumer before adding a backbone.
      let model = getInstalledRecommendedTtsModel()
        ?? registry.getModels().filter(verifiedBackbone).sort((left, right) => left.id.localeCompare(right.id))[0];
      if (!model) {
        const desired = getRecommendedTtsModelMetadata();
        const persisted = registry.getModel(desired.id);
        if (persisted && (getModelFileIdentity(persisted) !== getModelFileIdentity(desired)
          || ([LifecycleStatus.DOWNLOADED, LifecycleStatus.ACTIVE].includes(persisted.lifecycleStatus) && !verifiedBackbone(persisted)))) {
          throw new TtsModelSetupError('conflict');
        }
        model = persisted ?? desired;
        if (this.claim(request, model)) {
          if (!persisted) registry.updateModel(model);
          this.assertCurrent(request);
          useDownloadStore.getState().addToQueue(model);
        }
        model = await this.waitFor(request, model);
      }
      this.assertCurrent(request);
      const queuedBase = useDownloadStore.getState().queue.find(item => item.id === model!.id);
      if (queuedBase && !useDownloadStore.getState().downloadOptionsByModelId[model.id]?.companionArtifactId) {
        model = await this.waitFor(request, model); // Wait for an existing backbone job to release its queue slot.
      }
      this.assertCurrent(request);
      // Exact installed bytes remain compatible even if their resolve URL omits ?download=true.
      const bound = verifiedCodec(recommendedCodec(model)) ? withTtsEvidence(model)
        : bindManagedCompanion(withTtsEvidence(model), { kind: 'tts_codec', downloadUrl: sourceUrl(profile.codec),
          sizeBytes: profile.codec.bytes, sha256: profile.codec.sha256 });
      const codec = recommendedCodec(bound)!;
      const previousCodec = model.artifacts?.find(item => item.id === codec.id);
      if (previousCodec?.installState === 'installed' && !verifiedCodec(previousCodec)) throw new TtsModelSetupError('conflict');
      const existingCodecJob = this.matchingQueue(bound, codec.id);
      this.assertCurrent(request);
      if (!existingCodecJob && !verifiedCodec(codec)) {
        // Preserve existing queue metadata while observing a job this sheet did not create.
        registry.updateModel(bound);
        if (this.claim(request, bound, codec.id)) {
          manager.prepareCompanion(bound, codec.id);
        }
      }
      const ready = await this.waitFor(request, bound, codec.id);
      this.publish({ phase: 'selecting', progress: 1 });
      this.assertCurrent(request);
      request.committing = true; // The synchronous commit's own settings notification is expected.
      selectAuxiliaryModel('tts', withTtsEvidence(ready));
      this.publish({ phase: 'ready', progress: 1 });
    } catch (error) {
      try { await this.cleanup(request); }
      catch { this.publish({ phase: 'error', progress: this.state.progress, errorCode: 'cleanup_failed' }); throw new TtsModelSetupError('cleanup_failed'); }
      const code = error instanceof TtsModelSetupError ? error.code : 'storage_failed';
      this.publish(code === 'cancelled' ? { phase: 'cancelled', progress: this.state.progress }
        : { phase: 'error', progress: this.state.progress, errorCode: code });
      throw new TtsModelSetupError(code);
    } finally { request.wake?.(); removeSettings(); removeQueue(); appState.remove(); }
  }
}
