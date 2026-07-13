import { create } from 'zustand';
import { persist, createJSONStorage, subscribeWithSelector } from 'zustand/middleware';
import { mmkvStorage } from '../lib/mmkv';
import { ModelMetadata, LifecycleStatus } from '../types/models';
import type { ProjectorArtifact } from '../types/multimodal';
import { normalizePersistedModelMetadata } from '../services/ModelMetadataNormalizer';
import { getCandidateModelDownloadFileNames, getCandidateProjectorDownloadFileNames } from '../utils/modelFiles';
import { isValidLocalFileName } from '../utils/safeFilePath';
import { mergeProjectorCandidatesWithRuntimeStateAndIdMap } from '../utils/projectorRuntimeState';
import {
  getEffectiveActiveVariantKeys,
  getEffectiveActiveVariantProjectorCandidates,
  getEffectiveActiveVariantSelectedProjectorId,
  hasExplicitEffectiveActiveVariantProjectorCandidates,
  remapProjectorIdToEffectiveCandidate,
} from '../utils/modelCapabilities';
import {
  applyEffectiveProjectorState,
  getAllModelProjectorCandidates,
  mapModelProjectorCandidates,
} from '../utils/effectiveProjectorState';
import { normalizeDownloadResumeData } from '../utils/downloadResumeData';
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
  const blockedIncomingSelectedProjectorId = nextSelectedProjectorId
    && candidateIds.has(nextSelectedProjectorId)
    && blockedNextProjectorIds.has(nextSelectedProjectorId)
    ? nextSelectedProjectorId
    : undefined;

  if (
    nextSelectedProjectorId
    && candidateIds.has(nextSelectedProjectorId)
    && !blockedIncomingSelectedProjectorId
  ) {
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

  if (blockedIncomingSelectedProjectorId) {
    return selectedProjectorId === blockedIncomingSelectedProjectorId
      && existingSelectedProjectorId !== selectedProjectorId
      && candidateIds.has(selectedProjectorId)
      ? selectedProjectorId
      : undefined;
  }

  if (blockedNextProjectorIds.has(selectedProjectorId)) {
    return undefined;
  }

  return candidateIds.has(selectedProjectorId) ? selectedProjectorId : undefined;
}

function shouldSuppressReadinessForBlockedIncomingProjector(
  nextSelectedProjectorId: string | undefined,
  selectedProjectorId: string | undefined,
  candidateIds: Set<string>,
  blockedNextProjectorIds: Set<string>,
): boolean {
  return Boolean(
    nextSelectedProjectorId
    && candidateIds.has(nextSelectedProjectorId)
    && blockedNextProjectorIds.has(nextSelectedProjectorId)
    && selectedProjectorId !== nextSelectedProjectorId,
  );
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

function getEffectiveMultimodalReadiness(
  model: ModelMetadata,
  projectorCandidates: ProjectorArtifact[],
): ModelMetadata['multimodalReadiness'] {
  const readiness = model.multimodalReadiness;
  if (!readiness?.projectorId) {
    return readiness;
  }

  const projectorId = remapProjectorIdToEffectiveCandidate(
    model,
    readiness.projectorId,
    projectorCandidates,
  );
  return projectorId && projectorId !== readiness.projectorId
    ? { ...readiness, projectorId }
    : readiness;
}

function buildRetryableQueueEntry(existing: ModelMetadata, model: ModelMetadata): ModelMetadata {
  const canPreserveResumeState = hasCompatibleQueuedFileIdentity(existing, model);
  const incomingActiveVariantIds = getEffectiveActiveVariantKeys(model);
  const activeProjectorVariantIds = incomingActiveVariantIds.size > 0
    ? incomingActiveVariantIds
    : getEffectiveActiveVariantKeys(existing);
  const nextProjectorCandidates = getEffectiveActiveVariantProjectorCandidates(model);
  const existingProjectorCandidates = getEffectiveActiveVariantProjectorCandidates(existing);
  const projectorRuntimeMerge = canPreserveResumeState
    ? mergeProjectorCandidatesWithRuntimeStateAndIdMap(nextProjectorCandidates, existingProjectorCandidates, {
      activeVariantIds: activeProjectorVariantIds,
      emptyNextProjectorsAreAuthoritative: hasExplicitEffectiveActiveVariantProjectorCandidates(model),
    })
    : {
      projectorCandidates: nextProjectorCandidates,
      runtimeToNextProjectorIds: new Map<string, string>(),
      blockedRuntimeProjectorIds: new Set<string>(),
      blockedNextProjectorIds: new Set<string>(),
      blockedRuntimeReadinessProjectorIds: new Set<string>(),
      blockedNextReadinessProjectorIds: new Set<string>(),
    };
  const projectorCandidates = normalizePersistedProjectorDownloadStates(
    projectorRuntimeMerge.projectorCandidates,
  );
  const candidateIds = new Set((projectorCandidates ?? []).map((projector) => projector.id));
  const blockedNextReadinessProjectorIds = new Set<string>([
    ...projectorRuntimeMerge.blockedNextReadinessProjectorIds,
    ...projectorRuntimeMerge.blockedNextProjectorIds,
  ]);
  const blockedExistingReadinessProjectorIds = new Set<string>([
    ...projectorRuntimeMerge.blockedRuntimeReadinessProjectorIds,
    ...projectorRuntimeMerge.blockedRuntimeProjectorIds,
  ]);
  const blockedExistingResolvedReadinessProjectorIds = new Set(
    projectorRuntimeMerge.blockedNextReadinessProjectorIds,
  );
  const selectedProjectorId = canPreserveResumeState
    ? resolveMergedSelectedProjectorId(
      getEffectiveActiveVariantSelectedProjectorId(model, nextProjectorCandidates),
      getEffectiveActiveVariantSelectedProjectorId(existing, existingProjectorCandidates),
      candidateIds,
      projectorRuntimeMerge.runtimeToNextProjectorIds,
      projectorRuntimeMerge.blockedRuntimeProjectorIds,
      projectorRuntimeMerge.blockedNextProjectorIds,
    )
    : getEffectiveActiveVariantSelectedProjectorId(model, nextProjectorCandidates);
  const shouldSuppressMultimodalReadiness = canPreserveResumeState
    && shouldSuppressReadinessForBlockedIncomingProjector(
      getEffectiveActiveVariantSelectedProjectorId(model, nextProjectorCandidates),
      selectedProjectorId,
      candidateIds,
      projectorRuntimeMerge.blockedNextProjectorIds,
    );
  const multimodalReadiness = canPreserveResumeState
    ? shouldSuppressMultimodalReadiness
      ? undefined
      : remapMultimodalReadiness(
        model.id,
        getEffectiveMultimodalReadiness(model, nextProjectorCandidates),
        candidateIds,
        projectorRuntimeMerge.runtimeToNextProjectorIds,
        selectedProjectorId,
        blockedNextReadinessProjectorIds,
        blockedNextReadinessProjectorIds,
      ) ?? remapMultimodalReadiness(
        model.id,
        getEffectiveMultimodalReadiness(existing, existingProjectorCandidates),
        candidateIds,
        projectorRuntimeMerge.runtimeToNextProjectorIds,
        selectedProjectorId,
        blockedExistingReadinessProjectorIds,
        blockedExistingResolvedReadinessProjectorIds,
      )
    : model.multimodalReadiness;
  const retryableBaseModel = canPreserveResumeState
    ? {
      ...existing,
      ...model,
      // Projector runtime state is reconciled below from the effective incoming
      // scope. Do not let stale runtime-only top-level fields survive merely
      // because the incoming catalog object omitted them.
      projectorCandidates: model.projectorCandidates,
      selectedProjectorId: model.selectedProjectorId,
      variants: model.variants ?? existing.variants,
    }
    : model;

  const retryableModel = normalizePersistedModelMetadata({
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
    multimodalReadiness,
    lifecycleStatus: LifecycleStatus.QUEUED,
    downloadErrorAt: undefined,
    downloadErrorCode: undefined,
    downloadErrorMessage: undefined,
  });

  return normalizePersistedModelMetadata(applyEffectiveProjectorState(retryableModel, {
    projectorCandidates,
    selectedProjectorId,
  }));
}

function getQueuedProjectorFileNames(model: ModelMetadata): string[] {
  return getAllModelProjectorCandidates(model).flatMap((projector) => [
    ...(projector.localPath && isValidLocalFileName(projector.localPath) ? [projector.localPath] : []),
    ...getCandidateProjectorDownloadFileNames(projector),
  ]);
}

function normalizePersistedProjectorDownloadState(
  projector: ProjectorArtifact,
  options: { clearVolatileProgress?: boolean } = {},
): ProjectorArtifact {
  const resumeData = normalizeDownloadResumeData(projector.resumeData);
  const isDownloading = projector.lifecycleStatus === 'downloading';
  const shouldPauseQueuedWithResumeData = projector.lifecycleStatus === 'queued'
    && resumeData !== undefined;
  const lifecycleStatus = isDownloading
    ? resumeData !== undefined ? 'paused' as const : 'queued' as const
    : shouldPauseQueuedWithResumeData ? 'paused' as const : projector.lifecycleStatus;
  const shouldNormalizeResumeData = resumeData !== projector.resumeData;
  const shouldClearProgress = options.clearVolatileProgress === true
    || isDownloading
    || projector.lifecycleStatus === 'queued'
    || lifecycleStatus === 'queued'
    || lifecycleStatus === 'available';
  const base = shouldClearProgress || shouldNormalizeResumeData
    ? (() => {
      const { downloadProgress: _downloadProgress, resumeData: _resumeData, ...withoutVolatileState } = projector;
      return {
        ...withoutVolatileState,
        ...(resumeData !== undefined ? { resumeData } : {}),
      };
    })()
    : projector;

  return lifecycleStatus === projector.lifecycleStatus
    ? base
    : {
      ...base,
      lifecycleStatus,
    };
}

function normalizePersistedProjectorDownloadStates(
  projectors: ModelMetadata['projectorCandidates'],
  options: { clearVolatileProgress?: boolean } = {},
): ModelMetadata['projectorCandidates'] {
  if (!projectors?.length) {
    return projectors;
  }

  let didChange = false;
  const normalized = projectors.map((projector) => {
    const nextProjector = normalizePersistedProjectorDownloadState(projector, options);
    didChange ||= nextProjector !== projector;
    return nextProjector;
  });

  return didChange ? normalized : projectors;
}

function normalizePersistedProjectorDownloadStatesForModel(
  model: ModelMetadata,
  options: { clearVolatileProgress?: boolean } = {},
): ModelMetadata {
  return mapModelProjectorCandidates(
    model,
    (projector) => normalizePersistedProjectorDownloadState(projector, options),
  );
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
    const wasInFlight = normalizedModel.lifecycleStatus === LifecycleStatus.DOWNLOADING
      || normalizedModel.lifecycleStatus === LifecycleStatus.VERIFYING;
    const modelWithNormalizedProjectors = normalizePersistedProjectorDownloadStatesForModel(
      normalizedModel,
      { clearVolatileProgress: wasInFlight },
    );
    if (
      normalizedModel.lifecycleStatus === LifecycleStatus.DOWNLOADING
      || normalizedModel.lifecycleStatus === LifecycleStatus.VERIFYING
    ) {
      return {
        ...modelWithNormalizedProjectors,
        lifecycleStatus: LifecycleStatus.QUEUED,
      };
    }

    return modelWithNormalizedProjectors;
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

            return normalizePersistedProjectorDownloadStatesForModel({
              ...model,
              downloadProgress: shouldZeroProgress ? 0 : model.downloadProgress,
            }, { clearVolatileProgress: shouldZeroProgress });
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
