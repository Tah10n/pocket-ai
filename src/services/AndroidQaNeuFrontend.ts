import { TtsError, type TtsVoiceSelection } from '../types/tts';

/** Retained only to reject stale diagnostic requests; no fixture is bundled. */
export type AndroidQaNeuFrontend = 'neu-canonical-frontend-v1' | 'neu-canonical-reference-v1' | 'neu-canonical-target-v1';
export function resolveAndroidQaNeuFrontend(selector: unknown, _profileId: string, _text: string,
  _language: string, _voice?: TtsVoiceSelection): undefined {
  if (selector !== undefined) throw new TtsError('prerequisite_missing');
  return undefined;
}
