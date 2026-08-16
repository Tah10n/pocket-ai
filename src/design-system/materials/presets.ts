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
  MaterialTone,
  MaterialToneRecipes,
  NativeLiquidGlassMaterialRecipe,
  ThemeMaterialRecipes,
} from './contract';

export interface ContentMaterialFrame {
  readonly fillColor: string;
  readonly rimColor: string;
  readonly rimWidth?: number;
}

export interface SolidThemeMaterialOverrides {
  readonly raised?: ContentMaterialFrame;
  readonly inset?: ContentMaterialFrame;
  readonly list?: ContentMaterialFrame;
  readonly message?: ContentMaterialFrame;
  readonly messageThought?: ContentMaterialFrame;
  readonly messageAttachment?: ContentMaterialFrame;
  readonly messageError?: ContentMaterialFrame;
  readonly composerMode?: ContentMaterialFrame;
  readonly header?: ContentMaterialFrame;
  readonly tones?: Readonly<Partial<Record<Exclude<MaterialTone, 'neutral'>, ContentMaterialFrame>>>;
  readonly messageTones?: Readonly<Partial<Record<Exclude<MaterialTone, 'neutral'>, ContentMaterialFrame>>>;
  readonly selectedControlTones?: Readonly<Partial<Record<Exclude<MaterialTone, 'neutral'>, ContentMaterialFrame>>>;
}

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
  rimWidth = 1,
): DenseMaterialRecipe {
  return {
    renderer,
    fill: paint(fillColor),
    tint: null,
    contrastFilm: null,
    rim: rim(rimColor, 1, rimWidth),
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

function createSemanticContentTones(
  colors: MaterialPalette,
  neutralRecipe: MaterialRecipeDefinition,
  renderer: DenseMaterialRecipe['renderer'],
  overrides: SolidThemeMaterialOverrides['tones'] = {},
): MaterialToneRecipes {
  const define = (tone: Exclude<MaterialTone, 'neutral'>, fillColor: string, rimColor: string) => denseDefinition(
    denseRecipe(
      renderer,
      overrides[tone]?.fillColor ?? fillColor,
      overrides[tone]?.rimColor ?? rimColor,
      'static',
      NO_SHADOW,
      overrides[tone]?.rimWidth,
    ),
  );

  return {
    neutral: neutralRecipe,
    primary: define('primary', colors.primarySoft, colors.primary),
    accent: define('accent', colors.primarySoft, colors.primary),
    info: define('info', colors.infoSurface, colors.info),
    success: define('success', colors.successSurface, colors.success),
    warning: define('warning', colors.warningSurface, colors.warning),
    error: define('error', colors.dangerSurface, colors.error),
  };
}

function createSemanticBannerTones(
  colors: MaterialPalette,
  renderer: DenseMaterialRecipe['renderer'],
): MaterialToneRecipes {
  return createSemanticControlTones(colors, renderer, 'static');
}

export function createSolidThemeMaterialRecipes(
  colors: MaterialPalette,
  materialOverrides: SolidThemeMaterialOverrides = {},
): ThemeMaterialRecipes {
  const canvas = denseDefinition(denseRecipe('solid', colors.background, colors.background));
  const contentRaised = denseDefinition(denseRecipe(
    'solid',
    materialOverrides.raised?.fillColor ?? colors.cardBackground,
    materialOverrides.raised?.rimColor ?? colors.border,
  ));
  const contentInset = denseDefinition(denseRecipe(
    'solid',
    materialOverrides.inset?.fillColor ?? colors.surface,
    materialOverrides.inset?.rimColor ?? colors.borderSubtle,
  ));
  const contentList = denseDefinition(denseRecipe(
    'solid',
    materialOverrides.list?.fillColor ?? colors.surfaceMuted,
    materialOverrides.list?.rimColor ?? colors.borderSubtle,
  ));
  const contentMessage = denseDefinition(denseRecipe(
    'solid',
    materialOverrides.message?.fillColor ?? colors.cardBackground,
    materialOverrides.message?.rimColor ?? colors.border,
    'static',
    NO_SHADOW,
    materialOverrides.message?.rimWidth,
  ));
  const messageThought = denseDefinition(denseRecipe(
    'solid',
    materialOverrides.messageThought?.fillColor ?? colors.surface,
    materialOverrides.messageThought?.rimColor ?? colors.borderSubtle,
    'static',
    NO_SHADOW,
    materialOverrides.messageThought?.rimWidth,
  ));
  const messageAttachment = denseDefinition(denseRecipe(
    'solid',
    materialOverrides.messageAttachment?.fillColor ?? colors.surface,
    materialOverrides.messageAttachment?.rimColor ?? colors.borderSubtle,
    'static',
    NO_SHADOW,
    materialOverrides.messageAttachment?.rimWidth,
  ));
  const messageError = denseDefinition(denseRecipe(
    'solid',
    materialOverrides.messageError?.fillColor ?? colors.dangerSurface,
    materialOverrides.messageError?.rimColor ?? colors.error,
    'static',
    NO_SHADOW,
    materialOverrides.messageError?.rimWidth,
  ));
  const composerMode = denseDefinition(denseRecipe(
    'solid',
    materialOverrides.composerMode?.fillColor ?? colors.primarySoft,
    materialOverrides.composerMode?.rimColor ?? colors.primary,
    'static',
    NO_SHADOW,
    materialOverrides.composerMode?.rimWidth,
  ));
  const header = denseDefinition(denseRecipe(
    'solid',
    materialOverrides.header?.fillColor ?? colors.surface,
    materialOverrides.header?.rimColor ?? colors.border,
  ));
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
  const selectedControlTones = materialOverrides.selectedControlTones ?? {};
  const selectedControls: MaterialToneRecipes = {
    ...controls,
    primary: denseDefinition(denseRecipe(
      'tinted',
      selectedControlTones.primary?.fillColor ?? colors.primary,
      selectedControlTones.primary?.rimColor ?? colors.primary,
      'pressable',
      NO_SHADOW,
      selectedControlTones.primary?.rimWidth ?? 0,
    )),
    success: denseDefinition(denseRecipe(
      'tinted',
      selectedControlTones.success?.fillColor ?? colors.success,
      selectedControlTones.success?.rimColor ?? colors.success,
      'pressable',
      NO_SHADOW,
      selectedControlTones.success?.rimWidth ?? 0,
    )),
    error: denseDefinition(denseRecipe(
      'tinted',
      selectedControlTones.error?.fillColor ?? colors.error,
      selectedControlTones.error?.rimColor ?? colors.error,
      'pressable',
      NO_SHADOW,
      selectedControlTones.error?.rimWidth ?? 0,
    )),
  };
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
      raised: createSemanticContentTones(colors, contentRaised, 'solid', materialOverrides.tones),
      inset: createSemanticContentTones(colors, contentInset, 'solid', materialOverrides.tones),
      list: createSemanticContentTones(colors, contentList, 'solid', materialOverrides.tones),
      message: createSemanticContentTones(colors, contentMessage, 'solid', materialOverrides.messageTones),
      messageThought: neutral(messageThought),
      messageAttachment: neutral(messageAttachment),
      messageError: neutral(messageError),
      composerMode: neutral(composerMode),
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
      selected: selectedControls,
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
      // Expo interprets this value as a divisor, so values above 1 reduce blur radius.
      androidBlurReductionDivisor: mode === 'dark' ? 1 / 0.72 : 1 / 0.68,
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
      style: 'regular',
    },
  };
}

function tabBarBlurRecipe(
  mode: MaterialColorMode,
  platform: 'android' | 'ios',
): BlurMaterialRecipe {
  const isDark = mode === 'dark';
  const matteColor = isDark ? '#f4f7fb' : '#f8fafc';

  return {
    renderer: 'blur',
    fill: paint(matteColor, 0),
    tint: paint(matteColor, isDark ? 0.075 : 0.01),
    contrastFilm: isDark ? paint('#060b14', 0.18) : null,
    rim: rim(matteColor, 0, 0),
    shadow: NO_SHADOW,
    interactionSupport: 'static',
    blur: {
      intensity: isDark ? 18 : 15,
      tint: platform === 'ios'
        ? isDark ? 'systemUltraThinMaterialDark' : 'systemUltraThinMaterialLight'
        : isDark ? 'dark' : 'default',
      androidBlurReductionDivisor: 1,
    },
  };
}

function tabBarLiquidGlassRecipe(
  mode: MaterialColorMode,
): NativeLiquidGlassMaterialRecipe {
  const isDark = mode === 'dark';
  const matteColor = isDark ? '#f4f7fb' : '#f8fafc';

  return {
    renderer: 'native-liquid-glass',
    fill: paint(matteColor, 0),
    tint: paint(matteColor, isDark ? 0.075 : 0.01),
    contrastFilm: isDark ? paint('#060b14', 0.18) : null,
    rim: rim(matteColor, 0, 0),
    shadow: NO_SHADOW,
    interactionSupport: 'static',
    nativeGlass: {
      style: 'clear',
    },
  };
}

function tabBarEffectDefinition(
  colors: MaterialPalette,
  mode: MaterialColorMode,
): MaterialRecipeDefinition {
  const isDark = mode === 'dark';
  const matteColor = isDark ? '#f4f7fb' : '#f8fafc';
  const denseFallback: DenseMaterialRecipe = {
    renderer: 'tinted',
    fill: isDark ? paint('#060b14', 0.24) : paint(matteColor, 0.24),
    tint: isDark ? paint(matteColor, 0.22) : null,
    contrastFilm: null,
    rim: rim(colors.borderSubtle, 0, 0),
    shadow: NO_SHADOW,
    interactionSupport: 'static',
  };
  const androidBlur = tabBarBlurRecipe(mode, 'android');
  const iosBlur = tabBarBlurRecipe(mode, 'ios');

  return {
    preferredByPlatform: {
      ios: tabBarLiquidGlassRecipe(mode),
      android: androidBlur,
      web: denseFallback,
    },
    platformFallbackByPlatform: {
      ios: iosBlur,
      android: denseFallback,
      web: denseFallback,
    },
    accessibilityFallback: denseFallback,
    unsupportedPlatformFallback: denseFallback,
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
  const contentMessage = denseDefinition(denseRecipe(
    'tinted',
    colors.surface,
    colors.borderSubtle,
    'static',
    NO_SHADOW,
    0,
  ));
  const messageThought = denseDefinition(denseRecipe(
    'tinted',
    colors.surface,
    colors.borderSubtle,
    'static',
    NO_SHADOW,
    0,
  ));
  const messageAttachment = denseDefinition(denseRecipe(
    'tinted',
    colors.surface,
    colors.borderSubtle,
    'static',
    NO_SHADOW,
    0,
  ));
  const messageError = denseDefinition(denseRecipe(
    'tinted',
    colors.dangerSurface,
    colors.error,
    'static',
    NO_SHADOW,
    0,
  ));
  const composerMode = denseDefinition(denseRecipe(
    'tinted',
    colors.primarySoft,
    colors.primary,
    'static',
    NO_SHADOW,
    0,
  ));
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
      raised: createSemanticContentTones(colors, contentRaised, 'tinted'),
      inset: createSemanticContentTones(colors, contentInset, 'tinted'),
      list: createSemanticContentTones(colors, contentList, 'tinted'),
      message: createSemanticContentTones(colors, contentMessage, 'tinted', {
        primary: {
          fillColor: colors.primarySoft,
          rimColor: colors.primary,
          rimWidth: 0,
        },
      }),
      messageThought: neutral(messageThought),
      messageAttachment: neutral(messageAttachment),
      messageError: neutral(messageError),
      composerMode: neutral(composerMode),
    },
    chrome: {
      header: chrome(mode === 'dark' ? 88 : 75),
      tabBar: neutral(tabBarEffectDefinition(colors, mode)),
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
