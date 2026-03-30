import { NativeModules, Platform } from 'react-native';
import { getSystemMemorySnapshot } from '../../src/services/SystemMetricsService';

describe('SystemMetricsService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(Platform, 'OS', {
      configurable: true,
      value: 'android',
    });
    NativeModules.SystemMetrics = {
      getMemorySnapshot: jest.fn(),
    };
  });

  it('prefers Android app PSS for app memory when the native snapshot provides it', async () => {
    (NativeModules.SystemMetrics.getMemorySnapshot as jest.Mock).mockResolvedValue({
      totalBytes: 12_000_000_000,
      availableBytes: 4_000_000_000,
      usedBytes: 8_000_000_000,
      appUsedBytes: 6_000_000_000,
      appResidentBytes: 5_000_000_000,
      appPssBytes: 3_000_000_000,
      lowMemory: false,
      thresholdBytes: 0,
    });

    await expect(getSystemMemorySnapshot()).resolves.toEqual({
      totalBytes: 12_000_000_000,
      availableBytes: 4_000_000_000,
      usedBytes: 8_000_000_000,
      appUsedBytes: 3_000_000_000,
      appResidentBytes: 5_000_000_000,
      appPssBytes: 3_000_000_000,
      lowMemory: false,
      thresholdBytes: 0,
    });
  });

  it('falls back to resident memory and legacy appUsedBytes when PSS is unavailable', async () => {
    (NativeModules.SystemMetrics.getMemorySnapshot as jest.Mock)
      .mockResolvedValueOnce({
        totalBytes: 8_000_000_000,
        availableBytes: 2_000_000_000,
        usedBytes: 6_000_000_000,
        appUsedBytes: 4_000_000_000,
        appResidentBytes: 1_500_000_000,
        lowMemory: true,
        thresholdBytes: 250_000_000,
      })
      .mockResolvedValueOnce({
        totalBytes: 8_000_000_000,
        availableBytes: 2_000_000_000,
        usedBytes: 6_000_000_000,
        appUsedBytes: 1_250_000_000,
        lowMemory: false,
        thresholdBytes: 0,
      });

    await expect(getSystemMemorySnapshot()).resolves.toEqual({
      totalBytes: 8_000_000_000,
      availableBytes: 2_000_000_000,
      usedBytes: 6_000_000_000,
      appUsedBytes: 1_500_000_000,
      appResidentBytes: 1_500_000_000,
      appPssBytes: undefined,
      lowMemory: true,
      thresholdBytes: 250_000_000,
    });

    await expect(getSystemMemorySnapshot()).resolves.toEqual({
      totalBytes: 8_000_000_000,
      availableBytes: 2_000_000_000,
      usedBytes: 6_000_000_000,
      appUsedBytes: 1_250_000_000,
      appResidentBytes: undefined,
      appPssBytes: undefined,
      lowMemory: false,
      thresholdBytes: 0,
    });
  });
});
