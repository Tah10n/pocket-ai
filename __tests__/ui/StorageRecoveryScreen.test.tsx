import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { Alert } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StorageRecoveryScreen } from '../../src/ui/screens/StorageRecoveryScreen';
import type { PrivateStorageHealthSnapshot } from '../../src/services/storage';

const blockedHealth: PrivateStorageHealthSnapshot = {
  status: 'blocked',
  reason: 'encrypted_open_failed',
  retryable: true,
  requiresExplicitReset: true,
  lastUpdatedAt: 1,
};

function renderScreen(overrides: Partial<React.ComponentProps<typeof StorageRecoveryScreen>> = {}) {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 0, left: 0, right: 0, bottom: 0 },
      }}
    >
      <StorageRecoveryScreen
        health={blockedHealth}
        onRetry={jest.fn()}
        onReset={jest.fn()}
        {...overrides}
      />
    </SafeAreaProvider>,
  );
}

describe('StorageRecoveryScreen', () => {
  let alertSpy: jest.SpiedFunction<typeof Alert.alert>;

  beforeEach(() => {
    jest.clearAllMocks();
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  });

  afterEach(() => {
    alertSpy.mockRestore();
  });

  it('renders localized recovery copy and retries without resetting data', () => {
    const onRetry = jest.fn();
    const onReset = jest.fn();
    const { getByText, getByTestId } = renderScreen({ onRetry, onReset });

    expect(getByText('storageRecovery.title')).toBeTruthy();
    expect(getByText('storageRecovery.description')).toBeTruthy();
    expect(getByText('storageRecovery.existingDataPreserved')).toBeTruthy();
    expect(getByText('storageRecovery.resetScope')).toBeTruthy();
    expect(getByText('storageRecovery.reason.encryptedOpenFailed')).toBeTruthy();

    fireEvent.press(getByTestId('storage-recovery-retry-button'));

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onReset).not.toHaveBeenCalled();
  });

  it('requires explicit confirmation before running destructive reset', () => {
    const onReset = jest.fn();
    const { getByTestId } = renderScreen({ onReset });

    fireEvent.press(getByTestId('storage-recovery-reset-button'));

    expect(onReset).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledWith(
      'storageRecovery.resetConfirmTitle',
      'storageRecovery.resetConfirmMessage',
      expect.any(Array),
    );

    const actions = alertSpy.mock.calls[0]?.[2] as any[];
    expect(actions[0]).toEqual(expect.objectContaining({
      text: 'storageRecovery.resetConfirmCancel',
      style: 'cancel',
    }));
    expect(actions[1]).toEqual(expect.objectContaining({
      text: 'storageRecovery.resetConfirmAction',
      style: 'destructive',
    }));
  });

  it('runs the destructive reset callback only from the confirmation action', async () => {
    const onReset = jest.fn();
    const { getByTestId } = renderScreen({ onReset });

    fireEvent.press(getByTestId('storage-recovery-reset-button'));
    const actions = alertSpy.mock.calls[0]?.[2] as any[];

    await act(async () => {
      actions[1].onPress();
      await Promise.resolve();
    });

    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('disables retry and reset when the screen is disabled', () => {
    const onRetry = jest.fn();
    const onReset = jest.fn();
    const { getByTestId } = renderScreen({ disabled: true, onRetry, onReset });

    fireEvent.press(getByTestId('storage-recovery-retry-button'));
    fireEvent.press(getByTestId('storage-recovery-reset-button'));

    expect(onRetry).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
    expect(onReset).not.toHaveBeenCalled();
  });

  it('shows busy labels and prevents concurrent recovery actions', () => {
    const onRetry = jest.fn();
    const onReset = jest.fn();
    const { getByText, getByTestId } = renderScreen({ busy: true, onRetry, onReset });

    expect(getByText('storageRecovery.retryBusy')).toBeTruthy();
    expect(getByText('storageRecovery.resetBusy')).toBeTruthy();

    fireEvent.press(getByTestId('storage-recovery-retry-button'));
    fireEvent.press(getByTestId('storage-recovery-reset-button'));

    expect(onRetry).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
    expect(onReset).not.toHaveBeenCalled();
  });
});
