import * as FileSystem from 'expo-file-system/legacy';
import { AppState } from 'react-native';
import fixtures from '../../docs/validation/llama-rn-stage6/tts-fixtures.json';
import loraFixture from '../../docs/validation/llama-rn-stage3/lora-fixture.json';
import { useChatStore } from '../store/chatStore';
import { useDownloadStore } from '../store/downloadStore';
import { DEFAULT_PRESET_SNAPSHOT } from '../types/chat';
import { LifecycleStatus, ModelAccessState, type ModelMetadata } from '../types/models';
import { TtsError, type TtsFlow, type TtsObservation } from '../types/tts';
import { bindManagedCompanion, getCompanionBindingIdentity, getCompanionSourceIdentity } from '../utils/modelArtifacts';
import { getModelFileIdentity } from '../utils/modelRoles';
import { getAppCacheRootDir } from './FileSystemSetup';
import { isAndroidQaDocumentModelBootstrapEnabled, ANDROID_QA_DOCUMENT_MODEL_ID } from './AndroidQaDocumentModelBootstrap';
import { getAndroidQaEffectiveProfileIdentity, prepareAndroidQaStage3Adapter } from './AndroidQaStage3';
import { selectAuxiliaryModel } from './AuxiliaryModelService';
import { llmEngineService } from './LLMEngineService';
import { getModelDownloadManager, ModelFileLeaseBusyError } from './ModelDownloadManager';
import { registry } from './LocalStorageRegistry';
import { getSettings, updateSettings } from './SettingsStore';
import { TTS_EXECUTION_PROFILES, type TtsExecutionProfile } from './TtsExecutionProfiles';
import { resolveTtsBinding, ttsService } from './TtsService';
import { LLAMA_SOURCE_PATCH_SHA256 } from './LlamaSourcePatchIdentity';

type Receipt = {
  id: string; status: 'passed'; flow?: TtsFlow; nativeSynthesis?: 'passed'; decode?: 'passed';
  playback?: 'passed'; contentVerification?: 'not_run'; sampleRate?: number; sampleCount?: number;
  duration?: number; elementCount?: number; interrupted?: boolean; completionDrained?: boolean;
  profileRestored?: boolean; chatUnchanged?: boolean; deletionRejected?: boolean; fileRemoved?: boolean;
};
export interface AndroidQaTtsEvidence {
  schemaVersion: 1; status: 'idle' | 'running' | 'native_passed' | 'failed'; phase: string;
  flow?: TtsFlow; clipId?: string; failureCode?: string; requiresForceStop: boolean;
  backend: 'cpu'; runtimeVersion: '0.13.0-rc.3'; patchSha256: string; steps: Receipt[];
  contentVerification: 'not_run';
  mode?: 'playback_start'; synthesisCount?: number;
}
const initial = (): AndroidQaTtsEvidence => ({ schemaVersion: 1, status: 'idle', phase: 'idle',
  requiresForceStop: false, backend: 'cpu', runtimeVersion: '0.13.0-rc.3', patchSha256: LLAMA_SOURCE_PATCH_SHA256,
  steps: [], contentVerification: 'not_run' });
let evidence = initial();
let active: Promise<void> | null = null;
let continueClip: (() => void) | null = null;
const listeners = new Set<() => void>();
export const getAndroidQaTtsEvidence = () => evidence;
export function subscribeAndroidQaTts(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener); }
function publish(patch: Partial<AndroidQaTtsEvidence>): void { evidence = { ...evidence, ...patch }; listeners.forEach(listener => listener()); }
class QaTtsFailure extends Error {
  constructor(readonly code: string, readonly requiresForceStop = false) { super(code); }
}
function check(value: unknown, code: string): asserts value { if (!value) throw new QaTtsFailure(code); }
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const sourceUrl = (source: TtsExecutionProfile['backbone']) =>
  `https://huggingface.co/${source.repository}/resolve/${source.revision}/${source.filename}?download=true`;

type OwnedFixtureDownload = { modelId: string; fileIdentity: string; companionArtifactId?: string };
function claimNewFixtureDownload(model: ModelMetadata, owned: OwnedFixtureDownload[], companionArtifactId?: string): boolean {
  const state = useDownloadStore.getState();
  const previous = state.queue.find(item => item.id === model.id);
  if (previous) {
    check(getModelFileIdentity(previous) === getModelFileIdentity(model)
      && state.downloadOptionsByModelId[model.id]?.companionArtifactId === companionArtifactId, 'fixture_queue_conflict');
    return false; // This run neither retries nor cancels a pre-existing job.
  }
  owned.push({ modelId: model.id, fileIdentity: getModelFileIdentity(model), companionArtifactId });
  return true;
}

/** Uses the same registry, identity and download queue as the public resource UI. */
export async function prepareAndroidQaTtsProfile(profile: TtsExecutionProfile): Promise<ModelMetadata> {
  const fixtureId = ['outetts-1.0-0.6b-q4_k_m-dac-speech-f16', 'bluemagpie-barbet-1b-q4_k_m-audiovae-q8_0'].includes(profile.id)
    ? profile.flow : profile.id;
  const desired: ModelMetadata = { id: `pocket-ai/android-qa-tts-${fixtureId}`, name: `Android QA ${profile.family}`,
    author: profile.backbone.repository.split('/')[0], size: profile.backbone.bytes, sha256: profile.backbone.sha256,
    downloadUrl: sourceUrl(profile.backbone), resolvedFileName: profile.backbone.filename, hfRevision: profile.backbone.revision,
    lifecycleStatus: LifecycleStatus.AVAILABLE, fitsInRam: null, downloadProgress: 0, metadataTrust: 'trusted_remote',
    accessState: ModelAccessState.PUBLIC, isPrivate: false, isGated: false,
    roleEvidence: [{ role: 'tts', source: 'model_card', confidence: 'declared' }] };
  const manager = getModelDownloadManager();
  const owned: OwnedFixtureDownload[] = [];
  try {
    const ready = () => {
      const model = registry.getModel(desired.id);
      return model?.localPath && getModelFileIdentity(model) === getModelFileIdentity(desired)
        && model.downloadIntegrity?.kind === 'sha256' && model.downloadIntegrity.sha256 === profile.backbone.sha256
        && model.downloadIntegrity.sizeBytes === profile.backbone.bytes ? model : undefined;
    };
    if (!ready()) {
      check(!registry.getModel(desired.id)?.localPath, 'fixture_identity_conflict');
      if (claimNewFixtureDownload(desired, owned)) {
        registry.updateModel(desired);
        useDownloadStore.getState().addToQueue(desired);
      }
      const deadline = Date.now() + 1_800_000;
      while (!ready()) {
        check(Date.now() < deadline, 'download_timeout');
        const queued = useDownloadStore.getState().queue.find(item => item.id === desired.id);
        check(queued?.lifecycleStatus !== LifecycleStatus.FAILED && queued?.lifecycleStatus !== LifecycleStatus.PAUSED, 'download_failed');
        await delay(250);
      }
    }
    const base = ready()!;
    const bound = bindManagedCompanion(base, { kind: 'tts_codec', downloadUrl: sourceUrl(profile.codec),
      sizeBytes: profile.codec.bytes, sha256: profile.codec.sha256 });
    const artifact = bound.artifacts?.find(item => item.kind === 'tts_codec' && item.selected);
    check(artifact, 'codec_binding');
    const enqueueCodec = artifact.installState !== 'installed' && claimNewFixtureDownload(bound, owned, artifact.id);
    registry.updateModel(bound);
    if (enqueueCodec) manager.prepareCompanion(bound, artifact.id);
    const deadline = Date.now() + 1_800_000;
    while (true) {
      const model = registry.getModel(base.id);
      const codec = model?.artifacts?.find(item => item.id === artifact.id);
      if (model && codec?.localPath && codec.installState === 'installed' && codec.integrity?.kind === 'sha256'
        && codec.integrity.sha256 === profile.codec.sha256 && codec.integrity.sizeBytes === profile.codec.bytes) return model;
      check(Date.now() < deadline, 'codec_download_timeout');
      check(codec?.installState !== 'failed', 'codec_download_failed'); await delay(250);
    }
  } catch (error) {
    try {
      for (const job of owned.reverse()) {
        const state = useDownloadStore.getState();
        const queued = state.queue.find(item => item.id === job.modelId);
        if (!queued) continue;
        check(getModelFileIdentity(queued) === job.fileIdentity
          && state.downloadOptionsByModelId[job.modelId]?.companionArtifactId === job.companionArtifactId,
        'fixture_download_owner_changed');
        await manager.cancelDownload(job.modelId, { waitForDrain: true });
        check(!useDownloadStore.getState().queue.some(item => item.id === job.modelId), 'fixture_download_cleanup');
      }
    } catch {
      throw new QaTtsFailure(error instanceof QaTtsFailure ? error.code : 'fixture_prepare_failed', true);
    }
    throw error;
  }
}

/** One clip remains in the ordinary ephemeral cache while a local runner copies it for ASR. */
export function continueAndroidQaTts(): void { if (isAndroidQaDocumentModelBootstrapEnabled()) continueClip?.(); }
async function awaitClipCopy(id: string): Promise<void> {
  publish({ phase: 'awaiting_clip_copy', clipId: id });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      continueClip = resolve;
      timer = setTimeout(() => reject(new QaTtsFailure('clip_copy_timeout')), 180_000);
    });
  } finally { continueClip = null; if (timer) clearTimeout(timer); }
  publish({ clipId: undefined });
}

export function runAndroidQaTts(flow: TtsFlow): Promise<void> {
  if (!isAndroidQaDocumentModelBootstrapEnabled()) return Promise.resolve();
  if (active) return active;
  evidence = initial(); publish({ status: 'running', flow, phase: 'prepare' });
  active = execute(flow).finally(() => { active = null; });
  return active;
}

/** One real clip, then ordinary rendered controls; no export or repeated synthesis. */
export function runAndroidQaTtsPlayback(): Promise<void> {
  if (!isAndroidQaDocumentModelBootstrapEnabled()) return Promise.resolve();
  if (active) return active;
  evidence = initial();
  publish({ status: 'running', flow: 'tokens', phase: 'prepare', mode: 'playback_start', synthesisCount: 0 });
  active = execute('tokens', true).finally(() => { active = null; });
  return active;
}

export async function waitForAndroidQaTtsPublicControls(): Promise<void> {
  publish({ phase: 'awaiting_public_controls' });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let backgroundStartedPlaying = false;
  const backgroundListener = AppState.addEventListener('change', next => {
    const state = ttsService.getState();
    if (next !== 'active') backgroundStartedPlaying = state.phase === 'playing' && state.clipAvailable === true && !state.errorCode;
  });
  try {
    await new Promise<void>((resolve, reject) => {
      continueClip = resolve;
      timer = setTimeout(() => reject(new QaTtsFailure('public_controls_timeout')), 180_000);
    });
    check(backgroundStartedPlaying, 'background_playback_missing');
  } finally {
    continueClip = null;
    if (timer) clearTimeout(timer);
    backgroundListener.remove();
  }
}

async function execute(flow: TtsFlow, playbackOnly = false): Promise<void> {
  const originalThread = useChatStore.getState().activeThreadId;
  const originalBindings = getSettings().auxiliaryModels;
  const originalModel = llmEngineService.getState().activeModelId;
  const originalProfile = llmEngineService.getEffectiveLoadParameters();
  let ownedThread: string | undefined;
  let completed = false;
  let failureCode: string | undefined;
  let cleanupCompleted = false;
  const pass = (receipt: Omit<Receipt, 'status'>) => publish({ steps: [...evidence.steps, { ...receipt, status: 'passed' }] });
  try {
    const profile = TTS_EXECUTION_PROFILES.find(item => item.flow === flow)!;
    const fixture = fixtures.fixtures.find(item => item.id === profile.id)!;
    if (playbackOnly) await prepareAndroidQaStage3Adapter(180_000);
    const model = await prepareAndroidQaTtsProfile(profile);
    selectAuxiliaryModel('tts', model);
    check(getSettings().activeModelId === ANDROID_QA_DOCUMENT_MODEL_ID, 'chat_selection_changed');
    // Reuse the verified Stage 3 adapter, with the same original companion identity/order/scale.
    const base = registry.getModel(ANDROID_QA_DOCUMENT_MODEL_ID);
    const adapter = base?.artifacts?.find(item => item.kind === 'lora_adapter'
      && item.sha256 === loraFixture.adapter.sha256 && item.installState === 'installed' && item.localPath);
    check(base && adapter, 'stage3_adapter_missing');
    const loraAdapters = [{ artifactId: adapter.id, artifactIdentity: getCompanionSourceIdentity(adapter),
      baseModelIdentity: getCompanionBindingIdentity(base), scale: 0.5, sizeBytes: adapter.sizeBytes ?? undefined }];
    ownedThread = useChatStore.getState().createThread({ modelId: base.id, title: 'Android speech QA',
      presetId: null, presetSnapshot: DEFAULT_PRESET_SNAPSHOT, loraSnapshot: loraAdapters,
      paramsSnapshot: { temperature: 0, topP: 1, maxTokens: 32, seed: 42 } });
    await llmEngineService.load(base.id, { forceReload: true, loadParamsMode: 'replace', loadParamsOverride: {
      contextSize: 512, gpuLayers: 0, backendPolicy: 'cpu', mtpEnabled: false, kvCacheType: 'f16',
      loraAdapters, parallelSlots: 1, useMmap: true, cpuThreads: 4 } });
    const beforeProfile = getAndroidQaEffectiveProfileIdentity(llmEngineService.getEffectiveLoadParameters());
    const history = JSON.stringify(useChatStore.getState().threads);
    const assertRestored = () => {
      const state = llmEngineService.getState();
      check(state.activeModelId === base.id && state.status === 'ready'
        && state.diagnostics?.backendMode === 'cpu' && state.diagnostics.actualGpuAccelerated === false
        && state.diagnostics.loadedGpuLayers === 0 && state.diagnostics.initNParallel === 1
        && state.diagnostics.stateCacheBudgetMb === 0 && state.diagnostics.stateCacheMaxCheckpoints === 8
        && getAndroidQaEffectiveProfileIdentity(llmEngineService.getEffectiveLoadParameters()) === beforeProfile, 'profile_restore');
      check(JSON.stringify(useChatStore.getState().threads) === history, 'history_changed');
    };
    const synthesize = async (input: typeof fixture.acceptanceTexts[number], id: string) => {
      publish({ phase: id });
      const originalCodec = resolveTtsBinding();
      check(originalCodec.model.id === model.id, 'codec_missing');
      const codecOwnership = (binding: ReturnType<typeof resolveTtsBinding>) => JSON.stringify([
        getCompanionBindingIdentity(binding.model), binding.codec.id, getCompanionSourceIdentity(binding.codec),
        binding.codec.localPath, binding.codec.boundToModelIdentity, binding.codec.installState,
        binding.codec.integrity, binding.codec.sizeBytes,
      ]);
      const originalCodecOwnership = codecOwnership(originalCodec);
      const originalCodecFile = await FileSystem.getInfoAsync(originalCodec.codecUri);
      check(originalCodecFile.exists && !originalCodecFile.isDirectory
        && originalCodecFile.size === profile.codec.bytes, 'codec_file_missing');
      let decoded: TtsObservation | undefined;
      let deletion: Promise<boolean> | undefined;
      const observe = (event: TtsObservation) => {
        if (playbackOnly && event.operation === 'completion' && event.phase === 'started') {
          publish({ synthesisCount: (evidence.synthesisCount ?? 0) + 1 });
        }
        if (event.operation === 'completion' && event.phase === 'started' && !deletion) {
          const codec = registry.getModel(model.id)?.artifacts?.find(item => item.kind === 'tts_codec' && item.selected);
          check(codec, 'codec_missing');
          deletion = getModelDownloadManager().removeCompanion(model.id, codec.id).then(() => false,
            error => error instanceof ModelFileLeaseBusyError);
        }
        if (event.operation === 'decode' && event.phase === 'settled') decoded = event;
      };
      await ttsService.start({ text: input.text, language: input.language, playAfterSynthesis: false, observe });
      assertRestored(); check(decoded?.sampleCount && decoded.sampleRate && decoded.flow === flow, 'decode_receipt');
      check(await deletion, 'codec_delete_guard');
      const currentCodec = resolveTtsBinding();
      check(currentCodec.codecUri === originalCodec.codecUri && codecOwnership(currentCodec) === originalCodecOwnership,
        'codec_ownership_changed');
      const retainedCodecFile = await FileSystem.getInfoAsync(originalCodec.codecUri);
      check(retainedCodecFile.exists && !retainedCodecFile.isDirectory && retainedCodecFile.size === originalCodecFile.size,
        'codec_file_changed');
      if (playbackOnly) {
        check(evidence.synthesisCount === 1 && ttsService.getState().phase === 'ready', 'synthesis_count');
        pass({ id, flow, nativeSynthesis: 'passed', decode: 'passed', contentVerification: 'not_run',
          sampleRate: decoded.sampleRate, sampleCount: decoded.sampleCount, duration: decoded.sampleCount / decoded.sampleRate,
          elementCount: decoded.elementCount, profileRestored: true, chatUnchanged: true, deletionRejected: true });
        await waitForAndroidQaTtsPublicControls();
        // The host continues only after rendered controls and background cleanup.
        const cache = getAppCacheRootDir(); check(cache, 'cache_unavailable');
        check(ttsService.getState().phase === null
          && !(await FileSystem.getInfoAsync(`${cache}tts-clips/clip.wav`)).exists, 'background_clip_cleanup');
        assertRestored();
        pass({ id: 'background_cleanup', playback: 'passed', fileRemoved: true, profileRestored: true, chatUnchanged: true });
        return;
      }
      await ttsService.play(); await delay(600);
      check(ttsService.getState().position! > 0 && ttsService.getState().phase === 'playing', 'playback_position');
      await ttsService.pause(); check(ttsService.getState().phase === 'paused', 'playback_pause');
      await ttsService.stop(); await ttsService.replay(); await delay(500);
      check(ttsService.getState().position! > 0, 'playback_replay'); await ttsService.stop();
      pass({ id, flow, nativeSynthesis: 'passed', decode: 'passed', playback: 'passed', contentVerification: 'not_run',
        sampleRate: decoded.sampleRate, sampleCount: decoded.sampleCount, duration: decoded.sampleCount / decoded.sampleRate,
        elementCount: decoded.elementCount, profileRestored: true, chatUnchanged: true, deletionRejected: true });
      await awaitClipCopy(id); await ttsService.cancelAndClear();
    };
    if (playbackOnly) {
      await synthesize(fixture.acceptanceTexts[1], `${flow}-1`);
    } else {
      await synthesize(fixture.acceptanceTexts[0], `${flow}-1`);
      await synthesize(fixture.acceptanceTexts[1], `${flow}-2`);
      publish({ phase: 'stop_drain' });
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stopPromise: Promise<void> | undefined;
      let completion: TtsObservation | undefined;
      let stopSettled = false;
      let cancelled = false;
      try {
        await ttsService.start({ text: fixture.acceptanceTexts[2].text, language: fixture.acceptanceTexts[2].language,
          playAfterSynthesis: false, observe: event => {
            if (event.operation === 'completion' && event.phase === 'started') timer = setTimeout(() => {
              stopPromise = ttsService.stop(); void stopPromise.catch(() => undefined);
            }, 500);
            if (event.operation === 'completion' && event.phase === 'settled') completion = event;
            if (event.operation === 'completion_stop' && event.phase === 'settled') stopSettled = true;
          } });
      } catch (error) { cancelled = error instanceof TtsError && error.code === 'cancelled'; }
      finally { if (timer) clearTimeout(timer); await stopPromise; }
      check(cancelled && completion?.interrupted === true && stopSettled && !llmEngineService.hasAuxiliaryContextOperation(), 'stop_drain');
      assertRestored(); pass({ id: 'stop_drain', flow, interrupted: true, completionDrained: true, profileRestored: true, chatUnchanged: true });
      await synthesize(fixture.acceptanceTexts[2], `${flow}-retry`);
      }
    publish({ phase: 'chat_after' });
    let callbacks = 0;
    const result = await llmEngineService.chatCompletion({ expectedModelId: base.id,
      messages: [{ role: 'user', content: 'Write one short sentence about a friendly dog.' }],
      params: { n_predict: 32, temperature: 0, enable_thinking: false },
      onToken: () => { callbacks += 1; } });
    check(callbacks > 0 && (result.content ?? result.text)?.trim().length && !llmEngineService.hasActiveCompletion(), 'chat_after');
    assertRestored(); pass({ id: 'chat_after', profileRestored: true, chatUnchanged: true });
    completed = true;
  } catch (error) {
    failureCode = error instanceof TtsError || error instanceof QaTtsFailure ? error.code : 'qa_assertion';
    const requiresForceStop = (error instanceof QaTtsFailure && error.requiresForceStop)
      || llmEngineService.hasAuxiliaryContextOperation()
      || llmEngineService.getState().diagnostics?.contextRecoveryStatus === 'failed';
    // A runner may kill the process as soon as it sees failed. Ordinary failures
    // remain running until rollback has finished; uncertain owners surface early.
    publish({ phase: 'cleanup', ...(requiresForceStop ? { status: 'failed', failureCode, requiresForceStop: true } : {}) });
  } finally {
    try {
      await ttsService.cancelAndClear();
      const cache = getAppCacheRootDir(); check(cache, 'cache_unavailable');
      check(!(await FileSystem.getInfoAsync(`${cache}tts-clips/clip.wav`)).exists, 'clip_cleanup');
      if (!evidence.requiresForceStop) {
        if (originalModel && originalProfile) await llmEngineService.load(originalModel,
          { forceReload: true, loadParamsMode: 'replace', loadParamsOverride: originalProfile });
        else await llmEngineService.unload();
        if (ownedThread) useChatStore.getState().deleteThread(ownedThread);
        useChatStore.getState().setActiveThread(originalThread);
        // The explicit QA action prepares/selects this pair for the ordinary preview next.
        // Preserve all other auxiliary roles and restore the chat's complete original profile.
        updateSettings({ auxiliaryModels: completed ? { ...originalBindings, tts: getSettings().auxiliaryModels?.tts } : originalBindings });
      }
      pass({ id: 'cleanup', fileRemoved: true });
      cleanupCompleted = true;
    } catch { publish({ status: 'failed', phase: 'cleanup', failureCode: 'cleanup_failed', requiresForceStop: true }); }
  }
  if (cleanupCompleted && evidence.status !== 'failed') {
    publish(failureCode ? { status: 'failed', phase: 'complete', failureCode }
      : completed ? { status: 'native_passed', phase: 'complete' } : { status: 'failed', failureCode: 'qa_assertion' });
  }
}
