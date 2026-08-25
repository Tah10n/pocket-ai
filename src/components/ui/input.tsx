import React from 'react';
import { StyleSheet, View, TextInput, type TextInputProps, type ViewProps } from 'react-native';
import { cssInterop } from 'nativewind';
import { typographyColors } from '../../utils/themeTokens';
import { Surface } from '../../design-system/materials/Surface';
import type { MaterialRequest, MaterialShape } from '../../design-system/materials/contract';
import { useTheme } from '../../providers/ThemeProvider';

const BaseInput = cssInterop(View, { className: 'style' });
const BaseInputField = cssInterop(TextInput, { className: 'style' });

export interface InputProps extends ViewProps {
  className?: string;
  material?: MaterialRequest | null;
  shape?: MaterialShape;
}

export interface InputFieldProps extends TextInputProps {
  className?: string;
}

export function Input({
  className = '',
  material = { role: 'content', variant: 'inset' },
  shape = 'md',
  ...props
}: InputProps) {
  if (material === null) {
    return <BaseInput className={className} {...props} />;
  }

  return (
    <Surface
      material={material}
      shape={shape}
      className={className}
      {...props}
    />
  );
}

export function InputField({
  className = '',
  allowFontScaling = true,
  placeholderTextColor,
  style,
  ...props
}: InputFieldProps) {
  const { colors } = useTheme();

  return (
    <BaseInputField
      allowFontScaling={allowFontScaling}
      placeholderTextColor={placeholderTextColor ?? colors.textTertiary ?? typographyColors[400]}
      underlineColorAndroid="transparent"
      className={`min-h-11 bg-transparent py-0 text-base dark:bg-transparent ${className}`.trim()}
      style={style
        ? [styles.transparentField, { color: colors.text }, style]
        : [styles.transparentField, { color: colors.text }]}
      {...props}
    />
  );
}

const styles = StyleSheet.create({
  transparentField: {
    backgroundColor: 'transparent',
  },
});

