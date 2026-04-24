import { DarkTheme, DefaultTheme, type Theme } from '@react-navigation/native';

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

const themeContract = require('./theme-contract.json') as ThemeContract;

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

export interface ThemeColors {
  background: string;
  surface: string;
  surfaceMuted: string;
  surfaceElevated: string;
  surfaceOverlay: string;
  text: string;
  textSecondary: string;
  textTertiary: string;
  textInverse: string;
  icon: string;
  iconMuted: string;
  primary: string;
  primaryStrong: string;
  primarySoft: string;
  primaryMuted: string;
  border: string;
  borderStrong: string;
  borderSubtle: string;
  error: string;
  warning: string;
  success: string;
  info: string;
  dangerSurface: string;
  warningSurface: string;
  successSurface: string;
  infoSurface: string;
  inputBackground: string;
  cardBackground: string;
  overlay: string;
  tabBarBackground: string;
  tabBarBorder: string;
  tabBarActive: string;
  tabBarInactive: string;
  statusBarStyle: 'light' | 'dark';
  headerBlurTint: 'light' | 'dark';
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

export const listRowSelectedClassName = 'border-primary-500/30 bg-primary-500/10';

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
  sheetBottomInset: 32,
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
  inlineInputShellClassName: 'min-w-0 flex-1 min-h-0 h-full justify-center border-0 bg-transparent px-0',
  searchInlineInputClassName: 'min-h-0 px-0 py-0 text-sm leading-5 text-typography-900 dark:text-typography-100',
  composerInlineInputClassName: 'min-h-0 h-full px-0 py-0 text-sm text-typography-900 dark:text-typography-0',
  segmentedControlClassName: 'flex-row rounded-full border border-outline-200 bg-background-50 p-1 dark:border-outline-700 dark:bg-background-900/70',
  segmentedControlItemClassName: 'min-h-9 flex-1 items-center justify-center rounded-full px-3 py-1.5',
  modalOverlayClassName: 'flex-1 justify-end bg-background-950/45',
  sheetMaxHeightDefaultClassName: 'max-h-[82%]',
  sheetMaxHeightCompactClassName: 'max-h-[75%]',
  sheetClassName: `max-h-[88%] ${radiusTokens.sheet} bg-background-0 px-4 pt-5 dark:bg-background-950`,
  sheetHeaderClassName: 'mb-3 flex-row items-center justify-between gap-3',
  bannerPrimaryClassName: `${radiusTokens.md} border border-primary-200 bg-primary-500/10 px-4 py-3 dark:border-primary-800`,
  bannerWarningClassName: `${radiusTokens.md} border border-warning-300 bg-background-warning px-4 py-3 dark:border-warning-800`,
  bannerErrorClassName: `${radiusTokens.md} border border-error-300 bg-background-error px-4 py-3 dark:border-error-800`,
  fieldLabelClassName: 'text-xs font-semibold uppercase tracking-wide text-typography-500 dark:text-typography-400',
  sectionLabelClassName: 'px-1 text-xs font-semibold uppercase tracking-wide text-typography-500 dark:text-typography-400',
  textFieldClassName: `${textFieldBySize.md} border border-outline-200 bg-background-0 dark:border-outline-700 dark:bg-background-950/70`,
  compactTextFieldClassName: `min-h-11 ${radiusTokens.md} border border-outline-200 bg-background-0 px-3 dark:border-outline-700 dark:bg-background-950/70`,
  prominentTextFieldClassName: `${textFieldBySize.lg} justify-center border border-outline-200 bg-background-0 dark:border-outline-700 dark:bg-background-950/70`,
  multilineTextFieldClassName: `min-h-40 ${radiusTokens.xl} border border-outline-200 bg-background-0 dark:border-outline-700 dark:bg-background-950/70`,
  prominentMultilineTextFieldClassName: `min-h-[320px] ${radiusTokens.xl} border border-outline-200 bg-background-0 dark:border-outline-700 dark:bg-background-950/70`,
  badgeClassName: 'rounded-full px-2.5 py-1',
  microBadgeClassName: 'rounded-full px-2 py-1',
} as const;

export function getThemeColors(mode: ResolvedThemeMode): ThemeColors {
  const isDark = mode === 'dark';
  const background = semanticColorTokens.background;
  const typography = semanticColorTokens.typography;
  const primary = semanticColorTokens.primary;
  const outline = semanticColorTokens.outline;

  return {
    background: isDark ? background[950] : background[0],
    surface: isDark ? withAlpha(background[900], 0.94) : background[50],
    surfaceMuted: isDark ? withAlpha(background[800], 0.92) : background[100],
    surfaceElevated: isDark ? withAlpha(background[800], 0.98) : background[0],
    surfaceOverlay: isDark ? withAlpha(background[950], 0.9) : withAlpha(background[0], 0.94),
    text: isDark ? typography[0] : typography[900],
    textSecondary: isDark ? typography[300] : typography[600],
    textTertiary: isDark ? typography[400] : typography[500],
    textInverse: isDark ? typography[900] : typography[0],
    icon: isDark ? typography[100] : typography[800],
    iconMuted: isDark ? typography[400] : typography[500],
    primary: primary[500],
    primaryStrong: isDark ? primary[400] : primary[600],
    primarySoft: withAlpha(isDark ? primary[300] : primary[500], isDark ? 0.24 : 0.12),
    primaryMuted: isDark ? primary[200] : primary[700],
    border: isDark ? outline[700] : outline[200],
    borderStrong: isDark ? outline[600] : outline[300],
    borderSubtle: withAlpha(isDark ? outline[700] : outline[200], isDark ? 0.7 : 0.8),
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
  };
}

export function createNavigationTheme(mode: ResolvedThemeMode): Theme {
  const colors = getThemeColors(mode);
  const baseTheme = mode === 'dark' ? DarkTheme : DefaultTheme;

  return {
    ...baseTheme,
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
  };
}
