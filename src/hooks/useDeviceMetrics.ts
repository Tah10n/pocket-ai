import { useState, useEffect } from 'react';
import * as Device from 'expo-device';

export interface DeviceMetrics {
  storage: {
    totalGB: number;
    usedGB: number;
    appsGB: number;
    systemGB: number;
    otherGB: number;
    usedPercentage: number;
  };
  ram: {
    totalGB: number;
    availableGB: number;
    cachedGB: number;
  };
}

export const useDeviceMetrics = () => {
  const [metrics, setMetrics] = useState<DeviceMetrics | null>(null);

  useEffect(() => {
    // Note: Expo doesn't currently provide direct synchronous access to detailed RAM and Storage 
    // partitions without native modules. For the scope of matching the UI visually,
    // we will calculate based on total memory if available or provide stable mock layouts.
    
    // Convert bytes to GB 
    const totalMem = Device.totalMemory ? Device.totalMemory / (1024 * 1024 * 1024) : 16;
    
    setMetrics({
        storage: {
        totalGB: 256,
        usedGB: 216,
        appsGB: 128,
        systemGB: 64,
        otherGB: 24,
        usedPercentage: 82
      },
      ram: {
        totalGB: Math.round(totalMem),
        availableGB: 4.2,
        cachedGB: 2.1
      }
    });
  }, []);

  return metrics;
};
