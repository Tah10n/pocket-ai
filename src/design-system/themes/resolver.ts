import { DarkTheme, DefaultTheme, type Theme } from '@react-navigation/native';
import type {
  ResolvedTheme,
  ThemeDefinition,
  ThemeMetadata,
} from './contract';
import type { ResolvedThemeMode } from './legacyTheme';
import { deepFreeze } from './immutable';
import {
  DEFAULT_THEME_ID,
  getThemeDefinition,
  type ThemeId,
} from './registry';

function createNavigationTheme(
  mode: ResolvedThemeMode,
  colors: ThemeDefinition['modes'][ResolvedThemeMode]['colors'],
): Theme {
  const baseTheme = mode === 'dark' ? DarkTheme : DefaultTheme;
  const fonts = baseTheme.fonts
    ? Object.fromEntries(
      Object.entries(baseTheme.fonts).map(([weight, font]) => [weight, { ...font }]),
    ) as Theme['fonts']
    : undefined;

  const navigationTheme = {
    ...baseTheme,
    ...(fonts ? { fonts } : {}),
    dark: mode === 'dark',
    colors: {
      ...baseTheme.colors,
      primary: colors.primary,
      background: colors.background,
      card: colors.surface,
      text: colors.text,
      border: colors.borderStrong,
      notification: colors.error,
    },
  } as Theme;

  return deepFreeze(navigationTheme);
}

export function resolveThemeDefinition<Id extends string>(
  definition: ThemeDefinition<Id>,
  mode: ResolvedThemeMode,
): ResolvedTheme<Id> {
  const modeDefinition = definition.modes[mode];
  const metadata: ThemeMetadata<Id> = {
    id: definition.id,
    labelKey: definition.labelKey,
    descriptionKey: definition.descriptionKey,
    preview: definition.preview,
  };

  return deepFreeze({
    id: definition.id,
    mode,
    metadata,
    colors: modeDefinition.colors,
    appearance: modeDefinition.appearance,
    materials: modeDefinition.materials,
    components: definition.components,
    navigationTheme: createNavigationTheme(mode, modeDefinition.colors),
  });
}

export function resolveTheme(
  themeId: unknown = DEFAULT_THEME_ID,
  mode: ResolvedThemeMode = 'light',
): ResolvedTheme<ThemeId> {
  const definition = getThemeDefinition(themeId);
  return resolveThemeDefinition(definition, mode);
}
