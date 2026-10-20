import * as FileSystem from 'expo-file-system/legacy';
import { toByteArray } from 'base64-js';
import { MAX_CHAT_AUDIO_ATTACHMENT_BYTES } from './chatAttachments';

export class ImportedAudioValidationError extends Error {
  constructor(readonly code: 'invalid_audio' | 'audio_limit') { super(code); this.name = 'ImportedAudioValidationError'; }
}
const invalid = (): never => { throw new ImportedAudioValidationError('invalid_audio'); };
const CHUNK_BYTES = 64 * 1024;

/** Inspect the managed copy, never the picker path. No audio decoding or whole-file JS allocation. */
export async function validateImportedAudio(uri: string, size: number, expected: 'wav' | 'mp3',
  assertCurrent: () => void): Promise<{ format: 'wav' | 'mp3'; durationMs: number }> {
  if (!Number.isSafeInteger(size) || size < 12) return invalid();
  if (size > MAX_CHAT_AUDIO_ATTACHMENT_BYTES) throw new ImportedAudioValidationError('audio_limit');
  let chunk: Uint8Array = new Uint8Array(0); let chunkStart = -1;
  const read = async (offset: number, length: number): Promise<Uint8Array> => {
    assertCurrent();
    if (offset < 0 || length > CHUNK_BYTES || offset + length > size) return invalid();
    if (offset < chunkStart || offset + length > chunkStart + chunk.length) {
      chunkStart = offset;
      const count = Math.min(CHUNK_BYTES, size - offset);
      chunk = toByteArray(await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64, position: offset, length: count,
      }));
      assertCurrent();
      if (chunk.length !== count) return invalid();
    }
    return chunk.subarray(offset - chunkStart, offset - chunkStart + length);
  };
  const tag = (bytes: Uint8Array, text: string) => [...text].every((c, i) => bytes[i] === c.charCodeAt(0));
  const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = await read(0, 12);
  if (expected === 'wav') {
    if (!tag(header, 'RIFF') || !tag(header.subarray(8), 'WAVE') || view(header).getUint32(4, true) !== size - 8) return invalid();
    let offset = 12; let chunks = 0; let rate = 0; let alignment = 0; let dataBytes = 0;
    while (offset < size) {
      if (++chunks > 4096) return invalid();
      const entry = await read(offset, 8); const length = view(entry).getUint32(4, true);
      const end = offset + 8 + length;
      if (end > size || end + (length % 2) > size) return invalid();
      if (tag(entry, 'fmt ')) {
        if (rate || length < 16) return invalid();
        const fmt = view(await read(offset + 8, 16));
        const encoding = fmt.getUint16(0, true); const channels = fmt.getUint16(2, true);
        rate = fmt.getUint32(4, true); alignment = fmt.getUint16(12, true); const bits = fmt.getUint16(14, true);
        if (!(encoding === 1 && [8, 16, 24, 32].includes(bits)) && !(encoding === 3 && [32, 64].includes(bits))) return invalid();
        if (channels < 1 || channels > 2 || rate < 8000 || rate > 192000
          || alignment !== channels * bits / 8 || fmt.getUint32(8, true) !== rate * alignment) return invalid();
      } else if (tag(entry, 'data')) {
        if (!rate || dataBytes || !length || length % alignment !== 0) return invalid();
        dataBytes = length;
      }
      offset = end + (length % 2);
    }
    if (!dataBytes || !rate) return invalid();
    assertCurrent();
    return { format: 'wav', durationMs: Math.ceil(dataBytes * 1000 / alignment / rate) };
  }

  let offset = 0;
  if (tag(header, 'ID3')) {
    if (![2, 3, 4].includes(header[3]) || header[4] === 255 || header.slice(6, 10).some(byte => byte > 127)) return invalid();
    const length = header[6] * 2097152 + header[7] * 16384 + header[8] * 128 + header[9];
    offset = 10 + length + (header[3] === 4 && (header[5] & 16) !== 0 ? 10 : 0);
    if (offset >= size) return invalid();
  }
  let frames = 0; let samples = 0; let streamRate = 0; let streamVersion = -1;
  while (offset < size) {
    if (size - offset === 128 && tag(await read(offset, 3), 'TAG')) { offset = size; break; }
    const frame = await read(offset, 4);
    const version = (frame[1] >> 3) & 3; const layer = (frame[1] >> 1) & 3;
    const bitrateIndex = frame[2] >> 4; const rateIndex = (frame[2] >> 2) & 3;
    if (frame[0] !== 255 || (frame[1] & 224) !== 224 || version === 1 || layer !== 1
      || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3 || (frame[3] & 3) === 2) return invalid();
    const rate = [44100, 48000, 32000][rateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4);
    const bitrate = (version === 3 ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
      : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160])[bitrateIndex];
    if (frames && (rate !== streamRate || version !== streamVersion)) return invalid();
    const length = Math.floor((version === 3 ? 144000 : 72000) * bitrate / rate) + ((frame[2] >> 1) & 1);
    if (offset + length > size) return invalid();
    streamRate = rate; streamVersion = version; frames++; samples += version === 3 ? 1152 : 576; offset += length;
  }
  if (frames < 2 || offset !== size) return invalid();
  assertCurrent();
  return { format: 'mp3', durationMs: Math.ceil(samples * 1000 / streamRate) };
}
