import React from 'react';
import { View, TextInput, type TextInputProps, type ViewProps } from 'react-native';
import { cssInterop } from 'nativewind';
import { useTheme } from '../../providers/ThemeProvider';
import { DEFAULT_THEME_ID, getThemeAppearance, typographyColors } from '../../utils/themeTokens';

const BaseInput = cssInterop(View, { className: 'style' });
const BaseInputField = cssInterop(TextInput, { className: 'style' });

export interface InputProps extends ViewProps {
  className?: string;
}

export interface InputFieldProps extends TextInputProps {
  className?: string;
}

export function Input({ className = '', ...props }: InputProps) {
  const theme = useTheme();
  const appearance = theme.appearance ?? getThemeAppearance(theme.themeId ?? DEFAULT_THEME_ID, theme.resolvedMode ?? 'light');

  return (
    <BaseInput
      className={`${appearance.classNames.textFieldClassName} ${className}`.trim()}
      {...props}
    />
  );
}

export function InputField({
  className = '',
  allowFontScaling = true,
  placeholderTextColor,
  ...props
}: InputFieldProps) {
  return (
    <BaseInputField
      allowFontScaling={allowFontScaling}
      placeholderTextColor={placeholderTextColor ?? typographyColors[400]}
      className={`min-h-11 py-0 text-base text-typography-900 dark:text-typography-100 ${className}`.trim()}
      {...props}
    />
  );
}

