import React from 'react';
import { Pressable } from './pressable';
import { Text, composeTextRole } from './text';
import { PressableProps, TextProps } from 'react-native';
import { useTheme } from '../../providers/ThemeProvider';
import { DEFAULT_THEME_ID, buttonLayoutTokens, getThemeAppearance } from '../../utils/themeTokens';

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

export const Button = ({ 
  action = 'primary', 
  size = 'md', 
  className = '', 
  children, 
  ...props 
}: ButtonProps) => {
  const theme = useTheme();
  const appearance = theme.appearance ?? getThemeAppearance(theme.themeId ?? DEFAULT_THEME_ID, theme.resolvedMode ?? 'light');
  const actionStyles: Record<ButtonAction, string> = {
    primary: 'border border-primary-600/10 bg-primary-500',
    secondary: `border ${appearance.classNames.toneClassNameByTone.neutral.surfaceClassName}`,
    positive: 'border border-success-600/10 bg-success-500',
    negative: 'border border-error-600/10 bg-error-500',
    default: `border ${appearance.classNames.toneClassNameByTone.neutral.surfaceClassName}`,
    softPrimary: `border ${appearance.classNames.toneClassNameByTone.accent.surfaceClassName}`,
    softDestructive: `border ${appearance.classNames.toneClassNameByTone.error.surfaceClassName}`,
  };
  const isDisabled = props.disabled === true;
  const combinedClass = `${actionStyles[action]} ${buttonLayoutTokens.sizeClassNameBySize[size]} flex-row items-center justify-center gap-2 active:opacity-85 ${isDisabled ? 'opacity-55' : ''} ${className}`.trim();
  
  return (
    <ButtonContext.Provider value={{ action, size }}>
      <Pressable accessibilityRole={props.accessibilityRole ?? 'button'} className={combinedClass} {...props}>
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

  return (
    <Text className={`${composeTextRole('action', `${textActionStyles[action]} ${buttonLayoutTokens.textSizeClassNameBySize[size]} text-center`)} ${className}`.trim()} {...props}>
      {children}
    </Text>
  );
};
