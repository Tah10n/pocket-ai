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
    joinClassNames: (...values: Array<string | undefined | false>) => values.filter(Boolean).join(' '),
    ScreenAndroidContentBlurTarget: ({ children, ...props }: any) => mockReact.createElement(View, props, children),
    ScreenRoot: ({ children, ...props }: any) => mockReact.createElement(View, props, children),
    ScreenContent: ({ children, ...props }: any) => mockReact.createElement(View, props, children),
  };
});

jest.mock('../../src/components/ui/SearchHeader', () => {
  const mockReact = require('react');
  const { Pressable, Text, View } = require('react-native');
  return {
    SearchHeader: ({ activeTab, onOpenStorage, onSearchChange, onTabChange }: any) => mockReact.createElement(
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
      mockReact.createElement(
        Pressable,
        { testID: 'search-llama', onPress: () => onSearchChange('llama') },
        mockReact.createElement(Text, null, 'Search llama'),
      ),
      mockReact.createElement(
        Pressable,
        { testID: 'search-llama-again', onPress: () => onSearchChange('llama') },
        mockReact.createElement(Text, null, 'Search llama again'),
      ),
      mockReact.createElement(
        Pressable,
        { testID: 'search-mistral', onPress: () => onSearchChange('mistral') },
        mockReact.createElement(Text, null, 'Search mistral'),
      ),
      mockReact.createElement(
        Pressable,
        { testID: 'open-storage', onPress: () => onOpenStorage?.() },
        mockReact.createElement(Text, null, 'Open storage'),
      ),
    ),
  };
});

jest.mock('../../src/components/models/ModelsList', () => {
  const mockReact = require('react');
  const { Text, View } = require('react-native');
  return {
    ModelsList: ({ activeTab, androidContentBlurTargetRef, renderContentContainer, searchQuery, searchSessionKey }: any) => {
      const content = mockReact.createElement(
        View,
        { testID: 'models-list-props', androidContentBlurTargetRef },
        mockReact.createElement(Text, { testID: 'models-list-state' }, `${activeTab}:${searchQuery}:${searchSessionKey}`),
      );

      return renderContentContainer ? renderContentContainer(content) : content;
    },
  };
});

describe('ModelsCatalogScreen', () => {
  afterEach(() => {
    mockInitialTab = 'downloaded';
    mockPush.mockClear();
  });

  it('opens on the downloaded tab from route params and keeps tab changes on one screen', () => {
    const { getByTestId, queryByTestId } = render(<ModelsCatalogScreen />);

    expect(getByTestId('models-screen-content').props.style).toMatchObject({ paddingBottom: 0 });
    expect(queryByTestId('models-catalog-content-blur-target')).toBeTruthy();
    expect(getByTestId('models-list-props').props.androidContentBlurTargetRef)
      .toBe(getByTestId('models-catalog-content-blur-target').props.blurTargetRef);
    expect(getByTestId('models-active-tab').props.children).toBe('downloaded');
    expect(getByTestId('models-list-state').props.children).toBe('downloaded::0');

    fireEvent.press(getByTestId('switch-to-all'));

    expect(getByTestId('models-active-tab').props.children).toBe('all');
    expect(getByTestId('models-list-state').props.children).toBe('all::0');
  });

  it('defaults invalid route params to all and resyncs when params change', () => {
    mockInitialTab = 'unexpected';

    const { getByTestId, rerender } = render(<ModelsCatalogScreen />);

    expect(getByTestId('models-active-tab').props.children).toBe('all');
    expect(getByTestId('models-list-state').props.children).toBe('all::0');

    mockInitialTab = 'downloaded';
    rerender(<ModelsCatalogScreen />);

    expect(getByTestId('models-active-tab').props.children).toBe('downloaded');
    expect(getByTestId('models-list-state').props.children).toBe('downloaded::0');
  });

  it('updates the search session only when the query changes and opens storage from the header', () => {
    const { getByTestId } = render(<ModelsCatalogScreen />);

    fireEvent.press(getByTestId('search-llama'));
    expect(getByTestId('models-list-state').props.children).toBe('downloaded:llama:1');

    fireEvent.press(getByTestId('search-llama-again'));
    expect(getByTestId('models-list-state').props.children).toBe('downloaded:llama:1');

    fireEvent.press(getByTestId('search-mistral'));
    expect(getByTestId('models-list-state').props.children).toBe('downloaded:mistral:2');

    fireEvent.press(getByTestId('open-storage'));
    expect(mockPush).toHaveBeenCalledWith('/storage');
  });
});
