import React from 'react';
import { Text as RNText, type TextProps as RNTextProps } from 'react-native';
import { cssInterop } from 'nativewind';

const BaseText = cssInterop(RNText, { className: 'style' });

export const textRoleClassNames = {
  display: 'text-[26px] font-bold leading-8 tracking-tight text-typography-900 dark:text-typography-50',
  screenTitle: 'text-[20px] font-bold leading-6 text-typography-900 dark:text-typography-100',
  sectionTitle: 'text-base font-semibold leading-6 text-typography-900 dark:text-typography-100',
  body: 'text-sm leading-6 text-typography-800 dark:text-typography-100',
  bodyMuted: 'text-sm leading-5 text-typography-500 dark:text-typography-300',
  caption: 'text-xs leading-4 text-typography-500 dark:text-typography-400',
  eyebrow: 'text-2xs font-semibold uppercase tracking-wide text-typography-500 dark:text-typography-400',
  action: 'text-sm font-semibold leading-5',
  chip: 'text-xs font-semibold leading-4',
  metric: 'text-[28px] font-extrabold leading-tight tracking-tight text-typography-900 dark:text-typography-100',
} as const;

export type TextRole = keyof typeof textRoleClassNames;

export function composeTextRole(role: TextRole, className?: string) {
  return `${textRoleClassNames[role]} ${className ?? ''}`.trim();
}

export interface TextProps extends RNTextProps {
  className?: string;
  textRole?: TextRole;
}

export function Text({
  className = '',
  textRole,
  allowFontScaling = true,
  ...props
}: TextProps) {
  return (
    <BaseText
      allowFontScaling={allowFontScaling}
      className={textRole ? composeTextRole(textRole, className) : className}
      {...props}
    />
  );
}

