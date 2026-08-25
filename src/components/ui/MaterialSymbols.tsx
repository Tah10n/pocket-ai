import React from 'react';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { cssInterop } from 'nativewind';
import { iconSizePx, type SemanticIconSize } from '../../utils/themeTokens';
import { useTheme } from '../../providers/ThemeProvider';
import { resolveThemeForeground, type SemanticForegroundRole } from '../../design-system/themes/foreground';

export type MaterialSymbolName = React.ComponentProps<typeof MaterialIcons>['name'];

// Register MaterialIcons with NativeWind so className is processed correctly.
// Without this, NativeWind's printUpgradeWarning crashes by trying to
// JSON.stringify props that contain React Navigation context proxies.
cssInterop(MaterialIcons, { className: 'style' });

export interface MaterialSymbolsProps {
  /**
   * Icon name from @expo/vector-icons MaterialIcons set.
   * Use the exact name as-is (e.g. 'arrow-back', 'chevron-right', 'add-comment').
   * NOTE: MaterialIcons uses dashes, NOT underscores ('arrow-back', not 'arrow_back').
   */
  name: MaterialSymbolName;
  size?: number | SemanticIconSize;
  className?: string;
  color?: string;
  colorRole?: SemanticForegroundRole;
}

/**
 * Thin wrapper around MaterialIcons with semantic theme-aware foreground roles.
 */
export function MaterialSymbols({ name, size = 'md', className, color, colorRole }: MaterialSymbolsProps) {
  const { colors } = useTheme();
  const resolvedSize = typeof size === 'number'
    ? size
    : iconSizePx[size];

  return (
    <MaterialIcons
      name={name}
      size={resolvedSize}
      className={className}
      color={color ?? (colorRole ? resolveThemeForeground(colors, colorRole) : undefined)}
    />
  );
}
