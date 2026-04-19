import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Alert, Share } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as Sharing from 'expo-sharing';

jest.mock('@/services/AppError', () => ({
  toAppError: () => ({
    code: 'E_TEST',
    message: 'Something went wrong',
    details: {
      reason: 'unit-test',
      nested: { ok: true },
    },
  }),
}));

jest.mock('react-native-device-info', () => ({
  getTotalMemory: jest.fn().mockResolvedValue(8 * 1024 * 1024 * 1024),
  supportedAbis: jest.fn().mockResolvedValue(['arm64-v8a']),
  isEmulator: jest.fn().mockResolvedValue(false),
  getModel: jest.fn(() => 'Pixel 9'),
  getBuildNumber: jest.fn(() => '123'),
  getVersion: jest.fn(() => '1.2.3'),
}));

import { ErrorReportSheet } from '@/components/ui/ErrorReportSheet';

function parseLastClipboardJson(): any {
  const calls = (Clipboard.setStringAsync as jest.Mock).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const json = calls[calls.length - 1][0];
  expect(typeof json).toBe('string');
  return JSON.parse(json);
}

describe('ErrorReportSheet', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    jest.clearAllMocks();

    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as any);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('hides optional include toggles when context is missing', async () => {
    const { queryByTestId } = render(
      <ErrorReportSheet
        visible
        scope="test"
        error={new Error('boom')}
        onClose={jest.fn()}
      />,
    );

    // Settle the device info effect to avoid act warnings.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(queryByTestId('include-model-on')).toBeNull();
    expect(queryByTestId('include-engine-on')).toBeNull();
    expect(queryByTestId('include-options-on')).toBeNull();
    // diagnostics toggle is hidden when there are no details; our mocked toAppError includes details,
    // so it should be shown.
    expect(queryByTestId('include-diagnostics-on')).not.toBeNull();
  });

  it('builds payload based on toggles and additional info; copy success/failure alerts', async () => {
    const error = new Error('boom');
    error.stack = 'STACKTRACE';

    const { getByText, getByTestId, getByPlaceholderText } = render(
      <ErrorReportSheet
        visible
        scope="model-load"
        error={error}
        context={{
          model: { id: 'author/model-q4', sizeBytes: 123n },
          engine: { backendMode: 'gpu', devices: ['GPU0'] },
          options: { threads: 4 },
          extra: { note: 'extra' },
        } as any}
        onClose={jest.fn()}
      />,
    );

    // Wait for device info effect to settle.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.changeText(
      getByPlaceholderText('models.errorReport.additionalInfoPlaceholder'),
      '  hello  ',
    );

    await act(async () => {
      fireEvent.press(getByText('models.errorReport.copy'));
      await Promise.resolve();
    });

    const payloadA = parseLastClipboardJson();
    expect(payloadA.scope).toBe('model-load');
    expect(payloadA.additionalInfo).toBe('hello');
    expect(payloadA.model).toEqual({ id: 'author/model-q4', sizeBytes: '123' });
    expect(payloadA.engine).toEqual({ backendMode: 'gpu', devices: ['GPU0'] });
    expect(payloadA.options).toEqual({ threads: 4 });
    expect(payloadA.extra).toEqual({ note: 'extra' });
    expect(payloadA.diagnostics).toEqual(expect.any(Object));
    expect(payloadA.device).toEqual(
      expect.objectContaining({
        deviceModel: 'Pixel 9',
        cpuArch: ['arm64-v8a'],
      }),
    );
    expect(payloadA.error.stack).toBe('STACKTRACE');

    // Toggle off model and stack trace.
    fireEvent.press(getByTestId('include-model-off'));
    fireEvent.press(getByTestId('include-stack-off'));

    await act(async () => {
      fireEvent.press(getByText('models.errorReport.copy'));
      await Promise.resolve();
    });

    const payloadB = parseLastClipboardJson();
    expect(payloadB.model).toBeUndefined();
    expect(payloadB.engine).toBeDefined();
    expect(payloadB.error.stack).toBeUndefined();

    // Copy failure shows alert.
    (Clipboard.setStringAsync as jest.Mock).mockRejectedValueOnce(new Error('copy failed'));
    await act(async () => {
      fireEvent.press(getByText('models.errorReport.copy'));
      await Promise.resolve();
    });

    expect(Alert.alert).toHaveBeenCalledWith(
      'models.errorReport.failedTitle',
      'models.errorReport.copyFailedMessage',
    );
  });

  it('shares via expo-sharing when available; otherwise falls back to Share API', async () => {
    (Sharing.isAvailableAsync as jest.Mock).mockResolvedValueOnce(true);

    const { getByText, rerender } = render(
      <ErrorReportSheet visible scope="x" error={new Error('boom')} onClose={jest.fn()} />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.press(getByText('models.errorReport.share'));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(Sharing.shareAsync).toHaveBeenCalled();
    });
    expect(Share.share).not.toHaveBeenCalled();

    (Sharing.isAvailableAsync as jest.Mock).mockResolvedValueOnce(false);
    rerender(<ErrorReportSheet visible scope="x" error={new Error('boom')} onClose={jest.fn()} />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.press(getByText('models.errorReport.share'));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(Share.share).toHaveBeenCalledWith(expect.objectContaining({ message: expect.any(String) }));
    });
  });
});
