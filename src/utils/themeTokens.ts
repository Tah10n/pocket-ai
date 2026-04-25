import { DarkTheme, DefaultTheme, type Theme } from '@react-navigation/native';
import type { ViewStyle } from 'react-native';

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
export const themeIds = ['default', 'glass'] as const;
export type ThemeId = typeof themeIds[number];
export const DEFAULT_THEME_ID: ThemeId = 'default';
export type ThemeTone = 'neutral' | 'primary' | 'accent' | 'info' | 'success' | 'warning' | 'error';

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && (themeIds as readonly string[]).includes(value);
}

type ThemeSurfaceKind = 'solid' | 'glass';

export interface ThemeToneClassNames {
  surfaceClassName: string;
  iconTileClassName: string;
  iconClassName: string;
  textClassName: string;
  labelClassName: string;
  valueClassName: string;
  badgeClassName: string;
  progressTrackClassName: string;
  framedProgressTrackClassName: string;
  progressFillClassName: string;
  percentPillClassName: string;
}

interface ThemeAppearanceClassNames {
  toneClassNameByTone: Record<ThemeTone, ThemeToneClassNames>;
  headerShellClassName: string;
  headerBorderClassName: string;
  dividerClassName: string;
  surfaceBarClassName: string;
  cardClassName: string;
  insetCardClassName: string;
  selectedInsetCardClassName: string;
  textFieldClassName: string;
  compactTextFieldClassName: string;
  prominentTextFieldClassName: string;
  multilineTextFieldClassName: string;
  prominentMultilineTextFieldClassName: string;
  searchInlineFieldClassName: string;
  composerInlineFieldClassName: string;
  segmentedControlClassName: string;
  segmentedControlActiveItemClassName: string;
  sheetClassName: string;
  modalOverlayClassName: string;
  iconButtonClassName: string;
  headerActionClassName: string;
  primaryActionPillClassName: string;
  softActionPillClassName: string;
  bottomBarClassName: string;
  modeBannerClassName: string;
  floatingBannerClassName: string;
  inlinePillClassName: string;
  systemEventPillClassName: string;
  chatUserBubbleClassName: string;
  chatAssistantBubbleClassName: string;
  chatThoughtBubbleClassName: string;
  chatInlineErrorClassName: string;
  chatMetadataBadgeClassName: string;
  heroImageOverlayClassName: string;
  heroImageScrimClassName: string;
  thumbnailSurfaceClassName: string;
  progressShineClassName: string;
}

interface ThemeAppearanceEffects {
  headerBlurIntensity: number;
  surfaceBlurIntensity: number;
  blurReductionFactor?: number;
  tabBarStyle: Pick<ViewStyle, 'elevation' | 'shadowColor' | 'shadowOffset' | 'shadowOpacity' | 'shadowRadius'>;
}

export interface ThemeAppearance {
  id: ThemeId;
  surfaceKind: ThemeSurfaceKind;
  classNames: ThemeAppearanceClassNames;
  effects: ThemeAppearanceEffects;
}

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

export function getThemeToneIconColor(tone: ThemeTone, mode: ResolvedThemeMode) {
  if (tone === 'neutral') {
    return getScaleColor(semanticColorTokens.typography, mode === 'dark' ? '200' : '700');
  }

  if (tone === 'info') {
    return getScaleColor(semanticColorTokens.info, mode === 'dark' ? '300' : '600');
  }

  if (tone === 'success') {
    return getScaleColor(semanticColorTokens.success, mode === 'dark' ? '300' : '600');
  }

  if (tone === 'warning') {
    return getScaleColor(semanticColorTokens.warning, mode === 'dark' ? '200' : '700');
  }

  if (tone === 'error') {
    return getScaleColor(semanticColorTokens.error, mode === 'dark' ? '300' : '600');
  }

  return getScaleColor(semanticColorTokens.primary, mode === 'dark' ? '300' : '600');
}

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

const solidPrimaryTone: ThemeToneClassNames = {
  surfaceClassName: 'border-primary-500/20 bg-primary-500/10 dark:border-primary-400/25 dark:bg-primary-500/10',
  iconTileClassName: 'bg-primary-500/10 dark:bg-primary-500/20',
  iconClassName: 'text-primary-600 dark:text-primary-300',
  textClassName: 'text-primary-700 dark:text-primary-200',
  labelClassName: 'text-primary-700 dark:text-primary-200',
  valueClassName: 'text-typography-900 dark:text-typography-50',
  badgeClassName: 'border-primary-500/20 bg-primary-500/10 dark:border-primary-400/25 dark:bg-primary-500/15',
  progressTrackClassName: 'bg-primary-200 dark:bg-typography-800',
  framedProgressTrackClassName: 'border-primary-500/20 bg-primary-500/10 dark:border-primary-400/25 dark:bg-primary-500/10',
  progressFillClassName: 'bg-primary-500',
  percentPillClassName: 'bg-primary-500/10 dark:bg-primary-500/15',
};

const solidToneClassNameByTone: Record<ThemeTone, ThemeToneClassNames> = {
  neutral: {
    surfaceClassName: 'border-outline-200 bg-background-0 dark:border-outline-700 dark:bg-background-950/70',
    iconTileClassName: 'bg-background-100 dark:bg-background-800',
    iconClassName: 'text-typography-700 dark:text-typography-200',
    textClassName: 'text-typography-700 dark:text-typography-200',
    labelClassName: 'text-typography-600 dark:text-typography-400',
    valueClassName: 'text-typography-900 dark:text-typography-100',
    badgeClassName: 'border-outline-200 bg-background-50 dark:border-outline-700 dark:bg-background-900/70',
    progressTrackClassName: 'bg-background-200 dark:bg-background-800',
    framedProgressTrackClassName: 'border-outline-200 bg-background-100 dark:border-outline-700 dark:bg-background-900/70',
    progressFillClassName: 'bg-typography-500 dark:bg-typography-300',
    percentPillClassName: 'bg-background-100 dark:bg-background-800',
  },
  primary: solidPrimaryTone,
  accent: solidPrimaryTone,
  info: {
    surfaceClassName: 'border-info-500/20 bg-info-500/10 dark:border-info-400/25 dark:bg-info-500/10',
    iconTileClassName: 'bg-info-500/10 dark:bg-info-500/20',
    iconClassName: 'text-info-600 dark:text-info-300',
    textClassName: 'text-info-700 dark:text-info-200',
    labelClassName: 'text-info-700 dark:text-info-200',
    valueClassName: 'text-typography-900 dark:text-typography-50',
    badgeClassName: 'border-info-500/20 bg-info-500/10 dark:border-info-400/25 dark:bg-info-500/15',
    progressTrackClassName: 'bg-info-200 dark:bg-info-900/50',
    framedProgressTrackClassName: 'border-info-500/20 bg-info-500/10 dark:border-info-400/25 dark:bg-info-500/10',
    progressFillClassName: 'bg-info-500',
    percentPillClassName: 'bg-info-500/10 dark:bg-info-500/15',
  },
  success: {
    surfaceClassName: 'border-success-500/20 bg-success-500/10 dark:border-success-400/25 dark:bg-success-500/10',
    iconTileClassName: 'bg-success-500/10 dark:bg-success-500/20',
    iconClassName: 'text-success-600 dark:text-success-300',
    textClassName: 'text-success-700 dark:text-success-200',
    labelClassName: 'text-success-700 dark:text-success-200',
    valueClassName: 'text-typography-900 dark:text-typography-50',
    badgeClassName: 'border-success-500/20 bg-success-500/10 dark:border-success-400/25 dark:bg-success-500/15',
    progressTrackClassName: 'bg-success-200 dark:bg-success-900/50',
    framedProgressTrackClassName: 'border-success-500/25 bg-success-500/10 dark:border-success-400/25 dark:bg-success-500/10',
    progressFillClassName: 'bg-success-500',
    percentPillClassName: 'bg-success-500/10 dark:bg-success-500/15',
  },
  warning: {
    surfaceClassName: 'border-warning-300 bg-background-warning dark:border-warning-800 dark:bg-warning-950/35',
    iconTileClassName: 'bg-warning-100 dark:bg-warning-500/20',
    iconClassName: 'text-warning-700 dark:text-warning-200',
    textClassName: 'text-warning-800 dark:text-warning-100',
    labelClassName: 'text-warning-700 dark:text-warning-200',
    valueClassName: 'text-typography-900 dark:text-typography-50',
    badgeClassName: 'border-warning-400/30 bg-warning-50 dark:border-warning-600/40 dark:bg-warning-950/60',
    progressTrackClassName: 'bg-warning-200 dark:bg-warning-900/50',
    framedProgressTrackClassName: 'border-warning-500/30 bg-background-warning dark:border-warning-700 dark:bg-warning-500/10',
    progressFillClassName: 'bg-warning-500',
    percentPillClassName: 'bg-warning-500/10 dark:bg-warning-500/15',
  },
  error: {
    surfaceClassName: 'border-error-500/20 bg-error-500/10 dark:border-error-400/25 dark:bg-error-500/10',
    iconTileClassName: 'bg-error-500/10 dark:bg-error-500/20',
    iconClassName: 'text-error-600 dark:text-error-300',
    textClassName: 'text-error-700 dark:text-error-200',
    labelClassName: 'text-error-700 dark:text-error-200',
    valueClassName: 'text-typography-900 dark:text-typography-50',
    badgeClassName: 'border-error-500/20 bg-error-500/10 dark:border-error-400/25 dark:bg-error-500/15',
    progressTrackClassName: 'bg-error-200 dark:bg-error-900/50',
    framedProgressTrackClassName: 'border-error-500/25 bg-error-500/10 dark:border-error-400/25 dark:bg-error-500/10',
    progressFillClassName: 'bg-error-500',
    percentPillClassName: 'bg-error-500/10 dark:bg-error-500/15',
  },
};

const glassPrimaryTone: ThemeToneClassNames = {
  surfaceClassName: 'border-primary-500/25 bg-primary-500/10 dark:border-primary-400/25 dark:bg-primary-500/10',
  iconTileClassName: 'border border-primary-500/15 bg-primary-500/10 dark:border-primary-400/20 dark:bg-primary-500/15',
  iconClassName: 'text-primary-600 dark:text-primary-300',
  textClassName: 'text-primary-700 dark:text-primary-200',
  labelClassName: 'text-primary-700 dark:text-primary-200',
  valueClassName: 'text-typography-900 dark:text-typography-50',
  badgeClassName: 'border-primary-500/25 bg-primary-500/10 dark:border-primary-400/25 dark:bg-primary-500/15',
  progressTrackClassName: 'bg-primary-500/15 dark:bg-primary-500/20',
  framedProgressTrackClassName: 'border-primary-500/25 bg-primary-500/10 dark:border-primary-400/25 dark:bg-primary-500/10',
  progressFillClassName: 'bg-primary-500',
  percentPillClassName: 'border border-primary-500/15 bg-primary-500/10 dark:border-primary-400/20 dark:bg-primary-500/15',
};

const glassToneClassNameByTone: Record<ThemeTone, ThemeToneClassNames> = {
  neutral: {
    surfaceClassName: 'border-background-0/95 bg-background-0/72 dark:border-typography-0/16 dark:bg-background-950/50',
    iconTileClassName: 'border border-background-0/95 bg-background-0/72 dark:border-typography-0/16 dark:bg-background-900/50',
    iconClassName: 'text-typography-700 dark:text-typography-200',
    textClassName: 'text-typography-700 dark:text-typography-200',
    labelClassName: 'text-typography-600 dark:text-typography-400',
    valueClassName: 'text-typography-900 dark:text-typography-100',
    badgeClassName: 'border-background-0/95 bg-background-0/72 dark:border-typography-0/16 dark:bg-background-900/50',
    progressTrackClassName: 'bg-background-200/70 dark:bg-background-800/55',
    framedProgressTrackClassName: 'border-background-0/95 bg-background-100/72 dark:border-typography-0/16 dark:bg-background-900/50',
    progressFillClassName: 'bg-typography-500 dark:bg-typography-300',
    percentPillClassName: 'border border-background-0/95 bg-background-0/72 dark:border-typography-0/16 dark:bg-background-900/50',
  },
  primary: glassPrimaryTone,
  accent: glassPrimaryTone,
  info: {
    surfaceClassName: 'border-info-500/25 bg-info-500/10 dark:border-info-400/25 dark:bg-info-500/10',
    iconTileClassName: 'border border-info-500/15 bg-info-500/10 dark:border-info-400/20 dark:bg-info-500/15',
    iconClassName: 'text-info-600 dark:text-info-300',
    textClassName: 'text-info-700 dark:text-info-200',
    labelClassName: 'text-info-700 dark:text-info-200',
    valueClassName: 'text-typography-900 dark:text-typography-50',
    badgeClassName: 'border-info-500/25 bg-info-500/10 dark:border-info-400/25 dark:bg-info-500/15',
    progressTrackClassName: 'bg-info-500/15 dark:bg-info-500/20',
    framedProgressTrackClassName: 'border-info-500/25 bg-info-500/10 dark:border-info-400/25 dark:bg-info-500/10',
    progressFillClassName: 'bg-info-500',
    percentPillClassName: 'border border-info-500/15 bg-info-500/10 dark:border-info-400/20 dark:bg-info-500/15',
  },
  success: {
    surfaceClassName: 'border-success-500/25 bg-success-500/10 dark:border-success-400/25 dark:bg-success-500/10',
    iconTileClassName: 'border border-success-500/15 bg-success-500/10 dark:border-success-400/20 dark:bg-success-500/15',
    iconClassName: 'text-success-600 dark:text-success-300',
    textClassName: 'text-success-700 dark:text-success-200',
    labelClassName: 'text-success-700 dark:text-success-200',
    valueClassName: 'text-typography-900 dark:text-typography-50',
    badgeClassName: 'border-success-500/25 bg-success-500/10 dark:border-success-400/25 dark:bg-success-500/15',
    progressTrackClassName: 'bg-success-500/15 dark:bg-success-500/20',
    framedProgressTrackClassName: 'border-success-500/25 bg-success-500/10 dark:border-success-400/25 dark:bg-success-500/10',
    progressFillClassName: 'bg-success-500',
    percentPillClassName: 'border border-success-500/15 bg-success-500/10 dark:border-success-400/20 dark:bg-success-500/15',
  },
  warning: {
    surfaceClassName: 'border-warning-400/35 bg-warning-50/38 dark:border-warning-700/45 dark:bg-warning-950/22',
    iconTileClassName: 'border border-warning-500/20 bg-warning-500/10 dark:border-warning-400/25 dark:bg-warning-500/15',
    iconClassName: 'text-warning-700 dark:text-warning-200',
    textClassName: 'text-warning-800 dark:text-warning-100',
    labelClassName: 'text-warning-700 dark:text-warning-200',
    valueClassName: 'text-typography-900 dark:text-typography-50',
    badgeClassName: 'border-warning-400/35 bg-warning-50/38 dark:border-warning-700/45 dark:bg-warning-950/24',
    progressTrackClassName: 'bg-warning-500/15 dark:bg-warning-500/20',
    framedProgressTrackClassName: 'border-warning-500/30 bg-warning-500/10 dark:border-warning-700/50 dark:bg-warning-500/10',
    progressFillClassName: 'bg-warning-500',
    percentPillClassName: 'border border-warning-500/20 bg-warning-500/10 dark:border-warning-400/25 dark:bg-warning-500/15',
  },
  error: {
    surfaceClassName: 'border-error-500/25 bg-error-500/10 dark:border-error-400/25 dark:bg-error-500/10',
    iconTileClassName: 'border border-error-500/15 bg-error-500/10 dark:border-error-400/20 dark:bg-error-500/15',
    iconClassName: 'text-error-600 dark:text-error-300',
    textClassName: 'text-error-700 dark:text-error-200',
    labelClassName: 'text-error-700 dark:text-error-200',
    valueClassName: 'text-typography-900 dark:text-typography-50',
    badgeClassName: 'border-error-500/25 bg-error-500/10 dark:border-error-400/25 dark:bg-error-500/15',
    progressTrackClassName: 'bg-error-500/15 dark:bg-error-500/20',
    framedProgressTrackClassName: 'border-error-500/25 bg-error-500/10 dark:border-error-400/25 dark:bg-error-500/10',
    progressFillClassName: 'bg-error-500',
    percentPillClassName: 'border border-error-500/15 bg-error-500/10 dark:border-error-400/20 dark:bg-error-500/15',
  },
};

function getSolidThemeAppearance(mode: ResolvedThemeMode): ThemeAppearance {
  const isDark = mode === 'dark';

  return {
    id: 'default',
    surfaceKind: 'solid',
    classNames: {
      toneClassNameByTone: solidToneClassNameByTone,
      headerShellClassName: isDark ? 'bg-background-950/90' : 'bg-background-0/94',
      headerBorderClassName: isDark ? 'border-outline-800' : 'border-outline-200',
      dividerClassName: 'border-outline-200 dark:border-outline-800',
      surfaceBarClassName: 'border-b border-outline-200 bg-background-0 dark:border-outline-800 dark:bg-background-950',
      cardClassName: screenLayoutTokens.cardClassName,
      insetCardClassName: screenLayoutTokens.insetCardClassName,
      selectedInsetCardClassName: listRowSelectedClassName,
      textFieldClassName: screenLayoutTokens.textFieldClassName,
      compactTextFieldClassName: screenLayoutTokens.compactTextFieldClassName,
      prominentTextFieldClassName: screenLayoutTokens.prominentTextFieldClassName,
      multilineTextFieldClassName: screenLayoutTokens.multilineTextFieldClassName,
      prominentMultilineTextFieldClassName: screenLayoutTokens.prominentMultilineTextFieldClassName,
      searchInlineFieldClassName: screenLayoutTokens.searchInlineFieldClassName,
      composerInlineFieldClassName: screenLayoutTokens.composerInlineFieldClassName,
      segmentedControlClassName: screenLayoutTokens.segmentedControlClassName,
      segmentedControlActiveItemClassName: 'bg-primary-500',
      sheetClassName: screenLayoutTokens.sheetClassName,
      modalOverlayClassName: screenLayoutTokens.modalOverlayClassName,
      iconButtonClassName: 'bg-primary-500/10 dark:bg-primary-500/15',
      headerActionClassName: 'bg-primary-500/10 dark:bg-primary-500/15',
      primaryActionPillClassName: screenLayoutTokens.primaryActionPillClassName,
      softActionPillClassName: screenLayoutTokens.softActionPillClassName,
      bottomBarClassName: 'border-t border-outline-200 bg-background-0/95 dark:border-outline-800 dark:bg-background-950/95',
      modeBannerClassName: 'rounded-2xl border border-primary-500/15 bg-primary-500/5 px-3 py-2',
      floatingBannerClassName: 'rounded-2xl border border-primary-500/20 bg-background-0/95 px-3 py-2.5 dark:border-primary-400/25 dark:bg-background-950/95',
      inlinePillClassName: 'rounded-full border border-outline-200/80 bg-background-0/80 px-3 py-1.5 dark:border-outline-700 dark:bg-background-950/70',
      systemEventPillClassName: 'rounded-full bg-background-100 px-3 py-1 dark:bg-background-900/70',
      chatUserBubbleClassName: 'rounded-[24px] rounded-br-lg bg-primary-500 px-3.5 py-2',
      chatAssistantBubbleClassName: 'rounded-[22px] rounded-bl-lg border border-outline-200 bg-background-50 px-3 py-1.5 dark:border-outline-800 dark:bg-background-900/70',
      chatThoughtBubbleClassName: 'min-w-[220px] max-w-full rounded-[20px] border border-outline-200/80 bg-background-0/80 px-3 py-2 dark:border-outline-700/70 dark:bg-background-950/40',
      chatInlineErrorClassName: 'rounded-2xl bg-error-500/10 dark:bg-error-500/15',
      chatMetadataBadgeClassName: 'bg-background-100/90 dark:bg-background-800/90',
      heroImageOverlayClassName: 'bg-primary-500/15',
      heroImageScrimClassName: 'bg-background-50/60 dark:bg-background-900/70',
      thumbnailSurfaceClassName: 'rounded-2xl bg-background-200 overflow-hidden dark:bg-background-800',
      progressShineClassName: 'bg-typography-0/25',
    },
    effects: {
      headerBlurIntensity: isDark ? 72 : 82,
      surfaceBlurIntensity: 0,
      blurReductionFactor: undefined,
      tabBarStyle: {
        elevation: 0,
        shadowOpacity: 0,
      },
    },
  };
}

function getGlassThemeAppearance(mode: ResolvedThemeMode): ThemeAppearance {
  const isDark = mode === 'dark';

  return {
    id: 'glass',
    surfaceKind: 'glass',
    classNames: {
      toneClassNameByTone: glassToneClassNameByTone,
      headerShellClassName: isDark ? 'bg-background-950/48' : 'bg-background-0/55',
      headerBorderClassName: isDark ? 'border-typography-0/14' : 'border-background-0/70',
      dividerClassName: 'border-outline-200/60 dark:border-outline-700/50',
      surfaceBarClassName: 'border-b border-background-0/70 bg-background-0/55 shadow-sm dark:border-typography-0/14 dark:bg-background-950/48',
      cardClassName: `${radiusTokens.lg} border border-background-0/95 bg-background-0/72 shadow-sm dark:border-typography-0/16 dark:bg-background-900/50`,
      insetCardClassName: `${radiusTokens.md} border border-background-0/95 bg-background-0/70 shadow-sm dark:border-typography-0/16 dark:bg-background-950/52`,
      selectedInsetCardClassName: 'border-primary-500/35 bg-primary-500/16 dark:border-primary-400/30 dark:bg-primary-500/14',
      textFieldClassName: `${textFieldBySize.md} border border-background-0/95 bg-background-0/74 shadow-sm dark:border-typography-0/16 dark:bg-background-950/55`,
      compactTextFieldClassName: `min-h-11 ${radiusTokens.md} border border-background-0/95 bg-background-0/74 px-3 shadow-sm dark:border-typography-0/16 dark:bg-background-950/55`,
      prominentTextFieldClassName: `${textFieldBySize.lg} justify-center border border-background-0/95 bg-background-0/74 shadow-sm dark:border-typography-0/16 dark:bg-background-950/55`,
      multilineTextFieldClassName: `min-h-40 ${radiusTokens.xl} border border-background-0/95 bg-background-0/74 shadow-sm dark:border-typography-0/16 dark:bg-background-950/55`,
      prominentMultilineTextFieldClassName: `min-h-[320px] ${radiusTokens.xl} border border-background-0/95 bg-background-0/74 shadow-sm dark:border-typography-0/16 dark:bg-background-950/55`,
      searchInlineFieldClassName: 'flex-row h-10 rounded-2xl items-center border border-background-0/95 bg-background-0/72 px-3 shadow-sm dark:border-typography-0/16 dark:bg-background-900/55',
      composerInlineFieldClassName: 'flex-row h-10 items-center rounded-full border border-background-0/95 bg-background-0/74 px-3.5 shadow-sm dark:border-typography-0/16 dark:bg-background-900/55',
      segmentedControlClassName: 'flex-row rounded-full border border-background-0/95 bg-background-0/72 p-1 shadow-sm dark:border-typography-0/16 dark:bg-background-900/52',
      segmentedControlActiveItemClassName: 'bg-primary-500/76 shadow-sm',
      sheetClassName: `max-h-[88%] ${radiusTokens.sheet} border border-background-0/70 bg-background-0/55 px-4 pt-5 shadow-sm dark:border-typography-0/14 dark:bg-background-950/48`,
      modalOverlayClassName: 'flex-1 justify-end bg-background-950/30',
      iconButtonClassName: 'border border-background-0/70 bg-background-0/55 dark:border-typography-0/14 dark:bg-background-950/48',
      headerActionClassName: 'border border-background-0/70 bg-background-0/55 dark:border-typography-0/14 dark:bg-background-950/48',
      primaryActionPillClassName: 'flex-row items-center justify-center gap-2 border border-primary-500/25 bg-primary-500/82 shadow-sm',
      softActionPillClassName: 'flex-row items-center justify-center gap-1.5 border border-primary-500/20 bg-primary-500/10 dark:border-primary-400/20 dark:bg-primary-500/15',
      bottomBarClassName: 'border-t border-background-0/70 bg-background-0/55 shadow-sm dark:border-typography-0/14 dark:bg-background-950/48',
      modeBannerClassName: 'rounded-2xl border border-primary-500/20 bg-primary-500/10 px-3 py-2 dark:border-primary-400/25 dark:bg-primary-500/10',
      floatingBannerClassName: 'rounded-2xl border border-background-0/70 bg-background-0/55 px-3 py-2.5 shadow-sm dark:border-typography-0/14 dark:bg-background-950/48',
      inlinePillClassName: 'rounded-full border border-background-0/90 bg-background-0/70 px-3 py-1.5 dark:border-typography-0/16 dark:bg-background-950/50',
      systemEventPillClassName: 'rounded-full border border-background-0/85 bg-background-100/70 px-3 py-1 dark:border-typography-0/14 dark:bg-background-900/50',
      chatUserBubbleClassName: 'rounded-[24px] rounded-br-lg border border-primary-400/25 bg-primary-500/78 px-3.5 py-2 shadow-sm',
      chatAssistantBubbleClassName: 'rounded-[22px] rounded-bl-lg border border-background-0/90 bg-background-0/72 px-3 py-1.5 shadow-sm dark:border-typography-0/16 dark:bg-background-900/52',
      chatThoughtBubbleClassName: 'min-w-[220px] max-w-full rounded-[20px] border border-background-0/90 bg-background-0/70 px-3 py-2 shadow-sm dark:border-typography-0/16 dark:bg-background-950/50',
      chatInlineErrorClassName: 'rounded-2xl border border-error-500/15 bg-error-500/10 dark:border-error-400/20 dark:bg-error-500/10',
      chatMetadataBadgeClassName: 'border-background-0/80 bg-background-100/68 dark:border-typography-0/14 dark:bg-background-800/50',
      heroImageOverlayClassName: 'bg-primary-500/20',
      heroImageScrimClassName: 'bg-background-50/35 dark:bg-background-900/45',
      thumbnailSurfaceClassName: 'rounded-2xl overflow-hidden border border-background-0/90 bg-background-0/70 dark:border-typography-0/16 dark:bg-background-900/50',
      progressShineClassName: 'bg-typography-0/30',
    },
    effects: {
      headerBlurIntensity: isDark ? 70 : 60,
      surfaceBlurIntensity: isDark ? 65 : 55,
      blurReductionFactor: 3,
      tabBarStyle: {
        elevation: 8,
        shadowColor: isDark ? semanticColorTokens.background[950] : semanticColorTokens.typography[900],
        shadowOffset: { width: 0, height: -8 },
        shadowOpacity: isDark ? 0.28 : 0.12,
        shadowRadius: 18,
      },
    },
  };
}

export function getThemeAppearance(themeId: ThemeId = DEFAULT_THEME_ID, mode: ResolvedThemeMode = 'light'): ThemeAppearance {
  return themeId === 'glass'
    ? getGlassThemeAppearance(mode)
    : getSolidThemeAppearance(mode);
}

export function getThemeColors(mode: ResolvedThemeMode, themeId: ThemeId = DEFAULT_THEME_ID): ThemeColors {
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

  if (themeId !== 'glass') {
    return baseColors;
  }

  return {
    ...baseColors,
    surface: isDark ? withAlpha(background[900], 0.5) : withAlpha(background[50], 0.52),
    surfaceMuted: isDark ? withAlpha(background[800], 0.42) : withAlpha(background[100], 0.46),
    surfaceElevated: isDark ? withAlpha(background[800], 0.56) : withAlpha(background[50], 0.58),
    surfaceOverlay: isDark ? withAlpha(background[950], 0.54) : withAlpha(background[0], 0.56),
    borderSubtle: withAlpha(isDark ? typography[0] : background[50], isDark ? 0.1 : 0.7),
    inputBackground: isDark ? withAlpha(background[900], 0.36) : withAlpha(background[50], 0.42),
    cardBackground: isDark ? withAlpha(background[900], 0.34) : withAlpha(background[50], 0.42),
    overlay: withAlpha(background[950], isDark ? 0.58 : 0.24),
    tabBarBackground: isDark ? withAlpha(background[950], 0.48) : withAlpha(background[0], 0.55),
    tabBarBorder: isDark ? withAlpha(typography[0], 0.14) : withAlpha(background[0], 0.7),
  };
}

export function createNavigationTheme(mode: ResolvedThemeMode, themeId: ThemeId = DEFAULT_THEME_ID): Theme {
  const colors = getThemeColors(mode, themeId);
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
