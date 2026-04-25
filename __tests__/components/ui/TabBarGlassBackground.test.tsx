import React from 'react';
import { render } from '@testing-library/react-native';

let mockThemeContext: any;

jest.mock('@/components/ui/box', () => {
  const mockReact = require('react');
  const { View } = require('react-native');
  return {
    Box: ({ children, ...props }: any) => mockReact.createElement(View, props, children),
  };
});

jest.mock('../../../src/providers/ThemeProvider', () => ({
  useTheme: () => mockThemeContext,
}));

jest.mock('expo-blur', () => {
  const mockReact = require('react');
  const { View } = require('react-native');
  return {
    BlurTargetView: ({ children, ...props }: any) => mockReact.createElement(View, props, children),
    BlurView: ({ children, ...props }: any) => mockReact.createElement(View, props, children),
  };
});

jest.mock('expo-linear-gradient', () => {
  const mockReact = require('react');
  const { View } = require('react-native');
  return {
    LinearGradient: ({ children, ...props }: any) => mockReact.createElement(View, props, children),
  };
});

const { TabBarGlassBackground } = require('../../../src/components/ui/TabBarGlassBackground');

describe('TabBarGlassBackground', () => {
  beforeEach(() => {
    const { getThemeAppearance } = require('../../../src/utils/themeTokens');
    mockThemeContext = {
      appearance: getThemeAppearance('glass', 'light'),
      colors: {
        headerBlurTint: 'light',
        tabBarBackground: '#ffffff',
        tabBarBorder: '#eeeeee',
      },
    };
  });

  it('uses a static Android blur target when SDK blur is supported', () => {
    const { Platform } = require('react-native');
    const originalPlatform = Platform.OS;
    const originalVersion = Platform.Version;
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'android' });
    Object.defineProperty(Platform, 'Version', { configurable: true, get: () => 34 });

    try {
      const { getByTestId, UNSAFE_getAllByType } = render(<TabBarGlassBackground />);
      const { View } = require('react-native');
      const views = UNSAFE_getAllByType(View);
      const blurBackdrop = views.find((node: any) =>
        node.props.pointerEvents === 'none'
        && node.props.intensity === mockThemeContext.appearance.effects.surfaceBlurIntensity,
      );

      expect(getByTestId('tab-bar-glass-blur-target')).toBeTruthy();
      expect(blurBackdrop?.props.blurTarget).toBeDefined();
      expect(blurBackdrop?.props.blurMethod).toBe('dimezisBlurViewSdk31Plus');
      expect(blurBackdrop?.props.blurReductionFactor).toBe(mockThemeContext.appearance.effects.blurReductionFactor);
    } finally {
      Object.defineProperty(Platform, 'OS', { configurable: true, get: () => originalPlatform });
      Object.defineProperty(Platform, 'Version', { configurable: true, get: () => originalVersion });
    }
  });

  it('uses a dense tint fallback on legacy Android', () => {
    const { Platform } = require('react-native');
    const originalPlatform = Platform.OS;
    const originalVersion = Platform.Version;
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'android' });
    Object.defineProperty(Platform, 'Version', { configurable: true, get: () => 30 });

    try {
      const { UNSAFE_getAllByType } = render(<TabBarGlassBackground />);
      const { View } = require('react-native');
      const views = UNSAFE_getAllByType(View);

      expect(views.some((node: any) => node.props.intensity === mockThemeContext.appearance.effects.surfaceBlurIntensity)).toBe(false);
      expect(views.some((node: any) => typeof node.props.className === 'string'
        && node.props.className.includes('bg-background-0/82'))).toBe(true);
    } finally {
      Object.defineProperty(Platform, 'OS', { configurable: true, get: () => originalPlatform });
      Object.defineProperty(Platform, 'Version', { configurable: true, get: () => originalVersion });
    }
  });
});
