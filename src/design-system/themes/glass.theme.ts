import type { ThemeDefinition } from './contract';
import {
  createGlassThemeAppearance,
  createGlassThemeColors,
} from './legacyTheme';

const lightColors = createGlassThemeColors('light');

export const glassTheme = {
  id: 'glass',
  labelKey: 'settings.themeStyleGlass',
  descriptionKey: 'settings.themeStyleGlassDescription',
  preview: {
    canvas: lightColors.background,
    surface: lightColors.surface,
    accent: lightColors.primary,
    materialHint: 'translucent',
  },
  modes: {
    light: {
      colors: lightColors,
      appearance: createGlassThemeAppearance('light'),
    },
    dark: {
      colors: createGlassThemeColors('dark'),
      appearance: createGlassThemeAppearance('dark'),
    },
  },
  components: {
    tabBar: { presentation: 'floating' },
    header: { presentation: 'overlay' },
  },
} as const satisfies ThemeDefinition<'glass'>;
