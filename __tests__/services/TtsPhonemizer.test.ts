import { toIPA } from 'phonemize';
import { phonemizeSpeech, LOCAL_PHONEMIZER_DEADLINE_MS } from '../../src/services/TtsPhonemizer';
import { TtsError, sanitizePhonemizerFailure } from '../../src/types/tts';

jest.mock('phonemize', () => ({ ...jest.requireActual('phonemize'), toIPA: jest.fn(jest.requireActual('phonemize').toIPA) }));
beforeEach(() => { jest.restoreAllMocks(); jest.mocked(toIPA).mockReset().mockImplementation(jest.requireActual('phonemize').toIPA); });

it('uses the actual packaged English G2P with IPA stress, word spacing and punctuation offline', async () => {
  const check = jest.fn();
  const output = await phonemizeSpeech('Hello world!', 'en-us', check);
  expect(output).toBe('həˈɫoʊ wɝɫd!');
  expect(toIPA).toHaveBeenCalledWith('Hello world!', { language: 'en-us', anyAscii: false });
  expect(check).toHaveBeenCalledTimes(3);
});
it.each([['Hello.', 'ru'], ['Привет.', 'en-us'], ['x'.repeat(241), 'en-us']])('fails unsupported or oversized text before G2P %s', async (text, language) => {
  await expect(phonemizeSpeech(text, language, () => undefined)).rejects.toThrow();
  expect(toIPA).not.toHaveBeenCalled();
});
it('checks cancellation after conversion before native can receive stale phonemes', async () => {
  let active = true;
  jest.mocked(toIPA).mockImplementation(() => { active = false; return 'həˈloʊ'; });
  await expect(phonemizeSpeech('Hello.', 'en-us', () => { if (!active) throw new Error('cancelled'); })).rejects.toThrow('cancelled');
});
it('rejects late output only after the real synchronous conversion has settled', async () => {
  const now = jest.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(LOCAL_PHONEMIZER_DEADLINE_MS + 1);
  let finished = false;
  jest.mocked(toIPA).mockImplementation(() => { finished = true; return 'həˈloʊ'; });
  await expect(phonemizeSpeech('Hello.', 'en-us', () => undefined)).rejects.toMatchObject({ code: 'phonemizer_failed',
    phonemizerFailure: { reason: 'deadline', elapsedMs: 1001, moduleInitMs: 1001 } });
  expect(finished).toBe(true); now.mockRestore();
});

it('distinguishes conversion exceptions without retaining input, IPA or the original error', async () => {
  let clock = 10;
  jest.spyOn(Date, 'now').mockImplementation(() => clock);
  jest.mocked(toIPA).mockImplementation(() => { clock = 25; throw new Error('private input/IPA file:///private'); });
  const error = await phonemizeSpeech('Hello.', 'en-us', () => undefined).catch(value => value);
  expect(error).toMatchObject({ code: 'phonemizer_failed', message: 'phonemizer_failed',
    phonemizerFailure: { reason: 'conversion', elapsedMs: 15, moduleInitMs: 0 } });
  expect(JSON.stringify(error)).not.toMatch(/private|IPA|file:\/\/|cause|input/u);
});
it.each(['', 'x'.repeat(4097), 'invalid\u0000phones', 12])('classifies invalid settled output (%s)', async output => {
  jest.spyOn(Date, 'now').mockReturnValue(10);
  jest.mocked(toIPA).mockReturnValue(output as never);
  await expect(phonemizeSpeech('Hello.', 'en-us', () => undefined)).rejects.toMatchObject({ code: 'phonemizer_failed',
    phonemizerFailure: { reason: 'invalid_output', elapsedMs: 0, moduleInitMs: 0 } });
});
it('preserves the exact cancellation error when a conversion also throws', async () => {
  const cancelled = Object.freeze(new TtsError('cancelled'));
  let active = true;
  jest.mocked(toIPA).mockImplementation(() => { active = false; throw new Error('private conversion'); });
  await expect(phonemizeSpeech('Hello.', 'en-us', () => { if (!active) throw cancelled; })).rejects.toBe(cancelled);
});
it.each(['throws', 'deadline'] as const)('measures actual lazy module evaluation separately (%s)', async mode => {
  let clock = 0;
  const evaluation = jest.fn(() => {
    clock = mode === 'throws' ? 35 : LOCAL_PHONEMIZER_DEADLINE_MS + 1;
    if (mode === 'throws') throw new Error('private module payload');
    return jest.requireActual('phonemize');
  });
  jest.spyOn(Date, 'now').mockImplementation(() => clock);
  // An already evaluated mock would hide the lazy require boundary being tested.
  jest.resetModules();
  await jest.isolateModulesAsync(async () => {
    jest.doMock('phonemize', evaluation);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const isolated = require('../../src/services/TtsPhonemizer') as typeof import('../../src/services/TtsPhonemizer');
    expect(evaluation).not.toHaveBeenCalled();
    const error = await isolated.phonemizeSpeech('Hello.', 'en-us', () => undefined).catch(value => value);
    expect(evaluation).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({ code: 'phonemizer_failed', message: 'phonemizer_failed', phonemizerFailure: {
      reason: mode === 'throws' ? 'module_init' : 'deadline', elapsedMs: clock, moduleInitMs: clock } });
    expect(JSON.stringify(error)).not.toContain('private');
  });
});
it('sanitizes only closed reasons and consistent bounded integer timings', () => {
  const safe = { reason: 'conversion', elapsedMs: 30, moduleInitMs: 10 };
  expect(sanitizePhonemizerFailure({ ...safe, input: 'private', phones: 'private', native: 'private' })).toEqual(safe);
  for (const value of [-1, 1.5, NaN, Infinity, 300001, '20', null]) {
    expect(sanitizePhonemizerFailure({ ...safe, elapsedMs: value })).toBeUndefined();
    expect(sanitizePhonemizerFailure({ ...safe, moduleInitMs: value })).toBeUndefined();
  }
  expect(sanitizePhonemizerFailure({ ...safe, moduleInitMs: 31 })).toBeUndefined();
  expect(sanitizePhonemizerFailure({ ...safe, reason: 'file:///private' })).toBeUndefined();
  expect(new TtsError('native_failed', safe as never).phonemizerFailure).toBeUndefined();
});
