import * as FileSystem from 'expo-file-system/legacy';
import * as RNFS from 'react-native-fs';
import type { ModelArtifactMetadata, ModelMetadata } from '../types/models';
import { getThreadActiveModelId } from '../types/chat';
import { useChatStore } from '../store/chatStore';
import { getModelFileIdentity } from '../utils/modelRoles';
import { getCompanionSourceIdentity, getSelectedManagedCompanions } from '../utils/modelArtifacts';
import { fileUriToNativePath, safeJoinModelPath } from '../utils/safeFilePath';
import { validateGgufFileHeader } from '../utils/ggufValidation';
import { normalizeSha256Digest } from '../utils/sha256';
import { encodeMonoPcmWav, TtsWavError } from '../utils/ttsWav';
import { prepareSpeechText, TtsTextError } from '../utils/ttsText';
import { TTS_LIMITS, TtsError, type TtsErrorCode, type TtsPhase, type TtsObservation, type TtsVoiceSelection } from '../types/tts';
import { getAuxiliarySelection, validateAuxiliaryFile } from './AuxiliaryModelService';
import { registry } from './LocalStorageRegistry';
import { getSettings, subscribeSettings } from './SettingsStore';
import { getModelsDir } from './FileSystemSetup';
import { llmEngineService } from './LLMEngineService';
import { runWithIdleModelDownloads } from './ModelDownloadManager';
import { assertPrivateStorageWritable, isPrivateStorageWritable } from './storage';
import { getSystemMemorySnapshot } from './SystemMetricsService';
import { resolveConservativeAvailableMemoryBudget } from '../memory/budget';
import { getLlamaBuildInfo } from './LlamaRuntimeAdapter';
import { LLAMA_SOURCE_PATCH_SHA256 } from './LlamaSourcePatchIdentity';
import { getTtsExecutionProfile, getTtsInitParameters, estimateTtsPeakBytes, getTtsProfileIdentity,
  type TtsExecutionProfile } from './TtsExecutionProfiles';
import { synthesizeTtsOnContext, type TtsPcmResult } from './TtsSynthesisRuntime';
import { TtsPlaybackController, cleanupColdTtsClips } from './TtsPlayback';
import { referenceVoiceStore, type ReferenceVoiceLease } from './ReferenceVoiceStore';
import { prepareManagedAudio, readPreparedReferencePcm, discardPreparedAudio, AudioPreparationError, type PreparedAudio } from './AudioPreparationService';
import { LOCAL_PHONEMIZER_IDENTITY } from './TtsPhonemizer';

export interface TtsRequest {
  /** Exact text already shown in the preview. No chat protocol or hidden channels. */
  text: string;
  language: string;
  voice?: TtsVoiceSelection;
  source?: { threadId: string; messageId: string };
  isTextCurrent?: () => boolean;
  /** Stable text/language ownership for exact-A restore after closing the preview. */
  isRestoreCurrent?: () => boolean;
  /** Voice changes block stale speech publication without changing exact-A restoration. */
  isVoiceCurrent?: () => boolean;
  playAfterSynthesis?: boolean;
  observe?: (event: TtsObservation) => void;
}
export interface TtsServiceState {
  phase: TtsPhase | null;
  errorCode?: TtsErrorCode;
  profileId?: string;
  requiredBytes?: number;
  memoryConfidence?: 'low';
  position?: number;
  duration?: number;
  sampleRate?: number;
  sampleCount?: number;
  /** True only while the service owns a validated clip; cleanup errors still block reuse. */
  clipAvailable?: boolean;
}
interface TtsBinding {
  model: ModelMetadata;
  codec: ModelArtifactMetadata;
  profile: TtsExecutionProfile;
  backboneIdentity: string;
  codecIdentity: string;
  backbonePath: string;
  codecPath: string;
  codecUri: string;
}

export function resolveTtsBinding(): TtsBinding {
  assertPrivateStorageWritable();
  const model = getAuxiliarySelection('tts');
  if (!model) throw new TtsError('selection_missing');
  const codec = getSelectedManagedCompanions(model).find(artifact => artifact.kind === 'tts_codec');
  if (!model.localPath || !codec?.localPath || codec.installState !== 'installed') throw new TtsError('files_missing');
  const profile = getTtsExecutionProfile(model.sha256, codec.sha256);
  if (!profile) throw new TtsError('profile_unverified');
  if (model.size !== profile.backbone.bytes || codec.sizeBytes !== profile.codec.bytes) throw new TtsError('codec_incompatible');
  const root = getModelsDir();
  const backboneUri = root ? safeJoinModelPath(root, model.localPath) : null;
  const codecUri = root ? safeJoinModelPath(root, codec.localPath) : null;
  if (!backboneUri || !codecUri) throw new TtsError('files_missing');
  return { model, codec, profile, backboneIdentity: getModelFileIdentity(model),
    codecIdentity: getCompanionSourceIdentity(codec), backbonePath: fileUriToNativePath(backboneUri),
    codecPath: fileUriToNativePath(codecUri), codecUri };
}

export function getTtsSelectionStatus(): { profileId?: string; modelName?: string; languages?: readonly string[];
  voiceModes?: readonly ('speakerless' | 'builtin' | 'reference')[]; builtinVoices?: readonly string[];
  requiredBytes?: number; errorCode?: TtsErrorCode } {
  try {
    const binding = resolveTtsBinding();
    return { profileId: binding.profile.id, modelName: binding.model.name, languages: binding.profile.languages,
      voiceModes: binding.profile.voiceModes ?? ['speakerless'], builtinVoices: binding.profile.builtinVoices,
      requiredBytes: estimateTtsPeakBytes(binding.profile) };
  } catch (error) {
    return { errorCode: error instanceof TtsError ? error.code : 'files_missing' };
  }
}

function assertBindingCurrent(binding: TtsBinding): void {
  if (!isPrivateStorageWritable()) throw new TtsError('selection_changed');
  const live = getAuxiliarySelection('tts');
  const codec = live ? getSelectedManagedCompanions(live).find(artifact => artifact.kind === 'tts_codec') : undefined;
  if (!live || getModelFileIdentity(live) !== binding.backboneIdentity || live.localPath !== binding.model.localPath
    || !codec || codec.installState !== 'installed' || codec.localPath !== binding.codec.localPath
    || getCompanionSourceIdentity(codec) !== binding.codecIdentity) throw new TtsError('selection_changed');
}

async function validateTtsFiles(binding: TtsBinding): Promise<void> {
  assertBindingCurrent(binding);
  try {
    await validateAuxiliaryFile(binding.model);
    assertBindingCurrent(binding);
    const info = await FileSystem.getInfoAsync(binding.codecUri);
    if (!info.exists || info.isDirectory || info.size !== binding.profile.codec.bytes) throw new TtsError('integrity_failed');
    await validateGgufFileHeader(binding.codecUri, info);
    assertBindingCurrent(binding);
    const digest = normalizeSha256Digest(await RNFS.hash(binding.codecPath, 'sha256'));
    assertBindingCurrent(binding);
    if (digest !== binding.profile.codec.sha256) throw new TtsError('integrity_failed');
  } catch (error) {
    if (error instanceof TtsError) throw error;
    throw new TtsError('integrity_failed');
  }
}

function captureChatSelection(source: TtsRequest['source']): string {
  const state = useChatStore.getState();
  const thread = state.activeThreadId ? state.threads[state.activeThreadId] : undefined;
  const message = source ? state.threads[source.threadId]?.messages.find(item => item.id === source.messageId) : undefined;
  const settings = getSettings();
  if (source && (state.activeThreadId !== source.threadId || !message || message.role !== 'assistant'
    || message.state !== 'complete')) throw new TtsError('selection_changed');
  return JSON.stringify([state.activeThreadId, thread ? getThreadActiveModelId(thread) : null,
    thread?.paramsSnapshot, thread?.loraSnapshot,
    settings.activeModelId, settings.modelLoadParamsByModelId, settings.modelParamsByModelId,
    settings.auxiliaryModels, message ? [message.id, message.content, message.state, message.structuredOutput] : null]);
}

/** A single process-local owner. No history writes, no tools/retrieval, no queued synthesis jobs. */
export class TtsService {
  private state: TtsServiceState = { phase: null };
  private readonly listeners = new Set<() => void>();
  private controller: AbortController | null = null;
  private drain: Promise<void> | null = null;
  private controlDrain: Promise<void> | null = null;
  private controlKind: 'stop' | 'clear' | null = null;
  private unsubscriptions: (() => void)[] = [];
  private generation = 0;
  private executionIdentity: string | null = null;
  private playbackGeneration: number | null = null;
  private readonly playback = new TtsPlaybackController();

  constructor() {
    this.playback.subscribe(() => {
      if ((this.drain && this.playbackGeneration !== this.generation) || this.controlDrain || (this.state.phase === 'error'
        && ['storage_failed', 'release_failed', 'restore_failed'].includes(this.state.errorCode ?? ''))) return;
      const next = this.playback.getState();
      const errorCode = next.errorCode;
      this.publish({ ...this.state, phase: next.phase, position: next.position, duration: next.duration,
        errorCode });
    });
  }
  getState = (): TtsServiceState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private publish(state: TtsServiceState): void {
    this.state = state;
    this.listeners.forEach(listener => { try { listener(); } catch { /* Views cannot interrupt cleanup. */ } });
  }
  private unsubscribe(): void { this.unsubscriptions.splice(0).forEach(remove => remove()); }
  getExecutionIdentity = (): string | null => this.executionIdentity;

  async cleanupCold(): Promise<void> {
    try { await cleanupColdTtsClips(); }
    catch { this.publish({ phase: 'error', errorCode: 'storage_failed' }); throw new TtsError('storage_failed'); }
  }

  checkFiles(): Promise<void> {
    if (this.drain || this.controlDrain) return Promise.reject(new TtsError('busy'));
    const controller = new AbortController();
    this.controller = controller;
    const generation = ++this.generation;
    const work = Promise.resolve().then(() => this.performFileCheck(controller, generation));
    this.drain = work;
    void work.finally(() => {
      if (this.drain === work) { this.drain = null; this.controller = null; }
    }).catch(() => undefined);
    return work;
  }

  private async performFileCheck(controller: AbortController, generation: number): Promise<void> {
    try {
      this.unsubscribe();
      await this.playback.clear();
      const binding = resolveTtsBinding();
      this.publish({ phase: 'checking', profileId: binding.profile.id, requiredBytes: estimateTtsPeakBytes(binding.profile), memoryConfidence: 'low' });
      await runWithIdleModelDownloads(() => llmEngineService.runWithIdleModelResources(() => validateTtsFiles(binding), []));
      if (controller.signal.aborted || generation !== this.generation) throw new TtsError('cancelled');
      // Files checked does not claim loaded model, synthesis, playback or content verification.
      this.publish({ ...this.state, phase: null });
    } catch (error) {
      this.publish({ ...this.state, phase: 'error', errorCode: error instanceof TtsError ? error.code : 'busy' });
      throw error;
    }
  }

  start(request: TtsRequest): Promise<void> {
    if (this.drain || this.controlDrain || llmEngineService.hasAuxiliaryContextOperation()
      || llmEngineService.hasActiveCompletion() || llmEngineService.hasActiveChatBlockingContextOperation()) {
      return Promise.reject(new TtsError('busy'));
    }
    const controller = new AbortController();
    this.controller = controller;
    const generation = ++this.generation;
    const work = Promise.resolve().then(() => this.perform(request, controller, generation));
    this.drain = work;
    void work.finally(() => {
      if (this.drain === work) { this.drain = null; this.controller = null; }
    }).catch(() => undefined);
    return work;
  }

  private async perform(request: TtsRequest, controller: AbortController, generation: number): Promise<void> {
    this.unsubscribe();
    this.executionIdentity = null;
    this.playbackGeneration = null;
    let clipInstalled = false;
    let selectionInvalidated = false;
    let voiceInvalidated = false;
    let referenceLease: ReferenceVoiceLease | undefined;
    let preparedReference: PreparedAudio | undefined;
    let referenceSamples: number[] | undefined;
    try {
      await this.playback.clear();
      assertPrivateStorageWritable();
      // Applying this guard again rejects protocol/private paths in an edited standalone preview.
      const exactText = prepareSpeechText(request.text, { structured: true }).text;
      if (!exactText || exactText.length > TTS_LIMITS.textCharacters) throw new TtsError('input_too_large');
      const binding = resolveTtsBinding();
      const voice: TtsVoiceSelection = request.voice ?? { kind: 'speakerless' };
      // A builtin name must be explicitly selected; never synthesize a phantom default.
      if (!['speakerless', 'builtin', 'reference'].includes(voice.kind)
        || !(binding.profile.voiceModes ?? ['speakerless']).includes(voice.kind)) throw new TtsError('voice_unavailable');
      let referenceUri: string | undefined;
      let referenceSha: string | undefined;
      if (voice.kind === 'reference') {
        const ref = voice.source;
        referenceSha = ref.sourceSha256;
        if (normalizeSha256Digest(referenceSha) !== referenceSha) throw new TtsError('reference_invalid');
        if (ref.kind === 'temporary') {
          if (ref.consent !== true) throw new TtsError('consent_required');
          if (!binding.profile.reference || !Number.isFinite(ref.durationMs) || ref.durationMs < 200
            || ref.durationMs > binding.profile.reference.maxSeconds * 1000) throw new TtsError('reference_invalid');
          referenceUri = ref.sourceUri;
        } else {
          referenceLease = referenceVoiceStore.acquire(ref.voiceId);
          if (referenceLease.voice.sourceSha256 !== ref.sourceSha256) throw new TtsError('reference_invalid');
        }
      }
      const selectedChat = captureChatSelection(request.source);
      const previousId = llmEngineService.getState().activeModelId;
      const previous = previousId ? registry.getModel(previousId) : undefined;
      const previousIdentity = previous ? getModelFileIdentity(previous) : null;
      const selectionCurrent = () => {
        if (selectionInvalidated || !isPrivateStorageWritable()) return false;
        try {
          if ((request.isRestoreCurrent ?? request.isTextCurrent)?.() === false) return false;
          assertBindingCurrent(binding);
          if (captureChatSelection(request.source) !== selectedChat) return false;
          if (previous) {
            const current = registry.getModel(previous.id);
            if (!current || getModelFileIdentity(current) !== previousIdentity || current.localPath !== previous.localPath) return false;
          }
          return true;
        } catch { return false; }
      };
      const voiceCurrent = () => {
        if (voiceInvalidated) return false;
        try {
          if (request.isVoiceCurrent?.() === false) return false;
          if (voice.kind === 'reference' && voice.source.kind === 'saved') {
            const ref = voice.source;
            const voices = referenceVoiceStore.getState();
            return voices.selectedVoiceId === ref.voiceId && voices.voices.some(item => item.id === ref.voiceId
              && item.sourceSha256 === ref.sourceSha256);
          }
          return true;
        } catch { return false; }
      };
      const publicationCurrent = () => {
        try {
          return generation === this.generation && !controller.signal.aborted
            && selectionCurrent() && voiceCurrent() && request.isTextCurrent?.() !== false;
        } catch { return false; }
      };
      const check = () => {
        if (!selectionCurrent() || !voiceCurrent()) throw new TtsError('selection_changed');
        if (controller.signal.aborted) throw new TtsError('cancelled');
        if (!publicationCurrent()) throw new TtsError('selection_changed');
      };
      const invalidateIfChanged = () => {
        const sameSelection = selectionCurrent(), sameVoice = voiceCurrent();
        if (sameSelection && sameVoice) return;
        if (!sameSelection) selectionInvalidated = true;
        if (!sameVoice) voiceInvalidated = true;
        controller.abort();
        this.playback.cancelStart();
        this.publish({ ...this.state, phase: 'stopping' });
        // The same subscriber protects a ready clip from later model/chat/source changes.
        if (!this.drain) void this.cancelAndClear().catch(() => this.publish({ phase: 'error', errorCode: 'storage_failed' }));
      };
      this.unsubscriptions = [subscribeSettings(invalidateIfChanged), useChatStore.subscribe(invalidateIfChanged),
        registry.subscribeModels(invalidateIfChanged), ...(voice.kind === 'reference' ? [referenceVoiceStore.subscribe(invalidateIfChanged)] : [])];
      check();
      if ((referenceUri || referenceLease) && referenceSha) {
        // A may still be loaded during preprocessing. Admit the bounded native working
        // area plus PCM/JSON bridge copies independently before starting the decoder.
        const memory = await getSystemMemorySnapshot();
        check();
        const available = memory ? resolveConservativeAvailableMemoryBudget(memory, { strictFreeCap: true }) : null;
        if (available === null) throw new TtsError('memory_unknown');
        const preparationBytes = 64 * 1024 * 1024 + binding.profile.reference!.maxSamples * 32;
        if (memory?.lowMemory || available < preparationBytes) throw new TtsError('memory_insufficient');
        // Admit before decrypting a saved source as well as before codec preprocessing.
        if (referenceLease) referenceUri = (await referenceLease.materialize()).uri;
        check();
        if (!referenceUri) throw new TtsError('reference_invalid');
        preparedReference = await prepareManagedAudio({ sourceUri: referenceUri, purpose: 'reference',
          sampleRate: binding.profile.reference!.sampleRate, signal: controller.signal, assertCurrent: check });
        check();
        if (preparedReference.sourceSha256 !== referenceSha) throw new TtsError('reference_invalid');
        referenceSamples = await readPreparedReferencePcm(preparedReference);
        check();
        // Derivative is not needed after bounded PCM validation. Native ownership comes later.
        await discardPreparedAudio(preparedReference);
        preparedReference = undefined;
        check();
      }
      this.publish({ phase: 'checking', profileId: binding.profile.id,
        requiredBytes: estimateTtsPeakBytes(binding.profile), memoryConfidence: 'low' });
      const callbackDrains = new Set<Promise<unknown>>();
      let result: TtsPcmResult;
      // This outer file/download lease survives watchdog rejection until the actual callback
      // settles. Engine quarantine additionally retains the native/context cleanup paths.
      result = await runWithIdleModelDownloads(async () => {
        try {
          return await llmEngineService.runWithAuxiliarySequence({ signal: controller.signal,
            isCurrent: publicationCurrent,
            isSelectionCurrent: selectionCurrent,
          }, sequence => sequence.withContext({ modelId: binding.model.id, signal: controller.signal,
            isCurrent: publicationCurrent,
            nativeDrainTimeoutMs: 600_000,
            initParams: getTtsInitParameters(binding.profile, binding.backbonePath),
            beforeInit: async () => {
              check();
              await validateTtsFiles(binding);
              check();
              const memory = await getSystemMemorySnapshot();
              check();
              const budget = memory ? resolveConservativeAvailableMemoryBudget(memory, { strictFreeCap: true }) : null;
              if (budget === null) throw new TtsError('memory_unknown');
              if (memory?.lowMemory || budget < estimateTtsPeakBytes(binding.profile)) throw new TtsError('memory_insufficient');
              this.publish({ ...this.state, phase: 'loading' });
            },
          }, context => {
            this.executionIdentity = getTtsProfileIdentity(binding.profile,
              ['llama.rn/0.13.0-rc.3', getLlamaBuildInfo(), LLAMA_SOURCE_PATCH_SHA256,
                binding.profile.phonemizerLanguage ? LOCAL_PHONEMIZER_IDENTITY : null,
                voice.kind, 'voice' in voice ? voice.voice : referenceSha ?? null,
                voice.kind === 'reference' ? voice.bake ?? 'eager' : null]);
            const native = synthesizeTtsOnContext(context, binding.profile, {
              text: exactText, language: request.language, codecPath: binding.codecPath, signal: controller.signal,
              voice,
              ...(referenceSamples ? { referenceAudio: { samples: referenceSamples, sampleRate: binding.profile.reference!.sampleRate } } : {}),
              assertCurrent: check, observe: request.observe,
              onPhase: phase => this.publish({ ...this.state, phase: controller.signal.aborted ? 'stopping' : phase }),
            });
            callbackDrains.add(native);
            void native.then(() => callbackDrains.delete(native), () => callbackDrains.delete(native));
            return native.then(value => {
              this.publish({ ...this.state, phase: controller.signal.aborted ? 'stopping' : 'restoring' });
              return value;
            });
          }));
        } finally {
          for (const native of callbackDrains) {
            try { await native; } catch { /* Initial operation/quarantine failure remains authoritative. */ }
          }
        }
      });
      check(); // runWithAuxiliarySequence has confirmed codec/context cleanup and exact A restore.
      const wav = encodeMonoPcmWav(result.samples, result.sampleRate, {
        maxSamples: TTS_LIMITS.pcmSamples, maxDurationSeconds: TTS_LIMITS.durationSeconds, maxBytes: TTS_LIMITS.wavBytes,
      });
      const metadata = { sampleRate: result.sampleRate, sampleCount: result.samples.length };
      result.samples = []; // No large audio array reaches observable state or persisted messages.
      check();
      await this.playback.setClip(wav, metadata, publicationCurrent);
      check();
      clipInstalled = true;
      this.playbackGeneration = generation;
      this.publish({ ...this.state, phase: 'ready', clipAvailable: true, sampleRate: metadata.sampleRate,
        sampleCount: metadata.sampleCount, position: 0, duration: metadata.sampleCount / metadata.sampleRate });
      if (request.playAfterSynthesis !== false) {
        await this.playback.play();
        check();
        // Controller events alone publish Playing; Play acceptance is insufficient.
      }
    } catch (error) {
      // Admission failure already disposed the player. Keep the validated WAV
      // and selection guard for explicit retry without another synthesis.
      if (clipInstalled && generation === this.generation && !controller.signal.aborted && !selectionInvalidated
        && error instanceof TtsError && ['audio_focus_failed', 'audio_focus_delayed', 'playback_start_timeout', 'playback_failed'].includes(error.code)) {
        this.publish({ ...this.state, phase: 'error', errorCode: error.code, clipAvailable: true });
        throw error;
      }
      this.playbackGeneration = null;
      this.unsubscribe();
      let playbackCleanupFailed = false;
      try { await this.playback.clear(); } catch { playbackCleanupFailed = true; }
      const code: TtsErrorCode = playbackCleanupFailed ? 'storage_failed'
        : llmEngineService.getState().auxiliaryRestoreError ? 'restore_failed'
        : llmEngineService.getState().diagnostics?.contextRecoveryStatus === 'failed'
          || (error as { code?: string })?.code === 'engine_recovery_required' ? 'release_failed'
        : error instanceof TtsError ? error.code
        : error instanceof AudioPreparationError ? (error.code === 'cleanup_failed' ? 'storage_failed'
          : error.code === 'cancelled' ? 'cancelled' : 'reference_invalid')
        : error instanceof TtsTextError ? 'payload_invalid'
        : error instanceof TtsWavError ? 'decode_failed'
        : selectionInvalidated ? 'selection_changed'
        : controller.signal.aborted ? 'cancelled'
        : (error as { code?: string })?.code === 'engine_busy' ? 'busy' : 'native_failed';
      this.publish({ ...this.state, clipAvailable: false,
        ...(!playbackCleanupFailed ? { sampleCount: undefined, sampleRate: undefined, position: 0, duration: 0 } : {}),
        phase: code === 'cancelled' || code === 'selection_changed' ? 'stopped' : 'error', errorCode: code });
      throw new TtsError(code);
    } finally {
      if (referenceSamples) referenceSamples.length = 0;
      let cleanupFailed = false;
      if (preparedReference) { try { await discardPreparedAudio(preparedReference); } catch { cleanupFailed = true; } }
      if (referenceLease) { try { await referenceLease.release(); } catch { cleanupFailed = true; } }
      if (cleanupFailed) {
        try { await this.playback.clear(); } catch { /* Same fail-closed storage error. */ }
        this.publish({ ...this.state, phase: 'error', errorCode: 'storage_failed', clipAvailable: false });
        throw new TtsError('storage_failed');
      }
    }
  }

  private ownControl(kind: 'stop' | 'clear', operation: () => Promise<void>): Promise<void> {
    const work = Promise.resolve().then(operation);
    this.controlDrain = work;
    this.controlKind = kind;
    void work.finally(() => {
      if (this.controlDrain === work) { this.controlDrain = null; this.controlKind = null; }
    }).catch(() => undefined);
    return work;
  }
  stop(): Promise<void> {
    this.controller?.abort();
    this.playback.cancelStart();
    if (this.controlDrain) return this.controlDrain;
    return this.ownControl('stop', () => this.stopAndDrain());
  }
  private async stopAndDrain(): Promise<void> {
    this.controller?.abort();
    if (this.drain) {
      this.publish({ ...this.state, phase: 'stopping' });
      try { await this.drain; } catch { /* Cancel is an expected terminal outcome, errors remain in state. */ }
    }
    try { await this.playback.stop(); }
    catch { this.publish({ ...this.state, phase: 'error', errorCode: 'release_failed' }); throw new TtsError('release_failed'); }
    if (this.state.phase !== 'error') this.publish({ ...this.state, phase: 'stopped' });
  }
  cancelAndClear(): Promise<void> {
    ++this.generation;
    this.playbackGeneration = null;
    this.playback.cancelStart();
    this.unsubscribe();
    this.controller?.abort();
    if (this.controlKind === 'clear' && this.controlDrain) return this.controlDrain;
    const previous = this.controlDrain;
    return this.ownControl('clear', async () => {
      try {
        await previous;
        await this.stopAndDrain();
        await this.playback.clear();
        this.executionIdentity = null;
        if (llmEngineService.getState().diagnostics?.contextRecoveryStatus === 'failed') throw new TtsError('release_failed');
        this.publish({ phase: null });
      } catch (error) {
        const code = error instanceof TtsError && error.code === 'release_failed' ? 'release_failed' : 'storage_failed';
        this.publish({ ...this.state, phase: 'error', errorCode: code });
        throw new TtsError(code);
      }
    });
  }
  private assertPlaybackAllowed(): void {
    if (this.drain || this.controlDrain) throw new TtsError('busy');
    if (this.state.errorCode && ['release_failed', 'storage_failed', 'restore_failed'].includes(this.state.errorCode)) {
      throw new TtsError(this.state.errorCode);
    }
  }
  async play(): Promise<void> { this.assertPlaybackAllowed(); await this.playback.play(); }
  async pause(): Promise<void> { if (this.controlDrain) throw new TtsError('busy'); await this.playback.pause(); }
  async replay(): Promise<void> { this.assertPlaybackAllowed(); await this.playback.replay(); }
}

export const ttsService = new TtsService();
