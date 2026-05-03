import React, { useEffect } from 'react';
import { act, render, waitFor } from '@testing-library/react-native';
import AccessibilityInfo from 'react-native/Libraries/Components/AccessibilityInfo/AccessibilityInfo';
import DeviceInfo from 'react-native-device-info';
import { useDeviceMetrics, useMotionPreferences } from '../../src/hooks/useDeviceMetrics';
import { registry } from '../../src/services/LocalStorageRegistry';
import { getFreshMemorySnapshot } from '../../src/services/SystemMetricsService';
import { LifecycleStatus } from '../../src/types/models';

jest.mock('../../src/services/SystemMetricsService', () => ({
  getFreshMemorySnapshot: jest.fn(),
}));

jest.mock('../../src/services/LocalStorageRegistry', () => ({
  registry: {
    getModels: jest.fn(() => []),
  },
}));

const GB = 1000 * 1000 * 1000;

describe('useDeviceMetrics', () => {
  const mockedRegistry = registry as jest.Mocked<typeof registry>;

  function renderHookHarness(options: Parameters<typeof useDeviceMetrics>[0] = {}) {
    let currentValue: ReturnType<typeof useDeviceMetrics> | null = null;

    const Harness = () => {
      const value = useDeviceMetrics({ refreshIntervalMs: 60000, ...options });
      useEffect(() => {
        currentValue = value;
      }, [value]);
      return null;
    };

    const rendered = render(<Harness />);
    return {
      getCurrentValue: () => currentValue,
      ...rendered,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    (AccessibilityInfo as any).__resetAccessibilityState?.();
    mockedRegistry.getModels.mockReturnValue([]);
    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(8 * GB);
    (DeviceInfo.getUsedMemory as jest.Mock).mockResolvedValue(5 * GB);
    (DeviceInfo.getTotalDiskCapacity as jest.Mock).mockResolvedValue(100 * GB);
    (DeviceInfo.getFreeDiskStorage as jest.Mock).mockResolvedValue(25 * GB);
  });

  it('prefers system-wide Android RAM metrics when the native snapshot is available', async () => {
    (getFreshMemorySnapshot as jest.Mock).mockResolvedValue({
      timestampMs: Date.now(),
      platform: 'android',
      totalBytes: 12 * GB,
      availableBytes: 4 * GB,
      freeBytes: 3 * GB,
      usedBytes: 9 * GB,
      appUsedBytes: 3 * GB,
      appResidentBytes: 5 * GB,
      appPssBytes: 3 * GB,
      lowMemory: false,
      pressureLevel: 'normal',
      thresholdBytes: 0,
    });

    const { getCurrentValue } = renderHookHarness();

    await waitFor(() => {
      expect(getCurrentValue()?.metrics?.ram.source).toBe('system');
    });

    expect(getCurrentValue()?.metrics?.ram.totalGB).toBeCloseTo(12);
    expect(getCurrentValue()?.metrics?.ram.usedGB).toBeCloseTo(9);
    expect(getCurrentValue()?.metrics?.ram.freeGB).toBeCloseTo(3);
    expect(getCurrentValue()?.metrics?.ram.appUsedGB).toBeCloseTo(5);
    expect(getCurrentValue()?.metrics?.ram.totalBytes).toBe(12 * GB);
    expect(getCurrentValue()?.metrics?.ram.usedBytes).toBe(9 * GB);
    expect(getCurrentValue()?.metrics?.ram.availableBytes).toBe(4 * GB);
    expect(getCurrentValue()?.metrics?.ram.availableBudgetBytes).toBe(4 * GB);
    expect(getCurrentValue()?.metrics?.ram.freeBytes).toBe(3 * GB);
    expect(getCurrentValue()?.metrics?.ram.appUsedBytes).toBe(5 * GB);
    expect(getCurrentValue()?.metrics?.ram.usedPercentage).toBeCloseTo((9 / 12) * 100);
  });

  it('falls back to process memory when the Android system snapshot is unavailable', async () => {
    (getFreshMemorySnapshot as jest.Mock).mockResolvedValue(null);

    const { getCurrentValue } = renderHookHarness();

    await waitFor(() => {
      expect(getCurrentValue()?.metrics?.ram.source).toBe('process');
    });

    expect(getCurrentValue()?.metrics?.ram.totalGB).toBeCloseTo(8);
    expect(getCurrentValue()?.metrics?.ram.usedGB).toBeNull();
    expect(getCurrentValue()?.metrics?.ram.freeGB).toBeNull();
    expect(getCurrentValue()?.metrics?.ram.appUsedGB).toBeCloseTo(5);
    expect(getCurrentValue()?.metrics?.ram.totalBytes).toBe(8 * GB);
    expect(getCurrentValue()?.metrics?.ram.usedBytes).toBeNull();
    expect(getCurrentValue()?.metrics?.ram.availableBytes).toBeNull();
    expect(getCurrentValue()?.metrics?.ram.availableBudgetBytes).toBeNull();
    expect(getCurrentValue()?.metrics?.ram.freeBytes).toBeNull();
    expect(getCurrentValue()?.metrics?.ram.appUsedBytes).toBe(5 * GB);
    expect(getCurrentValue()?.metrics?.ram.usedPercentage).toBeNull();
    expect(getCurrentValue()?.metrics?.storage.usedGB).toBeCloseTo(75);
    expect(getCurrentValue()?.metrics?.storage.totalBytes).toBe(100 * GB);
    expect(getCurrentValue()?.metrics?.storage.usedBytes).toBe(75 * GB);
    expect(getCurrentValue()?.metrics?.storage.freeBytes).toBe(25 * GB);
  });

  it('does not load metrics when disabled', async () => {
    const { getCurrentValue } = renderHookHarness({ enabled: false, refreshIntervalMs: 50 });

    await act(async () => {
      await Promise.resolve();
    });

    expect(getCurrentValue()?.metrics).toBeNull();
    expect(getFreshMemorySnapshot).not.toHaveBeenCalled();
    expect(DeviceInfo.getTotalMemory).not.toHaveBeenCalled();
  });

  it('refreshes on an interval and stops after unmount', async () => {
    jest.useFakeTimers();

    try {
      (getFreshMemorySnapshot as jest.Mock).mockResolvedValue(null);
      const { getCurrentValue, unmount } = renderHookHarness({ refreshIntervalMs: 100 });

      await waitFor(() => {
        expect(getCurrentValue()?.metrics?.ram.source).toBe('process');
      });
      expect(getFreshMemorySnapshot).toHaveBeenCalledTimes(1);

      await act(async () => {
        jest.advanceTimersByTime(250);
        await Promise.resolve();
      });

      await waitFor(() => {
        expect((getFreshMemorySnapshot as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(3);
      });

      const callsBeforeUnmount = (getFreshMemorySnapshot as jest.Mock).mock.calls.length;
      unmount();

      await act(async () => {
        jest.advanceTimersByTime(300);
        await Promise.resolve();
      });

      expect((getFreshMemorySnapshot as jest.Mock).mock.calls.length).toBe(callsBeforeUnmount);
    } finally {
      jest.useRealTimers();
    }
  });

  it('skips overlapping refresh calls while a load is already in flight', async () => {
    let resolveSnapshot: (value: null) => void = () => {};
    const pendingSnapshot = new Promise<null>((resolve) => {
      resolveSnapshot = resolve;
    });
    (getFreshMemorySnapshot as jest.Mock).mockReturnValue(pendingSnapshot);

    const { getCurrentValue } = renderHookHarness();

    await waitFor(() => {
      expect(getFreshMemorySnapshot).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      void getCurrentValue()?.refresh();
      void getCurrentValue()?.refresh();
      await Promise.resolve();
    });

    expect(getFreshMemorySnapshot).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSnapshot(null);
      await pendingSnapshot;
    });

    await waitFor(() => {
      expect(getCurrentValue()?.metrics?.ram.source).toBe('process');
    });
  });

  it('falls back to zeroed metrics when loading throws unexpectedly', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockedRegistry.getModels.mockImplementation(() => {
      throw new Error('registry failed');
    });

    const { getCurrentValue } = renderHookHarness();

    await waitFor(() => {
      expect(getCurrentValue()?.metrics?.storage.totalBytes).toBe(0);
    });

    expect(getCurrentValue()?.metrics?.storage.downloadedModelsCount).toBe(0);
    expect(getCurrentValue()?.metrics?.ram.totalBytes).toBe(0);
    expect(getCurrentValue()?.metrics?.ram.source).toBe('process');
    expect(warnSpy).toHaveBeenCalledWith('[useDeviceMetrics] Failed to load device metrics', expect.any(Error));

    warnSpy.mockRestore();
  });

  it('counts only downloaded and active models in storage totals', async () => {
    mockedRegistry.getModels.mockReturnValue([
      { id: 'downloaded', lifecycleStatus: LifecycleStatus.DOWNLOADED, size: 2 * GB },
      { id: 'active', lifecycleStatus: LifecycleStatus.ACTIVE, size: 3 * GB },
      { id: 'available', lifecycleStatus: LifecycleStatus.AVAILABLE, size: 7 * GB },
      { id: 'negative', lifecycleStatus: LifecycleStatus.DOWNLOADED, size: -1 },
    ] as any);
    (getFreshMemorySnapshot as jest.Mock).mockResolvedValue(null);

    const { getCurrentValue } = renderHookHarness();

    await waitFor(() => {
      expect(getCurrentValue()?.metrics?.storage.downloadedModelsCount).toBe(3);
    });

    expect(getCurrentValue()?.metrics?.storage.downloadedModelsBytes).toBe(5 * GB);
    expect(getCurrentValue()?.metrics?.storage.downloadedModelsGB).toBeCloseTo(5);
  });

  it('downgrades motion when reduced motion is enabled at runtime', async () => {
    let currentValue: ReturnType<typeof useMotionPreferences> | null = null;

    const Harness = () => {
      const value = useMotionPreferences();
      useEffect(() => {
        currentValue = value;
      }, [value]);
      return null;
    };

    render(<Harness />);

    await waitFor(() => {
      expect(currentValue?.motionPreset).toBe('full');
    });

    await act(async () => {
      (AccessibilityInfo as any).__setReduceMotionEnabled?.(true);
    });

    await waitFor(() => {
      expect(currentValue?.motionPreset).toBe('minimal');
      expect(currentValue?.prefersReducedMotion).toBe(true);
      expect(currentValue?.routeDurationMs).toBe(0);
    });
  });

  it('uses reduced motion profile on weak devices even when accessibility motion is off', async () => {
    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(4 * GB);
    let currentValue: ReturnType<typeof useMotionPreferences> | null = null;

    const Harness = () => {
      const value = useMotionPreferences();
      useEffect(() => {
        currentValue = value;
      }, [value]);
      return null;
    };

    render(<Harness />);

    await waitFor(() => {
      expect(currentValue?.motionPreset).toBe('reduced');
      expect(currentValue?.isWeakDevice).toBe(true);
      expect(currentValue?.sheetDurationMs).toBe(160);
    });
  });

  it('handles DeviceInfo memory lookup failure and cleans up the accessibility subscription on unmount', async () => {
    (DeviceInfo.getTotalMemory as jest.Mock).mockRejectedValue(new Error('unavailable'));
    let currentValue: ReturnType<typeof useMotionPreferences> | null = null;

    const Harness = () => {
      const value = useMotionPreferences();
      useEffect(() => {
        currentValue = value;
      }, [value]);
      return null;
    };

    const { unmount } = render(<Harness />);

    await waitFor(() => {
      expect(DeviceInfo.getTotalMemory).toHaveBeenCalledTimes(1);
      expect(currentValue?.motionPreset).toBe('full');
    });

    const subscription = ((AccessibilityInfo as any).addEventListener as jest.Mock).mock.results[0]?.value;
    expect(subscription?.remove).toEqual(expect.any(Function));
    if (subscription) {
      subscription.remove = jest.fn(subscription.remove);
    }

    unmount();

    expect(subscription?.remove).toHaveBeenCalledTimes(1);
  });
});
