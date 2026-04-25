import React from 'react';
import { Platform, StyleSheet, type StyleProp, type View, type ViewStyle } from 'react-native';
import { BlurTargetView, BlurView } from 'expo-blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Box } from '@/components/ui/box';
import { Input, InputField, type InputFieldProps } from '@/components/ui/input';
import { Pressable } from '@/components/ui/pressable';
import { GlassSpecular } from './GlassSpecular';
import { MaterialSymbols, type MaterialSymbolsProps } from './MaterialSymbols';
import { Text, composeTextRole } from './text';
import { getNativeBottomSafeAreaInset } from '../../utils/safeArea';
import { DEFAULT_THEME_ID, buttonLayoutTokens, getThemeAppearance, getThemeToneIconColor, radiusTokens, screenChromeTokens, screenLayoutMetrics, screenLayoutTokens, typographyColors, type ThemeAppearance, type ThemeTone } from '../../utils/themeTokens';
import { useTheme } from '../../providers/ThemeProvider';

interface ScreenHeaderShellProps {
  children: React.ReactNode;
  contentClassName?: string;
  contentStyle?: StyleProp<ViewStyle>;
  maxWidthClassName?: string;
  testID?: string;
}

interface ScreenContentProps {
  children: React.ReactNode;
  className?: string;
  extraBottomInset?: number;
  includeBottomSafeArea?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

interface ScreenRootProps {
  children: React.ReactNode;
  className?: string;
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

const GlassBlurTargetContext = React.createContext<React.RefObject<View | null> | null>(null);

function getAndroidSdkVersion() {
  if (Platform.OS !== 'android') {
    return undefined;
  }

  const version = Platform.Version;
  const parsedVersion = typeof version === 'string'
    ? Number.parseInt(version, 10)
    : version;

  return Number.isFinite(parsedVersion) ? parsedVersion : undefined;
}

function isAndroidBlurFallbackRequired() {
  const sdkVersion = getAndroidSdkVersion();

  return Platform.OS === 'android' && (sdkVersion === undefined || sdkVersion < 31);
}

function getAndroidBlurProps(
  appearance: ThemeAppearance,
  blurTarget: React.RefObject<View | null> | null,
) {
  if (Platform.OS !== 'android' || appearance.surfaceKind !== 'glass' || isAndroidBlurFallbackRequired() || !blurTarget) {
    return {};
  }

  return {
    blurMethod: 'dimezisBlurViewSdk31Plus' as const,
    blurReductionFactor: appearance.effects.blurReductionFactor,
    blurTarget,
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

function GlassSurfaceBackdrop({ appearance, tint }: { appearance: ThemeAppearance; tint: 'light' | 'dark' }) {
  const blurTarget = React.useContext(GlassBlurTargetContext);

  if (appearance.surfaceKind !== 'glass') {
    return null;
  }

  if (Platform.OS === 'android' && (isAndroidBlurFallbackRequired() || !blurTarget)) {
    return (
      <>
        <Box pointerEvents="none" className="absolute inset-0 bg-background-0/82 dark:bg-background-950/72" />
        <Box pointerEvents="none" className="absolute inset-x-0 top-0 h-px bg-typography-0/90 dark:bg-typography-0/24" />
        <GlassSpecular tint={tint} />
      </>
    );
  }

  return (
    <>
      <BlurView
        pointerEvents="none"
        intensity={appearance.effects.surfaceBlurIntensity}
        tint={tint}
        {...getAndroidBlurProps(appearance, blurTarget)}
        style={StyleSheet.absoluteFill}
      />
      <Box pointerEvents="none" className="absolute inset-0 bg-background-0/10 dark:bg-background-950/10" />
      <GlassSpecular tint={tint} />
    </>
  );
}

function GlassBackgroundAccents({ appearance, dim = false }: { appearance: ThemeAppearance; dim?: boolean }) {
  if (appearance.surfaceKind !== 'glass') {
    return null;
  }

  return (
    <Box pointerEvents="none" className="absolute inset-0">
      <Box className={dim ? 'absolute -right-28 -top-28 h-96 w-96 rounded-full bg-primary-500/26 dark:bg-primary-400/18' : 'absolute -right-28 -top-28 h-96 w-96 rounded-full bg-primary-500/40 dark:bg-primary-400/30'} />
      <Box className={dim ? 'absolute -left-28 top-20 h-80 w-80 rounded-full bg-info-500/22 dark:bg-info-400/16' : 'absolute -left-28 top-20 h-80 w-80 rounded-full bg-info-500/34 dark:bg-info-400/24'} />
      <Box className={dim ? 'absolute -bottom-36 -left-20 h-[420px] w-[420px] rounded-full bg-info-500/26 dark:bg-info-400/18' : 'absolute -bottom-36 -left-20 h-[420px] w-[420px] rounded-full bg-info-500/40 dark:bg-info-400/28'} />
      <Box className={dim ? 'absolute -bottom-20 right-0 h-80 w-80 rounded-full bg-success-500/20 dark:bg-success-400/14' : 'absolute -bottom-20 right-0 h-80 w-80 rounded-full bg-success-500/32 dark:bg-success-400/22'} />
      <Box className={dim ? 'absolute right-8 top-1/2 h-48 w-48 rounded-full bg-warning-500/18 dark:bg-warning-400/12' : 'absolute right-8 top-1/2 h-48 w-48 rounded-full bg-warning-500/28 dark:bg-warning-400/18'} />
      <Box className={dim ? 'absolute left-8 right-8 top-24 h-px bg-typography-0/25 dark:bg-typography-0/8' : 'absolute left-8 right-8 top-24 h-px bg-typography-0/40 dark:bg-typography-0/12'} />
      <Box className={dim ? 'absolute bottom-32 left-12 right-16 h-px bg-primary-500/14 dark:bg-primary-300/8' : 'absolute bottom-32 left-12 right-16 h-px bg-primary-500/24 dark:bg-primary-300/12'} />
      <Box className={dim ? 'absolute inset-x-0 bottom-0 h-48 bg-background-0/8 dark:bg-background-950/10' : 'absolute inset-x-0 bottom-0 h-48 bg-background-0/12 dark:bg-background-950/14'} />
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
  testID?: string;
}

interface ScreenBannerProps {
  children: React.ReactNode;
  tone?: ThemeTone;
  floating?: boolean;
  className?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
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
  tone?: 'neutral' | 'accent' | 'warning' | 'error' | 'success' | 'info';
  size?: 'micro' | 'default';
  iconName?: MaterialSymbolsProps['name'];
  iconClassName?: string;
  testID?: string;
}

interface ScreenChipProps extends React.ComponentProps<typeof Pressable> {
  label: string;
  className?: string;
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
  maxWidthClassName = screenChromeTokens.maxWidthClassName,
  testID,
}: ScreenHeaderShellProps) {
  const insets = useSafeAreaInsets();
  const { appearance, theme } = useResolvedThemeAppearance();
  const blurTarget = React.useContext(GlassBlurTargetContext);
  const { colors } = theme;
  const isGlass = appearance.surfaceKind === 'glass';
  const shouldBlurHeader = Platform.OS !== 'android' || (isGlass && !isAndroidBlurFallbackRequired() && Boolean(blurTarget));
  const headerClassName = joinClassNames(
    appearance.classNames.headerShellClassName,
    isGlass && isAndroidBlurFallbackRequired() ? 'bg-background-0/82 dark:bg-background-950/72' : undefined,
  );
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
    <Box className={joinClassNames('z-10 w-full overflow-hidden border-b', appearance.classNames.headerBorderClassName)}>
      {shouldBlurHeader ? (
        <BlurView
          intensity={appearance.effects.headerBlurIntensity}
          tint={colors.headerBlurTint}
          blurReductionFactor={isGlass ? undefined : 2}
          {...getAndroidBlurProps(appearance, blurTarget)}
          className={headerClassName}
          style={{ paddingTop: insets.top }}
        >
          {isGlass ? <GlassSpecular tint={colors.headerBlurTint} /> : null}
          {content}
        </BlurView>
      ) : (
        <Box className={headerClassName} style={{ paddingTop: insets.top }}>
          {isGlass ? <GlassSpecular tint={colors.headerBlurTint} /> : null}
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
  const glassBlurTargetRef = React.useRef<View | null>(null);
  const { colors } = theme;
  const isGlass = appearance.surfaceKind === 'glass';
  const shouldUseAndroidBlurTarget = isGlass && Platform.OS === 'android' && !isAndroidBlurFallbackRequired();

  return (
    <Box
      testID={testID}
      className={joinClassNames('flex-1', isGlass ? 'overflow-hidden' : undefined, className)}
      style={[{ backgroundColor: colors.background }, style]}
    >
      {isGlass ? <GlassBackgroundAccents appearance={appearance} /> : null}
      {shouldUseAndroidBlurTarget ? (
        <BlurTargetView
          testID="screen-glass-blur-target"
          ref={glassBlurTargetRef}
          pointerEvents="none"
          style={StyleSheet.absoluteFill}
        >
          <GlassBackgroundAccents appearance={appearance} dim />
        </BlurTargetView>
      ) : isGlass ? <GlassBackgroundAccents appearance={appearance} dim /> : null}
      <GlassBlurTargetContext.Provider value={shouldUseAndroidBlurTarget ? glassBlurTargetRef : null}>
        {children}
      </GlassBlurTargetContext.Provider>
    </Box>
  );
}

export function ScreenContent({
  children,
  className,
  extraBottomInset = 0,
  includeBottomSafeArea = false,
  style,
  testID,
}: ScreenContentProps) {
  const insets = useSafeAreaInsets();
  const nativeBottomInset = includeBottomSafeArea
    ? getNativeBottomSafeAreaInset(insets.bottom)
    : 0;
  const resolvedExtraBottomInset = Math.max(0, extraBottomInset);
  const nativeBottomInsetStyle = nativeBottomInset > 0 || resolvedExtraBottomInset > 0
    ? { paddingBottom: screenLayoutMetrics.contentBottomInset + nativeBottomInset + resolvedExtraBottomInset }
    : undefined;

  return (
    <Box
      testID={testID}
      className={joinClassNames(`mx-auto w-full ${screenChromeTokens.maxWidthClassName} ${screenChromeTokens.contentHorizontalPaddingClassName} ${screenChromeTokens.contentBottomPaddingClassName}`, className)}
      style={nativeBottomInsetStyle ? [nativeBottomInsetStyle, style] : style}
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
  const { appearance } = useResolvedThemeAppearance();
  const baseClassName = variant === 'inset'
    ? appearance.classNames.insetCardClassName
    : appearance.classNames.cardClassName;
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

  return (
    <Box
      testID={testID}
      className={joinClassNames(baseClassName, paddingClassName, dashed ? 'border-dashed' : undefined, toneClassName, className)}
      style={style}
    >
      {children}
    </Box>
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
  const { appearance } = useResolvedThemeAppearance();
  const baseClassName = variant === 'inset'
    ? appearance.classNames.insetCardClassName
    : appearance.classNames.cardClassName;
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

  return (
    <Pressable
      testID={testID}
      accessibilityRole={accessibilityRole ?? 'button'}
      disabled={disabled}
      className={joinClassNames(baseClassName, paddingClassName, dashed ? 'border-dashed' : undefined, toneClassName, disabled ? 'opacity-55' : 'active:opacity-80', className)}
      style={style}
      {...props}
    >
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

  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={isDisabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      hitSlop={8}
      className={joinClassNames(`${screenChromeTokens.headerActionClassName} shrink-0 items-center justify-center rounded-full ${containerClassName} ${appearance.surfaceKind === 'glass' ? 'relative overflow-hidden' : ''} ${isDisabled ? 'opacity-55' : 'active:opacity-80'}`, className)}
    >
      <GlassSurfaceBackdrop appearance={appearance} tint={theme.colors.headerBlurTint} />
      <MaterialSymbols name={iconName} size={screenChromeTokens.headerActionIconSizePx} className={iconClassName} />
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
  ...props
}: ScreenActionPillProps) {
  const { appearance } = useResolvedThemeAppearance();
  const baseClassName = joinClassNames(
    buttonLayoutTokens.screenActionPillClassNameBySize[size],
    tone === 'primary'
      ? appearance.classNames.primaryActionPillClassName
      : appearance.classNames.softActionPillClassName,
  );

  return (
    <Pressable
      accessibilityRole={accessibilityRole ?? 'button'}
      disabled={disabled}
      className={joinClassNames(baseClassName, disabled ? 'opacity-55' : 'active:opacity-80', className)}
      {...props}
    >
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

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      hitSlop={8}
      className={joinClassNames(
        buttonLayoutTokens.screenIconButtonClassNameBySize[size],
        screenLayoutTokens.iconButtonClassName,
        toneClassName,
        appearance.surfaceKind === 'glass' ? 'relative overflow-hidden' : undefined,
        disabled ? 'opacity-55' : 'active:opacity-70',
        className,
      )}
      {...props}
    >
      <GlassSurfaceBackdrop appearance={appearance} tint={theme.colors.headerBlurTint} />
      <MaterialSymbols name={iconName} size={iconSize} className={joinClassNames(resolvedIconClassName, iconClassName)} />
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

  return (
    <Box
      testID={testID}
      className={joinClassNames(
        sizeClassName,
        'items-center justify-center overflow-hidden',
        toneClassNames.iconTileClassName,
        className,
      )}
    >
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
  tone = 'neutral',
  floating = false,
  className,
  style,
  testID,
}: ScreenBannerProps) {
  const { appearance, theme } = useResolvedThemeAppearance();
  const shouldUseGlassBackdrop = floating && appearance.surfaceKind === 'glass';
  const baseClassName = floating
    ? appearance.classNames.floatingBannerClassName
    : `${radiusTokens.md} border px-3 py-2.5 ${appearance.classNames.toneClassNameByTone[tone].surfaceClassName}`;

  return (
    <Box testID={testID} className={joinClassNames(baseClassName, shouldUseGlassBackdrop ? 'relative overflow-hidden' : undefined, className)} style={style}>
      {shouldUseGlassBackdrop ? <GlassSurfaceBackdrop appearance={appearance} tint={theme.colors.headerBlurTint} /> : null}
      {children}
    </Box>
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
  tone = 'neutral',
  size = 'default',
  iconName,
  iconClassName,
  testID,
}: ScreenBadgeProps) {
  const iconSize = size === 'micro' ? 'xs' : 'sm';
  const { appearance } = useResolvedThemeAppearance();
  const toneTokens = appearance.classNames.toneClassNameByTone[tone];

  return (
    <Box
      testID={testID}
      className={joinClassNames(
        'flex-row items-center border',
        getBadgeSizeClassName(size),
        toneTokens.badgeClassName,
        className,
      )}
    >
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
  const { appearance } = useResolvedThemeAppearance();
  const toneTokens = appearance.classNames.toneClassNameByTone[tone];
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
          'max-w-full shrink flex-row items-center border',
          getBadgeSizeClassName(size),
          toneTokens.badgeClassName,
          className,
        )}
      >
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
        'max-w-full shrink flex-row items-center border',
        getBadgeSizeClassName(size),
        toneTokens.badgeClassName,
        disabled ? 'opacity-60' : 'active:opacity-70',
        className,
      )}
      {...props}
    >
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
  const { appearance } = useResolvedThemeAppearance();
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

  return (
    <Box className={containerClassName}>
      {label ? (
        <Text className={joinClassNames(screenLayoutTokens.fieldLabelClassName, 'mb-2', labelClassName)}>
          {label}
        </Text>
      ) : null}
      <Input className={joinClassNames(fieldShellClassName, fieldClassName)}>
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
  const { appearance } = useResolvedThemeAppearance();
  const fieldShellClassName = variant === 'composer'
    ? appearance.classNames.composerInlineFieldClassName
    : appearance.classNames.searchInlineFieldClassName;
  const inputBaseClassName = variant === 'composer'
    ? screenLayoutTokens.composerInlineInputClassName
    : screenLayoutTokens.searchInlineInputClassName;

  return (
    <Box
      testID={containerTestID}
      className={joinClassNames(fieldShellClassName, className)}
      style={style}
    >
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
  const { appearance } = useResolvedThemeAppearance();
  return (
    <Box
      testID={testID}
      accessibilityRole="tablist"
      className={joinClassNames(appearance.classNames.segmentedControlClassName, disabled ? 'opacity-60' : undefined, className)}
    >
      {options.map((option) => {
        const isActive = activeKey === option.key;

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
          >
            <Text
              numberOfLines={1}
              className={composeTextRole(
                'action',
                `text-center ${isActive
                  ? 'text-typography-0'
                  : 'text-typography-600 dark:text-typography-300'}`,
              )}
            >
              {option.label}
            </Text>
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

  return (
    <Box
      testID={testID}
      className={joinClassNames(
        appearance.classNames.bottomBarClassName,
        appearance.surfaceKind === 'glass' ? 'relative overflow-hidden' : undefined,
        className,
      )}
      style={style}
    >
      <GlassSurfaceBackdrop appearance={appearance} tint={theme.colors.headerBlurTint} />
      {children}
    </Box>
  );
}

export function ScreenSheet({
  children,
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

  return (
    <Box
      testID={testID}
      className={joinClassNames(appearance.classNames.sheetClassName, appearance.surfaceKind === 'glass' ? 'relative overflow-hidden' : undefined, className)}
      style={[bottomInsetStyle, style]}
    >
      <GlassSurfaceBackdrop appearance={appearance} tint={theme.colors.headerBlurTint} />
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
