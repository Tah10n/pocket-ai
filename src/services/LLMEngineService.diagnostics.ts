import type { EngineBackendInitAttempt, EngineBackendMode, EngineBackendPolicy, EngineState } from '../types/models';

export function buildEngineDiagnosticsSnapshot(source: {
  activeBackendMode: EngineBackendMode | 'unknown';
  activeBackendDevices: string[];
  activeBackendReasonNoGpu: string | null;
  activeBackendSystemInfo: string | null;
  activeBackendAndroidLib: string | null;
  requestedGpuLayers: number | null;
  activeGpuLayers: number | null;
  actualGpuAccelerated: boolean | null;
  requestedBackendPolicy: EngineBackendPolicy | null;
  effectiveBackendPolicy: EngineBackendPolicy | null;
  backendPolicyReasons: string[];
  backendInitAttemptsSnapshot: EngineBackendInitAttempt[];
  initGpuLayers: number | null;
  initDevices: string[] | null;
  initCacheTypeK: string | null;
  initCacheTypeV: string | null;
  initFlashAttnType: 'auto' | 'on' | 'off' | null;
  initUseMmap: boolean | null;
  initUseMlock: boolean | null;
  initNParallel: number | null;
  initNThreads: number | null;
  initCpuMask: string | null;
  initCpuStrict: boolean | null;
  initNBatch: number | null;
  initNUbatch: number | null;
  initKvUnified: boolean | null;
}): NonNullable<EngineState['diagnostics']> {
  return {
    backendMode: source.activeBackendMode,
    backendDevices: [...source.activeBackendDevices],
    reasonNoGPU: source.activeBackendReasonNoGpu ?? undefined,
    systemInfo: source.activeBackendSystemInfo ?? undefined,
    androidLib: source.activeBackendAndroidLib ?? undefined,
    requestedGpuLayers: source.requestedGpuLayers ?? undefined,
    loadedGpuLayers: source.activeGpuLayers ?? undefined,
    actualGpuAccelerated: source.actualGpuAccelerated ?? undefined,
    requestedBackendPolicy: source.requestedBackendPolicy ?? undefined,
    effectiveBackendPolicy: source.effectiveBackendPolicy ?? undefined,
    backendPolicyReasons: source.backendPolicyReasons.length > 0 ? [...source.backendPolicyReasons] : undefined,
    backendInitAttempts: source.backendInitAttemptsSnapshot.length > 0
      ? source.backendInitAttemptsSnapshot.map((attempt) => ({
          ...attempt,
          devices: Array.isArray(attempt.devices) ? [...attempt.devices] : undefined,
        }))
      : undefined,
    initGpuLayers: source.initGpuLayers ?? undefined,
    initDevices: Array.isArray(source.initDevices) ? [...source.initDevices] : undefined,
    initCacheTypeK: source.initCacheTypeK ?? undefined,
    initCacheTypeV: source.initCacheTypeV ?? undefined,
    initFlashAttnType: source.initFlashAttnType ?? undefined,
    initUseMmap: source.initUseMmap ?? undefined,
    initUseMlock: source.initUseMlock ?? undefined,
    initNParallel: source.initNParallel ?? undefined,
    initNThreads: source.initNThreads ?? undefined,
    initCpuMask: source.initCpuMask ?? undefined,
    initCpuStrict: source.initCpuStrict ?? undefined,
    initNBatch: source.initNBatch ?? undefined,
    initNUbatch: source.initNUbatch ?? undefined,
    initKvUnified: source.initKvUnified ?? undefined,
  };
}
