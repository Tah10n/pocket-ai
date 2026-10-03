import * as FileSystem from 'expo-file-system/legacy';
import { AppState } from 'react-native';
import loraFixture from '../../docs/validation/llama-rn-stage3/lora-fixture.json';
import audioFixture from '../../docs/validation/llama-rn-stage7/audio-input-fixtures.json';
import syntheticFixtures from '../../docs/validation/llama-rn-stage7/synthetic-inputs.json';
import { useChatStore } from '../store/chatStore';
import { useDownloadStore } from '../store/downloadStore';
import { LifecycleStatus, ModelAccessState, type ModelMetadata } from '../types/models';
import { DEFAULT_PRESET_SNAPSHOT } from '../types/chat';
import { TtsError, type TtsObservation, type TtsVoiceSelection } from '../types/tts';
import { getCompanionBindingIdentity, getCompanionSourceIdentity } from '../utils/modelArtifacts';
import { getModelFileIdentity } from '../utils/modelRoles';
import { audioRecordingService } from './AudioRecordingService';
import { AudioPreparationError, prepareManagedAudio, discardPreparedAudio, type PreparedAudio } from './AudioPreparationService';
import { audioSamplePreviewService } from './AudioSamplePreviewService';
import { ANDROID_QA_DOCUMENT_MODEL_ID, isAndroidQaDocumentModelBootstrapEnabled } from './AndroidQaDocumentModelBootstrap';
import { getAndroidQaEffectiveProfileIdentity, prepareAndroidQaStage3Adapter } from './AndroidQaStage3';
import { prepareAndroidQaTtsProfile } from './AndroidQaTts';
import { prepareAndroidQaStage7Seed } from './AndroidQaStage7Seed';
import { selectAuxiliaryModel } from './AuxiliaryModelService';
import { getAppCacheRootDir } from './FileSystemSetup';
import { llmEngineService } from './LLMEngineService';
import { registry } from './LocalStorageRegistry';
import { normalizePersistedModelMetadata } from './ModelMetadataNormalizer';
import { getModelDownloadManager } from './ModelDownloadManager';
import { getSettings, updateSettings } from './SettingsStore';
import { referenceVoiceStore } from './ReferenceVoiceStore';
import { TTS_EXECUTION_PROFILES } from './TtsExecutionProfiles';
import { ttsService } from './TtsService';

type Mode = 'recording' | 'input' | 'voices' | 'cold_voice';
export interface AndroidQaAudioStage7Step {
  id: string; status: 'passed'; sampleRate?: number; sampleCount?: number; durationMs?: number;
  sizeBytes?: number; sourceSha256?: string; profileId?: string; callbacks?: number;
  outputCharacters?: number; profileRestored?: boolean; chatUnchanged?: boolean;
  interrupted?: boolean; noAutomaticResume?: boolean; headerValidated?: boolean;
  speakerRows?: number; speakerBaked?: boolean; phonemizerElapsedMs?: number;
  operations?: string[]; voiceCount?: number; selected?: boolean; handlesPersisted?: false;
  fixtureKind?: 'recorded' | 'imported'; contentMatched?: boolean; completionDrained?: boolean;
}
export interface AndroidQaAudioStage7Evidence {
  schemaVersion: 1; status: 'idle' | 'running' | 'native_passed' | 'failed'; phase: string;
  mode?: Mode; clipId?: string; failureCode?: string; requiresForceStop: boolean;
  steps: AndroidQaAudioStage7Step[]; runtimeVersion: '0.13.0-rc.3'; backend: 'cpu';
  contentVerification: 'not_run'; referenceConditioning: 'not_run';
}
const initial = (): AndroidQaAudioStage7Evidence => ({ schemaVersion: 1, status: 'idle', phase: 'idle',
  requiresForceStop: false, steps: [], runtimeVersion: '0.13.0-rc.3', backend: 'cpu',
  contentVerification: 'not_run', referenceConditioning: 'not_run' });
let evidence = initial();
let active: Promise<void> | null = null;
let continueStep: (() => void) | null = null;
const listeners = new Set<() => void>();
export const getAndroidQaAudioStage7Evidence = () => evidence;
export const subscribeAndroidQaAudioStage7 = (listener: () => void): (() => void) => {
  listeners.add(listener); return () => listeners.delete(listener);
};
function publish(patch: Partial<AndroidQaAudioStage7Evidence>): void {
  evidence = { ...evidence, ...patch }; listeners.forEach(listener => listener());
}
class QaAudioFailure extends Error { constructor(readonly code: string) { super(code); } }
function check(value: unknown, code: string): asserts value { if (!value) throw new QaAudioFailure(code); }
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const pass = (step: Omit<AndroidQaAudioStage7Step, 'status'>) =>
  publish({ steps: [...evidence.steps, { ...step, status: 'passed' }] });

/** Fixed synthetic fixtures only, in an isolated package; ordinary builds cannot read them. */
export function isAndroidQaAudioStage7Enabled(): boolean {
  return isAndroidQaDocumentModelBootstrapEnabled()
    && /\.qa\/cache\/$/u.test(getAppCacheRootDir() ?? '');
}
function fixtureUri(id: 'r1' | 'r2'): string {
  check(isAndroidQaAudioStage7Enabled(), 'isolated_package_required');
  return `${getAppCacheRootDir()}stage7-fixtures/${id === 'r1' ? 'r1-george' : 'r2-zira'}.wav`;
}
function assertSyntheticSource(audio: PreparedAudio, filename: string): void {
  const expected = syntheticFixtures.fixtures.find(item => item.filename === filename);
  check(expected && audio.sourceSha256 === expected.sha256 && audio.sampleRate === expected.sampleRate
    && audio.sampleCount === expected.sampleCount, 'synthetic_fixture_identity_mismatch');
}
export function continueAndroidQaAudioStage7(): void {
  if (isAndroidQaAudioStage7Enabled()) continueStep?.();
}
async function gate(phase: string, clipId?: string): Promise<void> {
  publish({ phase, clipId });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      continueStep = resolve;
      timer = setTimeout(() => reject(new QaAudioFailure('host_continuation_timeout')), 180_000);
    });
  } finally { continueStep = null; if (timer) clearTimeout(timer); }
  publish({ clipId: undefined });
}
async function playback(audio: PreparedAudio): Promise<void> {
  await audioSamplePreviewService.play(audio);
  check(audioSamplePreviewService.getState().phase === 'playing', 'preview_not_playing');
  await delay(300);
  await audioSamplePreviewService.stop();
}
function safeFailureCode(error: unknown): string {
  if (error instanceof AudioPreparationError) {
    let fallback: string;
    switch (error.code) {
      case 'invalid_audio': fallback = 'audio_preparation_invalid_audio'; break;
      case 'audio_limit': fallback = 'audio_preparation_limit'; break;
      case 'cancelled': fallback = 'audio_preparation_cancelled'; break;
      case 'preparation_failed': fallback = 'audio_preparation_failed'; break;
      case 'cleanup_failed': fallback = 'audio_preparation_cleanup_failed'; break;
      default: return 'qa_operation_failed';
    }
    switch (error.safeReason) {
      case 'native_result': return 'audio_preparation_native_result';
      case 'prepared_uri': return 'audio_preparation_prepared_uri';
      case 'channels': return 'audio_preparation_channels';
      case 'sample_rate': return 'audio_preparation_sample_rate';
      case 'sample_count': return 'audio_preparation_sample_count';
      case 'output_size': return 'audio_preparation_output_size';
      case 'source_hash': return 'audio_preparation_source_hash';
      case 'output_hash': return 'audio_preparation_output_hash';
      case 'native_input': return 'audio_preparation_native_input';
      case 'native_admission': return 'audio_preparation_native_admission';
      case 'native_sniff': return 'audio_preparation_native_sniff';
      case 'native_output': return 'audio_preparation_native_output';
      case 'native_decode': return 'audio_preparation_native_decode';
      case 'native_identity': return 'audio_preparation_native_identity';
      case 'native_delivery': return 'audio_preparation_native_delivery';
      default: return fallback;
    }
  }
  return error instanceof QaAudioFailure || error instanceof TtsError ? error.code : 'qa_operation_failed';
}
function run(mode: Mode, action: () => Promise<void>): Promise<void> {
  if (!isAndroidQaAudioStage7Enabled()) return Promise.resolve();
  if (active) return active;
  evidence = initial(); publish({ mode, status: 'running', phase: 'prepare' });
  active = action().then(() => publish({ status: 'native_passed', phase: 'complete' }), error => {
    publish({ status: 'failed', phase: 'complete', failureCode: safeFailureCode(error),
      requiresForceStop: llmEngineService.hasAuxiliaryContextOperation()
        || llmEngineService.hasActiveCompletion() || llmEngineService.getState().diagnostics?.contextRecoveryStatus === 'failed' });
  }).finally(() => { active = null; });
  return active;
}

/** Host injection begins only after actual Recording, then explicitly requests Stop. */
export function runAndroidQaStage7Recording(): Promise<void> {
  return run('recording', async () => {
    let prepared: PreparedAudio | undefined;
    try {
      check(audioRecordingService.getState().phase === 'idle', 'recorder_busy');
      await audioRecordingService.start({ ownerKey: 'qa-stage7-recorder', purpose: 'chat' });
      check(audioRecordingService.getState().phase === 'recording', 'recorder_not_recording');
      pass({ id: 'recording_started' });
      await gate('recording_awaiting_controlled_sound');
      const source = await audioRecordingService.stop();
      check(source && audioRecordingService.getState().phase === 'ready', 'source_not_finalized');
      pass({ id: 'recording_finalized', durationMs: source.durationMillis, sizeBytes: source.byteSize });
      prepared = await prepareManagedAudio({ sourceUri: source.uri, purpose: 'chat' });
      pass({ id: 'recording_prepared', sampleRate: prepared.sampleRate, sampleCount: prepared.sampleCount,
        sizeBytes: prepared.sizeBytes, sourceSha256: prepared.sourceSha256, headerValidated: true });
      await playback(prepared); pass({ id: 'recording_preview' });
      // Parent copies this controlled recorded clip before it is discarded; no personal audio.
      await FileSystem.copyAsync({ from: prepared.uri, to: `${getAppCacheRootDir()}stage7-fixtures/recorded.wav` });
      await gate('awaiting_clip_copy', 'recorded');
      await discardPreparedAudio(prepared); prepared = undefined;
      await audioRecordingService.cancelAndClear();
      check(!(await FileSystem.getInfoAsync(source.uri)).exists, 'source_discard_failed');
      pass({ id: 'recording_discard' });

      await audioRecordingService.start({ ownerKey: 'qa-stage7-background', purpose: 'chat' });
      check(audioRecordingService.getState().phase === 'recording', 'retry_not_recording');
      pass({ id: 'recording_retry' });
      await gate('recording_awaiting_background');
      // The runner backgrounds this isolated app during the gate; no simulated lifecycle call.
      const interrupted = audioRecordingService.getState();
      check(AppState.currentState === 'active' && interrupted.phase === 'ready' && interrupted.interrupted === true,
        'background_not_finalized');
      await delay(500);
      check(audioRecordingService.getState().phase === 'ready', 'automatic_recording_resume');
      pass({ id: 'recording_background', interrupted: true, noAutomaticResume: true });
    } finally {
      await audioSamplePreviewService.stop();
      if (prepared) await discardPreparedAudio(prepared);
      await audioRecordingService.cancelAndClear();
    }
  });
}

export const ANDROID_QA_STAGE7_AUDIO_MODEL_ID = 'pocket-ai/android-qa-ultravox-1b';
/** One fixed backbone/projector, natively verified from host fixtures or the download queue. */
export async function prepareAndroidQaStage7AudioModel(): Promise<ModelMetadata> {
  check(isAndroidQaAudioStage7Enabled(), 'isolated_package_required');
  const source = audioFixture.audioInput;
  const url = (file: string) => `https://huggingface.co/${source.repository}/resolve/${source.revision}/${file}?download=true`;
  const projectorId = 'android-qa-stage7-ultravox-projector';
  const desired = normalizePersistedModelMetadata({ id: ANDROID_QA_STAGE7_AUDIO_MODEL_ID, name: 'Android QA Ultravox 1B',
    author: 'ggml-org / fixie-ai', size: source.backbone.bytes, sha256: source.backbone.sha256,
    downloadUrl: url(source.backbone.filename), resolvedFileName: source.backbone.filename, hfRevision: source.revision,
    lifecycleStatus: LifecycleStatus.AVAILABLE, fitsInRam: null, downloadProgress: 0, metadataTrust: 'trusted_remote',
    accessState: ModelAccessState.PUBLIC, isPrivate: false, isGated: false,
    roleEvidence: [{ role: 'chat', source: 'model_card', confidence: 'declared' }],
    chatModalities: ['text', 'audio'], artifactRole: 'primary_chat_model', selectedProjectorId: projectorId,
    projectorCandidates: [{ id: projectorId, ownerModelId: ANDROID_QA_STAGE7_AUDIO_MODEL_ID,
      repoId: source.repository, fileName: source.projector.filename, hfRevision: source.revision,
      downloadUrl: url(source.projector.filename), sha256: source.projector.sha256, size: source.projector.bytes,
      lifecycleStatus: 'available', matchStatus: 'matched' }],
    artifacts: [{ id: projectorId, kind: 'multimodal_projector', requiredFor: ['audio'],
      hfRevision: source.revision, remoteFileName: source.projector.filename, downloadUrl: url(source.projector.filename),
      sizeBytes: source.projector.bytes, sha256: source.projector.sha256, installState: 'remote' }] });
  const desiredProjector = desired.artifacts?.find(item => item.id === desired.selectedProjectorId);
  check(desiredProjector, 'audio_fixture_identity_conflict');
  const ready = () => {
    const model = registry.getModel(desired.id);
    const artifact = model?.artifacts?.find(item => item.id === desiredProjector.id);
    return model?.localPath && getModelFileIdentity(model) === getModelFileIdentity(desired)
      && model.downloadIntegrity?.kind === 'sha256' && model.downloadIntegrity.sha256 === source.backbone.sha256
      && model.downloadIntegrity.sizeBytes === source.backbone.bytes
      && model.selectedProjectorId === desiredProjector.id
      && artifact?.localPath && getCompanionSourceIdentity(artifact) === getCompanionSourceIdentity(desiredProjector)
      && artifact.installState === 'installed' && artifact.integrity?.kind === 'sha256'
      && artifact.integrity.sha256 === source.projector.sha256 && artifact.integrity.sizeBytes === source.projector.bytes ? model : undefined;
  };
  const existing = ready(); if (existing) return existing;
  const seeded = await prepareAndroidQaStage7Seed('ultravox', desired);
  if (seeded) return seeded;
  const manager = getModelDownloadManager();
  let owned = false;
  try {
    const current = registry.getModel(desired.id);
    check(!current?.localPath || getModelFileIdentity(current) === getModelFileIdentity(desired), 'audio_fixture_identity_conflict');
    const queued = useDownloadStore.getState().queue.find(item => item.id === desired.id);
    if (queued) check(getModelFileIdentity(queued) === getModelFileIdentity(desired), 'audio_fixture_queue_conflict');
    else {
      owned = true;
      registry.updateModel({ ...desired, ...(current?.localPath ? { localPath: current.localPath,
        downloadIntegrity: current.downloadIntegrity } : {}) });
      useDownloadStore.getState().addToQueue(registry.getModel(desired.id)!);
    }
    const deadline = Date.now() + 1_800_000;
    while (!ready()) {
      check(Date.now() < deadline, 'audio_fixture_download_timeout');
      const job = useDownloadStore.getState().queue.find(item => item.id === desired.id);
      check(job?.lifecycleStatus !== LifecycleStatus.FAILED && job?.lifecycleStatus !== LifecycleStatus.PAUSED,
        'audio_fixture_download_failed');
      await delay(250);
    }
    return ready()!;
  } catch (error) {
    if (owned && useDownloadStore.getState().queue.some(item => item.id === desired.id)) {
      await manager.cancelDownload(desired.id, { waitForDrain: true });
      check(!useDownloadStore.getState().queue.some(item => item.id === desired.id), 'audio_download_cleanup_failed');
    }
    throw error;
  }
}

/** Imported fixture and emulator-captured fixture are separate actual input_audio proofs. */
export function runAndroidQaStage7Input(): Promise<void> {
  return run('input', async () => {
    const originalModel = llmEngineService.getState().activeModelId;
    const originalProfile = llmEngineService.getEffectiveLoadParameters();
    let prepared: PreparedAudio | undefined;
    try {
      const model = await prepareAndroidQaStage7AudioModel();
      await llmEngineService.load(model.id, { forceReload: true, loadParamsMode: 'replace', loadParamsOverride: {
        contextSize: 2048, backendPolicy: 'cpu', gpuLayers: 0, mtpEnabled: false, parallelSlots: 1,
        cpuThreads: 4, useMmap: true } });
      const readiness = registry.getModel(model.id)?.multimodalReadiness;
      check(readiness?.status === 'ready' && readiness.support.includes('audio'), 'native_audio_support_missing');
      for (const kind of ['imported', 'recorded'] as const) {
        publish({ phase: `input_${kind}` });
        const sourceUri = `${getAppCacheRootDir()}stage7-fixtures/${kind === 'imported' ? 'input-orange-seven' : 'recorded'}.wav`;
        prepared = await prepareManagedAudio({ sourceUri, purpose: 'chat' });
        if (kind === 'imported') assertSyntheticSource(prepared, 'input-orange-seven.wav');
        let callbacks = 0;
        const result = await llmEngineService.chatCompletion({ expectedModelId: model.id, multimodalReadiness: readiness,
          messages: [{ role: 'user', content: 'Repeat the color and number spoken in this audio. Answer with the color and number only.',
            contentParts: [{ type: 'text', text: 'Repeat the color and number spoken in this audio. Answer with the color and number only.' },
              { type: 'input_audio', input_audio: { format: 'wav', url: prepared.uri } }] }],
          params: { n_predict: 48, temperature: 0, enable_thinking: false }, onToken: () => { callbacks += 1; } });
        const text = result.content ?? result.text ?? '';
        const matched = /\borange\b/iu.test(text) && /\b(?:seven|7)\b/iu.test(text);
        check(callbacks > 0 && text.trim().length && !llmEngineService.hasActiveCompletion(), 'audio_completion_missing');
        check(matched, `audio_${kind}_content_mismatch`);
        pass({ id: `input_${kind}`, fixtureKind: kind, sampleRate: prepared.sampleRate, sampleCount: prepared.sampleCount,
          sourceSha256: prepared.sourceSha256, headerValidated: true, callbacks, outputCharacters: text.length,
          contentMatched: true, completionDrained: true });
        await discardPreparedAudio(prepared); prepared = undefined;
      }
    } finally {
      if (prepared) await discardPreparedAudio(prepared);
      if (!llmEngineService.hasActiveCompletion()) {
        if (originalModel && originalProfile) await llmEngineService.load(originalModel,
          { forceReload: true, loadParamsMode: 'replace', loadParamsOverride: originalProfile });
        else await llmEngineService.unload();
      } else throw new QaAudioFailure('audio_completion_not_drained');
    }
  });
}

const TARGET_TEXT = syntheticFixtures.referenceComparisonTarget;
export function runAndroidQaStage7Voices(): Promise<void> {
  return run('voices', executeVoices);
}
async function executeVoices(): Promise<void> {
  const originalThread = useChatStore.getState().activeThreadId;
  const originalBindings = getSettings().auxiliaryModels;
  const originalModel = llmEngineService.getState().activeModelId;
  const originalProfile = llmEngineService.getEffectiveLoadParameters();
  let ownedThread: string | undefined;
  let savedId: string | undefined;
  try {
    await prepareAndroidQaStage3Adapter(180_000);
    const base = registry.getModel(ANDROID_QA_DOCUMENT_MODEL_ID);
    const adapter = base?.artifacts?.find(item => item.kind === 'lora_adapter'
      && item.sha256 === loraFixture.adapter.sha256 && item.installState === 'installed' && item.localPath);
    check(base && adapter, 'stage3_adapter_missing');
    const loraAdapters = [{ artifactId: adapter.id, artifactIdentity: getCompanionSourceIdentity(adapter),
      baseModelIdentity: getCompanionBindingIdentity(base), scale: 0.5, sizeBytes: adapter.sizeBytes ?? undefined }];
    ownedThread = useChatStore.getState().createThread({ modelId: base.id, title: 'Android audio voices QA',
      presetId: null, presetSnapshot: DEFAULT_PRESET_SNAPSHOT, loraSnapshot: loraAdapters,
      paramsSnapshot: { temperature: 0, topP: 1, maxTokens: 32, seed: 42 } });
    await llmEngineService.load(base.id, { forceReload: true, loadParamsMode: 'replace', loadParamsOverride: {
      contextSize: 512, gpuLayers: 0, backendPolicy: 'cpu', mtpEnabled: false, kvCacheType: 'f16',
      loraAdapters, parallelSlots: 1, useMmap: true, cpuThreads: 4 } });
    const before = getAndroidQaEffectiveProfileIdentity(llmEngineService.getEffectiveLoadParameters());
    const history = JSON.stringify(useChatStore.getState().threads);
    const restored = () => {
      const state = llmEngineService.getState();
      check(state.activeModelId === base.id && state.status === 'ready'
        && state.diagnostics?.backendMode === 'cpu' && state.diagnostics.actualGpuAccelerated === false
        && state.diagnostics.initNParallel === 1 && state.diagnostics.stateCacheBudgetMb === 0
        && state.diagnostics.stateCacheMaxCheckpoints === 8
        && getAndroidQaEffectiveProfileIdentity(llmEngineService.getEffectiveLoadParameters()) === before, 'profile_restore');
      check(JSON.stringify(useChatStore.getState().threads) === history, 'chat_history_changed');
    };
    const synthesize = async (id: 'neu-jo' | 'qwen-r1-eager' | 'qwen-r2-lazy' | 'qwen-no-reference',
      profileId: string, voice: TtsVoiceSelection) => {
      publish({ phase: id });
      const profile = TTS_EXECUTION_PROFILES.find(item => item.id === profileId);
      check(profile, 'profile_missing');
      const model = await prepareAndroidQaTtsProfile(profile);
      selectAuxiliaryModel('tts', model);
      const observations: TtsObservation[] = [];
      await ttsService.start({ text: TARGET_TEXT, language: 'en', voice, playAfterSynthesis: false,
        observe: event => observations.push(event) });
      restored();
      const decoded = observations.find(event => event.operation === 'decode' && event.phase === 'settled');
      const formatted = observations.find(event => event.operation === 'formatter' && event.phase === 'settled');
      check(decoded?.sampleCount && decoded.sampleRate && formatted && ttsService.getState().clipAvailable, 'synthesis_receipt');
      const events = observations.filter(event => event.phase === 'settled').map(event => event.operation);
      if (voice.kind === 'reference') {
        check(events.includes('speaker_create') && events.includes('speaker_release') && formatted.speakerRows === 1
          && formatted.speakerBaked === true, 'reference_not_used');
        check(events.includes('speaker_bake') === (voice.bake === 'eager'), 'bake_mode_mismatch');
        check(events.indexOf('speaker_release') < events.indexOf('vocoder_release'), 'speaker_release_order');
      } else check(!events.includes('speaker_create'), 'unexpected_reference');
      const phones = observations.find(event => event.operation === 'phonemizer' && event.phase === 'settled');
      if (id === 'neu-jo') check(phones && Number.isFinite(phones.elapsedMs), 'phonemizer_not_executed');
      await ttsService.play(); check(ttsService.getState().phase === 'playing', 'tts_not_playing');
      await delay(300); await ttsService.stop();
      pass({ id, profileId, sampleRate: decoded.sampleRate, sampleCount: decoded.sampleCount,
        speakerRows: formatted.speakerRows, speakerBaked: formatted.speakerBaked,
        phonemizerElapsedMs: phones?.elapsedMs, operations: events, profileRestored: true, chatUnchanged: true });
      await gate('awaiting_clip_copy', id);
      await ttsService.cancelAndClear();
    };
    await synthesize('neu-jo', 'neutts-nano-q4_k_m-neucodec-q8_0', { kind: 'builtin', voice: 'jo' });
    const references: Record<'r1' | 'r2', { sha256: string; durationMs: number }> = {} as never;
    for (const id of ['r1', 'r2'] as const) {
      const prepared = await prepareManagedAudio({ sourceUri: fixtureUri(id), purpose: 'reference', sampleRate: 24000 });
      assertSyntheticSource(prepared, id === 'r1' ? 'r1-george.wav' : 'r2-zira.wav');
      references[id] = { sha256: prepared.sourceSha256, durationMs: prepared.durationMs };
      pass({ id: `reference-${id}`, sourceSha256: prepared.sourceSha256,
        sampleRate: prepared.sampleRate, sampleCount: prepared.sampleCount, durationMs: prepared.durationMs });
      await discardPreparedAudio(prepared);
    }
    check(references.r1.sha256 !== references.r2.sha256, 'reference_fixture_same');
    await synthesize('qwen-r1-eager', 'qwen3-tts-0.6b-q4_k_m-tokenizer-q8_0', { kind: 'reference', bake: 'eager',
      source: { kind: 'temporary', sourceUri: fixtureUri('r1'), sourceSha256: references.r1.sha256,
        durationMs: references.r1.durationMs, consent: true } });
    await synthesize('qwen-r2-lazy', 'qwen3-tts-0.6b-q4_k_m-tokenizer-q8_0', { kind: 'reference', bake: 'lazy',
      source: { kind: 'temporary', sourceUri: fixtureUri('r2'), sourceSha256: references.r2.sha256,
        durationMs: references.r2.durationMs, consent: true } });
    await synthesize('qwen-no-reference', 'qwen3-tts-0.6b-q4_k_m-tokenizer-q8_0', { kind: 'speakerless' });
    publish({ phase: 'chat_after' });
    let callbacks = 0;
    const result = await llmEngineService.chatCompletion({ expectedModelId: base.id,
      messages: [{ role: 'user', content: 'Write one short sentence about a friendly dog.' }],
      params: { n_predict: 32, temperature: 0, enable_thinking: false }, onToken: () => { callbacks += 1; } });
    check(callbacks > 0 && (result.content ?? result.text)?.trim().length && !llmEngineService.hasActiveCompletion(), 'chat_after_failed');
    restored(); pass({ id: 'chat_after', callbacks, profileRestored: true, chatUnchanged: true });
    referenceVoiceStore.hydrate();
    check(referenceVoiceStore.getState().voices.length === 0, 'qa_voice_library_not_empty');
    const saved = await referenceVoiceStore.save({ sourceUri: fixtureUri('r1'), sourceSha256: references.r1.sha256,
      durationMs: references.r1.durationMs, sourceMimeType: 'audio/wav', name: 'Stage7 synthetic QA', consent: true, language: 'en' });
    savedId = saved.id; referenceVoiceStore.select(saved.id);
    pass({ id: 'voice_saved', voiceCount: 1, selected: true, handlesPersisted: false });
    // Saved metadata remains for the runner's genuine force-stop/cold reopen check.
    savedId = undefined;
  } finally {
    await ttsService.cancelAndClear();
    if (savedId) await referenceVoiceStore.delete(savedId);
    if (!llmEngineService.hasAuxiliaryContextOperation() && !llmEngineService.hasActiveCompletion()) {
      if (originalModel && originalProfile) await llmEngineService.load(originalModel,
        { forceReload: true, loadParamsMode: 'replace', loadParamsOverride: originalProfile });
      else await llmEngineService.unload();
      if (ownedThread) useChatStore.getState().deleteThread(ownedThread);
      useChatStore.getState().setActiveThread(originalThread);
      updateSettings({ auxiliaryModels: originalBindings });
    } else throw new QaAudioFailure('cleanup_native_owner_pending');
  }
}

/** A genuine cold process restores only metadata, then removes just the owned encrypted sample. */
export function checkAndroidQaStage7ColdVoice(): Promise<void> {
  return run('cold_voice', async () => {
    check(audioRecordingService.getState().phase === 'idle' && ttsService.getState().phase === null,
      'cold_audio_activity');
    referenceVoiceStore.hydrate();
    const state = referenceVoiceStore.getState();
    const voice = state.voices.find(item => item.name === 'Stage7 synthetic QA');
    check(voice && state.voices.length === 1 && state.selectedVoiceId === voice.id, 'cold_saved_voice_missing');
    check(!Object.keys(voice).some(key => /speaker|handle|embedding|pcm/iu.test(key)), 'native_handle_persisted');
    pass({ id: 'voice_cold', voiceCount: 1, selected: true, handlesPersisted: false });
    const originalBindings = getSettings().auxiliaryModels;
    const originalProfile = getAndroidQaEffectiveProfileIdentity(llmEngineService.getEffectiveLoadParameters());
    const originalModel = llmEngineService.getState().activeModelId;
    try {
      const profile = TTS_EXECUTION_PROFILES.find(item => item.id === 'qwen3-tts-0.6b-q4_k_m-tokenizer-q8_0');
      check(profile, 'profile_missing');
      selectAuxiliaryModel('tts', await prepareAndroidQaTtsProfile(profile));
      const observations: TtsObservation[] = [];
      await ttsService.start({ text: TARGET_TEXT, language: 'en', voice: { kind: 'reference', bake: 'eager',
        source: { kind: 'saved', voiceId: voice.id, sourceSha256: voice.sourceSha256 } },
      playAfterSynthesis: false, observe: event => observations.push(event) });
      const decoded = observations.find(event => event.operation === 'decode' && event.phase === 'settled');
      const formatted = observations.find(event => event.operation === 'formatter' && event.phase === 'settled');
      const operations = observations.filter(event => event.phase === 'settled').map(event => event.operation);
      check(decoded?.sampleCount && decoded.sampleRate && formatted?.speakerRows === 1 && formatted.speakerBaked === true
        && operations.includes('speaker_create') && operations.includes('speaker_bake') && operations.includes('speaker_release')
        && operations.indexOf('speaker_release') < operations.indexOf('vocoder_release'), 'cold_saved_synthesis_missing');
      check(llmEngineService.getState().activeModelId === originalModel
        && getAndroidQaEffectiveProfileIdentity(llmEngineService.getEffectiveLoadParameters()) === originalProfile, 'profile_restore');
      await ttsService.play(); check(ttsService.getState().phase === 'playing', 'tts_not_playing');
      await delay(300); await ttsService.stop();
      pass({ id: 'qwen-saved-cold', profileId: profile.id, sampleRate: decoded.sampleRate, sampleCount: decoded.sampleCount,
        speakerRows: formatted.speakerRows, speakerBaked: formatted.speakerBaked, operations, profileRestored: true });
      await gate('awaiting_clip_copy', 'qwen-saved-cold');
    } finally {
      await ttsService.cancelAndClear();
      updateSettings({ auxiliaryModels: originalBindings });
    }
    await referenceVoiceStore.delete(voice.id);
    referenceVoiceStore.hydrate();
    check(referenceVoiceStore.getState().voices.length === 0 && referenceVoiceStore.getState().selectedVoiceId === null,
      'voice_delete_failed');
    check((await FileSystem.getInfoAsync(fixtureUri('r1'))).exists, 'borrowed_fixture_deleted');
    pass({ id: 'voice_deleted', voiceCount: 0, selected: false, handlesPersisted: false });
  });
}
