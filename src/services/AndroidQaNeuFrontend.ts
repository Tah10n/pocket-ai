import fixture from '../../docs/validation/llama-rn-stage7/neu-canonical-frontend-diagnostic.json';
import { TtsError, type TtsVoiceSelection } from '../types/tts';
import { isAndroidQaDocumentModelBootstrapEnabled } from './AndroidQaDocumentModelBootstrap';
import { getAppCacheRootDir } from './FileSystemSetup';

export type AndroidQaNeuFrontend = 'neu-canonical-frontend-v1' | 'neu-canonical-reference-v1' | 'neu-canonical-target-v1';
/** Hash of the exact public fixture bytes, verified by the provenance regression. */
export const ANDROID_QA_NEU_FRONTEND_SHA256 = '94017f55d9679de62837621afd7e9367660708e34cf9d4d9e1435fd5cbb97e58';
export const ANDROID_QA_NEU_FRONTEND_IDENTITY = `diagnostic:${fixture.id}:${ANDROID_QA_NEU_FRONTEND_SHA256}`;
const canonical = Object.freeze({ ...fixture });
const variant = (selector: AndroidQaNeuFrontend, canonicalReference: boolean, canonicalTarget: boolean) => Object.freeze({
  ...canonical, selector, canonicalReference, canonicalTarget,
  executionIdentity: `diagnostic:${selector}:${ANDROID_QA_NEU_FRONTEND_SHA256}`,
});
const variants = Object.freeze({
  'neu-canonical-frontend-v1': variant('neu-canonical-frontend-v1', true, true),
  'neu-canonical-reference-v1': variant('neu-canonical-reference-v1', true, false),
  'neu-canonical-target-v1': variant('neu-canonical-target-v1', false, true),
});

/** Closed fixed-input experiment; never admits arbitrary prompts or a production fallback. */
export function resolveAndroidQaNeuFrontend(selector: unknown, profileId: string, text: string,
  language: string, voice?: TtsVoiceSelection): typeof variants[AndroidQaNeuFrontend] | undefined {
  if (selector === undefined) return undefined;
  const selected = typeof selector === 'string' && Object.prototype.hasOwnProperty.call(variants, selector)
    ? variants[selector as AndroidQaNeuFrontend] : undefined;
  if (!selected || !isAndroidQaDocumentModelBootstrapEnabled()
    || !/\.qa\/cache\/$/u.test(getAppCacheRootDir() ?? '') || profileId !== canonical.profileId
    || text !== canonical.targetText || language !== 'en' || voice?.kind !== 'builtin' || voice.voice !== 'jo') {
    throw new TtsError('prerequisite_missing');
  }
  return selected;
}
