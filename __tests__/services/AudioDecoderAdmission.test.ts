import * as FileSystem from 'expo-file-system/legacy';
import { assertAudioDecoderAdmission, AUDIO_DECODER_RESERVE_PER_INPUT } from '../../src/services/AudioDecoderAdmission';
import { getFreshMemorySnapshot, type SystemMemorySnapshot } from '../../src/services/SystemMetricsService';
import { MAX_CHAT_AUDIO_ATTACHMENT_BYTES } from '../../src/utils/chatAttachments';
import type { LlmChatMessage, LlmInputAudioContentPart } from '../../src/types/chat';

jest.mock('../../src/services/SystemMetricsService', () => ({ getFreshMemorySnapshot: jest.fn() }));
const memory = jest.mocked(getFreshMemorySnapshot);
const info = jest.mocked(FileSystem.getInfoAsync);
const mib = 1024 ** 2;
function snapshot(overrides: Partial<SystemMemorySnapshot> = {}): SystemMemorySnapshot {
  return { timestampMs: 1, platform: 'android', totalBytes: 8 * 1024 ** 3, availableBytes: 1024 * mib,
    freeBytes: 1024 * mib, usedBytes: 1024 * mib, appUsedBytes: 128 * mib,
    lowMemory: false, pressureLevel: 'normal', thresholdBytes: 0, ...overrides };
}
function messages(input: LlmInputAudioContentPart['input_audio'] = { format: 'wav', url: 'file:///managed/audio.wav' }, count = 1): LlmChatMessage[] {
  return [{ role: 'user', content: 'Transcribe the attachment.', contentParts:
    Array.from({ length: count }, () => ({ type: 'input_audio', input_audio: input })) }];
}
beforeEach(() => {
  jest.clearAllMocks();
  info.mockResolvedValue({ exists: true, isDirectory: false, size: 1024, uri: 'file:///managed/audio.wav', modificationTime: 1 });
  memory.mockResolvedValue(snapshot());
});
it('leaves text-only requests independent of audio memory and file probes', async () => {
  await assertAudioDecoderAdmission([{ role: 'user', content: 'Hello.' }], jest.fn());
  expect(memory).not.toHaveBeenCalled(); expect(info).not.toHaveBeenCalled();
});
it('admits the actual maximum file at the conservative memory boundary', async () => {
  info.mockResolvedValue({ exists: true, isDirectory: false, size: MAX_CHAT_AUDIO_ATTACHMENT_BYTES, uri: 'file:///managed/audio.wav', modificationTime: 1 });
  memory.mockResolvedValue(snapshot({ availableBytes: AUDIO_DECODER_RESERVE_PER_INPUT, freeBytes: AUDIO_DECODER_RESERVE_PER_INPUT }));
  await expect(assertAudioDecoderAdmission(messages(), jest.fn())).resolves.toBeUndefined();
  expect(memory).toHaveBeenCalledWith(0); expect(info).toHaveBeenCalledWith('file:///managed/audio.wav');
});
it.each([
  null, snapshot({ lowMemory: true }), snapshot({ pressureLevel: 'critical' }),
  snapshot({ freeBytes: AUDIO_DECODER_RESERVE_PER_INPUT - 1, reclaimableBytes: 4 * 1024 ** 3 }),
  snapshot({ availableBytes: AUDIO_DECODER_RESERVE_PER_INPUT - 1 }),
  snapshot({ processAvailableBytes: AUDIO_DECODER_RESERVE_PER_INPUT - 1 }),
  snapshot({ availableBytes: AUDIO_DECODER_RESERVE_PER_INPUT, thresholdBytes: 1 }),
])('rejects unverified or insufficient decoder memory (%#)', async value => {
  memory.mockResolvedValue(value);
  await expect(assertAudioDecoderAdmission(messages(), jest.fn())).rejects.toMatchObject({ code: 'model_memory_insufficient' });
});
it('fails closed when the fresh memory bridge rejects', async () => {
  memory.mockRejectedValueOnce(new Error('unavailable memory snapshot'));
  await expect(assertAudioDecoderAdmission(messages(), jest.fn())).rejects.toMatchObject({ code: 'model_memory_insufficient' });
});
it('charges repeated inputs independently instead of deduplicating decoder allocation by URL', async () => {
  memory.mockResolvedValue(snapshot({ availableBytes: AUDIO_DECODER_RESERVE_PER_INPUT, freeBytes: AUDIO_DECODER_RESERVE_PER_INPUT }));
  await expect(assertAudioDecoderAdmission(messages(undefined, 2), jest.fn())).rejects.toMatchObject({ code: 'model_memory_insufficient' });
  expect(info).toHaveBeenCalledTimes(2);
  memory.mockResolvedValue(snapshot({ availableBytes: 2 * AUDIO_DECODER_RESERVE_PER_INPUT, freeBytes: 2 * AUDIO_DECODER_RESERVE_PER_INPUT }));
  await expect(assertAudioDecoderAdmission(messages(undefined, 2), jest.fn())).resolves.toBeUndefined();
});
it('rejects actual oversized files before fetching memory', async () => {
  info.mockResolvedValue({ exists: true, isDirectory: false, size: MAX_CHAT_AUDIO_ATTACHMENT_BYTES + 1, uri: 'file:///managed/audio.wav', modificationTime: 1 });
  await expect(assertAudioDecoderAdmission(messages(), jest.fn())).rejects.toMatchObject({ code: 'audio_decoder_size_limit' });
  expect(memory).not.toHaveBeenCalled();
});
it.each([0, -1, 1.5, NaN, Infinity])('rejects malformed or empty actual size %s', async size => {
  info.mockResolvedValue({ exists: true, isDirectory: false, size, uri: 'file:///managed/audio.wav', modificationTime: 1 });
  await expect(assertAudioDecoderAdmission(messages(), jest.fn())).rejects.toMatchObject({ code: 'chat_attachment_missing' });
  expect(memory).not.toHaveBeenCalled();
});
it('bounds inline encoded data before native allocation without reading a fabricated file', async () => {
  const limit = 4 * Math.ceil(MAX_CHAT_AUDIO_ATTACHMENT_BYTES / 3);
  await expect(assertAudioDecoderAdmission(messages({ format: 'mp3', data: 'A'.repeat(limit + 4) }), jest.fn()))
    .rejects.toMatchObject({ code: 'audio_decoder_size_limit' });
  expect(info).not.toHaveBeenCalled(); expect(memory).not.toHaveBeenCalled();
  await expect(assertAudioDecoderAdmission(messages({ format: 'mp3', data: 'QUJD' }), jest.fn())).resolves.toBeUndefined();
});
it.each(['https://example.com/audio.wav', 'content://unmanaged/audio'])('rejects a nonlocal decoder source %s', async url => {
  await expect(assertAudioDecoderAdmission(messages({ format: 'wav', url }), jest.fn()))
    .rejects.toMatchObject({ code: 'chat_attachment_unsupported_type' });
  expect(info).not.toHaveBeenCalled(); expect(memory).not.toHaveBeenCalled();
});
it('rejects empty audio without silently removing the part', async () => {
  await expect(assertAudioDecoderAdmission(messages({ format: 'wav', data: ' ', url: '' }), jest.fn()))
    .rejects.toMatchObject({ code: 'chat_attachment_corrupt' });
});
it.each(['file', 'memory'] as const)('rechecks ownership after the %s await and preserves cancellation', async boundary => {
  let active = true;
  const cancelled = new Error('cancelled owner');
  const assertCurrent = () => { if (!active) throw cancelled; };
  if (boundary === 'file') info.mockImplementationOnce(async () => { active = false; return { exists: true, isDirectory: false, size: 1, uri: 'file:///managed/audio.wav', modificationTime: 1 }; });
  else memory.mockImplementationOnce(async () => { active = false; return snapshot(); });
  await expect(assertAudioDecoderAdmission(messages(), assertCurrent)).rejects.toBe(cancelled);
  if (boundary === 'file') expect(memory).not.toHaveBeenCalled();
});
