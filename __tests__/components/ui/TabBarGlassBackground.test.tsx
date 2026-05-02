import React from 'react';
import { act, render } from '@testing-library/react-native';

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

function getExpectedTabBarBlurIntensity() {
  return Math.round(mockThemeContext.appearance.effects.surfaceBlurIntensity * 0.22);
}

function getFloatingFrameStyle(nodes: any[]) {
  const { StyleSheet } = require('react-native');
  const { bottomTabBarMetrics } = require('../../../src/utils/tabBarLayout');

  return nodes
    .map((node: any) => StyleSheet.flatten(node.props.style))
    .find((style: any) => style?.borderRadius === bottomTabBarMetrics.glassRadius);
}

function hasBackdropColor(nodes: any[], expectedColor: string) {
  const { StyleSheet } = require('react-native');

  return nodes.some((node: any) =>
    StyleSheet.flatten(node.props.style)?.backgroundColor === expectedColor,
  );
}

function getBlurBackdrop(nodes: any[]) {
  return nodes.find((node: any) =>
    node.props.pointerEvents === 'none'
    && node.props.intensity === getExpectedTabBarBlurIntensity(),
  );
}

function getGradientSignature(nodes: any[]) {
  const { StyleSheet } = require('react-native');

  return nodes
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

  it('keeps a visible matte island while waiting for an active Android blur target', () => {
    const { Platform } = require('react-native');
    const originalPlatform = Platform.OS;
    const originalVersion = Platform.Version;
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'android' });
    Object.defineProperty(Platform, 'Version', { configurable: true, get: () => 34 });

    try {
      const { queryByTestId, UNSAFE_getAllByType } = render(<TabBarGlassBackground />);
      const { View } = require('react-native');
      const views = UNSAFE_getAllByType(View);
      const blurBackdrop = views.find((node: any) =>
        node.props.pointerEvents === 'none'
        && node.props.intensity === getExpectedTabBarBlurIntensity(),
      );

      expect(queryByTestId('tab-bar-glass-blur-target')).toBeNull();
      expect(blurBackdrop).toBeUndefined();
      expect(hasBackdropColor(views, 'rgba(248,250,252,0.24)')).toBe(true);
    } finally {
      Object.defineProperty(Platform, 'OS', { configurable: true, get: () => originalPlatform });
      Object.defineProperty(Platform, 'Version', { configurable: true, get: () => originalVersion });
    }
  });

  it('uses clean translucent highlights for the dark matte island fallback', () => {
    const { Platform } = require('react-native');
    const { getThemeAppearance } = require('../../../src/utils/themeTokens');
    const originalPlatform = Platform.OS;
    const originalVersion = Platform.Version;
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'android' });
    Object.defineProperty(Platform, 'Version', { configurable: true, get: () => 34 });
    mockThemeContext = {
      ...mockThemeContext,
      appearance: getThemeAppearance('glass', 'dark'),
      colors: {
        ...mockThemeContext.colors,
        headerBlurTint: 'dark',
      },
    };

    try {
      const { UNSAFE_getAllByType } = render(<TabBarGlassBackground />);
      const { View } = require('react-native');
      const views = UNSAFE_getAllByType(View);

      expect(hasBackdropColor(views, 'rgba(6,11,20,0.24)')).toBe(true);
      expect(hasBackdropColor(views, 'rgba(244,247,251,0.22)')).toBe(true);
      expect(hasBackdropColor(views, 'rgba(15,23,42,0.24)')).toBe(false);
      expect(hasBackdropColor(views, 'rgba(255,255,255,0.16)')).toBe(false);
    } finally {
      Object.defineProperty(Platform, 'OS', { configurable: true, get: () => originalPlatform });
      Object.defineProperty(Platform, 'Version', { configurable: true, get: () => originalVersion });
    }
  });

  it('keeps light island highlights and skips dark feathered stripes', () => {
    const { View } = require('react-native');
    const { getThemeAppearance } = require('../../../src/utils/themeTokens');
    const lightRender = render(<TabBarGlassBackground />);
    const lightSignature = getGradientSignature(lightRender.UNSAFE_getAllByType(View));
    lightRender.unmount();

    mockThemeContext = {
      ...mockThemeContext,
      appearance: getThemeAppearance('glass', 'dark'),
      colors: {
        ...mockThemeContext.colors,
        headerBlurTint: 'dark',
      },
    };

    const darkRender = render(<TabBarGlassBackground />);
    const darkSignature = getGradientSignature(darkRender.UNSAFE_getAllByType(View));

    expect(lightSignature.length).toBeGreaterThan(0);
    expect(darkSignature).toHaveLength(lightSignature.length);
    for (const darkLayer of darkSignature) {
      expect(darkLayer.colors.join('|')).not.toContain('rgba(255,255,255');
      expect(darkLayer.colors.join('|')).not.toContain('rgba(244,247,251');
    }

    darkRender.unmount();
  });

  it('uses the active Android scene target for light glass tab bar blur', () => {
    const { Platform } = require('react-native');
    const { setActiveAndroidBlurTarget } = require('../../../src/utils/androidBlur');
    const originalPlatform = Platform.OS;
    const originalVersion = Platform.Version;
    const activeTarget = { current: {} };
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'android' });
    Object.defineProperty(Platform, 'Version', { configurable: true, get: () => 34 });
    let clearActiveTarget: (() => void) | undefined;

    try {
      const { UNSAFE_getAllByType } = render(<TabBarGlassBackground />);
      const { View } = require('react-native');

      expect(hasBackdropColor(UNSAFE_getAllByType(View), 'rgba(248,250,252,0.24)')).toBe(true);

      act(() => {
        clearActiveTarget = setActiveAndroidBlurTarget(activeTarget);
      });

      const views = UNSAFE_getAllByType(View);
      const blurBackdrop = getBlurBackdrop(views);

      expect(blurBackdrop?.props.blurTarget).toBe(activeTarget);
      expect(blurBackdrop?.props.blurMethod).toBe('dimezisBlurViewSdk31Plus');
      expect(blurBackdrop?.props.blurReductionFactor).toBe(mockThemeContext.appearance.effects.blurReductionFactor);
      expect(blurBackdrop?.props.tint).toBe('default');
      expect(hasBackdropColor(views, 'rgba(248,250,252,0.24)')).toBe(false);
      expect(hasBackdropColor(views, 'rgba(248,250,252,0.01)')).toBe(true);
    } finally {
      act(() => {
        clearActiveTarget?.();
      });
      Object.defineProperty(Platform, 'OS', { configurable: true, get: () => originalPlatform });
      Object.defineProperty(Platform, 'Version', { configurable: true, get: () => originalVersion });
    }
  });

  it('keeps matte fallback for a stale Android blur target ref with no native view', () => {
    const { Platform } = require('react-native');
    const { setActiveAndroidBlurTarget } = require('../../../src/utils/androidBlur');
    const originalPlatform = Platform.OS;
    const originalVersion = Platform.Version;
    const staleTarget = { current: null };
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'android' });
    Object.defineProperty(Platform, 'Version', { configurable: true, get: () => 34 });
    let clearActiveTarget: (() => void) | undefined;

    act(() => {
      clearActiveTarget = setActiveAndroidBlurTarget(staleTarget);
    });

    try {
      const { UNSAFE_getAllByType } = render(<TabBarGlassBackground />);
      const { View } = require('react-native');
      const views = UNSAFE_getAllByType(View);
      const blurBackdrop = views.find((node: any) =>
        node.props.pointerEvents === 'none'
        && node.props.intensity === getExpectedTabBarBlurIntensity(),
      );

      expect(blurBackdrop).toBeUndefined();
      expect(hasBackdropColor(views, 'rgba(248,250,252,0.24)')).toBe(true);
    } finally {
      act(() => {
        clearActiveTarget?.();
      });
      Object.defineProperty(Platform, 'OS', { configurable: true, get: () => originalPlatform });
      Object.defineProperty(Platform, 'Version', { configurable: true, get: () => originalVersion });
    }
  });

  it('blurs Android tab chrome through the active screen target without a nested tab target', () => {
    const { Platform } = require('react-native');
    const { setActiveAndroidBlurTarget } = require('../../../src/utils/androidBlur');
    const originalPlatform = Platform.OS;
    const originalVersion = Platform.Version;
    const activeTarget = { current: {} };
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'android' });
    Object.defineProperty(Platform, 'Version', { configurable: true, get: () => 34 });
    let clearActiveTarget: (() => void) | undefined;
    act(() => {
      clearActiveTarget = setActiveAndroidBlurTarget(activeTarget);
    });

    try {
      const { queryByTestId, UNSAFE_getAllByType, unmount } = render(<TabBarGlassBackground />);
      const { View } = require('react-native');
      const views = UNSAFE_getAllByType(View);
      const blurBackdrop = getBlurBackdrop(views);

      expect(queryByTestId('tab-bar-glass-blur-target')).toBeNull();
      expect(blurBackdrop?.props.blurTarget).toBe(activeTarget);
      expect(hasBackdropColor(views, 'rgba(248,250,252,0.24)')).toBe(false);
      unmount();
    } finally {
      act(() => {
        clearActiveTarget?.();
      });
      Object.defineProperty(Platform, 'OS', { configurable: true, get: () => originalPlatform });
      Object.defineProperty(Platform, 'Version', { configurable: true, get: () => originalVersion });
    }
  });

  it('tracks the active Android screen blur target stack for tab chrome', () => {
    const { Platform } = require('react-native');
    const { setActiveAndroidBlurTarget } = require('../../../src/utils/androidBlur');
    const originalPlatform = Platform.OS;
    const originalVersion = Platform.Version;
    const outerTarget = { current: {} };
    const nestedTarget = { current: {} };
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'android' });
    Object.defineProperty(Platform, 'Version', { configurable: true, get: () => 34 });
    let clearOuterTarget: (() => void) | undefined;
    let clearNestedTarget: (() => void) | undefined;

    function getRenderedBlurTarget(UNSAFE_getAllByType: any) {
      const { View } = require('react-native');
      const views = UNSAFE_getAllByType(View);
      const blurBackdrop = getBlurBackdrop(views);

      return blurBackdrop?.props.blurTarget;
    }

    try {
      act(() => {
        clearOuterTarget = setActiveAndroidBlurTarget(outerTarget);
      });
      const { UNSAFE_getAllByType, unmount } = render(<TabBarGlassBackground />);
      expect(getRenderedBlurTarget(UNSAFE_getAllByType)).toBe(outerTarget);

      act(() => {
        clearNestedTarget = setActiveAndroidBlurTarget(nestedTarget);
      });
      expect(getRenderedBlurTarget(UNSAFE_getAllByType)).toBe(nestedTarget);

      act(() => {
        clearNestedTarget?.();
      });
      expect(getRenderedBlurTarget(UNSAFE_getAllByType)).toBe(outerTarget);

      unmount();
    } finally {
      act(() => {
        clearNestedTarget?.();
        clearOuterTarget?.();
      });
      Object.defineProperty(Platform, 'OS', { configurable: true, get: () => originalPlatform });
      Object.defineProperty(Platform, 'Version', { configurable: true, get: () => originalVersion });
    }
  });

  it('uses native blur for dark Android glass tab bars', () => {
    const { Platform } = require('react-native');
    const { setActiveAndroidBlurTarget } = require('../../../src/utils/androidBlur');
    const { getThemeAppearance } = require('../../../src/utils/themeTokens');
    const originalPlatform = Platform.OS;
    const originalVersion = Platform.Version;
    const activeTarget = { current: {} };
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'android' });
    Object.defineProperty(Platform, 'Version', { configurable: true, get: () => 34 });
    let clearActiveTarget: (() => void) | undefined;
    act(() => {
      clearActiveTarget = setActiveAndroidBlurTarget(activeTarget);
    });
    mockThemeContext = {
      ...mockThemeContext,
      appearance: getThemeAppearance('glass', 'dark'),
      colors: {
        ...mockThemeContext.colors,
        headerBlurTint: 'dark',
      },
    };

    try {
      const { UNSAFE_getAllByType } = render(<TabBarGlassBackground />);
      const { View } = require('react-native');
      const views = UNSAFE_getAllByType(View);
      const blurBackdrop = getBlurBackdrop(views);

      expect(blurBackdrop?.props.blurTarget).toBe(activeTarget);
      expect(blurBackdrop?.props.blurMethod).toBe('dimezisBlurViewSdk31Plus');
      expect(blurBackdrop?.props.tint).toBe('dark');
      expect(hasBackdropColor(views, 'rgba(6,11,20,0.24)')).toBe(false);
      expect(hasBackdropColor(views, 'rgba(6,11,20,0.18)')).toBe(true);
      expect(hasBackdropColor(views, 'rgba(244,247,251,0.22)')).toBe(false);
      expect(hasBackdropColor(views, 'rgba(244,247,251,0.075)')).toBe(true);
    } finally {
      act(() => {
        clearActiveTarget?.();
      });
      Object.defineProperty(Platform, 'OS', { configurable: true, get: () => originalPlatform });
      Object.defineProperty(Platform, 'Version', { configurable: true, get: () => originalVersion });
    }
  });

  it('uses a light translucent glass tint fallback on legacy Android', () => {
    const { Platform } = require('react-native');
    const originalPlatform = Platform.OS;
    const originalVersion = Platform.Version;
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'android' });
    Object.defineProperty(Platform, 'Version', { configurable: true, get: () => 30 });

    try {
      const { UNSAFE_getAllByType } = render(<TabBarGlassBackground />);
      const { View } = require('react-native');
      const views = UNSAFE_getAllByType(View);

      expect(views.some((node: any) => node.props.intensity === getExpectedTabBarBlurIntensity())).toBe(false);
      expect(views.some((node: any) => typeof node.props.className === 'string'
        && node.props.className.includes('bg-background-0/82'))).toBe(false);
      expect(hasBackdropColor(views, 'rgba(248,250,252,0.24)')).toBe(true);
      expect(views.some((node: any) => Array.isArray(node.props.colors)
        && node.props.colors.includes('rgba(255,255,255,0.03)'))).toBe(false);
    } finally {
      Object.defineProperty(Platform, 'OS', { configurable: true, get: () => originalPlatform });
      Object.defineProperty(Platform, 'Version', { configurable: true, get: () => originalVersion });
    }
  });

  it('does not draw a native border around the floating glass tab bar', () => {
    mockThemeContext = {
      ...mockThemeContext,
      colors: {
        ...mockThemeContext.colors,
        headerBlurTint: 'dark',
      },
    };

    const { UNSAFE_getAllByType } = render(<TabBarGlassBackground />);
    const { View } = require('react-native');
    const frameStyle = getFloatingFrameStyle(UNSAFE_getAllByType(View));

    expect(frameStyle?.borderWidth).toBe(0);
    expect(frameStyle?.borderColor).toBeUndefined();
  });
});
