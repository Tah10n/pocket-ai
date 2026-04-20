import type { LlamaContext } from 'llama.rn';
import type { EngineBackendMode } from '../types/models';

export function hasNpuRuntimeSignal(context: LlamaContext): boolean {
  const devices = Array.isArray(context.devices) ? context.devices : [];
  const deviceText = devices.join(' ').toLowerCase();
  const androidLib = typeof context.androidLib === 'string' ? context.androidLib.toLowerCase() : '';
  const systemInfo = typeof context.systemInfo === 'string' ? context.systemInfo.toLowerCase() : '';

  return (
    devices.some((device) => typeof device === 'string' && device.startsWith('HTP'))
    || deviceText.includes('hexagon')
    || deviceText.includes('htp')
    || deviceText.includes('qnn')
    || androidLib.includes('hexagon')
    || androidLib.includes('qnn')
    || systemInfo.includes('hexagon')
    || systemInfo.includes('qnn')
  );
}

export function resolveBackendMode(context: LlamaContext): EngineBackendMode {
  if (hasNpuRuntimeSignal(context)) {
    return 'npu';
  }

  if (context.gpu) {
    return 'gpu';
  }

  return 'cpu';
}

export function resolveBackendTelemetry({
  context,
  initProfileBackendMode,
  resolvedInitGpuLayers,
  resolvedProfileLayers,
}: {
  context: LlamaContext;
  initProfileBackendMode: EngineBackendMode | null;
  resolvedInitGpuLayers: number | null;
  resolvedProfileLayers: number;
}): {
  activeBackendMode: EngineBackendMode;
  actualGpuAccelerated: boolean;
} {
  const reasonNoGPU = typeof context.reasonNoGPU === 'string' ? context.reasonNoGPU.trim() : '';
  const hasNpuSignal = hasNpuRuntimeSignal(context);
  let runtimeBackendMode = (initProfileBackendMode ?? resolveBackendMode(context));

  // If we requested NPU but the runtime is clearly using a GPU, reflect that in diagnostics.
  if (runtimeBackendMode === 'npu' && !hasNpuSignal && context.gpu) {
    runtimeBackendMode = 'gpu';
  }

  const runtimeAccelerationEnabled = runtimeBackendMode === 'npu'
    ? (Boolean(context.gpu) || (hasNpuSignal && reasonNoGPU.length === 0))
    : Boolean(context.gpu);
  const layersForAcceleration = (resolvedInitGpuLayers ?? resolvedProfileLayers);

  return {
    activeBackendMode: runtimeBackendMode,
    actualGpuAccelerated: runtimeBackendMode !== 'cpu'
      && runtimeAccelerationEnabled
      && layersForAcceleration > 0,
  };
}
