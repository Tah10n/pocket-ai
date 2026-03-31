import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { ModelsCatalogScreen } from '../../src/ui/screens/ModelsCatalogScreen';

jest.mock('react-native-css-interop', () => {
  const mockReact = require('react');
  return {
    createInteropElement: mockReact.createElement,
  };
});

const mockPush = jest.fn();
let mockInitialTab: string | undefined = 'downloaded';

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
  useLocalSearchParams: () => ({ initialTab: mockInitialTab }),
}));

jest.mock('../../src/components/ui/box', () => {
  const mockReact = require('react');
  const { View } = require('react-native');
  return {
    Box: ({ children, ...props }: any) => mockReact.createElement(View, props, children),
  };
});

jest.mock('../../src/components/ui/ScreenShell', () => {
  const mockReact = require('react');
  const { View } = require('react-native');
  return {
    ScreenContent: ({ children, ...props }: any) => mockReact.createElement(View, props, children),
  };
});

jest.mock('../../src/components/ui/SearchHeader', () => {
  const mockReact = require('react');
  const { Pressable, Text, View } = require('react-native');
  return {
    SearchHeader: ({ activeTab, onTabChange }: any) => mockReact.createElement(
      View,
      null,
      mockReact.createElement(Text, { testID: 'models-active-tab' }, activeTab),
      mockReact.createElement(
        Pressable,
        { testID: 'switch-to-all', onPress: () => onTabChange('all') },
        mockReact.createElement(Text, null, 'All'),
      ),
      mockReact.createElement(
        Pressable,
        { testID: 'switch-to-downloaded', onPress: () => onTabChange('downloaded') },
        mockReact.createElement(Text, null, 'Downloaded'),
      ),
    ),
  };
});

jest.mock('../../src/components/models/ModelsList', () => {
  const mockReact = require('react');
  const { Text } = require('react-native');
  return {
    ModelsList: ({ activeTab, searchQuery }: any) =>
      mockReact.createElement(Text, { testID: 'models-list-state' }, `${activeTab}:${searchQuery}`),
  };
});

describe('ModelsCatalogScreen', () => {
  afterEach(() => {
    mockInitialTab = 'downloaded';
  });

  it('opens on the downloaded tab from route params and keeps tab changes on one screen', () => {
    const { getByTestId } = render(<ModelsCatalogScreen />);

    expect(getByTestId('models-active-tab').props.children).toBe('downloaded');
    expect(getByTestId('models-list-state').props.children).toBe('downloaded:');

    fireEvent.press(getByTestId('switch-to-all'));

    expect(getByTestId('models-active-tab').props.children).toBe('all');
    expect(getByTestId('models-list-state').props.children).toBe('all:');
  });
});
