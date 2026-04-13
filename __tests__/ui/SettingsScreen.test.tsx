import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SettingsScreen } from '../../src/ui/screens/SettingsScreen';
import { getAppStorageMetrics } from '../../src/services/StorageManagerService';
import { screenLayoutMetrics } from '../../src/utils/themeTokens';

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
    availableBudgetBytes: 2_200_000_000,
    freeBytes: 2_500_000_000,
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
    availableBudgetBytes: null,
    freeBytes: null,
    appUsedBytes: 1_500_000_000,
    totalGB: 0,
    usedGB: null,
    freeGB: null,
    appUsedGB: 0,
    usedPercentage: null,
    source: 'process',
  };
}

async function renderScreen() {
  const result = render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 0, left: 0, right: 0, bottom: 0 },
      }}
    >
      <SettingsScreen />
    </SafeAreaProvider>,
  );

  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  return result;
}

function flattenStyle(style: any) {
  if (Array.isArray(style)) {
    return style.reduce((result, entry) => ({ ...result, ...flattenStyle(entry) }), {});
  }

  return style ?? {};
}

jest.mock('@react-navigation/bottom-tabs', () => ({
  useBottomTabBarHeight: () => 0,
}));

jest.mock('@react-navigation/native', () => {
  const mockReact = require('react');

  return {
    useFocusEffect: (effect: any) => mockReact.useEffect(() => effect(), [effect]),
    useIsFocused: () => true,
  };
});

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
    ensurePersistedCapabilitySnapshot: jest.fn().mockReturnValue(null),
    unload: jest.fn(),
  },
}));

jest.mock('../../src/services/StorageManagerService', () => ({
  getAppStorageMetrics: jest.fn().mockResolvedValue({ appFilesBytes: 12_000_000_000 }),
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
    (getAppStorageMetrics as jest.Mock).mockResolvedValue({ appFilesBytes: 12_000_000_000 });
    mockDeviceMetricsResult = {
      metrics: {
        ram: createSystemRamMetrics(),
        storage: createStorageMetrics(),
      },
      refresh: jest.fn(),
    };
  });

  it('uses the root-tab chrome without exposing a back button even when history exists', async () => {
    const { queryByTestId } = await renderScreen();

    expect(queryByTestId('settings-back-button')).toBeNull();
    expect(mockBack).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('keeps the root-tab chrome when there is no back history', async () => {
    mockCanGoBack = false;

    const { queryByTestId } = await renderScreen();

    expect(queryByTestId('settings-back-button')).toBeNull();
    expect(mockBack).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('renders the Android system RAM variant with conservative available memory and app memory breakdown', async () => {
    const { getAllByText, getByText, getByTestId, queryByText } = await renderScreen();

    expect(getByText('settings.memoryDescription')).toBeTruthy();
    expect(getByText('63%')).toBeTruthy();
    expect(getByText('settings.appMemory')).toBeTruthy();
    expect(getByText('settings.appFilesUsage')).toBeTruthy();
    expect(getAllByText('settings.free')).toHaveLength(1);
    expect(getByText('settings.available')).toBeTruthy();
    expect(getByText('2.2 GB')).toBeTruthy();
    expect(getByTestId('settings-memory-track')).toBeTruthy();
    expect(getByTestId('settings-memory-used-fill')).toBeTruthy();
    expect(getByTestId('settings-memory-app-fill')).toBeTruthy();
    expect(getByTestId('settings-storage-track')).toBeTruthy();
    expect(getByTestId('settings-storage-used-fill')).toBeTruthy();
    expect(getByTestId('settings-storage-app-fill')).toBeTruthy();
    expect(queryByText('settings.memoryAvailable')).toBeNull();
    expect(queryByText('settings.memoryBusy')).toBeNull();
    expect(queryByText('settings.storageOccupied')).toBeNull();
    expect(queryByText('settings.used')).toBeNull();
    expect(queryByText('settings.total')).toBeNull();
    expect(queryByText('settings.deviceTotal')).toBeNull();
    expect(queryByText(/·/)).toBeNull();
  });

  it('falls back to raw available memory when the conservative budget is unavailable', async () => {
    mockDeviceMetricsResult = {
      metrics: {
        ram: {
          ...createSystemRamMetrics(),
          availableBudgetBytes: null,
          freeBytes: null,
        },
        storage: createStorageMetrics(),
      },
      refresh: jest.fn(),
    };

    const { getByText } = await renderScreen();

    expect(getByText('settings.available')).toBeTruthy();
    expect(getByText('3.0 GB')).toBeTruthy();
  });

  it('renders the process-only RAM fallback without fabricated free or busy system metrics', async () => {
    mockDeviceMetricsResult = {
      metrics: {
        ram: createProcessRamMetrics(),
        storage: createStorageMetrics(),
      },
      refresh: jest.fn(),
    };

    const { getByText, getByTestId, queryByText, queryByTestId } = await renderScreen();

    expect(getByText('settings.memoryDescriptionFallback')).toBeTruthy();
    expect(getByText('settings.memoryAppUsage')).toBeTruthy();
    expect(getByText('settings.appMemory')).toBeTruthy();
    expect(getByText('settings.deviceTotal')).toBeTruthy();
    expect(getByTestId('settings-memory-app-fill')).toBeTruthy();
    expect(queryByTestId('settings-memory-track')).toBeNull();
    expect(queryByTestId('settings-memory-used-fill')).toBeNull();
    expect(queryByText('settings.memoryDeviceTotal')).toBeNull();
    expect(queryByText('settings.memoryBusy')).toBeNull();
    expect(queryByText('settings.available')).toBeNull();
  });

  it('renders the storage app-footprint bar instead of the old stat chips', async () => {
    const { findByText, getAllByText, getByTestId, queryByText } = await renderScreen();

    expect(await findByText('settings.appFilesUsage')).toBeTruthy();
    expect(await findByText('12 GB')).toBeTruthy();
    expect(getAllByText('settings.free')).toHaveLength(1);
    expect(getByTestId('settings-storage-track')).toBeTruthy();
    expect(getByTestId('settings-storage-used-fill')).toBeTruthy();
    expect(getByTestId('settings-storage-app-fill')).toBeTruthy();
    expect(queryByText('settings.storageOccupied')).toBeNull();
    expect(queryByText('settings.used')).toBeNull();
    expect(queryByText('settings.total')).toBeNull();
  });

  it('uses the shared content inset instead of adding extra tab bar spacing', async () => {
    const { getByTestId } = await renderScreen();

    expect(flattenStyle(getByTestId('settings-screen-content').props.style).paddingBottom)
      .toBe(screenLayoutMetrics.contentBottomInset);
  });
});
