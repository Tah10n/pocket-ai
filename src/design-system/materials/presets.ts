import type {
  BlurMaterialRecipe,
  DenseMaterialRecipe,
  MaterialColorMode,
  MaterialPalette,
  MaterialPaint,
  MaterialRecipeDefinition,
  MaterialRendererRecipe,
  MaterialRim,
  MaterialShadow,
  MaterialToneRecipes,
  NativeLiquidGlassMaterialRecipe,
  ThemeMaterialRecipes,
} from './contract';

const NO_SHADOW: MaterialShadow = {
  color: '#000000',
  opacity: 0,
  radius: 0,
  offsetX: 0,
  offsetY: 0,
  elevation: 0,
};

function paint(color: string, opacity = 1): MaterialPaint {
  return { color, opacity };
}

function rim(color: string, opacity = 1, width = 1): MaterialRim {
  return { color, opacity, width };
}

function shadow(color: string, opacity: number, radius: number, offsetY: number, elevation: number): MaterialShadow {
  return { color, opacity, radius, offsetX: 0, offsetY, elevation };
}

function denseRecipe(
  renderer: DenseMaterialRecipe['renderer'],
  fillColor: string,
  rimColor: string,
  interactionSupport: DenseMaterialRecipe['interactionSupport'] = 'static',
  recipeShadow: MaterialShadow = NO_SHADOW,
): DenseMaterialRecipe {
  return {
    renderer,
    fill: paint(fillColor),
    tint: null,
    contrastFilm: null,
    rim: rim(rimColor),
    shadow: recipeShadow,
    interactionSupport,
  };
}

function denseDefinition(recipe: DenseMaterialRecipe): MaterialRecipeDefinition {
  return {
    preferredByPlatform: {
      ios: recipe,
      android: recipe,
      web: recipe,
    },
    accessibilityFallback: recipe,
    unsupportedPlatformFallback: recipe,
  };
}

function neutral(recipe: MaterialRecipeDefinition): MaterialToneRecipes {
  return { neutral: recipe };
}

function createSemanticControlTones(
  colors: MaterialPalette,
  renderer: DenseMaterialRecipe['renderer'],
  interactionSupport: DenseMaterialRecipe['interactionSupport'] = 'pressable',
): MaterialToneRecipes {
  const define = (fillColor: string, rimColor: string) => denseDefinition(
    denseRecipe(renderer, fillColor, rimColor, interactionSupport),
  );

  return {
    neutral: define(colors.surfaceMuted, colors.borderSubtle),
    primary: define(colors.primarySoft, colors.primary),
    accent: define(colors.primarySoft, colors.primary),
    info: define(colors.infoSurface, colors.info),
    success: define(colors.successSurface, colors.success),
    warning: define(colors.warningSurface, colors.warning),
    error: define(colors.dangerSurface, colors.error),
  };
}

function createSemanticBannerTones(
  colors: MaterialPalette,
  renderer: DenseMaterialRecipe['renderer'],
): MaterialToneRecipes {
  return createSemanticControlTones(colors, renderer, 'static');
}

export function createSolidThemeMaterialRecipes(colors: MaterialPalette): ThemeMaterialRecipes {
  const canvas = denseDefinition(denseRecipe('solid', colors.background, colors.background));
  const contentRaised = denseDefinition(denseRecipe('solid', colors.cardBackground, colors.border));
  const contentInset = denseDefinition(denseRecipe('solid', colors.surface, colors.borderSubtle));
  const contentList = denseDefinition(denseRecipe('solid', colors.surfaceMuted, colors.borderSubtle));
  const header = denseDefinition(denseRecipe('solid', colors.surface, colors.border));
  const tabBar = denseDefinition(denseRecipe('solid', colors.tabBarBackground, colors.tabBarBorder));
  const composer = denseDefinition(denseRecipe('solid', colors.inputBackground, colors.border));
  const sheet = denseDefinition(denseRecipe(
    'solid',
    colors.surfaceOverlay,
    colors.border,
    'static',
    shadow(colors.background, 0.16, 18, -4, 8),
  ));
  const controls = createSemanticControlTones(colors, 'tinted');
  const overlayBanner = createSemanticBannerTones(colors, 'tinted');
  const overlayPopover = denseDefinition(denseRecipe(
    'solid',
    colors.surfaceOverlay,
    colors.borderStrong,
    'static',
    shadow(colors.background, 0.2, 20, 6, 10),
  ));
  const scrim = denseDefinition(denseRecipe('tinted', colors.overlay, colors.overlay));

  return {
    canvas: { base: neutral(canvas) },
    content: {
      raised: neutral(contentRaised),
      inset: neutral(contentInset),
      list: neutral(contentList),
    },
    chrome: {
      header: neutral(header),
      tabBar: neutral(tabBar),
      composer: neutral(composer),
      sheet: neutral(sheet),
    },
    control: {
      inline: controls,
      floating: controls,
      selected: controls,
    },
    overlay: {
      banner: overlayBanner,
      popover: neutral(overlayPopover),
      scrim: neutral(scrim),
    },
  };
}

function glassShadow(colors: MaterialPalette, mode: MaterialColorMode): MaterialShadow {
  return shadow(
    colors.background,
    mode === 'dark' ? 0.32 : 0.18,
    mode === 'dark' ? 24 : 20,
    6,
    10,
  );
}

function blurRecipe(
  colors: MaterialPalette,
  mode: MaterialColorMode,
  tintColor: string,
  intensity: number,
  interactionSupport: MaterialRendererRecipe['interactionSupport'],
): BlurMaterialRecipe {
  return {
    renderer: 'blur',
    fill: paint(colors.surface, 0.14),
    tint: paint(tintColor, mode === 'dark' ? 0.34 : 0.42),
    contrastFilm: paint(colors.background, mode === 'dark' ? 0.18 : 0.08),
    rim: rim(colors.borderSubtle, mode === 'dark' ? 0.72 : 0.82),
    shadow: glassShadow(colors, mode),
    interactionSupport,
    blur: {
      intensity,
      tint: colors.headerBlurTint,
      androidReductionFactor: mode === 'dark' ? 0.72 : 0.68,
    },
  };
}

function liquidGlassRecipe(
  colors: MaterialPalette,
  mode: MaterialColorMode,
  tintColor: string,
  interactionSupport: MaterialRendererRecipe['interactionSupport'],
): NativeLiquidGlassMaterialRecipe {
  return {
    renderer: 'native-liquid-glass',
    fill: paint(colors.surface, 0.1),
    tint: paint(tintColor, mode === 'dark' ? 0.28 : 0.34),
    contrastFilm: paint(colors.background, mode === 'dark' ? 0.14 : 0.06),
    rim: rim(colors.borderSubtle, mode === 'dark' ? 0.66 : 0.76),
    shadow: glassShadow(colors, mode),
    interactionSupport,
    nativeGlass: {
      style: interactionSupport === 'native' ? 'clear' : 'regular',
    },
  };
}

function effectDefinition(
  colors: MaterialPalette,
  mode: MaterialColorMode,
  tintColor: string,
  intensity: number,
  interactionSupport: MaterialRendererRecipe['interactionSupport'],
): MaterialRecipeDefinition {
  const denseFallback = denseRecipe(
    'tinted',
    colors.surfaceOverlay,
    colors.borderSubtle,
    interactionSupport === 'static' ? 'static' : 'pressable',
    glassShadow(colors, mode),
  );
  const legacyBlur = blurRecipe(colors, mode, tintColor, intensity, interactionSupport);

  return {
    preferredByPlatform: {
      ios: liquidGlassRecipe(colors, mode, tintColor, interactionSupport),
      android: legacyBlur,
      web: denseFallback,
    },
    platformFallbackByPlatform: {
      ios: legacyBlur,
      android: denseFallback,
      web: denseFallback,
    },
    accessibilityFallback: denseFallback,
    unsupportedPlatformFallback: denseFallback,
  };
}

function createGlassControlTones(
  colors: MaterialPalette,
  mode: MaterialColorMode,
  live: boolean,
): MaterialToneRecipes {
  if (!live) {
    return createSemanticControlTones(colors, 'tinted');
  }

  const define = (tintColor: string) => effectDefinition(
    colors,
    mode,
    tintColor,
    mode === 'dark' ? 64 : 56,
    'native',
  );

  return {
    neutral: define(colors.surface),
    primary: define(colors.primarySoft),
    accent: define(colors.primarySoft),
    info: define(colors.infoSurface),
    success: define(colors.successSurface),
    warning: define(colors.warningSurface),
    error: define(colors.dangerSurface),
  };
}

export function createLiquidThemeMaterialRecipes(
  colors: MaterialPalette,
  mode: MaterialColorMode,
): ThemeMaterialRecipes {
  const canvas = denseDefinition(denseRecipe('solid', colors.background, colors.background));
  const contentRaised = denseDefinition(denseRecipe('tinted', colors.cardBackground, colors.borderSubtle));
  const contentInset = denseDefinition(denseRecipe('tinted', colors.surface, colors.borderSubtle));
  const contentList = denseDefinition(denseRecipe('tinted', colors.surfaceMuted, colors.borderSubtle));
  const chrome = (intensity: number) => neutral(effectDefinition(
    colors,
    mode,
    colors.surface,
    intensity,
    'static',
  ));
  const inlineControls = createGlassControlTones(colors, mode, false);
  const floatingControls = createGlassControlTones(colors, mode, true);
  const banner = createSemanticBannerTones(colors, 'tinted');
  const popover = neutral(effectDefinition(
    colors,
    mode,
    colors.surfaceOverlay,
    mode === 'dark' ? 78 : 68,
    'static',
  ));
  const scrim = denseDefinition(denseRecipe('tinted', colors.overlay, colors.overlay));

  return {
    canvas: { base: neutral(canvas) },
    content: {
      raised: neutral(contentRaised),
      inset: neutral(contentInset),
      list: neutral(contentList),
    },
    chrome: {
      header: chrome(mode === 'dark' ? 88 : 75),
      tabBar: chrome(mode === 'dark' ? 82 : 72),
      composer: chrome(mode === 'dark' ? 76 : 66),
      sheet: chrome(mode === 'dark' ? 84 : 72),
    },
    control: {
      inline: inlineControls,
      floating: floatingControls,
      selected: inlineControls,
    },
    overlay: {
      banner,
      popover,
      scrim: neutral(scrim),
    },
  };
}
