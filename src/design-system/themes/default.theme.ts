import type { ThemeDefinition } from './contract';
import {
  createDefaultThemeAppearance,
  createDefaultThemeColors,
} from './legacyTheme';
import { createSolidThemeMaterialRecipes } from '../materials/presets';

const lightColors = createDefaultThemeColors('light');
const darkColors = createDefaultThemeColors('dark');

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
      materials: createSolidThemeMaterialRecipes(lightColors),
    },
    dark: {
      colors: darkColors,
      appearance: createDefaultThemeAppearance('dark'),
      materials: createSolidThemeMaterialRecipes(darkColors),
    },
  },
  components: {
    tabBar: { presentation: 'attached' },
    header: { presentation: 'attached' },
  },
} as const satisfies ThemeDefinition<'default'>;
