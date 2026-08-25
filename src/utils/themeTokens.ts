import type { ResolvedThemeMode } from '../design-system/themes/legacyTheme';
import {
  DEFAULT_THEME_ID,
  type ThemeId,
} from '../design-system/themes/registry';
import { resolveTheme } from '../design-system/themes/resolver';

export * from '../design-system/themes/legacyTheme';
export {
  DEFAULT_THEME_ID,
  getThemeDefinition,
  getThemeMetadata,
  isThemeId,
  themeDefinitions,
  type ThemeId,
} from '../design-system/themes/registry';
export {
  resolveTheme,
  resolveThemeDefinition,
} from '../design-system/themes/resolver';
export type {
  ResolvedTheme,
  ThemeComponentPresentation,
  ThemeDefinition,
  ThemeMetadata,
  ThemeModeDefinition,
  ThemePreviewTokens,
} from '../design-system/themes/contract';

export function getThemeColors(
  mode: ResolvedThemeMode,
  themeId: ThemeId = DEFAULT_THEME_ID,
) {
  return resolveTheme(themeId, mode).colors;
}

export function createNavigationTheme(
  mode: ResolvedThemeMode,
  themeId: ThemeId = DEFAULT_THEME_ID,
) {
  return resolveTheme(themeId, mode).navigationTheme;
}
