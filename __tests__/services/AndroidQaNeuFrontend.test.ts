import { resolveAndroidQaNeuFrontend } from '../../src/services/AndroidQaNeuFrontend';

it('admits ordinary requests without any override', () => {
  expect(resolveAndroidQaNeuFrontend(undefined, 'any', 'Any target.', 'en')).toBeUndefined();
});
it.each(['neu-canonical-frontend-v1', 'neu-canonical-reference-v1', 'neu-canonical-target-v1', null, {}, 'unknown'])(
  'permanently rejects retired diagnostic selector %p', selector => {
    expect(() => resolveAndroidQaNeuFrontend(selector, 'neutts-nano-q4_k_m-neucodec-q8_0',
      'The quiet river flows beside the old bridge.', 'en', { kind: 'builtin', voice: 'jo' }))
      .toThrow(expect.objectContaining({ code: 'prerequisite_missing' }));
  });
