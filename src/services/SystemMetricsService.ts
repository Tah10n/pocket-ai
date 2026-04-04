import { NativeModules, Platform } from 'react-native';

export type MemoryPressureLevel = 'normal' | 'warning' | 'critical' | 'unknown';

export interface SystemMemorySnapshot {
  timestampMs: number;
  platform: 'android' | 'ios';
  totalBytes: number;
  availableBytes: number;
  freeBytes?: number;
  usedBytes: number;
  appUsedBytes: number;
  appResidentBytes?: number;
  appPssBytes?: number;
  lowMemory: boolean;
  pressureLevel: MemoryPressureLevel;
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

function normalizePressureLevel(value: unknown): MemoryPressureLevel {
  return value === 'normal' || value === 'warning' || value === 'critical' || value === 'unknown'
    ? value
    : 'unknown';
}

function derivePressureLevel({
  lowMemory,
  totalBytes,
  availableBytes,
}: {
  lowMemory: boolean;
  totalBytes: number;
  availableBytes: number;
}): MemoryPressureLevel {
  if (lowMemory) {
    return 'critical';
  }

  if (totalBytes <= 0 || availableBytes <= 0) {
    return 'unknown';
  }

  const ratio = availableBytes / totalBytes;
  if (!Number.isFinite(ratio) || ratio <= 0) {
    return 'unknown';
  }

  if (ratio <= 0.08) {
    return 'critical';
  }

  if (ratio <= 0.15) {
    return 'warning';
  }

  return 'normal';
}

function normalizePlatform(): 'android' | 'ios' {
  return Platform.OS === 'android' ? 'android' : 'ios';
}

function resolveSystemMetricsModule(): NativeSystemMetricsModule | null {
  const nativeModule = NativeModules.SystemMetrics as NativeSystemMetricsModule | undefined;
  if (!nativeModule || typeof nativeModule.getMemorySnapshot !== 'function') {
    return null;
  }

  return nativeModule;
}

let cachedSnapshot: SystemMemorySnapshot | null = null;

async function readNativeSnapshot(): Promise<SystemMemorySnapshot | null> {
  const platform = normalizePlatform();
  const nativeModule = resolveSystemMetricsModule();
  if (!nativeModule) {
    return null;
  }

  const snapshot = await nativeModule.getMemorySnapshot();
  const totalBytes = toSafeByteCount(snapshot.totalBytes);
  const availableBytes = toSafeByteCount(snapshot.availableBytes);
  const freeBytes = toOptionalByteCount(snapshot.freeBytes);
  const usedBytesBase = freeBytes ?? availableBytes;
  const usedBytesCandidate = toOptionalByteCount(snapshot.usedBytes);
  const usedBytes = toSafeByteCount(usedBytesCandidate ?? totalBytes - usedBytesBase);
  const appResidentBytesRaw = toSafeByteCount(snapshot.appResidentBytes);
  const appPssBytesRaw = toSafeByteCount(snapshot.appPssBytes);
  const appResidentBytes = appResidentBytesRaw > 0 ? appResidentBytesRaw : undefined;
  const appPssBytes = appPssBytesRaw > 0 ? appPssBytesRaw : undefined;
  const appUsedBytes = appPssBytes || appResidentBytes || toSafeByteCount(snapshot.appUsedBytes);
  const lowMemory = snapshot.lowMemory === true;
  const timestampMs = typeof snapshot.timestampMs === 'number' && Number.isFinite(snapshot.timestampMs) && snapshot.timestampMs > 0
    ? Math.round(snapshot.timestampMs)
    : Date.now();
  const thresholdBytes = toSafeByteCount(snapshot.thresholdBytes);
  const pressureLevel = normalizePressureLevel(snapshot.pressureLevel);

  if (totalBytes <= 0) {
    return null;
  }

  return {
    timestampMs,
    platform,
    totalBytes,
    availableBytes: Math.min(availableBytes, totalBytes),
    freeBytes: freeBytes === undefined ? undefined : Math.min(freeBytes, totalBytes),
    usedBytes: Math.min(Math.max(usedBytes, 0), totalBytes),
    appUsedBytes: Math.min(Math.max(appUsedBytes, 0), totalBytes),
    appResidentBytes: appResidentBytes === undefined ? undefined : Math.min(appResidentBytes, totalBytes),
    appPssBytes: appPssBytes === undefined ? undefined : Math.min(appPssBytes, totalBytes),
    lowMemory,
    pressureLevel: pressureLevel === 'unknown'
      ? derivePressureLevel({ lowMemory, totalBytes, availableBytes })
      : pressureLevel,
    thresholdBytes,
  };
}

export async function getFreshMemorySnapshot(maxAgeMs: number): Promise<SystemMemorySnapshot | null> {
  const now = Date.now();

  if (cachedSnapshot && Number.isFinite(maxAgeMs) && maxAgeMs > 0 && now - cachedSnapshot.timestampMs <= maxAgeMs) {
    return cachedSnapshot;
  }

  const snapshot = await readNativeSnapshot();
  cachedSnapshot = snapshot;
  return snapshot;
}

export async function getSystemMemorySnapshot(): Promise<SystemMemorySnapshot | null> {
  return getFreshMemorySnapshot(0);
}
