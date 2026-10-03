import { AppState, Platform } from 'react-native';
import type { AudioRecorder, RecorderState } from 'expo-audio';
import type { File } from 'expo-file-system';
import { acquireAudioSession, type AudioSessionLease } from './AudioSessionCoordinator';
import { waitForAudioPreparationDrain } from './AudioPreparationService';

export type RecordingPurpose = 'chat' | 'reference';
export type AudioRecordingErrorCode = 'permission_denied' | 'permission_permanently_denied' | 'busy'
  | 'prepare_failed' | 'start_failed' | 'finalize_failed' | 'file_invalid' | 'release_failed' | 'storage_failed';
export class AudioRecordingError extends Error {
  constructor(readonly code: AudioRecordingErrorCode) { super(code); this.name = 'AudioRecordingError'; }
}
export const AUDIO_RECORDING_LIMITS = Object.freeze({
  chat: Object.freeze({ durationSeconds: 30, sourceBytes: 4 * 1024 * 1024 }),
  reference: Object.freeze({ durationSeconds: 8, sourceBytes: 2 * 1024 * 1024 }),
});
// Native stop/container finalization can exceed its scheduled capture duration.
// Keep that delay inside the unchanged decoder admission limit.
const CAPTURE_FINALIZATION_RESERVE_SECONDS = 0.5;
export interface RecordedAudio {
  readonly uri: string;
  readonly byteSize: number;
  readonly durationMillis: number;
  readonly container: 'm4a';
  readonly recorderId: string;
  readonly requestId: number;
}
export interface AudioRecordingState {
  readonly phase: 'idle' | 'requesting-permission' | 'preparing' | 'starting' | 'recording' | 'finalizing' | 'ready' | 'error';
  readonly durationMillis: number;
  readonly ownerKey?: string;
  readonly purpose?: RecordingPurpose;
  readonly interrupted?: boolean;
  readonly errorCode?: AudioRecordingErrorCode;
  readonly recording?: RecordedAudio;
}
type CaptureStatus = RecorderState & { recordingRequestId?: number; isFinished?: boolean; hasError?: boolean; interrupted?: boolean };
interface OwnedRecorder {
  recorder: AudioRecorder;
  recorderId: string;
  requestId: number;
  subscription: { remove(): void } | null;
  disposed: boolean;
  released: boolean;
}
interface StartOptions { ownerKey: string; purpose: RecordingPurpose; isCurrent?: () => boolean }

async function loadAudio(): Promise<typeof import('expo-audio')> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Permission/capture module stays lazy until Record.
  return require('expo-audio') as typeof import('expo-audio');
}
async function loadFiles(): Promise<typeof import('expo-file-system')> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- No filesystem startup side effect.
  return require('expo-file-system') as typeof import('expo-file-system');
}

/** Owns one explicit recording and its unencrypted temporary source until the consumer copies it. */
export class AudioRecordingService {
  private state: AudioRecordingState = Object.freeze({ phase: 'idle', durationMillis: 0 });
  private listeners = new Set<(state: AudioRecordingState) => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private requestCounter = 0;
  private owned: OwnedRecorder | null = null;
  private sourceFile: File | null = null;
  private lease: AudioSessionLease | null = null;
  private readonly leaseOwner = Symbol('explicit-audio-recording');
  private options: StartOptions | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private startPending = false;
  private finalizePending = false;
  private backgroundSubscription: { remove(): void } | null = null;

  getState = (): AudioRecordingState => this.state;
  subscribe = (listener: (state: AudioRecordingState) => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish(state: AudioRecordingState): void {
    this.state = Object.freeze(state);
    for (const listener of this.listeners) { try { listener(this.state); } catch { /* Views do not own cleanup. */ } }
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.queue.then(operation);
    this.queue = work.catch(() => undefined);
    return work;
  }
  private current(generation: number): boolean {
    try { return generation === this.generation && Boolean(this.options) && (this.options?.isCurrent?.() ?? true); }
    catch { return false; }
  }
  private invalidate(): void {
    this.generation += 1;
    this.stopPolling();
    const owned = this.owned;
    if (owned && !owned.disposed && !owned.released) owned.recorder.cancelRequest(owned.requestId);
  }
  private stopPolling(): void { if (this.poll) clearInterval(this.poll); this.poll = null; }
  private watchBackground(): void {
    if (this.backgroundSubscription) return;
    this.backgroundSubscription = AppState.addEventListener('change', next => {
      if (next !== 'active') void this.onBackground().catch(() => undefined);
    });
  }
  private statusCurrent(status: CaptureStatus, owned: OwnedRecorder): boolean {
    return this.owned === owned && !owned.disposed && !owned.released && status.recordingRequestId === owned.requestId;
  }
  private error(error: unknown, fallback: AudioRecordingErrorCode): AudioRecordingError {
    return error instanceof AudioRecordingError ? error : new AudioRecordingError(fallback);
  }
  private async disposeRecorder(): Promise<void> {
    this.stopPolling();
    const owned = this.owned;
    if (owned) {
      try {
        // prepare can fail after creating its file. Capture its native-owned URI before release.
        if (!this.sourceFile && !owned.released) {
          const fs = await loadFiles();
          const uri = owned.recorder.uri;
          if (typeof uri === 'string' && uri.startsWith(fs.Paths.cache.uri)) this.sourceFile = new fs.File(uri);
        }
        owned.subscription?.remove(); owned.subscription = null;
        if (!owned.disposed) { await owned.recorder.disposeAsync(); owned.disposed = true; }
        if (!owned.released) { owned.recorder.release(); owned.released = true; }
        if (this.owned === owned) this.owned = null;
      } catch { throw new AudioRecordingError('release_failed'); }
    }
    this.lease?.release(); this.lease = null;
  }
  private async removeSource(): Promise<void> {
    if (!this.sourceFile) return;
    await waitForAudioPreparationDrain(); // Native preprocessing may still be reading this finalized source.
    try {
      if (this.sourceFile.exists) this.sourceFile.delete();
      if (this.sourceFile.exists) throw new AudioRecordingError('storage_failed');
      this.sourceFile = null;
    } catch { throw new AudioRecordingError('storage_failed'); }
  }
  private async clear(): Promise<void> { await this.disposeRecorder(); await this.removeSource(); }

  start(options: StartOptions): Promise<void> {
    if (this.startPending || this.finalizePending || this.owned || this.lease
      || !options.ownerKey || !AUDIO_RECORDING_LIMITS[options.purpose]) return Promise.reject(new AudioRecordingError('busy'));
    this.startPending = true;
    this.invalidate();
    const generation = this.generation;
    this.options = options;
    this.watchBackground();
    this.publish({ phase: 'requesting-permission', durationMillis: 0, ownerKey: options.ownerKey, purpose: options.purpose });
    return this.enqueue(async () => {
      let fallback: AudioRecordingErrorCode = 'prepare_failed';
      try {
        await this.removeSource();
        if (!this.current(generation) || AppState.currentState !== 'active') return;
        const audio = await loadAudio();
        if (!this.current(generation) || AppState.currentState !== 'active') return;
        const permission = await audio.requestRecordingPermissionsAsync();
        if (!this.current(generation) || AppState.currentState !== 'active') return;
        if (!permission.granted) throw new AudioRecordingError(permission.canAskAgain ? 'permission_denied' : 'permission_permanently_denied');
        this.publish({ ...this.state, phase: 'preparing' });
        this.lease = await acquireAudioSession(this.leaseOwner, () => this.cancelAndClear());
        if (!this.current(generation) || AppState.currentState !== 'active') { await this.clear(); return; }
        await audio.setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, interruptionMode: 'doNotMix',
          allowsBackgroundRecording: false, shouldPlayInBackground: false, shouldRouteThroughEarpiece: false });
        if (!this.current(generation) || AppState.currentState !== 'active') { await this.clear(); return; }
        const nativeOptions = Platform.OS === 'ios'
          ? { extension: '.m4a', sampleRate: 44_100, numberOfChannels: 1, bitRate: 64_000,
            outputFormat: audio.IOSOutputFormat.MPEG4AAC, audioQuality: audio.AudioQuality.HIGH, isMeteringEnabled: false }
          : { extension: '.m4a', sampleRate: 44_100, numberOfChannels: 1, bitRate: 64_000,
            outputFormat: 'mpeg4', audioEncoder: 'aac', isMeteringEnabled: false };
        const recorder = new audio.AudioModule.AudioRecorder(nativeOptions);
        const owned: OwnedRecorder = { recorder, recorderId: recorder.id, requestId: ++this.requestCounter, subscription: null, disposed: false, released: false };
        this.owned = owned;
        recorder.preventAutomaticResume = true;
        if (!recorder.preventAutomaticResume || typeof recorder.cancelRequest !== 'function' || typeof recorder.prepareAsync !== 'function'
          || typeof recorder.startAsync !== 'function' || typeof recorder.finishAsync !== 'function'
          || typeof recorder.disposeAsync !== 'function') throw new AudioRecordingError('prepare_failed');
        owned.subscription = recorder.addListener('recordingStatusUpdate', event => {
          if (this.owned !== owned || owned.disposed || owned.released || !this.current(generation)) return;
          const status = event as typeof event & { recordingRequestId?: number; interrupted?: boolean };
          if (status.recordingRequestId !== owned.requestId) return;
          if (status.isFinished && this.state.phase === 'recording') void this.finalize(status.interrupted === true).catch(() => undefined);
        });
        const limits = AUDIO_RECORDING_LIMITS[options.purpose];
        const prepared = await recorder.prepareAsync(owned.requestId,
          limits.durationSeconds - CAPTURE_FINALIZATION_RESERVE_SECONDS, limits.sourceBytes);
        const fs = await loadFiles();
        const uri = recorder.uri;
        if (typeof uri !== 'string' || !uri.startsWith(fs.Paths.cache.uri)) throw new AudioRecordingError('file_invalid');
        this.sourceFile = new fs.File(uri);
        if (!this.current(generation) || AppState.currentState !== 'active') { await this.clear(); return; }
        if (!this.statusCurrent(prepared, owned) || !prepared.canRecord || prepared.isRecording) throw new AudioRecordingError('prepare_failed');
        this.publish({ ...this.state, phase: 'starting' });
        fallback = 'start_failed';
        const started = await recorder.startAsync(owned.requestId);
        if (!this.current(generation) || AppState.currentState !== 'active') { await this.clear(); return; }
        const confirmed = recorder.getStatus() as CaptureStatus;
        if (!this.statusCurrent(started, owned) || !started.isRecording
          || !this.statusCurrent(confirmed, owned) || !confirmed.isRecording) throw new AudioRecordingError('start_failed');
        this.publish({ ...this.state, phase: 'recording', durationMillis: confirmed.durationMillis });
        this.poll = setInterval(() => {
          if (!this.current(generation) || this.owned !== owned || this.state.phase !== 'recording') return;
          try {
            const status = recorder.getStatus() as CaptureStatus;
            if (!this.statusCurrent(status, owned)) return;
            if (status.isFinished || !status.isRecording) { void this.stop().catch(() => undefined); return; }
            const durationMillis = Number.isFinite(status.durationMillis) ? Math.max(0, status.durationMillis) : 0;
            this.publish({ ...this.state, durationMillis });
          } catch { void this.cancelAndClear().catch(() => undefined); }
        }, 200);
      } catch (error) {
        let safe = this.error(error, fallback);
        try { await this.clear(); } catch (cleanup) { safe = this.error(cleanup, 'release_failed'); }
        if (generation === this.generation) {
          this.publish({ ...this.state, phase: 'error', errorCode: safe.code, recording: undefined });
          throw safe;
        }
        // Native cancellation refusal after unmount is an expected drained cancellation.
        if (safe.code === 'release_failed' || safe.code === 'storage_failed') throw safe;
      } finally {
        this.startPending = false;
        if (!this.current(generation) && !this.owned && !this.lease && this.state.phase !== 'ready') this.publish({ phase: 'idle', durationMillis: 0 });
      }
    });
  }

  stop(): Promise<RecordedAudio | null> { return this.finalize(false); }
  private finalize(interrupted: boolean): Promise<RecordedAudio | null> {
    if (this.state.phase === 'ready') return Promise.resolve(this.state.recording ?? null);
    if (this.finalizePending) return this.enqueue(async () => this.state.recording ?? null);
    if (this.state.phase !== 'recording' || !this.owned) return this.cancelAndClear().then(() => null);
    this.stopPolling();
    this.finalizePending = true;
    const generation = this.generation;
    const owned = this.owned;
    this.publish({ ...this.state, phase: 'finalizing', interrupted });
    return this.enqueue(async () => {
      try {
        const status = await owned.recorder.finishAsync(owned.requestId);
        if (!this.statusCurrent(status, owned) || !status.isFinished || status.isRecording || status.hasError || !status.url
          || status.url !== this.sourceFile?.uri) throw new AudioRecordingError('finalize_failed');
        await this.disposeRecorder();
        if (!this.current(generation)) { await this.removeSource(); return null; }
        const file = this.sourceFile;
        const limits = this.options && AUDIO_RECORDING_LIMITS[this.options.purpose];
        if (!file || !limits || !file.exists || file.size < 16 || file.size > limits.sourceBytes
          || !Number.isFinite(status.durationMillis) || status.durationMillis <= 0
          || status.durationMillis > limits.durationSeconds * 1000) throw new AudioRecordingError('file_invalid');
        const handle = file.open();
        let header: Uint8Array;
        try { header = handle.readBytes(12); } finally { handle.close(); }
        // MP4 family signature comes from file bytes. Decoder verifies tracks/duration before Attach.
        if (header.length !== 12 || String.fromCharCode(...header.slice(4, 8)) !== 'ftyp') throw new AudioRecordingError('file_invalid');
        const recording: RecordedAudio = Object.freeze({ uri: file.uri, byteSize: file.size, durationMillis: status.durationMillis,
          container: 'm4a', recorderId: owned.recorderId, requestId: owned.requestId });
        this.publish({ ...this.state, phase: 'ready', durationMillis: status.durationMillis,
          interrupted: interrupted || status.interrupted === true || this.state.interrupted === true,
          recording, errorCode: undefined });
        return recording;
      } catch (error) {
        let safe = this.error(error, 'finalize_failed');
        try { await this.clear(); } catch (cleanup) { safe = this.error(cleanup, 'release_failed'); }
        if (generation === this.generation) this.publish({ ...this.state, phase: 'error', errorCode: safe.code, recording: undefined });
        throw safe;
      } finally { this.finalizePending = false; }
    });
  }

  onBackground(): Promise<void> {
    if (this.state.phase === 'recording') return this.finalize(true).then(() => undefined);
    if (this.state.phase === 'finalizing') {
      this.publish({ ...this.state, interrupted: true });
      return Promise.resolve();
    }
    if (this.state.phase === 'ready' || this.state.phase === 'idle') return Promise.resolve();
    return this.cancelAndClear();
  }
  cancelAndClear(expectedOwnerKey?: string): Promise<void> {
    if (expectedOwnerKey !== undefined && this.options?.ownerKey !== expectedOwnerKey) return Promise.resolve();
    this.invalidate();
    return this.enqueue(async () => {
      if (expectedOwnerKey !== undefined && this.options?.ownerKey !== expectedOwnerKey) return;
      try {
        await this.clear();
        // A new explicit request can queue while old source preprocessing is draining.
        if (expectedOwnerKey !== undefined && this.options?.ownerKey !== expectedOwnerKey) return;
        this.options = null;
        this.publish({ phase: 'idle', durationMillis: 0 });
      } catch (error) {
        const safe = this.error(error, 'release_failed');
        if (expectedOwnerKey === undefined || this.options?.ownerKey === expectedOwnerKey) {
          this.publish({ ...this.state, phase: 'error', errorCode: safe.code, recording: undefined });
        }
        throw safe;
      }
    });
  }
  async dispose(): Promise<void> {
    await this.cancelAndClear();
    this.backgroundSubscription?.remove(); this.backgroundSubscription = null;
  }
}

export const audioRecordingService = new AudioRecordingService();
