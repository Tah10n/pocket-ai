import type { AudioPlayer, AudioStatus } from 'expo-audio';
import { TtsPlaybackController, cleanupColdTtsClips } from '../../src/services/TtsPlayback';
import { encodeMonoPcmWav } from '../../src/utils/ttsWav';
import { TTS_LIMITS } from '../../src/types/tts';
import { acquireAudioSession } from '../../src/services/AudioSessionCoordinator';

type Entry = { bytes: Uint8Array; isDirectory?: boolean };
const mockFiles = new Map<string, Entry>();
const mockDirectories = new Set<string>();
const mockWrite = jest.fn();
const mockDelete = jest.fn();
const mockAudioLoaded = jest.fn();
const mockSetAudioMode = jest.fn<Promise<void>, [unknown]>(async (_mode: unknown) => undefined);
const mockCreateAudioPlayer = jest.fn();

jest.mock('expo-audio', () => {
  mockAudioLoaded();
  return { setAudioModeAsync: (mode: unknown) => mockSetAudioMode(mode),
    createAudioPlayer: (...args: unknown[]) => mockCreateAudioPlayer(...args) };
});
jest.mock('expo-file-system', () => {
  const uri = (parts: (string | { uri: string })[]) => parts.map(part => typeof part === 'string' ? part : part.uri)
    .reduce((result, part, index) => index === 0 ? part : `${result.replace(/\/$/, '')}/${part.replace(/^\/+/, '')}`, '');
  class Directory {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) { this.uri = uri(parts); }
    get exists() { return mockDirectories.has(this.uri); }
    create() { mockDirectories.add(this.uri); }
    list() { return Array.from(mockFiles.keys()).filter(path => path.startsWith(`${this.uri}/`)).map(path => new File(path)); }
  }
  class File {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) { this.uri = uri(parts); }
    get name() { return this.uri.split('/').at(-1); }
    get parentDirectory() { return new Directory(this.uri.slice(0, this.uri.lastIndexOf('/'))); }
    get exists() { return mockFiles.has(this.uri); }
    get size() { return mockFiles.get(this.uri)?.bytes.length ?? 0; }
    create() {
      if (this.exists) throw new Error('exists');
      mockFiles.set(this.uri, { bytes: new Uint8Array() });
    }
    write(bytes: Uint8Array) { mockWrite(bytes); mockFiles.set(this.uri, { bytes }); }
    delete() { mockDelete(this.uri); mockFiles.delete(this.uri); }
  }
  return { File, Directory, Paths: { cache: { uri: 'file:///private-cache' } } };
});

const initialStatus: AudioStatus = {
  playbackRequestId: 0, id: 'player', currentTime: 0, duration: 1, playbackState: 'ready', timeControlStatus: 'paused',
  reasonForWaitingToPlay: '', mute: false, playing: false, loop: false, didJustFinish: false,
  isBuffering: false, isLoaded: true, playbackRate: 1, shouldCorrectPitch: false,
};
interface MockPlayer {
  isLoaded: boolean;
  preventAutomaticResume: boolean;
  playing: boolean;
  currentStatus: AudioStatus;
  play: jest.Mock<void, []>;
  playAsync: jest.Mock<Promise<void>, [number]>;
  pause: jest.Mock<void, []>;
  seekTo: jest.Mock<Promise<void>, [number]>;
  remove: jest.Mock;
  disposeAsync: jest.Mock<Promise<void>, []>;
  release: jest.Mock;
  subscription: { remove: jest.Mock<void, []> };
  addListener: jest.Mock<{ remove(): void }, [string, (status: AudioStatus) => void]>;
  emit(patch: Partial<AudioStatus>): void;
}
function makePlayer(loaded = true): MockPlayer {
  let listener: ((status: AudioStatus) => void) | null = null;
  const player: MockPlayer = {
    preventAutomaticResume: false,
    isLoaded: loaded, playing: false, currentStatus: { ...initialStatus, isLoaded: loaded },
    playAsync: jest.fn(async (requestId: number) => {
      player.currentStatus = { ...player.currentStatus, playbackRequestId: requestId };
      player.play();
    }),
    play: jest.fn(() => {
      player.playing = true;
      player.emit({ playing: true, timeControlStatus: 'playing' });
    }),
    pause: jest.fn(() => { player.playing = false; player.emit({ playing: false }); }),
    seekTo: jest.fn<Promise<void>, [number]>(async (_position: number) => undefined),
    remove: jest.fn(), disposeAsync: jest.fn<Promise<void>, []>(async () => undefined), release: jest.fn(),
    subscription: { remove: jest.fn(() => { listener = null; }) },
    addListener: jest.fn((_event: string, next: (status: AudioStatus) => void) => { listener = next; return player.subscription; }),
    emit: (patch: Partial<AudioStatus>) => {
      player.currentStatus = { ...player.currentStatus, ...patch };
      listener?.(player.currentStatus);
    },
  };
  return player;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function flush() { for (let index = 0; index < 20; index += 1) await Promise.resolve(); }
const metadata = { sampleRate: 8_000, sampleCount: 8_000 };
const wav = () => encodeMonoPcmWav(Array(8_000).fill(0.25), 8_000, {
  maxSamples: TTS_LIMITS.pcmSamples, maxDurationSeconds: TTS_LIMITS.durationSeconds, maxBytes: TTS_LIMITS.wavBytes,
});
let controller: TtsPlaybackController;
let player: ReturnType<typeof makePlayer>;

beforeEach(() => {
  jest.clearAllMocks();
  mockFiles.clear(); mockDirectories.clear();
  mockWrite.mockReset(); mockDelete.mockReset(); mockSetAudioMode.mockReset().mockResolvedValue(undefined);
  player = makePlayer();
  mockCreateAudioPlayer.mockReset().mockImplementation(() => player as unknown as AudioPlayer);
  controller = new TtsPlaybackController();
});
afterEach(async () => {
  mockDelete.mockReset();
  player.pause.mockReset(); player.remove.mockReset(); player.disposeAsync.mockReset().mockResolvedValue(undefined); player.release.mockReset();
  await controller.clear();
  jest.useRealTimers();
});

describe('TtsPlaybackController', () => {
  it('imports without installing a player or loading the audio module', () => {
    expect(mockCreateAudioPlayer).not.toHaveBeenCalled();
    expect(mockAudioLoaded).not.toHaveBeenCalled();
    expect(controller.getState()).toEqual({ phase: 'stopped', position: 0, duration: 0 });
  });

  it('writes the exact binary clip once and replays it without replacing source or storing payload/path', async () => {
    const input = wav();
    const observe = jest.fn(); controller.subscribe(observe);
    await controller.setClip(input, metadata, () => true);
    expect(mockWrite).toHaveBeenCalledWith(input);
    expect(mockSetAudioMode).toHaveBeenCalledWith(expect.objectContaining({
      interruptionMode: 'doNotMix', allowsRecording: false, shouldPlayInBackground: false, allowsBackgroundRecording: false,
    }));
    expect(mockCreateAudioPlayer).toHaveBeenCalledWith(expect.objectContaining({ uri: 'file:///private-cache/tts-clips/clip.wav' }),
      expect.objectContaining({ downloadFirst: false, keepAudioSessionActive: false }));
    expect(player.play).not.toHaveBeenCalled();
    await controller.play();
    player.emit({ playing: true, currentTime: 0.4 });
    await controller.pause();
    expect(controller.getState()).toMatchObject({ phase: 'paused', position: 0.4 });
    await controller.replay();
    expect(player.seekTo).toHaveBeenLastCalledWith(0);
    expect(mockWrite).toHaveBeenCalledTimes(1);
    expect(mockCreateAudioPlayer).toHaveBeenCalledTimes(1);
    for (const [state] of observe.mock.calls) {
      expect(Object.keys(state).every(key => ['phase', 'position', 'duration', 'errorCode'].includes(key))).toBe(true);
      expect(JSON.stringify(state)).not.toContain('private-cache');
    }
    await controller.stop();
    expect(player.preventAutomaticResume).toBe(true);
    expect(player.disposeAsync).toHaveBeenCalledTimes(1);
    expect(player.remove).not.toHaveBeenCalled();
    expect(player.release).toHaveBeenCalledTimes(1);
    expect(mockFiles.size).toBe(1);
  });

  it('does not dispatch a late player after Stop while audio mode is pending', async () => {
    const mode = deferred<void>(); mockSetAudioMode.mockImplementationOnce(() => mode.promise);
    const install = controller.setClip(wav(), metadata, () => true);
    await flush();
    expect(mockSetAudioMode).toHaveBeenCalledTimes(1);
    const stop = controller.stop(); mode.resolve();
    await Promise.all([install, stop]);
    expect(mockCreateAudioPlayer).not.toHaveBeenCalled();
    expect(mockFiles.size).toBe(0);
  });

  it('rejects a second pending clip and pauses playback before Replay seek callbacks', async () => {
    const mode = deferred<void>(); mockSetAudioMode.mockImplementationOnce(() => mode.promise);
    const install = controller.setClip(wav(), metadata, () => true); await flush();
    await expect(controller.setClip(wav(), metadata, () => true)).rejects.toMatchObject({ code: 'busy' });
    mode.resolve(); await install; await controller.play();
    player.seekTo.mockImplementationOnce(async position => { player.emit({ playing: player.playing, currentTime: position }); });
    await controller.replay();
    expect(player.play).toHaveBeenCalledTimes(2); expect(player.disposeAsync).not.toHaveBeenCalled();
  });

  it.each(['play', 'replay'] as const)('drains older paused seek events before observing native %s, then stops on a real interruption', async command => {
    await controller.setClip(wav(), metadata, () => true);
    if (command === 'replay') {
      await controller.play(); player.emit({ playing: true, currentTime: 0.4 });
      await controller.pause();
    }
    const deliverNative = player.addListener.mock.calls[0][1];
    const seek = deferred<void>();
    let pausedSeekSnapshot: AudioStatus | undefined;
    player.seekTo.mockImplementationOnce(position => {
      // Android captures currentStatus on MAIN during seek, then JNIUtils.invokeAsync
      // queues that snapshot for later JS delivery. The getter may already be newer.
      pausedSeekSnapshot = { ...player.currentStatus, currentTime: position, playing: false,
        timeControlStatus: 'paused', didJustFinish: false };
      return seek.promise;
    });
    player.play.mockImplementationOnce(() => {
      player.playing = true;
      player.currentStatus = { ...player.currentStatus, playing: true, timeControlStatus: 'playing' };
      // Real playing=true event is queued behind the prior seek event, not synchronous.
    });
    const play = command === 'replay' ? controller.replay() : controller.play();
    await flush(); expect(pausedSeekSnapshot).toBeDefined();
    seek.resolve(); await flush();
    expect(player.playing).toBe(true);
    const playCalls = player.play.mock.calls.length;
    deliverNative(pausedSeekSnapshot!); await flush();
    expect(player.disposeAsync).not.toHaveBeenCalled();
    expect(player.release).not.toHaveBeenCalled();
    expect(player.play).toHaveBeenCalledTimes(playCalls);
    deliverNative({ ...player.currentStatus, currentTime: 0.2 });
    await play;
    expect(controller.getState()).toMatchObject({ phase: 'playing', position: 0.2 });
    player.playing = false;
    player.currentStatus = { ...player.currentStatus, playing: false, timeControlStatus: 'paused' };
    deliverNative(player.currentStatus); await flush();
    expect(player.disposeAsync).toHaveBeenCalledTimes(1);
    expect(player.release).toHaveBeenCalledTimes(1);
    expect(controller.getState().phase).toBe('stopped');
  });

  it('drains a pending seek before cleanup and never calls Play after Stop', async () => {
    await controller.setClip(wav(), metadata, () => true);
    const seek = deferred<void>(); player.seekTo.mockImplementationOnce(() => seek.promise);
    const play = controller.play(); await flush();
    const stop = controller.stop();
    expect(player.pause).toHaveBeenCalled();
    expect(player.release).not.toHaveBeenCalled();
    seek.resolve(); await Promise.all([play, stop]);
    expect(player.play).not.toHaveBeenCalled();
    expect(player.release).toHaveBeenCalledTimes(1);
    expect(controller.getState().phase).toBe('stopped');
  });

  it('cancels a loading deadline on clear, disposes the exact player and rejects late status', async () => {
    jest.useFakeTimers(); player.isLoaded = false;
    const install = controller.setClip(wav(), metadata, () => true); await flush();
    const late = player.addListener.mock.calls[0][1];
    const clear = controller.clear(); await Promise.all([install, clear]);
    expect(jest.getTimerCount()).toBe(0);
    late({ ...initialStatus, playing: true });
    expect(controller.getState()).toEqual({ phase: 'stopped', position: 0, duration: 0 });
    expect(player.release).toHaveBeenCalledTimes(1);
    expect(mockFiles.size).toBe(0);
  });

  it('fails a player that never loads, retaining the clip for explicit cleanup', async () => {
    jest.useFakeTimers(); player.isLoaded = false;
    const install = controller.setClip(wav(), metadata, () => true);
    const assertion = expect(install).rejects.toMatchObject({ code: 'playback_failed' });
    await flush(); jest.advanceTimersByTime(15_000); await assertion;
    expect(controller.getState()).toMatchObject({ phase: 'error', errorCode: 'playback_failed' });
    expect(player.release).toHaveBeenCalledTimes(1);
    expect(mockFiles.size).toBe(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([{ playing: false }, { mediaServicesDidReset: true }])('disposes on focus interruption/reset and waits for explicit Replay', async patch => {
    await controller.setClip(wav(), metadata, () => true); await controller.play();
    player.emit(patch); await flush();
    expect(player.release).toHaveBeenCalledTimes(1);
    expect(controller.getState().phase).toBe('stopped');
    expect(mockFiles.size).toBe(1);
    const next = makePlayer(); mockCreateAudioPlayer.mockImplementationOnce(() => next as unknown as AudioPlayer);
    await controller.replay();
    expect(next.play).toHaveBeenCalledTimes(1);
    expect(mockWrite).toHaveBeenCalledTimes(1);
    await controller.clear();
    expect(next.release).toHaveBeenCalledTimes(1);
  });

  it('disposes unexpected native resume after user Pause and handles end/error states', async () => {
    await controller.setClip(wav(), metadata, () => true); await controller.play(); await controller.pause();
    player.emit({ playing: true }); await flush();
    expect(player.release).toHaveBeenCalledTimes(1);
    const next = makePlayer(); mockCreateAudioPlayer.mockImplementationOnce(() => next as unknown as AudioPlayer);
    await controller.replay();
    next.emit({ playing: false, didJustFinish: true, currentTime: 1 });
    expect(controller.getState()).toMatchObject({ phase: 'stopped', position: 1 });
    next.emit({ didJustFinish: false, playbackState: 'failed' }); await flush();
    expect(controller.getState()).toMatchObject({ phase: 'error', errorCode: 'playback_failed' });
    expect(next.release).toHaveBeenCalledTimes(1);
  });

  it('rejects overlay from a second controller and preserves the file if release is uncertain', async () => {
    await controller.setClip(wav(), metadata, () => true);
    const second = new TtsPlaybackController();
    await expect(second.setClip(wav(), metadata, () => true)).rejects.toMatchObject({ code: 'busy' });
    player.release.mockImplementationOnce(() => { throw new Error('private native path'); });
    await expect(controller.clear()).rejects.toMatchObject({ code: 'release_failed' });
    expect(mockDelete).not.toHaveBeenCalled(); expect(mockFiles.size).toBe(1);
    await expect(cleanupColdTtsClips()).rejects.toMatchObject({ code: 'busy' });
    await controller.clear();
    expect(player.disposeAsync).toHaveBeenCalledTimes(1); expect(player.release).toHaveBeenCalledTimes(2);
    expect(mockFiles.size).toBe(0);
  });

  it('keeps partial writes/deletion failures owned until retry and exposes only safe errors', async () => {
    mockWrite.mockImplementationOnce(() => { throw new Error('private input/path'); });
    await expect(controller.setClip(wav(), metadata, () => true)).rejects.toMatchObject({ code: 'storage_failed' });
    expect(mockFiles.size).toBe(1); expect(mockCreateAudioPlayer).not.toHaveBeenCalled();
    mockDelete.mockImplementationOnce(() => { throw new Error('private path'); });
    await expect(controller.clear()).rejects.toMatchObject({ code: 'storage_failed' });
    expect(mockFiles.size).toBe(1);
    expect(JSON.stringify(controller.getState())).not.toContain('private');
    await controller.clear(); expect(mockFiles.size).toBe(0);
  });

  it('awaits confirmed native disposal before shared-object release or file deletion', async () => {
    await controller.setClip(wav(), metadata, () => true);
    const disposal = deferred<void>(); player.disposeAsync.mockImplementationOnce(() => disposal.promise);
    const clear = controller.clear(); await flush();
    expect(player.disposeAsync).toHaveBeenCalledTimes(1);
    expect(player.release).not.toHaveBeenCalled(); expect(mockDelete).not.toHaveBeenCalled();
    await expect(cleanupColdTtsClips()).rejects.toMatchObject({ code: 'busy' });
    disposal.resolve(); await clear;
    expect(player.release).toHaveBeenCalledTimes(1); expect(mockFiles.size).toBe(0);
  });

  it('retains the exact player and clip after failed disposal, then retries disposal', async () => {
    await controller.setClip(wav(), metadata, () => true);
    player.disposeAsync.mockRejectedValueOnce(new Error('private path'));
    await expect(controller.clear()).rejects.toMatchObject({ code: 'release_failed' });
    expect(player.release).not.toHaveBeenCalled(); expect(mockFiles.size).toBe(1);
    await controller.clear();
    expect(player.disposeAsync).toHaveBeenCalledTimes(2); expect(mockFiles.size).toBe(0);
  });

  it('retains cleanup ownership when installing the resume guard fails', async () => {
    Object.defineProperty(player, 'preventAutomaticResume', { configurable: true,
      get: () => false, set: () => { throw new Error('private source'); } });
    player.disposeAsync.mockRejectedValueOnce(new Error('native busy'));
    await expect(controller.setClip(wav(), metadata, () => true)).rejects.toMatchObject({ code: 'release_failed' });
    expect(mockFiles.size).toBe(1); expect(player.release).not.toHaveBeenCalled();
    await controller.clear(); expect(player.disposeAsync).toHaveBeenCalledTimes(2);
  });

  it('never plays a stale selection and rejects metadata/WAV mismatches before writing', async () => {
    let current = true;
    await controller.setClip(wav(), metadata, () => current); current = false;
    await controller.play(); expect(player.play).not.toHaveBeenCalled();
    await controller.clear();
    await expect(controller.setClip(wav(), { ...metadata, sampleRate: 24_000 }, () => true)).rejects.toMatchObject({ code: 'payload_invalid' });
    expect(mockWrite).toHaveBeenCalledTimes(1);
  });

  it('drains playback before a recorder can change the shared mode and retains the WAV for Replay', async () => {
    await controller.setClip(wav(), metadata, () => true);
    await controller.play();
    const disposal = deferred<void>(); player.disposeAsync.mockImplementationOnce(() => disposal.promise);
    const recordingMode = jest.fn();
    const capture = acquireAudioSession(Symbol('test-recorder'), async () => undefined).then(lease => {
      recordingMode(); return lease;
    });
    await flush();
    expect(player.disposeAsync).toHaveBeenCalledTimes(1);
    expect(recordingMode).not.toHaveBeenCalled();
    expect(player.release).not.toHaveBeenCalled();
    disposal.resolve();
    const lease = await capture;
    expect(recordingMode).toHaveBeenCalledTimes(1);
    expect(player.release).toHaveBeenCalledTimes(1);
    expect(mockFiles.size).toBe(1);
    lease.release();
    const next = makePlayer(); mockCreateAudioPlayer.mockImplementationOnce(() => next as unknown as AudioPlayer);
    await controller.replay();
    expect(next.play).toHaveBeenCalledTimes(1);
    expect(mockWrite).toHaveBeenCalledTimes(1);
  });

  it('switches to sample preview after disposal without deleting either borrowed source or generated retry', async () => {
    await controller.setClip(wav(), metadata, () => true); await controller.play();
    const preview = new TtsPlaybackController();
    const sampleUri = 'file:///private-cache/audio-preparation/authorized.wav';
    mockFiles.set(sampleUri, { bytes: wav() });
    const samplePlayer = makePlayer();
    mockCreateAudioPlayer.mockImplementationOnce(() => samplePlayer as unknown as AudioPlayer);
    const disposal = deferred<void>(); player.disposeAsync.mockImplementationOnce(() => disposal.promise);
    try {
      await preview.setBorrowedClip(sampleUri, metadata, () => true);
      const playing = preview.play(); await flush();
      expect(mockCreateAudioPlayer).toHaveBeenCalledTimes(1);
      expect(samplePlayer.play).not.toHaveBeenCalled();
      disposal.resolve(); await playing;
      expect(player.release).toHaveBeenCalledTimes(1);
      expect(samplePlayer.play).toHaveBeenCalledTimes(1);
      await preview.clear();
      expect(mockFiles.has(sampleUri)).toBe(true);
      expect(mockFiles.has('file:///private-cache/tts-clips/clip.wav')).toBe(true);
      expect(mockDelete).not.toHaveBeenCalled();
      const retry = makePlayer(); mockCreateAudioPlayer.mockImplementationOnce(() => retry as unknown as AudioPlayer);
      await controller.replay(); expect(retry.play).toHaveBeenCalledTimes(1);
      expect(mockWrite).toHaveBeenCalledTimes(1);
    } finally { disposal.resolve(); await preview.clear(); }
  });
});

describe('cleanupColdTtsClips', () => {
  it('deletes only the exact owned cold file and never autostarts or removes unexpected entries', async () => {
    const directory = 'file:///private-cache/tts-clips';
    mockDirectories.add(directory); mockFiles.set(`${directory}/clip.wav`, { bytes: wav() });
    await cleanupColdTtsClips(); expect(mockFiles.size).toBe(0);
    expect(mockCreateAudioPlayer).not.toHaveBeenCalled();
    mockFiles.set(`${directory}/user-file.txt`, { bytes: new Uint8Array([1]) });
    await expect(cleanupColdTtsClips()).rejects.toMatchObject({ code: 'storage_failed' });
    expect(mockFiles.size).toBe(1);
  });
});
