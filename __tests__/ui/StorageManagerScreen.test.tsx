import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StorageManagerScreen } from '../../src/ui/screens/StorageManagerScreen';
import {
  clearActiveCache,
  clearChatHistory,
  cleanupQuarantinedModelFiles,
  getAppStorageMetrics,
  resetAppSettings,
} from '../../src/services/StorageManagerService';

const mockBack = jest.fn();
const mockReplace = jest.fn();
let mockCanGoBack = true;

jest.mock('expo-router', () => ({
  useRouter: () => ({
    back: mockBack,
    replace: mockReplace,
    canGoBack: () => mockCanGoBack,
  }),
}));

jest.mock('../../src/services/HardwareListenerService', () => ({
  hardwareListenerService: {
    getCurrentStatus: jest.fn(() => ({ isLowMemory: false, isConnected: true })),
    subscribe: jest.fn(() => jest.fn()),
  },
}));

jest.mock('../../src/services/StorageManagerService', () => ({
  clearActiveCache: jest.fn(() => Promise.resolve(0)),
  clearChatHistory: jest.fn(() => Promise.resolve(0)),
  cleanupQuarantinedModelFiles: jest.fn(() => Promise.resolve(0)),
  getAppStorageMetrics: jest.fn(() => Promise.resolve({
    downloadedModels: [],
    modelsBytes: 0,
    quarantinedModelFiles: {
      fileNames: [],
      count: 0,
      bytes: 0,
    },
    cacheBytes: 0,
    chatHistoryBytes: 0,
    settingsBytes: 0,
    appFilesBytes: 0,
    activeModelEstimateBytes: 0,
    activeModelId: null,
  })),
  offloadModel: jest.fn(() => Promise.resolve(undefined)),
  resetAppSettings: jest.fn(() => Promise.resolve({ language: 'en' })),
}));

jest.mock('../../src/components/ui/MaterialSymbols', () => {
  const mockReact = require('react');
  const { Text } = require('react-native');

  return {
    MaterialSymbols: ({ name }: any) => mockReact.createElement(Text, null, name),
  };
});

const mockClearActiveCache = clearActiveCache as jest.MockedFunction<typeof clearActiveCache>;
const mockClearChatHistory = clearChatHistory as jest.MockedFunction<typeof clearChatHistory>;
const mockCleanupQuarantinedModelFiles = cleanupQuarantinedModelFiles as jest.MockedFunction<typeof cleanupQuarantinedModelFiles>;
const mockGetAppStorageMetrics = getAppStorageMetrics as jest.MockedFunction<typeof getAppStorageMetrics>;
const mockResetAppSettings = resetAppSettings as jest.MockedFunction<typeof resetAppSettings>;

async function renderScreen() {
  const result = render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 0, left: 0, right: 0, bottom: 0 },
      }}
    >
      <StorageManagerScreen />
    </SafeAreaProvider>,
  );

  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  return result;
}

describe('StorageManagerScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCanGoBack = true;
    mockGetAppStorageMetrics.mockResolvedValue({
      downloadedModels: [],
      modelsBytes: 0,
      quarantinedModelFiles: {
        fileNames: [],
        count: 0,
        bytes: 0,
      },
      cacheBytes: 0,
      chatHistoryBytes: 0,
      settingsBytes: 0,
      appFilesBytes: 0,
      activeModelEstimateBytes: 0,
      activeModelId: null,
    });
    mockCleanupQuarantinedModelFiles.mockResolvedValue(0);
  });

  it('navigates back when possible', async () => {
    const { getByTestId } = await renderScreen();

    expect(mockGetAppStorageMetrics).toHaveBeenCalledWith();

    fireEvent.press(getByTestId('storage-manager-back-button'));
    fireEvent.press(getByTestId('storage-manager-back-button'));

    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('replaces the route when there is no back stack', async () => {
    mockCanGoBack = false;
    const { getByTestId } = await renderScreen();

    fireEvent.press(getByTestId('storage-manager-back-button'));

    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/models');
  });

  it('checks the current back-stack state when the user presses back', async () => {
    const { getByTestId } = await renderScreen();
    mockCanGoBack = false;

    fireEvent.press(getByTestId('storage-manager-back-button'));

    expect(mockBack).not.toHaveBeenCalled();
    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/models');
  });

  it('shows a loading state instead of false zero values while metrics are pending', async () => {
    let resolveMetrics!: (metrics: Awaited<ReturnType<typeof getAppStorageMetrics>>) => void;
    mockGetAppStorageMetrics.mockReturnValue(new Promise((resolve) => {
      resolveMetrics = resolve;
    }));

    const result = render(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 0, left: 0, right: 0, bottom: 0 },
        }}
      >
        <StorageManagerScreen />
      </SafeAreaProvider>,
    );

    expect(result.getByTestId('storage-manager-metrics-status')).toHaveTextContent('storageManager.metricsLoading');
    expect(result.queryByText('storageManager.emptyModelsTitle')).toBeNull();
    expect(result.queryByText('0 MB')).toBeNull();
    expect(result.getByTestId('storage-manager-clear-cache')).toBeDisabled();
    expect(result.getByTestId('storage-manager-clear-chat')).toBeDisabled();

    await act(async () => {
      resolveMetrics({
        downloadedModels: [],
        modelsBytes: 0,
        quarantinedModelFiles: { fileNames: [], count: 0, bytes: 0 },
        cacheBytes: 12_000_000,
        chatHistoryBytes: 4_000_000,
        settingsBytes: 1024,
        appFilesBytes: 16_001_024,
        activeModelEstimateBytes: 0,
        activeModelId: null,
      });
    });

    await waitFor(() => {
      expect(result.queryByTestId('storage-manager-metrics-status')).toBeNull();
      expect(result.getByText('storageManager.emptyModelsTitle')).toBeTruthy();
      expect(result.getByText('12 MB')).toBeTruthy();
      expect(result.getByText('4.0 MB')).toBeTruthy();
    });
  });

  it('offers a retry when metrics fail instead of rendering empty storage', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockGetAppStorageMetrics.mockRejectedValueOnce(new Error('storage probe failed'));
    try {
      const result = await renderScreen();

      expect(result.getByTestId('storage-manager-metrics-status')).toHaveTextContent('storageManager.metricsLoadError');
      expect(result.queryByText('storageManager.emptyModelsTitle')).toBeNull();

      fireEvent.press(result.getByTestId('storage-manager-retry-metrics'));

      await waitFor(() => {
        expect(mockGetAppStorageMetrics).toHaveBeenCalledTimes(2);
        expect(result.getByText('storageManager.emptyModelsTitle')).toBeTruthy();
      });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('confirms and clears the active cache', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const { getByTestId } = await renderScreen();

    fireEvent.press(getByTestId('storage-manager-clear-cache'));

    expect(alertSpy).toHaveBeenCalledWith(
      'storageManager.clearCacheTitle',
      'storageManager.clearCacheMessage',
      expect.any(Array),
    );

    const actions = alertSpy.mock.calls[0]?.[2] as any[];
    await act(async () => {
      actions[1].onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockClearActiveCache).toHaveBeenCalledTimes(1);
    expect(mockGetAppStorageMetrics).toHaveBeenCalled();

    alertSpy.mockRestore();
  });

  it('confirms and clears chat history', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const { getByTestId } = await renderScreen();

    fireEvent.press(getByTestId('storage-manager-clear-chat'));

    const actions = alertSpy.mock.calls[0]?.[2] as any[];
    await act(async () => {
      actions[1].onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockClearChatHistory).toHaveBeenCalledTimes(1);
    alertSpy.mockRestore();
  });

  it('confirms and cleans up quarantined model files', async () => {
    mockGetAppStorageMetrics.mockResolvedValue({
      downloadedModels: [],
      modelsBytes: 0,
      quarantinedModelFiles: {
        fileNames: ['orphan.gguf'],
        count: 1,
        bytes: 2048,
      },
      cacheBytes: 0,
      chatHistoryBytes: 0,
      settingsBytes: 0,
      appFilesBytes: 2048,
      activeModelEstimateBytes: 0,
      activeModelId: null,
    });
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const { getByTestId } = await renderScreen();

    fireEvent.press(getByTestId('storage-manager-cleanup-quarantine'));

    expect(alertSpy).toHaveBeenCalledWith(
      'storageManager.clearQuarantineTitle',
      'storageManager.clearQuarantineMessage',
      expect.any(Array),
    );

    const actions = alertSpy.mock.calls[0]?.[2] as any[];
    await act(async () => {
      actions[1].onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockCleanupQuarantinedModelFiles).toHaveBeenCalledTimes(1);
    expect(mockGetAppStorageMetrics).toHaveBeenCalled();

    alertSpy.mockRestore();
  });

  it('confirms and resets settings', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const { getByTestId } = await renderScreen();

    fireEvent.press(getByTestId('storage-manager-reset-settings'));

    const actions = alertSpy.mock.calls[0]?.[2] as any[];
    await act(async () => {
      actions[1].onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockResetAppSettings).toHaveBeenCalledTimes(1);
    alertSpy.mockRestore();
  });
});
