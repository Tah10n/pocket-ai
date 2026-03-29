import { NativeModules, Platform } from 'react-native';

export interface SystemMemorySnapshot {
  totalBytes: number;
  availableBytes: number;
  usedBytes: number;
  appUsedBytes: number;
  appResidentBytes?: number;
  appPssBytes?: number;
  lowMemory: boolean;
  thresholdBytes: number;
}

interface NativeSystemMetricsModule {
  getMemorySnapshot(): Promise<Partial<SystemMemorySnapshot>>;
}

function toSafeByteCount(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

export async function getSystemMemorySnapshot(): Promise<SystemMemorySnapshot | null> {
  if (Platform.OS !== 'android') {
    return null;
  }

  const nativeModule = NativeModules.SystemMetrics as NativeSystemMetricsModule | undefined;
  if (!nativeModule || typeof nativeModule.getMemorySnapshot !== 'function') {
    return null;
  }

  const snapshot = await nativeModule.getMemorySnapshot();
  const totalBytes = toSafeByteCount(snapshot.totalBytes);
  const availableBytes = toSafeByteCount(snapshot.availableBytes);
  const usedBytes = toSafeByteCount(snapshot.usedBytes || totalBytes - availableBytes);
  const appUsedBytes = toSafeByteCount(snapshot.appUsedBytes);

  if (totalBytes <= 0) {
    return null;
  }

  return {
    totalBytes,
    availableBytes: Math.min(availableBytes, totalBytes),
    usedBytes: Math.min(Math.max(usedBytes, 0), totalBytes),
    appUsedBytes,
    lowMemory: snapshot.lowMemory === true,
    thresholdBytes: toSafeByteCount(snapshot.thresholdBytes),
  };
}
