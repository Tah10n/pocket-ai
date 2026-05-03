import React from 'react';
import { Platform, StyleSheet, Text as RNText, type LayoutChangeEvent, type StyleProp, type View, type ViewStyle } from 'react-native';
import { BlurTargetView, BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { useIsFocused } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Box } from '@/components/ui/box';
import { Input, InputField, type InputFieldProps } from '@/components/ui/input';
import { Pressable } from '@/components/ui/pressable';
import { GlassSpecular } from './GlassSpecular';
import { MaterialSymbols, type MaterialSymbolsProps } from './MaterialSymbols';
import { Text, composeTextRole } from './text';
import { getAndroidBlurProps, getGlassBlurTint, isAndroidBlurFallbackRequired, setActiveAndroidBlurTarget, type AndroidBlurTargetRef } from '../../utils/androidBlur';
import { getNativeBottomSafeAreaInset } from '../../utils/safeArea';
import { DEFAULT_THEME_ID, buttonLayoutTokens, getThemeActionContentClassName, getThemeAppearance, getThemeToneIconColor, radiusTokens, screenChromeTokens, screenLayoutMetrics, screenLayoutTokens, semanticColorTokens, tailwindRadiusPxByToken, typographyColors, withAlpha, type ResolvedThemeMode, type ThemeAppearance, type ThemeColors, type ThemeTone } from '../../utils/themeTokens';
import { useTheme } from '../../providers/ThemeProvider';

interface ScreenHeaderShellProps {
  children: React.ReactNode;
  contentClassName?: string;
  contentStyle?: StyleProp<ViewStyle>;
  floating?: boolean;
  maxWidthClassName?: string;
  testID?: string;
}

interface ScreenContentProps {
  children: React.ReactNode;
  className?: string;
  extraBottomInset?: number;
  includeBottomSafeArea?: boolean;
  respectFloatingHeader?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

interface ScreenRootProps {
  children: React.ReactNode;
  className?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

interface ScreenAndroidContentBlurTargetProps {
  blurTargetRef: AndroidBlurTargetRef;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

interface ScreenStackProps {
  children: React.ReactNode;
  className?: string;
  testID?: string;
  gap?: 'compact' | 'default' | 'loose';
}

interface ScreenCardProps {
  children: React.ReactNode;
  className?: string;
  decorative?: GlassSurfaceDecorative;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  variant?: 'surface' | 'inset';
  padding?: 'none' | 'compact' | 'default' | 'large';
  tone?: 'default' | 'accent' | 'warning' | 'error';
  dashed?: boolean;
}

interface ScreenPressableCardProps extends React.ComponentProps<typeof Pressable> {
  children: React.ReactNode;
  className?: string;
  decorative?: GlassSurfaceDecorative;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  variant?: 'surface' | 'inset';
  padding?: 'none' | 'compact' | 'default' | 'large';
  tone?: 'default' | 'accent' | 'warning' | 'error';
  dashed?: boolean;
}

export function joinClassNames(...values: (string | undefined | false)[]) {
  return values.filter(Boolean).join(' ');
}

const GlassBlurTargetContext = React.createContext<React.RefObject<View | null> | null>(null);

type GlassSurfaceDecorative = 'standard' | 'matte' | 'tint';
type GlassCornerRadiusStyle = Pick<ViewStyle,
  | 'borderRadius'
  | 'borderTopLeftRadius'
  | 'borderTopRightRadius'
  | 'borderBottomRightRadius'
  | 'borderBottomLeftRadius'
>;

const roundedSideTokens = new Set(['t', 'r', 'b', 'l', 'tl', 'tr', 'br', 'bl']);
const defaultGlassCornerRadiusStyle: GlassCornerRadiusStyle = { borderRadius: 28 };

interface ScreenHeaderInset {
  height: number;
  isFloating: boolean;
}

const ScreenHeaderInsetContext = React.createContext<ScreenHeaderInset>({ height: 0, isFloating: false });
const ScreenHeaderInsetSetterContext = React.createContext<((inset: ScreenHeaderInset) => void) | null>(null);

export function useScreenHeaderInset() {
  return React.useContext(ScreenHeaderInsetContext);
}

export function useFloatingHeaderInset() {
  const inset = useScreenHeaderInset();
  return inset.isFloating ? inset.height : 0;
}

function getNextScreenHeaderInset(current: ScreenHeaderInset, next: ScreenHeaderInset) {
  return current.height === next.height && current.isFloating === next.isFloating
    ? current
    : next;
}

function getGlassBackdropContainerClassName(appearance: ThemeAppearance) {
  return appearance.surfaceKind === 'glass'
    ? 'relative overflow-hidden bg-transparent'
    : undefined;
}

function getRoundedTokenParts(token: string) {
  if (token === 'rounded') {
    return { valueToken: 'DEFAULT' };
  }

  if (!token.startsWith('rounded-')) {
    return undefined;
  }

  const value = token.slice('rounded-'.length);
  const [maybeSide, ...rest] = value.split('-');

  if (roundedSideTokens.has(maybeSide)) {
    return {
      side: maybeSide,
      valueToken: rest.length > 0 ? rest.join('-') : 'DEFAULT',
    };
  }

  return { valueToken: value };
}

function getRadiusFromToken(valueToken: string) {
  const arbitraryMatch = /^\[(\d+(?:\.\d+)?)px\]$/.exec(valueToken);

  if (arbitraryMatch) {
    return Number(arbitraryMatch[1]);
  }

  return tailwindRadiusPxByToken[valueToken];
}

function applyCornerRadius(
  radiusStyle: GlassCornerRadiusStyle,
  side: string | undefined,
  radius: number,
) {
  if (!side) {
    radiusStyle.borderRadius = radius;
    delete radiusStyle.borderTopLeftRadius;
    delete radiusStyle.borderTopRightRadius;
    delete radiusStyle.borderBottomRightRadius;
    delete radiusStyle.borderBottomLeftRadius;
    return;
  }

  if (side === 't' || side === 'l' || side === 'tl') {
    radiusStyle.borderTopLeftRadius = radius;
  }

  if (side === 't' || side === 'r' || side === 'tr') {
    radiusStyle.borderTopRightRadius = radius;
  }

  if (side === 'b' || side === 'r' || side === 'br') {
    radiusStyle.borderBottomRightRadius = radius;
  }

  if (side === 'b' || side === 'l' || side === 'bl') {
    radiusStyle.borderBottomLeftRadius = radius;
  }
}

export function getGlassCornerRadiusStyle(...classNames: (string | undefined | false)[]): GlassCornerRadiusStyle | undefined {
  const radiusStyle: GlassCornerRadiusStyle = {};

  for (const className of classNames) {
    if (!className) {
      continue;
    }

    for (const rawToken of className.split(/\s+/)) {
      const token = rawToken.split(':').pop();

      if (!token) {
        continue;
      }

      const roundedParts = getRoundedTokenParts(token);

      if (!roundedParts) {
        continue;
      }

      const radius = getRadiusFromToken(roundedParts.valueToken);

      if (radius === undefined) {
        continue;
      }

      applyCornerRadius(radiusStyle, roundedParts.side, radius);
    }
  }

  return Object.keys(radiusStyle).length > 0 ? radiusStyle : undefined;
}

export function getGlassSurfaceFrameStyle(
  appearance: ThemeAppearance,
  mode: ResolvedThemeMode,
  colors: ThemeColors,
  tone: 'default' | ThemeTone | 'danger' = 'default',
  _softened = false,
  cornerRadiusStyle?: GlassCornerRadiusStyle,
): ViewStyle | undefined {
  if (appearance.surfaceKind !== 'glass') {
    return undefined;
  }

  const isDark = mode === 'dark';
  const toneColor = tone === 'warning'
    ? colors.warning
    : tone === 'success'
      ? colors.success
      : tone === 'info'
        ? colors.info
    : tone === 'error' || tone === 'danger'
      ? colors.error
      : tone === 'accent' || tone === 'primary'
        ? colors.primaryStrong
        : undefined;

  return {
    ...(cornerRadiusStyle ?? {}),
    backgroundColor: toneColor
      ? withAlpha(toneColor, isDark ? 0.07 : 0.08)
      : isDark
        ? 'rgba(244, 247, 251, 0.045)'
        : 'rgba(255, 255, 255, 0.08)',
    borderWidth: 0,
    elevation: 0,
    shadowOpacity: 0,
  };
}

function getGlassActionPillStyle(
  appearance: ThemeAppearance,
  mode: ResolvedThemeMode,
  colors: ThemeColors,
  tone: 'primary' | 'soft',
  cornerRadiusStyle?: GlassCornerRadiusStyle,
): ViewStyle | undefined {
  if (appearance.surfaceKind !== 'glass') {
    return undefined;
  }

  const primaryFill = mode === 'dark' ? colors.primary : colors.primaryStrong;

  return {
    ...(cornerRadiusStyle ?? {}),
    backgroundColor: tone === 'primary'
      ? withAlpha(primaryFill, mode === 'dark' ? 0.2 : 0.16)
      : mode === 'dark'
        ? 'rgba(244, 247, 251, 0.05)'
        : 'rgba(255, 255, 255, 0.08)',
    borderWidth: 0,
    elevation: 0,
    shadowOpacity: 0,
  };
}

function getExplicitIconColorFromClassName(iconClassName: string | undefined, colors: ThemeColors) {
  if (!iconClassName) {
    return undefined;
  }

  const tokens = iconClassName
    .split(/\s+/)
    .map((token) => token.split(':').pop())
    .filter((token): token is string => Boolean(token));

  for (const token of [...tokens].reverse()) {
    if (token === 'text-typography-0') {
      return colors.textInverse;
    }

    if (token === 'text-typography-500') {
      return colors.textTertiary;
    }

    if (/^text-typography-\d+(?:\/\d+)?$/.test(token)) {
      return colors.icon;
    }

    if (/^text-primary-\d+(?:\/\d+)?$/.test(token)) {
      return colors.primaryStrong;
    }

    if (/^text-error-\d+(?:\/\d+)?$/.test(token)) {
      return colors.error;
    }

    if (/^text-warning-\d+(?:\/\d+)?$/.test(token)) {
      return colors.warning;
    }

    if (/^text-success-\d+(?:\/\d+)?$/.test(token)) {
      return colors.success;
    }

    if (/^text-info-\d+(?:\/\d+)?$/.test(token)) {
      return colors.info;
    }
  }

  return undefined;
}

function getGlassHeaderFrameStyle(
  appearance: ThemeAppearance,
  _mode: ResolvedThemeMode,
): ViewStyle | undefined {
  if (appearance.surfaceKind !== 'glass') {
    return undefined;
  }

  return {
    borderBottomWidth: 0,
    elevation: 0,
    shadowOpacity: 0,
  };
}

function useResolvedThemeAppearance() {
  const theme = useTheme();
  const appearance = theme.appearance ?? getThemeAppearance(theme.themeId ?? DEFAULT_THEME_ID, theme.resolvedMode ?? 'light');

  return { appearance, theme };
}

export function useScreenAppearance() {
  return useResolvedThemeAppearance().appearance;
}

type LiquidGlassTintVariant = 'standard' | 'matte' | 'control' | 'fallback';
type LiquidGlassGradientColors = readonly [string, string, ...string[]];

function getLiquidGlassTintColor(tint: 'light' | 'dark', variant: LiquidGlassTintVariant) {
  const isDark = tint === 'dark';

  if (variant === 'control') {
    return isDark ? 'rgba(244,247,251,0.085)' : 'rgba(255,255,255,0.16)';
  }

  if (variant === 'fallback') {
    return isDark ? 'rgba(244,247,251,0.13)' : 'rgba(255,255,255,0.42)';
  }

  if (variant === 'matte') {
    return isDark ? 'rgba(244,247,251,0.11)' : 'rgba(255,255,255,0.34)';
  }

  return isDark ? 'rgba(244,247,251,0.075)' : 'rgba(255,255,255,0.3)';
}

function getLiquidGlassContrastColor(tint: 'light' | 'dark', variant: LiquidGlassTintVariant) {
  if (tint !== 'dark') {
    return undefined;
  }

  if (variant === 'control') {
    return 'rgba(6,11,20,0.28)';
  }

  if (variant === 'fallback') {
    return 'rgba(6,11,20,0.46)';
  }

  if (variant === 'matte') {
    return 'rgba(6,11,20,0.38)';
  }

  return 'rgba(6,11,20,0.48)';
}

function shouldSkipGlassSheen(tint: 'light' | 'dark', variant: LiquidGlassTintVariant = 'standard') {
  return Platform.OS === 'android' || (tint === 'dark' && variant === 'control');
}

function getLiquidGlassSheenColors(tint: 'light' | 'dark', variant: LiquidGlassTintVariant = 'standard'): LiquidGlassGradientColors {
  if (tint === 'dark') {
    if (variant === 'matte') {
      return ['rgba(96,165,250,0)', 'rgba(125,211,252,0.08)', 'rgba(96,165,250,0.035)', 'rgba(52,211,153,0)'];
    }

    return ['rgba(96,165,250,0)', 'rgba(125,211,252,0.1)', 'rgba(96,165,250,0.05)', 'rgba(52,211,153,0)'];
  }

  if (variant === 'control') {
    return ['rgba(255,255,255,0)', 'rgba(255,255,255,0.22)', 'rgba(255,255,255,0.08)', 'rgba(255,255,255,0)'];
  }

  return ['rgba(255,255,255,0)', 'rgba(255,255,255,0.2)', 'rgba(255,255,255,0.075)', 'rgba(255,255,255,0)'];
}

function shouldUseAndroidGlassMatteFallback() {
  return Platform.OS === 'android';
}

function LiquidGlassContrastLayer({
  cornerRadiusStyle,
  tint,
  variant = 'standard',
}: {
  cornerRadiusStyle?: GlassCornerRadiusStyle;
  tint: 'light' | 'dark';
  variant?: LiquidGlassTintVariant;
}) {
  const backgroundColor = getLiquidGlassContrastColor(tint, variant);

  if (!backgroundColor) {
    return null;
  }

  return (
    <Box
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        cornerRadiusStyle,
        { backgroundColor },
      ]}
    />
  );
}

function LiquidGlassTintLayer({
  cornerRadiusStyle,
  tint,
  variant = 'standard',
}: {
  cornerRadiusStyle?: GlassCornerRadiusStyle;
  tint: 'light' | 'dark';
  variant?: LiquidGlassTintVariant;
}) {
  return (
    <Box
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        cornerRadiusStyle,
        { backgroundColor: getLiquidGlassTintColor(tint, variant) },
      ]}
    />
  );
}

export function GlassSurfaceBackdrop({
  appearance,
  tint,
  cornerRadiusStyle,
  decorative = 'standard',
  forceNativeAndroidBlur = false,
  androidBlurTargetRef,
}: {
  appearance: ThemeAppearance;
  tint: 'light' | 'dark';
  cornerRadiusStyle?: GlassCornerRadiusStyle;
  decorative?: GlassSurfaceDecorative;
  forceNativeAndroidBlur?: boolean;
  androidBlurTargetRef?: AndroidBlurTargetRef | null;
}) {
  const contextBlurTarget = React.useContext(GlassBlurTargetContext);
  const blurTarget = androidBlurTargetRef === undefined ? contextBlurTarget : androidBlurTargetRef;
  const isMatte = decorative === 'matte';
  const isTintOnly = decorative === 'tint';

  if (appearance.surfaceKind !== 'glass') {
    return null;
  }

  if (isTintOnly) {
    return (
      <>
        <LiquidGlassContrastLayer tint={tint} variant="control" cornerRadiusStyle={cornerRadiusStyle} />
        <LiquidGlassTintLayer tint={tint} variant="control" cornerRadiusStyle={cornerRadiusStyle} />
        {shouldSkipGlassSheen(tint, 'control') ? null : (
          <LinearGradient
            pointerEvents="none"
            colors={getLiquidGlassSheenColors(tint, 'control')}
            locations={[0, 0.18, 0.58, 1]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={[StyleSheet.absoluteFill, cornerRadiusStyle]}
          />
        )}
      </>
    );
  }

  if (
    Platform.OS === 'android'
    && (
      isAndroidBlurFallbackRequired()
      || (!forceNativeAndroidBlur && shouldUseAndroidGlassMatteFallback())
      || !blurTarget
    )
  ) {
    return (
      <>
        <LiquidGlassContrastLayer tint={tint} variant="fallback" cornerRadiusStyle={cornerRadiusStyle} />
        <LiquidGlassTintLayer tint={tint} variant="fallback" cornerRadiusStyle={cornerRadiusStyle} />
        {isMatte ? null : (
          <>
            <GlassSpecular tint={tint} />
            <LiquidGlassOptics tint={tint} cornerRadiusStyle={cornerRadiusStyle} />
          </>
        )}
      </>
    );
  }

  return (
    <>
      <BlurView
        pointerEvents="none"
        intensity={appearance.effects.surfaceBlurIntensity}
        tint={getGlassBlurTint(tint)}
        {...getAndroidBlurProps(appearance, blurTarget)}
        style={StyleSheet.absoluteFill}
      />
      <LiquidGlassContrastLayer tint={tint} variant={isMatte ? 'matte' : 'standard'} cornerRadiusStyle={cornerRadiusStyle} />
      <LiquidGlassTintLayer tint={tint} variant={isMatte ? 'matte' : 'standard'} cornerRadiusStyle={cornerRadiusStyle} />
      {shouldSkipGlassSheen(tint, isMatte ? 'matte' : 'standard') ? null : (
        <LinearGradient
          pointerEvents="none"
          colors={getLiquidGlassSheenColors(tint, isMatte ? 'matte' : 'standard')}
          locations={[0, 0.2, 0.58, 1]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
      )}
      {isMatte ? null : (
        <>
          <GlassSpecular tint={tint} />
          <LinearGradient
            pointerEvents="none"
            colors={tint === 'dark'
              ? ['rgba(96,165,250,0)', 'rgba(96,165,250,0.06)', 'rgba(125,211,252,0.03)', 'rgba(96,165,250,0)']
              : ['rgba(37,99,235,0)', 'rgba(37,99,235,0.16)', 'rgba(14,165,233,0.08)', 'rgba(37,99,235,0)']}
            locations={[0, 0.24, 0.62, 1]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={StyleSheet.absoluteFill}
          />
          <LiquidGlassOptics tint={tint} cornerRadiusStyle={cornerRadiusStyle} />
        </>
      )}
    </>
  );
}

export function GlassControlTint({
  appearance,
  colors,
  mode,
  tone,
}: {
  appearance: ThemeAppearance;
  colors: ThemeColors;
  mode: ResolvedThemeMode;
  tone: ThemeTone | 'danger' | 'default';
}) {
  if (appearance.surfaceKind !== 'glass') {
    return null;
  }

  const color = tone === 'success'
    ? colors.success
    : tone === 'warning'
      ? colors.warning
      : tone === 'info'
        ? colors.info
        : tone === 'error' || tone === 'danger'
          ? colors.error
          : tone === 'primary' || tone === 'accent'
            ? colors.primaryStrong
            : undefined;

  if (!color) {
    return null;
  }

  return (
    <LinearGradient
      pointerEvents="none"
      colors={[
        withAlpha(color, 0.24),
        withAlpha(color, 0.14),
        withAlpha(color, 0.055),
      ]}
      locations={[0, 0.52, 1]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 0.8 }}
      style={StyleSheet.absoluteFill}
    />
  );
}

function LiquidGlassOptics({
  tint,
  cornerRadiusStyle,
}: {
  tint: 'light' | 'dark';
  cornerRadiusStyle?: GlassCornerRadiusStyle;
}) {
  const isDark = tint === 'dark';
  const rimRadiusStyle = cornerRadiusStyle ?? defaultGlassCornerRadiusStyle;
  const rimBorderColor = isDark ? 'rgba(125,211,252,0.22)' : 'rgba(255,255,255,0.58)';

  if (Platform.OS === 'android') {
    return (
      <Box pointerEvents="none" style={StyleSheet.absoluteFill}>
        <Box pointerEvents="none" style={[styles.liquidInnerRim, rimRadiusStyle, { borderColor: rimBorderColor }]} />
      </Box>
    );
  }

  if (isDark) {
    return (
      <Box pointerEvents="none" style={StyleSheet.absoluteFill}>
        <LinearGradient
          pointerEvents="none"
          colors={['rgba(125,211,252,0)', 'rgba(125,211,252,0.12)', 'rgba(96,165,250,0.05)', 'rgba(6,11,20,0)']}
          locations={[0, 0.2, 0.62, 1]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.liquidTopSheen}
        />
        <LinearGradient
          pointerEvents="none"
          colors={['rgba(96,165,250,0)', 'rgba(56,189,248,0.1)', 'rgba(37,99,235,0.04)', 'rgba(6,11,20,0)']}
          locations={[0, 0.28, 0.66, 1]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0.6 }}
          style={styles.liquidRefractionBand}
        />
        <LinearGradient
          pointerEvents="none"
          colors={['rgba(6,11,20,0)', 'rgba(96,165,250,0.045)', 'rgba(6,11,20,0)']}
          locations={[0, 0.58, 1]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.liquidLowerLens}
        />
        <Box pointerEvents="none" style={[styles.liquidInnerRim, rimRadiusStyle, { borderColor: rimBorderColor }]} />
      </Box>
    );
  }

  return (
    <Box pointerEvents="none" style={StyleSheet.absoluteFill}>
      <LinearGradient
        pointerEvents="none"
        colors={['rgba(255,255,255,0)', 'rgba(255,255,255,0.28)', 'rgba(255,255,255,0.11)', 'rgba(255,255,255,0)']}
        locations={[0, 0.2, 0.62, 1]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.liquidTopSheen}
      />
      <LinearGradient
        pointerEvents="none"
        colors={['rgba(56,189,248,0)', 'rgba(56,189,248,0.16)', 'rgba(37,99,235,0.075)', 'rgba(255,255,255,0)']}
        locations={[0, 0.28, 0.66, 1]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0.6 }}
        style={styles.liquidRefractionBand}
      />
      <LinearGradient
        pointerEvents="none"
        colors={['rgba(255,255,255,0)', 'rgba(37,99,235,0.08)', 'rgba(37,99,235,0)']}
        locations={[0, 0.58, 1]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.liquidLowerLens}
      />
      <Box pointerEvents="none" style={[styles.liquidInnerRim, rimRadiusStyle, { borderColor: rimBorderColor }]} />
    </Box>
  );
}

function HeaderFadeBackdrop({ tint }: { tint: 'light' | 'dark' }) {
  if (Platform.OS === 'android') {
    return null;
  }

  const colors: LiquidGlassGradientColors = tint === 'dark'
    ? ['rgba(125,211,252,0.1)', 'rgba(96,165,250,0.035)', 'rgba(6,11,20,0)']
    : ['rgba(255,255,255,0.38)', 'rgba(255,255,255,0)'];

  return (
    <LinearGradient
      pointerEvents="none"
      colors={colors}
      locations={tint === 'dark' ? [0, 0.46, 1] : undefined}
      start={{ x: 0, y: 0 }}
      end={{ x: 0, y: 1 }}
      style={StyleSheet.absoluteFill}
    />
  );
}

const styles = StyleSheet.create({
  screenSceneBlurTarget: {
    flex: 1,
  },
  liquidTopSheen: {
    position: 'absolute',
    left: -20,
    right: -20,
    top: 0,
    bottom: 0,
    opacity: 0.6,
  },
  liquidRefractionBand: {
    position: 'absolute',
    left: -32,
    right: -32,
    top: -10,
    bottom: -10,
    opacity: 0.48,
    transform: [{ rotate: '-1.5deg' }],
  },
  liquidLowerLens: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    opacity: 0.44,
  },
  liquidInnerRim: {
    ...StyleSheet.absoluteFillObject,
    borderWidth: StyleSheet.hairlineWidth,
    opacity: 0.9,
  },
  segmentedControlLabelText: {
    fontSize: 14,
    fontWeight: '600',
    lineHeight: 20,
    opacity: 1,
    position: 'relative',
    textAlign: 'center',
    zIndex: 1,
    elevation: 1,
  },
});

type GlassAccentColors = readonly [string, string, ...string[]];

function getGlassAccentColors(mode: ResolvedThemeMode, dim: boolean) {
  const alphaScale = dim ? 0.62 : 1;
  const alpha = (value: number) => Math.round(value * alphaScale * 1000) / 1000;

  if (mode === 'dark') {
    return {
      top: [
        `rgba(96, 165, 250, ${alpha(0.16)})`,
        `rgba(125, 211, 252, ${alpha(0.09)})`,
        'rgba(244, 247, 251, 0)',
      ] as GlassAccentColors,
      cross: [
        'rgba(244, 247, 251, 0)',
        `rgba(125, 211, 252, ${alpha(0.11)})`,
        `rgba(96, 165, 250, ${alpha(0.07)})`,
        'rgba(244, 247, 251, 0)',
      ] as GlassAccentColors,
      bottom: [
        'rgba(244, 247, 251, 0)',
        `rgba(96, 165, 250, ${alpha(0.12)})`,
        `rgba(52, 211, 153, ${alpha(0.055)})`,
      ] as GlassAccentColors,
      warmth: [
        'rgba(244, 247, 251, 0)',
        `rgba(251, 146, 60, ${alpha(0.045)})`,
        'rgba(244, 247, 251, 0)',
      ] as GlassAccentColors,
    };
  }

  return {
    top: [
      `rgba(37, 99, 235, ${alpha(0.24)})`,
      `rgba(96, 165, 250, ${alpha(0.16)})`,
      'rgba(248, 250, 252, 0)',
    ] as GlassAccentColors,
    cross: [
      'rgba(248, 250, 252, 0)',
      `rgba(59, 130, 246, ${alpha(0.18)})`,
      `rgba(14, 165, 233, ${alpha(0.12)})`,
      'rgba(248, 250, 252, 0)',
    ] as GlassAccentColors,
    bottom: [
      'rgba(248, 250, 252, 0)',
      `rgba(96, 165, 250, ${alpha(0.22)})`,
      `rgba(34, 197, 94, ${alpha(0.1)})`,
    ] as GlassAccentColors,
    warmth: [
      'rgba(248, 250, 252, 0)',
      `rgba(251, 146, 60, ${alpha(0.08)})`,
      'rgba(248, 250, 252, 0)',
    ] as GlassAccentColors,
  };
}

function GlassBackgroundAccents({
  appearance,
  dim = false,
  mode,
}: {
  appearance: ThemeAppearance;
  dim?: boolean;
  mode: ResolvedThemeMode;
}) {
  if (appearance.surfaceKind !== 'glass') {
    return null;
  }

  const accentColors = getGlassAccentColors(mode, dim);

  return (
    <Box pointerEvents="none" className="absolute inset-0">
      <LinearGradient
        pointerEvents="none"
        colors={accentColors.top}
        locations={[0, 0.46, 1]}
        start={{ x: 0.72, y: 0 }}
        end={{ x: 0.2, y: 0.9 }}
        style={StyleSheet.absoluteFill}
      />
      <LinearGradient
        pointerEvents="none"
        colors={accentColors.cross}
        locations={[0, 0.42, 0.72, 1]}
        start={{ x: 0, y: 0.12 }}
        end={{ x: 1, y: 0.86 }}
        style={StyleSheet.absoluteFill}
      />
      <LinearGradient
        pointerEvents="none"
        colors={accentColors.bottom}
        locations={[0, 0.54, 1]}
        start={{ x: 0.3, y: 0.36 }}
        end={{ x: 0.7, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <LinearGradient
        pointerEvents="none"
        colors={accentColors.warmth}
        locations={[0, 0.48, 1]}
        start={{ x: 0.98, y: 0.32 }}
        end={{ x: 0.54, y: 0.68 }}
        style={StyleSheet.absoluteFill}
      />
    </Box>
  );
}

function getBadgeSizeClassName(size: 'micro' | 'default') {
  return size === 'micro'
    ? `${screenLayoutTokens.microBadgeClassName} gap-1`
    : `${screenLayoutTokens.badgeClassName} gap-1.5`;
}

interface HeaderTitleBlockProps {
  title: string;
  subtitle?: string;
  className?: string;
  titleLines?: number;
  subtitleLines?: number;
}

interface HeaderActionButtonProps {
  iconName: MaterialSymbolsProps['name'];
  accessibilityLabel: string;
  onPress?: () => void;
  disabled?: boolean;
  tone?: 'accent' | 'neutral' | 'destructive';
  className?: string;
  testID?: string;
}

interface ScreenActionPillProps extends React.ComponentProps<typeof Pressable> {
  className?: string;
  style?: StyleProp<ViewStyle>;
  tone?: 'primary' | 'soft';
  size?: 'sm' | 'md' | 'lg';
  children: React.ReactNode;
}

interface ScreenIconButtonProps extends React.ComponentProps<typeof Pressable> {
  iconName: MaterialSymbolsProps['name'];
  iconSize?: MaterialSymbolsProps['size'];
  size?: 'micro' | 'compact' | 'default';
  iconClassName?: string;
  className?: string;
  style?: StyleProp<ViewStyle>;
  tone?: 'neutral' | 'primary' | 'danger';
  accessibilityLabel: string;
}

interface ScreenIconTileProps {
  iconName: MaterialSymbolsProps['name'];
  children?: React.ReactNode;
  tone?: ThemeTone;
  size?: 'sm' | 'md' | 'lg';
  iconSize?: MaterialSymbolsProps['size'];
  className?: string;
  iconClassName?: string;
  iconColor?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

interface ScreenBannerProps {
  children: React.ReactNode;
  tone?: ThemeTone;
  floating?: boolean;
  forceNativeAndroidBlur?: boolean;
  androidBlurTargetRef?: AndroidBlurTargetRef | null;
  className?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

type ScreenSurfaceTone = ThemeTone | 'danger' | 'default';

interface ScreenSurfaceProps {
  applyGlassFrame?: boolean;
  androidBlurTargetRef?: AndroidBlurTargetRef | null;
  children: React.ReactNode;
  className?: string;
  decorative?: GlassSurfaceDecorative;
  forceNativeAndroidBlur?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  tone?: ScreenSurfaceTone;
  withControlTint?: boolean;
}

interface ScreenPressableSurfaceProps extends React.ComponentProps<typeof Pressable> {
  applyGlassFrame?: boolean;
  children: React.ReactNode;
  className?: string;
  decorative?: GlassSurfaceDecorative;
  style?: React.ComponentProps<typeof Pressable>['style'];
  tone?: ScreenSurfaceTone;
  withControlTint?: boolean;
}

interface ScreenSectionLabelProps {
  children: React.ReactNode;
  className?: string;
  testID?: string;
}

interface ScreenBadgeProps {
  children: React.ReactNode;
  className?: string;
  textClassName?: string;
  style?: StyleProp<ViewStyle>;
  tone?: 'neutral' | 'accent' | 'warning' | 'error' | 'success' | 'info';
  size?: 'micro' | 'default';
  iconName?: MaterialSymbolsProps['name'];
  iconClassName?: string;
  testID?: string;
}

interface ScreenChipProps extends React.ComponentProps<typeof Pressable> {
  label: string;
  className?: string;
  style?: StyleProp<ViewStyle>;
  textClassName?: string;
  tone?: 'neutral' | 'accent' | 'warning' | 'error' | 'success' | 'info';
  size?: 'micro' | 'default';
  leadingIconName?: MaterialSymbolsProps['name'];
  trailingIconName?: MaterialSymbolsProps['name'];
  disabled?: boolean;
}

interface ScreenTextFieldProps extends Omit<InputFieldProps, 'className'> {
  label?: string;
  helperText?: string;
  containerClassName?: string;
  fieldClassName?: string;
  inputClassName?: string;
  labelClassName?: string;
  helperTextClassName?: string;
  size?: 'compact' | 'default' | 'multiline' | 'prominent' | 'prominentMultiline';
}

interface ScreenInlineInputProps extends Omit<InputFieldProps, 'className' | 'style'> {
  applyGlassFrame?: boolean;
  className?: string;
  style?: StyleProp<ViewStyle>;
  inputClassName?: string;
  leadingAccessory?: React.ReactNode;
  trailingAccessory?: React.ReactNode;
  containerTestID?: string;
  variant?: 'search' | 'composer';
}

interface ScreenSegmentedControlOption {
  key: string;
  label: string;
  accessibilityLabel?: string;
  testID?: string;
}

interface ScreenSegmentedControlProps {
  options: ScreenSegmentedControlOption[];
  activeKey: string;
  onChange: (key: string) => void;
  className?: string;
  itemClassName?: string;
  testID?: string;
  disabled?: boolean;
}

interface ScreenSheetProps {
  children: React.ReactNode;
  androidBlurTargetRef?: AndroidBlurTargetRef | null;
  className?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

interface ScreenModalOverlayProps {
  children: React.ReactNode;
  className?: string;
  testID?: string;
}

interface ScreenChromeBarProps {
  children: React.ReactNode;
  className?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function ScreenHeaderShell({
  children,
  contentClassName,
  contentStyle,
  floating,
  maxWidthClassName = screenChromeTokens.maxWidthClassName,
  testID,
}: ScreenHeaderShellProps) {
  const insets = useSafeAreaInsets();
  const { appearance, theme } = useResolvedThemeAppearance();
  const blurTarget = React.useContext(GlassBlurTargetContext);
  const setHeaderInset = React.useContext(ScreenHeaderInsetSetterContext);
  const { colors } = theme;
  const isGlass = appearance.surfaceKind === 'glass';
  const isFloating = floating ?? false;
  const shouldUseAndroidMatteHeader = isGlass && shouldUseAndroidGlassMatteFallback();
  const shouldBlurHeader = !shouldUseAndroidMatteHeader
    && (Platform.OS !== 'android' || (isGlass && !isAndroidBlurFallbackRequired() && Boolean(blurTarget)));
  const headerClassName = joinClassNames(
    appearance.classNames.headerShellClassName,
    isGlass && (isAndroidBlurFallbackRequired() || shouldUseAndroidMatteHeader)
      ? theme.resolvedMode === 'dark'
        ? 'bg-background-0/14 dark:bg-background-0/14'
        : 'bg-background-0/82 dark:bg-background-0/82'
      : undefined,
  );
  const handleLayout = React.useCallback((event: LayoutChangeEvent) => {
    if (!isFloating || !setHeaderInset) {
      return;
    }

    setHeaderInset({
      height: event.nativeEvent.layout.height,
      isFloating: true,
    });
  }, [isFloating, setHeaderInset]);

  React.useEffect(() => {
    if (!setHeaderInset) {
      return undefined;
    }

    if (!isFloating) {
      setHeaderInset({ height: 0, isFloating: false });
      return undefined;
    }

    return () => {
      setHeaderInset({ height: 0, isFloating: false });
    };
  }, [isFloating, setHeaderInset]);

  const content = (
    <Box
      testID={testID}
      className={joinClassNames('mx-auto w-full', maxWidthClassName, contentClassName)}
      style={contentStyle}
    >
      {children}
    </Box>
  );

  return (
    <Box
      onLayout={isFloating ? handleLayout : undefined}
      className={joinClassNames(
        'z-10 w-full overflow-hidden',
        isGlass ? undefined : 'border-b',
        isFloating ? 'absolute left-0 right-0 top-0' : undefined,
        appearance.classNames.headerBorderClassName,
      )}
      style={getGlassHeaderFrameStyle(appearance, theme.resolvedMode)}
    >
      {shouldBlurHeader ? (
        <BlurView
          intensity={appearance.effects.headerBlurIntensity}
          tint={getGlassBlurTint(colors.headerBlurTint)}
          blurReductionFactor={isGlass ? undefined : 2}
          {...getAndroidBlurProps(appearance, blurTarget)}
          className={headerClassName}
          style={{ paddingTop: insets.top }}
        >
          {isGlass ? (
            <>
              <HeaderFadeBackdrop tint={colors.headerBlurTint} />
              <GlassSpecular tint={colors.headerBlurTint} />
            </>
          ) : null}
          {content}
        </BlurView>
      ) : (
        <Box className={headerClassName} style={{ paddingTop: insets.top }}>
          {isGlass ? (
            <>
              <HeaderFadeBackdrop tint={colors.headerBlurTint} />
              <GlassSpecular tint={colors.headerBlurTint} />
            </>
          ) : null}
          {content}
        </Box>
      )}
    </Box>
  );
}

export function ScreenRoot({
  children,
  className,
  style,
  testID,
}: ScreenRootProps) {
  const { appearance, theme } = useResolvedThemeAppearance();
  const glassBackgroundBlurTargetRef = React.useRef<View | null>(null);
  const glassSceneBlurTargetRef = React.useRef<View | null>(null);
  const [headerInset, setHeaderInsetState] = React.useState<ScreenHeaderInset>({ height: 0, isFloating: false });
  const { colors } = theme;
  const isGlass = appearance.surfaceKind === 'glass';
  const isFocused = useIsFocused();
  const shouldUseAndroidBlurTarget = isGlass && Platform.OS === 'android' && !isAndroidBlurFallbackRequired();
  const shouldRegisterAndroidBlurTarget = shouldUseAndroidBlurTarget && isFocused;
  const androidGlassBlurTarget = shouldUseAndroidBlurTarget ? glassBackgroundBlurTargetRef : null;
  const setHeaderInset = React.useCallback((nextInset: ScreenHeaderInset) => {
    setHeaderInsetState((currentInset) => getNextScreenHeaderInset(currentInset, nextInset));
  }, []);
  const screenContent = (
    <ScreenHeaderInsetSetterContext.Provider value={setHeaderInset}>
      <ScreenHeaderInsetContext.Provider value={headerInset}>
        <GlassBlurTargetContext.Provider value={androidGlassBlurTarget}>
          {children}
        </GlassBlurTargetContext.Provider>
      </ScreenHeaderInsetContext.Provider>
    </ScreenHeaderInsetSetterContext.Provider>
  );

  React.useEffect(() => {
    if (!shouldRegisterAndroidBlurTarget) {
      return undefined;
    }

    return setActiveAndroidBlurTarget(glassSceneBlurTargetRef);
  }, [shouldRegisterAndroidBlurTarget]);

  return (
    <Box
      testID={testID}
      className={joinClassNames('flex-1', isGlass ? 'overflow-hidden' : undefined, className)}
      style={[{ backgroundColor: colors.background }, style]}
    >
      {isGlass ? <GlassBackgroundAccents appearance={appearance} mode={theme.resolvedMode} /> : null}
      {shouldUseAndroidBlurTarget ? (
        <>
          <BlurTargetView
            testID="screen-glass-blur-target"
            ref={glassBackgroundBlurTargetRef}
            pointerEvents="none"
            style={StyleSheet.absoluteFill}
          >
            <GlassBackgroundAccents appearance={appearance} dim mode={theme.resolvedMode} />
          </BlurTargetView>
          <BlurTargetView
            testID="screen-glass-scene-blur-target"
            ref={glassSceneBlurTargetRef}
            pointerEvents="box-none"
            style={styles.screenSceneBlurTarget}
          >
            {screenContent}
          </BlurTargetView>
        </>
      ) : isGlass ? (
        <>
          <GlassBackgroundAccents appearance={appearance} dim mode={theme.resolvedMode} />
          {screenContent}
        </>
      ) : (
        screenContent
      )}
    </Box>
  );
}

export function ScreenAndroidContentBlurTarget({
  blurTargetRef,
  children,
  style,
  testID,
}: ScreenAndroidContentBlurTargetProps) {
  const { appearance } = useResolvedThemeAppearance();
  const shouldUseAndroidBlurTarget = appearance.surfaceKind === 'glass'
    && Platform.OS === 'android'
    && !isAndroidBlurFallbackRequired();

  if (shouldUseAndroidBlurTarget) {
    return (
      <BlurTargetView
        ref={blurTargetRef}
        collapsable={false}
        testID={testID}
        style={style}
      >
        {children}
      </BlurTargetView>
    );
  }

  return (
    <Box testID={testID} style={style}>
      {children}
    </Box>
  );
}

export function ScreenContent({
  children,
  className,
  extraBottomInset = 0,
  includeBottomSafeArea = false,
  respectFloatingHeader = true,
  style,
  testID,
}: ScreenContentProps) {
  const insets = useSafeAreaInsets();
  const floatingHeaderInset = useFloatingHeaderInset();
  const nativeBottomInset = includeBottomSafeArea
    ? getNativeBottomSafeAreaInset(insets.bottom)
    : 0;
  const resolvedExtraBottomInset = Math.max(0, extraBottomInset);
  const floatingHeaderInsetStyle = respectFloatingHeader && floatingHeaderInset > 0
    ? { paddingTop: floatingHeaderInset }
    : undefined;
  const bottomInsetStyle = nativeBottomInset > 0 || resolvedExtraBottomInset > 0
    ? { paddingBottom: screenLayoutMetrics.contentBottomInset + nativeBottomInset + resolvedExtraBottomInset }
    : undefined;
  const insetStyle = floatingHeaderInsetStyle || bottomInsetStyle
    ? [floatingHeaderInsetStyle, bottomInsetStyle]
    : undefined;

  return (
    <Box
      testID={testID}
      className={joinClassNames(`mx-auto w-full ${screenChromeTokens.maxWidthClassName} ${screenChromeTokens.contentHorizontalPaddingClassName} ${screenChromeTokens.contentBottomPaddingClassName}`, className)}
      style={insetStyle ? [...insetStyle, style] : style}
    >
      {children}
    </Box>
  );
}

export function ScreenStack({
  children,
  className,
  testID,
  gap = 'default',
}: ScreenStackProps) {
  const gapClassName = gap === 'compact'
    ? screenLayoutTokens.stackGapCompactClassName
    : gap === 'loose'
      ? screenLayoutTokens.stackGapLooseClassName
      : screenLayoutTokens.stackGapClassName;

  return (
    <Box testID={testID} className={joinClassNames(gapClassName, className)}>
      {children}
    </Box>
  );
}

export function ScreenCard({
  children,
  className,
  decorative = 'standard',
  style,
  testID,
  variant = 'surface',
  padding = variant === 'inset' ? 'compact' : 'default',
  tone = 'default',
  dashed = false,
}: ScreenCardProps) {
  const { appearance, theme } = useResolvedThemeAppearance();
  const baseClassName = variant === 'inset'
    ? appearance.classNames.insetCardClassName
    : appearance.classNames.cardClassName;
  const glassBackdropClassName = getGlassBackdropContainerClassName(appearance);
  const paddingClassName = padding === 'none'
    ? undefined
    : padding === 'compact'
      ? screenLayoutTokens.cardPaddingCompactClassName
      : padding === 'large'
        ? screenLayoutTokens.cardPaddingLargeClassName
        : screenLayoutTokens.cardPaddingClassName;
  const toneClassName = tone === 'accent'
    ? appearance.classNames.toneClassNameByTone.accent.surfaceClassName
    : tone === 'warning'
      ? appearance.classNames.toneClassNameByTone.warning.surfaceClassName
      : tone === 'error'
        ? appearance.classNames.toneClassNameByTone.error.surfaceClassName
        : undefined;
  const glassCornerRadiusStyle = getGlassCornerRadiusStyle(baseClassName, className);
  const glassFrameStyle = getGlassSurfaceFrameStyle(appearance, theme.resolvedMode, theme.colors, tone, dashed, glassCornerRadiusStyle);

  return (
    <Box
      testID={testID}
      className={joinClassNames(baseClassName, glassBackdropClassName, paddingClassName, dashed && appearance.surfaceKind !== 'glass' ? 'border-dashed' : undefined, toneClassName, className)}
      style={glassFrameStyle ? [glassFrameStyle, style] : style}
    >
      <GlassSurfaceBackdrop appearance={appearance} tint={theme.colors.headerBlurTint} decorative={decorative} cornerRadiusStyle={glassCornerRadiusStyle} />
      {children}
    </Box>
  );
}

export function ScreenPressableCard({
  children,
  className,
  decorative = 'standard',
  style,
  testID,
  variant = 'surface',
  padding = variant === 'inset' ? 'compact' : 'default',
  tone = 'default',
  dashed = false,
  disabled,
  accessibilityRole,
  ...props
}: ScreenPressableCardProps) {
  const { appearance, theme } = useResolvedThemeAppearance();
  const baseClassName = variant === 'inset'
    ? appearance.classNames.insetCardClassName
    : appearance.classNames.cardClassName;
  const glassBackdropClassName = getGlassBackdropContainerClassName(appearance);
  const paddingClassName = padding === 'none'
    ? undefined
    : padding === 'compact'
      ? screenLayoutTokens.cardPaddingCompactClassName
      : padding === 'large'
        ? screenLayoutTokens.cardPaddingLargeClassName
        : screenLayoutTokens.cardPaddingClassName;
  const toneClassName = tone === 'accent'
    ? appearance.classNames.toneClassNameByTone.accent.surfaceClassName
    : tone === 'warning'
      ? appearance.classNames.toneClassNameByTone.warning.surfaceClassName
      : tone === 'error'
        ? appearance.classNames.toneClassNameByTone.error.surfaceClassName
        : undefined;
  const glassCornerRadiusStyle = getGlassCornerRadiusStyle(baseClassName, className);
  const glassFrameStyle = getGlassSurfaceFrameStyle(appearance, theme.resolvedMode, theme.colors, tone, dashed, glassCornerRadiusStyle);

  return (
    <Pressable
      testID={testID}
      accessibilityRole={accessibilityRole ?? 'button'}
      disabled={disabled}
      className={joinClassNames(baseClassName, glassBackdropClassName, paddingClassName, dashed && appearance.surfaceKind !== 'glass' ? 'border-dashed' : undefined, toneClassName, disabled ? 'opacity-55' : 'active:opacity-80', className)}
      style={glassFrameStyle ? [glassFrameStyle, style] : style}
      {...props}
    >
      <GlassSurfaceBackdrop appearance={appearance} tint={theme.colors.headerBlurTint} decorative={decorative} cornerRadiusStyle={glassCornerRadiusStyle} />
      <GlassControlTint appearance={appearance} colors={theme.colors} mode={theme.resolvedMode} tone={tone} />
      {children}
    </Pressable>
  );
}

export function HeaderTitleBlock({
  title,
  subtitle,
  className,
  titleLines = 2,
  subtitleLines = 2,
}: HeaderTitleBlockProps) {
  return (
    <Box className={joinClassNames('min-w-0 flex-1', className)}>
      <Text numberOfLines={titleLines} className={composeTextRole('screenTitle', 'leading-7')}>
        {title}
      </Text>
      {subtitle ? (
        <Text numberOfLines={subtitleLines} className={composeTextRole('bodyMuted', 'mt-1')}>
          {subtitle}
        </Text>
      ) : null}
    </Box>
  );
}

export function HeaderActionPlaceholder() {
  return <Box className={`${screenChromeTokens.headerActionClassName} shrink-0`} />;
}

export function HeaderActionButton({
  iconName,
  accessibilityLabel,
  onPress,
  disabled = false,
  tone = 'neutral',
  className,
  testID,
}: HeaderActionButtonProps) {
  const { appearance, theme } = useResolvedThemeAppearance();
  const isDisabled = disabled || !onPress;
  const containerClassName = appearance.classNames.headerActionClassName;
  const iconClassName = tone === 'accent'
    ? 'text-primary-600 dark:text-primary-300'
    : tone === 'destructive'
      ? 'text-error-600 dark:text-error-300'
      : 'text-typography-700 dark:text-typography-200';
  const iconColor = tone === 'accent'
    ? getThemeToneIconColor('primary', theme.resolvedMode)
    : tone === 'destructive'
      ? getThemeToneIconColor('error', theme.resolvedMode)
      : getThemeToneIconColor('neutral', theme.resolvedMode);
  const glassTone = tone === 'accent'
    ? 'primary'
    : tone === 'destructive'
      ? 'danger'
      : 'default';
  const glassCornerRadiusStyle = getGlassCornerRadiusStyle('rounded-full', className);

  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={isDisabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      hitSlop={8}
      className={joinClassNames(`${screenChromeTokens.headerActionClassName} shrink-0 items-center justify-center rounded-full ${containerClassName} ${appearance.surfaceKind === 'glass' ? 'relative overflow-hidden' : ''} ${isDisabled ? 'opacity-55' : 'active:opacity-80'}`, className)}
      style={appearance.surfaceKind === 'glass'
        ? getGlassSurfaceFrameStyle(appearance, theme.resolvedMode, theme.colors, glassTone, false, glassCornerRadiusStyle)
        : undefined}
    >
      <GlassSurfaceBackdrop appearance={appearance} tint={theme.colors.headerBlurTint} decorative="tint" cornerRadiusStyle={glassCornerRadiusStyle} />
      <GlassControlTint appearance={appearance} colors={theme.colors} mode={theme.resolvedMode} tone={glassTone} />
      <MaterialSymbols name={iconName} size={screenChromeTokens.headerActionIconSizePx} className={iconClassName} color={iconColor} />
    </Pressable>
  );
}

export function HeaderBackButton({
  onPress,
  accessibilityLabel,
  testID,
}: {
  onPress?: () => void;
  accessibilityLabel: string;
  testID?: string;
}) {
  if (!onPress) {
    return <HeaderActionPlaceholder />;
  }

  return (
    <HeaderActionButton
      testID={testID}
      iconName="arrow-back-ios-new"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      tone="neutral"
    />
  );
}

export function ScreenActionPill({
  className,
  tone = 'soft',
  size = 'md',
  children,
  disabled,
  accessibilityRole,
  style,
  ...props
}: ScreenActionPillProps) {
  const { appearance, theme } = useResolvedThemeAppearance();
  const baseClassName = joinClassNames(
    buttonLayoutTokens.screenActionPillClassNameBySize[size],
    tone === 'primary'
      ? appearance.classNames.primaryActionPillClassName
      : appearance.classNames.softActionPillClassName,
  );
  const glassCornerRadiusStyle = getGlassCornerRadiusStyle(baseClassName, className);
  const glassFrameStyle = getGlassActionPillStyle(appearance, theme.resolvedMode, theme.colors, tone, glassCornerRadiusStyle);

  return (
    <Pressable
      accessibilityRole={accessibilityRole ?? 'button'}
      disabled={disabled}
      className={joinClassNames(
        baseClassName,
        appearance.surfaceKind === 'glass' ? 'relative overflow-hidden' : undefined,
        disabled ? 'opacity-55' : 'active:opacity-80',
        className,
      )}
      style={glassFrameStyle ? [glassFrameStyle, style] : style}
      {...props}
    >
      <GlassSurfaceBackdrop appearance={appearance} tint={theme.colors.headerBlurTint} decorative="tint" cornerRadiusStyle={glassCornerRadiusStyle} />
      <GlassControlTint appearance={appearance} colors={theme.colors} mode={theme.resolvedMode} tone={tone === 'primary' ? 'primary' : 'default'} />
      {children}
    </Pressable>
  );
}

export function ScreenIconButton({
  iconName,
  iconSize = 'md',
  size = 'default',
  iconClassName,
  className,
  tone = 'neutral',
  accessibilityLabel,
  disabled,
  style,
  ...props
}: ScreenIconButtonProps) {
  const { appearance, theme } = useResolvedThemeAppearance();
  const toneClassName = tone === 'danger'
    ? appearance.classNames.toneClassNameByTone.error.iconTileClassName
    : appearance.classNames.iconButtonClassName;
  const resolvedIconClassName = tone === 'primary'
    ? 'text-primary-500'
    : tone === 'danger'
      ? appearance.classNames.toneClassNameByTone.error.iconClassName
      : 'text-typography-700 dark:text-typography-200';
  const mergedIconClassName = joinClassNames(resolvedIconClassName, iconClassName);
  const resolvedIconColor = getThemeToneIconColor(
    tone === 'danger' ? 'error' : tone === 'primary' ? 'primary' : 'neutral',
    theme.resolvedMode,
  );
  const explicitIconColor = getExplicitIconColorFromClassName(mergedIconClassName, theme.colors);
  const sizeClassName = buttonLayoutTokens.screenIconButtonClassNameBySize[size];
  const glassCornerRadiusStyle = getGlassCornerRadiusStyle(sizeClassName, screenLayoutTokens.iconButtonClassName, toneClassName, className);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      hitSlop={8}
      className={joinClassNames(
        sizeClassName,
        screenLayoutTokens.iconButtonClassName,
        toneClassName,
        appearance.surfaceKind === 'glass' ? 'relative overflow-hidden' : undefined,
        disabled ? 'opacity-55' : 'active:opacity-70',
        className,
      )}
      style={appearance.surfaceKind === 'glass'
        ? [getGlassSurfaceFrameStyle(appearance, theme.resolvedMode, theme.colors, tone, false, glassCornerRadiusStyle), style]
        : style}
      {...props}
    >
      <GlassSurfaceBackdrop appearance={appearance} tint={theme.colors.headerBlurTint} decorative="tint" cornerRadiusStyle={glassCornerRadiusStyle} />
      <GlassControlTint appearance={appearance} colors={theme.colors} mode={theme.resolvedMode} tone={tone} />
      <MaterialSymbols
        name={iconName}
        size={iconSize}
        className={mergedIconClassName}
        color={explicitIconColor ?? resolvedIconColor}
      />
    </Pressable>
  );
}

export function ScreenIconTile({
  iconName,
  children,
  tone = 'accent',
  size = 'md',
  iconSize = 'lg',
  className,
  iconClassName,
  iconColor,
  style,
  testID,
}: ScreenIconTileProps) {
  const theme = useTheme();
  const appearance = theme.appearance ?? getThemeAppearance(theme.themeId ?? DEFAULT_THEME_ID, theme.resolvedMode ?? 'light');
  const toneClassNames = appearance.classNames.toneClassNameByTone[tone];
  const resolvedIconColor = iconColor ?? getThemeToneIconColor(tone, theme.resolvedMode ?? 'light');
  const sizeClassName = size === 'sm'
    ? 'h-8 w-8 rounded-full'
    : size === 'lg'
      ? 'h-11 w-11 rounded-2xl'
      : 'h-9 w-9 rounded-xl';
  const glassCornerRadiusStyle = getGlassCornerRadiusStyle(sizeClassName, toneClassNames.iconTileClassName, className);

  return (
    <Box
      testID={testID}
      className={joinClassNames(
        sizeClassName,
        'items-center justify-center overflow-hidden',
        appearance.surfaceKind === 'glass' ? 'relative' : undefined,
        toneClassNames.iconTileClassName,
        className,
      )}
      style={appearance.surfaceKind === 'glass'
        ? [getGlassSurfaceFrameStyle(appearance, theme.resolvedMode ?? 'light', theme.colors, tone, false, glassCornerRadiusStyle), style]
        : style}
    >
      <GlassSurfaceBackdrop appearance={appearance} tint={theme.colors.headerBlurTint} decorative="tint" cornerRadiusStyle={glassCornerRadiusStyle} />
      <GlassControlTint appearance={appearance} colors={theme.colors} mode={theme.resolvedMode ?? 'light'} tone={tone} />
      {children ?? (
        <MaterialSymbols
          name={iconName}
          size={iconSize}
          className={joinClassNames(toneClassNames.iconClassName, iconClassName)}
          color={resolvedIconColor}
        />
      )}
    </Box>
  );
}

export function ScreenBanner({
  children,
  androidBlurTargetRef,
  tone = 'neutral',
  floating = false,
  forceNativeAndroidBlur = false,
  className,
  style,
  testID,
}: ScreenBannerProps) {
  const { appearance, theme } = useResolvedThemeAppearance();
  const baseClassName = floating
    ? appearance.classNames.floatingBannerClassName
    : `${radiusTokens.md} border px-3 py-2.5 ${appearance.classNames.toneClassNameByTone[tone].surfaceClassName}`;
  const glassCornerRadiusStyle = getGlassCornerRadiusStyle(baseClassName, className);
  const glassFrameStyle = getGlassSurfaceFrameStyle(appearance, theme.resolvedMode, theme.colors, tone, false, glassCornerRadiusStyle);

  return (
    <Box
      testID={testID}
      className={joinClassNames(baseClassName, appearance.surfaceKind === 'glass' ? 'relative overflow-hidden' : undefined, className)}
      style={glassFrameStyle ? [glassFrameStyle, style] : style}
    >
      {appearance.surfaceKind === 'glass' ? (
        <>
          <GlassSurfaceBackdrop
            appearance={appearance}
            tint={theme.colors.headerBlurTint}
            cornerRadiusStyle={glassCornerRadiusStyle}
            forceNativeAndroidBlur={forceNativeAndroidBlur}
            androidBlurTargetRef={androidBlurTargetRef}
          />
          <GlassControlTint appearance={appearance} colors={theme.colors} mode={theme.resolvedMode} tone={tone} />
        </>
      ) : null}
      {children}
    </Box>
  );
}

export function ScreenSurface({
  applyGlassFrame = true,
  androidBlurTargetRef,
  children,
  className,
  decorative = 'tint',
  forceNativeAndroidBlur = false,
  style,
  testID,
  tone = 'default',
  withControlTint = false,
}: ScreenSurfaceProps) {
  const { appearance, theme } = useResolvedThemeAppearance();
  const shouldUseGlassChrome = applyGlassFrame && appearance.surfaceKind === 'glass';
  const glassCornerRadiusStyle = getGlassCornerRadiusStyle(className);
  const glassFrameStyle = shouldUseGlassChrome
    ? getGlassSurfaceFrameStyle(appearance, theme.resolvedMode, theme.colors, tone, false, glassCornerRadiusStyle)
    : undefined;

  return (
    <Box
      testID={testID}
      className={joinClassNames(
        shouldUseGlassChrome ? 'relative overflow-hidden' : undefined,
        className,
      )}
      style={glassFrameStyle ? [glassFrameStyle, style] : style}
    >
      {shouldUseGlassChrome ? (
        <GlassSurfaceBackdrop
          appearance={appearance}
          tint={theme.colors.headerBlurTint}
          decorative={decorative}
          cornerRadiusStyle={glassCornerRadiusStyle}
          forceNativeAndroidBlur={forceNativeAndroidBlur}
          androidBlurTargetRef={androidBlurTargetRef}
        />
      ) : null}
      {shouldUseGlassChrome && withControlTint ? <GlassControlTint appearance={appearance} colors={theme.colors} mode={theme.resolvedMode} tone={tone} /> : null}
      {children}
    </Box>
  );
}

export function ScreenPressableSurface({
  applyGlassFrame = true,
  children,
  className,
  decorative = 'tint',
  style,
  tone = 'default',
  withControlTint = false,
  ...props
}: ScreenPressableSurfaceProps) {
  const { appearance, theme } = useResolvedThemeAppearance();
  const shouldUseGlassChrome = applyGlassFrame && appearance.surfaceKind === 'glass';
  const glassCornerRadiusStyle = getGlassCornerRadiusStyle(className);
  const glassFrameStyle = shouldUseGlassChrome
    ? getGlassSurfaceFrameStyle(appearance, theme.resolvedMode, theme.colors, tone, false, glassCornerRadiusStyle)
    : undefined;
  const combinedStyle = glassFrameStyle
    ? typeof style === 'function'
      ? (state: Parameters<NonNullable<typeof style>>[0]) => [glassFrameStyle, style(state)]
      : [glassFrameStyle, style]
    : style;

  return (
    <Pressable
      className={joinClassNames(
        shouldUseGlassChrome ? 'relative overflow-hidden' : undefined,
        className,
      )}
      style={combinedStyle}
      {...props}
    >
      {shouldUseGlassChrome ? <GlassSurfaceBackdrop appearance={appearance} tint={theme.colors.headerBlurTint} decorative={decorative} cornerRadiusStyle={glassCornerRadiusStyle} /> : null}
      {shouldUseGlassChrome && withControlTint ? <GlassControlTint appearance={appearance} colors={theme.colors} mode={theme.resolvedMode} tone={tone} /> : null}
      {children}
    </Pressable>
  );
}

export function ScreenSectionLabel({
  children,
  className,
  testID,
}: ScreenSectionLabelProps) {
  return (
    <Text testID={testID} className={joinClassNames(screenLayoutTokens.sectionLabelClassName, className)}>
      {children}
    </Text>
  );
}

export function ScreenBadge({
  children,
  className,
  textClassName,
  style,
  tone = 'neutral',
  size = 'default',
  iconName,
  iconClassName,
  testID,
}: ScreenBadgeProps) {
  const iconSize = size === 'micro' ? 'xs' : 'sm';
  const { appearance, theme } = useResolvedThemeAppearance();
  const toneTokens = appearance.classNames.toneClassNameByTone[tone];
  const badgeSizeClassName = getBadgeSizeClassName(size);
  const glassCornerRadiusStyle = getGlassCornerRadiusStyle(badgeSizeClassName, toneTokens.badgeClassName, className);

  return (
    <Box
      testID={testID}
      className={joinClassNames(
        'flex-row items-center',
        appearance.surfaceKind === 'glass' ? undefined : 'border',
        appearance.surfaceKind === 'glass' ? 'relative overflow-hidden' : undefined,
        badgeSizeClassName,
        toneTokens.badgeClassName,
        className,
      )}
      style={appearance.surfaceKind === 'glass'
        ? [getGlassSurfaceFrameStyle(appearance, theme.resolvedMode, theme.colors, tone, false, glassCornerRadiusStyle), style]
        : style}
    >
      <GlassSurfaceBackdrop appearance={appearance} tint={theme.colors.headerBlurTint} decorative="tint" cornerRadiusStyle={glassCornerRadiusStyle} />
      <GlassControlTint appearance={appearance} colors={theme.colors} mode={theme.resolvedMode} tone={tone} />
      {iconName ? (
        <MaterialSymbols
          name={iconName}
          size={iconSize}
          className={joinClassNames(toneTokens.textClassName, iconClassName)}
        />
      ) : null}
      <Text
        className={joinClassNames(
          composeTextRole(size === 'micro' ? 'eyebrow' : 'chip'),
          toneTokens.textClassName,
          textClassName,
        )}
      >
        {children}
      </Text>
    </Box>
  );
}

export function ScreenChip({
  label,
  className,
  textClassName,
  style,
  tone = 'neutral',
  size = 'default',
  leadingIconName,
  trailingIconName,
  disabled = false,
  accessibilityRole,
  onPress,
  ...props
}: ScreenChipProps) {
  const iconSize = size === 'micro' ? 'xs' : 'sm';
  const { appearance, theme } = useResolvedThemeAppearance();
  const toneTokens = appearance.classNames.toneClassNameByTone[tone];
  const badgeSizeClassName = getBadgeSizeClassName(size);
  const glassCornerRadiusStyle = getGlassCornerRadiusStyle(badgeSizeClassName, toneTokens.badgeClassName, className);
  const glassFrameStyle = getGlassSurfaceFrameStyle(appearance, theme.resolvedMode, theme.colors, tone, false, glassCornerRadiusStyle);
  const content = (
    <>
      {leadingIconName ? (
        <MaterialSymbols name={leadingIconName} size={iconSize} className={toneTokens.textClassName} />
      ) : null}
      <Text
        numberOfLines={1}
        className={joinClassNames(composeTextRole('chip', 'min-w-0 shrink'), toneTokens.textClassName, textClassName)}
      >
        {label}
      </Text>
      {trailingIconName ? (
        <MaterialSymbols name={trailingIconName} size={iconSize} className={toneTokens.textClassName} />
      ) : null}
    </>
  );

  if (!onPress) {
    return (
      <Box
        className={joinClassNames(
          'max-w-full shrink flex-row items-center',
          appearance.surfaceKind === 'glass' ? undefined : 'border',
          appearance.surfaceKind === 'glass' ? 'relative overflow-hidden' : undefined,
          badgeSizeClassName,
          toneTokens.badgeClassName,
          className,
        )}
        style={glassFrameStyle ? [glassFrameStyle, style] : style}
      >
        <GlassSurfaceBackdrop appearance={appearance} tint={theme.colors.headerBlurTint} decorative="tint" cornerRadiusStyle={glassCornerRadiusStyle} />
        <GlassControlTint appearance={appearance} colors={theme.colors} mode={theme.resolvedMode} tone={tone} />
        {content}
      </Box>
    );
  }

  return (
    <Pressable
      accessibilityRole={accessibilityRole ?? 'button'}
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      className={joinClassNames(
        'max-w-full shrink flex-row items-center',
        appearance.surfaceKind === 'glass' ? undefined : 'border',
        appearance.surfaceKind === 'glass' ? 'relative overflow-hidden' : undefined,
        badgeSizeClassName,
        toneTokens.badgeClassName,
        disabled ? 'opacity-60' : 'active:opacity-70',
        className,
      )}
      style={glassFrameStyle ? [glassFrameStyle, style] : style}
      {...props}
    >
      <GlassSurfaceBackdrop appearance={appearance} tint={theme.colors.headerBlurTint} decorative="tint" cornerRadiusStyle={glassCornerRadiusStyle} />
      <GlassControlTint appearance={appearance} colors={theme.colors} mode={theme.resolvedMode} tone={tone} />
      {content}
    </Pressable>
  );
}

export function ScreenTextField({
  label,
  helperText,
  containerClassName,
  fieldClassName,
  inputClassName,
  labelClassName,
  helperTextClassName,
  size = 'default',
  multiline,
  placeholderTextColor,
  testID,
  ...props
}: ScreenTextFieldProps) {
  const { appearance, theme } = useResolvedThemeAppearance();
  const isProminent = size === 'prominent' || size === 'prominentMultiline';
  const isMultiline = size === 'multiline' || size === 'prominentMultiline' || multiline === true;
  const fieldShellClassName = size === 'compact'
    ? appearance.classNames.compactTextFieldClassName
    : size === 'prominent'
      ? appearance.classNames.prominentTextFieldClassName
    : isMultiline
      ? isProminent
        ? appearance.classNames.prominentMultilineTextFieldClassName
        : appearance.classNames.multilineTextFieldClassName
      : appearance.classNames.textFieldClassName;
  const inputBaseClassName = isMultiline
    ? isProminent
      ? 'min-h-80 flex-1 px-4 py-4 text-base leading-7 text-typography-900 dark:text-typography-100'
      : 'min-h-40 px-3 py-3 text-base leading-6 text-typography-900 dark:text-typography-100'
    : isProminent
      ? 'w-full min-h-6 px-0 py-3 text-base leading-6 text-typography-900 dark:text-typography-100'
      : 'min-h-0 h-full px-0 py-0 text-base text-typography-900 dark:text-typography-100';
  const glassCornerRadiusStyle = getGlassCornerRadiusStyle(fieldShellClassName, fieldClassName);

  return (
    <Box className={containerClassName}>
      {label ? (
        <Text className={joinClassNames(screenLayoutTokens.fieldLabelClassName, 'mb-2', labelClassName)}>
          {label}
        </Text>
      ) : null}
      <Input
        className={joinClassNames(
          fieldShellClassName,
          appearance.surfaceKind === 'glass' ? 'relative overflow-hidden' : undefined,
          fieldClassName,
        )}
        style={getGlassSurfaceFrameStyle(appearance, theme.resolvedMode, theme.colors, 'default', false, glassCornerRadiusStyle)}
      >
        <GlassSurfaceBackdrop appearance={appearance} tint={theme.colors.headerBlurTint} cornerRadiusStyle={glassCornerRadiusStyle} />
        <InputField
          {...props}
          testID={testID}
          multiline={isMultiline}
          textAlignVertical={isMultiline ? 'top' : props.textAlignVertical}
          placeholderTextColor={placeholderTextColor ?? typographyColors[500]}
          className={joinClassNames(inputBaseClassName, inputClassName)}
        />
      </Input>
      {helperText ? (
        <Text className={joinClassNames(composeTextRole('caption', 'mt-2'), helperTextClassName)}>
          {helperText}
        </Text>
      ) : null}
    </Box>
  );
}

export function ScreenInlineInput({
  applyGlassFrame = true,
  className,
  style,
  inputClassName,
  leadingAccessory,
  trailingAccessory,
  containerTestID,
  variant = 'search',
  placeholderTextColor,
  testID,
  ...props
}: ScreenInlineInputProps) {
  const { appearance, theme } = useResolvedThemeAppearance();
  const fieldShellClassName = variant === 'composer'
    ? appearance.classNames.composerInlineFieldClassName
    : appearance.classNames.searchInlineFieldClassName;
  const inputBaseClassName = variant === 'composer'
    ? screenLayoutTokens.composerInlineInputClassName
    : screenLayoutTokens.searchInlineInputClassName;
  const shouldUseGlassFrame = appearance.surfaceKind === 'glass' && applyGlassFrame;
  const glassCornerRadiusStyle = getGlassCornerRadiusStyle(fieldShellClassName, className);

  return (
    <Box
      testID={containerTestID}
      className={joinClassNames(
        fieldShellClassName,
        shouldUseGlassFrame ? 'relative overflow-hidden' : undefined,
        className,
      )}
      style={shouldUseGlassFrame
        ? [getGlassSurfaceFrameStyle(appearance, theme.resolvedMode, theme.colors, 'default', false, glassCornerRadiusStyle), style]
        : style}
    >
      {shouldUseGlassFrame ? <GlassSurfaceBackdrop appearance={appearance} tint={theme.colors.headerBlurTint} decorative="tint" cornerRadiusStyle={glassCornerRadiusStyle} /> : null}
      {leadingAccessory ? <Box className="shrink-0">{leadingAccessory}</Box> : null}
      <Input className={joinClassNames(screenLayoutTokens.inlineInputShellClassName, leadingAccessory ? 'ml-2' : undefined)}>
        <InputField
          {...props}
          testID={testID}
          placeholderTextColor={placeholderTextColor ?? typographyColors[400]}
          className={joinClassNames(inputBaseClassName, inputClassName)}
        />
      </Input>
      {trailingAccessory ? <Box className="ml-2 shrink-0">{trailingAccessory}</Box> : null}
    </Box>
  );
}

export function ScreenSegmentedControl({
  options,
  activeKey,
  onChange,
  className,
  itemClassName,
  testID,
  disabled = false,
}: ScreenSegmentedControlProps) {
  const { appearance, theme } = useResolvedThemeAppearance();
  const isGlass = appearance.surfaceKind === 'glass';
  const glassCornerRadiusStyle = getGlassCornerRadiusStyle(appearance.classNames.segmentedControlClassName, className);
  const getGlassLabelColor = (isActive: boolean) => {
    if (!isActive) {
      return theme.colors.textSecondary;
    }

    return theme.resolvedMode === 'dark'
      ? semanticColorTokens.primary[100]
      : semanticColorTokens.primary[700];
  };
  const renderLabel = (option: ScreenSegmentedControlOption, isActive: boolean) => {
    const labelKey = `${option.key}-${isActive ? 'active' : 'inactive'}-label`;

    if (isGlass) {
      return (
        <RNText
          key={labelKey}
          numberOfLines={1}
          style={[styles.segmentedControlLabelText, { color: getGlassLabelColor(isActive) }]}
        >
          {option.label}
        </RNText>
      );
    }

    return (
      <Text
        key={labelKey}
        numberOfLines={1}
        className={composeTextRole(
          'action',
          `text-center ${isActive
            ? getThemeActionContentClassName(appearance, 'primary')
            : 'text-typography-600 dark:text-typography-300'}`,
        )}
      >
        {option.label}
      </Text>
    );
  };

  return (
    <Box
      testID={testID}
      accessibilityRole="tablist"
      className={joinClassNames(
        appearance.classNames.segmentedControlClassName,
        isGlass ? 'relative overflow-hidden' : undefined,
        disabled ? 'opacity-60' : undefined,
        className,
      )}
      style={getGlassSurfaceFrameStyle(appearance, theme.resolvedMode, theme.colors, 'default', false, glassCornerRadiusStyle)}
    >
      <GlassSurfaceBackdrop appearance={appearance} tint={theme.colors.headerBlurTint} decorative="tint" cornerRadiusStyle={glassCornerRadiusStyle} />
      {options.map((option) => {
        const isActive = activeKey === option.key;
        const activeCornerRadiusStyle = getGlassCornerRadiusStyle(
          screenLayoutTokens.segmentedControlItemClassName,
          isActive ? appearance.classNames.segmentedControlActiveItemClassName : 'bg-transparent',
          itemClassName,
        );

        return (
          <Pressable
            key={option.key}
            testID={option.testID}
            onPress={() => {
              if (!disabled) {
                onChange(option.key);
              }
            }}
            disabled={disabled}
            accessibilityRole="tab"
            accessibilityLabel={option.accessibilityLabel || option.label}
            accessibilityState={{ selected: isActive, disabled }}
            className={joinClassNames(
              screenLayoutTokens.segmentedControlItemClassName,
              isActive
                ? appearance.classNames.segmentedControlActiveItemClassName
                : 'bg-transparent',
              itemClassName,
            )}
            style={isGlass && isActive
              ? getGlassSurfaceFrameStyle(appearance, theme.resolvedMode, theme.colors, 'primary', true, activeCornerRadiusStyle)
              : undefined}
          >
            {renderLabel(option, isActive)}
          </Pressable>
        );
      })}
    </Box>
  );
}

export function ScreenChromeBar({
  children,
  className,
  style,
  testID,
}: ScreenChromeBarProps) {
  const { appearance, theme } = useResolvedThemeAppearance();
  const glassCornerRadiusStyle = getGlassCornerRadiusStyle(appearance.classNames.bottomBarClassName, className);

  return (
    <Box
      testID={testID}
      className={joinClassNames(
        appearance.classNames.bottomBarClassName,
        appearance.surfaceKind === 'glass' ? 'relative overflow-hidden' : undefined,
        className,
      )}
      style={appearance.surfaceKind === 'glass'
        ? [getGlassSurfaceFrameStyle(appearance, theme.resolvedMode, theme.colors, 'default', false, glassCornerRadiusStyle), style]
        : style}
    >
      <GlassSurfaceBackdrop appearance={appearance} tint={theme.colors.headerBlurTint} cornerRadiusStyle={glassCornerRadiusStyle} />
      {children}
    </Box>
  );
}

export function ScreenSheet({
  children,
  androidBlurTargetRef,
  className,
  style,
  testID,
}: ScreenSheetProps) {
  const { appearance, theme } = useResolvedThemeAppearance();
  const insets = useSafeAreaInsets();
  const nativeBottomInset = getNativeBottomSafeAreaInset(insets.bottom);
  const bottomInsetStyle = {
    paddingBottom: screenLayoutMetrics.sheetBottomInset + nativeBottomInset,
  };
  const glassCornerRadiusStyle = getGlassCornerRadiusStyle(appearance.classNames.sheetClassName, className);

  return (
    <Box
      testID={testID}
      className={joinClassNames(appearance.classNames.sheetClassName, appearance.surfaceKind === 'glass' ? 'relative overflow-hidden' : undefined, className)}
      style={[
        bottomInsetStyle,
        appearance.surfaceKind === 'glass'
          ? getGlassSurfaceFrameStyle(appearance, theme.resolvedMode, theme.colors, 'default', false, glassCornerRadiusStyle)
          : undefined,
        style,
      ]}
    >
      <GlassSurfaceBackdrop
        appearance={appearance}
        tint={theme.colors.headerBlurTint}
        cornerRadiusStyle={glassCornerRadiusStyle}
        forceNativeAndroidBlur={Boolean(androidBlurTargetRef)}
        androidBlurTargetRef={androidBlurTargetRef}
      />
      {children}
    </Box>
  );
}

export function ScreenModalOverlay({
  children,
  className,
  testID,
}: ScreenModalOverlayProps) {
  const appearance = useScreenAppearance();
  return (
    <Box
      testID={testID}
      className={joinClassNames(appearance.classNames.modalOverlayClassName, className)}
    >
      {children}
    </Box>
  );
}
