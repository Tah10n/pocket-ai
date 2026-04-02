import { NativeModules, Platform } from 'react-native';

export interface SystemMemorySnapshot {
  totalBytes: number;
  availableBytes: number;
  freeBytes?: number;
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

function toOptionalByteCount(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
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
  const freeBytes = toOptionalByteCount(snapshot.freeBytes);
  const usedBytesBase = freeBytes ?? availableBytes;
  const usedBytes = toSafeByteCount(snapshot.usedBytes || totalBytes - usedBytesBase);
  const appResidentBytes = toSafeByteCount(snapshot.appResidentBytes);
  const appPssBytes = toSafeByteCount(snapshot.appPssBytes);
  const appUsedBytes = appPssBytes || appResidentBytes || toSafeByteCount(snapshot.appUsedBytes);

  if (totalBytes <= 0) {
    return null;
  }

  return {
    totalBytes,
    availableBytes: Math.min(availableBytes, totalBytes),
    freeBytes: freeBytes === undefined ? undefined : Math.min(freeBytes, totalBytes),
    usedBytes: Math.min(Math.max(usedBytes, 0), totalBytes),
    appUsedBytes: Math.min(Math.max(appUsedBytes, 0), totalBytes),
    appResidentBytes: appResidentBytes > 0 ? Math.min(appResidentBytes, totalBytes) : undefined,
    appPssBytes: appPssBytes > 0 ? Math.min(appPssBytes, totalBytes) : undefined,
    lowMemory: snapshot.lowMemory === true,
    thresholdBytes: toSafeByteCount(snapshot.thresholdBytes),
  };
}
