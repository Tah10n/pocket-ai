import { toIPA } from 'phonemize';
import { phonemizeSpeech, LOCAL_PHONEMIZER_DEADLINE_MS } from '../../src/services/TtsPhonemizer';

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
  await expect(phonemizeSpeech('Hello.', 'en-us', () => undefined)).rejects.toMatchObject({ code: 'phonemizer_failed' });
  expect(finished).toBe(true); now.mockRestore();
});
