import React from 'react';
import { render } from '@testing-library/react-native';

const mockTabsProps = jest.fn();
let mockThemeContext: any;

jest.mock('expo-router', () => {
  const mockReact = require('react');
  const { View } = require('react-native');
  const Tabs = ({ children, ...props }: any) => {
    mockTabsProps(props);

    return mockReact.createElement(View, { testID: 'tabs' }, children);
  };
  Tabs.Screen = ({ name }: any) => mockReact.createElement(View, { testID: `tab-${name}` });

  return { Tabs };
});

jest.mock('expo-linear-gradient', () => {
  const mockReact = require('react');
  const { View } = require('react-native');
  return {
    LinearGradient: ({ children, ...props }: any) => mockReact.createElement(View, props, children),
  };
});

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

jest.mock('../../src/components/ui/box', () => {
  const mockReact = require('react');
  const { View } = require('react-native');
  return {
    Box: ({ children, ...props }: any) => mockReact.createElement(View, props, children),
  };
});

jest.mock('../../src/components/ui/MaterialSymbols', () => {
  const mockReact = require('react');
  const { Text } = require('react-native');
  return {
    MaterialSymbols: ({ name }: any) => mockReact.createElement(Text, null, name),
  };
});

jest.mock('../../src/components/ui/TabBarGlassBackground', () => {
  const mockReact = require('react');
  const { View } = require('react-native');
  return {
    TabBarGlassBackground: () => mockReact.createElement(View, { testID: 'tab-bar-glass-background' }),
  };
});

jest.mock('../../src/providers/ThemeProvider', () => ({
  useTheme: () => mockThemeContext,
}));

const TabLayout = require('../../app/(tabs)/_layout').default;

function getLatestScreenOptions() {
  return mockTabsProps.mock.calls[mockTabsProps.mock.calls.length - 1]?.[0]?.screenOptions;
}

describe('TabLayout', () => {
  beforeEach(() => {
    mockTabsProps.mockClear();
    const { getThemeAppearance, getThemeColors } = require('../../src/utils/themeTokens');
    mockThemeContext = {
      appearance: getThemeAppearance('default', 'light'),
      colors: getThemeColors('light', 'default'),
    };
  });

  it('lets the native tab style own the standard-theme background', () => {
    render(<TabLayout />);

    const screenOptions = getLatestScreenOptions();

    expect(screenOptions.tabBarBackground).toBeUndefined();
    expect(screenOptions.tabBarStyle.backgroundColor).not.toBe('transparent');
  });

  it('installs a keyed glass tab background when switching to the glass island', () => {
    const { getThemeAppearance, getThemeColors } = require('../../src/utils/themeTokens');
    mockThemeContext = {
      appearance: getThemeAppearance('glass', 'light'),
      colors: getThemeColors('light', 'glass'),
    };

    render(<TabLayout />);

    const screenOptions = getLatestScreenOptions();
    const tabBarBackground = screenOptions.tabBarBackground();

    expect(screenOptions.tabBarStyle.backgroundColor).toBe('transparent');
    expect(tabBarBackground.key).toBe('glass-light');
  });
});
