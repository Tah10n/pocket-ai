import React, { forwardRef } from 'react';
import { Text } from '@/components/ui/text';
import { MaterialIcons } from '@expo/vector-icons';
import { cssInterop } from 'react-native-css-interop';
import type { StyleProp, TextStyle } from 'react-native';

export interface MaterialSymbolsProps {
  name: React.ComponentProps<typeof MaterialIcons>['name'];
  size?: number;
  color?: string;
  className?: string;
  style?: StyleProp<TextStyle>;
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

MaterialSymbolsBase.displayName = 'MaterialSymbols';

cssInterop(MaterialSymbolsBase, {
  className: 'style',
});

export const MaterialSymbols = MaterialSymbolsBase;
