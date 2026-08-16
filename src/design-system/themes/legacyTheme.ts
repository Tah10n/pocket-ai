type Scale = Record<string, string>;

interface ThemeContract {
  colors: {
    primary: Scale;
    background: Scale;
    typography: Scale;
    outline: Scale;
    success: Scale;
    info: Scale;
    warning: Scale;
    error: Scale;
  };
  motion: {
    routeTransitionMs: number;
    sheetTransitionMs: number;
    inlineRevealMs: number;
    feedbackMs: number;
    weakDeviceMemoryGb: number;
    headerMaxTitleLines: number;
    minimumTouchTargetPx: number;
  };
}

const themeContract = require('../../utils/theme-contract.json') as ThemeContract;

function getScaleColor(scale: Scale, key: string) {
  const value = scale[key];

  if (!value) {
    throw new Error(`Missing semantic color token "${key}".`);
  }

  return value;
}

function hexToRgb(hex: string) {
  const normalized = hex.replace('#', '');
  const value = normalized.length === 3
    ? normalized.split('').map((entry) => `${entry}${entry}`).join('')
    : normalized;

  const parsed = Number.parseInt(value, 16);

  return {
    red: (parsed >> 16) & 255,
    green: (parsed >> 8) & 255,
    blue: parsed & 255,
  };
}

export function withAlpha(hex: string, alpha: number) {
  const { red, green, blue } = hexToRgb(hex);
  return `rgba(${red}, ${green}, ${blue}, ${Math.min(Math.max(alpha, 0), 1)})`;
}

export const semanticColorTokens = themeContract.colors;
export const motionTokens = themeContract.motion;

export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedThemeMode = 'light' | 'dark';
export type ThemeTone = 'neutral' | 'primary' | 'accent' | 'info' | 'success' | 'warning' | 'error';
export type ThemeProgressTone = 'neutral' | 'primary' | 'success' | 'warning' | 'error';


export interface ThemeColors {
  readonly background: string;
  readonly surface: string;
  readonly surfaceMuted: string;
  readonly surfaceElevated: string;
  readonly surfaceOverlay: string;
  readonly text: string;
  readonly textSecondary: string;
  readonly textTertiary: string;
  readonly textInverse: string;
  readonly textOnPrimary: string;
  readonly textOnSuccess: string;
  readonly textOnError: string;
  readonly textOnSoftAction: string;
  readonly textToneNeutral: string;
  readonly textToneAccent: string;
  readonly textStatusAccent: string;
  readonly textStatusWarning: string;
  readonly textInfo: string;
  readonly textSuccess: string;
  readonly textWarning: string;
  readonly textDanger: string;
  readonly icon: string;
  readonly iconMuted: string;
  readonly iconToneNeutral: string;
  readonly iconToneAccent: string;
  readonly iconToneInfo: string;
  readonly iconToneSuccess: string;
  readonly iconToneWarning: string;
  readonly iconToneDanger: string;
  readonly primary: string;
  readonly primaryStrong: string;
  readonly primarySoft: string;
  readonly primaryMuted: string;
  readonly border: string;
  readonly borderStrong: string;
  readonly borderSubtle: string;
  readonly divider: string;
  readonly error: string;
  readonly warning: string;
  readonly success: string;
  readonly info: string;
  readonly dangerSurface: string;
  readonly warningSurface: string;
  readonly successSurface: string;
  readonly infoSurface: string;
  readonly inputBackground: string;
  readonly cardBackground: string;
  readonly overlay: string;
  readonly tabBarBackground: string;
  readonly tabBarBorder: string;
  readonly tabBarActive: string;
  readonly tabBarInactive: string;
  readonly statusBarStyle: 'light' | 'dark';
  readonly headerBlurTint: 'light' | 'dark';
  readonly heroImageOverlay: string;
  readonly heroImageScrim: string;
  readonly thumbnailBackground: string;
  readonly thinkingPulseHalo: string;
  readonly progressTrackByTone: Readonly<Record<ThemeProgressTone, string>>;
  readonly progressFillByTone: Readonly<Record<ThemeProgressTone, string>>;
}

export const typographyColors = {
  400: getScaleColor(semanticColorTokens.typography, '400'),
  500: getScaleColor(semanticColorTokens.typography, '500'),
} as const;


export const iconSizePx = {
  xs: 14,
  sm: 16,
  md: 18,
  lg: 20,
  xl: 22,
  '2xl': 24,
} as const;

export type SemanticIconSize = keyof typeof iconSizePx;

export const radiusTokens = {
  sm: 'rounded-xl',
  md: 'rounded-2xl',
  // FR-002: Keep the exact (non-scale) radii from the design contract behind semantic tokens.
  lg: 'rounded-[20px]',
  xl: 'rounded-[28px]',
  sheet: 'rounded-t-[32px]',
  full: 'rounded-full',
} as const;


export const cardPaddingByDensity = {
  compact: 'px-3 py-2.5',
  cozy: 'px-4 py-3',
  comfortable: 'px-4 py-4',
} as const;

export const stackGapByDensity = {
  compact: 'gap-2',
  cozy: 'gap-2.5',
  comfortable: 'gap-3',
} as const;

export const textFieldBySize = {
  sm: 'min-h-10 rounded-2xl px-3',
  md: 'min-h-12 rounded-2xl px-3.5',
  lg: 'min-h-14 rounded-[28px] px-4',
} as const;

export const screenChromeTokens = {
  maxWidthClassName: 'max-w-3xl',
  contentHorizontalPaddingClassName: 'px-4',
  contentBottomPaddingClassName: 'pb-6',
  headerHorizontalPaddingClassName: 'px-4',
  headerContentMinHeightClassName: 'min-h-14',
  headerContentGapClassName: 'gap-3',
  headerContentVerticalPaddingClassName: 'py-2',
  headerContentVerticalPaddingCompactClassName: 'py-1.5',
  headerActionClassName: 'h-11 w-11',
  headerActionIconSizePx: iconSizePx.xl,
  bottomBarVerticalPaddingClassName: 'py-2',
} as const;

export const screenLayoutMetrics = {
  contentHorizontalInset: 16,
  contentBottomInset: 24,
  sheetContentTopInset: 20,
  sheetBottomInset: 32,
  sheetFooterTopGap: 8,
  sheetMinimumScrollableContentHeight: 112,
  sheetExpandedMaxHeightRatio: 0.98,
  contentTopInset: 16,
  keyboardComposerGap: 12,
  cardRadius: 20,
  cardInnerRadius: 16,
  cardPaddingHorizontal: 16,
  cardPaddingVertical: 14,
  compactCardPaddingHorizontal: 12,
  compactCardPaddingVertical: 12,
  actionHeight: 40,
  iconButtonSize: 40,
  searchFieldHeight: 40,
  sheetRadius: 32,
} as const;

export const buttonLayoutTokens = {
  sizeClassNameBySize: {
    xs: 'min-h-8 rounded-xl px-3 py-1.5',
    sm: 'min-h-9 rounded-2xl px-3 py-2',
    md: 'min-h-10 rounded-2xl px-4 py-2.5',
    lg: 'min-h-11 rounded-[28px] px-5 py-3',
  },
  textSizeClassNameBySize: {
    xs: 'text-xs',
    sm: 'text-sm',
    md: 'text-sm',
    lg: 'text-base',
  },
  screenActionPillClassNameBySize: {
    sm: 'min-h-8 rounded-2xl px-3 py-1',
    md: 'min-h-9 rounded-full px-3 py-1.5',
    lg: 'min-h-12 rounded-full px-4 py-3',
  },
  screenIconButtonClassNameBySize: {
    micro: 'h-6 w-6 rounded-full',
    compact: 'h-8 w-8 rounded-full',
    default: 'h-10 w-10 rounded-full',
  },
} as const;

export const screenLayoutTokens = {
  contentTopPaddingClassName: 'pt-3',
  stackGapClassName: stackGapByDensity.comfortable,
  stackGapLooseClassName: 'gap-4',
  stackGapCompactClassName: stackGapByDensity.cozy,
  cardClassName: `${radiusTokens.lg} border border-outline-200 bg-background-50 dark:border-outline-800 dark:bg-background-900/60`,
  cardPaddingClassName: cardPaddingByDensity.cozy,
  cardPaddingCompactClassName: cardPaddingByDensity.compact,
  cardPaddingLargeClassName: cardPaddingByDensity.comfortable,
  insetCardClassName: `${radiusTokens.md} border border-outline-200 bg-background-0 dark:border-outline-700 dark:bg-background-950/70`,
  insetCardPaddingClassName: cardPaddingByDensity.compact,
  primaryActionPillClassName: 'flex-row items-center justify-center gap-2 border border-primary-500/20 bg-primary-500',
  softActionPillClassName: 'flex-row items-center justify-center gap-1.5 border border-primary-500/20 bg-primary-500/10',
  iconButtonClassName: 'items-center justify-center',
  iconTileClassName: `h-10 w-10 items-center justify-center ${radiusTokens.md}`,
  searchInlineFieldClassName: 'flex-row h-10 rounded-2xl items-center border border-outline-200 bg-background-50 px-3 dark:border-outline-700 dark:bg-background-900/60',
  composerInlineFieldClassName: 'flex-row h-10 items-center rounded-full border border-outline-200 bg-background-50 px-3.5 dark:border-outline-700 dark:bg-background-900/80',
  inlineInputShellClassName: 'min-w-0 flex-1 min-h-0 h-full justify-center border-0 bg-transparent px-0 dark:bg-transparent',
  searchInlineInputClassName: 'min-h-0 px-0 py-0 text-sm leading-5',
  composerInlineInputClassName: 'min-h-0 h-full px-0 py-0 text-sm',
  segmentedControlClassName: 'flex-row rounded-full border border-outline-200 bg-background-50 p-1 dark:border-outline-700 dark:bg-background-900/70',
  segmentedControlItemClassName: 'min-h-9 flex-1 items-center justify-center rounded-full px-3 py-1.5',
  modalOverlayClassName: 'flex-1 justify-end bg-background-950/45',
  sheetMaxHeightDefaultClassName: 'max-h-[82%]',
  sheetMaxHeightCompactClassName: 'max-h-[75%]',
  sheetMaxHeightExpandedClassName: 'max-h-[98%]',
  sheetContentPaddingClassName: 'px-4 pt-5',
  sheetClassName: `max-h-[88%] ${radiusTokens.sheet} bg-background-0 dark:bg-background-950`,
  sheetHeaderClassName: 'mb-3 flex-row items-center justify-between gap-3',
  bannerPrimaryClassName: `${radiusTokens.md} border border-primary-200 bg-primary-500/10 px-4 py-3 dark:border-primary-800`,
  bannerWarningClassName: `${radiusTokens.md} border border-warning-300 bg-background-warning px-4 py-3 dark:border-warning-800`,
  bannerErrorClassName: `${radiusTokens.md} border border-error-300 bg-background-error px-4 py-3 dark:border-error-800`,
  fieldLabelClassName: 'text-xs font-semibold uppercase tracking-wide',
  sectionLabelClassName: 'px-1 text-xs font-semibold uppercase tracking-wide',
  textFieldClassName: `${textFieldBySize.md} border border-outline-200 bg-background-0 dark:border-outline-700 dark:bg-background-950/70`,
  compactTextFieldClassName: `min-h-11 ${radiusTokens.md} border border-outline-200 bg-background-0 px-3 dark:border-outline-700 dark:bg-background-950/70`,
  prominentTextFieldClassName: `${textFieldBySize.lg} justify-center border border-outline-200 bg-background-0 dark:border-outline-700 dark:bg-background-950/70`,
  multilineTextFieldClassName: `min-h-40 ${radiusTokens.xl} border border-outline-200 bg-background-0 dark:border-outline-700 dark:bg-background-950/70`,
  prominentMultilineTextFieldClassName: `min-h-[320px] ${radiusTokens.xl} border border-outline-200 bg-background-0 dark:border-outline-700 dark:bg-background-950/70`,
  badgeClassName: 'rounded-full px-2.5 py-1',
  microBadgeClassName: 'rounded-full px-2 py-1',
} as const;


function createLegacyThemeColors(mode: ResolvedThemeMode, useGlassOverrides: boolean): ThemeColors {
  const isDark = mode === 'dark';
  const background = semanticColorTokens.background;
  const typography = semanticColorTokens.typography;
  const primary = semanticColorTokens.primary;
  const outline = semanticColorTokens.outline;

  const baseColors: ThemeColors = {
    background: isDark ? background[950] : background[0],
    surface: isDark ? withAlpha(background[900], 0.94) : background[50],
    surfaceMuted: isDark ? withAlpha(background[800], 0.92) : background[100],
    surfaceElevated: isDark ? withAlpha(background[800], 0.98) : background[0],
    surfaceOverlay: isDark ? withAlpha(background[950], 0.9) : withAlpha(background[0], 0.94),
    text: isDark ? typography[0] : typography[900],
    textSecondary: isDark ? typography[300] : typography[600],
    textTertiary: isDark ? typography[400] : typography[500],
    textInverse: isDark ? typography[900] : typography[0],
    textOnPrimary: useGlassOverrides
      ? (isDark ? primary[100] : primary[700])
      : typography[0],
    textOnSuccess: useGlassOverrides
      ? (isDark ? semanticColorTokens.success[100] : semanticColorTokens.success[700])
      : typography[0],
    textOnError: useGlassOverrides
      ? (isDark ? semanticColorTokens.error[100] : semanticColorTokens.error[700])
      : typography[0],
    textOnSoftAction: isDark ? primary[300] : primary[600],
    textToneNeutral: isDark ? typography[200] : typography[700],
    textToneAccent: isDark ? primary[200] : primary[700],
    textStatusAccent: isDark ? primary[300] : primary[600],
    textStatusWarning: isDark ? semanticColorTokens.warning[200] : semanticColorTokens.warning[700],
    textInfo: isDark ? semanticColorTokens.info[200] : semanticColorTokens.info[700],
    textSuccess: isDark ? semanticColorTokens.success[200] : semanticColorTokens.success[700],
    textWarning: isDark ? semanticColorTokens.warning[100] : semanticColorTokens.warning[800],
    textDanger: isDark ? semanticColorTokens.error[200] : semanticColorTokens.error[800],
    icon: isDark ? typography[100] : typography[800],
    iconMuted: isDark ? typography[400] : typography[500],
    iconToneNeutral: isDark ? typography[200] : typography[700],
    iconToneAccent: isDark ? primary[300] : primary[600],
    iconToneInfo: isDark ? semanticColorTokens.info[300] : semanticColorTokens.info[600],
    iconToneSuccess: isDark ? semanticColorTokens.success[300] : semanticColorTokens.success[600],
    iconToneWarning: isDark ? semanticColorTokens.warning[200] : semanticColorTokens.warning[700],
    iconToneDanger: isDark ? semanticColorTokens.error[300] : semanticColorTokens.error[600],
    primary: primary[500],
    primaryStrong: isDark ? primary[400] : primary[600],
    primarySoft: withAlpha(isDark ? primary[300] : primary[500], isDark ? 0.24 : 0.12),
    primaryMuted: isDark ? primary[200] : primary[700],
    border: isDark ? outline[700] : outline[200],
    borderStrong: isDark ? outline[600] : outline[300],
    borderSubtle: withAlpha(isDark ? outline[700] : outline[200], isDark ? 0.7 : 0.8),
    divider: isDark ? outline[800] : outline[200],
    error: isDark ? semanticColorTokens.error[400] : semanticColorTokens.error[600],
    warning: isDark ? semanticColorTokens.warning[300] : semanticColorTokens.warning[700],
    success: isDark ? semanticColorTokens.success[400] : semanticColorTokens.success[600],
    info: isDark ? semanticColorTokens.info[300] : semanticColorTokens.info[600],
    dangerSurface: isDark ? withAlpha(semanticColorTokens.error[900], 0.28) : semanticColorTokens.error[50],
    warningSurface: isDark ? withAlpha(semanticColorTokens.warning[900], 0.28) : semanticColorTokens.warning[50],
    successSurface: isDark ? withAlpha(semanticColorTokens.success[900], 0.28) : semanticColorTokens.success[50],
    infoSurface: isDark ? withAlpha(semanticColorTokens.info[900], 0.24) : semanticColorTokens.info[50],
    inputBackground: isDark ? withAlpha(background[900], 0.9) : background[50],
    cardBackground: isDark ? withAlpha(background[900], 0.86) : background[50],
    overlay: withAlpha(background[950], isDark ? 0.72 : 0.32),
    tabBarBackground: isDark ? withAlpha(background[900], 0.94) : withAlpha(background[0], 0.96),
    tabBarBorder: isDark ? withAlpha(outline[700], 0.82) : withAlpha(outline[200], 0.9),
    tabBarActive: isDark ? primary[300] : primary[600],
    tabBarInactive: isDark ? typography[300] : typography[500],
    statusBarStyle: isDark ? 'light' : 'dark',
    headerBlurTint: isDark ? 'dark' : 'light',
    heroImageOverlay: withAlpha(primary[500], 0.15),
    heroImageScrim: withAlpha(isDark ? background[900] : background[50], isDark ? 0.7 : 0.6),
    thumbnailBackground: isDark ? background[800] : background[200],
    thinkingPulseHalo: withAlpha(primary[500], isDark ? 0.2 : 0.1),
    progressTrackByTone: {
      neutral: isDark ? background[800] : background[200],
      primary: isDark ? typography[800] : primary[200],
      success: isDark
        ? withAlpha(semanticColorTokens.success[900], 0.5)
        : semanticColorTokens.success[200],
      warning: isDark
        ? withAlpha(semanticColorTokens.warning[900], 0.5)
        : semanticColorTokens.warning[200],
      error: isDark
        ? withAlpha(semanticColorTokens.error[900], 0.5)
        : semanticColorTokens.error[200],
    },
    progressFillByTone: {
      neutral: isDark ? typography[300] : typography[500],
      primary: primary[500],
      success: semanticColorTokens.success[500],
      warning: semanticColorTokens.warning[500],
      error: semanticColorTokens.error[500],
    },
  };

  if (!useGlassOverrides) {
    return baseColors;
  }

  return {
    ...baseColors,
    textSecondary: isDark ? typography[200] : baseColors.textSecondary,
    textTertiary: isDark ? typography[300] : baseColors.textTertiary,
    iconMuted: isDark ? typography[300] : baseColors.iconMuted,
    surface: isDark ? withAlpha(background[0], 0.16) : withAlpha(background[50], 0.3),
    surfaceMuted: isDark ? withAlpha(background[0], 0.13) : withAlpha(background[50], 0.24),
    surfaceElevated: isDark ? withAlpha(background[0], 0.19) : withAlpha(background[50], 0.34),
    surfaceOverlay: isDark ? withAlpha(background[0], 0.23) : withAlpha(background[50], 0.38),
    borderSubtle: withAlpha(isDark ? background[0] : background[50], isDark ? 0.38 : 0.42),
    divider: 'transparent',
    inputBackground: isDark ? withAlpha(background[0], 0.15) : withAlpha(background[50], 0.26),
    cardBackground: isDark ? withAlpha(background[0], 0.18) : withAlpha(background[50], 0.3),
    overlay: withAlpha(background[950], 0.26),
    tabBarBackground: isDark ? withAlpha(background[0], 0.2) : withAlpha(background[50], 0.38),
    tabBarBorder: isDark ? withAlpha(background[0], 0.4) : withAlpha(background[50], 0.48),
    tabBarInactive: isDark ? typography[200] : typography[600],
    heroImageOverlay: withAlpha(primary[500], isDark ? 0.18 : 0.3),
    heroImageScrim: withAlpha(isDark ? background[950] : background[50], isDark ? 0.55 : 0.5),
    thumbnailBackground: withAlpha(background[0], isDark ? 0.1 : 0.15),
    thinkingPulseHalo: withAlpha(primary[500], 0.1),
    progressTrackByTone: {
      neutral: withAlpha(isDark ? background[0] : background[200], 0.7),
      primary: withAlpha(primary[500], 0.15),
      success: withAlpha(semanticColorTokens.success[500], 0.15),
      warning: withAlpha(semanticColorTokens.warning[500], 0.15),
      error: withAlpha(semanticColorTokens.error[500], 0.15),
    },
  };
}

export function createDefaultThemeColors(mode: ResolvedThemeMode): ThemeColors {
  return createLegacyThemeColors(mode, false);
}

export function createGlassThemeColors(mode: ResolvedThemeMode): ThemeColors {
  return createLegacyThemeColors(mode, true);
}
