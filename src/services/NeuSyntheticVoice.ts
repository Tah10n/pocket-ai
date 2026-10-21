import fixture from '../../assets/tts/pocket-synthetic-en-v1.json';

export const NEU_SYNTHETIC_VOICE_ID = 'pocket-synthetic-en-v1';
export const NEU_SYNTHETIC_VOICE_SHA256 = '2d80b34675fb03b5a5f2af86738d0549cce00bd08a165fc6badc5a9ba88473b0';
const reference = Object.freeze({ text: fixture.ref_text, codes: Object.freeze([...fixture.ref_codes]) });

/** Own synthetic reference; callers must phonemize its plain transcript at runtime. */
export function getNeuSyntheticVoice(name: string): { ref_text: string; ref_codes: number[] } | undefined {
  if (name !== NEU_SYNTHETIC_VOICE_ID) return undefined;
  return { ref_text: reference.text, ref_codes: [...reference.codes] };
}
