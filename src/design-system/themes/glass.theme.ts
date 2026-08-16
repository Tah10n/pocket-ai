import type { ThemeDefinition } from './contract';
import {
  createGlassThemeColors,
} from './legacyTheme';
import { createLiquidThemeMaterialRecipes } from '../materials/presets';

const lightColors = createGlassThemeColors('light');
const darkColors = createGlassThemeColors('dark');

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
      materials: createLiquidThemeMaterialRecipes(lightColors, 'light'),
    },
    dark: {
      colors: darkColors,
      materials: createLiquidThemeMaterialRecipes(darkColors, 'dark'),
    },
  },
  components: {
    screen: { backgroundDecoration: 'aurora' },
    tabBar: { presentation: 'floating' },
    header: { presentation: 'overlay' },
    chat: {
      composerPresentation: 'capsule',
      userBubbleTone: 'primary',
    },
  },
} as const satisfies ThemeDefinition<'glass'>;
