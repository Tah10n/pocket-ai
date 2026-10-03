import { encodeMonoPcmWav, TtsWavError } from '../../src/utils/ttsWav';

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
