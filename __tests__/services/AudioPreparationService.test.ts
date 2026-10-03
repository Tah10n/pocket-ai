import * as FileSystem from 'expo-file-system/legacy';
import * as RNFS from 'react-native-fs';
import { fromByteArray } from 'base64-js';
import { encodeMonoPcmWav } from '../../src/utils/ttsWav';
import {
  AudioPreparationError, AUDIO_PREPARATION_LIMITS, prepareManagedAudio, readPreparedReferencePcm,
  discardPreparedAudio, cleanupPreparedAudioAfterDrain,
} from '../../src/services/AudioPreparationService';
import type { AudioPreparationFailureReason, AudioPurpose } from '../../src/services/AudioPreparationService';

const mockPrepare = jest.fn();
const mockRemove = jest.fn();
jest.mock('expo-modules-core', () => ({ requireNativeModule: () => ({ prepare: mockPrepare, remove: mockRemove }) }));
jest.mock('../../src/services/storage', () => ({ assertPrivateStorageWritable: jest.fn() }));

const sourceSha = 'a'.repeat(64);
const outputSha = 'b'.repeat(64);
const uri = `${FileSystem.cacheDirectory}audio-preparation/1234-abcd.wav`;
const sensitiveSource = 'file:///private-reference-source.m4a';
const sensitivePayload = 'encoded-private-source-payload';
function result() {
  return { uri, sourceSha256: sourceSha, sha256: outputSha, sampleRate: 24000,
    channels: 1, sampleCount: 3, sizeBytes: 50 };
}

async function expectSafeFailure(pending: Promise<unknown>, code: AudioPreparationError['code'],
  safeReason?: AudioPreparationFailureReason) {
  const error: unknown = await pending.then(() => { throw new Error('expected_preparation_failure'); }, value => value);
  expect(error).toBeInstanceOf(AudioPreparationError);
  const failure = error as AudioPreparationError;
  expect(failure.code).toBe(code);
  expect(failure.safeReason).toBe(safeReason);
  expect(failure.message).toBe(code);
  const serialized = JSON.stringify(failure);
  expect(JSON.parse(serialized)).toEqual({ code, name: 'AudioPreparationError', ...(safeReason ? { safeReason } : {}) });
  for (const sensitive of [sensitiveSource, sensitivePayload, uri, sourceSha, outputSha]) {
    expect(serialized).not.toContain(sensitive);
    expect(failure.message).not.toContain(sensitive);
  }
  expect(failure.stack).not.toContain(sensitivePayload);
}

describe('bounded managed audio preparation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, isDirectory: false, size: 50 });
    mockRemove.mockResolvedValue(undefined);
    mockPrepare.mockResolvedValue(result());
    (RNFS.hash as jest.Mock).mockResolvedValue(outputSha);
  });

  afterEach(async () => {
    mockRemove.mockResolvedValue(undefined);
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: false });
    await cleanupPreparedAudioAfterDrain();
  });

  it('uses the actual 24k mono output and retains immutable source/profile identity', async () => {
    const prepared = await prepareManagedAudio({ sourceUri: 'file:///managed/source.m4a', purpose: 'reference' });
    expect(mockPrepare).toHaveBeenCalledWith('file:///managed/source.m4a', 24000, 8, 2 * 1024 * 1024);
    expect(prepared.durationMs).toBe(3 * 1000 / 24000);
    expect(JSON.parse(prepared.identity)).toContain(sourceSha);
    expect(JSON.parse(prepared.identity)).toContain(outputSha);
    await discardPreparedAudio(prepared);
    expect(mockRemove).toHaveBeenCalledWith(uri);
  });

  it('rejects excessive bytes before calling a native decoder', async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, size: 2 * 1024 * 1024 + 1 });
    await expect(prepareManagedAudio({ sourceUri: 'file:///managed/source.wav', purpose: 'reference' })).rejects.toMatchObject({ code: 'audio_limit' });
    expect(mockPrepare).not.toHaveBeenCalled();
  });

  it('cancellation during native preparation waits for settlement before deleting its result', async () => {
    let finish!: (value: ReturnType<typeof result>) => void;
    mockPrepare.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const controller = new AbortController();
    const pending = prepareManagedAudio({ sourceUri: 'file:///managed/source.m4a', purpose: 'reference', signal: controller.signal });
    await Promise.resolve(); await Promise.resolve();
    controller.abort();
    expect(mockRemove).not.toHaveBeenCalled();
    finish(result());
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(mockRemove).toHaveBeenCalledWith(uri);
  });

  it('reads real PCM samples rather than trusting the extension', async () => {
    const prepared = await prepareManagedAudio({ sourceUri: 'file:///managed/renamed.mp3', purpose: 'reference' });
    const wav = encodeMonoPcmWav([0, 0.5, -0.5], 24000, { maxSamples: 3, maxDurationSeconds: 1, maxBytes: 50 });
    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue(fromByteArray(wav));
    const samples = await readPreparedReferencePcm(prepared);
    expect(samples).toEqual([0, 0.5, -0.5]);
    wav[20] = 3; // Invalid float declaration over PCM16 data.
    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue(fromByteArray(wav));
    await expect(readPreparedReferencePcm(prepared)).rejects.toMatchObject({ code: 'invalid_audio' });
  });

  it('rejects changed bytes and invalid sample counts before creating a speaker payload', async () => {
    const prepared = await prepareManagedAudio({ sourceUri: 'file:///managed/source.wav', purpose: 'reference' });
    const wav = encodeMonoPcmWav([0, 0.5, -0.5], 24000, { maxSamples: 3, maxDurationSeconds: 1, maxBytes: 50 });
    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue(fromByteArray(wav));
    (RNFS.hash as jest.Mock).mockResolvedValue('c'.repeat(64));
    await expect(readPreparedReferencePcm(prepared)).rejects.toMatchObject({ code: 'invalid_audio' });
    await expect(readPreparedReferencePcm({ ...prepared, sampleCount: 0 })).rejects.toMatchObject({ code: 'audio_limit' });
  });

  it('preserves native partial-file cleanup failure and blocks retries until confirmed cleanup', async () => {
    mockPrepare.mockRejectedValueOnce({ code: 'ERR_AUDIO_CLEANUP', message: 'cleanup_failed' });
    await expect(prepareManagedAudio({ sourceUri: 'file:///managed/source.wav', purpose: 'reference' })).rejects.toMatchObject({ code: 'cleanup_failed' });
    await expect(prepareManagedAudio({ sourceUri: 'file:///managed/source.wav', purpose: 'reference' })).rejects.toMatchObject({ code: 'cleanup_failed' });
    expect(mockPrepare).toHaveBeenCalledTimes(1);
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: false });
    await cleanupPreparedAudioAfterDrain();
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, isDirectory: false, size: 50 });
    await expect(prepareManagedAudio({ sourceUri: 'file:///managed/source.wav', purpose: 'reference' })).resolves.toMatchObject({ uri });
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: false });
    await cleanupPreparedAudioAfterDrain();
  });

  it.each<[AudioPreparationFailureReason, unknown, boolean]>([
    ['native_result', sensitivePayload, false],
    ['prepared_uri', { ...result(), uri: sensitiveSource }, false],
    ['channels', { ...result(), channels: 2 }, true],
    ['sample_rate', { ...result(), sampleRate: 16000 }, true],
    ['sample_count', { ...result(), sampleCount: 1.5 }, true],
    ['output_size', { ...result(), sizeBytes: 51 }, true],
    ['source_hash', { ...result(), sourceSha256: sensitivePayload }, true],
    ['output_hash', { ...result(), sha256: sensitivePayload }, true],
  ])('publishes only the finite %s validation reason and disposes only an owned result', async (reason, nativeResult, owned) => {
    mockPrepare.mockResolvedValueOnce(nativeResult);
    await expectSafeFailure(prepareManagedAudio({ sourceUri: sensitiveSource, purpose: 'reference' }), 'invalid_audio', reason);
    if (owned) expect(mockRemove).toHaveBeenCalledTimes(1);
    else expect(mockRemove).not.toHaveBeenCalled();
    if (owned) expect(mockRemove).toHaveBeenCalledWith(uri);
  });

  it.each<[AudioPurpose, number]>([['chat', 16000], ['reference', 24000]])(
    'keeps the full %s decoder sample limit and rejects one extra sample with a finite reason', async (purpose, rate) => {
      const limits = AUDIO_PREPARATION_LIMITS[purpose];
      const sampleCount = rate * limits.seconds;
      mockPrepare.mockResolvedValueOnce({ ...result(), sampleRate: rate, sampleCount, sizeBytes: 44 + sampleCount * 2 });
      const prepared = await prepareManagedAudio({ sourceUri: sensitiveSource, purpose });
      expect(prepared.durationMs).toBe(limits.seconds * 1000);
      expect(mockPrepare).toHaveBeenLastCalledWith(sensitiveSource, rate, limits.seconds, limits.sourceBytes);
      await discardPreparedAudio(prepared);
      mockPrepare.mockResolvedValueOnce({ ...result(), sampleRate: rate, sampleCount: sampleCount + 1,
        sizeBytes: 44 + (sampleCount + 1) * 2 });
      await expectSafeFailure(prepareManagedAudio({ sourceUri: sensitiveSource, purpose }), 'invalid_audio', 'sample_count');
      expect(mockRemove).toHaveBeenCalledTimes(2);
    });

  it.each<[string, AudioPreparationFailureReason]>([
    ['ERR_AUDIO_PREPARATION_NATIVE_INPUT', 'native_input'],
    ['ERR_AUDIO_PREPARATION_NATIVE_ADMISSION', 'native_admission'],
    ['ERR_AUDIO_PREPARATION_NATIVE_SNIFF', 'native_sniff'],
    ['ERR_AUDIO_PREPARATION_NATIVE_OUTPUT', 'native_output'],
    ['ERR_AUDIO_PREPARATION_NATIVE_DECODE', 'native_decode'],
    ['ERR_AUDIO_PREPARATION_NATIVE_IDENTITY', 'native_identity'],
    ['ERR_AUDIO_PREPARATION_NATIVE_DELIVERY', 'native_delivery'],
  ])('transports only the whitelisted native code %s', async (nativeCode, reason) => {
    mockPrepare.mockRejectedValueOnce({ code: nativeCode, message: sensitivePayload, uri: sensitiveSource,
      sourceSha256: sourceSha, sha256: outputSha, encodedSource: sensitivePayload, stack: sensitivePayload });
    await expectSafeFailure(prepareManagedAudio({ sourceUri: sensitiveSource, purpose: 'reference' }), 'preparation_failed', reason);
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it.each([undefined, 123, '__proto__', 'ERR_AUDIO_PREPARATION', 'ERR_AUDIO_PREPARATION_NATIVE_UNKNOWN',
    'ERR_AUDIO_PREPARATION_NATIVE_DECODE:' + sensitivePayload])(
    'does not infer a native reason from an unknown code or private error payload (%s)', async nativeCode => {
      mockPrepare.mockRejectedValueOnce({ code: nativeCode,
        message: 'ERR_AUDIO_PREPARATION_NATIVE_DECODE:' + sensitivePayload, safeReason: 'native_decode',
        uri: sensitiveSource, sourceSha256: sourceSha, encodedSource: sensitivePayload, stack: sensitivePayload });
      await expectSafeFailure(prepareManagedAudio({ sourceUri: sensitiveSource, purpose: 'reference' }), 'preparation_failed');
      expect(mockRemove).not.toHaveBeenCalled();
    });

  it('prioritizes an actual derivative cleanup failure over its validation reason and blocks retries', async () => {
    mockPrepare.mockResolvedValueOnce({ ...result(), channels: 2 });
    mockRemove.mockRejectedValueOnce({ message: sensitivePayload, uri });
    await expectSafeFailure(prepareManagedAudio({ sourceUri: sensitiveSource, purpose: 'reference' }), 'cleanup_failed');
    await expectSafeFailure(prepareManagedAudio({ sourceUri: sensitiveSource, purpose: 'reference' }), 'cleanup_failed');
    expect(mockPrepare).toHaveBeenCalledTimes(1);
    expect(mockRemove).toHaveBeenCalledTimes(1);
  });
});
