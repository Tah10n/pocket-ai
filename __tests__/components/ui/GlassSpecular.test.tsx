import React from 'react';
import { render } from '@testing-library/react-native';

jest.mock('@/components/ui/box', () => {
  const mockReact = require('react');
  const { View } = require('react-native');
  return {
    Box: ({ children, ...props }: any) => mockReact.createElement(View, props, children),
  };
});

jest.mock('expo-linear-gradient', () => {
  const mockReact = require('react');
  const { View } = require('react-native');
  return {
    LinearGradient: ({ children, ...props }: any) => mockReact.createElement(View, props, children),
  };
});

const { GlassSpecular } = require('../../../src/components/ui/GlassSpecular');

function getGradientSignature(tint: 'light' | 'dark') {
  const { StyleSheet, View } = require('react-native');
  const { UNSAFE_queryAllByType } = render(<GlassSpecular tint={tint} />);

  return UNSAFE_queryAllByType(View)
    .filter((node: any) => Array.isArray(node.props.colors))
    .map((node: any) => ({
      alphaStops: node.props.colors.map((color: string) => color.match(/rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)/)?.[1]),
      colors: node.props.colors,
      end: node.props.end,
      locations: node.props.locations,
      start: node.props.start,
      style: StyleSheet.flatten(node.props.style),
    }));
}

describe('GlassSpecular', () => {
  it('keeps light highlights and uses color-safe dark specular sheen', () => {
    const lightSignature = getGradientSignature('light');
    const darkSignature = getGradientSignature('dark');

    expect(lightSignature.length).toBeGreaterThan(0);
    expect(lightSignature.every((layer: any) => layer.colors.join('|').includes('rgba(255,255,255'))).toBe(true);
    expect(darkSignature).toHaveLength(lightSignature.length);
    expect(darkSignature.some((layer: any) => layer.colors.join('|').includes('rgba(125,211,252'))).toBe(true);
    expect(darkSignature.every((layer: any) => !layer.colors.join('|').includes('rgba(255,255,255'))).toBe(true);
    expect(darkSignature.every((layer: any) => !layer.colors.join('|').includes('rgba(244,247,251'))).toBe(true);
  });
});
