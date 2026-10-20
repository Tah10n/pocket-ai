import * as FileSystem from 'expo-file-system/legacy';
import { fromByteArray } from 'base64-js';
import { ChatAttachmentStorageService, materializeMediaDraftsForMessage } from '../../src/services/ChatAttachmentStorageService';
import { prepareManagedAudio, discardPreparedAudio, cleanupPreparedAudioAfterDrain } from '../../src/services/AudioPreparationService';
import { normalizePersistedChatAttachment } from '../../src/utils/chatAttachments';

const mockPrepare = jest.fn();
const mockRemove = jest.fn();
jest.mock('expo-modules-core', () => ({ requireNativeModule: () => ({ prepare: mockPrepare, remove: mockRemove }) }));
jest.mock('../../src/services/storage', () => ({ assertPrivateStorageWritable: jest.fn() }));

function wav(seconds: number, rate = 16000) {
  const bytes = new Uint8Array(44 + seconds * rate * 2);
  const view = new DataView(bytes.buffer);
  const tag = (offset: number, value: string) => [...value].forEach((c, i) => { bytes[offset + i] = c.charCodeAt(0); });
  tag(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true);
  view.setUint16(34, 16, true); tag(36, 'data'); view.setUint32(40, bytes.length - 44, true);
  return bytes;
}
function mp3(frames: number) {
  // MPEG1 Layer III, 128kbps / 44100Hz: valid zero main-data (silence) frames.
  const bytes = new Uint8Array(frames * 417);
  for (let i = 0; i < frames; i++) bytes.set([0xff, 0xfb, 0x90, 0x00], i * 417);
  return bytes;
}

describe('real storage/preparation import policy', () => {
  const files = new Map<string, Uint8Array>();
  let service: ChatAttachmentStorageService;
  beforeEach(() => {
    jest.clearAllMocks(); files.clear();
    service = new ChatAttachmentStorageService({ now: () => 123, random: () => 0.456 });
    (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => files.has(uri)
      ? { exists: true, isDirectory: false, size: files.get(uri)!.length } : { exists: false });
    (FileSystem.copyAsync as jest.Mock).mockImplementation(async ({ from, to }) => { files.set(to, files.get(from)!.slice()); });
    (FileSystem.deleteAsync as jest.Mock).mockImplementation(async (uri: string) => { files.delete(uri); });
    (FileSystem.readAsStringAsync as jest.Mock).mockImplementation(async (uri: string, options) => {
      const data = files.get(uri)!;
      return fromByteArray(data.subarray(options.position ?? 0, (options.position ?? 0) + (options.length ?? data.length)));
    });
    mockRemove.mockImplementation(async (uri: string) => { files.delete(uri); });
    // Only native boundary is mocked. It enforces the actual short-preparation contract.
    mockPrepare.mockImplementation(async (source: string, rate: number, seconds: number, maxBytes: number) => {
      const data = files.get(source)!;
      if (data.length > maxBytes) throw { code: 'ERR_AUDIO_PREPARATION_NATIVE_INPUT' };
      if (data[0] !== 82) throw { code: 'ERR_AUDIO_PREPARATION_NATIVE_DECODE' };
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const duration = view.getUint32(40, true) / view.getUint32(28, true);
      if (duration > seconds) throw { code: 'ERR_AUDIO_PREPARATION_NATIVE_DECODE' };
      const output = wav(duration, rate); const uri = `${FileSystem.cacheDirectory}audio-preparation/abcd.wav`;
      files.set(uri, output);
      return { uri, sourceSha256: 'a'.repeat(64), sha256: 'b'.repeat(64), channels: 1,
        sampleRate: rate, sampleCount: duration * rate, sizeBytes: output.length };
    });
  });
  afterEach(async () => { mockRemove.mockResolvedValue(undefined); files.clear(); await cleanupPreparedAudioAfterDrain(); });

  it.each([
    ['over-four-MiB.wav', () => wav(140)],
    ['forty-seconds.wav', () => wav(40)],
    ['legacy-import.mp3', () => mp3(1400)],
  ])('imports %s unchanged, sends and reopens with its original name', async (name, fixture) => {
    const source = 'file:///picker/' + name; const bytes = fixture(); files.set(source, bytes);
    const draft = await service.copyAudioAssetToDraft({ uri: source, name, size: bytes.length });
    expect(draft.displayName).toBe(name); expect(draft.sizeBytes).toBe(bytes.length);
    expect(Buffer.from(files.get(draft.localUri!)!).equals(Buffer.from(bytes))).toBe(true);
    expect(mockPrepare).not.toHaveBeenCalled();
    const [sent] = materializeMediaDraftsForMessage({ threadId: 't', messageId: 'm', drafts: [draft] });
    const reopened = normalizePersistedChatAttachment(JSON.parse(JSON.stringify(sent)));
    expect(reopened).toMatchObject({ displayName: name, sizeBytes: bytes.length, source: 'document_picker' });
    expect(reopened).toMatchObject({ audio: { durationMs: expect.any(Number) } });
    await service.discardMediaDraft(draft); expect(files.has(draft.localUri!)).toBe(false);
    expect(files.get(source)).toBe(bytes);
  });

  it('keeps microphone and reference limits independent of import', async () => {
    const source = 'file:///recorder/recording.wav'; files.set(source, wav(30));
    const prepared = await prepareManagedAudio({ sourceUri: source, purpose: 'chat' });
    const draft = await service.copyPreparedAudioToDraft(prepared, 'microphone');
    expect(draft.audio?.durationMs).toBe(30000);
    expect(mockPrepare).toHaveBeenCalledWith(source, 16000, 30, 4 * 1024 * 1024);
    await discardPreparedAudio(prepared);
    await expect(service.copyPreparedAudioToDraft({ ...prepared, sampleCount: 480001, sizeBytes: 960046 }, 'microphone'))
      .rejects.toMatchObject({ name: 'ChatMediaAttachmentUnsupportedTypeError' });
    files.set(source, wav(140));
    await expect(prepareManagedAudio({ sourceUri: source, purpose: 'chat' })).rejects.toMatchObject({ code: 'audio_limit' });
    files.set(source, wav(9));
    await expect(prepareManagedAudio({ sourceUri: source, purpose: 'reference' })).rejects.toBeDefined();
    expect(mockPrepare).toHaveBeenLastCalledWith(source, 24000, 8, 2 * 1024 * 1024);
  });

  it('rejects renamed bytes and corrupt/truncated containers, cleaning the new copy', async () => {
    for (const bytes of [new Uint8Array(100), wav(1).subarray(0, 100), mp3(4).subarray(0, 900)]) {
      files.clear(); const source = 'file:///picker/fake.wav'; files.set(source, bytes);
      await expect(service.copyAudioAssetToDraft({ uri: source, name: 'fake.wav' }))
        .rejects.toMatchObject({ name: 'ChatMediaAttachmentUnsupportedTypeError' });
      expect([...files.keys()]).toEqual([source]);
    }
  });

  it('checks actual copied size rather than trusting picker metadata', async () => {
    const source = 'file:///picker/large.wav'; files.set(source, new Uint8Array(25 * 1024 * 1024 + 1));
    await expect(service.copyAudioAssetToDraft({ uri: source, name: 'large.wav', size: 10 }))
      .rejects.toMatchObject({ name: 'ChatMediaAttachmentTooLargeError' });
    expect([...files.keys()]).toEqual([source]);
  });

  it('does not publish a copy after Stop or owner change during validation', async () => {
    const source = 'file:///picker/voice.wav'; files.set(source, wav(40));
    let stale = false;
    (FileSystem.readAsStringAsync as jest.Mock).mockImplementationOnce(async (uri, options) => {
      stale = true; return fromByteArray(files.get(uri)!.subarray(options.position, options.position + options.length));
    });
    await expect(service.copyAudioAssetToDraft({ uri: source, name: 'voice.wav' }, {
      assertCurrent: () => { if (stale) throw new Error('owner_changed'); },
    })).rejects.toThrow('owner_changed');
    expect([...files.keys()]).toEqual([source]);
  });
  it('bounds every content read and preserves previously sent attachments during rollback', async () => {
    const prior = 'test-dir/chat-attachments/prior.wav'; const source = 'file:///picker/voice.wav';
    files.set(prior, wav(1)); files.set(source, wav(140));
    const draft = await service.copyAudioAssetToDraft({ uri: source, name: 'voice.wav' });
    for (const [, options] of (FileSystem.readAsStringAsync as jest.Mock).mock.calls) {
      expect(options.length).toBeLessThanOrEqual(65536);
      expect(options.position).toBeGreaterThanOrEqual(0);
    }
    await service.discardMediaDraft(draft);
    expect(files.has(prior)).toBe(true);
    expect(files.has(source)).toBe(true);
  });

  it('surfaces failed copy rollback and retains ownership until an explicit retry succeeds', async () => {
    const source = 'file:///picker/corrupt.wav'; files.set(source, new Uint8Array(100));
    (FileSystem.deleteAsync as jest.Mock).mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(service.copyAudioAssetToDraft({ uri: source, name: 'corrupt.wav' }))
      .rejects.toMatchObject({ code: 'cleanup_failed' });
    const owned = [...files.keys()].find(uri => uri !== source)!;
    expect(owned).toBeDefined();
    await service.cleanupFailedAudioCopies();
    expect(files.has(owned)).toBe(false); expect(files.has(source)).toBe(true);
  });

  it('retains a failed microphone copy rollback while its borrowed derivative remains caller owned', async () => {
    const source = 'file:///recorder/recording.wav'; files.set(source, wav(1));
    const prepared = await prepareManagedAudio({ sourceUri: source, purpose: 'chat' });
    (FileSystem.copyAsync as jest.Mock).mockImplementationOnce(async ({ to }) => { files.set(to, new Uint8Array(10)); });
    (FileSystem.deleteAsync as jest.Mock).mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(service.copyPreparedAudioToDraft(prepared, 'microphone')).rejects.toMatchObject({ code: 'cleanup_failed' });
    expect(files.has(prepared.uri)).toBe(true);
    await service.cleanupFailedAudioCopies();
    expect([...files.keys()]).toEqual([source, prepared.uri]);
    await discardPreparedAudio(prepared);
  });

});
