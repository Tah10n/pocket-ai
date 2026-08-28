import React from 'react';
import { render } from '@testing-library/react-native';

const mockTabsProps = jest.fn();
const mockTabScreenProps = jest.fn();
const mockHasActiveChatGenerationWork = jest.fn(() => false);
let mockThemeContext: any;

jest.mock('expo-router', () => {
  const mockReact = require('react');
  const { View } = require('react-native');
  const Tabs = ({ children, ...props }: any) => {
    mockTabsProps(props);

    return mockReact.createElement(View, { testID: 'tabs' }, children);
  };
  Tabs.Screen = (props: any) => {
    mockTabScreenProps(props);
    return mockReact.createElement(View, { testID: `tab-${props.name}` });
  };

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

jest.mock('../../src/components/ui/TabBarMaterialBackground', () => {
  const mockReact = require('react');
  const { View } = require('react-native');
  return {
    TabBarMaterialBackground: () => mockReact.createElement(View, { testID: 'tab-bar-material-background' }),
  };
});

jest.mock('../../src/providers/ThemeProvider', () => ({
  useTheme: () => mockThemeContext,
}));

jest.mock('../../src/services/ChatGenerationService', () => ({
  hasActiveChatGenerationWork: () => mockHasActiveChatGenerationWork(),
}));

const TabLayout = require('../../app/(tabs)/_layout').default;

function getLatestScreenOptions() {
  return mockTabsProps.mock.calls[mockTabsProps.mock.calls.length - 1]?.[0]?.screenOptions;
}

describe('TabLayout', () => {
  beforeEach(() => {
    mockTabsProps.mockClear();
    mockTabScreenProps.mockClear();
    mockHasActiveChatGenerationWork.mockReturnValue(false);
    const { resolveTheme } = require('../../src/design-system/themes/resolver');
    const resolvedTheme = resolveTheme('default', 'light');
    mockThemeContext = {
      appearance: resolvedTheme.appearance,
      colors: resolvedTheme.colors,
      resolvedTheme,
    };
  });

  it('lets the native tab style own the standard-theme background', () => {
    render(<TabLayout />);

    const screenOptions = getLatestScreenOptions();

    expect(screenOptions.tabBarBackground).toBeUndefined();
    expect(screenOptions.tabBarStyle.backgroundColor).not.toBe('transparent');
  });

  it('installs a keyed glass tab background when switching to the glass island', () => {
    const { resolveTheme } = require('../../src/design-system/themes/resolver');
    const resolvedTheme = resolveTheme('glass', 'light');
    mockThemeContext = {
      appearance: resolvedTheme.appearance,
      colors: resolvedTheme.colors,
      resolvedTheme,
    };

    render(<TabLayout />);

    const screenOptions = getLatestScreenOptions();
    const tabBarBackground = screenOptions.tabBarBackground();

    expect(screenOptions.tabBarStyle.backgroundColor).toBe('transparent');
    expect(tabBarBackground.key).toBe('glass-light');
  });

  it('prevents every tab transition while chat work is active', () => {
    mockHasActiveChatGenerationWork.mockReturnValue(true);
    render(<TabLayout />);
    const preventDefault = jest.fn();

    for (const [{ listeners }] of mockTabScreenProps.mock.calls) {
      listeners.tabPress({ preventDefault });
    }

    expect(mockTabScreenProps).toHaveBeenCalledTimes(4);
    expect(preventDefault).toHaveBeenCalledTimes(4);
  });

  it('gives every tab a translated accessibility label and stable QA selector', () => {
    render(<TabLayout />);

    expect(mockTabScreenProps.mock.calls.map(([{ options }]) => ({
      title: options.title,
      accessibilityLabel: options.tabBarAccessibilityLabel,
      testID: options.tabBarButtonTestID,
    }))).toEqual([
      { title: 'tabs.home', accessibilityLabel: 'tabs.home', testID: 'bottom-tab-home' },
      { title: 'tabs.chat', accessibilityLabel: 'tabs.chat', testID: 'bottom-tab-chat' },
      { title: 'tabs.models', accessibilityLabel: 'tabs.models', testID: 'bottom-tab-models' },
      { title: 'tabs.settings', accessibilityLabel: 'tabs.settings', testID: 'bottom-tab-settings' },
    ]);
  });
});
