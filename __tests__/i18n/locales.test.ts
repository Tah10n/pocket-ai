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
    'common.errors.engineRecoveryRequired',
    'storageRecovery.privateUnavailableMessage',
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

  it('keeps engine recovery copy pointing at automatic recovery and app restart, not model reload', () => {
    const enValue = String(getNestedValue(en, 'common.errors.engineRecoveryRequired'));
    const ruValue = String(getNestedValue(ru, 'common.errors.engineRecoveryRequired'));

    expect(enValue.toLowerCase()).toContain('automatic recovery');
    expect(enValue.toLowerCase()).toContain('restart pocket ai');
    expect(enValue.toLowerCase()).not.toContain('reload the model');

    expect(ruValue.toLowerCase()).toContain('автоматического восстановления');
    expect(ruValue.toLowerCase()).toContain('перезапустите pocket ai');
    expect(ruValue.toLowerCase()).not.toContain('перезагрузите модель');
  });
});
