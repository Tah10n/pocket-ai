import { create } from 'zustand';
import { persist, createJSONStorage, subscribeWithSelector } from 'zustand/middleware';
import { mmkvStorage } from '../lib/mmkv';
import { ModelMetadata, LifecycleStatus } from '../types/models';
import { normalizePersistedModelMetadata } from '../services/ModelMetadataNormalizer';
import { getCandidateModelDownloadFileNames } from '../utils/modelFiles';
import { isValidLocalFileName } from '../utils/safeFilePath';
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

function buildRetryableQueueEntry(existing: ModelMetadata, model: ModelMetadata): ModelMetadata {
  const canPreserveResumeState = hasCompatibleQueuedFileIdentity(existing, model);
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
    lifecycleStatus: LifecycleStatus.QUEUED,
    downloadErrorAt: undefined,
    downloadErrorCode: undefined,
    downloadErrorMessage: undefined,
  });
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
