import { ttsNow } from '../utils/ttsLatency';
import { TTS_LIMITS, boundedTtsLatencyMs, TtsError, type TtsObservation, type PhonemizerFailureReason } from '../types/tts';
import { split, restore } from './TtsPhonemizerFrontend';

export const LOCAL_PHONEMIZER_IDENTITY = 'espeak-ng/69bfd1efde0236654ccc117a28d04aef27673a30:en-us:bootphon-3.3.0:data-0bb3d67bab0295f4749d09a504bdad7fc17bc92b77cd0275a1e58dc5bfd33dd8:v1';
export const LOCAL_PHONEMIZER_MODULE_INIT_DEADLINE_MS = 2000;
export const LOCAL_PHONEMIZER_DEADLINE_MS = 1000;
interface NativeResult { raw: string[]; initMs: number; conversionMs: number; calls: number; offThread: boolean; error?: string }
interface NativePhonemizer {
  initialize(): Promise<NativeResult>;
  convert(requestId: string, chunks: string[]): Promise<NativeResult>;
  cancel(requestId: string): Promise<void>;
}
let busy = false;
let nextRequest = 0;

/** Lazy, offline English frontend. The native promise settles only after the actual C call drains. */
export async function phonemizeSpeech(
  text: string, language: string, assertCurrent: () => void,
  observe?: (event: TtsObservation) => void, signal?: AbortSignal,
): Promise<string> {
  const check = () => { assertCurrent(); if (signal?.aborted) throw new TtsError('cancelled'); };
  check();
  if (language !== 'en-us') throw new TtsError('language_unsupported');
  if (!text.trim() || text.length > TTS_LIMITS.textCharacters) throw new TtsError('input_too_large');
  if (/[^\p{Script=Latin}\p{Number}\p{Punctuation}\p{Separator}\p{Mark}\s$+<=>^|~`]/u.test(text)) throw new TtsError('language_unsupported');
  let parts: ReturnType<typeof split>;
  try { parts = split(text); } catch { throw new TtsError('input_too_large'); }
  await Promise.resolve(); check();
  if (busy) throw new TtsError('busy');
  if (!parts.chunks.length) return restore([], parts);
  busy = true;
  const started = Date.now();
  let moduleInitMs: number | undefined;
  const failure = (reason: PhonemizerFailureReason) => new TtsError('phonemizer_failed', {
    reason, elapsedMs: boundedTtsLatencyMs(Date.now() - started), moduleInitMs,
  });
  const observed = async <T>(operation: 'phonemizer_module_init' | 'phonemizer_conversion', call: () => Promise<T>): Promise<T> => {
    const at = ttsNow();
    const emit = (phase: 'started' | 'settled') => { try {
      observe?.({ operation, phase, ...(phase === 'settled' ? { elapsedMs: boundedTtsLatencyMs(ttsNow() - at) } : {}) });
    } catch { /* Observations never affect ownership. */ } };
    emit('started'); try { return await call(); } finally { emit('settled'); }
  };
  const requestId = `tts_${++nextRequest}`;
  let native: NativePhonemizer | undefined;
  const cancel = () => { try { void native?.cancel(requestId).catch(() => undefined); } catch { /* Still await actual drain below. */ } };
  try {
    let initialized: NativeResult;
    try {
      initialized = await observed('phonemizer_module_init', async () => {
        // Importing UI does not resolve this module, stage dictionaries or create native work.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        native = require('expo-modules-core').requireNativeModule('PocketPhonemizer') as NativePhonemizer;
        return await native.initialize();
      });
    } catch { moduleInitMs = boundedTtsLatencyMs(Date.now() - started); check(); throw failure('module_init'); }
    moduleInitMs = boundedTtsLatencyMs(Date.now() - started);
    check();
    if (!initialized || initialized.error) throw failure('module_init');
    if (moduleInitMs === undefined || moduleInitMs > LOCAL_PHONEMIZER_MODULE_INIT_DEADLINE_MS || initialized.initMs > LOCAL_PHONEMIZER_MODULE_INIT_DEADLINE_MS) throw failure('deadline');
    signal?.addEventListener('abort', cancel);
    check();
    let output: NativeResult;
    const conversionAt = Date.now();
    try { output = await observed('phonemizer_conversion', () => native!.convert(requestId, parts.chunks)); }
    catch { check(); throw failure('conversion'); }
    // Cancellation never races a timer against native ownership or releases TTS early.
    check();
    if (!output || output.error) {
      if (output?.error === 'busy') throw new TtsError('busy');
      throw failure(output?.error === 'deadline' || output?.error === 'init_deadline' ? 'deadline' : 'conversion');
    }
    if (Date.now() - conversionAt > LOCAL_PHONEMIZER_DEADLINE_MS || output.conversionMs > LOCAL_PHONEMIZER_DEADLINE_MS) throw failure('deadline');
    if (!Array.isArray(output.raw) || output.raw.length !== parts.chunks.length || !output.raw.some(value => typeof value === 'string' && value.trim())
      || output.raw.some(value => typeof value !== 'string' || value.length > 4096 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value))) throw failure('invalid_output');
    try { return restore(output.raw, parts); } catch { throw failure('invalid_output'); }
  } finally { signal?.removeEventListener('abort', cancel); busy = false; }
}
