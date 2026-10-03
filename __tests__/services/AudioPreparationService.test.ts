import * as FileSystem from 'expo-file-system/legacy';
import * as RNFS from 'react-native-fs';
import { fromByteArray } from 'base64-js';
import { encodeMonoPcmWav } from '../../src/utils/ttsWav';
import { prepareManagedAudio, readPreparedReferencePcm, discardPreparedAudio, cleanupPreparedAudioAfterDrain } from '../../src/services/AudioPreparationService';

const mockPrepare = jest.fn();
const mockRemove = jest.fn();
jest.mock('expo-modules-core', () => ({ requireNativeModule: () => ({ prepare: mockPrepare, remove: mockRemove }) }));
jest.mock('../../src/services/storage', () => ({ assertPrivateStorageWritable: jest.fn() }));

const sourceSha = 'a'.repeat(64);
const outputSha = 'b'.repeat(64);
const uri = `${FileSystem.cacheDirectory}audio-preparation/1234-abcd.wav`;
function result() {
  return { uri, sourceSha256: sourceSha, sha256: outputSha, sampleRate: 24000,
    channels: 1, sampleCount: 3, sizeBytes: 50 };
}

describe('bounded managed audio preparation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, isDirectory: false, size: 50 });
    mockRemove.mockResolvedValue(undefined);
    mockPrepare.mockResolvedValue(result());
    (RNFS.hash as jest.Mock).mockResolvedValue(outputSha);
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
});
