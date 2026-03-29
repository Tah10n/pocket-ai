import { useCallback, useEffect, useRef, useState } from 'react';
import * as Device from 'expo-device';
import DeviceInfo from 'react-native-device-info';
import { registry } from '../services/LocalStorageRegistry';
import { getSystemMemorySnapshot } from '../services/SystemMetricsService';
import { LifecycleStatus } from '../types/models';

export interface DeviceMetrics {
  storage: {
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
    downloadedModelsBytes: number;
    totalGB: number;
    usedGB: number;
    freeGB: number;
    downloadedModelsGB: number;
    downloadedModelsCount: number;
    usedPercentage: number;
  };
  ram: {
    totalBytes: number;
    usedBytes: number | null;
    availableBytes: number | null;
    appUsedBytes: number;
    totalGB: number;
    usedGB: number | null;
    freeGB: number | null;
    appUsedGB: number;
    usedPercentage: number | null;
    source: 'system' | 'process';
  };
}

interface UseDeviceMetricsOptions {
  enabled?: boolean;
  refreshIntervalMs?: number;
}

function bytesToGb(value: number) {
  return value / (1024 * 1024 * 1024);
}

export const useDeviceMetrics = (options: UseDeviceMetricsOptions = {}) => {
  const {
    enabled = true,
    refreshIntervalMs = 15000,
  } = options;
  const [metrics, setMetrics] = useState<DeviceMetrics | null>(null);
  const isMountedRef = useRef(true);

  const loadMetrics = useCallback(async () => {
    try {
      const systemMemorySnapshot = await getSystemMemorySnapshot().catch(() => null);
      const [
        totalMemoryBytes,
        usedMemoryBytes,
        totalDiskBytes,
        freeDiskBytes,
      ] = await Promise.all([
        DeviceInfo.getTotalMemory().catch(() => Device.totalMemory ?? 0),
        DeviceInfo.getUsedMemory().catch(() => 0),
        DeviceInfo.getTotalDiskCapacity().catch(() => 0),
        DeviceInfo.getFreeDiskStorage().catch(() => 0),
      ]);

      const isSystemMemoryAvailable = systemMemorySnapshot !== null;
      const resolvedTotalMemoryBytes = systemMemorySnapshot?.totalBytes ?? totalMemoryBytes;
      const resolvedUsedMemoryBytes = systemMemorySnapshot?.usedBytes ?? null;
      const resolvedFreeMemoryBytes = systemMemorySnapshot?.availableBytes ?? null;
      const appUsedMemoryBytes = systemMemorySnapshot?.appUsedBytes ?? usedMemoryBytes;
      const totalMemoryGB = bytesToGb(resolvedTotalMemoryBytes);
      const usedMemoryGB = resolvedUsedMemoryBytes === null ? null : bytesToGb(resolvedUsedMemoryBytes);
      const freeMemoryGB = resolvedFreeMemoryBytes === null ? null : bytesToGb(resolvedFreeMemoryBytes);
      const appUsedMemoryGB = bytesToGb(appUsedMemoryBytes);
      const totalStorageGB = bytesToGb(totalDiskBytes);
      const freeStorageGB = bytesToGb(freeDiskBytes);
      const usedStorageGB = Math.max(totalStorageGB - freeStorageGB, 0);
      const downloadedModels = registry.getModels().filter((model) => (
        model.lifecycleStatus === LifecycleStatus.DOWNLOADED
        || model.lifecycleStatus === LifecycleStatus.ACTIVE
      ));
      const downloadedModelsBytes = downloadedModels.reduce((sum, model) => (
        sum + Math.max(model.size ?? 0, 0)
      ), 0);

      if (!isMountedRef.current) {
        return;
      }

      setMetrics({
        storage: {
          totalBytes: totalDiskBytes,
          usedBytes: Math.max(totalDiskBytes - freeDiskBytes, 0),
          freeBytes: freeDiskBytes,
          downloadedModelsBytes,
          totalGB: totalStorageGB,
          usedGB: usedStorageGB,
          freeGB: freeStorageGB,
          downloadedModelsGB: bytesToGb(downloadedModelsBytes),
          downloadedModelsCount: downloadedModels.length,
          usedPercentage: totalStorageGB > 0 ? (usedStorageGB / totalStorageGB) * 100 : 0,
        },
        ram: {
          totalBytes: resolvedTotalMemoryBytes,
          usedBytes: resolvedUsedMemoryBytes,
          availableBytes: resolvedFreeMemoryBytes,
          appUsedBytes: appUsedMemoryBytes,
          totalGB: totalMemoryGB,
          usedGB: usedMemoryGB,
          freeGB: freeMemoryGB,
          appUsedGB: appUsedMemoryGB,
          usedPercentage: isSystemMemoryAvailable && usedMemoryGB !== null && totalMemoryGB > 0
            ? (usedMemoryGB / totalMemoryGB) * 100
            : null,
          source: isSystemMemoryAvailable ? 'system' : 'process',
        },
      });
    } catch (error) {
      console.warn('[useDeviceMetrics] Failed to load device metrics', error);

      if (!isMountedRef.current) {
        return;
      }

      setMetrics({
        storage: {
          totalBytes: 0,
          usedBytes: 0,
          freeBytes: 0,
          downloadedModelsBytes: 0,
          totalGB: 0,
          usedGB: 0,
          freeGB: 0,
          downloadedModelsGB: 0,
          downloadedModelsCount: 0,
          usedPercentage: 0,
        },
        ram: {
          totalBytes: 0,
          usedBytes: null,
          availableBytes: null,
          appUsedBytes: 0,
          totalGB: 0,
          usedGB: null,
          freeGB: null,
          appUsedGB: 0,
          usedPercentage: null,
          source: 'process',
        },
      });
    }
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    if (!enabled) {
      return () => {
        isMountedRef.current = false;
      };
    }

    void loadMetrics();
    const intervalId = setInterval(() => {
      void loadMetrics();
    }, refreshIntervalMs);

    return () => {
      isMountedRef.current = false;
      clearInterval(intervalId);
    };
  }, [enabled, loadMetrics, refreshIntervalMs]);

  return { metrics, refresh: loadMetrics };
};
