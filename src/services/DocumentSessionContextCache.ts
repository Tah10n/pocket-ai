import type { ChatAttachment } from '../types/attachments';
import { AppError, getPrivacySafeErrorLogDetails, toAppError } from './AppError';
import type {
  ChatDocumentSessionContextSource,
  ChatDocumentTextProcessorResult,
  PocketAnydocAssetLease,
  SelectChatDocumentSessionContextOptions,
} from './ChatAttachmentProcessorRegistry';

type ChatDocumentAttachment = Extract<ChatAttachment, { kind: 'document' }>;

export const DOCUMENT_SESSION_CONTEXT_MAX_ENTRIES = 4;
/** Applies only to direct-text chunks retained on the JavaScript heap. */
export const DOCUMENT_SESSION_CONTEXT_MAX_SOURCE_CHARS = 1_000_000;

type CachedDocumentContext = {
  key: string;
  threadId: string;
  attachment: ChatDocumentAttachment;
  source: ChatDocumentSessionContextSource;
  sourceCharCount: number;
  insertedSequence: number;
  lastAccessSequence: number;
};

type CacheMutationStamp = {
  globalEpoch: number;
  threadEpoch: number;
  keyEpoch: number;
  threadState: EpochState;
  keyState: EpochState;
};

type EpochState = {
  epoch: number;
  activeOperations: number;
};

type MutationLease = {
  stamp: CacheMutationStamp;
  release(): void;
};

export type SelectedSessionDocumentContext = {
  attachment: ChatDocumentAttachment;
  result: ChatDocumentTextProcessorResult;
};

export type DocumentSessionContextCacheStats = {
  activeMutationLeaseCount: number;
  entryCount: number;
  keyEpochStateCount: number;
  pendingReleaseCount: number;
  sourceCharCount: number;
  threadCount: number;
  threadEpochStateCount: number;
};

export type ReleasableDocumentResource = Pick<
  ChatDocumentSessionContextSource | PocketAnydocAssetLease,
  'release'
> & {
  isReleased?: () => boolean;
};

export type DocumentResourceRelease = {
  resource: ReleasableDocumentResource;
  /** Counts only direct-text data retained on the JavaScript heap. */
  sourceCharCount?: number;
};

function createCacheKey(threadId: string, attachmentId: string): string {
  return `${threadId}\u0000${attachmentId}`;
}

function normalizeSourceCharCount(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

class DocumentSessionContextCache {
  private readonly entries = new Map<string, CachedDocumentContext>();
  /**
   * Removed resources stay owned here until native/JS release succeeds. A failed native release
   * is explicitly retryable, so dropping the last reference would permanently consume a handle.
   */
  private readonly pendingReleases = new Map<ReleasableDocumentResource, number>();
  private readonly releaseAttempts = new Map<ReleasableDocumentResource, Promise<boolean>>();
  private readonly threadEpochStates = new Map<string, EpochState>();
  private readonly keyEpochStates = new Map<string, EpochState>();
  private activeMutationLeaseCount = 0;
  private globalEpoch = 0;
  private sequence = 0;
  private sourceCharCount = 0;

  public async put(
    threadId: string,
    attachment: ChatDocumentAttachment,
    result: ChatDocumentTextProcessorResult,
  ): Promise<boolean> {
    const source = result.sessionContextSource;
    const normalizedThreadId = threadId.trim();
    const normalizedAttachmentId = attachment.id.trim();
    const sourceCharCount = source?.kind === 'memory'
      ? normalizeSourceCharCount(result.sourceCharCount)
      : 0;
    if (!source || source.isReleased()) {
      return false;
    }
    if (
      !normalizedThreadId
      || !normalizedAttachmentId
      || source.attachmentId !== normalizedAttachmentId
      || result.attachmentId !== normalizedAttachmentId
    ) {
      await this.releaseResources([{ resource: source, sourceCharCount }]);
      return false;
    }

    if (sourceCharCount > DOCUMENT_SESSION_CONTEXT_MAX_SOURCE_CHARS) {
      await this.releaseResources([{ resource: source, sourceCharCount }]);
      return false;
    }

    const key = createCacheKey(normalizedThreadId, normalizedAttachmentId);
    const mutationLease = this.beginMutationLease(key, normalizedThreadId, true);
    try {
      await this.retryPendingReleases();
      if (!this.isMutationCurrent(key, normalizedThreadId, mutationLease.stamp)) {
        await this.releaseResources([{ resource: source, sourceCharCount }]);
        return false;
      }

      const replaced = this.removeEntry(key);
      const evicted: CachedDocumentContext[] = replaced ? [replaced] : [];
      while (
        this.getRetainedResourceCount() >= DOCUMENT_SESSION_CONTEXT_MAX_ENTRIES
        || this.getRetainedSourceCharCount() + sourceCharCount > DOCUMENT_SESSION_CONTEXT_MAX_SOURCE_CHARS
      ) {
        const oldest = this.removeLeastRecentlyUsedEntry();
        if (!oldest) {
          break;
        }
        evicted.push(oldest);
      }

      await this.releaseEntries(evicted.filter((entry) => entry.source !== source));
      if (!this.isMutationCurrent(key, normalizedThreadId, mutationLease.stamp)) {
        await this.releaseResources([{ resource: source, sourceCharCount }]);
        return false;
      }
      if (
        source.isReleased()
        || this.getRetainedResourceCount() >= DOCUMENT_SESSION_CONTEXT_MAX_ENTRIES
        || this.getRetainedSourceCharCount() + sourceCharCount > DOCUMENT_SESSION_CONTEXT_MAX_SOURCE_CHARS
      ) {
        await this.releaseResources([{ resource: source, sourceCharCount }]);
        return false;
      }

      this.sequence += 1;
      this.entries.set(key, {
        key,
        threadId: normalizedThreadId,
        attachment,
        source,
        sourceCharCount,
        insertedSequence: this.sequence,
        lastAccessSequence: this.sequence,
      });
      this.sourceCharCount += sourceCharCount;
      return true;
    } finally {
      mutationLease.release();
    }
  }

  /** Free enough globally bounded slots before native preparation starts. */
  public async reserveForIncomingDocuments(count: number): Promise<void> {
    await this.retryPendingReleases();
    const normalizedCount = Math.min(
      DOCUMENT_SESSION_CONTEXT_MAX_ENTRIES,
      Number.isSafeInteger(count) && count > 0 ? count : 0,
    );
    while (this.getRetainedResourceCount() + normalizedCount > DOCUMENT_SESSION_CONTEXT_MAX_ENTRIES) {
      const oldest = this.removeLeastRecentlyUsedEntry();
      if (!oldest) {
        break;
      }
      const retainedBeforeRelease = this.getRetainedResourceCount() + 1;
      await this.releaseEntries([oldest]);
      if (this.getRetainedResourceCount() >= retainedBeforeRelease) {
        break;
      }
    }
    if (this.getRetainedResourceCount() + normalizedCount > DOCUMENT_SESSION_CONTEXT_MAX_ENTRIES) {
      throw new AppError(
        'chat_attachment_document_resource_limit',
        'Document session resources are still being released. Try again.',
        { details: { limit: 'max_cache_entries' } },
      );
    }
  }

  public async evictLeastRecentlyUsed(): Promise<boolean> {
    await this.retryPendingReleases();
    const oldest = this.removeLeastRecentlyUsedEntry();
    if (!oldest) {
      return false;
    }
    const retainedBeforeRelease = this.getRetainedResourceCount() + 1;
    await this.releaseEntries([oldest]);
    return this.getRetainedResourceCount() < retainedBeforeRelease;
  }

  public async selectThreadDocuments(
    threadId: string,
    options: SelectChatDocumentSessionContextOptions,
    attachmentIds?: ReadonlySet<string>,
  ): Promise<SelectedSessionDocumentContext[]> {
    const selectedEntries = [...this.entries.values()]
      .filter((entry) => (
        entry.threadId === threadId
        && (!attachmentIds || attachmentIds.has(entry.attachment.id))
      ))
      .sort((left, right) => left.insertedSequence - right.insertedSequence);
    const selected: SelectedSessionDocumentContext[] = [];
    for (const entry of selectedEntries) {
      if (this.entries.get(entry.key) !== entry) {
        continue;
      }
      if (options.signal?.aborted) {
        throw new AppError(
          'chat_attachment_processing_cancelled',
          'Document session context selection was cancelled.',
        );
      }
      const mutationLease = this.beginMutationLease(entry.key, entry.threadId, false);
      try {
        const result = await entry.source.selectContext(options);
        if (
          this.entries.get(entry.key) !== entry
          || !this.isMutationCurrent(entry.key, entry.threadId, mutationLease.stamp)
        ) {
          continue;
        }
        this.sequence += 1;
        entry.lastAccessSequence = this.sequence;
        selected.push({ attachment: entry.attachment, result });
      } catch (error) {
        const appError = toAppError(error, 'chat_attachment_native_failed');
        if (options.signal?.aborted || appError.code === 'chat_attachment_processing_cancelled') {
          throw appError;
        }
        const removed = this.entries.get(entry.key) === entry
          ? this.removeEntry(entry.key)
          : undefined;
        if (removed) {
          await this.releaseEntries([removed]);
        }
        console.warn('[DocumentSessionContextCache] Dropped an unavailable session document', {
          ...getPrivacySafeErrorLogDetails(appError),
        });
      } finally {
        mutationLease.release();
      }
    }
    return selected;
  }

  public async clearThread(threadId: string): Promise<void> {
    await this.clearThreads([threadId]);
  }

  public async clearThreads(threadIds: Iterable<string>): Promise<void> {
    const normalizedThreadIds = new Set(
      Array.from(threadIds, (threadId) => threadId.trim()).filter(Boolean),
    );
    normalizedThreadIds.forEach((threadId) => this.invalidateThread(threadId));
    const removed = [...this.entries.values()].filter((entry) => (
      normalizedThreadIds.has(entry.threadId)
    ));
    removed.forEach((entry) => this.removeEntry(entry.key));
    await Promise.all([
      this.retryPendingReleases(),
      this.releaseEntries(removed),
    ]);
  }

  public async retainThreadAttachments(
    threadId: string,
    attachmentIds: ReadonlySet<string>,
  ): Promise<void> {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) {
      return;
    }
    this.invalidateThread(normalizedThreadId);
    const removed = [...this.entries.values()].filter((entry) => (
      entry.threadId === normalizedThreadId && !attachmentIds.has(entry.attachment.id)
    ));
    removed.forEach((entry) => this.removeEntry(entry.key));
    await Promise.all([
      this.retryPendingReleases(),
      this.releaseEntries(removed),
    ]);
  }

  public async clearAll(): Promise<void> {
    this.globalEpoch += 1;
    const removed = [...this.entries.values()];
    this.entries.clear();
    this.sourceCharCount = 0;
    this.cleanupEpochStates();
    await Promise.all([
      this.retryPendingReleases(),
      this.releaseEntries(removed),
    ]);
  }

  /** Transfer ownership of uncached session sources or asset leases into the retry queue. */
  public async releaseResources(resources: Iterable<DocumentResourceRelease>): Promise<void> {
    const normalized = Array.from(resources, ({ resource, sourceCharCount }) => ({
      resource,
      sourceCharCount: normalizeSourceCharCount(sourceCharCount ?? 0),
    }));
    normalized.forEach(({ resource, sourceCharCount }) => {
      this.pendingReleases.set(
        resource,
        Math.max(this.pendingReleases.get(resource) ?? 0, sourceCharCount),
      );
    });
    await Promise.all(normalized.map(({ resource }) => this.attemptPendingRelease(resource)));
  }

  public async retryPendingReleases(): Promise<void> {
    await Promise.all(
      [...this.pendingReleases.keys()].map((resource) => this.attemptPendingRelease(resource)),
    );
  }

  public getStats(): DocumentSessionContextCacheStats {
    return {
      activeMutationLeaseCount: this.activeMutationLeaseCount,
      entryCount: this.entries.size,
      keyEpochStateCount: this.keyEpochStates.size,
      pendingReleaseCount: this.pendingReleases.size,
      sourceCharCount: this.getRetainedSourceCharCount(),
      threadCount: new Set([...this.entries.values()].map((entry) => entry.threadId)).size,
      threadEpochStateCount: this.threadEpochStates.size,
    };
  }

  private getRetainedResourceCount(): number {
    return this.entries.size + this.pendingReleases.size;
  }

  private getRetainedSourceCharCount(): number {
    return this.sourceCharCount
      + [...this.pendingReleases.values()].reduce((sum, charCount) => sum + charCount, 0);
  }

  private getOrCreateThreadEpochState(threadId: string): EpochState {
    const existing = this.threadEpochStates.get(threadId);
    if (existing) {
      return existing;
    }
    const created = { activeOperations: 0, epoch: 0 };
    this.threadEpochStates.set(threadId, created);
    return created;
  }

  private getOrCreateKeyEpochState(key: string): EpochState {
    const existing = this.keyEpochStates.get(key);
    if (existing) {
      return existing;
    }
    const created = { activeOperations: 0, epoch: 0 };
    this.keyEpochStates.set(key, created);
    return created;
  }

  private beginMutationLease(
    key: string,
    threadId: string,
    invalidatePreviousKeyOperations: boolean,
  ): MutationLease {
    const threadState = this.getOrCreateThreadEpochState(threadId);
    const keyState = this.getOrCreateKeyEpochState(key);
    if (invalidatePreviousKeyOperations) {
      keyState.epoch += 1;
    }
    threadState.activeOperations += 1;
    keyState.activeOperations += 1;
    this.activeMutationLeaseCount += 1;
    const stamp: CacheMutationStamp = {
      globalEpoch: this.globalEpoch,
      threadEpoch: threadState.epoch,
      keyEpoch: keyState.epoch,
      threadState,
      keyState,
    };
    let active = true;
    return {
      stamp,
      release: () => {
        if (!active) {
          return;
        }
        active = false;
        threadState.activeOperations -= 1;
        keyState.activeOperations -= 1;
        this.activeMutationLeaseCount -= 1;
        this.cleanupKeyEpochState(key, keyState);
        this.cleanupThreadEpochState(threadId, threadState);
      },
    };
  }

  private isMutationCurrent(
    key: string,
    threadId: string,
    stamp: CacheMutationStamp,
  ): boolean {
    return (
      stamp.globalEpoch === this.globalEpoch
      && this.threadEpochStates.get(threadId) === stamp.threadState
      && stamp.threadEpoch === stamp.threadState.epoch
      && this.keyEpochStates.get(key) === stamp.keyState
      && stamp.keyEpoch === stamp.keyState.epoch
    );
  }

  private invalidateThread(threadId: string): void {
    const state = this.threadEpochStates.get(threadId);
    if (state) {
      state.epoch += 1;
    }
  }

  private removeEntry(key: string): CachedDocumentContext | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    this.entries.delete(key);
    this.sourceCharCount = Math.max(0, this.sourceCharCount - entry.sourceCharCount);
    this.cleanupKeyEpochState(key);
    this.cleanupThreadEpochState(entry.threadId);
    return entry;
  }

  private cleanupEpochStates(): void {
    [...this.keyEpochStates].forEach(([key, state]) => {
      this.cleanupKeyEpochState(key, state);
    });
    [...this.threadEpochStates].forEach(([threadId, state]) => {
      this.cleanupThreadEpochState(threadId, state);
    });
  }

  private cleanupKeyEpochState(key: string, expectedState?: EpochState): void {
    const state = this.keyEpochStates.get(key);
    if (
      state
      && (!expectedState || state === expectedState)
      && state.activeOperations === 0
      && !this.entries.has(key)
    ) {
      this.keyEpochStates.delete(key);
    }
  }

  private cleanupThreadEpochState(threadId: string, expectedState?: EpochState): void {
    const state = this.threadEpochStates.get(threadId);
    if (
      state
      && (!expectedState || state === expectedState)
      && state.activeOperations === 0
      && ![...this.entries.values()].some((entry) => entry.threadId === threadId)
    ) {
      this.threadEpochStates.delete(threadId);
    }
  }

  private removeLeastRecentlyUsedEntry(): CachedDocumentContext | undefined {
    let oldest: CachedDocumentContext | undefined;
    this.entries.forEach((entry) => {
      if (
        !oldest
        || entry.lastAccessSequence < oldest.lastAccessSequence
        || (
          entry.lastAccessSequence === oldest.lastAccessSequence
          && entry.insertedSequence < oldest.insertedSequence
        )
      ) {
        oldest = entry;
      }
    });
    return oldest ? this.removeEntry(oldest.key) : undefined;
  }

  private async releaseEntries(entries: readonly CachedDocumentContext[]): Promise<void> {
    await this.releaseResources(entries.map((entry) => ({
      resource: entry.source,
      sourceCharCount: entry.sourceCharCount,
    })));
  }

  private async attemptPendingRelease(resource: ReleasableDocumentResource): Promise<boolean> {
    const existingAttempt = this.releaseAttempts.get(resource);
    if (existingAttempt) {
      return existingAttempt;
    }
    const attempt = (async () => {
      try {
        if (resource.isReleased?.()) {
          this.pendingReleases.delete(resource);
          return true;
        }
        await resource.release();
        this.pendingReleases.delete(resource);
        return true;
      } catch (error) {
        console.warn('[DocumentSessionContextCache] Failed to release a document resource', {
          ...getPrivacySafeErrorLogDetails(error),
        });
        return false;
      }
    })();
    this.releaseAttempts.set(resource, attempt);
    try {
      return await attempt;
    } finally {
      if (this.releaseAttempts.get(resource) === attempt) {
        this.releaseAttempts.delete(resource);
      }
    }
  }
}

export const documentSessionContextCache = new DocumentSessionContextCache();
