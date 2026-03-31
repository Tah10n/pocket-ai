import React from 'react';
import { Platform, type StyleProp, type ViewStyle } from 'react-native';
import { BlurView } from 'expo-blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Box } from '@/components/ui/box';
import { Input, InputField, type InputFieldProps } from '@/components/ui/input';
import { Pressable } from '@/components/ui/pressable';
import { MaterialSymbols, type MaterialSymbolsProps } from './MaterialSymbols';
import { Text, composeTextRole } from './text';
import { buttonLayoutTokens, screenChromeTokens, screenLayoutTokens, typographyColors } from '../../utils/themeTokens';
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

function joinClassNames(...values: (string | undefined)[]) {
  return values.filter(Boolean).join(' ');
}

function getBadgeToneTokens(tone: 'neutral' | 'accent' | 'warning' | 'error' | 'success') {
  if (tone === 'accent') {
    return {
      shellClassName: 'border-primary-500/20 bg-primary-500/10 dark:border-primary-400/25 dark:bg-primary-500/15',
      contentClassName: 'text-primary-700 dark:text-primary-200',
    };
  }
  if (tone === 'warning') {
    return {
      shellClassName: 'border-warning-400/30 bg-warning-50 dark:border-warning-600/40 dark:bg-warning-950/60',
      contentClassName: 'text-warning-800 dark:text-warning-100',
    };
  }
  if (tone === 'error') {
    return {
      shellClassName: 'border-error-500/20 bg-error-500/10 dark:border-error-400/25 dark:bg-error-500/15',
      contentClassName: 'text-error-700 dark:text-error-200',
    };
  }
  if (tone === 'success') {
    return {
      shellClassName: 'border-success-500/20 bg-success-500/10 dark:border-success-400/25 dark:bg-success-500/15',
      contentClassName: 'text-success-700 dark:text-success-200',
    };
  }

  return {
    shellClassName: 'border-outline-200 bg-background-50 dark:border-outline-700 dark:bg-background-900/70',
    contentClassName: 'text-typography-700 dark:text-typography-200',
  };
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
  size?: 'compact' | 'default' | 'prominent';
  children: React.ReactNode;
}

interface ScreenIconButtonProps extends React.ComponentProps<typeof Pressable> {
  iconName: MaterialSymbolsProps['name'];
  iconSize?: number;
  size?: 'micro' | 'compact' | 'default';
  iconClassName?: string;
  className?: string;
  tone?: 'neutral' | 'primary' | 'danger';
  accessibilityLabel: string;
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
  tone?: 'neutral' | 'accent' | 'warning' | 'error' | 'success';
  size?: 'micro' | 'default';
  iconName?: MaterialSymbolsProps['name'];
  iconClassName?: string;
  testID?: string;
}

interface ScreenChipProps extends React.ComponentProps<typeof Pressable> {
  label: string;
  className?: string;
  textClassName?: string;
  tone?: 'neutral' | 'accent' | 'warning' | 'error' | 'success';
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
}

interface ScreenSheetProps {
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
  const { colors, resolvedMode } = useTheme();
  const shellClassName = resolvedMode === 'dark'
    ? 'bg-background-950/90'
    : 'bg-background-0/94';
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
    <Box className="z-10 w-full overflow-hidden border-b border-outline-200 dark:border-outline-800">
      {Platform.OS === 'android' ? (
        <Box className={shellClassName} style={{ paddingTop: insets.top }}>
          {content}
        </Box>
      ) : (
        <BlurView
          intensity={resolvedMode === 'dark' ? 72 : 82}
          tint={colors.headerBlurTint}
          className={shellClassName}
          style={{ paddingTop: insets.top }}
        >
          {content}
        </BlurView>
      )}
    </Box>
  );
}

export function ScreenContent({
  children,
  className,
  style,
  testID,
}: ScreenContentProps) {
  return (
    <Box
      testID={testID}
      className={joinClassNames(`mx-auto w-full ${screenChromeTokens.maxWidthClassName} ${screenChromeTokens.contentHorizontalPaddingClassName} ${screenChromeTokens.contentBottomPaddingClassName}`, className)}
      style={style}
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
  const baseClassName = variant === 'inset'
    ? screenLayoutTokens.insetCardClassName
    : screenLayoutTokens.cardClassName;
  const paddingClassName = padding === 'none'
    ? undefined
    : padding === 'compact'
      ? screenLayoutTokens.cardPaddingCompactClassName
      : padding === 'large'
        ? screenLayoutTokens.cardPaddingLargeClassName
        : screenLayoutTokens.cardPaddingClassName;
  const toneClassName = tone === 'accent'
    ? 'border-primary-500/20 bg-primary-500/10 dark:border-primary-400/25 dark:bg-primary-500/10'
    : tone === 'warning'
      ? 'border-warning-300 bg-background-warning dark:border-warning-800'
      : tone === 'error'
        ? 'border-error-300 bg-background-error dark:border-error-800'
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
  const baseClassName = variant === 'inset'
    ? screenLayoutTokens.insetCardClassName
    : screenLayoutTokens.cardClassName;
  const paddingClassName = padding === 'none'
    ? undefined
    : padding === 'compact'
      ? screenLayoutTokens.cardPaddingCompactClassName
      : padding === 'large'
        ? screenLayoutTokens.cardPaddingLargeClassName
        : screenLayoutTokens.cardPaddingClassName;
  const toneClassName = tone === 'accent'
    ? 'border-primary-500/20 bg-primary-500/10 dark:border-primary-400/25 dark:bg-primary-500/10'
    : tone === 'warning'
      ? 'border-warning-300 bg-background-warning dark:border-warning-800'
      : tone === 'error'
        ? 'border-error-300 bg-background-error dark:border-error-800'
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
      <Text numberOfLines={titleLines} className={composeTextRole('screenTitle', 'text-[22px] leading-7')}>
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
  const isDisabled = disabled || !onPress;
  const containerClassName = 'bg-primary-500/10 dark:bg-primary-500/15';
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
      className={joinClassNames(`${screenChromeTokens.headerActionClassName} shrink-0 items-center justify-center rounded-full ${containerClassName} ${isDisabled ? 'opacity-55' : 'active:opacity-80'}`, className)}
    >
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
  size = 'default',
  children,
  disabled,
  accessibilityRole,
  ...props
}: ScreenActionPillProps) {
  const baseClassName = joinClassNames(
    buttonLayoutTokens.screenActionPillClassNameBySize[size],
    tone === 'primary'
      ? screenLayoutTokens.primaryActionPillClassName
      : screenLayoutTokens.softActionPillClassName,
  );
  const textToneClassName = tone === 'primary'
    ? 'text-typography-0'
    : 'text-primary-600 dark:text-primary-300';

  return (
    <Pressable
      accessibilityRole={accessibilityRole ?? 'button'}
      disabled={disabled}
      className={joinClassNames(baseClassName, disabled ? 'opacity-55' : 'active:opacity-80', textToneClassName, className)}
      {...props}
    >
      {children}
    </Pressable>
  );
}

export function ScreenIconButton({
  iconName,
  iconSize = 18,
  size = 'default',
  iconClassName,
  className,
  tone = 'neutral',
  accessibilityLabel,
  disabled,
  ...props
}: ScreenIconButtonProps) {
  const toneClassName = tone === 'danger'
    ? 'bg-error-500/10 dark:bg-error-500/15'
    : 'bg-primary-500/10 dark:bg-primary-500/15';
  const resolvedIconClassName = tone === 'primary'
    ? 'text-primary-500'
    : tone === 'danger'
      ? 'text-error-500'
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
        disabled ? 'opacity-55' : 'active:opacity-70',
        className,
      )}
      {...props}
    >
      <MaterialSymbols name={iconName} size={iconSize} className={joinClassNames(resolvedIconClassName, iconClassName)} />
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
  tone = 'neutral',
  size = 'default',
  iconName,
  iconClassName,
  testID,
}: ScreenBadgeProps) {
  const iconSize = size === 'micro' ? 12 : 14;
  const toneTokens = getBadgeToneTokens(tone);

  return (
    <Box
      testID={testID}
      className={joinClassNames(
        'flex-row items-center border',
        getBadgeSizeClassName(size),
        toneTokens.shellClassName,
        className,
      )}
    >
      {iconName ? (
        <MaterialSymbols
          name={iconName}
          size={iconSize}
          className={joinClassNames(toneTokens.contentClassName, iconClassName)}
        />
      ) : null}
      <Text
        className={joinClassNames(
          composeTextRole(size === 'micro' ? 'eyebrow' : 'chip'),
          toneTokens.contentClassName,
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
  const iconSize = size === 'micro' ? 12 : 14;
  const toneTokens = getBadgeToneTokens(tone);
  const content = (
    <>
      {leadingIconName ? (
        <MaterialSymbols name={leadingIconName} size={iconSize} className={toneTokens.contentClassName} />
      ) : null}
      <Text
        numberOfLines={1}
        className={joinClassNames(composeTextRole('chip', 'min-w-0 flex-1'), toneTokens.contentClassName, textClassName)}
      >
        {label}
      </Text>
      {trailingIconName ? (
        <MaterialSymbols name={trailingIconName} size={iconSize} className={toneTokens.contentClassName} />
      ) : null}
    </>
  );

  if (!onPress) {
    return (
      <Box
        className={joinClassNames(
          'max-w-full shrink flex-row items-center border',
          getBadgeSizeClassName(size),
          toneTokens.shellClassName,
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
        toneTokens.shellClassName,
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
  const isProminent = size === 'prominent' || size === 'prominentMultiline';
  const isMultiline = size === 'multiline' || size === 'prominentMultiline' || multiline === true;
  const fieldShellClassName = size === 'compact'
    ? screenLayoutTokens.compactTextFieldClassName
    : size === 'prominent'
      ? screenLayoutTokens.prominentTextFieldClassName
    : isMultiline
      ? isProminent
        ? screenLayoutTokens.prominentMultilineTextFieldClassName
        : screenLayoutTokens.multilineTextFieldClassName
      : screenLayoutTokens.textFieldClassName;
  const inputBaseClassName = isMultiline
    ? isProminent
      ? 'min-h-[320px] flex-1 px-4 py-4 text-[16px] leading-7 text-typography-900 dark:text-typography-100'
      : 'min-h-40 px-3 py-3 text-base leading-6 text-typography-900 dark:text-typography-100'
    : isProminent
      ? 'w-full min-h-6 px-0 py-3 text-[16px] leading-6 text-typography-900 dark:text-typography-100'
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
  const fieldShellClassName = variant === 'composer'
    ? screenLayoutTokens.composerInlineFieldClassName
    : screenLayoutTokens.searchInlineFieldClassName;
  const inputBaseClassName = variant === 'composer'
    ? screenLayoutTokens.composerInlineInputClassName
    : screenLayoutTokens.searchInlineInputClassName;

  return (
    <Box
      testID={containerTestID}
      className={joinClassNames(fieldShellClassName, className)}
      style={style}
    >
      {leadingAccessory}
      <Input className={joinClassNames(leadingAccessory ? 'ml-2' : undefined, screenLayoutTokens.inlineInputShellClassName)}>
        <InputField
          {...props}
          testID={testID}
          placeholderTextColor={placeholderTextColor ?? typographyColors[400]}
          className={joinClassNames(inputBaseClassName, inputClassName)}
        />
      </Input>
      {trailingAccessory}
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
}: ScreenSegmentedControlProps) {
  return (
    <Box
      testID={testID}
      accessibilityRole="tablist"
      className={joinClassNames(screenLayoutTokens.segmentedControlClassName, className)}
    >
      {options.map((option) => {
        const isActive = activeKey === option.key;

        return (
          <Pressable
            key={option.key}
            testID={option.testID}
            onPress={() => onChange(option.key)}
            accessibilityRole="tab"
            accessibilityLabel={option.accessibilityLabel || option.label}
            accessibilityState={{ selected: isActive }}
            className={joinClassNames(
              screenLayoutTokens.segmentedControlItemClassName,
              isActive
                ? 'bg-primary-500'
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

export function ScreenSheet({
  children,
  className,
  style,
  testID,
}: ScreenSheetProps) {
  return (
    <Box
      testID={testID}
      className={joinClassNames(screenLayoutTokens.sheetClassName, className)}
      style={style}
    >
      {children}
    </Box>
  );
}
