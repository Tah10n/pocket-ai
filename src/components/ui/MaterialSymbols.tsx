import React from 'react';
import { Text, TextProps } from 'react-native';

export interface MaterialSymbolsProps extends TextProps {
  name: string;
  size?: number;
  color?: string;
  className?: string;
}

export const MaterialSymbols = ({ name, size = 24, className = '', style, ...rest }: MaterialSymbolsProps) => {
  return (
    <Text
      className={className}
      style={[
        {
          fontFamily: 'Material Symbols Outlined',
          fontSize: size,
          includeFontPadding: false,
          textAlignVertical: 'center',
        },
        style,
      ]}
      {...rest}
    >
      {name}
    </Text>
  );
};
