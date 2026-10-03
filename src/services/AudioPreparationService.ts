import * as FileSystem from 'expo-file-system/legacy';
import * as RNFS from 'react-native-fs';
import { toByteArray } from 'base64-js';
import { fileUriToNativePath } from '../utils/safeFilePath';
import { assertPrivateStorageWritable } from './storage';

export type AudioPurpose = 'chat' | 'reference';
export interface PreparedAudio {
  uri: string;
  sourceSha256: string;
  identity: string;
  sampleRate: number;
  channels: 1;
  sampleCount: number;
  durationMs: number;
  sizeBytes: number;
}
export const AUDIO_PREPARATION_LIMITS = Object.freeze({
  chat: { sourceBytes: 4 * 1024 * 1024, seconds: 30 },
  reference: { sourceBytes: 2 * 1024 * 1024, seconds: 8 },
  channels: 2, sourceSampleRate: 192_000, outputSampleRate: 48_000,
  nativeAdmissionReserveBytes: 64 * 1024 * 1024,
});
export class AudioPreparationError extends Error {
  constructor(readonly code: 'invalid_audio' | 'audio_limit' | 'cancelled' | 'preparation_failed' | 'cleanup_failed') {
    super(code); this.name = 'AudioPreparationError';
  }
}
type NativePreparation = {
  prepare(sourceUri: string, sampleRate: number, seconds: number, sourceBytes: number): Promise<
    Omit<PreparedAudio, 'identity' | 'durationMs'> & { sha256: string }>;
  remove(uri: string): Promise<void>;
};
let native: NativePreparation | undefined;
let pending = 0;
let coldCleanup = false;
let cleanupBlocked = false;
const ownedDerivatives = new Set<string>();
const sourceDrains = new Set<Promise<void>>();
function getNative(): NativePreparation {
  // Lazy: opening a chat/voice sheet requests neither permissions nor native preprocessing.
  if (!native) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    native = require('expo-modules-core').requireNativeModule('PocketAudioPreparation') as NativePreparation;
  }
  return native;
}
function check(signal?: AbortSignal, assertCurrent?: () => void) {
  assertPrivateStorageWritable();
  assertCurrent?.();
  if (signal?.aborted) throw new AudioPreparationError('cancelled');
}

/** Native streams bounded source frames; no codec/PCM/Base64 is added to app state. */
interface AudioPreparationOptions {
  sourceUri: string; purpose: AudioPurpose; sampleRate?: number;
  signal?: AbortSignal; assertCurrent?: () => void;
}
export function prepareManagedAudio(options: AudioPreparationOptions): Promise<PreparedAudio> {
  let settle!: () => void;
  const drain = new Promise<void>(resolve => { settle = resolve; });
  sourceDrains.add(drain); // Register synchronously before metadata/native work can start.
  return performManagedAudio(options).finally(() => { sourceDrains.delete(drain); settle(); });
}
/** A source owner must wait for these actual calls before deleting a recorder/sample source. */
export async function waitForAudioPreparationDrain(): Promise<void> {
  while (sourceDrains.size) await Promise.all([...sourceDrains]);
}
async function performManagedAudio(options: AudioPreparationOptions): Promise<PreparedAudio> {
  const limits = AUDIO_PREPARATION_LIMITS[options.purpose];
  const rate = options.sampleRate ?? (options.purpose === 'chat' ? 16_000 : 24_000);
  check(options.signal, options.assertCurrent);
  if (cleanupBlocked) throw new AudioPreparationError('cleanup_failed');
  if (coldCleanup) throw new AudioPreparationError('preparation_failed');
  if (!Number.isSafeInteger(rate) || rate < 8_000 || rate > AUDIO_PREPARATION_LIMITS.outputSampleRate
    || !options.sourceUri.startsWith('file://')) throw new AudioPreparationError('invalid_audio');
  const info = await FileSystem.getInfoAsync(options.sourceUri);
  check(options.signal, options.assertCurrent);
  if (!info.exists || info.isDirectory || !info.size || info.size > limits.sourceBytes) throw new AudioPreparationError('audio_limit');
  let result: Awaited<ReturnType<NativePreparation['prepare']>> | undefined;
  pending += 1;
  try {
    // Cancellation invalidates publication and retains ownership until this actual promise settles.
    result = await getNative().prepare(options.sourceUri, rate, limits.seconds, limits.sourceBytes);
    if (isPreparedUri(result.uri)) ownedDerivatives.add(result.uri);
    check(options.signal, options.assertCurrent);
    if (result.channels !== 1 || result.sampleRate !== rate || !Number.isSafeInteger(result.sampleCount)
      || result.sampleCount < 1 || result.sampleCount > rate * limits.seconds
      || result.sizeBytes !== 44 + result.sampleCount * 2 || !/^([a-f0-9]{64})$/.test(result.sourceSha256)
      || !/^([a-f0-9]{64})$/.test(result.sha256) || !isPreparedUri(result.uri)) throw new AudioPreparationError('invalid_audio');
    return { uri: result.uri, sourceSha256: result.sourceSha256, sampleRate: rate, channels: 1,
      sampleCount: result.sampleCount, durationMs: result.sampleCount * 1000 / rate, sizeBytes: result.sizeBytes,
      identity: JSON.stringify(['audio-preparation/v1', result.sourceSha256, options.purpose, rate,
        limits, 'pcm16-mono-area-resample', result.sha256]) };
  } catch (error) {
    if (result?.uri && isPreparedUri(result.uri)) {
      try { await getNative().remove(result.uri); }
      catch { cleanupBlocked = true; throw new AudioPreparationError('cleanup_failed'); }
      ownedDerivatives.delete(result.uri);
    }
    if (error instanceof AudioPreparationError) throw error;
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ERR_AUDIO_CLEANUP') {
      cleanupBlocked = true;
      throw new AudioPreparationError('cleanup_failed');
    }
    throw new AudioPreparationError('preparation_failed');
  } finally { pending -= 1; }
}

function isPreparedUri(uri: unknown): uri is string {
  const root = FileSystem.cacheDirectory;
  return typeof uri === 'string' && Boolean(root) && uri.startsWith(root + 'audio-preparation/')
    && /^[a-f0-9-]+\.wav$/.test(uri.slice((root + 'audio-preparation/').length));
}
export async function discardPreparedAudio(audio: PreparedAudio): Promise<void> {
  if (!isPreparedUri(audio.uri)) throw new AudioPreparationError('cleanup_failed');
  try { await getNative().remove(audio.uri); ownedDerivatives.delete(audio.uri); }
  catch { cleanupBlocked = true; throw new AudioPreparationError('cleanup_failed'); }
}

/** Cold-start only. Refuse to delete any derivative belonging to a live preprocessing/preview. */
export async function cleanupColdPreparedAudio(): Promise<void> {
  if (pending || sourceDrains.size || ownedDerivatives.size || coldCleanup) throw new AudioPreparationError('cleanup_failed');
  coldCleanup = true;
  try {
    const root = FileSystem.cacheDirectory;
    if (!root) throw new AudioPreparationError('cleanup_failed');
    const directory = root + 'audio-preparation/';
    const info = await FileSystem.getInfoAsync(directory);
    if (!info.exists) { cleanupBlocked = false; return; }
    if (!info.isDirectory) throw new AudioPreparationError('cleanup_failed');
    const names = await FileSystem.readDirectoryAsync(directory);
    if (names.length > 32 || names.some(name => !/^[a-f0-9-]+\.wav$/.test(name))) throw new AudioPreparationError('cleanup_failed');
    for (const name of names) await getNative().remove(directory + name);
    cleanupBlocked = false;
  } catch (error) {
    cleanupBlocked = true;
    throw error;
  } finally { coldCleanup = false; }
}

/** Call only after capture, preview and TTS owners have drained during confirmed private reset. */
export async function cleanupPreparedAudioAfterDrain(): Promise<void> {
  if (pending || sourceDrains.size || coldCleanup) throw new AudioPreparationError('cleanup_failed');
  try {
    for (const uri of ownedDerivatives) { await getNative().remove(uri); ownedDerivatives.delete(uri); }
    await cleanupColdPreparedAudio();
  } catch { cleanupBlocked = true; throw new AudioPreparationError('cleanup_failed'); }
}

/** A short reference alone crosses the number[] JSI bridge; never persist this result. */
export async function readPreparedReferencePcm(audio: PreparedAudio): Promise<number[]> {
  assertPrivateStorageWritable();
  if (!isPreparedUri(audio.uri) || audio.channels !== 1 || audio.sampleCount < 1
    || audio.sampleRate < 8_000 || audio.sampleRate > 48_000 || audio.sampleCount > audio.sampleRate * 8
    || audio.sizeBytes !== 44 + audio.sampleCount * 2) throw new AudioPreparationError('audio_limit');
  const info = await FileSystem.getInfoAsync(audio.uri);
  if (!info.exists || info.isDirectory || info.size !== audio.sizeBytes) throw new AudioPreparationError('invalid_audio');
  const bytes = toByteArray(await FileSystem.readAsStringAsync(audio.uri, { encoding: FileSystem.EncodingType.Base64 }));
  if (bytes.byteLength !== audio.sizeBytes) throw new AudioPreparationError('invalid_audio');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number, text: string) => [...text].every((value, index) => view.getUint8(offset + index) === value.charCodeAt(0));
  if (!tag(0, 'RIFF') || !tag(8, 'WAVE') || !tag(12, 'fmt ') || !tag(36, 'data')
    || view.getUint32(4, true) !== bytes.length - 8 || view.getUint32(16, true) !== 16
    || view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1
    || view.getUint32(24, true) !== audio.sampleRate || view.getUint32(28, true) !== audio.sampleRate * 2
    || view.getUint16(32, true) !== 2 || view.getUint16(34, true) !== 16
    || view.getUint32(40, true) !== audio.sampleCount * 2) throw new AudioPreparationError('invalid_audio');
  const outputHash = await RNFS.hash(fileUriToNativePath(audio.uri), 'sha256');
  const identity: unknown = JSON.parse(audio.identity);
  if (!Array.isArray(identity) || identity[identity.length - 1] !== outputHash) throw new AudioPreparationError('invalid_audio');
  const samples = Array.from({ length: audio.sampleCount }, (_, index) => view.getInt16(44 + index * 2, true) / 32768);
  if (!samples.length || samples.some(value => !Number.isFinite(value))) throw new AudioPreparationError('invalid_audio');
  return samples;
}
