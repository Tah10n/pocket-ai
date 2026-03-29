import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SettingsScreen } from '../../src/ui/screens/SettingsScreen';

const mockBack = jest.fn();
const mockReplace = jest.fn();
const mockPush = jest.fn();
let mockCanGoBack = true;
let mockDeviceMetricsResult: {
  metrics: Record<string, any>;
  refresh: jest.Mock;
};

function createStorageMetrics() {
  return {
    totalBytes: 128_000_000_000,
    usedBytes: 64_000_000_000,
    freeBytes: 64_000_000_000,
    downloadedModelsBytes: 0,
    totalGB: 0,
    usedGB: 0,
    freeGB: 0,
    downloadedModelsGB: 0,
    downloadedModelsCount: 0,
    usedPercentage: 50,
  };
}

function createSystemRamMetrics() {
  return {
    totalBytes: 8_000_000_000,
    usedBytes: 5_000_000_000,
    availableBytes: 3_000_000_000,
    appUsedBytes: 2_000_000_000,
    totalGB: 0,
    usedGB: 0,
    freeGB: 0,
    appUsedGB: 0,
    usedPercentage: 62.5,
    source: 'system',
  };
}

function createProcessRamMetrics() {
  return {
    totalBytes: 8_000_000_000,
    usedBytes: null,
    availableBytes: null,
    appUsedBytes: 1_500_000_000,
    totalGB: 0,
    usedGB: null,
    freeGB: null,
    appUsedGB: 0,
    usedPercentage: null,
    source: 'process',
  };
}

function renderScreen() {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 0, left: 0, right: 0, bottom: 0 },
      }}
    >
      <SettingsScreen />
    </SafeAreaProvider>,
  );
}

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
  useDeviceMetrics: () => mockDeviceMetricsResult,
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
    mockDeviceMetricsResult = {
      metrics: {
        ram: createSystemRamMetrics(),
        storage: createStorageMetrics(),
      },
      refresh: jest.fn(),
    };
  });

  it('renders a header back button and navigates back when history exists', () => {
    const { getByTestId } = renderScreen();

    fireEvent.press(getByTestId('settings-back-button'));

    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('falls back to the home route when there is no back history', () => {
    mockCanGoBack = false;

    const { getByTestId } = renderScreen();

    fireEvent.press(getByTestId('settings-back-button'));

    expect(mockBack).not.toHaveBeenCalled();
    expect(mockReplace).toHaveBeenCalledWith('/');
  });

  it('renders the Android system RAM variant with availability and app memory breakdown', () => {
    const { getByText, queryByText } = renderScreen();

    expect(getByText('settings.memoryDescription')).toBeTruthy();
    expect(getByText('63%')).toBeTruthy();
    expect(getByText('settings.available')).toBeTruthy();
    expect(getByText('settings.appMemory')).toBeTruthy();
    expect(getByText('settings.memoryAvailable')).toBeTruthy();
    expect(queryByText('settings.deviceTotal')).toBeNull();
  });

  it('renders the process-only RAM fallback without fabricated free or busy system metrics', () => {
    mockDeviceMetricsResult = {
      metrics: {
        ram: createProcessRamMetrics(),
        storage: createStorageMetrics(),
      },
      refresh: jest.fn(),
    };

    const { getByText, queryByText } = renderScreen();

    expect(getByText('settings.memoryDescriptionFallback')).toBeTruthy();
    expect(getByText('settings.memoryAppUsage')).toBeTruthy();
    expect(getByText('settings.memoryDeviceTotal')).toBeTruthy();
    expect(getByText('settings.deviceTotal')).toBeTruthy();
    expect(queryByText('settings.memoryBusy')).toBeNull();
    expect(queryByText('settings.available')).toBeNull();
  });
});
