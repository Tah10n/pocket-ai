import { NativeModules, Platform } from 'react-native';
import {
  getAppCacheDirectorySizeBytes,
  getSystemMemorySnapshot,
  invalidateAppCacheDirectorySizeMeasurement,
} from '../../src/services/SystemMetricsService';
import { performanceMonitor } from '../../src/services/PerformanceMonitor';

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, reject, resolve };
}

describe('SystemMetricsService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    invalidateAppCacheDirectorySizeMeasurement();
    performanceMonitor.clear();
    performanceMonitor.setEnabled(true);
    Object.defineProperty(Platform, 'OS', {
      configurable: true,
      value: 'android',
    });
    NativeModules.SystemMetrics = {
      getMemorySnapshot: jest.fn(),
    };
  });

  afterEach(() => {
    performanceMonitor.setEnabled(false);
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

  it('reads app cache size through the Android native metrics module', async () => {
    NativeModules.SystemMetrics.getCacheDirectorySize = jest.fn().mockResolvedValue(42_500_000);

    await expect(getAppCacheDirectorySizeBytes()).resolves.toBe(42_500_000);
    expect(NativeModules.SystemMetrics.getCacheDirectorySize).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent Android cache-size callers into one native invocation', async () => {
    const nativeResult = createDeferred<number>();
    NativeModules.SystemMetrics.getCacheDirectorySize = jest.fn(() => nativeResult.promise);

    const measurements = Array.from({ length: 8 }, () => getAppCacheDirectorySizeBytes());

    expect(new Set(measurements).size).toBe(1);
    expect(NativeModules.SystemMetrics.getCacheDirectorySize).toHaveBeenCalledTimes(1);

    nativeResult.resolve(12_345);

    await expect(Promise.all(measurements)).resolves.toEqual(Array(8).fill(12_345));
    expect(performanceMonitor.snapshot().counters).toEqual(expect.objectContaining({
      'storage.cacheScan.deduped': 7,
      'storage.cacheScan.native': 1,
    }));
  });

  it('shares a native cache-size rejection without poisoning the next scan', async () => {
    const firstScan = createDeferred<number>();
    const scanError = new Error('native scan failed');
    NativeModules.SystemMetrics.getCacheDirectorySize = jest.fn()
      .mockImplementationOnce(() => firstScan.promise)
      .mockResolvedValueOnce(77);

    const first = getAppCacheDirectorySizeBytes();
    const second = getAppCacheDirectorySizeBytes();

    expect(first).toBe(second);
    expect(NativeModules.SystemMetrics.getCacheDirectorySize).toHaveBeenCalledTimes(1);

    firstScan.reject(scanError);

    await expect(Promise.all([first, second])).rejects.toBe(scanError);
    await expect(getAppCacheDirectorySizeBytes()).resolves.toBe(77);
    expect(NativeModules.SystemMetrics.getCacheDirectorySize).toHaveBeenCalledTimes(2);
  });

  it('does not let an invalidated scan clear its active replacement', async () => {
    const staleScan = createDeferred<number>();
    const freshScan = createDeferred<number>();
    const invalidateNativeScan = jest.fn();
    NativeModules.SystemMetrics.getCacheDirectorySize = jest.fn()
      .mockImplementationOnce(() => staleScan.promise)
      .mockImplementationOnce(() => freshScan.promise);
    NativeModules.SystemMetrics.invalidateCacheDirectorySizeMeasurement = invalidateNativeScan;

    const staleMeasurement = getAppCacheDirectorySizeBytes();
    invalidateAppCacheDirectorySizeMeasurement();
    const freshMeasurement = getAppCacheDirectorySizeBytes();

    expect(invalidateNativeScan).toHaveBeenCalledTimes(1);

    staleScan.resolve(10);
    await expect(staleMeasurement).resolves.toBe(10);

    const dedupedFreshMeasurement = getAppCacheDirectorySizeBytes();
    expect(dedupedFreshMeasurement).toBe(freshMeasurement);
    expect(NativeModules.SystemMetrics.getCacheDirectorySize).toHaveBeenCalledTimes(2);

    freshScan.resolve(20);
    await expect(Promise.all([freshMeasurement, dedupedFreshMeasurement])).resolves.toEqual([20, 20]);
  });

  it('contains a synchronous native invalidation failure without leaking it to callers', () => {
    NativeModules.SystemMetrics.invalidateCacheDirectorySizeMeasurement = jest.fn(() => {
      throw new Error('native cancellation failed');
    });

    expect(() => invalidateAppCacheDirectorySizeMeasurement()).not.toThrow();
    expect(performanceMonitor.snapshot().counters).toEqual(expect.objectContaining({
      'storage.cacheScan.nativeInvalidationFailed': 1,
    }));
  });

  it('does not invent an Android cache size when the native method is unavailable', async () => {
    await expect(getAppCacheDirectorySizeBytes()).resolves.toBeNull();
  });
});
