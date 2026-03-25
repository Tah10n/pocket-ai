import { useCallback, useEffect, useRef, useState } from 'react';
import * as Device from 'expo-device';
import DeviceInfo from 'react-native-device-info';
import { registry } from '../services/LocalStorageRegistry';
import { LifecycleStatus } from '../types/models';

export interface DeviceMetrics {
  storage: {
    totalGB: number;
    usedGB: number;
    freeGB: number;
    downloadedModelsGB: number;
    downloadedModelsCount: number;
    usedPercentage: number;
  };
  ram: {
    totalGB: number;
    usedGB: number;
    freeGB: number;
    usedPercentage: number;
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

      const totalMemoryGB = bytesToGb(totalMemoryBytes);
      const usedMemoryGB = bytesToGb(usedMemoryBytes);
      const freeMemoryGB = Math.max(totalMemoryGB - usedMemoryGB, 0);
      const totalStorageGB = bytesToGb(totalDiskBytes);
      const freeStorageGB = bytesToGb(freeDiskBytes);
      const usedStorageGB = Math.max(totalStorageGB - freeStorageGB, 0);
      const downloadedModels = registry.getModels().filter((model) => (
        model.lifecycleStatus === LifecycleStatus.DOWNLOADED
        || model.lifecycleStatus === LifecycleStatus.ACTIVE
      ));
      const downloadedModelsBytes = downloadedModels.reduce((sum, model) => (
        sum + Math.max(model.size, 0)
      ), 0);

      if (!isMountedRef.current) {
        return;
      }

      setMetrics({
        storage: {
          totalGB: totalStorageGB,
          usedGB: usedStorageGB,
          freeGB: freeStorageGB,
          downloadedModelsGB: bytesToGb(downloadedModelsBytes),
          downloadedModelsCount: downloadedModels.length,
          usedPercentage: totalStorageGB > 0 ? (usedStorageGB / totalStorageGB) * 100 : 0,
        },
        ram: {
          totalGB: totalMemoryGB,
          usedGB: usedMemoryGB,
          freeGB: freeMemoryGB,
          usedPercentage: totalMemoryGB > 0 ? (usedMemoryGB / totalMemoryGB) * 100 : 0,
        },
      });
    } catch (error) {
      console.warn('[useDeviceMetrics] Failed to load device metrics', error);

      if (!isMountedRef.current) {
        return;
      }

      setMetrics({
        storage: {
          totalGB: 0,
          usedGB: 0,
          freeGB: 0,
          downloadedModelsGB: 0,
          downloadedModelsCount: 0,
          usedPercentage: 0,
        },
        ram: {
          totalGB: 0,
          usedGB: 0,
          freeGB: 0,
          usedPercentage: 0,
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
