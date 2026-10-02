import type { AudioPlayer, AudioStatus } from 'expo-audio';
import type { File } from 'expo-file-system';
import { TTS_LIMITS, TtsError, type TtsErrorCode } from '../types/tts';

export interface TtsPlaybackState {
  readonly phase: 'ready' | 'playing' | 'paused' | 'stopped' | 'error';
  readonly position: number;
  readonly duration: number;
  readonly errorCode?: TtsErrorCode;
}

type OwnedPlayer = {
  player: AudioPlayer;
  subscription: { remove(): void } | null;
  paused: boolean;
  disposed: boolean;
  released: boolean;
  observedPlaying: boolean;
  disposing: boolean;
};

const LOAD_TIMEOUT_MS = 15_000;
const CLIP_NAME = 'clip.wav';
let activeController: TtsPlaybackController | null = null;
let coldCleanupActive = false;

// Metro and the repository Jest environment both support lazy require. Keeping
// it inside these functions avoids installing a player/module at app import.
async function loadFileSystem(): Promise<typeof import('expo-file-system')> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Load the native module only when speech owns a clip.
  return require('expo-file-system') as typeof import('expo-file-system');
}
async function loadAudio(): Promise<typeof import('expo-audio')> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Audio startup stays lazy until explicit playback.
  return require('expo-audio') as typeof import('expo-audio');
}

async function removeColdFiles(): Promise<void> {
  const fs = await loadFileSystem();
  const directory = new fs.Directory(fs.Paths.cache, 'tts-clips');
  if (!directory.exists) return;
  const files = directory.list();
  // This directory and exact filename are reserved solely for generated speech.
  // Never recursively remove unexpected entries or follow caller-supplied paths.
  if (files.length > TTS_LIMITS.temporaryClips) throw new TtsError('storage_failed');
  for (const entry of files) {
    if (!(entry instanceof fs.File) || entry.name !== CLIP_NAME
      || entry.parentDirectory.uri !== directory.uri || entry.size > TTS_LIMITS.wavBytes) {
      throw new TtsError('storage_failed');
    }
    entry.delete();
    if (entry.exists) throw new TtsError('storage_failed');
  }
}

/** Startup cleanup only; it cannot race an owned clip or install an audio player. */
export async function cleanupColdTtsClips(): Promise<void> {
  if (activeController || coldCleanupActive) throw new TtsError('busy');
  coldCleanupActive = true;
  try { await removeColdFiles(); }
  catch (error) { throw error instanceof TtsError ? error : new TtsError('storage_failed'); }
  finally { coldCleanupActive = false; }
}

function validateClip(wav: Uint8Array, metadata: { sampleRate: number; sampleCount: number }): number {
  const { sampleRate, sampleCount } = metadata;
  if (!(wav instanceof Uint8Array) || !Number.isSafeInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000
    || !Number.isSafeInteger(sampleCount) || sampleCount < 1 || sampleCount > TTS_LIMITS.pcmSamples
    || sampleCount / sampleRate > TTS_LIMITS.durationSeconds || wav.length !== 44 + sampleCount * 2
    || wav.length > TTS_LIMITS.wavBytes) throw new TtsError('payload_invalid');
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const tag = (offset: number, value: string) => Array.from(value).every((char, index) => view.getUint8(offset + index) === char.charCodeAt(0));
  if (!tag(0, 'RIFF') || !tag(8, 'WAVE') || !tag(12, 'fmt ') || !tag(36, 'data')
    || view.getUint32(4, true) !== wav.length - 8 || view.getUint32(16, true) !== 16
    || view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1
    || view.getUint32(24, true) !== sampleRate || view.getUint32(28, true) !== sampleRate * 2
    || view.getUint16(32, true) !== 2 || view.getUint16(34, true) !== 16
    || view.getUint32(40, true) !== sampleCount * 2) throw new TtsError('payload_invalid');
  return sampleCount / sampleRate;
}

/** Owns one temporary clip and one player; observable state contains neither payload nor path. */
export class TtsPlaybackController {
  private state: TtsPlaybackState = { phase: 'stopped', position: 0, duration: 0 };
  private listeners = new Set<(state: TtsPlaybackState) => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private desiredPlaying = false;
  private file: File | null = null;
  private clipReady = false;
  private owned: OwnedPlayer | null = null;
  private isClipCurrent: (() => boolean) | null = null;
  private cancelLoad: (() => void) | null = null;
  private installingClip = false;

  private cancelLoading(): void { this.cancelLoad?.(); }

  getState(): TtsPlaybackState { return this.state; }
  subscribe(listener: (state: TtsPlaybackState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private publish(state: TtsPlaybackState): void {
    this.state = Object.freeze(state);
    for (const listener of this.listeners) {
      try { listener(state); } catch { /* A view observer cannot break resource cleanup. */ }
    }
  }
  private invalidate(): number {
    this.generation += 1;
    this.desiredPlaying = false;
    this.cancelLoading();
    return this.generation;
  }
  private current(generation: number): boolean {
    try { return generation === this.generation && Boolean(this.isClipCurrent?.()); }
    catch { return false; }
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }
  private async disposePlayer(): Promise<void> {
    this.cancelLoading();
    const owned = this.owned;
    if (!owned) return;
    owned.disposing = true;
    try {
      if (!owned.paused) { owned.player.pause(); owned.paused = true; }
      if (owned.subscription) { owned.subscription.remove(); owned.subscription = null; }
      if (!owned.disposed) { await owned.player.disposeAsync(); owned.disposed = true; }
      if (!owned.released) { owned.player.release(); owned.released = true; }
      if (this.owned === owned) this.owned = null;
    } catch { throw new TtsError('release_failed'); }
  }
  private async clearOwned(releaseClaim = true): Promise<void> {
    await this.disposePlayer();
    if (this.file) {
      try {
        if (this.file.exists) this.file.delete();
        if (this.file.exists) throw new TtsError('storage_failed');
        this.file = null;
        this.clipReady = false;
      } catch { throw new TtsError('storage_failed'); }
    }
    this.isClipCurrent = null;
    if (releaseClaim && activeController === this) activeController = null;
  }
  private report(error: unknown, generation: number): TtsError {
    const safe = error instanceof TtsError ? error : new TtsError('playback_failed');
    if (generation === this.generation) this.publish({ ...this.state, phase: 'error', errorCode: safe.code });
    return safe;
  }

  async setClip(wav: Uint8Array, metadata: { sampleRate: number; sampleCount: number }, isCurrent: () => boolean): Promise<void> {
    if (this.installingClip || coldCleanupActive || (activeController && activeController !== this)) throw new TtsError('busy');
    const duration = validateClip(wav, metadata);
    this.installingClip = true;
    activeController = this;
    const generation = this.invalidate();
    return this.enqueue(async () => {
      try {
        await this.clearOwned(false);
        if (generation !== this.generation || !isCurrent()) return;
        activeController = this;
        this.isClipCurrent = isCurrent;
        const fs = await loadFileSystem();
        if (!this.current(generation)) return;
        await removeColdFiles();
        if (!this.current(generation)) return;
        const directory = new fs.Directory(fs.Paths.cache, 'tts-clips');
        directory.create({ intermediates: true, idempotent: true });
        const file = new fs.File(directory, CLIP_NAME);
        this.file = file; // Track even a partial write so failed cleanup stays visible.
        try {
          file.create();
          file.write(wav);
          if (!file.exists || file.size !== wav.length) throw new TtsError('storage_failed');
        } catch { throw new TtsError('storage_failed'); }
        this.publish({ phase: 'ready', position: 0, duration });
        this.clipReady = true;
        await this.ensurePlayer(generation);
        if (!this.current(generation)) await this.clearOwned();
      } catch (error) {
        try { await this.disposePlayer(); } catch (cleanup) { throw this.report(cleanup, generation); }
        throw this.report(error, generation);
      } finally {
        this.installingClip = false;
        if (!this.file && !this.owned && activeController === this) activeController = null;
      }
    });
  }

  private async ensurePlayer(generation: number): Promise<AudioPlayer | null> {
    if (this.owned) {
      if (this.owned.disposing || this.owned.disposed || this.owned.released) throw new TtsError('release_failed');
      return this.owned.player;
    }
    if (!this.file || !this.clipReady || !this.current(generation)) return null;
    const audio = await loadAudio();
    if (!this.current(generation)) return null;
    await audio.setAudioModeAsync({ interruptionMode: 'doNotMix', allowsRecording: false,
      shouldPlayInBackground: false, allowsBackgroundRecording: false,
      shouldRouteThroughEarpiece: false, playsInSilentMode: true });
    if (!this.current(generation)) return null;
    const player = audio.createAudioPlayer(this.file, { updateInterval: 200, downloadFirst: false, keepAudioSessionActive: false });
    const owned: OwnedPlayer = { player, subscription: null, paused: false, disposed: false, released: false,
      observedPlaying: false, disposing: false };
    this.owned = owned;
    player.preventAutomaticResume = true;
    if (!player.preventAutomaticResume) throw new TtsError('playback_failed');
    const settlement: { finish?: (error?: TtsError) => void } = {};
    const loaded = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new TtsError('playback_failed')), LOAD_TIMEOUT_MS);
      const finish = (error?: TtsError) => {
        clearTimeout(timer);
        if (this.cancelLoad === cancel) this.cancelLoad = null;
        delete settlement.finish;
        if (error) reject(error); else resolve();
      };
      const cancel = () => finish();
      this.cancelLoad = cancel;
      settlement.finish = finish;
    });
    owned.subscription = player.addListener('playbackStatusUpdate', status => {
      if (this.owned !== owned || owned.disposing || owned.disposed || owned.released) return;
      if (status.playbackState === 'failed' || status.playbackState === 'error') {
        settlement.finish?.(new TtsError('playback_failed'));
        this.interrupted(owned, 'playback_failed');
        return;
      }
      if (status.isLoaded) settlement.finish?.();
      this.onStatus(owned, status);
    });
    if (player.isLoaded) settlement.finish?.();
    await loaded;
    if (!this.current(generation)) { await this.disposePlayer(); return null; }
    return player;
  }

  private onStatus(owned: OwnedPlayer, status: AudioStatus): void {
    const position = Number.isFinite(status.currentTime) ? Math.max(0, Math.min(status.currentTime, this.state.duration)) : this.state.position;
    if (status.mediaServicesDidReset || !this.current(this.generation)
      || (status.playing && !this.desiredPlaying)
      || (!status.playing && this.desiredPlaying && owned.observedPlaying && !status.didJustFinish)) {
      this.interrupted(owned, undefined, position);
      return;
    }
    if (status.didJustFinish) {
      this.desiredPlaying = false;
      owned.observedPlaying = false;
      this.publish({ phase: 'stopped', position: this.state.duration, duration: this.state.duration });
    } else if (status.playing) {
      owned.observedPlaying = true;
      this.publish({ phase: 'playing', position, duration: this.state.duration });
    } else if (this.state.phase === 'paused') this.publish({ ...this.state, position });
  }
  private interrupted(owned: OwnedPlayer, errorCode?: TtsErrorCode, position = this.state.position): void {
    if (this.owned !== owned || owned.disposing) return;
    owned.disposing = true;
    const generation = this.invalidate();
    // Best-effort immediate pause precedes asynchronous queue settlement.
    try { owned.player.pause(); owned.paused = true; } catch { /* Retain the exact owner for cleanup retry. */ }
    void this.enqueue(async () => {
      try {
        await this.disposePlayer();
        if (generation === this.generation) this.publish({ ...this.state, position,
          phase: errorCode ? 'error' : 'stopped', ...(errorCode ? { errorCode } : { errorCode: undefined }) });
      } catch (error) { this.report(error, generation); }
    });
  }

  private start(replay: boolean): Promise<void> {
    const generation = this.invalidate();
    // Seek status callbacks retain the old playing bit on both platforms. Pause
    // first so Replay cannot be mistaken for an unexpected native resume.
    if (this.owned) {
      try { this.owned.player.pause(); this.owned.paused = true; this.owned.observedPlaying = false; }
      catch { /* The queued operation still owns and verifies this player. */ }
    }
    return this.enqueue(async () => {
      try {
        if (!this.file) return;
        if (!this.current(generation)) { await this.clearOwned(); return; }
        if (!this.clipReady) throw new TtsError('storage_failed');
        const position = replay || this.state.position >= this.state.duration ? 0 : this.state.position;
        const player = await this.ensurePlayer(generation);
        if (!player || !this.current(generation)) return;
        await player.seekTo(position);
        if (!this.current(generation)) return;
        this.desiredPlaying = true;
        if (this.owned) { this.owned.paused = false; this.owned.observedPlaying = false; }
        player.play();
        if (player.playing) this.onStatus(this.owned!, player.currentStatus);
      } catch (error) {
        this.desiredPlaying = false;
        try { await this.disposePlayer(); } catch (cleanup) { throw this.report(cleanup, generation); }
        throw this.report(error, generation);
      }
    });
  }
  play(): Promise<void> { return this.start(false); }
  replay(): Promise<void> { return this.start(true); }
  pause(): Promise<void> {
    const generation = this.invalidate();
    return this.enqueue(async () => {
      try {
        if (this.owned) { this.owned.player.pause(); this.owned.paused = true; }
        if (generation === this.generation && this.file) this.publish({ ...this.state, phase: 'paused', errorCode: undefined });
      } catch (error) { throw this.report(error, generation); }
    });
  }
  stop(): Promise<void> {
    const generation = this.invalidate();
    // Prevent another native focus callback from resuming this player while a seek drains.
    if (this.owned) { try { this.owned.player.pause(); this.owned.paused = true; } catch { /* Retry under the queue. */ } }
    return this.enqueue(async () => {
      try {
        await this.disposePlayer();
        if (generation === this.generation) this.publish({ phase: 'stopped', position: 0, duration: this.state.duration });
      } catch (error) { throw this.report(error, generation); }
    });
  }
  clear(): Promise<void> {
    const generation = this.invalidate();
    if (this.owned) { try { this.owned.player.pause(); this.owned.paused = true; } catch { /* Retry under the queue. */ } }
    return this.enqueue(async () => {
      try {
        await this.clearOwned();
        if (generation === this.generation) this.publish({ phase: 'stopped', position: 0, duration: 0 });
      } catch (error) { throw this.report(error, generation); }
    });
  }
}
