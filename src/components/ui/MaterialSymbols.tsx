import React from 'react';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { cssInterop } from 'nativewind';
import { iconSizePx, type SemanticIconSize } from '../../utils/themeTokens';

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
}

/**
 * Thin wrapper around @expo/vector-icons MaterialIcons that accepts
 * NativeWind className for colour (e.g. "text-primary-500").
 */
export function MaterialSymbols({ name, size = 'md', className, color }: MaterialSymbolsProps) {
  const resolvedSize = typeof size === 'number'
    ? size
    : iconSizePx[size];

  return (
    <MaterialIcons
      name={name}
      size={resolvedSize}
      className={className}
      color={color}
    />
  );
}
