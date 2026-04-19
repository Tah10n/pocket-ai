import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { Alert, Share } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import * as Sharing from 'expo-sharing';
import { performanceMonitor } from '../../src/services/PerformanceMonitor';
import { PerformanceScreen } from '../../src/ui/screens/PerformanceScreen';

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

jest.mock('../../src/providers/ThemeProvider', () => ({
  useTheme: () => ({
    resolvedMode: 'light',
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

jest.mock('../../src/components/ui/MaterialSymbols', () => {
  const mockReact = require('react');
  const { Text } = require('react-native');

  return {
    MaterialSymbols: ({ name }: any) => mockReact.createElement(Text, null, name),
  };
});

jest.mock('@/services/PerformanceExport', () => ({
  buildPerformanceExportJson: jest.fn(() => '{"ok":true}'),
  buildTraceFilename: jest.fn(() => 'trace.json'),
  dumpTraceToLogcat: jest.fn(() => ({ ok: true, estimatedPayloadBytes: 12 })),
  getUtf8ByteLength: jest.fn(() => 11),
}));

jest.mock('expo-file-system', () => ({
  Paths: { cache: 'cache://', document: 'document://' },
  File: class MockFile {
    uri = 'file://mock';
    create = jest.fn();
    write = jest.fn();
  },
}));

jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn().mockResolvedValue(false),
  shareAsync: jest.fn().mockResolvedValue(undefined),
}));

async function renderScreen() {
  const result = render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 0, left: 0, right: 0, bottom: 0 },
      }}
    >
      <PerformanceScreen />
    </SafeAreaProvider>,
  );

  await act(async () => {
    await Promise.resolve();
  });

  return result;
}

describe('PerformanceScreen', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as any);
    mockCanGoBack = true;
    performanceMonitor.clear();
    performanceMonitor.setEnabled(true);
  });

  afterEach(() => {
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
  });

  it('navigates back when possible', async () => {
    const { getByTestId, unmount } = await renderScreen();

    fireEvent.press(getByTestId('performance-back-button'));

    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(mockReplace).not.toHaveBeenCalled();
    unmount();
  });

  it('replaces the route when there is no back stack', async () => {
    mockCanGoBack = false;
    const { getByTestId, unmount } = await renderScreen();

    fireEvent.press(getByTestId('performance-back-button'));

    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/settings');
    unmount();
  });

  it('copies the trace JSON to the clipboard', async () => {
    const { getByTestId, unmount } = await renderScreen();

    await act(async () => {
      fireEvent.press(getByTestId('performance-copy-trace'));
      await Promise.resolve();
    });

    expect(Clipboard.setStringAsync).toHaveBeenCalledWith('{"ok":true}');
    expect(performanceMonitor.snapshot().counters['perf.export.bytes']).toBe(11);
    unmount();
  });

  it('toggles instrumentation', async () => {
    performanceMonitor.setEnabled(true);

    const { getByTestId, unmount } = await renderScreen();

    fireEvent.press(getByTestId('performance-toggle-instrumentation'));

    expect(performanceMonitor.isEnabled()).toBe(false);
    unmount();
  });

  it('shares trace via expo-sharing when available', async () => {
    (Sharing.isAvailableAsync as jest.Mock).mockResolvedValueOnce(true);

    const { getByTestId, unmount } = await renderScreen();

    await act(async () => {
      fireEvent.press(getByTestId('performance-share-trace'));
      await Promise.resolve();
    });

    expect(Sharing.shareAsync).toHaveBeenCalledWith('file://mock', { mimeType: 'application/json' });
    expect(Share.share).not.toHaveBeenCalled();
    unmount();
  });

  it('falls back to Share API when expo-sharing is unavailable', async () => {
    (Sharing.isAvailableAsync as jest.Mock).mockResolvedValueOnce(false);

    const { getByTestId, unmount } = await renderScreen();

    await act(async () => {
      fireEvent.press(getByTestId('performance-share-trace'));
      await Promise.resolve();
    });

    expect(Share.share).toHaveBeenCalledWith(expect.objectContaining({ message: expect.any(String) }));
    unmount();
  });

  it('shows an alert when saving to file is not supported', async () => {
    (Sharing.isAvailableAsync as jest.Mock).mockResolvedValueOnce(false);

    const { getByTestId, unmount } = await renderScreen();

    await act(async () => {
      fireEvent.press(getByTestId('performance-save-trace'));
      await Promise.resolve();
    });

    expect(Alert.alert).toHaveBeenCalledWith('performance.exportFailedTitle', 'performance.saveFailedMessage');
    unmount();
  });

  it('clears the trace data', async () => {
    const clearSpy = jest.spyOn(performanceMonitor, 'clear');
    performanceMonitor.incrementCounter('perf.export.bytes', 123);

    const { getByTestId, unmount } = await renderScreen();

    fireEvent.press(getByTestId('performance-clear-trace'));

    expect(clearSpy).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('renders span aggregates and event values', async () => {
    const perfNowSpy = jest.spyOn(globalThis.performance, 'now');
    perfNowSpy
      .mockReturnValueOnce(0) // span short start
      .mockReturnValueOnce(100) // span short end => 100ms
      .mockReturnValueOnce(200) // span long start
      .mockReturnValueOnce(1700) // span long end => 1500ms
      .mockReturnValue(2000);

    performanceMonitor.setEnabled(true);
    const spanShort = performanceMonitor.startSpan('load');
    spanShort.end();
    const spanLong = performanceMonitor.startSpan('load');
    spanLong.end();
    performanceMonitor.mark('mark-x');
    performanceMonitor.incrementCounter('counter-x', 5, { source: 'test' });

    const { queryAllByText, unmount } = await renderScreen();

    // Span aggregate p95 should show seconds formatting.
    expect(queryAllByText('load').length).toBeGreaterThan(0);
    expect(queryAllByText('1.50 s').length).toBeGreaterThan(0);

    // Event list should include both ms and s durations.
    expect(queryAllByText('100 ms').length).toBeGreaterThan(0);
    expect(queryAllByText('1.50 s').length).toBeGreaterThan(0);

    // Counter and mark events.
    expect(queryAllByText('counter-x').length).toBeGreaterThan(0);
    expect(queryAllByText('5').length).toBeGreaterThan(0);
    expect(queryAllByText('mark-x').length).toBeGreaterThan(0);
    expect(queryAllByText('mark').length).toBeGreaterThan(0);

    perfNowSpy.mockRestore();
    unmount();
  });
});

