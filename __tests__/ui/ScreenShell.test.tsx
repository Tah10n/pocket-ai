import React from 'react';
import { render } from '@testing-library/react-native';

const mockMaterialSymbols = jest.fn(({ name }: any) => {
  const mockReact = require('react');
  const { Text } = require('react-native');
  return mockReact.createElement(Text, null, name);
});

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
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

jest.mock('expo-blur', () => {
  const mockReact = require('react');
  const { View } = require('react-native');
  return {
    BlurView: ({ children, ...props }: any) => mockReact.createElement(View, props, children),
  };
});

const { ScreenIconButton, ScreenSheet } = require('../../src/components/ui/ScreenShell');

describe('ScreenShell', () => {
  beforeEach(() => {
    mockMaterialSymbols.mockClear();
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
});
