import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

const mockStackProps = jest.fn();
const mockBootstrapAppCritical = jest.fn();
const mockBootstrapAppBackground = jest.fn();
const mockGetPrivateStorageHealthSnapshot = jest.fn();
const mockGetStorageFallbackReport = jest.fn();
const mockResetPrivateAppStorageAndRuntimeStateAfterConfirmation = jest.fn();
const mockRetryPrivateStorageInitialization = jest.fn();
const mockNotificationInitialize = jest.fn();

const blockedHealth = {
  status: 'blocked' as const,
  reason: 'encrypted_open_failed' as const,
  retryable: true,
  requiresExplicitReset: true,
  messageKey: 'storageRecovery.reason.encryptedOpenFailed',
  lastUpdatedAt: 1,
};

const readyHealth = {
  status: 'ready' as const,
  retryable: false,
  requiresExplicitReset: false,
  lastUpdatedAt: 2,
};

jest.mock('@react-navigation/native', () => {
  const mockReact = require('react');
  const { View } = require('react-native');
  return {
    ThemeProvider: ({ children }: any) => mockReact.createElement(View, { testID: 'navigation-theme' }, children),
  };
});

jest.mock('expo-router', () => {
  const mockReact = require('react');
  const { View } = require('react-native');
  const Stack = ({ children, ...props }: any) => {
    mockStackProps(props);
    return mockReact.createElement(View, { testID: 'root-stack' }, children);
  };
  Stack.Screen = ({ name }: any) => mockReact.createElement(View, { testID: `stack-${name}` });
  return { Stack };
});

jest.mock('expo-status-bar', () => {
  const mockReact = require('react');
  const { View } = require('react-native');
  return {
    StatusBar: ({ style }: any) => mockReact.createElement(View, { testID: `status-bar-${style}` }),
  };
});

jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(async () => undefined),
  hideAsync: jest.fn(async () => undefined),
}));

jest.mock('expo-system-ui', () => ({
  setBackgroundColorAsync: jest.fn(async () => undefined),
}));

jest.mock('expo-keep-awake', () => ({
  activateKeepAwake: jest.fn(async () => undefined),
  deactivateKeepAwake: jest.fn(async () => undefined),
}));

jest.mock('react-native-reanimated', () => ({}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

jest.mock('../../src/providers/ThemeProvider', () => {
  const mockReact = require('react');
  const { View } = require('react-native');
  return {
    ThemeProvider: ({ children }: any) => mockReact.createElement(View, { testID: 'custom-theme' }, children),
    useTheme: () => ({
      colors: {
        background: '#101010',
        statusBarStyle: 'light',
      },
      navigationTheme: {},
    }),
  };
});

jest.mock('../../src/hooks/useDeviceMetrics', () => ({
  useMotionPreferences: () => ({ motionPreset: 'none' }),
}));

jest.mock('../../src/hooks/usePerformanceNavigationTrace', () => ({
  usePerformanceNavigationTrace: jest.fn(),
}));

jest.mock('../../src/services/HardwareListenerService', () => ({
  hardwareListenerService: {
    start: jest.fn(),
    stop: jest.fn(),
  },
}));

jest.mock('../../src/services/AppBootstrap', () => ({
  bootstrapAppCritical: (...args: unknown[]) => mockBootstrapAppCritical(...args),
  bootstrapAppBackground: (...args: unknown[]) => mockBootstrapAppBackground(...args),
}));

jest.mock('../../src/services/PerformanceMonitor', () => ({
  performanceMonitor: {
    mark: jest.fn(),
    startSpan: jest.fn(() => ({ end: jest.fn() })),
  },
}));

jest.mock('../../src/services/storage', () => ({
  getPrivateStorageHealthSnapshot: (...args: unknown[]) => mockGetPrivateStorageHealthSnapshot(...args),
  getStorageFallbackReport: (...args: unknown[]) => mockGetStorageFallbackReport(...args),
  retryPrivateStorageInitialization: (...args: unknown[]) => mockRetryPrivateStorageInitialization(...args),
}));

jest.mock('../../src/services/PrivateStorageRecovery', () => ({
  resetPrivateAppStorageAndRuntimeStateAfterConfirmation: (...args: unknown[]) => (
    mockResetPrivateAppStorageAndRuntimeStateAfterConfirmation(...args)
  ),
}));

jest.mock('../../src/services/NotificationService', () => ({
  notificationService: {
    initialize: (...args: unknown[]) => mockNotificationInitialize(...args),
  },
}));

jest.mock('../../src/ui/screens/StorageRecoveryScreen', () => {
  const mockReact = require('react');
  const { Pressable, Text, View } = require('react-native');
  return {
    StorageRecoveryScreen: ({ busy, health, onReset, onRetry }: any) => mockReact.createElement(
      View,
      { testID: 'storage-recovery-screen' },
      mockReact.createElement(Text, { testID: 'storage-recovery-reason' }, health?.reason ?? 'no-reason'),
      mockReact.createElement(Pressable, { testID: 'storage-recovery-retry', onPress: onRetry }, mockReact.createElement(Text, null, busy === 'retry' ? 'retrying' : 'retry')),
      mockReact.createElement(Pressable, { testID: 'storage-recovery-reset', onPress: onReset }, mockReact.createElement(Text, null, busy === 'reset' ? 'resetting' : 'reset')),
    ),
  };
});

jest.mock('../../src/i18n', () => ({}));
jest.mock('../../global.css', () => ({}));

const RootLayout = require('../../app/_layout').default;
const { useBootstrapStore } = require('../../src/store/bootstrapStore');

function resetBootstrapStore() {
  useBootstrapStore.setState({
    criticalOutcome: 'success',
    criticalStorageHealth: null,
    backgroundState: 'idle',
    backgroundError: null,
  });
}

describe('RootLayout storage recovery gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetBootstrapStore();
    mockBootstrapAppBackground.mockResolvedValue({ outcome: 'success' });
    mockGetPrivateStorageHealthSnapshot.mockReturnValue(blockedHealth);
    mockGetStorageFallbackReport.mockReturnValue(null);
    mockRetryPrivateStorageInitialization.mockResolvedValue(readyHealth);
    mockResetPrivateAppStorageAndRuntimeStateAfterConfirmation.mockResolvedValue(readyHealth);
  });

  it('renders storage recovery and skips background bootstrap when critical storage is blocked', async () => {
    mockBootstrapAppCritical.mockResolvedValueOnce({ outcome: 'storage_blocked', storageHealth: blockedHealth });

    const { findByTestId } = render(<RootLayout />);

    expect(await findByTestId('storage-recovery-screen')).toBeTruthy();
    expect(mockBootstrapAppBackground).not.toHaveBeenCalled();
    expect(mockNotificationInitialize).not.toHaveBeenCalled();
    expect(useBootstrapStore.getState().criticalOutcome).toBe('storage_blocked');
    expect(useBootstrapStore.getState().criticalStorageHealth).toEqual(expect.objectContaining({
      reason: 'encrypted_open_failed',
    }));
  });

  it('retries private storage and starts background bootstrap after critical bootstrap succeeds', async () => {
    mockBootstrapAppCritical
      .mockResolvedValueOnce({ outcome: 'storage_blocked', storageHealth: blockedHealth })
      .mockResolvedValueOnce({ outcome: 'success' });

    const { findByTestId, queryByTestId } = render(<RootLayout />);
    const retryButton = await findByTestId('storage-recovery-retry');

    await act(async () => {
      fireEvent.press(retryButton);
      await Promise.resolve();
    });

    await waitFor(() => expect(mockRetryPrivateStorageInitialization).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockBootstrapAppCritical).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mockBootstrapAppBackground).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(queryByTestId('root-stack')).toBeTruthy());
    expect(queryByTestId('storage-recovery-screen')).toBeNull();
  });

  it('shows recovery when background bootstrap reports private storage is blocked', async () => {
    mockBootstrapAppCritical.mockResolvedValueOnce({ outcome: 'success' });
    mockBootstrapAppBackground.mockResolvedValueOnce({ outcome: 'storage_blocked', storageHealth: blockedHealth });

    const { findByTestId } = render(<RootLayout />);

    expect(await findByTestId('storage-recovery-screen')).toBeTruthy();
    await waitFor(() => expect(mockBootstrapAppBackground).toHaveBeenCalledTimes(1));
    expect(useBootstrapStore.getState()).toEqual(expect.objectContaining({
      criticalOutcome: 'storage_blocked',
      backgroundState: 'blocked',
      backgroundError: null,
    }));
    expect(useBootstrapStore.getState().criticalStorageHealth).toEqual(expect.objectContaining({
      reason: 'encrypted_open_failed',
    }));
  });

  it('runs explicit reset recovery through the root gate before remounting the app shell', async () => {
    mockBootstrapAppCritical
      .mockResolvedValueOnce({ outcome: 'storage_blocked', storageHealth: blockedHealth })
      .mockResolvedValueOnce({ outcome: 'success' });

    const { findByTestId, queryByTestId } = render(<RootLayout />);
    const resetButton = await findByTestId('storage-recovery-reset');

    await act(async () => {
      fireEvent.press(resetButton);
      await Promise.resolve();
    });

    await waitFor(() => expect(mockResetPrivateAppStorageAndRuntimeStateAfterConfirmation).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockBootstrapAppCritical).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mockBootstrapAppBackground).toHaveBeenCalledTimes(1));
    expect(queryByTestId('storage-recovery-screen')).toBeNull();
  });
});
