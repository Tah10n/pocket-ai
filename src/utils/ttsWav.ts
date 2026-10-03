export interface TtsWavLimits {
  readonly maxSamples: number;
  readonly maxDurationSeconds: number;
  readonly maxBytes: number;
}

export class TtsWavError extends Error {
  constructor(readonly code: 'invalid_limits' | 'invalid_sample_rate' | 'invalid_pcm' | 'audio_limit') {
    super(code);
    this.name = 'TtsWavError';
  }
}

/** Validate the complete mono decode before allocating its single PCM16 WAV buffer. */
export function encodeMonoPcmWav(
  samples: readonly number[],
  sampleRate: number,
  limits: TtsWavLimits,
): Uint8Array {
  if (!Number.isSafeInteger(limits.maxSamples) || limits.maxSamples < 1
    || !Number.isFinite(limits.maxDurationSeconds) || limits.maxDurationSeconds <= 0
    || !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 44) {
    throw new TtsWavError('invalid_limits');
  }
  if (!Number.isSafeInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000) {
    throw new TtsWavError('invalid_sample_rate');
  }
  if (!Array.isArray(samples) || samples.length === 0) throw new TtsWavError('invalid_pcm');
  const dataBytes = samples.length * 2;
  const fileBytes = 44 + dataBytes;
  if (samples.length > limits.maxSamples || samples.length / sampleRate > limits.maxDurationSeconds
    || !Number.isSafeInteger(fileBytes) || fileBytes > limits.maxBytes
    || dataBytes > 0xffff_ffff - 36) {
    throw new TtsWavError('audio_limit');
  }
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    if (typeof sample !== 'number' || !Number.isFinite(sample) || sample < -1 || sample > 1) {
      throw new TtsWavError('invalid_pcm');
    }
  }

  const wav = new Uint8Array(fileBytes);
  const view = new DataView(wav.buffer);
  const writeTag = (offset: number, tag: string) => {
    for (let index = 0; index < tag.length; index += 1) view.setUint8(offset + index, tag.charCodeAt(index));
  };
  writeTag(0, 'RIFF');
  view.setUint32(4, fileBytes - 8, true);
  writeTag(8, 'WAVE');
  writeTag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // Linear PCM.
  view.setUint16(22, 1, true); // The pinned decoder returns mono samples.
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeTag(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    view.setInt16(44 + index * 2, Math.round(sample * (sample < 0 ? 32_768 : 32_767)), true);
  }
  return wav;
}
