import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { Alert } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StorageManagerScreen } from '../../src/ui/screens/StorageManagerScreen';
import {
  clearActiveCache,
  clearChatHistory,
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
  getAppStorageMetrics: jest.fn(() => Promise.resolve({
    downloadedModels: [],
    modelsBytes: 0,
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
  });

  it('navigates back when possible', async () => {
    const { getByTestId } = await renderScreen();

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
