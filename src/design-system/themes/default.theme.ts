import type { ThemeDefinition } from './contract';
import {
  createDefaultThemeColors,
  semanticColorTokens,
  withAlpha,
} from './legacyTheme';
import {
  createSolidThemeMaterialRecipes,
  type SolidThemeMaterialOverrides,
} from '../materials/presets';

const lightColors = createDefaultThemeColors('light');
const darkColors = createDefaultThemeColors('dark');

function createDefaultMaterialOverrides(
  mode: 'light' | 'dark',
): SolidThemeMaterialOverrides {
  const isDark = mode === 'dark';
  const { background, error, info, outline, primary, success, warning } = semanticColorTokens;

  const semanticFrame = (
    palette: Readonly<Record<string, string>>,
  ) => ({
    fillColor: withAlpha(palette[500], 0.1),
    rimColor: withAlpha(palette[isDark ? 400 : 500], isDark ? 0.25 : 0.2),
  });

  return {
    header: {
      fillColor: isDark ? withAlpha(background[950], 0.9) : withAlpha(background[0], 0.94),
      rimColor: isDark ? outline[800] : outline[200],
    },
    raised: {
      fillColor: isDark ? withAlpha(background[900], 0.6) : background[50],
      rimColor: isDark ? outline[800] : outline[200],
    },
    inset: {
      fillColor: isDark ? withAlpha(background[950], 0.7) : background[0],
      rimColor: isDark ? outline[700] : outline[200],
    },
    message: {
      fillColor: isDark ? withAlpha(background[900], 0.7) : background[50],
      rimColor: isDark ? outline[800] : outline[200],
    },
    messageThought: {
      fillColor: withAlpha(isDark ? background[950] : background[0], isDark ? 0.4 : 0.8),
      rimColor: withAlpha(isDark ? outline[700] : outline[200], isDark ? 0.7 : 0.8),
    },
    messageAttachment: {
      fillColor: 'transparent',
      rimColor: 'transparent',
      rimWidth: 0,
    },
    messageError: {
      fillColor: withAlpha(error[500], isDark ? 0.15 : 0.1),
      rimColor: 'transparent',
      rimWidth: 0,
    },
    composerMode: {
      fillColor: withAlpha(primary[500], 0.05),
      rimColor: withAlpha(primary[500], 0.15),
    },
    messageTones: {
      primary: {
        fillColor: primary[600],
        rimColor: primary[600],
        rimWidth: 0,
      },
    },
    selectedControlTones: {
      primary: { fillColor: primary[600], rimColor: primary[600], rimWidth: 0 },
      success: { fillColor: success[700], rimColor: success[700], rimWidth: 0 },
      error: { fillColor: error[600], rimColor: error[600], rimWidth: 0 },
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
      materials: createSolidThemeMaterialRecipes(
        lightColors,
        createDefaultMaterialOverrides('light'),
      ),
    },
    dark: {
      colors: darkColors,
      materials: createSolidThemeMaterialRecipes(
        darkColors,
        createDefaultMaterialOverrides('dark'),
      ),
    },
  },
  components: {
    screen: { backgroundDecoration: 'plain' },
    tabBar: { presentation: 'attached' },
    header: { presentation: 'attached' },
    chat: {
      composerPresentation: 'inline',
      userBubbleTone: 'primary',
    },
  },
} as const satisfies ThemeDefinition<'default'>;
