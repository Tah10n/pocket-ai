import { llmEngineService } from './LLMEngineService';
import { inferenceBackendService } from './InferenceBackendService';
import { getModelLoadParametersForModel, type ModelLoadParameters } from './SettingsStore';
import { EngineStatus, type EngineDiagnostics } from '../types/models';
import * as FileSystem from 'expo-file-system/legacy';
import { registry } from './LocalStorageRegistry';
import { getModelsDir } from './FileSystemSetup';
import { safeJoinModelPath } from '../utils/safeFilePath';
import {
  type AutotuneBackendMode,
  type AutotuneBestStableProfile,
  type AutotuneCandidateReport,
  type AutotuneResult,
  readAutotuneResult,
  writeAutotuneResult,
} from './InferenceAutotuneStore';

function uniqueInts(values: number[]): number[] {
  const normalized = values
    .filter((value) => Number.isFinite(value))
    .map((value) => Math.max(0, Math.round(value)));
  return Array.from(new Set(normalized));
}

function isSafeBackendDeviceSelector(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) {
    return false;
  }

  return !/\s/.test(normalized);
}

function resolveAutotuneCandidates({
  recommendedGpuLayers,
  gpuLayersCeiling,
  gpuAvailable,
  npuAvailable,
  npuDeviceSelectors,
}: {
  recommendedGpuLayers: number;
  gpuLayersCeiling: number;
  gpuAvailable: boolean;
  npuAvailable: boolean;
  npuDeviceSelectors?: string[] | null;
}): AutotuneBestStableProfile[] {
  const ceiling = Math.max(0, Math.round(gpuLayersCeiling));
  const recommended = Math.max(0, Math.min(ceiling, Math.round(recommendedGpuLayers)));

  const candidates: AutotuneBestStableProfile[] = [{ backendMode: 'cpu', nGpuLayers: 0 }];

  if (recommended <= 0) {
    return candidates;
  }

  // Avoid attempting GPU profiles unless backend discovery has confirmed the GPU path is available.
  // Some older devices crash natively when initializing unsupported GPU backends.
  if (gpuAvailable) {
    const layerTargets = uniqueInts([
      Math.floor(recommended / 2),
      recommended,
      Math.min(ceiling, Math.floor(recommended * 1.5)),
    ])
      .filter((value) => value > 0)
      .sort((a, b) => a - b);

    for (const nGpuLayers of layerTargets) {
      candidates.push({ backendMode: 'gpu', nGpuLayers });
    }
  }

  if (npuAvailable) {
    const resolvedSelectors = Array.isArray(npuDeviceSelectors)
      ? npuDeviceSelectors
          .filter((device): device is string => typeof device === 'string')
          .map((device) => device.trim())
          .filter((device) => device.length > 0)
      : [];

    candidates.push({
      backendMode: 'npu',
      nGpuLayers: recommended,
      devices: resolvedSelectors.length > 0 ? Array.from(new Set(resolvedSelectors)) : ['HTP*'],
    });
  }

  return candidates;
}

function mapBackendModeToPolicy(mode: AutotuneBackendMode): ModelLoadParameters['backendPolicy'] {
  if (mode === 'cpu' || mode === 'gpu' || mode === 'npu') {
    return mode;
  }
  return undefined;
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'Unknown error';
}

function resolveRestoreLoadParamsOverride(diagnostics: EngineDiagnostics | undefined): Partial<ModelLoadParameters> | null {
  const backendMode = diagnostics?.backendMode;
  const actualGpu = diagnostics?.actualGpuAccelerated === true;
  const loadedGpuLayers = typeof diagnostics?.loadedGpuLayers === 'number' && Number.isFinite(diagnostics.loadedGpuLayers)
    ? Math.max(0, Math.round(diagnostics.loadedGpuLayers))
    : 0;

  if (backendMode === 'npu' && actualGpu) {
    const initDevices = Array.isArray(diagnostics?.initDevices)
      ? diagnostics.initDevices
          .filter((device): device is string => typeof device === 'string')
          .map((device) => device.trim())
          .filter((device) => device.length > 0)
          .filter((device) => isSafeBackendDeviceSelector(device))
      : [];

    return {
      backendPolicy: 'npu',
      gpuLayers: loadedGpuLayers > 0 ? loadedGpuLayers : 0,
      selectedBackendDevices: initDevices.length > 0 ? Array.from(new Set(initDevices)) : null,
    };
  }

  if (backendMode === 'gpu' && actualGpu) {
    return {
      backendPolicy: 'gpu',
      gpuLayers: loadedGpuLayers > 0 ? loadedGpuLayers : 0,
      selectedBackendDevices: null,
    };
  }

  return {
    backendPolicy: 'cpu',
    gpuLayers: 0,
    selectedBackendDevices: null,
  };
}

class InferenceAutotuneService {
  public async runBackendAutotune({
    modelId,
    prompt = 'Write the numbers from 1 to 200, separated by spaces.',
    nPredict = 256,
  }: {
    modelId: string;
    prompt?: string;
    nPredict?: number;
  }): Promise<AutotuneResult> {
    const normalizedModelId = typeof modelId === 'string' ? modelId.trim() : '';
    if (!normalizedModelId) {
      throw new Error('Invalid modelId');
    }

    if (llmEngineService.hasActiveCompletion()) {
      throw new Error('Engine is busy generating a response.');
    }

    const engineState = llmEngineService.getState();
    if (engineState.status === EngineStatus.INITIALIZING) {
      throw new Error('Engine is initializing. Try again in a moment.');
    }

    const previousActiveModelId = engineState.activeModelId ?? null;
    const shouldRestorePreviousModel = engineState.status === EngineStatus.READY && Boolean(previousActiveModelId);
    const restoreLoadParamsOverride = shouldRestorePreviousModel
      ? resolveRestoreLoadParamsOverride(engineState.diagnostics)
      : null;

    let didUnloadPreviousModel = false;

    const persistedModel = registry.getModel(normalizedModelId);
    const modelsDir = getModelsDir();
    const modelFilePath = (modelsDir && typeof persistedModel?.localPath === 'string')
      ? safeJoinModelPath(modelsDir, persistedModel.localPath)
      : null;
    const modelSha256 = typeof persistedModel?.sha256 === 'string' ? persistedModel.sha256 : null;
    let modelFileSizeBytes: number | null = null;
    if (modelFilePath) {
      try {
        const info = await FileSystem.getInfoAsync(modelFilePath);
        if (info.exists && typeof info.size === 'number' && Number.isFinite(info.size) && info.size > 0) {
          modelFileSizeBytes = Math.round(info.size);
        }
      } catch {
        // Ignore: autotune can proceed without an exact model signature.
      }
    }

    if (modelFileSizeBytes === null) {
      const fallbackGgufTotalBytes = typeof persistedModel?.gguf?.totalBytes === 'number'
        && Number.isFinite(persistedModel.gguf.totalBytes)
        && persistedModel.gguf.totalBytes > 0
        ? Math.round(persistedModel.gguf.totalBytes)
        : null;

      if (fallbackGgufTotalBytes !== null) {
        modelFileSizeBytes = fallbackGgufTotalBytes;
      }
    }

    const baseLoadParams = getModelLoadParametersForModel(normalizedModelId);
    const previousAutotuneResult = readAutotuneResult({
      modelId: normalizedModelId,
      contextSize: baseLoadParams.contextSize,
      kvCacheType: baseLoadParams.kvCacheType,
      modelFileSizeBytes,
      modelSha256,
    });
    const { recommendedGpuLayers, gpuLayersCeiling } = await llmEngineService.getRecommendedLoadProfile(normalizedModelId);
    const capabilities = await inferenceBackendService.getCapabilitiesSummary().catch(() => null);
    const gpuAvailable = capabilities?.gpu?.available === true;
    const npuAvailable = capabilities?.npu?.available === true;
    const npuDeviceSelectors = Array.isArray(capabilities?.npu.deviceNames) && capabilities.npu.deviceNames.length > 0
      ? capabilities.npu.deviceNames.filter((device) => isSafeBackendDeviceSelector(device))
      : null;

    const candidateProfiles = resolveAutotuneCandidates({
      recommendedGpuLayers,
      gpuLayersCeiling,
      gpuAvailable,
      npuAvailable,
      npuDeviceSelectors,
    });

    const targetAlreadyLoaded = engineState.status === EngineStatus.READY
      && engineState.activeModelId === normalizedModelId;
    const hasAcceleratorCandidates = candidateProfiles.some((candidate) => candidate.backendMode !== 'cpu');

    // If only CPU is available and the target model is already loaded, avoid unloading/reloading.
    // Some devices crash natively on reload, even for CPU-only models.
    if (targetAlreadyLoaded && !hasAcceleratorCandidates) {
      const cpuProfile: AutotuneBestStableProfile = { backendMode: 'cpu', nGpuLayers: 0 };
      const candidates: AutotuneCandidateReport[] = [];

      try {
        let tokenCount = 0;
        let firstTokenMs: number | null = null;
        const startMs = Date.now();

        await llmEngineService.chatCompletion({
          messages: [{ role: 'user', content: prompt }],
          onToken: () => {
            tokenCount += 1;
            if (firstTokenMs === null) {
              firstTokenMs = Date.now();
            }
          },
          params: {
            temperature: 0,
            top_p: 1,
            n_predict: nPredict,
          },
        });

        const endMs = Date.now();
        const durationMs = Math.max(1, endMs - startMs);
        const tokensPerSec = (tokenCount / durationMs) * 1000;
        const diagnostics = llmEngineService.getState().diagnostics;
        const initGpuLayers = typeof diagnostics?.initGpuLayers === 'number' && Number.isFinite(diagnostics.initGpuLayers)
          ? Math.max(0, Math.round(diagnostics.initGpuLayers))
          : undefined;
        const initDevices = Array.isArray(diagnostics?.initDevices) && diagnostics.initDevices.length > 0
          ? diagnostics.initDevices
          : undefined;

        candidates.push({
          profile: cpuProfile,
          success: true,
          tokensPerSec,
          ttftMs: firstTokenMs !== null ? Math.max(0, firstTokenMs - startMs) : undefined,
          durationMs,
          initGpuLayers,
          initDevices,
          actualBackendMode: diagnostics?.backendMode,
          actualGpuAccelerated: diagnostics?.actualGpuAccelerated,
          loadedGpuLayers: diagnostics?.loadedGpuLayers,
          reasonNoGPU: diagnostics?.reasonNoGPU,
        });
      } catch (error) {
        const diagnostics = llmEngineService.getState().diagnostics;
        const initGpuLayers = typeof diagnostics?.initGpuLayers === 'number' && Number.isFinite(diagnostics.initGpuLayers)
          ? Math.max(0, Math.round(diagnostics.initGpuLayers))
          : undefined;
        const initDevices = Array.isArray(diagnostics?.initDevices) && diagnostics.initDevices.length > 0
          ? diagnostics.initDevices
          : undefined;
        candidates.push({
          profile: cpuProfile,
          success: false,
          initGpuLayers,
          initDevices,
          actualBackendMode: diagnostics?.backendMode,
          actualGpuAccelerated: diagnostics?.actualGpuAccelerated,
          loadedGpuLayers: diagnostics?.loadedGpuLayers,
          reasonNoGPU: diagnostics?.reasonNoGPU,
          error: formatErrorMessage(error),
        });
      }

      const eligible = candidates.filter((candidate) => {
        if (!candidate.success || typeof candidate.tokensPerSec !== 'number' || !Number.isFinite(candidate.tokensPerSec)) {
          return false;
        }
        const actualMode = candidate.actualBackendMode;
        const actualGpu = candidate.actualGpuAccelerated;
        return actualMode === 'cpu' || actualGpu === false;
      });
      const bestCandidate = eligible.reduce<AutotuneCandidateReport | null>((best, current) => {
        if (!best) {
          return current;
        }
        const bestSpeed = best.tokensPerSec ?? 0;
        const currentSpeed = current.tokensPerSec ?? 0;
        return currentSpeed > bestSpeed ? current : best;
      }, null);

      const bestStable: AutotuneBestStableProfile | undefined = bestCandidate
        ? { backendMode: 'cpu', nGpuLayers: 0 }
        : previousAutotuneResult?.bestStable;

      const result: AutotuneResult = {
        createdAtMs: Date.now(),
        modelId: normalizedModelId,
        contextSize: baseLoadParams.contextSize,
        kvCacheType: baseLoadParams.kvCacheType,
        modelFileSizeBytes,
        modelSha256,
        ...(bestStable ? { bestStable } : null),
        candidates,
      };

      writeAutotuneResult(result);
      return result;
    }

    try {
      // Unload only once we're ready to start benchmarking so early failures don't leave the
      // user without their previously loaded model.
      await llmEngineService.unload().catch(() => undefined);
      didUnloadPreviousModel = true;

      const candidates: AutotuneCandidateReport[] = [];

      for (const candidate of candidateProfiles) {
        const loadParamsOverride: Partial<ModelLoadParameters> = {
          backendPolicy: mapBackendModeToPolicy(candidate.backendMode),
          gpuLayers: candidate.backendMode === 'cpu' ? 0 : candidate.nGpuLayers,
          // Ensure benchmarks don't implicitly depend on a persisted device selection.
          selectedBackendDevices: candidate.devices ?? null,
        };

        try {
          await llmEngineService.load(normalizedModelId, {
            forceReload: true,
            allowUnsafeMemoryLoad: false,
            loadParamsOverride,
          });

          let tokenCount = 0;
          let firstTokenMs: number | null = null;
          const startMs = Date.now();

          await llmEngineService.chatCompletion({
            messages: [{ role: 'user', content: prompt }],
            onToken: () => {
              tokenCount += 1;
              if (firstTokenMs === null) {
                firstTokenMs = Date.now();
              }
            },
            params: {
              temperature: 0,
              top_p: 1,
              n_predict: nPredict,
            },
          });

          const endMs = Date.now();
          const durationMs = Math.max(1, endMs - startMs);
          const tokensPerSec = (tokenCount / durationMs) * 1000;
          const diagnostics = llmEngineService.getState().diagnostics;
          const initGpuLayers = typeof diagnostics?.initGpuLayers === 'number' && Number.isFinite(diagnostics.initGpuLayers)
            ? Math.max(0, Math.round(diagnostics.initGpuLayers))
            : undefined;
          const initDevices = Array.isArray(diagnostics?.initDevices) && diagnostics.initDevices.length > 0
            ? diagnostics.initDevices
            : undefined;

          candidates.push({
            profile: candidate,
            success: true,
            tokensPerSec,
            ttftMs: firstTokenMs !== null ? Math.max(0, firstTokenMs - startMs) : undefined,
            durationMs,
            initGpuLayers,
            initDevices,
            actualBackendMode: diagnostics?.backendMode,
            actualGpuAccelerated: diagnostics?.actualGpuAccelerated,
            loadedGpuLayers: diagnostics?.loadedGpuLayers,
            reasonNoGPU: diagnostics?.reasonNoGPU,
          });
        } catch (error) {
          const diagnostics = llmEngineService.getState().diagnostics;
          const initGpuLayers = typeof diagnostics?.initGpuLayers === 'number' && Number.isFinite(diagnostics.initGpuLayers)
            ? Math.max(0, Math.round(diagnostics.initGpuLayers))
            : undefined;
          const initDevices = Array.isArray(diagnostics?.initDevices) && diagnostics.initDevices.length > 0
            ? diagnostics.initDevices
            : undefined;
          candidates.push({
            profile: candidate,
            success: false,
            initGpuLayers,
            initDevices,
            actualBackendMode: diagnostics?.backendMode,
            actualGpuAccelerated: diagnostics?.actualGpuAccelerated,
            loadedGpuLayers: diagnostics?.loadedGpuLayers,
            reasonNoGPU: diagnostics?.reasonNoGPU,
            error: formatErrorMessage(error),
          });
        } finally {
          await llmEngineService.unload().catch(() => undefined);
        }
      }

      const eligible = candidates.filter((candidate) => {
        if (!candidate.success || typeof candidate.tokensPerSec !== 'number' || !Number.isFinite(candidate.tokensPerSec)) {
          return false;
        }
        const actualMode = candidate.actualBackendMode;
        const actualGpu = candidate.actualGpuAccelerated;

        if (candidate.profile.backendMode === 'cpu') {
          return actualMode === 'cpu' || actualGpu === false;
        }

        if (candidate.profile.backendMode === 'gpu') {
          return actualMode === 'gpu' && actualGpu === true;
        }

        if (candidate.profile.backendMode === 'npu') {
          return actualMode === 'npu' && actualGpu === true;
        }

        return false;
      });

      const bestCandidate = eligible.reduce<AutotuneCandidateReport | null>((best, current) => {
        if (!best) {
          return current;
        }
        const bestSpeed = best.tokensPerSec ?? 0;
        const currentSpeed = current.tokensPerSec ?? 0;
        return currentSpeed > bestSpeed ? current : best;
      }, null);

      const bestStable: AutotuneBestStableProfile | undefined = bestCandidate
        ? (() => {
            const backendMode = bestCandidate.profile.backendMode;
            const resolvedGpuLayers = typeof bestCandidate.initGpuLayers === 'number' && Number.isFinite(bestCandidate.initGpuLayers)
              ? Math.max(0, Math.round(bestCandidate.initGpuLayers))
              : Math.max(0, Math.round(bestCandidate.profile.nGpuLayers));

            const initDevices = Array.isArray(bestCandidate.initDevices)
              ? bestCandidate.initDevices.filter((device): device is string => typeof device === 'string')
              : [];
            const profileDevices = Array.isArray(bestCandidate.profile.devices)
              ? bestCandidate.profile.devices.filter((device): device is string => typeof device === 'string')
              : [];

            const resolveDevicesForBestStable = (): string[] | undefined => {
              if (backendMode === 'npu') {
                const initSelectors = initDevices
                  .map((device) => device.trim())
                  .filter((device) => device.length > 0)
                  .filter(isSafeBackendDeviceSelector);
                if (initSelectors.length > 0) {
                  return Array.from(new Set(initSelectors));
                }

                const profileSelectors = profileDevices
                  .map((device) => device.trim())
                  .filter((device) => device.length > 0)
                  .filter(isSafeBackendDeviceSelector);
                if (profileSelectors.length > 0) {
                  return Array.from(new Set(profileSelectors));
                }

                return undefined;
              }

              const initResolved = initDevices.map((device) => device.trim()).filter((device) => device.length > 0);
              if (initResolved.length > 0) {
                return Array.from(new Set(initResolved));
              }

              const profileResolved = profileDevices.map((device) => device.trim()).filter((device) => device.length > 0);
              return profileResolved.length > 0 ? Array.from(new Set(profileResolved)) : undefined;
            };

            const devices = resolveDevicesForBestStable();
            return {
              backendMode,
              nGpuLayers: resolvedGpuLayers,
              ...(devices && devices.length > 0 ? { devices } : null),
            } satisfies AutotuneBestStableProfile;
          })()
        : previousAutotuneResult?.bestStable;

      const result: AutotuneResult = {
        createdAtMs: Date.now(),
        modelId: normalizedModelId,
        contextSize: baseLoadParams.contextSize,
        kvCacheType: baseLoadParams.kvCacheType,
        modelFileSizeBytes,
        modelSha256,
        ...(bestStable ? { bestStable } : null),
        candidates,
      };

      writeAutotuneResult(result);
      return result;
    } finally {
      if (shouldRestorePreviousModel && previousActiveModelId && didUnloadPreviousModel) {
        await llmEngineService.load(previousActiveModelId, {
          forceReload: true,
          ...(restoreLoadParamsOverride ? { loadParamsOverride: restoreLoadParamsOverride } : null),
        }).catch(() => undefined);
      }
    }
  }
}

export const inferenceAutotuneService = new InferenceAutotuneService();
