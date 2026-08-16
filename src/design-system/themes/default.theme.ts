import type { ThemeDefinition } from './contract';
import {
  createDefaultThemeAppearance,
  createDefaultThemeColors,
} from './legacyTheme';

const lightColors = createDefaultThemeColors('light');

export const defaultTheme = {
  id: 'default',
  labelKey: 'settings.themeStyleDefault',
  descriptionKey: 'settings.themeStyleDefaultDescription',
  preview: {
    canvas: lightColors.background,
    surface: lightColors.surface,
    accent: lightColors.primary,
    materialHint: 'solid',
  },
  modes: {
    light: {
      colors: lightColors,
      appearance: createDefaultThemeAppearance('light'),
    },
    dark: {
      colors: createDefaultThemeColors('dark'),
      appearance: createDefaultThemeAppearance('dark'),
    },
  },
  components: {
    tabBar: { presentation: 'attached' },
    header: { presentation: 'attached' },
  },
} as const satisfies ThemeDefinition<'default'>;
