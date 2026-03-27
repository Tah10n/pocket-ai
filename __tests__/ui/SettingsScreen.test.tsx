import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SettingsScreen } from '../../src/ui/screens/SettingsScreen';

const mockBack = jest.fn();
const mockReplace = jest.fn();
const mockPush = jest.fn();
let mockCanGoBack = true;

jest.mock('@react-navigation/bottom-tabs', () => ({
  useBottomTabBarHeight: () => 0,
}));

jest.mock('@react-navigation/native', () => ({
  useFocusEffect: () => undefined,
  useIsFocused: () => true,
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({
    back: mockBack,
    replace: mockReplace,
    push: mockPush,
    canGoBack: () => mockCanGoBack,
  }),
}));

jest.mock('../../src/providers/ThemeProvider', () => ({
  useTheme: () => ({
    mode: 'system',
    resolvedMode: 'light',
    setTheme: jest.fn(),
    colors: {
      background: '#f6f6f8',
      surface: '#ffffff',
      text: '#0f172a',
      textSecondary: '#64748b',
      primary: '#3211d4',
      border: '#e2e8f0',
      error: '#ef4444',
      warning: '#f59e0b',
      success: '#10b981',
      inputBackground: '#ffffff',
    },
  }),
}));

jest.mock('../../src/hooks/useDeviceMetrics', () => ({
  useDeviceMetrics: () => ({
    metrics: {
      ram: {
        totalGB: 8,
        usedGB: 4,
        freeGB: 4,
        usedPercentage: 50,
      },
      storage: {
        totalGB: 128,
        usedGB: 64,
        freeGB: 64,
        downloadedModelsGB: 0,
        downloadedModelsCount: 0,
        usedPercentage: 50,
      },
    },
    refresh: jest.fn(),
  }),
}));

jest.mock('../../src/hooks/useLLMEngine', () => ({
  useLLMEngine: () => ({
    state: { activeModelId: null },
    isReady: false,
  }),
}));

jest.mock('../../src/services/LLMEngineService', () => ({
  llmEngineService: {
    unload: jest.fn(),
  },
}));

jest.mock('../../src/services/StorageManagerService', () => ({
  getAppStorageMetrics: jest.fn().mockResolvedValue({ appFilesBytes: 0 }),
}));

jest.mock('../../src/services/SettingsStore', () => ({
  getSettings: () => ({
    language: 'en',
  }),
  subscribeSettings: () => jest.fn(),
  updateSettings: jest.fn(),
}));

jest.mock('../../src/components/ui/MaterialSymbols', () => {
  const mockReact = require('react');
  const { Text } = require('react-native');

  return {
    MaterialSymbols: ({ name }: any) => mockReact.createElement(Text, null, name),
  };
});

describe('SettingsScreen', () => {
  beforeEach(() => {
    mockBack.mockReset();
    mockReplace.mockReset();
    mockPush.mockReset();
    mockCanGoBack = true;
  });

  it('renders a header back button and navigates back when history exists', () => {
    const { getByTestId } = render(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 0, left: 0, right: 0, bottom: 0 },
        }}
      >
        <SettingsScreen />
      </SafeAreaProvider>,
    );

    fireEvent.press(getByTestId('settings-back-button'));

    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('falls back to the home route when there is no back history', () => {
    mockCanGoBack = false;

    const { getByTestId } = render(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 0, left: 0, right: 0, bottom: 0 },
        }}
      >
        <SettingsScreen />
      </SafeAreaProvider>,
    );

    fireEvent.press(getByTestId('settings-back-button'));

    expect(mockBack).not.toHaveBeenCalled();
    expect(mockReplace).toHaveBeenCalledWith('/');
  });
});
