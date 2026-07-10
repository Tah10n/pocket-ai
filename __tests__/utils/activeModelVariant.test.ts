import {
  getActiveModelVariantKeys,
  resolveActiveModelVariant,
} from '../../src/utils/activeModelVariant';

const variants = [
  {
    variantId: 'legacy',
    fileName: 'audio-q4',
    quantizationLabel: 'Q4_K_M',
    size: 1,
    chatModalities: ['text', 'vision'] as Array<'text' | 'vision'>,
  },
  {
    variantId: 'audio-q4',
    fileName: 'audio.gguf',
    quantizationLabel: 'Q4_K_M',
    size: 2,
    chatModalities: ['text', 'audio'] as Array<'text' | 'audio'>,
  },
];

describe('activeModelVariant', () => {
  it('prefers an exact active variant id over an earlier filename alias collision', () => {
    const model = { activeVariantId: 'audio-q4', variants };

    expect(resolveActiveModelVariant(model)).toBe(variants[1]);
    expect([...getActiveModelVariantKeys(model)]).toEqual(['audio-q4', 'audio.gguf']);
  });

  it('prefers an exact resolved filename over a variant-id alias collision', () => {
    const model = {
      resolvedFileName: 'audio-q4',
      variants: [variants[1], variants[0]],
    };

    expect(resolveActiveModelVariant(model)).toBe(variants[0]);
    expect([...getActiveModelVariantKeys(model)]).toEqual(['legacy', 'audio-q4']);
  });
});
