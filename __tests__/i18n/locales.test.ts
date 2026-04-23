const en = require('../../src/i18n/locales/en.json');
const ru = require('../../src/i18n/locales/ru.json');

function getNestedValue(source: Record<string, unknown>, path: string) {
  return path.split('.').reduce<unknown>((current, segment) => {
    if (!current || typeof current !== 'object') {
      return undefined;
    }

    return (current as Record<string, unknown>)[segment];
  }, source);
}

describe('chat locale coverage', () => {
  const requiredKeys = [
    'chat.modelSwitchedLine',
    'chat.modelSelector.title',
    'chat.modelSelector.subtitle',
    'chat.modelSelector.emptyTitle',
    'chat.modelSelector.emptyDescription',
  ];

  it.each(requiredKeys)('includes %s in both English and Russian locales', (key) => {
    expect(getNestedValue(en, key)).toEqual(expect.any(String));
    expect(getNestedValue(ru, key)).toEqual(expect.any(String));
  });

  it('keeps interpolation placeholders for the model-switch line in both locales', () => {
    expect(getNestedValue(en, 'chat.modelSwitchedLine')).toContain('{{from}}');
    expect(getNestedValue(en, 'chat.modelSwitchedLine')).toContain('{{to}}');
    expect(getNestedValue(ru, 'chat.modelSwitchedLine')).toContain('{{from}}');
    expect(getNestedValue(ru, 'chat.modelSwitchedLine')).toContain('{{to}}');
  });
});
