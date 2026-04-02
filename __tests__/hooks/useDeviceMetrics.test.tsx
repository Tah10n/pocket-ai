import React, { useEffect } from 'react';
import { act, render, waitFor } from '@testing-library/react-native';
import AccessibilityInfo from 'react-native/Libraries/Components/AccessibilityInfo/AccessibilityInfo';
import DeviceInfo from 'react-native-device-info';
import { useDeviceMetrics, useMotionPreferences } from '../../src/hooks/useDeviceMetrics';
import { getSystemMemorySnapshot } from '../../src/services/SystemMetricsService';

jest.mock('../../src/services/SystemMetricsService', () => ({
  getSystemMemorySnapshot: jest.fn(),
}));

jest.mock('../../src/services/LocalStorageRegistry', () => ({
  registry: {
    getModels: jest.fn(() => []),
  },
}));

const GB = 1000 * 1000 * 1000;

describe('useDeviceMetrics', () => {
  function renderHookHarness() {
    let currentValue: ReturnType<typeof useDeviceMetrics> | null = null;

    const Harness = () => {
      const value = useDeviceMetrics({ refreshIntervalMs: 60000 });
      useEffect(() => {
        currentValue = value;
      }, [value]);
      return null;
    };

    render(<Harness />);
    return () => currentValue;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    (AccessibilityInfo as any).__resetAccessibilityState?.();
    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(8 * GB);
    (DeviceInfo.getUsedMemory as jest.Mock).mockResolvedValue(5 * GB);
    (DeviceInfo.getTotalDiskCapacity as jest.Mock).mockResolvedValue(100 * GB);
    (DeviceInfo.getFreeDiskStorage as jest.Mock).mockResolvedValue(25 * GB);
  });

  it('prefers system-wide Android RAM metrics when the native snapshot is available', async () => {
    (getSystemMemorySnapshot as jest.Mock).mockResolvedValue({
      totalBytes: 12 * GB,
      availableBytes: 4 * GB,
      freeBytes: 3 * GB,
      usedBytes: 9 * GB,
      appUsedBytes: 3 * GB,
      appResidentBytes: 5 * GB,
      appPssBytes: 3 * GB,
      lowMemory: false,
      thresholdBytes: 0,
    });

    const getMetrics = renderHookHarness();

    await waitFor(() => {
      expect(getMetrics()?.metrics?.ram.source).toBe('system');
    });

    expect(getMetrics()?.metrics?.ram.totalGB).toBeCloseTo(12);
    expect(getMetrics()?.metrics?.ram.usedGB).toBeCloseTo(9);
    expect(getMetrics()?.metrics?.ram.freeGB).toBeCloseTo(3);
    expect(getMetrics()?.metrics?.ram.appUsedGB).toBeCloseTo(5);
    expect(getMetrics()?.metrics?.ram.totalBytes).toBe(12 * GB);
    expect(getMetrics()?.metrics?.ram.usedBytes).toBe(9 * GB);
    expect(getMetrics()?.metrics?.ram.availableBytes).toBe(4 * GB);
    expect(getMetrics()?.metrics?.ram.freeBytes).toBe(3 * GB);
    expect(getMetrics()?.metrics?.ram.appUsedBytes).toBe(5 * GB);
    expect(getMetrics()?.metrics?.ram.usedPercentage).toBeCloseTo((9 / 12) * 100);
  });

  it('falls back to process memory when the Android system snapshot is unavailable', async () => {
    (getSystemMemorySnapshot as jest.Mock).mockResolvedValue(null);

    const getMetrics = renderHookHarness();

    await waitFor(() => {
      expect(getMetrics()?.metrics?.ram.source).toBe('process');
    });

    expect(getMetrics()?.metrics?.ram.totalGB).toBeCloseTo(8);
    expect(getMetrics()?.metrics?.ram.usedGB).toBeNull();
    expect(getMetrics()?.metrics?.ram.freeGB).toBeNull();
    expect(getMetrics()?.metrics?.ram.appUsedGB).toBeCloseTo(5);
    expect(getMetrics()?.metrics?.ram.totalBytes).toBe(8 * GB);
    expect(getMetrics()?.metrics?.ram.usedBytes).toBeNull();
    expect(getMetrics()?.metrics?.ram.availableBytes).toBeNull();
    expect(getMetrics()?.metrics?.ram.freeBytes).toBeNull();
    expect(getMetrics()?.metrics?.ram.appUsedBytes).toBe(5 * GB);
    expect(getMetrics()?.metrics?.ram.usedPercentage).toBeNull();
    expect(getMetrics()?.metrics?.storage.usedGB).toBeCloseTo(75);
    expect(getMetrics()?.metrics?.storage.totalBytes).toBe(100 * GB);
    expect(getMetrics()?.metrics?.storage.usedBytes).toBe(75 * GB);
    expect(getMetrics()?.metrics?.storage.freeBytes).toBe(25 * GB);
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
});
