import React from 'react';
import { render } from '@testing-library/react-native';

const mockMaterialSymbols = jest.fn(({ name }: any) => {
  const mockReact = require('react');
  const { Text } = require('react-native');
  return mockReact.createElement(Text, null, name);
});

let mockSafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };
let mockThemeContext: any = {
  colors: { background: '#fff', headerBlurTint: 'light' },
  resolvedMode: 'light',
  themeId: 'default',
};

jest.mock('react-native-css-interop', () => {
  const mockReact = require('react');
  return {
    createInteropElement: mockReact.createElement,
  };
});

jest.mock('@/components/ui/box', () => {
  const mockReact = require('react');
  const { View } = require('react-native');
  return {
    Box: ({ children, ...props }: any) => mockReact.createElement(View, props, children),
  };
});

jest.mock('@/components/ui/input', () => {
  const mockReact = require('react');
  const { TextInput, View } = require('react-native');
  return {
    Input: ({ children, ...props }: any) => mockReact.createElement(View, props, children),
    InputField: (props: any) => mockReact.createElement(TextInput, props),
  };
});

jest.mock('@/components/ui/pressable', () => {
  const mockReact = require('react');
  const { Pressable } = require('react-native');
  return {
    Pressable: ({ children, ...props }: any) => mockReact.createElement(Pressable, props, children),
  };
});

jest.mock('@/components/ui/text', () => {
  const mockReact = require('react');
  const { Text } = require('react-native');
  return {
    Text: ({ children, ...props }: any) => mockReact.createElement(Text, props, children),
    composeTextRole: (_role: string, className = '') => className,
  };
});

jest.mock('../../src/components/ui/MaterialSymbols', () => ({
  MaterialSymbols: (props: any) => mockMaterialSymbols(props),
}));

jest.mock('../../src/providers/ThemeProvider', () => ({
  useTheme: () => mockThemeContext,
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => mockSafeAreaInsets,
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

const { ScreenCard, ScreenContent, ScreenIconButton, ScreenIconTile, ScreenInlineInput, ScreenRoot, ScreenSheet } = require('../../src/components/ui/ScreenShell');

describe('ScreenShell', () => {
  beforeEach(() => {
    mockMaterialSymbols.mockClear();
    mockSafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };
    mockThemeContext = {
      colors: { background: '#fff', headerBlurTint: 'light' },
      resolvedMode: 'light',
      themeId: 'default',
    };
  });

  it('applies the runtime theme background through ScreenRoot', () => {
    const { getByTestId } = render(
      <ScreenRoot testID="screen-root">content</ScreenRoot>,
    );

    expect(getByTestId('screen-root').props.className).toContain('flex-1');
    expect(getByTestId('screen-root').props.style).toEqual(expect.arrayContaining([
      expect.objectContaining({ backgroundColor: '#fff' }),
    ]));
  });

  it('uses the normalized compact icon-button shape', () => {
    const { getByLabelText } = render(
      <ScreenIconButton iconName="close" accessibilityLabel="Close" size="compact" />,
    );

    expect(getByLabelText('Close').props.className).toContain('h-8 w-8 rounded-full');
    expect(mockMaterialSymbols.mock.calls[0][0].size).toBe('md');
  });

  it('keeps icon tiles on an explicit vector-icon color across visual theme toggles', () => {
    const { getThemeAppearance, getThemeToneIconColor } = require('../../src/utils/themeTokens');
    const expectedColor = getThemeToneIconColor('info', 'light');
    mockThemeContext = {
      colors: { background: '#fff', headerBlurTint: 'light' },
      resolvedMode: 'light',
      themeId: 'default',
      appearance: getThemeAppearance('default', 'light'),
    };

    const { rerender } = render(
      <ScreenIconTile iconName="palette" tone="info" />,
    );

    expect(mockMaterialSymbols.mock.calls[mockMaterialSymbols.mock.calls.length - 1]?.[0]).toEqual(expect.objectContaining({
      name: 'palette',
      color: expectedColor,
    }));

    mockThemeContext = {
      ...mockThemeContext,
      themeId: 'glass',
      appearance: getThemeAppearance('glass', 'light'),
    };
    rerender(<ScreenIconTile iconName="palette" tone="info" />);
    expect(mockMaterialSymbols.mock.calls[mockMaterialSymbols.mock.calls.length - 1]?.[0]).toEqual(expect.objectContaining({
      name: 'palette',
      color: expectedColor,
    }));

    mockThemeContext = {
      ...mockThemeContext,
      themeId: 'default',
      appearance: getThemeAppearance('default', 'light'),
    };
    rerender(<ScreenIconTile iconName="palette" tone="info" />);
    expect(mockMaterialSymbols.mock.calls[mockMaterialSymbols.mock.calls.length - 1]?.[0]).toEqual(expect.objectContaining({
      name: 'palette',
      color: expectedColor,
    }));
  });

  it('uses the normalized sheet padding tokens', () => {
    const { getByTestId } = render(
      <ScreenSheet testID="screen-sheet">content</ScreenSheet>,
    );

    expect(getByTestId('screen-sheet').props.className).toContain('px-4');
    expect(getByTestId('screen-sheet').props.className).toContain('pt-5');
  });

  it('keeps glass cards as inline tint surfaces without a frosted backdrop', () => {
    const { getThemeAppearance } = require('../../src/utils/themeTokens');
    const appearance = getThemeAppearance('glass', 'light');
    mockThemeContext = {
      colors: { background: '#fff', headerBlurTint: 'light' },
      resolvedMode: 'light',
      themeId: 'glass',
      appearance,
    };

    const { getByTestId, UNSAFE_getAllByType } = render(
      <ScreenCard testID="glass-card">content</ScreenCard>,
    );

    expect(getByTestId('glass-card').props.className).toContain('px-4 py-3');
    expect(getByTestId('glass-card').props.className).toContain('bg-background-0/72');
    expect(getByTestId('glass-card').props.className).not.toContain('relative overflow-hidden');

    const { View } = require('react-native');
    const blurBackdrop = UNSAFE_getAllByType(View).find((node: any) =>
      node.props.pointerEvents === 'none'
      && node.props.intensity === appearance.effects.surfaceBlurIntensity,
    );
    expect(blurBackdrop).toBeUndefined();
  });

  it('renders frosted backdrops for compact glass controls', () => {
    const { getThemeAppearance } = require('../../src/utils/themeTokens');
    const appearance = getThemeAppearance('glass', 'light');
    mockThemeContext = {
      colors: { background: '#fff', headerBlurTint: 'light' },
      resolvedMode: 'light',
      themeId: 'glass',
      appearance,
    };

    const { getByLabelText, UNSAFE_getAllByType } = render(
      <ScreenIconButton iconName="close" accessibilityLabel="Close" size="compact" />,
    );

    expect(getByLabelText('Close').props.className).toContain('relative overflow-hidden');

    const { View } = require('react-native');
    const blurBackdrop = UNSAFE_getAllByType(View).find((node: any) =>
      node.props.pointerEvents === 'none'
      && node.props.intensity === appearance.effects.surfaceBlurIntensity,
    );
    expect(blurBackdrop).toBeTruthy();
  });

  it('connects glass surfaces to a static Android blur target', () => {
    const { Platform } = require('react-native');
    const { getThemeAppearance } = require('../../src/utils/themeTokens');
    const originalPlatform = Platform.OS;
    const originalVersion = Platform.Version;
    const appearance = getThemeAppearance('glass', 'light');
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'android' });
    Object.defineProperty(Platform, 'Version', { configurable: true, get: () => 34 });
    mockThemeContext = {
      colors: { background: '#fff', headerBlurTint: 'light' },
      resolvedMode: 'light',
      themeId: 'glass',
      appearance,
    };

    try {
      const { getByTestId, UNSAFE_getAllByType } = render(
        <ScreenRoot>
          <ScreenSheet testID="android-glass-sheet">content</ScreenSheet>
        </ScreenRoot>,
      );

      const { View } = require('react-native');
      const views = UNSAFE_getAllByType(View);
      const blurBackdrop = views.find((node: any) =>
        node.props.pointerEvents === 'none'
        && node.props.intensity === appearance.effects.surfaceBlurIntensity,
      );

      expect(getByTestId('screen-glass-blur-target')).toBeTruthy();
      expect(blurBackdrop?.props.blurTarget).toBeDefined();
      expect(blurBackdrop?.props.blurMethod).toBe('dimezisBlurViewSdk31Plus');
      expect(blurBackdrop?.props.blurReductionFactor).toBe(appearance.effects.blurReductionFactor);
    } finally {
      Object.defineProperty(Platform, 'OS', { configurable: true, get: () => originalPlatform });
      Object.defineProperty(Platform, 'Version', { configurable: true, get: () => originalVersion });
    }
  });

  it('falls back to dense tint surfaces instead of BlurView on pre-31 Android', () => {
    const { Platform } = require('react-native');
    const { getThemeAppearance } = require('../../src/utils/themeTokens');
    const originalPlatform = Platform.OS;
    const originalVersion = Platform.Version;
    const appearance = getThemeAppearance('glass', 'light');
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'android' });
    Object.defineProperty(Platform, 'Version', { configurable: true, get: () => 30 });
    mockThemeContext = {
      colors: { background: '#fff', headerBlurTint: 'light' },
      resolvedMode: 'light',
      themeId: 'glass',
      appearance,
    };

    try {
      const { UNSAFE_getAllByType } = render(
        <ScreenRoot>
          <ScreenSheet testID="legacy-glass-sheet">content</ScreenSheet>
        </ScreenRoot>,
      );

      const { View } = require('react-native');
      const views = UNSAFE_getAllByType(View);
      expect(views.some((node: any) => node.props.intensity === appearance.effects.surfaceBlurIntensity)).toBe(false);
      expect(views.some((node: any) => typeof node.props.className === 'string'
        && node.props.className.includes('bg-background-0/82'))).toBe(true);
    } finally {
      Object.defineProperty(Platform, 'OS', { configurable: true, get: () => originalPlatform });
      Object.defineProperty(Platform, 'Version', { configurable: true, get: () => originalVersion });
    }
  });

  it('adds native bottom safe area space to sheet padding', () => {
    const { Platform, StyleSheet } = require('react-native');
    const { screenLayoutMetrics } = require('../../src/utils/themeTokens');
    const originalPlatform = Platform.OS;
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'android' });
    mockSafeAreaInsets = { top: 0, right: 0, bottom: 18, left: 0 };

    try {
      const { getByTestId } = render(
        <ScreenSheet testID="safe-screen-sheet">content</ScreenSheet>,
      );

      expect(StyleSheet.flatten(getByTestId('safe-screen-sheet').props.style).paddingBottom)
        .toBe(screenLayoutMetrics.sheetBottomInset + 18);
    } finally {
      Object.defineProperty(Platform, 'OS', { configurable: true, get: () => originalPlatform });
    }
  });

  it('keeps inline inputs inside the shared input shell', () => {
    const { UNSAFE_getAllByType } = render(
      <ScreenInlineInput
        containerTestID="inline-input-shell"
        testID="inline-input-field"
        variant="search"
        value=""
        onChangeText={jest.fn()}
      />,
    );

    const { View } = require('react-native');
    const requiredClasses = [
      'min-w-0',
      'flex-1',
      'border-0',
      'bg-transparent',
      'px-0',
    ];
    const shell = UNSAFE_getAllByType(View).find((node: any) =>
      typeof node.props.className === 'string'
      && requiredClasses.every((token) => node.props.className.split(/\s+/).includes(token)),
    );

    expect(shell).toBeTruthy();
  });

  it('does not inject native bottom safe area padding by default', () => {
    const { Platform, StyleSheet } = require('react-native');
    const originalPlatform = Platform.OS;
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'ios' });
    mockSafeAreaInsets = { top: 0, right: 0, bottom: 32, left: 0 };

    try {
      const { getByTestId } = render(
        <ScreenContent testID="screen-content" className="pb-0">content</ScreenContent>,
      );

      expect(StyleSheet.flatten(getByTestId('screen-content').props.style)?.paddingBottom).toBeUndefined();
    } finally {
      Object.defineProperty(Platform, 'OS', { configurable: true, get: () => originalPlatform });
    }
  });

  it('adds native bottom safe area space to opted-in screen content padding', () => {
    const { Platform, StyleSheet } = require('react-native');
    const { screenLayoutMetrics } = require('../../src/utils/themeTokens');
    const originalPlatform = Platform.OS;
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'ios' });
    mockSafeAreaInsets = { top: 0, right: 0, bottom: 32, left: 0 };

    try {
      const { getByTestId } = render(
        <ScreenContent testID="safe-screen-content" includeBottomSafeArea>content</ScreenContent>,
      );

      expect(StyleSheet.flatten(getByTestId('safe-screen-content').props.style).paddingBottom)
        .toBe(screenLayoutMetrics.contentBottomInset + 32);
    } finally {
      Object.defineProperty(Platform, 'OS', { configurable: true, get: () => originalPlatform });
    }
  });

  it('adds extra bottom inset for floating screen overlays', () => {
    const { StyleSheet } = require('react-native');
    const { screenLayoutMetrics } = require('../../src/utils/themeTokens');

    const { getByTestId } = render(
      <ScreenContent testID="extra-screen-content" extraBottomInset={96}>content</ScreenContent>,
    );

    expect(StyleSheet.flatten(getByTestId('extra-screen-content').props.style).paddingBottom)
      .toBe(screenLayoutMetrics.contentBottomInset + 96);
  });
});
