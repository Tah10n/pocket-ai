import React from 'react';
import { render } from '@testing-library/react-native';

const mockMaterialSymbols = jest.fn(({ name }: any) => {
  const mockReact = require('react');
  const { Text } = require('react-native');
  return mockReact.createElement(Text, null, name);
});

let mockSafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };

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
  useTheme: () => ({
    colors: { headerBlurTint: 'light' },
    resolvedMode: 'light',
  }),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => mockSafeAreaInsets,
}));

jest.mock('expo-blur', () => {
  const mockReact = require('react');
  const { View } = require('react-native');
  return {
    BlurView: ({ children, ...props }: any) => mockReact.createElement(View, props, children),
  };
});

const { ScreenContent, ScreenIconButton, ScreenInlineInput, ScreenSheet } = require('../../src/components/ui/ScreenShell');

describe('ScreenShell', () => {
  beforeEach(() => {
    mockMaterialSymbols.mockClear();
    mockSafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  });

  it('uses the normalized compact icon-button shape', () => {
    const { getByLabelText } = render(
      <ScreenIconButton iconName="close" accessibilityLabel="Close" size="compact" />,
    );

    expect(getByLabelText('Close').props.className).toContain('h-8 w-8 rounded-full');
    expect(mockMaterialSymbols.mock.calls[0][0].size).toBe('md');
  });

  it('uses the normalized sheet padding tokens', () => {
    const { getByTestId } = render(
      <ScreenSheet testID="screen-sheet">content</ScreenSheet>,
    );

    expect(getByTestId('screen-sheet').props.className).toContain('px-4');
    expect(getByTestId('screen-sheet').props.className).toContain('pt-5');
    expect(getByTestId('screen-sheet').props.className).toContain('pb-6');
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
});
