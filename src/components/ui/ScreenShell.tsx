import React from 'react';
import {
  StyleSheet,
  type LayoutChangeEvent,
  type StyleProp,
  type View,
  type ViewStyle,
} from 'react-native';
import { BlurTargetView } from 'expo-blur';
import { useIsFocused } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Box } from '@/components/ui/box';
import { Input, InputField, type InputFieldProps } from '@/components/ui/input';
import { Pressable } from '@/components/ui/pressable';
import { PressableSurface as MaterialPressableSurface, Surface as MaterialSurface } from '../../design-system/materials/Surface';
import { EffectPressableSurface, EffectSurface } from '../../design-system/materials/EffectSurface';
import type { MaterialRequest, MaterialShape, MaterialTone } from '../../design-system/materials/contract';
import type { SemanticForegroundRole } from '../../design-system/themes/foreground';
import { useMaterialEnvironment } from '../../design-system/materials/MaterialEnvironmentProvider';
import {
  themeUsesAndroidLiquidGlass,
  themeUsesAndroidTargetBlur,
} from '../../design-system/materials/resolver';
import { ScreenBackgroundDecoration } from '../../design-system/materials/ScreenBackgroundDecoration';
import { AndroidLiquidGlassBackdropProvider } from '../../design-system/materials/AndroidLiquidGlass';
import {
  AndroidBlurBoundaryProvider,
  AndroidBlurSampleTargetProvider,
  useAndroidBlurTargetHandle,
} from '../../design-system/materials/AndroidBlurTargetContext';
import { MaterialSymbols, type MaterialSymbolsProps } from './MaterialSymbols';
import { Text, composeTextRole } from './text';
import { setActiveAndroidBlurTarget, type AndroidBlurTargetRef } from '../../utils/androidBlur';
import { getNativeBottomSafeAreaInset } from '../../utils/safeArea';
import { buttonLayoutTokens, screenChromeTokens, screenLayoutMetrics, screenLayoutTokens, type ThemeTone } from '../../utils/themeTokens';
import { useTheme } from '../../providers/ThemeProvider';
import {
  screenActionPillGeometryBySize,
  screenInlineInputGeometryByVariant,
  screenTextFieldGeometryBySize,
  segmentedControlGeometry,
} from './controlGeometry';

interface ScreenHeaderShellProps {
  androidBlurTargetRef?: AndroidBlurTargetRef | null;
  children: React.ReactNode;
  contentClassName?: string;
  contentStyle?: StyleProp<ViewStyle>;
  floating?: boolean;
  maxWidthClassName?: string;
  testID?: string;
}

const SCREEN_HEADER_MATERIAL = { role: 'chrome', variant: 'header' } as const;

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

function normalizeMaterialTone(tone: ThemeTone | 'danger' | 'default'): MaterialTone {
  if (tone === 'default') return 'neutral';
  if (tone === 'danger') return 'error';
  return tone;
}

function getToneForegroundRole(tone: MaterialTone): SemanticForegroundRole {
  if (tone === 'primary' || tone === 'accent') return 'toneAccent';
  if (tone === 'error') return 'danger';
  if (tone === 'warning') return 'warning';
  if (tone === 'success') return 'success';
  if (tone === 'info') return 'info';
  return 'toneNeutral';
}

function getToneIconForegroundRole(tone: MaterialTone): SemanticForegroundRole {
  if (tone === 'primary' || tone === 'accent') return 'toneIconAccent';
  if (tone === 'error') return 'toneIconDanger';
  if (tone === 'warning') return 'toneIconWarning';
  if (tone === 'success') return 'toneIconSuccess';
  if (tone === 'info') return 'toneIconInfo';
  return 'toneIconNeutral';
}

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


const styles = StyleSheet.create({
  screenSceneBlurTarget: {
    flex: 1,
  },
});

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
  iconColorRole?: SemanticForegroundRole;
  className?: string;
  style?: StyleProp<ViewStyle>;
  material?: Extract<MaterialRequest, { role: 'control' }>;
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
  iconColorRole?: SemanticForegroundRole;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

interface ScreenBannerProps {
  children: React.ReactNode;
  tone?: ThemeTone;
  floating?: boolean;
  androidBlurTargetRef?: AndroidBlurTargetRef | null;
  className?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

type ScreenSurfaceTone = ThemeTone | 'danger' | 'default';

interface ScreenSurfaceProps {
  accessibilityHint?: React.ComponentProps<typeof Box>['accessibilityHint'];
  accessibilityLabel?: React.ComponentProps<typeof Box>['accessibilityLabel'];
  accessibilityRole?: React.ComponentProps<typeof Box>['accessibilityRole'];
  accessibilityState?: React.ComponentProps<typeof Box>['accessibilityState'];
  accessible?: React.ComponentProps<typeof Box>['accessible'];
  children: React.ReactNode;
  className?: string;
  material?: MaterialRequest | null;
  style?: StyleProp<ViewStyle>;
  shape?: MaterialShape;
  testID?: string;
  tone?: ScreenSurfaceTone;
  withControlTint?: boolean;
}

interface ScreenPressableSurfaceProps extends React.ComponentProps<typeof Pressable> {
  children: React.ReactNode;
  className?: string;
  material?: Extract<MaterialRequest, { role: 'control' }>;
  style?: React.ComponentProps<typeof Pressable>['style'];
  shape?: MaterialShape;
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
  textColorRole?: SemanticForegroundRole;
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
  fieldTestID?: string;
  size?: 'compact' | 'default' | 'multiline' | 'prominent' | 'prominentMultiline';
}

interface ScreenInlineInputProps extends Omit<InputFieldProps, 'className' | 'style'> {
  className?: string;
  embedded?: boolean;
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
  androidBlurTargetRef,
  children,
  contentClassName,
  contentStyle,
  floating,
  maxWidthClassName = screenChromeTokens.maxWidthClassName,
  testID,
}: ScreenHeaderShellProps) {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const setHeaderInset = React.useContext(ScreenHeaderInsetSetterContext);
  const isFloating = floating
    ?? theme.resolvedTheme.components.header.presentation === 'overlay';
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
        'z-10 w-full',
        isFloating ? 'absolute left-0 right-0 top-0' : undefined,
      )}
    >
      <EffectSurface
        androidBlurTargetRef={androidBlurTargetRef}
        material={SCREEN_HEADER_MATERIAL}
        shape="none"
        style={{
          borderLeftWidth: 0,
          borderRightWidth: 0,
          borderTopWidth: 0,
          paddingTop: insets.top,
        }}
      >
        {content}
      </EffectSurface>
    </Box>
  );
}

export function ScreenRoot({
  children,
  className,
  style,
  testID,
}: ScreenRootProps) {
  const theme = useTheme();
  const environment = useMaterialEnvironment();
  const materialBackgroundBlurTargetRef = React.useRef<View | null>(null);
  const materialSceneBlurTargetRef = React.useRef<View | null>(null);
  const hasBackgroundDecoration = theme.resolvedTheme.components.screen.backgroundDecoration === 'aurora';
  const hasAndroidBlurChrome = themeUsesAndroidTargetBlur(theme.resolvedTheme.materials);
  const hasAndroidLiquidGlassChrome = themeUsesAndroidLiquidGlass(theme.resolvedTheme.materials);
  const isFocused = useIsFocused();
  const shouldUseAndroidLiquidGlass = environment.platform === 'android'
    && environment.androidLiquidGlassAvailable
    && hasAndroidLiquidGlassChrome;
  const shouldMountAndroidLiquidGlassProvider = environment.platform === 'android'
    && environment.androidLiquidGlassAvailable;
  const shouldMountAndroidBlurTargets = environment.platform === 'android'
    && environment.androidTargetBlurSupported
    && !environment.androidLiquidGlassAvailable;
  const shouldUseAndroidBlurTarget = shouldMountAndroidBlurTargets
    && hasAndroidBlurChrome;
  const shouldRegisterAndroidBlurTarget = shouldUseAndroidBlurTarget && isFocused;
  const materialBackgroundBlurTarget = useAndroidBlurTargetHandle(
    materialBackgroundBlurTargetRef,
    'screen-material-background',
    shouldUseAndroidBlurTarget,
  );
  const materialSceneBlurTarget = useAndroidBlurTargetHandle(
    materialSceneBlurTargetRef,
    'screen-material-scene',
    shouldUseAndroidBlurTarget,
  );
  const [headerInset, setHeaderInsetState] = React.useState<ScreenHeaderInset>({ height: 0, isFloating: false });
  const { colors } = theme;
  const androidBlurSampleTarget = shouldUseAndroidBlurTarget
    ? materialBackgroundBlurTarget.sample
    : null;
  const androidSceneBoundary = shouldUseAndroidBlurTarget
    ? materialSceneBlurTarget.boundary
    : null;
  const setHeaderInset = React.useCallback((nextInset: ScreenHeaderInset) => {
    setHeaderInsetState((currentInset) => getNextScreenHeaderInset(currentInset, nextInset));
  }, []);
  const screenContent = (
    <ScreenHeaderInsetSetterContext.Provider value={setHeaderInset}>
      <ScreenHeaderInsetContext.Provider value={headerInset}>
        <AndroidBlurSampleTargetProvider target={androidBlurSampleTarget}>
          <AndroidBlurBoundaryProvider boundary={androidSceneBoundary}>
            {children}
          </AndroidBlurBoundaryProvider>
        </AndroidBlurSampleTargetProvider>
      </ScreenHeaderInsetContext.Provider>
    </ScreenHeaderInsetSetterContext.Provider>
  );

  React.useEffect(() => {
    if (!shouldRegisterAndroidBlurTarget || !materialSceneBlurTarget.sample.ready) {
      return undefined;
    }

    return setActiveAndroidBlurTarget(materialSceneBlurTargetRef);
  }, [materialSceneBlurTarget.sample.ready, shouldRegisterAndroidBlurTarget]);

  const rootScene = (
    <Box
      testID={testID}
      className={joinClassNames('flex-1', hasBackgroundDecoration ? 'overflow-hidden' : undefined, className)}
      style={[{ backgroundColor: colors.background }, style]}
    >
      {hasBackgroundDecoration ? <ScreenBackgroundDecoration mode={theme.resolvedMode} /> : null}
      {shouldMountAndroidBlurTargets ? (
        <>
          <BlurTargetView
            testID="screen-material-blur-target"
            ref={materialBackgroundBlurTargetRef}
            onLayout={materialBackgroundBlurTarget.markReady}
            pointerEvents="none"
            style={StyleSheet.absoluteFill}
          >
            {hasBackgroundDecoration ? <ScreenBackgroundDecoration dim mode={theme.resolvedMode} /> : null}
          </BlurTargetView>
          <BlurTargetView
            testID="screen-material-scene-blur-target"
            ref={materialSceneBlurTargetRef}
            onLayout={materialSceneBlurTarget.markReady}
            pointerEvents="box-none"
            style={styles.screenSceneBlurTarget}
          >
            {screenContent}
          </BlurTargetView>
        </>
      ) : (
        <>
          {hasBackgroundDecoration ? <ScreenBackgroundDecoration dim mode={theme.resolvedMode} /> : null}
          {screenContent}
        </>
      )}
    </Box>
  );

  if (shouldMountAndroidLiquidGlassProvider) {
    return (
      <AndroidLiquidGlassBackdropProvider
        testID="screen-material-liquid-glass-scene"
        active={shouldUseAndroidLiquidGlass && isFocused}
        collapsable={false}
        style={styles.screenSceneBlurTarget}
      >
        {rootScene}
      </AndroidLiquidGlassBackdropProvider>
    );
  }

  return rootScene;
}

export function ScreenAndroidContentBlurTarget({
  blurTargetRef,
  children,
  style,
  testID,
}: ScreenAndroidContentBlurTargetProps) {
  const theme = useTheme();
  const environment = useMaterialEnvironment();
  const shouldUseAndroidBlurTarget = environment.platform === 'android'
    && environment.androidTargetBlurSupported
    && !environment.androidLiquidGlassAvailable
    && themeUsesAndroidTargetBlur(theme.resolvedTheme.materials);
  const blurTarget = useAndroidBlurTargetHandle(
    blurTargetRef,
    'screen-android-content',
    shouldUseAndroidBlurTarget,
  );

  if (shouldUseAndroidBlurTarget) {
    return (
      <BlurTargetView
        ref={blurTargetRef}
        onLayout={blurTarget.markReady}
        collapsable={false}
        testID={testID}
        style={style}
      >
        <AndroidBlurSampleTargetProvider target={blurTarget.sample}>
          <AndroidBlurBoundaryProvider boundary={blurTarget.boundary}>
            {children}
          </AndroidBlurBoundaryProvider>
        </AndroidBlurSampleTargetProvider>
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
  style,
  testID,
  variant = 'surface',
  padding = variant === 'inset' ? 'compact' : 'default',
  tone = 'default',
  dashed = false,
}: ScreenCardProps) {
  const material = React.useMemo<MaterialRequest>(() => ({
    role: 'content',
    variant: variant === 'inset' ? 'inset' : 'raised',
    tone: tone === 'default' ? 'neutral' : tone,
  }), [tone, variant]);
  const paddingClassName = padding === 'none'
    ? undefined
    : padding === 'compact'
      ? screenLayoutTokens.cardPaddingCompactClassName
      : padding === 'large'
        ? screenLayoutTokens.cardPaddingLargeClassName
        : screenLayoutTokens.cardPaddingClassName;
  return (
    <MaterialSurface
      testID={testID}
      material={material}
      shape={variant === 'inset' ? 'md' : 'lg'}
      className={joinClassNames(paddingClassName, dashed ? 'border-dashed' : undefined, className)}
      style={style}
    >
      {children}
    </MaterialSurface>
  );
}

export function ScreenPressableCard({
  children,
  className,
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
  const material = React.useMemo<MaterialRequest>(() => ({
    role: 'content',
    variant: variant === 'inset' ? 'inset' : 'raised',
    tone: tone === 'default' ? 'neutral' : tone,
  }), [tone, variant]);
  const paddingClassName = padding === 'none'
    ? undefined
    : padding === 'compact'
      ? screenLayoutTokens.cardPaddingCompactClassName
      : padding === 'large'
        ? screenLayoutTokens.cardPaddingLargeClassName
        : screenLayoutTokens.cardPaddingClassName;
  return (
    <MaterialPressableSurface
      testID={testID}
      material={material}
      shape={variant === 'inset' ? 'md' : 'lg'}
      accessibilityRole={accessibilityRole ?? 'button'}
      disabled={disabled}
      className={joinClassNames(paddingClassName, dashed ? 'border-dashed' : undefined, disabled ? 'opacity-55' : 'active:opacity-80', className)}
      style={style}
      {...props}
    >
      {children}
    </MaterialPressableSurface>
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
      <Text colorRole="primary" numberOfLines={titleLines} className={composeTextRole('screenTitle', 'leading-7')}>
        {title}
      </Text>
      {subtitle ? (
        <Text colorRole="secondary" numberOfLines={subtitleLines} className={composeTextRole('bodyMuted', 'mt-1')}>
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
  const isDisabled = disabled || !onPress;
  const materialTone = tone === 'accent'
    ? 'primary'
    : tone === 'destructive'
      ? 'error'
      : 'neutral';
  const colorRole = tone === 'accent'
    ? 'accent'
    : tone === 'destructive'
      ? 'danger'
      : 'icon';

  return (
    <EffectPressableSurface
      testID={testID}
      onPress={onPress}
      disabled={isDisabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      hitSlop={8}
      material={{ role: 'control', variant: 'floating', tone: materialTone }}
      shape="full"
      className={joinClassNames(`${screenChromeTokens.headerActionClassName} shrink-0 items-center justify-center ${isDisabled ? 'opacity-55' : 'active:opacity-80'}`, className)}
    >
      <MaterialSymbols name={iconName} size={screenChromeTokens.headerActionIconSizePx} colorRole={colorRole} />
    </EffectPressableSurface>
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
  const geometry = screenActionPillGeometryBySize[size];
  const baseClassName = joinClassNames(
    'flex-row items-center justify-center',
    tone === 'primary' ? 'gap-2' : 'gap-1.5',
  );

  return (
    <MaterialPressableSurface
      accessibilityRole={accessibilityRole ?? 'button'}
      disabled={disabled}
      material={{
        role: 'control',
        variant: tone === 'primary' ? 'selected' : 'inline',
        tone: tone === 'primary' ? 'primary' : 'neutral',
      }}
      shape={geometry.shape}
      className={joinClassNames(
        baseClassName,
        disabled ? 'opacity-55' : 'active:opacity-80',
        className,
      )}
      style={[geometry.style, style]}
      {...props}
    >
      {children}
    </MaterialPressableSurface>
  );
}

export function ScreenIconButton({
  iconName,
  iconSize = 'md',
  size = 'default',
  iconClassName,
  iconColorRole,
  className,
  tone = 'neutral',
  accessibilityLabel,
  disabled,
  material,
  style,
  ...props
}: ScreenIconButtonProps) {
  const sizeClassName = buttonLayoutTokens.screenIconButtonClassNameBySize[size];
  const resolvedMaterial = material ?? {
    role: 'control',
    variant: 'inline',
    tone: tone === 'danger' ? 'error' : tone,
  } as const;
  const colorRole: SemanticForegroundRole = tone === 'danger'
    ? 'danger'
    : tone === 'primary'
      ? 'accent'
      : 'icon';
  const icon = (
    <MaterialSymbols
      name={iconName}
      size={iconSize}
      className={iconClassName}
      colorRole={iconColorRole ?? (iconClassName ? undefined : colorRole)}
    />
  );

  return (
    <MaterialPressableSurface
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      hitSlop={size === 'micro' ? 10 : 8}
      material={resolvedMaterial}
      shape="full"
      className={joinClassNames(
        sizeClassName,
        screenLayoutTokens.iconButtonClassName,
        disabled ? 'opacity-55' : 'active:opacity-70',
        className,
      )}
      style={style}
      {...props}
    >
      {icon}
    </MaterialPressableSurface>
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
  iconColorRole,
  style,
  testID,
}: ScreenIconTileProps) {
  const sizeClassName = size === 'sm'
    ? 'h-8 w-8 rounded-full'
    : size === 'lg'
      ? 'h-11 w-11 rounded-2xl'
      : 'h-9 w-9 rounded-xl';
  const materialTone = normalizeMaterialTone(tone);

  return (
    <MaterialSurface
      testID={testID}
      material={{ role: 'control', variant: 'inline', tone: materialTone }}
      shape={size === 'sm' ? 'full' : size === 'lg' ? 'md' : 'sm'}
      className={joinClassNames(
        sizeClassName,
        'items-center justify-center overflow-hidden',
        className,
      )}
      style={style}
    >
      {children ?? (
        <MaterialSymbols
          name={iconName}
          size={iconSize}
          className={iconClassName}
          color={iconColor}
          colorRole={iconColorRole ?? (iconColor || iconClassName ? undefined : getToneIconForegroundRole(materialTone))}
        />
      )}
    </MaterialSurface>
  );
}

export function ScreenBanner({
  children,
  tone = 'neutral',
  floating = false,
  androidBlurTargetRef,
  className,
  style,
  testID,
}: ScreenBannerProps) {
  if (floating) {
    return (
      <EffectSurface
        testID={testID}
        androidBlurTargetRef={androidBlurTargetRef}
        material={{ role: 'overlay', variant: 'popover', tone }}
        shape="md"
        className={joinClassNames('px-3 py-2.5', className)}
        style={style}
      >
        {children}
      </EffectSurface>
    );
  }

  return (
    <MaterialSurface
      testID={testID}
      material={{ role: 'overlay', variant: 'banner', tone }}
      shape="md"
      className={joinClassNames('px-3 py-2.5', className)}
      style={style}
    >
      {children}
    </MaterialSurface>
  );
}

export function ScreenSurface({
  accessibilityHint,
  accessibilityLabel,
  accessibilityRole,
  accessibilityState,
  accessible,
  children,
  className,
  material,
  shape = 'md',
  style,
  testID,
  tone = 'default',
  withControlTint = false,
}: ScreenSurfaceProps) {
  const resolvedMaterial = material === null
    ? null
    : material ?? (withControlTint ? {
      role: 'control',
      variant: 'inline',
      tone: normalizeMaterialTone(tone),
    } as MaterialRequest : null);
  const sharedProps = {
    accessible,
    accessibilityHint,
    accessibilityLabel,
    accessibilityRole,
    accessibilityState,
    testID,
    className,
    style,
  };

  return resolvedMaterial ? (
    <MaterialSurface {...sharedProps} material={resolvedMaterial} shape={shape}>
      {children}
    </MaterialSurface>
  ) : <Box {...sharedProps}>{children}</Box>;
}

export function ScreenPressableSurface({
  children,
  className,
  material,
  shape = 'md',
  style,
  tone = 'default',
  withControlTint = false,
  ...props
}: ScreenPressableSurfaceProps) {
  const resolvedMaterial = material ?? {
    role: 'control',
    variant: withControlTint ? 'selected' : 'inline',
    tone: normalizeMaterialTone(tone),
  } as const;

  return (
    <MaterialPressableSurface
      className={className}
      material={resolvedMaterial}
      shape={shape}
      style={style}
      {...props}
    >
      {children}
    </MaterialPressableSurface>
  );
}

export function ScreenSectionLabel({
  children,
  className,
  testID,
}: ScreenSectionLabelProps) {
  return (
    <Text colorRole="tertiary" testID={testID} className={joinClassNames(screenLayoutTokens.sectionLabelClassName, className)}>
      {children}
    </Text>
  );
}

export function ScreenBadge({
  children,
  className,
  textClassName,
  textColorRole,
  style,
  tone = 'neutral',
  size = 'default',
  iconName,
  iconClassName,
  testID,
}: ScreenBadgeProps) {
  const iconSize = size === 'micro' ? 'xs' : 'sm';
  const badgeSizeClassName = getBadgeSizeClassName(size);
  const materialTone = tone === 'accent' ? 'accent' : tone;
  const colorRole = getToneForegroundRole(materialTone);
  const iconColorRole = getToneIconForegroundRole(materialTone);

  return (
    <MaterialSurface
      testID={testID}
      material={{ role: 'control', variant: 'inline', tone: materialTone }}
      shape="full"
      className={joinClassNames(
        'flex-row items-center',
        badgeSizeClassName,
        className,
      )}
      style={style}
    >
      {iconName ? (
        <MaterialSymbols
          name={iconName}
          size={iconSize}
          className={iconClassName}
          colorRole={iconClassName ? undefined : iconColorRole}
        />
      ) : null}
      <Text
        colorRole={textColorRole ?? (textClassName ? undefined : colorRole)}
        className={joinClassNames(
          composeTextRole(size === 'micro' ? 'eyebrow' : 'chip'),
          textClassName,
        )}
      >
        {children}
      </Text>
    </MaterialSurface>
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
  const badgeSizeClassName = getBadgeSizeClassName(size);
  const materialTone = tone === 'accent' ? 'accent' : tone;
  const colorRole = getToneForegroundRole(materialTone);
  const iconColorRole = getToneIconForegroundRole(materialTone);
  const content = (
    <>
      {leadingIconName ? (
        <MaterialSymbols name={leadingIconName} size={iconSize} colorRole={iconColorRole} />
      ) : null}
      <Text
        numberOfLines={1}
        colorRole={textClassName ? undefined : colorRole}
        className={joinClassNames(composeTextRole('chip', 'min-w-0 shrink'), textClassName)}
      >
        {label}
      </Text>
      {trailingIconName ? (
        <MaterialSymbols name={trailingIconName} size={iconSize} colorRole={iconColorRole} />
      ) : null}
    </>
  );

  if (!onPress) {
    return (
      <MaterialSurface
        material={{ role: 'control', variant: 'inline', tone: materialTone }}
        shape="full"
        className={joinClassNames(
          'max-w-full shrink flex-row items-center',
          badgeSizeClassName,
          className,
        )}
        style={style}
      >
        {content}
      </MaterialSurface>
    );
  }

  return (
    <MaterialPressableSurface
      accessibilityRole={accessibilityRole ?? 'button'}
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      material={{ role: 'control', variant: 'inline', tone: materialTone }}
      shape="full"
      className={joinClassNames(
        'max-w-full shrink flex-row items-center',
        badgeSizeClassName,
        disabled ? 'opacity-60' : 'active:opacity-70',
        className,
      )}
      style={style}
      {...props}
    >
      {content}
    </MaterialPressableSurface>
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
  fieldTestID,
  size = 'default',
  multiline,
  placeholderTextColor,
  testID,
  ...props
}: ScreenTextFieldProps) {
  const isProminent = size === 'prominent' || size === 'prominentMultiline';
  const isMultiline = size === 'multiline' || size === 'prominentMultiline' || multiline === true;
  const geometrySize = isMultiline
    ? isProminent ? 'prominentMultiline' : 'multiline'
    : size === 'compact' || size === 'prominent' ? size : 'default';
  const geometry = screenTextFieldGeometryBySize[geometrySize];
  const inputBaseClassName = isMultiline
    ? isProminent
      ? 'min-h-80 flex-1 px-4 py-4 text-base leading-7'
      : 'min-h-40 px-3 py-3 text-base leading-6'
    : isProminent
      ? 'w-full min-h-6 px-0 py-3 text-base leading-6'
      : 'min-h-0 h-full px-0 py-0 text-base';

  return (
    <Box className={containerClassName}>
      {label ? (
        <Text colorRole="tertiary" className={joinClassNames(screenLayoutTokens.fieldLabelClassName, 'mb-2', labelClassName)}>
          {label}
        </Text>
      ) : null}
      <Input
        testID={fieldTestID}
        material={{ role: 'content', variant: 'inset' }}
        shape={geometry.shape}
        className={fieldClassName}
        style={geometry.style}
      >
        <InputField
          {...props}
          testID={testID}
          multiline={isMultiline}
          textAlignVertical={isMultiline ? 'top' : props.textAlignVertical}
          placeholderTextColor={placeholderTextColor}
          className={joinClassNames(inputBaseClassName, inputClassName)}
        />
      </Input>
      {helperText ? (
        <Text colorRole="tertiary" className={joinClassNames(composeTextRole('caption', 'mt-2'), helperTextClassName)}>
          {helperText}
        </Text>
      ) : null}
    </Box>
  );
}

export function ScreenInlineInput({
  className,
  embedded = false,
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
  const geometry = screenInlineInputGeometryByVariant[variant];
  const inputBaseClassName = variant === 'composer'
    ? screenLayoutTokens.composerInlineInputClassName
    : screenLayoutTokens.searchInlineInputClassName;
  const isEmbedded = embedded;

  return (
    <Input
      testID={containerTestID}
      material={isEmbedded ? null : { role: 'content', variant: 'inset' }}
      shape={geometry.shape}
      className={className}
      style={[geometry.style, style]}
    >
      {leadingAccessory ? <Box className="shrink-0">{leadingAccessory}</Box> : null}
      <Input material={null} className={joinClassNames(screenLayoutTokens.inlineInputShellClassName, leadingAccessory ? 'ml-2' : undefined)}>
        <InputField
          {...props}
          testID={testID}
          placeholderTextColor={placeholderTextColor}
          className={joinClassNames(inputBaseClassName, inputClassName)}
        />
      </Input>
      {trailingAccessory ? <Box className="ml-2 shrink-0">{trailingAccessory}</Box> : null}
    </Input>
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
  const renderLabel = (option: ScreenSegmentedControlOption, isActive: boolean) => {
    const labelKey = `${option.key}-${isActive ? 'active' : 'inactive'}-label`;

    return (
      <Text
        key={labelKey}
        numberOfLines={1}
        colorRole={isActive ? 'onAccent' : 'secondary'}
        className={composeTextRole('action', 'text-center')}
      >
        {option.label}
      </Text>
    );
  };

  return (
    <MaterialSurface
      testID={testID}
      accessibilityRole="tablist"
      material={{ role: 'control', variant: 'inline', tone: 'neutral' }}
      shape="full"
      className={joinClassNames(
        'flex-row',
        disabled ? 'opacity-60' : undefined,
        className,
      )}
      style={segmentedControlGeometry.container}
    >
      {options.map((option) => {
        const isActive = activeKey === option.key;

        const sharedItemProps = {
          testID: option.testID,
          onPress: () => {
            if (!disabled) {
              onChange(option.key);
            }
          },
          disabled,
          accessibilityRole: 'tab' as const,
          accessibilityLabel: option.accessibilityLabel || option.label,
          accessibilityState: { selected: isActive, disabled },
          className: itemClassName,
          style: segmentedControlGeometry.item,
        };

        return (
          <MaterialPressableSurface
            key={option.key}
            {...sharedItemProps}
            material={isActive ? { role: 'control', variant: 'selected', tone: 'primary' } : null}
            shape="full"
          >
            {renderLabel(option, isActive)}
          </MaterialPressableSurface>
        );
      })}
    </MaterialSurface>
  );
}

export function ScreenChromeBar({
  children,
  className,
  style,
  testID,
}: ScreenChromeBarProps) {
  return (
    <EffectSurface
      testID={testID}
      material={{ role: 'chrome', variant: 'composer' }}
      shape="none"
      className={className}
      style={style}
    >
      {children}
    </EffectSurface>
  );
}

export function ScreenSheet({
  children,
  androidBlurTargetRef,
  className,
  style,
  testID,
}: ScreenSheetProps) {
  const insets = useSafeAreaInsets();
  const nativeBottomInset = getNativeBottomSafeAreaInset(insets.bottom);
  const bottomInsetStyle = {
    paddingBottom: screenLayoutMetrics.sheetBottomInset + nativeBottomInset,
  };

  return (
    <EffectSurface
      testID={testID}
      androidBlurTargetRef={androidBlurTargetRef}
      material={{ role: 'chrome', variant: 'sheet' }}
      shape="sheet"
      className={joinClassNames('max-h-[88%]', className)}
      style={style}
    >
      <Box
        className={screenLayoutTokens.sheetContentPaddingClassName}
        style={bottomInsetStyle}
      >
        {children}
      </Box>
    </EffectSurface>
  );
}

export function ScreenModalOverlay({
  children,
  className,
  testID,
}: ScreenModalOverlayProps) {
  return (
    <MaterialSurface
      testID={testID}
      material={{ role: 'overlay', variant: 'scrim' }}
      shape="none"
      className={joinClassNames(
        'relative flex-1 justify-end overflow-hidden',
        className,
      )}
    >
      {children}
    </MaterialSurface>
  );
}
