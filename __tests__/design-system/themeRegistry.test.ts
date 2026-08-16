import {
  DEFAULT_THEME_ID,
  getThemeDefinition,
  getThemeMetadata,
  isThemeId,
  resolveTheme,
  resolveThemeDefinition,
  themeDefinitions,
  type ThemeDefinition,
} from '../../src/utils/themeTokens';
import { deepFreeze } from '../../src/design-system/themes/immutable';

describe('theme registry', () => {
  it('is the ordered, unique source of visual theme ids and metadata', () => {
    const ids = themeDefinitions.map((definition) => definition.id);

    expect(ids).toEqual(['default', 'glass']);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(DEFAULT_THEME_ID);
    expect(getThemeMetadata().map((metadata) => metadata.id)).toEqual(ids);
    expect(getThemeMetadata()).toBe(getThemeMetadata());
    expect(Object.isFrozen(themeDefinitions)).toBe(true);
    expect(Object.isFrozen(getThemeMetadata())).toBe(true);

    for (const definition of themeDefinitions) {
      expect(Object.isFrozen(definition)).toBe(true);
      expect(Object.isFrozen(definition.modes.light.colors)).toBe(true);
      expect(Object.isFrozen(definition.modes.dark.appearance)).toBe(true);
      expect(definition.modes.light).toBeDefined();
      expect(definition.modes.dark).toBeDefined();
      expect(definition.preview).toEqual(expect.objectContaining({
        canvas: expect.any(String),
        surface: expect.any(String),
        accent: expect.any(String),
        materialHint: expect.any(String),
      }));
    }
  });

  it('rejects unknown and prototype-like persisted values without dynamic lookup', () => {
    expect(isThemeId('default')).toBe(true);
    expect(isThemeId('glass')).toBe(true);
    expect(isThemeId('__proto__')).toBe(false);
    expect(isThemeId(null)).toBe(false);
    expect(isThemeId([])).toBe(false);
    expect(isThemeId({ id: 'glass' })).toBe(false);
    expect(getThemeDefinition('__proto__').id).toBe(DEFAULT_THEME_ID);
    expect(resolveTheme('future-theme', 'dark').id).toBe(DEFAULT_THEME_ID);
  });

  it('deep-freezes descendants even when their parent was already frozen', () => {
    const child = { value: 'stable' };
    const parent = Object.freeze({ child });

    deepFreeze(parent);

    expect(Object.isFrozen(parent)).toBe(true);
    expect(Object.isFrozen(child)).toBe(true);
  });

  it('resolves colors, compatibility appearance and navigation from one definition', () => {
    const definition = getThemeDefinition('glass');
    const resolved = resolveTheme('glass', 'dark');

    expect(resolved.colors).toBe(definition.modes.dark.colors);
    expect(resolved.appearance).toBe(definition.modes.dark.appearance);
    expect(resolved.navigationTheme.colors.background).toBe(resolved.colors.background);
    expect(resolved.navigationTheme.colors.card).toBe(resolved.colors.surface);
    expect(resolved.metadata.id).toBe(resolved.id);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.colors)).toBe(true);
    expect(Object.isFrozen(resolved.appearance.classNames)).toBe(true);
    expect(Object.isFrozen(resolved.navigationTheme.colors)).toBe(true);
  });

  it('resolves a synthetic future theme without changing generic resolver code', () => {
    const base = getThemeDefinition('default');
    const paperTheme = {
      ...base,
      id: 'paper',
      labelKey: 'settings.themeStylePaper',
      preview: {
        ...base.preview,
        canvas: '#f5f0e6',
      },
      modes: {
        light: {
          ...base.modes.light,
          appearance: { ...base.modes.light.appearance, id: 'paper' },
        },
        dark: {
          ...base.modes.dark,
          appearance: { ...base.modes.dark.appearance, id: 'paper' },
        },
      },
    } as const satisfies ThemeDefinition<'paper'>;

    const resolved = resolveThemeDefinition(paperTheme, 'light');

    expect(resolved.id).toBe('paper');
    expect(resolved.appearance.id).toBe('paper');
    expect(resolved.metadata.labelKey).toBe('settings.themeStylePaper');
    expect(resolved.metadata.preview.canvas).toBe('#f5f0e6');
    expect(resolved.navigationTheme.colors.background).toBe(paperTheme.modes.light.colors.background);
  });
});
