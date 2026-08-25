import {
  createNavigationTheme,
  getThemeColors,
  resolveTheme,
  screenLayoutTokens,
} from '../../src/utils/themeTokens';

describe('themeTokens compatibility facade', () => {
  it('resolves default and glass colors through the registry', () => {
    expect(getThemeColors('light')).toBe(resolveTheme('default', 'light').colors);
    expect(getThemeColors('dark', 'glass')).toBe(resolveTheme('glass', 'dark').colors);
  });

  it('resolves navigation colors from the same immutable theme result', () => {
    expect(createNavigationTheme('dark', 'glass')).toStrictEqual(
      resolveTheme('glass', 'dark').navigationTheme,
    );
  });

  it('keeps inline input layout independent from visual theme materials', () => {
    expect(screenLayoutTokens.inlineInputShellClassName).toContain('bg-transparent');
    expect(screenLayoutTokens.inlineInputShellClassName).toContain('dark:bg-transparent');
    expect(screenLayoutTokens.inlineInputShellClassName).not.toContain('dark:bg-background');
  });
});
