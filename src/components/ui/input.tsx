import React from 'react';
import { View, TextInput, type TextInputProps, type ViewProps } from 'react-native';
import { cssInterop } from 'nativewind';
import { typographyColors } from '../../utils/themeTokens';

const BaseInput = cssInterop(View, { className: 'style' });
const BaseInputField = cssInterop(TextInput, { className: 'style' });

export interface InputProps extends ViewProps {
  className?: string;
}

export interface InputFieldProps extends TextInputProps {
  className?: string;
}

export function Input({ className = '', ...props }: InputProps) {
  return (
    <BaseInput
      className={`min-h-12 rounded-2xl border border-outline-200 bg-background-50 px-3 dark:border-outline-700 dark:bg-background-900/70 ${className}`.trim()}
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

