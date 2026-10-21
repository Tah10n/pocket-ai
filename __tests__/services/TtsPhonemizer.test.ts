import corpus from '../fixtures/tts/eSpeak-canonical-corpus.json';
import { split, restore, postprocess } from '../../src/services/TtsPhonemizerFrontend';
import { sanitizePhonemizerFailure, TtsError } from '../../src/types/tts';

// Independent bootphon 3.3.0/eSpeak 1.52.0.1 oracle, also matched byte-for-byte
// by the actual mobile C++ core linked to the same-source engine. This JS test
// verifies splitting/restoration, not native execution or speech quality.
it.each(corpus)('preserves the independent frontend contract: $id', fixture => {
  const state=split(fixture.text); expect(state.chunks).toEqual(fixture.chunks);
  expect(restore(fixture.raw,state)).toBe(fixture.expected);
});
it('strips generated language flags before restoring literal user parentheses',()=>{
  expect(postprocess('h_ə_l_ˈoʊ (fr)b_ɔ̃_ʒ_ˈu_ʁ (en)')).toBe('həlˈoʊ bɔ̃ʒˈuʁ  ');
});
it.each(['','x'.repeat(241),'bad\u0000input','\ud800','中文','hello\x01'])('rejects inadmissible input before splitting %s',input=>expect(()=>split(input)).toThrow());
it('sanitizes only closed reasons and consistent bounded timings',()=>{
  const safe={reason:'conversion',elapsedMs:30,moduleInitMs:10}; expect(sanitizePhonemizerFailure({...safe,input:'private',phones:'secret'})).toEqual(safe);
  for(const value of [-1,1.5,NaN,Infinity,300001,'20',null]){
    expect(sanitizePhonemizerFailure({...safe,elapsedMs:value})).toBeUndefined();
    expect(sanitizePhonemizerFailure({...safe,moduleInitMs:value})).toBeUndefined();
  }
  expect(sanitizePhonemizerFailure({...safe,moduleInitMs:31})).toBeUndefined();expect(sanitizePhonemizerFailure({...safe,reason:'file:///private'})).toBeUndefined();
  expect(new TtsError('native_failed',safe as never).phonemizerFailure).toBeUndefined();
});
