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

function normalizeSearchToken(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

function buildDeviceSearchText(device: NativeBackendDeviceInfo): string {
  const metadata = device.metadata as Record<string, unknown> | undefined;
  const metadataTokens = metadata
    ? Object.values(metadata).map(normalizeSearchToken).filter((token) => token.length > 0)
    : [];

  return [
    normalizeSearchToken(device.backend),
    normalizeSearchToken(device.type),
    normalizeSearchToken(device.deviceName),
    ...metadataTokens,
  ]
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .join(' ')
    .toLowerCase();
}

function parseAdrenoModelNumber(text: string): number | null {
  const match = text.match(/adreno(?:\s*\(tm\))?\s*(\d{3,4})/i);
  if (!match) {
    return null;
  }
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.round(parsed);
}

function parseQualcommSocModelNumber(text: string): number | null {
  const regex = /\bsm(\d{4})\b/gi;
  let match: RegExpExecArray | null = null;
  let best: number | null = null;
  while ((match = regex.exec(text)) !== null) {
    const parsed = Number(match[1]);
    if (!Number.isFinite(parsed)) {
      continue;
    }
    const normalized = Math.round(parsed);
    if (best === null || normalized > best) {
      best = normalized;
    }
  }
  return best;
}

function isCompatibleAndroidOpenClGpuDevice(device: NativeBackendDeviceInfo): boolean {
  const text = buildDeviceSearchText(device);
  if (!text.includes('opencl')) {
    return false;
  }

  const adreno = parseAdrenoModelNumber(text);
  if (adreno === null) {
    return false;
  }

  // OpenCL acceleration is supported & tested on Adreno 700+.
  return adreno >= 700;
}

function isCompatibleAndroidHexagonNpuEnvironment({
  devices,
  hasCompatibleOpenClGpu,
}: {
  devices: NativeBackendDeviceInfo[];
  hasCompatibleOpenClGpu: boolean;
}): boolean {
  if (hasCompatibleOpenClGpu) {
    return true;
  }

  const combinedText = devices.map(buildDeviceSearchText).join(' ');
  const socModel = parseQualcommSocModelNumber(combinedText);
  if (socModel !== null) {
    // Hexagon HTP support is supported & tested on SM8450+.
    return socModel >= 8450;
  }

  // Fallback: Qualcomm board codenames for newer SoCs.
  return combinedText.includes('taro') || combinedText.includes('kalama') || combinedText.includes('pineapple');
}

function isNpuDevice(device: NativeBackendDeviceInfo): boolean {
  const text = buildDeviceSearchText(device);

  // Keep in sync (conceptually) with the runtime backend detector in
  // LLMEngineService.resolveBackendMode, but only using fields we have here.
  return text.includes('htp') || text.includes('hexagon') || text.includes('qnn');
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

        const result = await llama.getBackendDevicesInfo();
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
      const hasCompatibleOpenClGpu = gpuDevices.some((device) => isCompatibleAndroidOpenClGpuDevice(device));
      const hasCompatibleHexagon = npuDevices.length > 0 && isCompatibleAndroidHexagonNpuEnvironment({
        devices,
        hasCompatibleOpenClGpu,
      });

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
      ? gpuDevices.some((device) => isCompatibleAndroidOpenClGpuDevice(device))
      : gpuDevices.length > 0;
    const androidHasCompatibleHexagonNpu = Platform.OS === 'android'
      ? (npuDevices.length > 0 && isCompatibleAndroidHexagonNpuEnvironment({ devices, hasCompatibleOpenClGpu: androidHasCompatibleOpenClGpu }))
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
