import React from 'react';
import { Pressable } from './pressable';
import { Text, composeTextRole } from './text';
import { PressableProps, type PressableStateCallbackType, TextProps } from 'react-native';
import { useTheme } from '../../providers/ThemeProvider';
import { DEFAULT_THEME_ID, buttonLayoutTokens, getThemeAppearance } from '../../utils/themeTokens';
import { GlassControlTint, GlassSurfaceBackdrop, getGlassCornerRadiusStyle, getGlassSurfaceFrameStyle } from './ScreenShell';

interface ButtonProps extends PressableProps {
  action?: 'primary' | 'secondary' | 'positive' | 'negative' | 'default' | 'softPrimary' | 'softDestructive';
  size?: 'xs' | 'sm' | 'md' | 'lg';
  children?: React.ReactNode;
  className?: string;
}

type ButtonAction = NonNullable<ButtonProps['action']>;
type ButtonSize = NonNullable<ButtonProps['size']>;

const ButtonContext = React.createContext<{ action: ButtonAction; size: ButtonSize }>({
  action: 'primary',
  size: 'md',
});

const textActionStyles: Record<ButtonAction, string> = {
  primary: 'text-typography-0',
  secondary: 'text-typography-900 dark:text-typography-100',
  positive: 'text-typography-0',
  negative: 'text-typography-0',
  default: 'text-typography-900 dark:text-typography-100',
  softPrimary: 'text-primary-600 dark:text-primary-300',
  softDestructive: 'text-error-600 dark:text-error-300',
};

const glassTextActionStyles: Record<ButtonAction, string> = {
  primary: 'text-primary-700 dark:text-primary-100',
  secondary: 'text-typography-900 dark:text-typography-100',
  positive: 'text-success-700 dark:text-success-100',
  negative: 'text-error-700 dark:text-error-100',
  default: 'text-typography-900 dark:text-typography-100',
  softPrimary: 'text-primary-700 dark:text-primary-200',
  softDestructive: 'text-error-700 dark:text-error-200',
};

export const Button = ({ 
  action = 'primary', 
  size = 'md', 
  className = '', 
  children, 
  style,
  ...props 
}: ButtonProps) => {
  const theme = useTheme();
  const appearance = theme.appearance ?? getThemeAppearance(theme.themeId ?? DEFAULT_THEME_ID, theme.resolvedMode ?? 'light');
  const solidActionStyles: Record<ButtonAction, string> = {
    primary: 'border border-primary-600/10 bg-primary-500',
    secondary: `border ${appearance.classNames.toneClassNameByTone.neutral.surfaceClassName}`,
    positive: 'border border-success-600/10 bg-success-500',
    negative: 'border border-error-600/10 bg-error-500',
    default: `border ${appearance.classNames.toneClassNameByTone.neutral.surfaceClassName}`,
    softPrimary: `border ${appearance.classNames.toneClassNameByTone.accent.surfaceClassName}`,
    softDestructive: `border ${appearance.classNames.toneClassNameByTone.error.surfaceClassName}`,
  };
  const glassActionStyles: Record<ButtonAction, string> = {
    primary: 'bg-primary-500/8 dark:bg-primary-500/12',
    secondary: appearance.classNames.toneClassNameByTone.neutral.surfaceClassName,
    positive: 'bg-success-500/8 dark:bg-success-500/12',
    negative: 'bg-error-500/8 dark:bg-error-500/12',
    default: appearance.classNames.toneClassNameByTone.neutral.surfaceClassName,
    softPrimary: appearance.classNames.toneClassNameByTone.accent.surfaceClassName,
    softDestructive: appearance.classNames.toneClassNameByTone.error.surfaceClassName,
  };
  const actionStyles = appearance.surfaceKind === 'glass' ? glassActionStyles : solidActionStyles;
  const tone = action === 'positive'
    ? 'success'
    : action === 'negative' || action === 'softDestructive'
      ? 'error'
      : action === 'primary' || action === 'softPrimary'
        ? 'primary'
        : 'neutral';
  const isDisabled = props.disabled === true;
  const glassCornerRadiusStyle = getGlassCornerRadiusStyle(actionStyles[action], buttonLayoutTokens.sizeClassNameBySize[size], className);
  const glassFrameStyle = appearance.surfaceKind === 'glass'
    ? getGlassSurfaceFrameStyle(appearance, theme.resolvedMode, theme.colors, tone, false, glassCornerRadiusStyle)
    : undefined;
  const combinedStyle: PressableProps['style'] = glassFrameStyle
    ? typeof style === 'function'
      ? (state: PressableStateCallbackType) => [glassFrameStyle, style(state)]
      : [glassFrameStyle, style]
    : style;
  const combinedClass = `${actionStyles[action]} ${buttonLayoutTokens.sizeClassNameBySize[size]} flex-row items-center justify-center gap-2 active:opacity-85 ${appearance.surfaceKind === 'glass' ? 'relative overflow-hidden' : ''} ${isDisabled ? 'opacity-55' : ''} ${className}`.trim();
  
  return (
    <ButtonContext.Provider value={{ action, size }}>
      <Pressable
        accessibilityRole={props.accessibilityRole ?? 'button'}
        className={combinedClass}
        style={combinedStyle}
        {...props}
      >
        <GlassSurfaceBackdrop appearance={appearance} tint={theme.colors.headerBlurTint} decorative="tint" cornerRadiusStyle={glassCornerRadiusStyle} />
        <GlassControlTint appearance={appearance} colors={theme.colors} mode={theme.resolvedMode} tone={tone} />
        {children}
      </Pressable>
    </ButtonContext.Provider>
  );
};

interface ButtonTextProps extends TextProps {
  className?: string;
}

export const ButtonText = ({ className = '', children, ...props }: ButtonTextProps) => {
  const { action, size } = React.useContext(ButtonContext);
  const theme = useTheme();
  const appearance = theme.appearance ?? getThemeAppearance(theme.themeId ?? DEFAULT_THEME_ID, theme.resolvedMode ?? 'light');
  const actionTextStyles = appearance.surfaceKind === 'glass' ? glassTextActionStyles : textActionStyles;

  return (
    <Text className={`${composeTextRole('action', `${actionTextStyles[action]} ${buttonLayoutTokens.textSizeClassNameBySize[size]} text-center`)} ${className}`.trim()} {...props}>
      {children}
    </Text>
  );
};
