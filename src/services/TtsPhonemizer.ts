import { TTS_LIMITS, TtsError, type PhonemizerFailureReason } from '../types/tts';

export const LOCAL_PHONEMIZER_IDENTITY = 'phonemize/2.0.1:en-us:ipa:preserve-stress-punctuation:v1';
const MAX_PHONE_CHARACTERS = 4096;
export const LOCAL_PHONEMIZER_DEADLINE_MS = 1000;

/** English-only entry: packaged dictionaries/rules, no network or native installation. */
export async function phonemizeSpeech(text: string, language: string, assertCurrent: () => void): Promise<string> {
  assertCurrent();
  if (language !== 'en-us') throw new TtsError('language_unsupported');
  if (!text.trim() || text.length > TTS_LIMITS.textCharacters) throw new TtsError('input_too_large');
  // Do not silently transliterate another language into English pronunciations.
  if (/[^\p{Script=Latin}\p{Number}\p{Punctuation}\p{Separator}\p{Mark}\s$+<=>^|~`]/u.test(text)) {
    throw new TtsError('language_unsupported');
  }
  await Promise.resolve();
  assertCurrent();
  const started = Date.now();
  let moduleInitMs: number;
  const failed = (reason: PhonemizerFailureReason, elapsedMs = Date.now() - started) =>
    new TtsError('phonemizer_failed', { reason, elapsedMs, moduleInitMs });
  let local: typeof import('phonemize');
  try {
    // Lazy English entry keeps dictionary work outside ordinary chat startup.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    local = require('phonemize') as typeof import('phonemize');
  } catch {
    moduleInitMs = Date.now() - started;
    assertCurrent();
    throw failed('module_init', moduleInitMs);
  }
  moduleInitMs = Date.now() - started;
  let output: string;
  try {
    output = local.toIPA(text, { language: 'en-us', anyAscii: false });
    if (typeof output === 'string') output = output.replace(/\s+/gu, ' ').trim();
  }
  catch { assertCurrent(); throw failed('conversion'); }
  assertCurrent();
  // A synchronous G2P cannot be forcibly interrupted in Hermes. Reject late output only
  // after the actual call settles; never treat a timer as completion or a resource drain.
  const elapsedMs = Date.now() - started;
  if (elapsedMs > LOCAL_PHONEMIZER_DEADLINE_MS) throw failed('deadline', elapsedMs);
  if (typeof output !== 'string') throw failed('invalid_output', elapsedMs);
  if (!output || output.length > MAX_PHONE_CHARACTERS || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(output)) {
    throw failed('invalid_output', elapsedMs);
  }
  return output;
}
