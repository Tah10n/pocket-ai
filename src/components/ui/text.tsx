import React from 'react';
import { Text as RNText, type TextProps as RNTextProps } from 'react-native';
import { cssInterop } from 'nativewind';
import { useTheme } from '../../providers/ThemeProvider';
import { resolveThemeForeground, type SemanticForegroundRole } from '../../design-system/themes/foreground';

const BaseText = cssInterop(RNText, { className: 'style' });

export const textRoleClassNames = {
  display: 'text-[26px] font-bold leading-8 tracking-tight',
  screenTitle: 'text-[20px] font-bold leading-6',
  sectionTitle: 'text-base font-semibold leading-6',
  body: 'text-sm leading-6',
  bodyMuted: 'text-sm leading-5',
  caption: 'text-xs leading-4',
  eyebrow: 'text-2xs font-semibold uppercase tracking-wide',
  action: 'text-sm font-semibold leading-5',
  chip: 'text-xs font-semibold leading-4',
  metric: 'text-[28px] font-extrabold leading-tight tracking-tight',
} as const;

export type TextRole = keyof typeof textRoleClassNames;

export function composeTextRole(role: TextRole, className?: string) {
  return `${textRoleClassNames[role]} ${className ?? ''}`.trim();
}

export interface TextProps extends RNTextProps {
  className?: string;
  colorRole?: SemanticForegroundRole;
  textRole?: TextRole;
}

const foregroundRoleByTextRole: Readonly<Record<TextRole, SemanticForegroundRole>> = {
  display: 'primary',
  screenTitle: 'primary',
  sectionTitle: 'primary',
  body: 'primary',
  bodyMuted: 'secondary',
  caption: 'tertiary',
  eyebrow: 'tertiary',
  action: 'primary',
  chip: 'primary',
  metric: 'primary',
};

export function Text({
  className = '',
  colorRole,
  textRole,
  allowFontScaling = true,
  style,
  ...props
}: TextProps) {
  const theme = useTheme();
  const resolvedClassName = textRole ? composeTextRole(textRole, className) : className;
  const resolvedColorRole = colorRole ?? (textRole ? foregroundRoleByTextRole[textRole] : undefined);
  const semanticColorStyle = resolvedColorRole
    ? { color: resolveThemeForeground(theme.colors, resolvedColorRole) }
    : undefined;

  return (
    <BaseText
      allowFontScaling={allowFontScaling}
      className={resolvedClassName}
      style={semanticColorStyle ? [semanticColorStyle, style] : style}
      {...props}
    />
  );
}

