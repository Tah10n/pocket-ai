import React from 'react';
import { Text as RNText, type TextProps as RNTextProps, type TextStyle } from 'react-native';
import { cssInterop } from 'nativewind';
import { useTheme } from '../../providers/ThemeProvider';
import { semanticColorTokens, withAlpha } from '../../utils/themeTokens';

const BaseText = cssInterop(RNText, { className: 'style' });

export const textRoleClassNames = {
  display: 'text-[26px] font-bold leading-8 tracking-tight text-typography-900 dark:text-typography-50',
  screenTitle: 'text-[20px] font-bold leading-6 text-typography-900 dark:text-typography-100',
  sectionTitle: 'text-base font-semibold leading-6 text-typography-900 dark:text-typography-100',
  body: 'text-sm leading-6 text-typography-800 dark:text-typography-100',
  bodyMuted: 'text-sm leading-5 text-typography-600 dark:text-typography-300',
  caption: 'text-xs leading-4 text-typography-600 dark:text-typography-400',
  eyebrow: 'text-2xs font-semibold uppercase tracking-wide text-typography-600 dark:text-typography-400',
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

const readableDarkGlassTypographyTokenBySource: Record<string, keyof typeof semanticColorTokens.typography> = {
  300: '200',
  400: '200',
  500: '300',
  600: '300',
};

function getDarkGlassReadableClassName(className: string) {
  return className
    .split(/\s+/)
    .map((rawToken) => {
      const match = /^(dark:)?text-typography-(\d+)(\/\d+)?$/.exec(rawToken);

      if (!match) {
        return rawToken;
      }

      const readableToken = readableDarkGlassTypographyTokenBySource[match[2]];
      if (!readableToken) {
        return rawToken;
      }

      return `${match[1] ?? ''}text-typography-${readableToken}${match[3] ?? ''}`;
    })
    .join(' ');
}

function getDarkGlassReadableColor(className: string): string | undefined {
  const tokens = className.split(/\s+/).filter(Boolean);

  for (const rawToken of [...tokens].reverse()) {
    const token = rawToken.startsWith('dark:') ? rawToken.slice('dark:'.length) : rawToken;
    const match = /^text-typography-(\d+)(?:\/(\d+))?$/.exec(token);

    if (!match) {
      continue;
    }

    const readableToken = readableDarkGlassTypographyTokenBySource[match[1]];
    if (!readableToken) {
      return undefined;
    }

    const color = semanticColorTokens.typography[readableToken];
    const opacity = match[2] ? Number(match[2]) / 100 : undefined;

    return Number.isFinite(opacity) && opacity !== undefined
      ? withAlpha(color, opacity)
      : color;
  }

  return undefined;
}

export function Text({
  className = '',
  textRole,
  allowFontScaling = true,
  style,
  ...props
}: TextProps) {
  const theme = useTheme();
  const resolvedClassName = textRole ? composeTextRole(textRole, className) : className;
  const isDarkGlass = theme.resolvedMode === 'dark' && theme.appearance.surfaceKind === 'glass';
  const darkGlassTextColor = isDarkGlass ? getDarkGlassReadableColor(resolvedClassName) : undefined;
  const readableDarkGlassTextStyle: TextStyle | undefined = darkGlassTextColor
    ? { color: darkGlassTextColor }
    : undefined;
  const resolvedReadableClassName = isDarkGlass
    ? getDarkGlassReadableClassName(resolvedClassName)
    : resolvedClassName;

  return (
    <BaseText
      allowFontScaling={allowFontScaling}
      className={resolvedReadableClassName}
      style={readableDarkGlassTextStyle ? [readableDarkGlassTextStyle, style] : style}
      {...props}
    />
  );
}

