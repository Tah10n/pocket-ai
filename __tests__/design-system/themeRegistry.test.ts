import {
  DEFAULT_THEME_ID,
  getThemeDefinition,
  getThemeMetadata,
  isThemeId,
  resolveTheme,
  resolveThemeDefinition,
  semanticColorTokens,
  themeDefinitions,
  type ThemeDefinition,
  withAlpha,
} from '../../src/utils/themeTokens';
import { deepFreeze } from '../../src/design-system/themes/immutable';
import { resolveThemeForeground } from '../../src/design-system/themes/foreground';

describe('theme registry', () => {
  it.each(['default', 'glass'] as const)('keeps %s status foregrounds distinct from paint colors', (themeId) => {
    expect(resolveTheme(themeId, 'light').colors).toMatchObject({
      textToneNeutral: semanticColorTokens.typography[700],
      textToneAccent: semanticColorTokens.primary[700],
      textStatusAccent: semanticColorTokens.primary[600],
      textStatusWarning: semanticColorTokens.warning[700],
      textInfo: semanticColorTokens.info[700],
      textSuccess: semanticColorTokens.success[700],
      textWarning: semanticColorTokens.warning[800],
      textDanger: semanticColorTokens.error[800],
    });
    expect(resolveTheme(themeId, 'dark').colors).toMatchObject({
      textToneNeutral: semanticColorTokens.typography[200],
      textToneAccent: semanticColorTokens.primary[200],
      textStatusAccent: semanticColorTokens.primary[300],
      textStatusWarning: semanticColorTokens.warning[200],
      textInfo: semanticColorTokens.info[200],
      textSuccess: semanticColorTokens.success[200],
      textWarning: semanticColorTokens.warning[100],
      textDanger: semanticColorTokens.error[200],
    });
  });

  it('keeps hero decoration paints owned by each theme and mode', () => {
    expect(resolveTheme('default', 'light').colors).toMatchObject({
      heroImageOverlay: withAlpha(semanticColorTokens.primary[500], 0.15),
      heroImageScrim: withAlpha(semanticColorTokens.background[50], 0.6),
    });
    expect(resolveTheme('default', 'dark').colors).toMatchObject({
      heroImageOverlay: withAlpha(semanticColorTokens.primary[500], 0.15),
      heroImageScrim: withAlpha(semanticColorTokens.background[900], 0.7),
    });
    expect(resolveTheme('glass', 'light').colors).toMatchObject({
      heroImageOverlay: withAlpha(semanticColorTokens.primary[500], 0.3),
      heroImageScrim: withAlpha(semanticColorTokens.background[50], 0.5),
    });
    expect(resolveTheme('glass', 'dark').colors).toMatchObject({
      heroImageOverlay: withAlpha(semanticColorTokens.primary[500], 0.18),
      heroImageScrim: withAlpha(semanticColorTokens.background[950], 0.55),
    });
  });

  it('keeps shared dividers visible for default and absent for translucent themes', () => {
    expect(resolveTheme('default', 'light').colors.divider).toBe(semanticColorTokens.outline[200]);
    expect(resolveTheme('default', 'dark').colors.divider).toBe(semanticColorTokens.outline[800]);
    expect(resolveTheme('glass', 'light').colors.divider).toBe('transparent');
    expect(resolveTheme('glass', 'dark').colors.divider).toBe('transparent');
  });

  it('keeps dark Glass dense surfaces darker than their light-mode counterparts', () => {
    expect(resolveTheme('glass', 'dark').colors).toMatchObject({
      surface: withAlpha(semanticColorTokens.background[0], 0.12),
      surfaceMuted: withAlpha(semanticColorTokens.background[0], 0.1),
      surfaceElevated: withAlpha(semanticColorTokens.background[0], 0.15),
      inputBackground: withAlpha(semanticColorTokens.background[0], 0.12),
      cardBackground: withAlpha(semanticColorTokens.background[0], 0.14),
    });
    expect(resolveTheme('glass', 'light').colors).toMatchObject({
      surface: withAlpha(semanticColorTokens.background[50], 0.3),
      surfaceMuted: withAlpha(semanticColorTokens.background[50], 0.24),
      surfaceElevated: withAlpha(semanticColorTokens.background[50], 0.34),
      inputBackground: withAlpha(semanticColorTokens.background[50], 0.26),
      cardBackground: withAlpha(semanticColorTokens.background[50], 0.3),
    });
  });

  it('keeps thumbnail backgrounds theme-owned', () => {
    expect(resolveTheme('default', 'light').colors.thumbnailBackground).toBe(semanticColorTokens.background[200]);
    expect(resolveTheme('default', 'dark').colors.thumbnailBackground).toBe(semanticColorTokens.background[800]);
    expect(resolveTheme('glass', 'light').colors.thumbnailBackground).toBe(withAlpha(semanticColorTokens.background[0], 0.15));
    expect(resolveTheme('glass', 'dark').colors.thumbnailBackground).toBe(withAlpha(semanticColorTokens.background[0], 0.1));
  });

  it('keeps plain progress paints theme-owned across modes', () => {
    expect(resolveTheme('default', 'light').colors.progressTrackByTone).toMatchObject({
      neutral: semanticColorTokens.background[200],
      primary: semanticColorTokens.primary[200],
    });
    expect(resolveTheme('default', 'dark').colors).toMatchObject({
      progressTrackByTone: {
        neutral: semanticColorTokens.background[800],
        primary: semanticColorTokens.typography[800],
      },
      progressFillByTone: {
        neutral: semanticColorTokens.typography[300],
        primary: semanticColorTokens.primary[500],
      },
    });
    expect(resolveTheme('glass', 'light').colors.progressTrackByTone).toMatchObject({
      neutral: withAlpha(semanticColorTokens.background[200], 0.7),
      primary: withAlpha(semanticColorTokens.primary[500], 0.15),
    });
    expect(resolveTheme('glass', 'dark').colors.progressTrackByTone).toMatchObject({
      neutral: withAlpha(semanticColorTokens.background[0], 0.7),
      primary: withAlpha(semanticColorTokens.primary[500], 0.15),
    });
  });

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
      expect(Object.isFrozen(definition.modes.light.materials)).toBe(true);
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

  it('resolves colors, materials and navigation from one definition', () => {
    const definition = getThemeDefinition('glass');
    const resolved = resolveTheme('glass', 'dark');

    expect(resolved.colors).toBe(definition.modes.dark.colors);
    expect(resolved.navigationTheme.colors.background).toBe(resolved.colors.background);
    expect(resolved.navigationTheme.colors.card).toBe(resolved.colors.surface);
    expect(resolved.metadata.id).toBe(resolved.id);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.colors)).toBe(true);
    expect(Object.isFrozen(resolved.materials)).toBe(true);
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
          colors: { ...base.modes.light.colors, text: '#332d24' },
        },
        dark: {
          ...base.modes.dark,
          colors: { ...base.modes.dark.colors, text: '#f5f0e6' },
        },
      },
    } as const satisfies ThemeDefinition<'paper'>;

    const resolved = resolveThemeDefinition(paperTheme, 'light');

    expect(resolved.id).toBe('paper');
    expect(resolved.colors.text).toBe('#332d24');
    expect(resolveThemeForeground(resolved.colors, 'primary')).toBe('#332d24');
    expect(resolved.metadata.labelKey).toBe('settings.themeStylePaper');
    expect(resolved.metadata.preview.canvas).toBe('#f5f0e6');
    expect(resolved.navigationTheme.colors.background).toBe(paperTheme.modes.light.colors.background);
  });
});
