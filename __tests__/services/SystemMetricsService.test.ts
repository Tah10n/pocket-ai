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
      freeBytes: 3_000_000_000,
      usedBytes: 9_000_000_000,
      appUsedBytes: 6_000_000_000,
      appResidentBytes: 5_000_000_000,
      appPssBytes: 3_000_000_000,
      lowMemory: false,
      thresholdBytes: 0,
    });

    await expect(getSystemMemorySnapshot()).resolves.toEqual({
      timestampMs: expect.any(Number),
      platform: 'android',
      totalBytes: 12_000_000_000,
      availableBytes: 4_000_000_000,
      freeBytes: 3_000_000_000,
      usedBytes: 9_000_000_000,
      appUsedBytes: 3_000_000_000,
      appResidentBytes: 5_000_000_000,
      appPssBytes: 3_000_000_000,
      lowMemory: false,
      pressureLevel: 'normal',
      thresholdBytes: 0,
    });
  });

  it('falls back to resident memory and legacy appUsedBytes when PSS is unavailable', async () => {
    (NativeModules.SystemMetrics.getMemorySnapshot as jest.Mock)
      .mockResolvedValueOnce({
        totalBytes: 8_000_000_000,
        availableBytes: 2_000_000_000,
        freeBytes: 1_500_000_000,
        usedBytes: 6_500_000_000,
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
      timestampMs: expect.any(Number),
      platform: 'android',
      totalBytes: 8_000_000_000,
      availableBytes: 2_000_000_000,
      freeBytes: 1_500_000_000,
      usedBytes: 6_500_000_000,
      appUsedBytes: 1_500_000_000,
      appResidentBytes: 1_500_000_000,
      appPssBytes: undefined,
      lowMemory: true,
      pressureLevel: 'critical',
      thresholdBytes: 250_000_000,
    });

    await expect(getSystemMemorySnapshot()).resolves.toEqual({
      timestampMs: expect.any(Number),
      platform: 'android',
      totalBytes: 8_000_000_000,
      availableBytes: 2_000_000_000,
      freeBytes: undefined,
      usedBytes: 6_000_000_000,
      appUsedBytes: 1_250_000_000,
      appResidentBytes: undefined,
      appPssBytes: undefined,
      lowMemory: false,
      pressureLevel: 'normal',
      thresholdBytes: 0,
    });
  });

  it('preserves advertised Android memory separately from budgetable total memory', async () => {
    (NativeModules.SystemMetrics.getMemorySnapshot as jest.Mock).mockResolvedValue({
      totalBytes: 7_500_000_000,
      advertisedMemoryBytes: 8_000_000_000,
      availableBytes: 1_500_000_000,
      freeBytes: 300_000_000,
      usedBytes: 7_200_000_000,
      appUsedBytes: 200_000_000,
      lowMemory: false,
      pressureLevel: 'normal',
      thresholdBytes: 0,
    });

    await expect(getSystemMemorySnapshot()).resolves.toEqual(expect.objectContaining({
      platform: 'android',
      totalBytes: 7_500_000_000,
      advertisedMemoryBytes: 8_000_000_000,
      availableBytes: 1_500_000_000,
      freeBytes: 300_000_000,
      pressureLevel: 'normal',
    }));
  });

  it('derives warning pressure when native pressure is unknown', async () => {
    (NativeModules.SystemMetrics.getMemorySnapshot as jest.Mock).mockResolvedValue({
      totalBytes: 10_000_000_000,
      availableBytes: 1_200_000_000,
      freeBytes: 250_000_000,
      appUsedBytes: 100_000_000,
      lowMemory: false,
      pressureLevel: 'unknown',
      thresholdBytes: 0,
    });

    await expect(getSystemMemorySnapshot()).resolves.toEqual(expect.objectContaining({
      platform: 'android',
      pressureLevel: 'warning',
    }));
  });

  it('preserves native warning pressure without falling back to normal', async () => {
    (NativeModules.SystemMetrics.getMemorySnapshot as jest.Mock).mockResolvedValue({
      totalBytes: 10_000_000_000,
      availableBytes: 2_000_000_000,
      freeBytes: 250_000_000,
      appUsedBytes: 100_000_000,
      lowMemory: false,
      pressureLevel: 'warning',
      thresholdBytes: 0,
    });

    await expect(getSystemMemorySnapshot()).resolves.toEqual(expect.objectContaining({
      platform: 'android',
      pressureLevel: 'warning',
    }));
  });

  it('keeps iOS process availability and reclaimable availability distinct from free memory', async () => {
    Object.defineProperty(Platform, 'OS', {
      configurable: true,
      value: 'ios',
    });
    (NativeModules.SystemMetrics.getMemorySnapshot as jest.Mock).mockResolvedValue({
      totalBytes: 8_000_000_000,
      availableBytes: 3_000_000_000,
      processAvailableBytes: 2_000_000_000,
      freeBytes: 250_000_000,
      usedBytes: 7_750_000_000,
      appUsedBytes: 500_000_000,
      appResidentBytes: 500_000_000,
      lowMemory: false,
      pressureLevel: 'normal',
      thresholdBytes: 0,
    });

    await expect(getSystemMemorySnapshot()).resolves.toEqual(expect.objectContaining({
      platform: 'ios',
      availableBytes: 3_000_000_000,
      processAvailableBytes: 2_000_000_000,
      freeBytes: 250_000_000,
    }));
  });

  it('ignores a zero iOS process availability value when native reports one', async () => {
    Object.defineProperty(Platform, 'OS', {
      configurable: true,
      value: 'ios',
    });
    (NativeModules.SystemMetrics.getMemorySnapshot as jest.Mock).mockResolvedValue({
      totalBytes: 8_000_000_000,
      availableBytes: 3_000_000_000,
      processAvailableBytes: 0,
      freeBytes: 250_000_000,
      appUsedBytes: 500_000_000,
      lowMemory: false,
      thresholdBytes: 0,
    });

    await expect(getSystemMemorySnapshot()).resolves.toEqual(expect.objectContaining({
      platform: 'ios',
      processAvailableBytes: undefined,
    }));
  });

  it('does not label unsupported platforms as iOS', async () => {
    Object.defineProperty(Platform, 'OS', {
      configurable: true,
      value: 'web',
    });
    (NativeModules.SystemMetrics.getMemorySnapshot as jest.Mock).mockResolvedValue({
      totalBytes: 4_000_000_000,
      availableBytes: 2_000_000_000,
      appUsedBytes: 100_000_000,
      lowMemory: false,
      thresholdBytes: 0,
    });

    await expect(getSystemMemorySnapshot()).resolves.toEqual(expect.objectContaining({
      platform: 'unknown',
    }));
  });
});
