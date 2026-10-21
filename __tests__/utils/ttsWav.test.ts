import { encodeDecodedMonoPcmWav, encodeMonoPcmWav, TtsWavError } from '../../src/utils/ttsWav';
import { TTS_LIMITS } from '../../src/types/tts';

const limits = { maxSamples: 96_000, maxDurationSeconds: 2, maxBytes: 192_044 };

function tag(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}

describe('encodeMonoPcmWav', () => {
  it.each([8_000, 22_050, 24_000, 44_100, 48_000, 192_000])('encodes the actual %i Hz mono rate and RIFF lengths', rate => {
    const wav = encodeMonoPcmWav([-1, -0.5, 0, 0.5, 1], rate, limits);
    const view = new DataView(wav.buffer);
    expect(wav.length).toBe(54);
    expect([tag(wav, 0), tag(wav, 8), tag(wav, 12), tag(wav, 36)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data']);
    expect(view.getUint32(4, true)).toBe(46);
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(rate);
    expect(view.getUint32(28, true)).toBe(rate * 2);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(10);
    expect(Array.from({ length: 5 }, (_, i) => view.getInt16(44 + i * 2, true)))
      .toEqual([-32768, -16384, 0, 16384, 32767]);
  });

  it.each([[], [NaN], [Infinity], [-Infinity], [1.00001], [-1.00001], Array(1)].map(samples => ({ samples })))('rejects invalid PCM rather than emitting silence', ({ samples }) => {
    expect(() => encodeMonoPcmWav(samples, 24_000, limits)).toThrow(TtsWavError);
  });

  it.each([0, 7999, 192001, 24000.5, NaN, Infinity])('rejects invalid reported rate %s', rate => {
    expect(() => encodeMonoPcmWav([0], rate, limits)).toThrow('invalid_sample_rate');
  });

  it('permits the exact duration/file bounds and rejects each exceeded bound', () => {
    const pcm = Array(8_000).fill(0);
    const exact = { maxSamples: 8_000, maxDurationSeconds: 1, maxBytes: 16_044 };
    expect(encodeMonoPcmWav(pcm, 8_000, exact).length).toBe(16_044);
    expect(() => encodeMonoPcmWav(pcm, 8_000, { ...exact, maxSamples: 7_999 })).toThrow('audio_limit');
    expect(() => encodeMonoPcmWav(pcm, 8_000, { ...exact, maxDurationSeconds: 0.999 })).toThrow('audio_limit');
    expect(() => encodeMonoPcmWav(pcm, 8_000, { ...exact, maxBytes: 16_043 })).toThrow('audio_limit');
  });

  it('rejects malformed limits', () => {
    for (const invalid of [
      { ...limits, maxSamples: 0 }, { ...limits, maxSamples: 1.5 },
      { ...limits, maxDurationSeconds: Infinity }, { ...limits, maxDurationSeconds: 0 },
      { ...limits, maxBytes: 43 }, { ...limits, maxBytes: NaN },
    ]) expect(() => encodeMonoPcmWav([0], 24_000, invalid)).toThrow('invalid_limits');
  });

  it('validates samples before allocating an output buffer and retains the caller array', () => {
    const pcm = [0, NaN];
    const allocation = jest.spyOn(global, 'Uint8Array');
    try {
      expect(() => encodeMonoPcmWav(pcm, 24_000, limits)).toThrow('invalid_pcm');
      expect(allocation).not.toHaveBeenCalled();
      expect(pcm[0]).toBe(0);
      expect(pcm[1]).toBeNaN();
    } finally { allocation.mockRestore(); }
  });
});

describe('encodeDecodedMonoPcmWav', () => {
  it('normalizes the complete finite clip by one peak while preserving ratios, header and caller samples', () => {
    const samples = Object.freeze([2, -4, 1, -2, 4, 0]);
    const { wav, pcmNormalization } = encodeDecodedMonoPcmWav(samples, 24_000, limits);
    const view = new DataView(wav.buffer);
    expect(samples).toEqual([2, -4, 1, -2, 4, 0]);
    expect(pcmNormalization).toEqual({ sourcePeakAbs: 4, outOfRangeSamples: 4, gain: 0.25 });
    expect(wav.length).toBe(44 + samples.length * 2);
    expect([tag(wav, 0), tag(wav, 8), tag(wav, 12), tag(wav, 36)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data']);
    expect(view.getUint32(4, true)).toBe(wav.length - 8);
    expect(view.getUint16(20, true)).toBe(1); expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(24_000); expect(view.getUint32(28, true)).toBe(48_000);
    expect(view.getUint16(32, true)).toBe(2); expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(samples.length * 2);
    expect(Array.from({ length: samples.length }, (_, index) => view.getInt16(44 + index * 2, true)))
      .toEqual([16384, -32768, 8192, -16384, 32767, 0]);
    expect(() => encodeMonoPcmWav(samples, 24_000, limits)).toThrow('invalid_pcm');
  });

  it.each([
    { samples: [-0.5, 0, 0.25], peak: 0.5 },
    { samples: [-1, 0, 1], peak: 1 },
    { samples: [0, -0], peak: 0 },
    { samples: [Number.MIN_VALUE], peak: Number.MIN_VALUE },
  ])('does not boost an already bounded clip with peak $peak', ({ samples, peak }) => {
    const encoded = encodeDecodedMonoPcmWav(Object.freeze(samples), 24_000, limits);
    expect(encoded.wav).toEqual(encodeMonoPcmWav(samples, 24_000, limits));
    expect(encoded.pcmNormalization).toEqual({ sourcePeakAbs: peak, outOfRangeSamples: 0, gain: 1 });
  });

  it('converts finite numeric extremes without overflow or sample clipping', () => {
    const samples = Object.freeze([-Number.MAX_VALUE, -Number.MAX_VALUE / 2, 0, Number.MAX_VALUE / 2, Number.MAX_VALUE]);
    const encoded = encodeDecodedMonoPcmWav(samples, 44_100, limits);
    const view = new DataView(encoded.wav.buffer);
    expect(encoded.pcmNormalization).toEqual({ sourcePeakAbs: Number.MAX_VALUE, outOfRangeSamples: 4, gain: 1 / Number.MAX_VALUE });
    expect(Array.from({ length: samples.length }, (_, index) => view.getInt16(44 + index * 2, true)))
      .toEqual([-32768, -16384, 0, 16384, 32767]);
  });

  it.each([undefined, null, 'pcm', { 0: 2, length: 1 }, new Float32Array([2]), [],
    ['2'], [NaN], [Infinity], [-Infinity], [2, undefined], Array(1)].map(samples => ({ samples })))
  ('rejects malformed decoded PCM without allocating a WAV', ({ samples }) => {
    const allocation = jest.spyOn(global, 'Uint8Array');
    try {
      expect(() => encodeDecodedMonoPcmWav(samples as unknown as readonly number[], 24_000, limits)).toThrow('invalid_pcm');
      expect(allocation).not.toHaveBeenCalled();
    } finally { allocation.mockRestore(); }
  });

  it('checks the full clip for nonfinite samples before any output allocation', () => {
    const samples = Object.freeze([2, -4, NaN]);
    const allocation = jest.spyOn(global, 'Uint8Array');
    try {
      expect(() => encodeDecodedMonoPcmWav(samples, 24_000, limits)).toThrow('invalid_pcm');
      expect(allocation).not.toHaveBeenCalled(); expect(samples[2]).toBeNaN();
    } finally { allocation.mockRestore(); }
  });

  it.each([0, 7999, 192001, 24000.5, NaN, Infinity])('retains the reported sample-rate guard for %s', rate => {
    expect(() => encodeDecodedMonoPcmWav([2], rate, limits)).toThrow('invalid_sample_rate');
  });

  it('retains sample, 16-second duration and WAV byte limits before normalizing', () => {
    const rate = 8_000;
    const count = rate * TTS_LIMITS.durationSeconds;
    const samples = Array(count).fill(2);
    const admitted = { maxSamples: TTS_LIMITS.pcmSamples, maxDurationSeconds: TTS_LIMITS.durationSeconds,
      maxBytes: TTS_LIMITS.wavBytes };
    expect(encodeDecodedMonoPcmWav(samples, rate, admitted).wav.length).toBe(44 + count * 2);
    const allocation = jest.spyOn(global, 'Uint8Array');
    try {
      expect(() => encodeDecodedMonoPcmWav(Array(TTS_LIMITS.pcmSamples + 1).fill(2), rate, admitted)).toThrow('audio_limit');
      expect(() => encodeDecodedMonoPcmWav([...samples, 2], rate, admitted)).toThrow('audio_limit');
      expect(() => encodeDecodedMonoPcmWav(samples, rate, { ...admitted, maxBytes: 44 + count * 2 - 1 })).toThrow('audio_limit');
      expect(allocation).not.toHaveBeenCalled();
    } finally { allocation.mockRestore(); }
  });

  it('retains malformed-limits rejection for native decoding', () => {
    for (const invalid of [
      { ...limits, maxSamples: 0 }, { ...limits, maxSamples: 1.5 },
      { ...limits, maxDurationSeconds: Infinity }, { ...limits, maxDurationSeconds: 0 },
      { ...limits, maxBytes: 43 }, { ...limits, maxBytes: NaN },
    ]) expect(() => encodeDecodedMonoPcmWav([2], 24_000, invalid)).toThrow('invalid_limits');
  });
});
