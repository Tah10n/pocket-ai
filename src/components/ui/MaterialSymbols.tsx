import React, { forwardRef } from 'react';
import { Text } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { cssInterop } from 'react-native-css-interop';

export interface MaterialSymbolsProps {
  name: React.ComponentProps<typeof MaterialIcons>['name'];
  size?: number;
  color?: string;
  className?: string;
}

const MaterialSymbolsBase = forwardRef<Text, MaterialSymbolsProps>(
  ({ name, size = 24, color, className, ...rest }, ref) => {
    return (
      <MaterialIcons
        ref={ref as any}
        name={name}
        size={size}
        color={color}
        {...rest}
      />
    );
  }
);

cssInterop(MaterialSymbolsBase, {
  className: 'style',
});

export const MaterialSymbols = MaterialSymbolsBase;
