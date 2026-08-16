import type { ThemeDefinition } from './contract';
import {
  createDefaultThemeAppearance,
  createDefaultThemeColors,
  semanticColorTokens,
  withAlpha,
} from './legacyTheme';
import {
  createSolidThemeMaterialRecipes,
  type SolidContentMaterialOverrides,
} from '../materials/presets';

const lightColors = createDefaultThemeColors('light');
const darkColors = createDefaultThemeColors('dark');

function createDefaultContentMaterialOverrides(
  mode: 'light' | 'dark',
): SolidContentMaterialOverrides {
  const isDark = mode === 'dark';
  const { background, error, info, outline, primary, success, warning } = semanticColorTokens;

  const semanticFrame = (
    palette: Readonly<Record<string, string>>,
  ) => ({
    fillColor: withAlpha(palette[500], 0.1),
    rimColor: withAlpha(palette[isDark ? 400 : 500], isDark ? 0.25 : 0.2),
  });

  return {
    raised: {
      fillColor: isDark ? withAlpha(background[900], 0.6) : background[50],
      rimColor: isDark ? outline[800] : outline[200],
    },
    inset: {
      fillColor: isDark ? withAlpha(background[950], 0.7) : background[0],
      rimColor: isDark ? outline[700] : outline[200],
    },
    tones: {
      primary: semanticFrame(primary),
      accent: semanticFrame(primary),
      info: semanticFrame(info),
      success: semanticFrame(success),
      warning: {
        fillColor: isDark ? withAlpha(warning[950], 0.35) : warning[50],
        rimColor: isDark ? warning[800] : warning[300],
      },
      error: semanticFrame(error),
    },
  };
}

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
      materials: createSolidThemeMaterialRecipes(
        lightColors,
        createDefaultContentMaterialOverrides('light'),
      ),
    },
    dark: {
      colors: darkColors,
      appearance: createDefaultThemeAppearance('dark'),
      materials: createSolidThemeMaterialRecipes(
        darkColors,
        createDefaultContentMaterialOverrides('dark'),
      ),
    },
  },
  components: {
    tabBar: { presentation: 'attached' },
    header: { presentation: 'attached' },
  },
} as const satisfies ThemeDefinition<'default'>;
