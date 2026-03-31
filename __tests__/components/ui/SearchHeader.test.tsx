import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { SearchHeader } from '../../../src/components/ui/SearchHeader';

jest.mock('react-native-css-interop', () => {
  const mockReact = require('react');
  return {
    createInteropElement: mockReact.createElement,
  };
});

jest.mock('../../../src/components/ui/ScreenShell', () => {
  const mockReact = require('react');
  const { Pressable, Text, TextInput, View } = require('react-native');

  return {
    ScreenHeaderShell: ({ children }: any) => mockReact.createElement(View, null, children),
    HeaderActionButton: ({ accessibilityLabel, onPress }: any) =>
      mockReact.createElement(Pressable, { accessibilityLabel, onPress }, mockReact.createElement(Text, null, 'action')),
    HeaderActionPlaceholder: () => mockReact.createElement(View, { testID: 'header-action-placeholder' }),
    HeaderBackButton: ({ accessibilityLabel, onPress }: any) =>
      mockReact.createElement(Pressable, { accessibilityLabel, onPress }, mockReact.createElement(Text, null, 'back')),
    ScreenInlineInput: ({ leadingAccessory, trailingAccessory, testID, ...props }: any) =>
      mockReact.createElement(
        View,
        { testID },
        leadingAccessory,
        mockReact.createElement(TextInput, props),
        trailingAccessory,
      ),
    ScreenIconButton: ({ accessibilityLabel, onPress, testID }: any) =>
      mockReact.createElement(
        Pressable,
        { accessibilityLabel, onPress, testID },
        mockReact.createElement(Text, null, 'icon'),
      ),
    ScreenSegmentedControl: ({ options, activeKey, onChange, testID }: any) =>
      mockReact.createElement(
        View,
        { testID },
        options.map((option: any) => mockReact.createElement(
          Pressable,
          {
            key: option.key,
            testID: option.testID,
            accessibilityRole: 'tab',
            accessibilityState: { selected: activeKey === option.key },
            onPress: () => onChange(option.key),
          },
          mockReact.createElement(Text, null, option.label),
        )),
      ),
  };
});

jest.mock('../../../src/components/ui/box', () => {
  const mockReact = require('react');
  const { View } = require('react-native');
  return {
    Box: ({ children, ...props }: any) => mockReact.createElement(View, props, children),
  };
});

jest.mock('../../../src/components/ui/text', () => {
  const mockReact = require('react');
  const { Text } = require('react-native');
  return {
    Text: ({ children, ...props }: any) => mockReact.createElement(Text, props, children),
    composeTextRole: (_role: string, className = '') => className,
  };
});

jest.mock('../../../src/components/ui/input', () => {
  const mockReact = require('react');
  const { TextInput, View } = require('react-native');
  return {
    Input: ({ children, ...props }: any) => mockReact.createElement(View, props, children),
    InputField: (props: any) => mockReact.createElement(TextInput, props),
  };
});

jest.mock('../../../src/components/ui/pressable', () => {
  const mockReact = require('react');
  const { Pressable } = require('react-native');
  return {
    Pressable: ({ children, ...props }: any) => mockReact.createElement(Pressable, props, children),
  };
});

jest.mock('../../../src/components/ui/MaterialSymbols', () => {
  const mockReact = require('react');
  const { Text } = require('react-native');
  return {
    MaterialSymbols: ({ name }: any) => mockReact.createElement(Text, null, name),
  };
});

describe('SearchHeader', () => {
  it('renders a shared tab control and switches between all and downloaded tabs', () => {
    const onTabChange = jest.fn();
    const { getByTestId } = render(
      <SearchHeader
        searchQuery=""
        onSearchChange={jest.fn()}
        activeTab="all"
        onTabChange={onTabChange}
        onOpenStorage={jest.fn()}
      />,
    );

    expect(getByTestId('models-tab-control')).toBeTruthy();
    expect(getByTestId('models-tab-all').props.accessibilityState.selected).toBe(true);
    expect(getByTestId('models-tab-downloaded').props.accessibilityState.selected).toBe(false);

    fireEvent.press(getByTestId('models-tab-downloaded'));
    expect(onTabChange).toHaveBeenCalledWith('downloaded');
  });

  it('clears the search query from the header clear action', () => {
    const onSearchChange = jest.fn();
    const { getByLabelText } = render(
      <SearchHeader
        searchQuery="llama"
        onSearchChange={onSearchChange}
        activeTab="all"
        onTabChange={jest.fn()}
      />,
    );

    fireEvent.press(getByLabelText('common.clear'));
    expect(onSearchChange).toHaveBeenCalledWith('');
  });
});
