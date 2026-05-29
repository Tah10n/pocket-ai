import { create } from 'zustand';
import { persist, createJSONStorage, subscribeWithSelector } from 'zustand/middleware';
import { mmkvStorage } from '../lib/mmkv';
import { ModelMetadata, LifecycleStatus } from '../types/models';
import { normalizePersistedModelMetadata } from '../services/ModelMetadataNormalizer';
import { getCandidateModelDownloadFileNames, getCandidateProjectorDownloadFileNames } from '../utils/modelFiles';
import { isValidLocalFileName } from '../utils/safeFilePath';
import { mergeProjectorCandidatesWithRuntimeStateAndIdMap } from '../utils/projectorRuntimeState';
import { createInstrumentedStateStorage } from './persistStateStorage';
import { assertPrivateStorageWritable } from '../services/storage';

const downloadStoreStateStorage = createInstrumentedStateStorage(mmkvStorage, { scope: 'downloadStore', dedupe: true });

function normalizeComparableString(value: string | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeComparableSha256(value: string | undefined): string | undefined {
  return normalizeComparableString(value)?.toLowerCase();
}

function normalizeComparableSize(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined;
}

function hasCompatibleQueuedFileIdentity(existing: ModelMetadata, model: ModelMetadata): boolean {
  const fileIdentityComparisons: [string | undefined, string | undefined][] = [
    [normalizeComparableString(existing.resolvedFileName), normalizeComparableString(model.resolvedFileName)],
    [normalizeComparableString(existing.downloadUrl), normalizeComparableString(model.downloadUrl)],
    [normalizeComparableSha256(existing.sha256), normalizeComparableSha256(model.sha256)],
  ];
  const revisionComparison: [string | undefined, string | undefined] = [
    normalizeComparableString(existing.hfRevision),
    normalizeComparableString(model.hfRevision),
  ];

  if ([...fileIdentityComparisons, revisionComparison].some(([existingValue, nextValue]) => (
    existingValue !== undefined && nextValue !== undefined && existingValue !== nextValue
  ))) {
    return false;
  }

  const existingSize = normalizeComparableSize(existing.size);
  const nextSize = normalizeComparableSize(model.size);
  if (existingSize !== undefined && nextSize !== undefined && existingSize !== nextSize) {
    return false;
  }

  const hasMatchingFileIdentity = fileIdentityComparisons.some(([existingValue, nextValue]) => (
    existingValue !== undefined && existingValue === nextValue
  ));
  if (hasMatchingFileIdentity) {
    return true;
  }

  const hasVariantDifferentiatingField = fileIdentityComparisons.some(([existingValue, nextValue]) => (
    existingValue !== undefined || nextValue !== undefined
  ));
  return !hasVariantDifferentiatingField
    && existingSize !== undefined
    && nextSize !== undefined;
}

function resolveMergedSelectedProjectorId(
  nextSelectedProjectorId: string | undefined,
  existingSelectedProjectorId: string | undefined,
  candidateIds: Set<string>,
  existingToNextProjectorIds: Map<string, string>,
  blockedExistingProjectorIds: Set<string> = new Set(),
  blockedNextProjectorIds: Set<string> = blockedExistingProjectorIds,
): string | undefined {
  if (nextSelectedProjectorId && candidateIds.has(nextSelectedProjectorId)) {
    return nextSelectedProjectorId;
  }

  if (!existingSelectedProjectorId) {
    return undefined;
  }

  if (blockedExistingProjectorIds.has(existingSelectedProjectorId)) {
    return undefined;
  }

  const selectedProjectorId = existingToNextProjectorIds.get(existingSelectedProjectorId)
    ?? existingSelectedProjectorId;
  if (blockedNextProjectorIds.has(selectedProjectorId)) {
    return undefined;
  }

  return candidateIds.has(selectedProjectorId) ? selectedProjectorId : undefined;
}

function remapMultimodalReadiness(
  modelId: string,
  readiness: ModelMetadata['multimodalReadiness'],
  candidateIds: Set<string>,
  existingToNextProjectorIds: Map<string, string>,
  selectedProjectorId: string | undefined,
  blockedSourceProjectorIds: Set<string> = new Set(),
  blockedResolvedProjectorIds: Set<string> = blockedSourceProjectorIds,
): ModelMetadata['multimodalReadiness'] {
  if (!readiness || readiness.modelId !== modelId) {
    return undefined;
  }

  if (!readiness.projectorId) {
    return readiness;
  }

  if (blockedSourceProjectorIds.has(readiness.projectorId)) {
    return undefined;
  }

  const projectorId = existingToNextProjectorIds.get(readiness.projectorId)
    ?? readiness.projectorId;

  if (blockedResolvedProjectorIds.has(projectorId)) {
    return undefined;
  }

  if (!candidateIds.has(projectorId)) {
    return undefined;
  }

  if (selectedProjectorId && projectorId !== selectedProjectorId) {
    return undefined;
  }

  return projectorId === readiness.projectorId
    ? readiness
    : { ...readiness, projectorId };
}

function buildRetryableQueueEntry(existing: ModelMetadata, model: ModelMetadata): ModelMetadata {
  const canPreserveResumeState = hasCompatibleQueuedFileIdentity(existing, model);
  const projectorRuntimeMerge = canPreserveResumeState
    ? mergeProjectorCandidatesWithRuntimeStateAndIdMap(model.projectorCandidates, existing.projectorCandidates)
    : {
      projectorCandidates: model.projectorCandidates,
      runtimeToNextProjectorIds: new Map<string, string>(),
      blockedRuntimeProjectorIds: new Set<string>(),
      blockedNextProjectorIds: new Set<string>(),
      blockedRuntimeReadinessProjectorIds: new Set<string>(),
      blockedNextReadinessProjectorIds: new Set<string>(),
    };
  const projectorCandidates = projectorRuntimeMerge.projectorCandidates;
  const candidateIds = new Set((projectorCandidates ?? []).map((projector) => projector.id));
  const blockedNextReadinessProjectorIds = new Set<string>([
    ...projectorRuntimeMerge.blockedNextReadinessProjectorIds,
    ...projectorRuntimeMerge.blockedNextProjectorIds,
  ]);
  const blockedExistingReadinessProjectorIds = new Set<string>([
    ...projectorRuntimeMerge.blockedRuntimeReadinessProjectorIds,
    ...projectorRuntimeMerge.blockedRuntimeProjectorIds,
  ]);
  const blockedExistingResolvedReadinessProjectorIds = new Set(blockedNextReadinessProjectorIds);
  const selectedProjectorId = canPreserveResumeState
    ? resolveMergedSelectedProjectorId(
      model.selectedProjectorId,
      existing.selectedProjectorId,
      candidateIds,
      projectorRuntimeMerge.runtimeToNextProjectorIds,
      projectorRuntimeMerge.blockedRuntimeProjectorIds,
      projectorRuntimeMerge.blockedNextProjectorIds,
    )
    : model.selectedProjectorId;
  const multimodalReadiness = canPreserveResumeState
    ? remapMultimodalReadiness(
      model.id,
      model.multimodalReadiness,
      candidateIds,
      projectorRuntimeMerge.runtimeToNextProjectorIds,
      selectedProjectorId,
      blockedNextReadinessProjectorIds,
      blockedNextReadinessProjectorIds,
    ) ?? remapMultimodalReadiness(
      model.id,
      existing.multimodalReadiness,
      candidateIds,
      projectorRuntimeMerge.runtimeToNextProjectorIds,
      selectedProjectorId,
      blockedExistingReadinessProjectorIds,
      blockedExistingResolvedReadinessProjectorIds,
    )
    : model.multimodalReadiness;
  const retryableBaseModel = canPreserveResumeState
    ? { ...existing, ...model }
    : model;

  return normalizePersistedModelMetadata({
    ...retryableBaseModel,
    resumeData: canPreserveResumeState ? existing.resumeData : undefined,
    downloadProgress: canPreserveResumeState ? existing.downloadProgress : 0,
    localPath: canPreserveResumeState ? existing.localPath ?? model.localPath : model.localPath,
    downloadIntegrity: canPreserveResumeState
      ? model.downloadIntegrity ?? existing.downloadIntegrity
      : model.downloadIntegrity,
    allowUnknownSizeDownload: canPreserveResumeState
      ? existing.allowUnknownSizeDownload === true || model.allowUnknownSizeDownload === true
      : model.allowUnknownSizeDownload === true,
    projectorCandidates,
    selectedProjectorId,
    multimodalReadiness,
    lifecycleStatus: LifecycleStatus.QUEUED,
    downloadErrorAt: undefined,
    downloadErrorCode: undefined,
    downloadErrorMessage: undefined,
  });
}

function getQueuedProjectorFileNames(model: ModelMetadata): string[] {
  return (model.projectorCandidates ?? []).flatMap((projector) => [
    ...(projector.localPath && isValidLocalFileName(projector.localPath) ? [projector.localPath] : []),
    ...getCandidateProjectorDownloadFileNames(projector),
  ]);
}

interface DownloadState {
  queue: ModelMetadata[];
  activeDownloadId: string | null;
  
  addToQueue: (model: ModelMetadata) => void;
  removeFromQueue: (modelId: string) => void;
  setActiveDownload: (modelId: string | null) => void;
  updateModelInQueue: (modelId: string, updates: Partial<ModelMetadata>) => void;
}

export function normalizePersistedDownloadQueue(queue: ModelMetadata[]): ModelMetadata[] {
  return queue.map((model) => {
    const normalizedModel = normalizePersistedModelMetadata(model);
    if (
      normalizedModel.lifecycleStatus === LifecycleStatus.DOWNLOADING ||
      normalizedModel.lifecycleStatus === LifecycleStatus.VERIFYING
    ) {
      return {
        ...normalizedModel,
        lifecycleStatus: LifecycleStatus.QUEUED,
      };
    }

    return normalizedModel;
  });
}

export const useDownloadStore = create<DownloadState>()(
  subscribeWithSelector(
    persist(
      (set) => {
        const setWhenPrivateStorageWritable: typeof set = (partial, replace) => {
          assertPrivateStorageWritable();
          return (set as any)(partial, replace);
        };

        return {
          queue: [],
          activeDownloadId: null,

          addToQueue: (model) => setWhenPrivateStorageWritable((state) => {
          const existing = state.queue.find((queued) => queued.id === model.id);

          if (!existing) {
            return {
              queue: [
                ...state.queue,
                normalizePersistedModelMetadata({
                  ...model,
                  lifecycleStatus: LifecycleStatus.QUEUED,
                }),
              ],
            };
          }

          if (
            existing.lifecycleStatus === LifecycleStatus.PAUSED
            || existing.lifecycleStatus === LifecycleStatus.FAILED
          ) {
            const nextEntry = buildRetryableQueueEntry(existing, model);

            return {
              queue: state.queue.map((queued) => queued.id === model.id ? nextEntry : queued),
            };
          }

          if (
            existing.lifecycleStatus === LifecycleStatus.QUEUED
            || existing.lifecycleStatus === LifecycleStatus.DOWNLOADING
            || existing.lifecycleStatus === LifecycleStatus.VERIFYING
          ) {
            return state;
          }

          // Legacy queues may still contain a retryable entry stored as AVAILABLE.
          // Re-queue it only when the user explicitly taps Download again.
          if (existing.lifecycleStatus === LifecycleStatus.AVAILABLE) {
            const nextEntry = buildRetryableQueueEntry(existing, model);

            return {
              queue: state.queue.map((queued) => queued.id === model.id ? nextEntry : queued),
            };
          }

          return state;
          }),

          removeFromQueue: (modelId) => setWhenPrivateStorageWritable((state) => ({
          queue: state.queue.filter(m => m.id !== modelId),
          activeDownloadId: state.activeDownloadId === modelId ? null : state.activeDownloadId
          })),

          setActiveDownload: (modelId) => setWhenPrivateStorageWritable({ activeDownloadId: modelId }),

          updateModelInQueue: (modelId, updates) => setWhenPrivateStorageWritable((state) => ({
          queue: state.queue.map((model) => (
            model.id === modelId
              ? normalizePersistedModelMetadata({ ...model, ...updates })
              : model
          )),
          })),
        };
      },
      {
        name: 'download-queue-storage',
        skipHydration: true,
        storage: createJSONStorage(() => downloadStoreStateStorage),
        // Do NOT persist activeDownloadId — after a restart, no real download is running.
        // Persisting it would leave the UI in a permanent "downloading" spinner state.
        // Avoid persisting volatile progress updates so downloads don't spam MMKV writes.
        partialize: (state) => ({
          queue: state.queue.map((model) => {
            const shouldZeroProgress = model.lifecycleStatus === LifecycleStatus.DOWNLOADING
              || model.lifecycleStatus === LifecycleStatus.VERIFYING;

            return {
              ...model,
              downloadProgress: shouldZeroProgress ? 0 : model.downloadProgress,
            };
          }),
        }),
        onRehydrateStorage: () => (state) => {
          if (!state) {
            return;
          }

          state.activeDownloadId = null;
          state.queue = normalizePersistedDownloadQueue(state.queue);
        },
      }
    )
  )
);

export function getQueuedDownloadFileNames(): string[] {
  return Array.from(new Set(
    useDownloadStore
      .getState()
      .queue
      .flatMap((model) => [
        ...(model.localPath && isValidLocalFileName(model.localPath) ? [model.localPath] : []),
        ...getCandidateModelDownloadFileNames(model),
        ...getQueuedProjectorFileNames(model),
      ]),
  ));
}

export function resetDownloadStoreForPrivateStorageReset(): void {
  useDownloadStore.setState({
    queue: [],
    activeDownloadId: null,
  });
  void useDownloadStore.persist.clearStorage();
}
