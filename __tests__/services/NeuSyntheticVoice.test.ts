import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { getNeuSyntheticVoice, NEU_SYNTHETIC_VOICE_ID, NEU_SYNTHETIC_VOICE_SHA256 } from '../../src/services/NeuSyntheticVoice';
import { TTS_EXECUTION_PROFILES } from '../../src/services/TtsExecutionProfiles';

it('locks the own generated reference bytes and offers no Jo/default aliases', () => {
  const bytes = readFileSync(resolve(__dirname, '../../assets/tts/pocket-synthetic-en-v1.json'));
  expect(bytes.includes(13)).toBe(false);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(NEU_SYNTHETIC_VOICE_SHA256);
  expect(TTS_EXECUTION_PROFILES.find(p => p.family === 'neutts')?.builtinVoices).toEqual([NEU_SYNTHETIC_VOICE_ID]);
  const value = getNeuSyntheticVoice(NEU_SYNTHETIC_VOICE_ID)!;
  expect(value).not.toHaveProperty('ref_phones');
  expect(value.ref_text).toBe('The quiet river flows beside the old bridge.');
  expect(value.ref_codes).toHaveLength(166);
  expect(value.ref_codes.every(n => Number.isSafeInteger(n) && n >= 0 && n < 65536)).toBe(true);
  for (const retired of ['jo', 'default', 'dave', 'greta', 'juliette']) expect(getNeuSyntheticVoice(retired)).toBeUndefined();
});
it('returns independently owned code arrays so caller mutation cannot change the next reference', () => {
  const first = getNeuSyntheticVoice(NEU_SYNTHETIC_VOICE_ID)!;
  const original = [...first.ref_codes]; first.ref_codes[0] = -1; first.ref_text = 'mutated';
  expect(getNeuSyntheticVoice(NEU_SYNTHETIC_VOICE_ID)).toEqual({ ref_text: 'The quiet river flows beside the old bridge.', ref_codes: original });
});
