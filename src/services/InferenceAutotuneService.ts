import { llmEngineService } from './LLMEngineService';
import { inferenceBackendService } from './InferenceBackendService';
import {
  getModelLoadParametersForModel,
  isSafeBackendDeviceSelector,
  MAX_BACKEND_DEVICE_SELECTORS,
  type ModelLoadParameters,
} from './SettingsStore';
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

export type AutotuneProgressStage =
  | 'preparing'
  | 'cancelling'
  | 'unloadingPrevious'
  | 'loadingCandidate'
  | 'benchmarkingCandidate'
  | 'unloadingCandidate'
  | 'saving'
  | 'restoringPrevious'
  | 'cancelled'
  | 'done';

export interface AutotuneProgressSnapshot {
  stage: AutotuneProgressStage;
  step: number;
  totalSteps: number;
  candidate?: AutotuneBestStableProfile;
  candidateIndex?: number;
  candidateCount?: number;
}

function resolveAutotuneCandidates({
  recommendedGpuLayers,
  gpuLayersCeiling,
  gpuAttemptable,
  npuAttemptable,
  npuDeviceSelectors,
}: {
  recommendedGpuLayers: number;
  gpuLayersCeiling: number;
  gpuAttemptable: boolean;
  npuAttemptable: boolean;
  npuDeviceSelectors?: string[] | null;
}): AutotuneBestStableProfile[] {
  const ceiling = Math.max(0, Math.round(gpuLayersCeiling));
  const recommended = Math.max(0, Math.min(ceiling, Math.round(recommendedGpuLayers)));

  const candidates: AutotuneBestStableProfile[] = [{ backendMode: 'cpu', nGpuLayers: 0 }];

  if (recommended <= 0) {
    return candidates;
  }

  // Avoid attempting GPU profiles unless backend discovery has confirmed the GPU path is available.
  if (gpuAttemptable) {
    candidates.push({ backendMode: 'gpu', nGpuLayers: recommended });
  }

  if (npuAttemptable) {
    const resolvedSelectors = Array.isArray(npuDeviceSelectors)
      ? npuDeviceSelectors
          .map((device) => (typeof device === 'string' ? device.trim() : ''))
          .filter(isSafeBackendDeviceSelector)
      : [];

    const dedupedSelectors = Array.from(new Set(resolvedSelectors)).slice(0, MAX_BACKEND_DEVICE_SELECTORS);
    candidates.push({
      backendMode: 'npu',
      nGpuLayers: recommended,
      devices: dedupedSelectors.length > 0 ? dedupedSelectors : ['HTP*'],
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
          .map((device) => (typeof device === 'string' ? device.trim() : ''))
          .filter(isSafeBackendDeviceSelector)
      : [];

    const dedupedInitDevices = Array.from(new Set(initDevices)).slice(0, MAX_BACKEND_DEVICE_SELECTORS);
    return {
      backendPolicy: 'npu',
      gpuLayers: loadedGpuLayers > 0 ? loadedGpuLayers : 0,
      selectedBackendDevices: dedupedInitDevices.length > 0 ? dedupedInitDevices : null,
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
    onProgress,
    signal,
  }: {
    modelId: string;
    prompt?: string;
    nPredict?: number;
    onProgress?: (snapshot: AutotuneProgressSnapshot) => void;
    signal?: AbortSignal;
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

    let cancelled = signal?.aborted === true;
    let progressStep = 0;
    let progressTotalSteps = 0;
    const emitProgress = (snapshot: Omit<AutotuneProgressSnapshot, 'step' | 'totalSteps'>) => {
      if (!onProgress) {
        return;
      }

      onProgress({
        ...snapshot,
        step: progressStep,
        totalSteps: progressTotalSteps,
      });
    };
    const advanceProgress = () => {
      progressStep = Math.min(progressTotalSteps, progressStep + 1);
    };

    const advanceAndEmit = (snapshot: Omit<AutotuneProgressSnapshot, 'step' | 'totalSteps'>) => {
      advanceProgress();
      emitProgress(snapshot);
    };

    const finishAndEmit = (snapshot: Omit<AutotuneProgressSnapshot, 'step' | 'totalSteps'>) => {
      if (progressTotalSteps > 0) {
        progressStep = progressTotalSteps;
      }
      emitProgress(snapshot);
    };

    const handleAbort = () => {
      if (cancelled) {
        return;
      }

      cancelled = true;
      if (progressTotalSteps <= 0) {
        progressTotalSteps = 1;
      }
      emitProgress({ stage: 'cancelling' });

      // Abort can be delivered at any time; never allow a synchronous throw to crash the caller.
      try {
        void Promise
          .resolve()
          .then(() => llmEngineService.interruptActiveCompletion())
          .catch(() => undefined);
      } catch {
        // ignore
      }
    };

    let removeAbortListener: (() => void) | null = null;
    if (signal && typeof signal.addEventListener === 'function' && typeof signal.removeEventListener === 'function') {
      try {
        signal.addEventListener('abort', handleAbort);
        removeAbortListener = () => {
          try {
            signal.removeEventListener('abort', handleAbort);
          } catch {
            // ignore
          }
        };
      } catch {
        // ignore
      }
    }

    try {
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
      const capabilitiesKnown = Boolean(capabilities && capabilities.discoveryUnavailable !== true);
      const gpuAvailable = capabilities?.gpu?.available === true;
      const npuAvailable = capabilities?.npu?.available === true;
      // Compatibility rule: only attempt accelerators when discovery marks them available.
      // Do not attempt based on model/SOC heuristics here.
      const gpuAttemptable = gpuAvailable;
      const npuAttemptable = npuAvailable;
      const npuDeviceSelectors = Array.isArray(capabilities?.npu.deviceNames) && capabilities.npu.deviceNames.length > 0
        ? capabilities.npu.deviceNames.filter((device) => isSafeBackendDeviceSelector(device))
        : null;

      const candidateProfiles = resolveAutotuneCandidates({
        recommendedGpuLayers,
        gpuLayersCeiling,
        gpuAttemptable,
        npuAttemptable,
        npuDeviceSelectors,
      });

    const targetAlreadyLoaded = engineState.status === EngineStatus.READY
      && engineState.activeModelId === normalizedModelId;
    const hasAcceleratorCandidates = candidateProfiles.some((candidate) => candidate.backendMode !== 'cpu');
    const candidateCount = candidateProfiles.length;
    const willRestorePreviousModel = shouldRestorePreviousModel && Boolean(previousActiveModelId);
    const willBenchmarkInPlace = targetAlreadyLoaded && !hasAcceleratorCandidates;

    // step counts completed stages (1..totalSteps). Terminal stages set step=totalSteps.
    progressTotalSteps = willBenchmarkInPlace
      ? 3 // preparing + benchmark + saving
      : (
        // preparing + unload previous + (load/bench/unload per candidate) + save + optional restore.
        1
        + 1
        + (candidateCount * 3)
        + 1
        + (willRestorePreviousModel ? 1 : 0)
      );
    advanceAndEmit({ stage: 'preparing' });

    if (cancelled) {
      const result: AutotuneResult = {
        createdAtMs: Date.now(),
        modelId: normalizedModelId,
        contextSize: baseLoadParams.contextSize,
        kvCacheType: baseLoadParams.kvCacheType,
        modelFileSizeBytes,
        modelSha256,
        backendDiscoveryKnown: capabilitiesKnown,
        ...(previousAutotuneResult?.bestStable ? { bestStable: previousAutotuneResult.bestStable } : null),
        candidates: [],
        cancelled: true,
      };

      finishAndEmit({ stage: 'cancelled' });
      return result;
    }

    // If only CPU is available and the target model is already loaded, avoid unloading/reloading.
    // Some devices crash natively on reload, even for CPU-only models.
    if (targetAlreadyLoaded && !hasAcceleratorCandidates) {
      advanceAndEmit({
        stage: 'benchmarkingCandidate',
        candidate: { backendMode: 'cpu', nGpuLayers: 0 },
        candidateIndex: 1,
        candidateCount: 1,
      });
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
          error: cancelled ? 'Cancelled' : formatErrorMessage(error),
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

      const acceleratorCandidate = candidates.find((candidate) => {
        if (!candidate.success || typeof candidate.tokensPerSec !== 'number' || !Number.isFinite(candidate.tokensPerSec)) {
          return false;
        }
        const actualMode = candidate.actualBackendMode;
        const actualGpu = candidate.actualGpuAccelerated === true;
        return actualGpu && (actualMode === 'gpu' || actualMode === 'npu');
      }) ?? null;

      // A CPU-only run during transient backend discovery failures should not overwrite the
      // stored Auto preference for later loads on accelerator-capable devices.
      const bestStable: AutotuneBestStableProfile | undefined = bestCandidate
        ? capabilitiesKnown
          ? { backendMode: 'cpu', nGpuLayers: 0 }
          : previousAutotuneResult?.bestStable
        : acceleratorCandidate
          ? (() => {
              const backendMode = acceleratorCandidate.actualBackendMode === 'npu' ? 'npu' : 'gpu';
              const resolvedGpuLayers = typeof acceleratorCandidate.initGpuLayers === 'number' && Number.isFinite(acceleratorCandidate.initGpuLayers)
                ? Math.max(0, Math.round(acceleratorCandidate.initGpuLayers))
                : 0;

              if (backendMode !== 'npu') {
                return { backendMode, nGpuLayers: resolvedGpuLayers };
              }

              const initDevices = Array.isArray(acceleratorCandidate.initDevices)
                ? acceleratorCandidate.initDevices
                    .map((device) => (typeof device === 'string' ? device.trim() : ''))
                    .filter(isSafeBackendDeviceSelector)
                : [];
              const dedupedInitDevices = Array.from(new Set(initDevices)).slice(0, MAX_BACKEND_DEVICE_SELECTORS);

              return {
                backendMode: 'npu',
                nGpuLayers: resolvedGpuLayers,
                ...(dedupedInitDevices.length > 0 ? { devices: dedupedInitDevices } : null),
              };
            })()
          : previousAutotuneResult?.bestStable;

      const result: AutotuneResult = {
        createdAtMs: Date.now(),
        modelId: normalizedModelId,
        contextSize: baseLoadParams.contextSize,
        kvCacheType: baseLoadParams.kvCacheType,
        modelFileSizeBytes,
        modelSha256,
        backendDiscoveryKnown: capabilitiesKnown,
        ...(bestStable ? { bestStable } : null),
        candidates,
      };

      if (cancelled) {
        result.cancelled = true;
      }

      if (!cancelled) {
        advanceAndEmit({ stage: 'saving' });
        writeAutotuneResult(result);
        finishAndEmit({ stage: 'done' });
      } else {
        finishAndEmit({ stage: 'cancelled' });
      }
      return result;
    }

    let result: AutotuneResult | null = null;

    try {
      advanceAndEmit({ stage: 'unloadingPrevious' });
      // Unload only once we're ready to start benchmarking so early failures don't leave the
      // user without their previously loaded model.
      await llmEngineService.unload().catch(() => undefined);
      didUnloadPreviousModel = true;

      const candidates: AutotuneCandidateReport[] = [];

      for (const candidate of candidateProfiles) {
        if (cancelled) {
          break;
        }

        advanceAndEmit({
          stage: 'loadingCandidate',
          candidate,
          candidateIndex: candidates.length + 1,
          candidateCount,
        });
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

          if (cancelled) {
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
              error: 'Cancelled',
            });
            break;
          }

          advanceAndEmit({
            stage: 'benchmarkingCandidate',
            candidate,
            candidateIndex: candidates.length + 1,
            candidateCount,
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
            error: cancelled ? 'Cancelled' : formatErrorMessage(error),
          });
        } finally {
          advanceAndEmit({
            stage: 'unloadingCandidate',
            candidate,
            candidateIndex: candidates.length,
            candidateCount,
          });
          await llmEngineService.unload().catch(() => undefined);
        }

        if (cancelled) {
          break;
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

      const promotedBestCandidate = bestCandidate !== null && (
        bestCandidate.profile.backendMode !== 'cpu' || capabilitiesKnown
      )
        ? bestCandidate
        : null;
      const bestStable: AutotuneBestStableProfile | undefined = promotedBestCandidate
        ? (() => {
            const backendMode = promotedBestCandidate.profile.backendMode;
            const resolvedGpuLayers = typeof promotedBestCandidate.initGpuLayers === 'number' && Number.isFinite(promotedBestCandidate.initGpuLayers)
              ? Math.max(0, Math.round(promotedBestCandidate.initGpuLayers))
              : Math.max(0, Math.round(promotedBestCandidate.profile.nGpuLayers));

            const initDevices = Array.isArray(promotedBestCandidate.initDevices)
              ? promotedBestCandidate.initDevices.filter((device): device is string => typeof device === 'string')
              : [];
            const profileDevices = Array.isArray(promotedBestCandidate.profile.devices)
              ? promotedBestCandidate.profile.devices.filter((device): device is string => typeof device === 'string')
              : [];

            const capDevices = (values: string[]): string[] =>
              Array.from(new Set(values)).slice(0, MAX_BACKEND_DEVICE_SELECTORS);

            const resolveDevicesForBestStable = (): string[] | undefined => {
              if (backendMode === 'npu') {
                const initSelectors = initDevices
                  .map((device) => device.trim())
                  .filter(isSafeBackendDeviceSelector);
                if (initSelectors.length > 0) {
                  return capDevices(initSelectors);
                }

                const profileSelectors = profileDevices
                  .map((device) => device.trim())
                  .filter(isSafeBackendDeviceSelector);
                if (profileSelectors.length > 0) {
                  return capDevices(profileSelectors);
                }

                return undefined;
              }

              const initResolved = initDevices.map((device) => device.trim()).filter((device) => device.length > 0);
              if (initResolved.length > 0) {
                return capDevices(initResolved);
              }

              const profileResolved = profileDevices.map((device) => device.trim()).filter((device) => device.length > 0);
              return profileResolved.length > 0 ? capDevices(profileResolved) : undefined;
            };

            const devices = resolveDevicesForBestStable();
            return {
              backendMode,
              nGpuLayers: resolvedGpuLayers,
              ...(devices && devices.length > 0 ? { devices } : null),
            } satisfies AutotuneBestStableProfile;
          })()
        : previousAutotuneResult?.bestStable;

      result = {
        createdAtMs: Date.now(),
        modelId: normalizedModelId,
        contextSize: baseLoadParams.contextSize,
        kvCacheType: baseLoadParams.kvCacheType,
        modelFileSizeBytes,
        modelSha256,
        backendDiscoveryKnown: capabilitiesKnown,
        ...(bestStable ? { bestStable } : null),
        candidates,
      };

      if (cancelled) {
        result.cancelled = true;
      }

      if (!cancelled) {
        advanceAndEmit({ stage: 'saving' });
        writeAutotuneResult(result);
      }

      if (!willRestorePreviousModel) {
        finishAndEmit({ stage: cancelled ? 'cancelled' : 'done' });
      }
      return result;
    } finally {
      if (shouldRestorePreviousModel && previousActiveModelId && didUnloadPreviousModel) {
        advanceAndEmit({ stage: 'restoringPrevious' });
        try {
          await llmEngineService.load(previousActiveModelId, {
            forceReload: true,
            ...(restoreLoadParamsOverride ? { loadParamsOverride: restoreLoadParamsOverride } : null),
          });
        } catch (restoreError) {
          const message = formatErrorMessage(restoreError);
          console.warn('[InferenceAutotune] Failed to restore previously loaded model', restoreError);

          // Best-effort safety: avoid leaving the app in a broken state.
          // Prefer keeping a working model loaded when possible, but if we're cancelled
          // or the engine isn't READY, attempt to unload any candidate that may be active.
          const stateAfterRestoreFailure = llmEngineService.getState();
          const activeModelId = stateAfterRestoreFailure.activeModelId ?? null;
          const shouldAttemptUnload = cancelled || stateAfterRestoreFailure.status !== EngineStatus.READY;
          if (shouldAttemptUnload && activeModelId && activeModelId !== previousActiveModelId) {
            try {
              await llmEngineService.unload().catch(() => undefined);
            } catch {
              // ignore
            }
          }
          if (result) {
            result.restorationError = message;
          }
        } finally {
          finishAndEmit({ stage: cancelled ? 'cancelled' : 'done' });
        }
      }
    }
    } finally {
      removeAbortListener?.();
    }
  }
}

export const inferenceAutotuneService = new InferenceAutotuneService();
