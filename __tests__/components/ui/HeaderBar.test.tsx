import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { Text as NativeText } from 'react-native';

const mockMaterialSymbols = jest.fn(({ name, ...props }: any) => {
  const mockReact = require('react');
  const { Text } = require('react-native');
  return mockReact.createElement(Text, props, name);
});

jest.mock('../../../src/components/ui/box', () => {
  const mockReact = require('react');
  const { View } = require('react-native');
  return {
    Box: ({ children, ...props }: any) => mockReact.createElement(View, props, children),
  };
});

jest.mock('../../../src/components/ui/MaterialSymbols', () => ({
  MaterialSymbols: (props: any) => mockMaterialSymbols(props),
}));

jest.mock('../../../src/components/ui/ScreenShell', () => {
  const mockReact = require('react');
  const { Pressable, Text, View } = require('react-native');
  return {
    ScreenHeaderShell: ({ children, ...props }: any) => mockReact.createElement(View, props, children),
    HeaderActionPlaceholder: (props: any) => mockReact.createElement(View, { testID: 'header-action-placeholder', ...props }),
    ScreenIconTile: ({ iconName, iconSize }: any) => {
      mockMaterialSymbols({ name: iconName, size: iconSize });
      return mockReact.createElement(Text, null, iconName);
    },
    HeaderBackButton: ({ onPress, accessibilityLabel, testID }: any) => mockReact.createElement(
      Pressable,
      { onPress, accessibilityLabel, testID: testID ?? 'header-back-button' },
      mockReact.createElement(Text, null, 'back'),
    ),
    HeaderTitleBlock: ({ title, subtitle, titleLines }: any) => mockReact.createElement(
      View,
      { testID: 'header-title-block', titleLines },
      mockReact.createElement(Text, null, title),
      subtitle ? mockReact.createElement(Text, null, subtitle) : null,
    ),
  };
});

import { HeaderBar } from '../../../src/components/ui/HeaderBar';

describe('HeaderBar', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders placeholder actions when back, brand, and accessory are absent', () => {
    const screen = render(<HeaderBar title="Pocket AI" />);

    expect(screen.getByText('Pocket AI')).toBeTruthy();
    expect(screen.getAllByTestId('header-action-placeholder')).toHaveLength(2);
  });

  it('renders the brand icon branch when requested', () => {
    const screen = render(
      <HeaderBar title="Pocket AI" showBrand brandIconName="settings" />,
    );

    expect(screen.getByText('Pocket AI')).toBeTruthy();
    expect(mockMaterialSymbols).toHaveBeenCalledWith(expect.objectContaining({
      name: 'settings',
      size: 'xl',
    }));
  });

  it('uses the provided back label and custom right accessory', () => {
    const onBack = jest.fn();
    const screen = render(
      <HeaderBar
        title="Pocket AI"
        subtitle="Subtitle"
        onBack={onBack}
        backAccessibilityLabel="Go back custom"
        backButtonTestID="custom-back-button"
        rightAccessory={<NativeText>Accessory</NativeText>}
      />,
    );

    fireEvent.press(screen.getByLabelText('Go back custom'));

    expect(onBack).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Accessory')).toBeTruthy();
    expect(screen.getByText('Subtitle')).toBeTruthy();
  });
});
