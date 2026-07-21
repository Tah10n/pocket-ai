import * as FileSystem from 'expo-file-system/legacy';
import { useChatStore } from '../store/chatStore';
import { getQueuedDownloadFileNames } from '../store/downloadStore';
import { storage as appStorage } from '../store/storage';
import { getAppCacheRootDir, getCacheDir, getModelsDir } from './FileSystemSetup';
import { llmEngineService } from './LLMEngineService';
import { registry } from './LocalStorageRegistry';
import { modelCatalogService } from './ModelCatalogService';
import { isValidLocalFileName, safeJoinModelPath } from '../utils/safeFilePath';
import {
  CHAT_HISTORY_INDEX_KEY,
  CHAT_HISTORY_PREFIX,
  SETTINGS_KEY,
  clearLegacyChatHistory,
  resetAllParametersForModel,
  resetSettings,
  storage as settingsStorage,
} from './SettingsStore';
import { LifecycleStatus, ModelMetadata, type ModelArtifactMetadata } from '../types/models';
import {
  ESTIMATED_CONTEXT_BYTES_PER_TOKEN,
  ESTIMATED_MODEL_RUNTIME_OVERHEAD_FACTOR,
} from '../utils/contextWindow';
import type { ProjectorArtifact } from '../types/multimodal';
import {
  hasTrackableProjectorLocalFile,
  isStoredProjectorArtifact,
  normalizePositiveByteSize,
} from '../utils/modelSize';
import {
  getAllModelProjectorCandidates,
  mapModelProjectorCandidates,
} from '../utils/effectiveProjectorState';
import {
  CHAT_PERSISTENCE_INDEX_KEY,
  LEGACY_CHAT_STORE_STORAGE_KEY,
  isChatPersistenceStorageKey,
} from '../store/chatPersistence';
import {
  getAppCacheDirectorySizeBytes,
  invalidateAppCacheDirectorySizeMeasurement,
} from './SystemMetricsService';
import { performanceMonitor } from './PerformanceMonitor';

const CHAT_STORE_KEY = LEGACY_CHAT_STORE_STORAGE_KEY;
const MIN_DIRECTORY_SIZE_FALLBACK_BYTES = 0;
const MIN_ESTIMATED_CONTEXT_BYTES = 64 * 1024 * 1024;
const DIRECTORY_SIZE_CACHE_TTL_MS = 60_000;
const DIRECTORY_SIZE_MAX_CONCURRENT_STATS = 8;
const DIRECTORY_SIZE_CACHE_MAX_ENTRIES = 32;
const DIRECTORY_SIZE_MAX_VISITED_NODES = 4_096;
const DIRECTORY_SIZE_MAX_QUEUED_FILE_SYSTEM_TASKS = 64;
const CLEARABLE_CACHE_DIRECTORY_SIZE_REQUEST_MAX_ENTRIES = 8;
const PROTECTED_ACTIVE_CACHE_ENTRY_NAMES = new Set(['http-cache']);

type PersistedChatStorePayload = {
  state?: {
    threads?: Record<string, unknown>;
    activeThreadId?: string | null;
  };
};

export interface AppStorageMetrics {
  downloadedModels: ModelMetadata[];
  modelsBytes: number;
  quarantinedModelFiles: QuarantinedModelFilesMetrics;
  cacheBytes: number;
  chatHistoryBytes: number;
  settingsBytes: number;
  appFilesBytes: number;
  activeModelEstimateBytes: number;
  activeModelId: string | null;
}

export interface QuarantinedModelFilesMetrics {
  fileNames: string[];
  count: number;
  bytes: number;
}

export interface AppStorageMetricsOptions {
  refreshModelFileQuarantine?: boolean;
}

interface OffloadModelOptions {
  preserveSettings?: boolean;
}

type DirectorySizeCacheEntry = {
  measuredAt: number;
  sizeBytes: number;
};

type DirectoryStatLimiter = <T>(task: () => Promise<T>) => Promise<T>;

type DirectoryTraversalOptions = {
  excludedRootEntryNames?: ReadonlySet<string>;
};

type DirectoryFileSystemWorkQueue = {
  schedule: <T>(task: () => Promise<T>) => Promise<T>;
  getState: () => { activeCount: number; queuedCount: number };
};

type ClearableCacheDirectorySizeRequest = {
  generation: number;
  promise: Promise<number>;
};

const directorySizeCache = new Map<string, DirectorySizeCacheEntry>();
const clearableCacheDirectorySizeRequests = new Map<string, ClearableCacheDirectorySizeRequest>();
let directorySizeCacheGeneration = 0;

function getTextByteLength(value: string | null | undefined) {
  if (!value) {
    return 0;
  }

  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(value).length;
  }

  return unescape(encodeURIComponent(value)).length;
}

function normalizeDirectoryUri(directoryUri: string): string {
  return directoryUri.endsWith('/') ? directoryUri : `${directoryUri}/`;
}

function isFileSystemDirectory(info: { isDirectory?: boolean }): boolean {
  return info.isDirectory === true;
}

function joinDirectoryEntryUri(directoryUri: string, entryName: string): string {
  return `${normalizeDirectoryUri(directoryUri)}${entryName}`;
}

function isSafeDirectoryEntryName(entryName: string): boolean {
  return entryName.length > 0
    && entryName !== '.'
    && entryName !== '..'
    && !/[\\/?#%\u0000-\u001F\u007F]/u.test(entryName);
}

function isFileSystemSymbolicLink(info: FileSystem.FileInfo): boolean {
  const candidate = info as FileSystem.FileInfo & {
    isSymbolicLink?: boolean;
    type?: string;
  };
  return candidate.isSymbolicLink === true || candidate.type === 'symbolicLink';
}

function getSanitizedStorageManagerErrorDetails(error: unknown): { errorName: string } | { errorType: string } {
  return error instanceof Error
    ? { errorName: error.name || 'Error' }
    : { errorType: typeof error };
}

function getDirectoryPathCategory(directoryUri: string): 'cache_storage' | 'model_storage' | 'app_storage' {
  const appCacheRootDir = getAppCacheRootDir();
  if (appCacheRootDir && directoryUri.startsWith(appCacheRootDir)) {
    return 'cache_storage';
  }

  const cacheDir = getCacheDir();
  if (cacheDir && directoryUri.startsWith(cacheDir)) {
    return 'cache_storage';
  }

  const modelsDir = getModelsDir();
  if (modelsDir && directoryUri.startsWith(modelsDir)) {
    return 'model_storage';
  }

  return 'app_storage';
}

function createDirectoryStatLimiter(maxConcurrent: number): DirectoryStatLimiter {
  const queue: (() => void)[] = [];
  let activeCount = 0;

  const drainQueue = () => {
    if (activeCount >= maxConcurrent) {
      return;
    }

    const next = queue.shift();
    if (next) {
      next();
    }
  };

  return async <T>(task: () => Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
    const run = () => {
      activeCount += 1;
      task()
        .then(resolve, reject)
        .finally(() => {
          activeCount -= 1;
          drainQueue();
        });
    };

    if (activeCount < maxConcurrent) {
      run();
    } else {
      queue.push(run);
    }
  });
}

class DirectorySizeTraversalCancelledError extends Error {
  constructor() {
    super('Directory size traversal was invalidated.');
    this.name = 'DirectorySizeTraversalCancelledError';
  }
}

class DirectorySizeTraversalLimitError extends Error {
  constructor(scope: 'visited_nodes' | 'work_queue') {
    super(`Directory size traversal exceeded its ${scope} limit.`);
    this.name = 'DirectorySizeTraversalLimitError';
  }
}

function createDirectoryFileSystemWorkQueue(
  maxConcurrent: number,
  maxQueued: number,
): DirectoryFileSystemWorkQueue {
  const queue: (() => void)[] = [];
  let activeCount = 0;

  const drainQueue = () => {
    while (activeCount < maxConcurrent) {
      const next = queue.shift();
      if (!next) {
        return;
      }
      next();
    }
  };

  return {
    schedule: async <T>(task: () => Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
      const run = () => {
        activeCount += 1;
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            activeCount -= 1;
            drainQueue();
          });
      };

      if (activeCount < maxConcurrent) {
        run();
        return;
      }

      if (queue.length >= maxQueued) {
        reject(new DirectorySizeTraversalLimitError('work_queue'));
        return;
      }

      queue.push(run);
    }),
    getState: () => ({ activeCount, queuedCount: queue.length }),
  };
}

const directoryFileSystemWorkQueue = createDirectoryFileSystemWorkQueue(
  DIRECTORY_SIZE_MAX_CONCURRENT_STATS,
  DIRECTORY_SIZE_MAX_QUEUED_FILE_SYSTEM_TASKS,
);

function assertDirectorySizeTraversalIsCurrent(cacheGeneration: number): void {
  if (cacheGeneration !== directorySizeCacheGeneration) {
    throw new DirectorySizeTraversalCancelledError();
  }
}

async function scheduleDirectoryFileSystemTask<T>(
  cacheGeneration: number,
  task: () => Promise<T>,
): Promise<T> {
  assertDirectorySizeTraversalIsCurrent(cacheGeneration);
  return directoryFileSystemWorkQueue.schedule(async () => {
    assertDirectorySizeTraversalIsCurrent(cacheGeneration);
    const result = await task();
    assertDirectorySizeTraversalIsCurrent(cacheGeneration);
    return result;
  });
}

function getCachedDirectorySize(directoryUri: string): number | null {
  const cached = directorySizeCache.get(directoryUri);
  if (!cached) {
    return null;
  }

  const cacheAgeMs = Date.now() - cached.measuredAt;
  if (cacheAgeMs < 0 || cacheAgeMs > DIRECTORY_SIZE_CACHE_TTL_MS) {
    directorySizeCache.delete(directoryUri);
    return null;
  }

  directorySizeCache.delete(directoryUri);
  directorySizeCache.set(directoryUri, cached);
  return cached.sizeBytes;
}

function cacheDirectorySizeIfCurrent(directoryUri: string, sizeBytes: number, generation: number): void {
  if (generation !== directorySizeCacheGeneration) {
    return;
  }

  directorySizeCache.delete(directoryUri);
  directorySizeCache.set(directoryUri, {
    measuredAt: Date.now(),
    sizeBytes,
  });
  while (directorySizeCache.size > DIRECTORY_SIZE_CACHE_MAX_ENTRIES) {
    const leastRecentlyUsedDirectoryUri = directorySizeCache.keys().next().value;
    if (typeof leastRecentlyUsedDirectoryUri !== 'string') {
      break;
    }
    directorySizeCache.delete(leastRecentlyUsedDirectoryUri);
  }
}

function invalidateDirectorySizeMeasurements(): void {
  directorySizeCacheGeneration += 1;
  directorySizeCache.clear();
  clearableCacheDirectorySizeRequests.clear();
  invalidateAppCacheDirectorySizeMeasurement();
}

async function getDirectorySizeBytes(
  directoryUri: string,
  cacheGeneration = directorySizeCacheGeneration,
  propagateErrors = false,
  options: DirectoryTraversalOptions = {},
): Promise<number> {
  const normalizedDirectoryUri = normalizeDirectoryUri(directoryUri);
  if (cacheGeneration !== directorySizeCacheGeneration) {
    return MIN_DIRECTORY_SIZE_FALLBACK_BYTES;
  }

  const cachedSize = getCachedDirectorySize(normalizedDirectoryUri);
  if (cachedSize !== null) {
    return cachedSize;
  }

  try {
    const info = await scheduleDirectoryFileSystemTask(
      cacheGeneration,
      () => FileSystem.getInfoAsync(normalizedDirectoryUri),
    );
    if (!info.exists) {
      cacheDirectorySizeIfCurrent(
        normalizedDirectoryUri,
        MIN_DIRECTORY_SIZE_FALLBACK_BYTES,
        cacheGeneration,
      );
      return MIN_DIRECTORY_SIZE_FALLBACK_BYTES;
    }

    const directoriesToVisit = [normalizedDirectoryUri];
    const seenDirectoryUris = new Set(directoriesToVisit);
    const seenEntryUris = new Set<string>();
    let directoryIndex = 0;
    let visitedNodeCount = 0;
    let sizeBytes = 0;

    while (directoryIndex < directoriesToVisit.length) {
      assertDirectorySizeTraversalIsCurrent(cacheGeneration);
      const currentDirectoryUri = directoriesToVisit[directoryIndex];
      directoryIndex += 1;
      const entries = await scheduleDirectoryFileSystemTask(
        cacheGeneration,
        () => FileSystem.readDirectoryAsync(currentDirectoryUri),
      );
      const prospectiveEntryUris = new Set<string>();
      for (const entryName of entries) {
        if (
          !isSafeDirectoryEntryName(entryName)
          || (
            currentDirectoryUri === normalizedDirectoryUri
            && options.excludedRootEntryNames?.has(entryName.toLowerCase())
          )
        ) {
          continue;
        }
        const entryUri = joinDirectoryEntryUri(currentDirectoryUri, entryName);
        if (!seenEntryUris.has(entryUri)) {
          prospectiveEntryUris.add(entryUri);
        }
        if (
          visitedNodeCount + prospectiveEntryUris.size
          > DIRECTORY_SIZE_MAX_VISITED_NODES
        ) {
          throw new DirectorySizeTraversalLimitError('visited_nodes');
        }
      }
      let entryIndex = 0;

      while (entryIndex < entries.length) {
        const entryBatch: { entryUri: string }[] = [];
        while (
          entryIndex < entries.length
          && entryBatch.length < DIRECTORY_SIZE_MAX_CONCURRENT_STATS
        ) {
          const entryName = entries[entryIndex];
          entryIndex += 1;
          if (
            !isSafeDirectoryEntryName(entryName)
            || (
              currentDirectoryUri === normalizedDirectoryUri
              && options.excludedRootEntryNames?.has(entryName.toLowerCase())
            )
          ) {
            continue;
          }

          const entryUri = joinDirectoryEntryUri(currentDirectoryUri, entryName);
          if (seenEntryUris.has(entryUri)) {
            continue;
          }
          seenEntryUris.add(entryUri);
          visitedNodeCount += 1;
          if (visitedNodeCount > DIRECTORY_SIZE_MAX_VISITED_NODES) {
            throw new DirectorySizeTraversalLimitError('visited_nodes');
          }
          entryBatch.push({ entryUri });
        }

        if (entryBatch.length === 0) {
          continue;
        }

        const entryInfos = await Promise.all(entryBatch.map(({ entryUri }) => (
          scheduleDirectoryFileSystemTask(
            cacheGeneration,
            () => FileSystem.getInfoAsync(entryUri),
          )
        )));

        entryInfos.forEach((entryInfo, batchIndex) => {
          if (!entryInfo.exists || isFileSystemSymbolicLink(entryInfo)) {
            return;
          }

          const { entryUri } = entryBatch[batchIndex];
          if (isFileSystemDirectory(entryInfo)) {
            const normalizedChildDirectoryUri = normalizeDirectoryUri(entryUri);
            if (!seenDirectoryUris.has(normalizedChildDirectoryUri)) {
              seenDirectoryUris.add(normalizedChildDirectoryUri);
              directoriesToVisit.push(normalizedChildDirectoryUri);
            }
            return;
          }

          const entrySizeBytes = typeof entryInfo.size === 'number'
            && Number.isFinite(entryInfo.size)
            && entryInfo.size > 0
            ? entryInfo.size
            : 0;
          sizeBytes = Math.min(Number.MAX_SAFE_INTEGER, sizeBytes + entrySizeBytes);
        });
      }
    }

    assertDirectorySizeTraversalIsCurrent(cacheGeneration);
    cacheDirectorySizeIfCurrent(normalizedDirectoryUri, sizeBytes, cacheGeneration);
    return sizeBytes;
  } catch (error) {
    if (error instanceof DirectorySizeTraversalCancelledError) {
      return MIN_DIRECTORY_SIZE_FALLBACK_BYTES;
    }
    console.warn('[StorageManagerService] Failed to read directory size', {
      pathCategory: getDirectoryPathCategory(normalizedDirectoryUri),
      scope: 'directory_size',
      ...getSanitizedStorageManagerErrorDetails(error),
    });
    if (propagateErrors) {
      throw error;
    }
    return MIN_DIRECTORY_SIZE_FALLBACK_BYTES;
  }
}

async function scanClearableCacheDirectorySizeBytes(
  normalizedDirectoryUri: string,
  cacheGeneration: number,
): Promise<number> {
  const span = performanceMonitor.startSpan('storage.cacheScan', {
    pathCategory: 'cache_storage',
  });
  let fallbackReason: 'native_error' | 'native_unavailable' = 'native_unavailable';

  try {
    try {
      const nativeSizeBytes = await getAppCacheDirectorySizeBytes();
      if (cacheGeneration !== directorySizeCacheGeneration) {
        span.end({ outcome: 'cancelled', source: 'native' });
        return MIN_DIRECTORY_SIZE_FALLBACK_BYTES;
      }
      if (nativeSizeBytes !== null) {
        cacheDirectorySizeIfCurrent(normalizedDirectoryUri, nativeSizeBytes, cacheGeneration);
        span.end({ outcome: 'success', source: 'native' });
        return nativeSizeBytes;
      }
    } catch (error) {
      fallbackReason = 'native_error';
      console.warn('[StorageManagerService] Failed to read native cache size', {
        pathCategory: 'cache_storage',
        scope: 'native_directory_size',
        ...getSanitizedStorageManagerErrorDetails(error),
      });
    }

    performanceMonitor.incrementCounter('storage.cacheScan.jsFallback', 1, {
      reason: fallbackReason,
    });

    try {
      const sizeBytes = await getDirectorySizeBytes(
        normalizedDirectoryUri,
        cacheGeneration,
        true,
        { excludedRootEntryNames: PROTECTED_ACTIVE_CACHE_ENTRY_NAMES },
      );
      span.end({ outcome: 'success', source: 'js_fallback' });
      return sizeBytes;
    } catch (error) {
      console.warn('[StorageManagerService] Failed to read clearable cache size', {
        pathCategory: 'cache_storage',
        scope: 'clearable_directory_size',
        ...getSanitizedStorageManagerErrorDetails(error),
      });
      span.end({ outcome: 'error', source: 'js_fallback' });
      return 0;
    }
  } catch (error) {
    span.end({ outcome: 'error', source: 'unknown' });
    throw error;
  }
}

function getClearableCacheDirectorySizeBytes(cacheDirectoryUri: string): Promise<number> {
  const normalizedDirectoryUri = normalizeDirectoryUri(cacheDirectoryUri);
  const cachedSize = getCachedDirectorySize(normalizedDirectoryUri);
  if (cachedSize !== null) {
    return Promise.resolve(cachedSize);
  }

  const generation = directorySizeCacheGeneration;
  const existingRequest = clearableCacheDirectorySizeRequests.get(normalizedDirectoryUri);
  if (existingRequest && existingRequest.generation === generation) {
    performanceMonitor.incrementCounter('storage.cacheScan.deduped', 1, {
      level: 'storage_manager',
    });
    return existingRequest.promise;
  }

  const scanRequest = scanClearableCacheDirectorySizeBytes(normalizedDirectoryUri, generation);
  let sharedRequest!: Promise<number>;
  const clearIfCurrent = () => {
    if (clearableCacheDirectorySizeRequests.get(normalizedDirectoryUri)?.promise === sharedRequest) {
      clearableCacheDirectorySizeRequests.delete(normalizedDirectoryUri);
    }
  };
  sharedRequest = scanRequest.then(
    (sizeBytes) => {
      clearIfCurrent();
      return sizeBytes;
    },
    (error) => {
      clearIfCurrent();
      throw error;
    },
  );
  while (
    clearableCacheDirectorySizeRequests.size
    >= CLEARABLE_CACHE_DIRECTORY_SIZE_REQUEST_MAX_ENTRIES
  ) {
    const oldestRequestDirectoryUri = clearableCacheDirectorySizeRequests.keys().next().value;
    if (typeof oldestRequestDirectoryUri !== 'string') {
      break;
    }
    clearableCacheDirectorySizeRequests.delete(oldestRequestDirectoryUri);
  }
  clearableCacheDirectorySizeRequests.set(normalizedDirectoryUri, {
    generation,
    promise: sharedRequest,
  });

  return sharedRequest;
}

export function __resetStorageManagerDirectorySizeCacheForTests(): void {
  invalidateDirectorySizeMeasurements();
}

export function __measureStorageManagerDirectorySizeForTests(directoryUri: string): Promise<number> {
  return getDirectorySizeBytes(directoryUri);
}

export function __getStorageManagerDirectorySizeStateForTests(): {
  cacheEntryCount: number;
  inFlightRequestCount: number;
  activeFileSystemTaskCount: number;
  queuedFileSystemTaskCount: number;
  limits: {
    maxCacheEntries: number;
    maxConcurrentFileSystemTasks: number;
    maxQueuedFileSystemTasks: number;
    maxVisitedNodes: number;
  };
} {
  const workQueueState = directoryFileSystemWorkQueue.getState();
  return {
    cacheEntryCount: directorySizeCache.size,
    inFlightRequestCount: clearableCacheDirectorySizeRequests.size,
    activeFileSystemTaskCount: workQueueState.activeCount,
    queuedFileSystemTaskCount: workQueueState.queuedCount,
    limits: {
      maxCacheEntries: DIRECTORY_SIZE_CACHE_MAX_ENTRIES,
      maxConcurrentFileSystemTasks: DIRECTORY_SIZE_MAX_CONCURRENT_STATS,
      maxQueuedFileSystemTasks: DIRECTORY_SIZE_MAX_QUEUED_FILE_SYSTEM_TASKS,
      maxVisitedNodes: DIRECTORY_SIZE_MAX_VISITED_NODES,
    },
  };
}

function getDownloadedModels() {
  return registry.getModels().filter((model) => (
    model.lifecycleStatus === LifecycleStatus.DOWNLOADED
    || model.lifecycleStatus === LifecycleStatus.ACTIVE
  ));
}

async function resolveStoredModelSize(
  model: ModelMetadata,
  statLimiter: DirectoryStatLimiter,
): Promise<number | null> {
  if (!model.localPath) {
    return normalizePositiveByteSize(model.size);
  }

  const modelsDir = getModelsDir();
  if (!modelsDir) {
    return normalizePositiveByteSize(model.size);
  }

  try {
    const localUri = safeJoinModelPath(modelsDir, model.localPath);
    if (!localUri) {
      return normalizePositiveByteSize(model.size);
    }

    const info = await statLimiter(() => FileSystem.getInfoAsync(localUri));
    if (
      info.exists &&
      typeof info.size === 'number' &&
      Number.isFinite(info.size) &&
      info.size > 0
    ) {
      return Math.round(info.size);
    }
  } catch {
    // Fall back to persisted metadata when local stat lookup fails.
  }

  return normalizePositiveByteSize(model.size);
}

async function resolveStoredProjectorSize(
  projector: ProjectorArtifact,
  statLimiter: DirectoryStatLimiter,
  localSizeByPath: Map<string, Promise<number | null>>,
): Promise<number | null> {
  const shouldStatLocalFile = hasTrackableProjectorLocalFile(projector) && isValidLocalFileName(projector.localPath);
  const shouldUsePersistedSizeFallback = isStoredProjectorArtifact(projector);
  if (!shouldUsePersistedSizeFallback && !shouldStatLocalFile) {
    return null;
  }

  const persistedSize = normalizePositiveByteSize(projector.size);
  if (!projector.localPath) {
    return shouldUsePersistedSizeFallback ? persistedSize : null;
  }

  const localSize = await resolveProjectorLocalFileSize(projector.localPath, statLimiter, localSizeByPath);
  if (localSize !== null) {
    return localSize;
  }

  return shouldUsePersistedSizeFallback ? persistedSize : null;
}

function getProjectorLocalPathKey(localPath: unknown): string | undefined {
  // Android app storage is case-sensitive; physical file identity must preserve case.
  return isValidLocalFileName(localPath) ? localPath : undefined;
}

async function resolveProjectorLocalFileSize(
  localPath: string,
  statLimiter: DirectoryStatLimiter,
  localSizeByPath: Map<string, Promise<number | null>>,
): Promise<number | null> {
  const pathKey = getProjectorLocalPathKey(localPath);
  const modelsDir = getModelsDir();
  if (!pathKey || !modelsDir) {
    return null;
  }

  let pending = localSizeByPath.get(pathKey);
  if (!pending) {
    pending = (async () => {
      try {
        const localUri = safeJoinModelPath(modelsDir, localPath);
        if (!localUri) {
          return null;
        }

        const info = await statLimiter(() => FileSystem.getInfoAsync(localUri));
        if (
          info.exists
          && !isFileSystemDirectory(info)
          && typeof info.size === 'number'
          && Number.isFinite(info.size)
          && info.size > 0
        ) {
          return Math.round(info.size);
        }
      } catch {
        // Completed files retain their persisted size; partial files are counted only while present.
      }

      return null;
    })();
    localSizeByPath.set(pathKey, pending);
  }

  return pending;
}

async function resolveStoredProjectorCandidates(
  model: ModelMetadata,
  statLimiter: DirectoryStatLimiter,
  localSizeByPath: Map<string, Promise<number | null>>,
): Promise<ModelMetadata> {
  const allProjectors = getAllModelProjectorCandidates(model);
  if (allProjectors.length === 0) {
    return model;
  }

  const resolvedSizes = await Promise.all(
    allProjectors.map((projector) => resolveStoredProjectorSize(projector, statLimiter, localSizeByPath)),
  );
  const resolvedByProjector = new Map<ProjectorArtifact, ProjectorArtifact>();
  allProjectors.forEach((projector, index) => {
    const resolvedSize = resolvedSizes[index];
    if (resolvedSize === null) {
      if (!isStoredProjectorArtifact(projector) && hasTrackableProjectorLocalFile(projector)) {
        resolvedByProjector.set(projector, {
          ...projector,
          localPath: undefined,
        });
      }
      return;
    }

    if (resolvedSize === projector.size) {
      return;
    }

    resolvedByProjector.set(projector, {
      ...projector,
      size: resolvedSize,
    });
  });

  return resolvedByProjector.size > 0
    ? mapModelProjectorCandidates(model, (projector) => resolvedByProjector.get(projector) ?? projector)
    : model;
}

function isStoredProjectorModelArtifact(artifact: Pick<ModelArtifactMetadata, 'installState'>): boolean {
  return artifact.installState === 'installed';
}

function hasTrackableProjectorArtifactLocalFile(
  artifact: Pick<ModelArtifactMetadata, 'installState' | 'localPath'>,
): boolean {
  return typeof artifact.localPath === 'string'
    && (
      artifact.installState === 'installed'
      || artifact.installState === 'downloading'
      || artifact.installState === 'verifying'
      || artifact.installState === 'failed'
    );
}

async function resolveStoredCompanionArtifacts(
  model: ModelMetadata,
  statLimiter: DirectoryStatLimiter,
  localSizeByPath: Map<string, Promise<number | null>>,
): Promise<ModelArtifactMetadata[] | undefined> {
  if (!model.artifacts?.length) {
    return model.artifacts;
  }

  const resolvedByArtifact = new Map<ModelArtifactMetadata, ModelArtifactMetadata>();
  await Promise.all(model.artifacts.map(async (artifact) => {
    if (artifact.kind === 'main_model') {
      return;
    }

    const shouldStatLocalFile = hasTrackableProjectorArtifactLocalFile(artifact)
      && isValidLocalFileName(artifact.localPath);
    const shouldUsePersistedSizeFallback = isStoredProjectorModelArtifact(artifact);
    if (!shouldUsePersistedSizeFallback && !shouldStatLocalFile) {
      return;
    }

    const localSize = shouldStatLocalFile && artifact.localPath
      ? await resolveProjectorLocalFileSize(artifact.localPath, statLimiter, localSizeByPath)
      : null;
    const resolvedSize = localSize ?? (
      shouldUsePersistedSizeFallback ? normalizePositiveByteSize(artifact.sizeBytes) : null
    );
    if (resolvedSize === null) {
      if (!shouldUsePersistedSizeFallback && shouldStatLocalFile) {
        resolvedByArtifact.set(artifact, { ...artifact, localPath: undefined });
      }
      return;
    }

    if (resolvedSize !== artifact.sizeBytes) {
      resolvedByArtifact.set(artifact, { ...artifact, sizeBytes: resolvedSize });
    }
  }));

  if (resolvedByArtifact.size === 0) {
    return model.artifacts;
  }

  return model.artifacts.map((artifact) => resolvedByArtifact.get(artifact) ?? artifact);
}

async function resolveStoredArtifactSizes(
  model: ModelMetadata,
  statLimiter: DirectoryStatLimiter,
  localSizeByPath = new Map<string, Promise<number | null>>(),
): Promise<ModelMetadata> {
  const [resolvedModelSize, modelWithResolvedProjectors, resolvedArtifacts] = await Promise.all([
    resolveStoredModelSize(model, statLimiter),
    resolveStoredProjectorCandidates(model, statLimiter, localSizeByPath),
    resolveStoredCompanionArtifacts(model, statLimiter, localSizeByPath),
  ]);

  const shouldUpdateModelSize = resolvedModelSize !== null && resolvedModelSize !== model.size;
  const shouldUpdateProjectors = modelWithResolvedProjectors !== model;
  const shouldUpdateArtifacts = resolvedArtifacts !== model.artifacts;

  return shouldUpdateModelSize || shouldUpdateProjectors || shouldUpdateArtifacts
    ? {
      ...modelWithResolvedProjectors,
      ...(shouldUpdateModelSize ? { size: resolvedModelSize } : {}),
      ...(shouldUpdateArtifacts ? { artifacts: resolvedArtifacts } : {}),
    }
    : model;
}

async function getDownloadedModelsWithResolvedSizes(): Promise<ModelMetadata[]> {
  const downloadedModels = getDownloadedModels();
  const statLimiter = createDirectoryStatLimiter(DIRECTORY_SIZE_MAX_CONCURRENT_STATS);
  const localSizeByPath = new Map<string, Promise<number | null>>();
  return Promise.all(downloadedModels.map((model) => (
    resolveStoredArtifactSizes(model, statLimiter, localSizeByPath)
  )));
}

async function getQuarantinedModelFilesMetrics(
  statLimiter = createDirectoryStatLimiter(DIRECTORY_SIZE_MAX_CONCURRENT_STATS),
): Promise<QuarantinedModelFilesMetrics> {
  const fileNames = registry.getQuarantinedModelFileNames();
  const modelsDir = getModelsDir();

  if (!modelsDir || fileNames.length === 0) {
    return {
      fileNames,
      count: fileNames.length,
      bytes: 0,
    };
  }

  const sizes = await Promise.all(
    fileNames.map(async (fileName) => {
      const fileUri = safeJoinModelPath(modelsDir, fileName);
      if (!fileUri) {
        return 0;
      }

      try {
        const info = await statLimiter(() => FileSystem.getInfoAsync(fileUri));
        if (
          info.exists
          && !(info as { isDirectory?: boolean }).isDirectory
          && typeof info.size === 'number'
          && Number.isFinite(info.size)
          && info.size > 0
        ) {
          return Math.round(info.size);
        }
      } catch {
        // Keep the file visible in quarantine metrics even if size probing fails.
      }

      return 0;
    }),
  );

  return {
    fileNames,
    count: fileNames.length,
    bytes: sizes.reduce((sum, size) => sum + size, 0),
  };
}

async function refreshModelFileQuarantine() {
  try {
    await registry.validateRegistry(getQueuedDownloadFileNames());
  } catch (error) {
    console.warn('[StorageManagerService] Failed to refresh model file quarantine', {
      pathCategory: 'model_storage',
      scope: 'orphan_quarantine_refresh',
      ...getSanitizedStorageManagerErrorDetails(error),
    });
  }
}

function getLegacyChatHistoryBytes() {
  const legacyKeys = settingsStorage
    .getAllKeys()
    .filter((key) => key === CHAT_HISTORY_INDEX_KEY || key.startsWith(CHAT_HISTORY_PREFIX));

  return legacyKeys.reduce((sum, key) => {
    const value = settingsStorage.getString(key);
    if (key === CHAT_HISTORY_INDEX_KEY) {
      try {
        const parsed = value ? JSON.parse(value) : [];
        if (Array.isArray(parsed) && parsed.length === 0) {
          return sum;
        }
      } catch {
        // If the legacy index is corrupted, still count its occupied bytes.
      }
    }

    return sum + getTextByteLength(key) + getTextByteLength(value);
  }, 0);
}

function getPersistedChatStoreBytes() {
  const chatKeys = appStorage.getAllKeys().filter(isChatPersistenceStorageKey);

  return chatKeys.reduce((sum, key) => {
    const value = appStorage.getString(key);
    if (key === CHAT_STORE_KEY) {
      try {
        const parsed = JSON.parse(value ?? '') as PersistedChatStorePayload;
        const threads = parsed?.state?.threads;
        const activeThreadId = parsed?.state?.activeThreadId ?? null;
        const threadCount =
          threads && typeof threads === 'object' && !Array.isArray(threads)
            ? Object.keys(threads).length
            : 0;

        if (threadCount === 0 && activeThreadId === null) {
          return sum;
        }
      } catch {
        // If the persisted payload is corrupted, still count its occupied bytes.
      }
    }

    if (key === CHAT_PERSISTENCE_INDEX_KEY) {
      try {
        const parsed = JSON.parse(value ?? '') as { activeThreadId?: unknown; threadIds?: unknown };
        if (
          parsed.activeThreadId === null &&
          Array.isArray(parsed.threadIds) &&
          parsed.threadIds.length === 0
        ) {
          return sum;
        }
      } catch {
        // If the persisted index is corrupted, still count its occupied bytes.
      }
    }

    return sum + getTextByteLength(key) + getTextByteLength(value);
  }, 0);
}

function getSettingsBytes() {
  const settingsValue = settingsStorage.getString(SETTINGS_KEY);
  return getTextByteLength(SETTINGS_KEY) + getTextByteLength(settingsValue);
}

async function getActiveModelEstimateBytes(downloadedModels: ModelMetadata[]) {
  const activeModelId = llmEngineService.getState().activeModelId ?? null;
  if (!activeModelId) {
    return 0;
  }

  const activeModel = downloadedModels.find((model) => model.id === activeModelId)
    ?? registry.getModel(activeModelId);
  if (!activeModel) {
    return 0;
  }

  const activeModelWithResolvedSizes = downloadedModels.find((model) => model.id === activeModel.id)
    ?? await resolveStoredArtifactSizes(
      activeModel,
      createDirectoryStatLimiter(DIRECTORY_SIZE_MAX_CONCURRENT_STATS),
    );
  const baseModelBytes = Math.max(getDownloadedModelsStoredBytes([activeModelWithResolvedSizes]), 0);
  const contextBytes = Math.max(
    llmEngineService.getContextSize() * ESTIMATED_CONTEXT_BYTES_PER_TOKEN,
    MIN_ESTIMATED_CONTEXT_BYTES,
  );

  return Math.round(baseModelBytes * (1 + ESTIMATED_MODEL_RUNTIME_OVERHEAD_FACTOR) + contextBytes);
}

function getDownloadedModelsStoredBytes(downloadedModels: ModelMetadata[]): number {
  const countedProjectorKeys = new Set<string>();
  return downloadedModels.reduce((sum, model) => {
    const modelSizeBytes = normalizePositiveByteSize(model.size) ?? 0;
    const candidateProjectorSizeBytes = getAllModelProjectorCandidates(model).reduce((projectorSum, projector) => {
      const hasCountablePartialLocalFile = !isStoredProjectorArtifact(projector)
        && hasTrackableProjectorLocalFile(projector)
        && isValidLocalFileName(projector.localPath);
      if (!isStoredProjectorArtifact(projector) && !hasCountablePartialLocalFile) {
        return projectorSum;
      }

      const projectorSize = normalizePositiveByteSize(projector.size);
      if (projectorSize === null) {
        return projectorSum;
      }

      const projectorKey = projector.localPath && isValidLocalFileName(projector.localPath)
        ? `path:${projector.localPath}`
        : `id:${projector.id}`;
      if (countedProjectorKeys.has(projectorKey)) {
        return projectorSum;
      }

      countedProjectorKeys.add(projectorKey);
      return projectorSum + projectorSize;
    }, 0);

    const artifactProjectorSizeBytes = (model.artifacts ?? []).reduce((projectorSum, artifact) => {
      if (artifact.kind === 'main_model') {
        return projectorSum;
      }

      const hasCountablePartialLocalFile = !isStoredProjectorModelArtifact(artifact)
        && hasTrackableProjectorArtifactLocalFile(artifact)
        && isValidLocalFileName(artifact.localPath);
      if (!isStoredProjectorModelArtifact(artifact) && !hasCountablePartialLocalFile) {
        return projectorSum;
      }

      const projectorSize = normalizePositiveByteSize(artifact.sizeBytes);
      if (projectorSize === null) {
        return projectorSum;
      }

      const projectorKey = artifact.localPath && isValidLocalFileName(artifact.localPath)
        ? `path:${artifact.localPath}`
        : `id:${artifact.id}`;
      if (countedProjectorKeys.has(projectorKey)) {
        return projectorSum;
      }

      countedProjectorKeys.add(projectorKey);
      return projectorSum + projectorSize;
    }, 0);

    return sum + modelSizeBytes + candidateProjectorSizeBytes + artifactProjectorSizeBytes;
  }, 0);
}

export async function getAppStorageMetrics(options: AppStorageMetricsOptions = {}): Promise<AppStorageMetrics> {
  if (options.refreshModelFileQuarantine) {
    invalidateDirectorySizeMeasurements();
    await refreshModelFileQuarantine();
  }

  const cacheDir = getAppCacheRootDir();
  const [downloadedModels, quarantinedModelFiles, cacheDirectoryBytes] = await Promise.all([
    getDownloadedModelsWithResolvedSizes(),
    getQuarantinedModelFilesMetrics(),
    cacheDir ? getClearableCacheDirectorySizeBytes(cacheDir) : Promise.resolve(0),
  ]);
  const modelsBytes = getDownloadedModelsStoredBytes(downloadedModels);
  const cacheBytes = cacheDirectoryBytes + modelCatalogService.getPersistentCacheBytes();
  const chatHistoryBytes = getPersistedChatStoreBytes() + getLegacyChatHistoryBytes();
  const settingsBytes = getSettingsBytes();
  const activeModelEstimateBytes = await getActiveModelEstimateBytes(downloadedModels);

  return {
    downloadedModels,
    modelsBytes,
    quarantinedModelFiles,
    cacheBytes,
    chatHistoryBytes,
    settingsBytes,
    appFilesBytes: modelsBytes + quarantinedModelFiles.bytes + cacheBytes + chatHistoryBytes + settingsBytes,
    activeModelEstimateBytes,
    activeModelId: llmEngineService.getState().activeModelId ?? null,
  };
}

export async function offloadModel(modelId: string, options?: OffloadModelOptions) {
  const preserveSettings = options?.preserveSettings !== false;

  if (llmEngineService.getState().activeModelId === modelId) {
    await llmEngineService.unload();
  }

  await registry.removeModel(modelId);

  if (!preserveSettings) {
    resetAllParametersForModel(modelId);
  }
}

export async function clearActiveCache() {
  invalidateDirectorySizeMeasurements();

  let firstError: unknown = null;
  try {
    // Stop catalog work before removing files so an in-flight response cannot
    // repopulate the cache while this explicit user action is still running.
    modelCatalogService.clearCache('manual');
  } catch (error) {
    console.warn('[StorageManagerService] Failed to clear catalog cache', {
      pathCategory: 'cache_storage',
      scope: 'catalog_cache_clear',
      ...getSanitizedStorageManagerErrorDetails(error),
    });
    firstError = error;
  }

  const deleteWithRetry = async (uri: string) => {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await FileSystem.deleteAsync(uri, { idempotent: true });
        return;
      } catch (error) {
        lastError = error;
        if (attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
    }

    throw lastError;
  };

  let clearedEntries = 0;
  let failedCacheEntryDeletes = 0;
  const cacheDir = getAppCacheRootDir();

  try {
    if (cacheDir) {
      const cacheInfo = await FileSystem.getInfoAsync(cacheDir);
      if (cacheInfo.exists) {
        const entries = await FileSystem.readDirectoryAsync(cacheDir);
        for (const entryName of entries) {
          if (PROTECTED_ACTIVE_CACHE_ENTRY_NAMES.has(entryName.toLowerCase())) {
            continue;
          }
          try {
            await deleteWithRetry(joinDirectoryEntryUri(cacheDir, entryName));
            clearedEntries += 1;
          } catch (error) {
            failedCacheEntryDeletes += 1;
            firstError ??= error;
          }
        }
      }
    }
  } catch (error) {
    console.warn('[StorageManagerService] Failed to clear cache directory', {
      pathCategory: 'cache_storage',
      scope: 'active_cache_clear',
      ...getSanitizedStorageManagerErrorDetails(error),
    });
    firstError = error;
  }

  if (failedCacheEntryDeletes > 0) {
    console.warn('[StorageManagerService] Failed to delete cache entries', {
      pathCategory: 'cache_storage',
      scope: 'active_cache_clear',
      failedCount: failedCacheEntryDeletes,
      ...getSanitizedStorageManagerErrorDetails(firstError),
    });
  }

  invalidateDirectorySizeMeasurements();

  if (firstError) {
    throw firstError;
  }

  return clearedEntries;
}

export async function cleanupQuarantinedModelFiles() {
  invalidateDirectorySizeMeasurements();
  const getCurrentQueuedModelFileNames = () => getQueuedDownloadFileNames();
  await registry.validateRegistry(getCurrentQueuedModelFileNames());

  const fileNames = registry.getQuarantinedModelFileNames();
  let deletedCount = 0;
  let failedQuarantinedDeletes = 0;
  let firstError: unknown = null;

  for (const fileName of fileNames) {
    try {
      deletedCount += await registry.deleteQuarantinedModelFiles(
        [fileName],
        getCurrentQueuedModelFileNames,
      );
    } catch (error) {
      failedQuarantinedDeletes += 1;
      firstError ??= error;
    }
  }

  if (failedQuarantinedDeletes > 0) {
    console.warn('[StorageManagerService] Failed to delete quarantined model files', {
      pathCategory: 'model_storage',
      scope: 'quarantined_model_cleanup',
      failedCount: failedQuarantinedDeletes,
      ...getSanitizedStorageManagerErrorDetails(firstError),
    });
  }

  invalidateDirectorySizeMeasurements();

  if (firstError) {
    throw firstError;
  }

  return deletedCount;
}

export async function clearChatHistory() {
  await llmEngineService.interruptActiveCompletion();
  const removedThreads = useChatStore.getState().clearAllThreads();
  const removedLegacyEntries = clearLegacyChatHistory();
  return removedThreads + removedLegacyEntries;
}

export async function resetAppSettings() {
  if (llmEngineService.getState().activeModelId) {
    await llmEngineService.unload();
  }

  return resetSettings();
}
