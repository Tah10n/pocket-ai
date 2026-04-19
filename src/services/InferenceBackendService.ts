import type { NativeBackendDeviceInfo } from 'llama.rn';
import { Platform } from 'react-native';
import { requireLlamaModule } from './llamaRnModule';

export type RuntimeBackendKind = 'cpu' | 'gpu' | 'npu';

export interface BackendCapability {
  kind: RuntimeBackendKind;
  label: string;
  available: boolean;
  deviceNames: string[];
  backendNames: string[];
  notes: string[];
}

export interface BackendCapabilitiesSummary {
  discoveryUnavailable: boolean;
  cpu: BackendCapability;
  gpu: BackendCapability;
  npu: BackendCapability;
  rawDevices: {
    backend: string;
    type: string;
    deviceName: string;
    maxMemorySize: number;
    metadata?: Record<string, unknown>;
  }[];
}

export type BackendAvailabilitySnapshot = {
  gpuBackendAvailable: boolean | null;
  npuBackendAvailable: boolean | null;
  discoveryUnavailable: boolean;
  devices: NativeBackendDeviceInfo[];
};

function normalizeDeviceName(deviceName: string): string {
  return deviceName.trim();
}

function isNpuDevice(device: NativeBackendDeviceInfo): boolean {
  // Align with llama.rn docs: Hexagon devices are exposed as HTP* selectors.
  // Prefer matching the concrete deviceName tokens (HTP0 / HTP1 / ...).
  const name = typeof device.deviceName === 'string' ? device.deviceName.trim() : '';
  if (name.startsWith('HTP')) {
    return true;
  }

  // Fallback: some builds may label the backend as HTP/Hexagon/QNN.
  const backend = typeof device.backend === 'string' ? device.backend.trim().toLowerCase() : '';
  return backend.includes('htp') || backend.includes('hexagon') || backend.includes('qnn');
}

function isOpenClDevice(device: NativeBackendDeviceInfo): boolean {
  const backend = typeof device.backend === 'string' ? device.backend.trim().toLowerCase() : '';
  return backend.includes('opencl');
}

function uniqueStrings(values: string[]): string[] {
  const normalized = values.map((value) => value.trim()).filter((value) => value.length > 0);
  return Array.from(new Set(normalized));
}

function mapRawDevice(device: NativeBackendDeviceInfo): BackendCapabilitiesSummary['rawDevices'][number] {
  return {
    backend: device.backend,
    type: device.type,
    deviceName: device.deviceName,
    maxMemorySize: device.maxMemorySize,
    metadata: device.metadata as Record<string, unknown> | undefined,
  };
}

class InferenceBackendService {
  private backendDevicesInfo: NativeBackendDeviceInfo[] | null | undefined = undefined;
  private backendDevicesInfoPromise: Promise<NativeBackendDeviceInfo[] | null> | null = null;
  private backendDiscoveryUnsupported = false;

  private static readonly BACKEND_DISCOVERY_TIMEOUT_MS = 8000;

  public async getBackendDevicesInfo(): Promise<NativeBackendDeviceInfo[] | null> {
    if (this.backendDiscoveryUnsupported) {
      return null;
    }

    if (this.backendDevicesInfo !== undefined) {
      return this.backendDevicesInfo;
    }

    if (this.backendDevicesInfoPromise) {
      return this.backendDevicesInfoPromise;
    }

    this.backendDevicesInfoPromise = (async () => {
      try {
        const llama = requireLlamaModule() as unknown as {
          getBackendDevicesInfo?: () => Promise<NativeBackendDeviceInfo[]>;
        };

        if (typeof llama.getBackendDevicesInfo !== 'function') {
          this.backendDiscoveryUnsupported = true;
          this.backendDevicesInfo = null;
          return null;
        }

        const timeoutMs = InferenceBackendService.BACKEND_DISCOVERY_TIMEOUT_MS;
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error(`Timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        });

        // Ensure sync throws become Promise rejections, and always clear the timeout.
        const backendPromise = Promise.resolve().then(() => llama.getBackendDevicesInfo!());

        let result: unknown;
        try {
          result = await Promise.race([
            backendPromise,
            timeoutPromise,
          ]);
        } finally {
          if (timeoutId !== null) {
            clearTimeout(timeoutId);
          }
        }
        const devices = Array.isArray(result) ? result : [];
        this.backendDevicesInfo = devices;
        return devices;
      } catch (error) {
        // Do not permanently cache transient discovery failures.
        if (process.env.NODE_ENV !== 'test') {
          console.warn('[InferenceBackend] Failed to read backend devices info', error);
        }
        return null;
      } finally {
        this.backendDevicesInfoPromise = null;
      }
    })();

    return this.backendDevicesInfoPromise;
  }

  public clearCache(): void {
    this.backendDevicesInfo = undefined;
    this.backendDevicesInfoPromise = null;
    this.backendDiscoveryUnsupported = false;
  }

  public async getBackendAvailability(): Promise<BackendAvailabilitySnapshot> {
    const devicesOrNull = await this.getBackendDevicesInfo();
    const devices = devicesOrNull ?? [];

    // If discovery is unavailable, report unknown accelerator availability.
    // Callers should treat discovery-unavailable as CPU-only for safety.
    if (devicesOrNull === null) {
      return {
        gpuBackendAvailable: null,
        npuBackendAvailable: null,
        discoveryUnavailable: true,
        devices,
      };
    }

    const npuDevices = devices.filter((device) => isNpuDevice(device));
    const gpuDevices = devices.filter((device) => !isNpuDevice(device));

    if (Platform.OS === 'android') {
      const hasCompatibleOpenClGpu = gpuDevices.some((device) => isOpenClDevice(device));
      const hasCompatibleHexagon = npuDevices.length > 0;

      return {
        gpuBackendAvailable: hasCompatibleOpenClGpu,
        npuBackendAvailable: hasCompatibleHexagon,
        discoveryUnavailable: false,
        devices,
      };
    }

    const npuBackendAvailable = npuDevices.length > 0;
    const gpuBackendAvailable = gpuDevices.length > 0;

    return {
      gpuBackendAvailable,
      npuBackendAvailable,
      discoveryUnavailable: false,
      devices,
    };
  }

  public async getCapabilitiesSummary(): Promise<BackendCapabilitiesSummary> {
    const devicesOrNull = await this.getBackendDevicesInfo();
    const devices = devicesOrNull ?? [];
    const rawDevices = devices.map(mapRawDevice);
    const discoveryUnavailable = devicesOrNull === null;

    const npuDevices = devices.filter((device) => isNpuDevice(device));
    const gpuDevices = devices.filter((device) => !isNpuDevice(device));

    const androidHasCompatibleOpenClGpu = Platform.OS === 'android'
      ? gpuDevices.some((device) => isOpenClDevice(device))
      : gpuDevices.length > 0;
    const androidHasCompatibleHexagonNpu = Platform.OS === 'android'
      ? npuDevices.length > 0
      : npuDevices.length > 0;

    const cpu: BackendCapability = {
      kind: 'cpu',
      label: 'CPU',
      available: true,
      deviceNames: [],
      backendNames: [],
      notes: [],
    };

    const gpuNotes: string[] = [];
    const npuNotes: string[] = [];
    if (discoveryUnavailable) {
      const note = 'Backend device discovery is unavailable.';
      gpuNotes.push(note);
      npuNotes.push(note);
    }

    const gpu: BackendCapability = {
      kind: 'gpu',
      label: 'GPU',
      available: !discoveryUnavailable && androidHasCompatibleOpenClGpu,
      deviceNames: uniqueStrings(gpuDevices.map((device) => normalizeDeviceName(device.deviceName))),
      backendNames: uniqueStrings(gpuDevices.map((device) => device.backend)),
      notes: gpuNotes,
    };

    const npu: BackendCapability = {
      kind: 'npu',
      label: 'NPU',
      available: !discoveryUnavailable && androidHasCompatibleHexagonNpu,
      deviceNames: uniqueStrings(npuDevices.map((device) => normalizeDeviceName(device.deviceName))),
      backendNames: uniqueStrings(npuDevices.map((device) => device.backend)),
      notes: npuNotes,
    };

    return {
      discoveryUnavailable,
      cpu,
      gpu,
      npu,
      rawDevices,
    };
  }
}

export const inferenceBackendService = new InferenceBackendService();
