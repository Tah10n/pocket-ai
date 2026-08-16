import type { ThemeColors } from './legacyTheme';

export type SemanticForegroundRole =
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'inverse'
  | 'icon'
  | 'iconMuted'
  | 'accent'
  | 'onAccent'
  | 'onSuccess'
  | 'onError'
  | 'softAction'
  | 'toneNeutral'
  | 'toneAccent'
  | 'statusAccent'
  | 'statusWarning'
  | 'toneIconNeutral'
  | 'toneIconAccent'
  | 'toneIconInfo'
  | 'toneIconSuccess'
  | 'toneIconWarning'
  | 'toneIconDanger'
  | 'info'
  | 'success'
  | 'warning'
  | 'danger';

export function resolveThemeForeground(
  colors: ThemeColors,
  role: SemanticForegroundRole,
): string {
  switch (role) {
    case 'primary':
      return colors.text;
    case 'secondary':
      return colors.textSecondary;
    case 'tertiary':
      return colors.textTertiary;
    case 'inverse':
      return colors.textInverse;
    case 'icon':
      return colors.icon;
    case 'iconMuted':
      return colors.iconMuted;
    case 'accent':
      return colors.primaryStrong;
    case 'onAccent':
      return colors.textOnPrimary;
    case 'onSuccess':
      return colors.textOnSuccess;
    case 'onError':
      return colors.textOnError;
    case 'softAction':
      return colors.textOnSoftAction;
    case 'toneNeutral':
      return colors.textToneNeutral;
    case 'toneAccent':
      return colors.textToneAccent;
    case 'statusAccent':
      return colors.textStatusAccent;
    case 'statusWarning':
      return colors.textStatusWarning;
    case 'toneIconNeutral':
      return colors.iconToneNeutral;
    case 'toneIconAccent':
      return colors.iconToneAccent;
    case 'toneIconInfo':
      return colors.iconToneInfo;
    case 'toneIconSuccess':
      return colors.iconToneSuccess;
    case 'toneIconWarning':
      return colors.iconToneWarning;
    case 'toneIconDanger':
      return colors.iconToneDanger;
    case 'info':
      return colors.textInfo;
    case 'success':
      return colors.textSuccess;
    case 'warning':
      return colors.textWarning;
    case 'danger':
      return colors.textDanger;
  }
}
