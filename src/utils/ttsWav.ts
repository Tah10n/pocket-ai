export interface TtsWavLimits {
  readonly maxSamples: number;
  readonly maxDurationSeconds: number;
  readonly maxBytes: number;
}

/** Three scalar values only; decoded samples remain private to the encoder. */
export interface TtsPcmNormalization {
  readonly sourcePeakAbs: number;
  readonly outOfRangeSamples: number;
  readonly gain: number;
}
export interface DecodedMonoPcmWavResult {
  readonly wav: Uint8Array;
  readonly pcmNormalization: TtsPcmNormalization;
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
  return encodePcmWav(samples, sampleRate, limits, false).wav;
}

/** Native vocoders may return finite float PCM above unity. Scale the whole clip
 * down by its peak, preserving relative amplitude without clipping or gain boost. */
export function encodeDecodedMonoPcmWav(
  samples: readonly number[],
  sampleRate: number,
  limits: TtsWavLimits,
): DecodedMonoPcmWavResult {
  return encodePcmWav(samples, sampleRate, limits, true);
}

function encodePcmWav(
  samples: readonly number[], sampleRate: number, limits: TtsWavLimits, normalizeNativeDecode: boolean,
): DecodedMonoPcmWavResult {
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
  let sourcePeakAbs = 0;
  let outOfRangeSamples = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    if (typeof sample !== 'number' || !Number.isFinite(sample)) {
      throw new TtsWavError('invalid_pcm');
    }
    const absolute = Math.abs(sample);
    if (absolute > 1) {
      if (!normalizeNativeDecode) throw new TtsWavError('invalid_pcm');
      outOfRangeSamples += 1;
    }
    sourcePeakAbs = Math.max(sourcePeakAbs, absolute);
  }
  const divisor = Math.max(1, sourcePeakAbs);

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
    const sample = samples[index] / divisor;
    view.setInt16(44 + index * 2, Math.round(sample * (sample < 0 ? 32_768 : 32_767)), true);
  }
  return { wav, pcmNormalization: { sourcePeakAbs, outOfRangeSamples, gain: 1 / divisor } };
}
