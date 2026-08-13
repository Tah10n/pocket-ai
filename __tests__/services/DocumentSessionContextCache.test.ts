import type { ChatAttachment } from '../../src/types/attachments';
import type {
  ChatDocumentSessionContextSource,
  ChatDocumentTextProcessorResult,
} from '../../src/services/ChatAttachmentProcessorRegistry';
import { AppError } from '../../src/services/AppError';
import {
  DOCUMENT_SESSION_CONTEXT_MAX_ENTRIES,
  DOCUMENT_SESSION_CONTEXT_MAX_SOURCE_CHARS,
  documentSessionContextCache,
} from '../../src/services/DocumentSessionContextCache';

type ChatDocumentAttachment = Extract<ChatAttachment, { kind: 'document' }>;

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function createAttachment(id: string, threadId = `thread-${id}`): ChatDocumentAttachment {
  return {
    id,
    kind: 'document',
    state: 'ready',
    threadId,
    messageId: `message-${id}`,
    localUri: `file:///documents/${id}.txt`,
    pathCategory: 'chat_attachment',
    fileName: `${id}.txt`,
    displayName: `${id}.txt`,
    mimeType: 'text/plain',
    sizeBytes: 128,
    source: 'document_picker',
    createdAt: 1,
    document: {
      processorId: 'document-text',
      processorVersion: 3,
    },
  };
}

function createResult(
  attachment: ChatDocumentAttachment,
  sourceCharCount = 128,
): {
  result: ChatDocumentTextProcessorResult;
  source: jest.Mocked<ChatDocumentSessionContextSource>;
} {
  let result!: ChatDocumentTextProcessorResult;
  let released = false;
  const source: jest.Mocked<ChatDocumentSessionContextSource> = {
    attachmentId: attachment.id,
    kind: 'memory',
    isReleased: jest.fn(() => released),
    release: jest.fn(async () => {
      released = true;
    }),
    selectContext: jest.fn(async ({ query }) => ({
      ...result,
      text: `selected:${query}`,
      chunks: [{ index: 0, text: `selected:${query}`, kind: 'paragraph' as const }],
      extractedCharCount: `selected:${query}`.length,
      selectedChunkCount: 1,
    })),
  };
  result = {
    attachmentId: attachment.id,
    runtimeInput: 'document_text',
    processorId: 'document-text',
    processorVersion: 3,
    mimeType: attachment.mimeType,
    canonicalFormat: 'txt',
    text: 'initial',
    chunks: [{ index: 0, text: 'initial', kind: 'paragraph' }],
    truncated: false,
    extractedCharCount: 7,
    sourceCharCount,
    contentHash: `sha256:${attachment.id.padEnd(64, '0').slice(0, 64)}`,
    selectedChunkCount: 1,
    chunkCount: 1,
    warnings: [],
    sessionContextSource: source,
  };
  return { result, source };
}

describe('DocumentSessionContextCache', () => {
  beforeEach(async () => {
    await documentSessionContextCache.clearAll();
    await documentSessionContextCache.retryPendingReleases();
  });

  afterEach(async () => {
    await documentSessionContextCache.clearAll();
    await documentSessionContextCache.retryPendingReleases();
  });

  it('bounds key metadata across 10,000 sequential unique put and clear cycles', async () => {
    for (let index = 0; index < 10_000; index += 1) {
      const attachment = createAttachment(`unique-${index}`, 'thread-reused');
      const { result } = createResult(attachment);
      await documentSessionContextCache.put('thread-reused', attachment, result);
      await documentSessionContextCache.clearThread('thread-reused');
    }

    expect(documentSessionContextCache.getStats()).toEqual({
      activeMutationLeaseCount: 0,
      entryCount: 0,
      keyEpochStateCount: 0,
      pendingReleaseCount: 0,
      sourceCharCount: 0,
      threadCount: 0,
      threadEpochStateCount: 0,
    });
  }, 30_000);

  it('does not retain thread tombstones after many unique threads are cleared', async () => {
    for (let index = 0; index < 1_000; index += 1) {
      const threadId = `thread-unique-${index}`;
      const attachment = createAttachment(`thread-document-${index}`, threadId);
      const { result } = createResult(attachment);
      await documentSessionContextCache.put(threadId, attachment, result);
      await documentSessionContextCache.clearThread(threadId);
    }

    expect(documentSessionContextCache.getStats()).toEqual({
      activeMutationLeaseCount: 0,
      entryCount: 0,
      keyEpochStateCount: 0,
      pendingReleaseCount: 0,
      sourceCharCount: 0,
      threadCount: 0,
      threadEpochStateCount: 0,
    });
  }, 30_000);

  it('reuses a process-local source for each new question', async () => {
    const attachment = createAttachment('document', 'thread');
    const { result, source } = createResult(attachment);
    await expect(documentSessionContextCache.put('thread', attachment, result)).resolves.toBe(true);

    const selected = await documentSessionContextCache.selectThreadDocuments('thread', {
      query: 'second question',
      maxChars: 64_000,
      maxChunks: 64,
    });

    expect(source.selectContext).toHaveBeenCalledTimes(1);
    expect(source.selectContext).toHaveBeenCalledWith(expect.objectContaining({
      query: 'second question',
    }));
    expect(selected).toEqual([expect.objectContaining({
      attachment,
      result: expect.objectContaining({ text: 'selected:second question' }),
    })]);
  });

  it('keeps a strict global LRU bound and explicitly releases the evicted source', async () => {
    const entries = Array.from({ length: DOCUMENT_SESSION_CONTEXT_MAX_ENTRIES }, (_, index) => {
      const attachment = createAttachment(`document-${index}`);
      return { attachment, ...createResult(attachment) };
    });
    for (const entry of entries) {
      await documentSessionContextCache.put(entry.attachment.threadId, entry.attachment, entry.result);
    }
    await documentSessionContextCache.selectThreadDocuments(entries[0].attachment.threadId, {
      query: 'touch newest',
      maxChars: 64_000,
      maxChunks: 64,
    });

    const replacement = createAttachment('replacement');
    const replacementEntry = createResult(replacement);
    await documentSessionContextCache.put(replacement.threadId, replacement, replacementEntry.result);

    expect(entries[0].source.release).not.toHaveBeenCalled();
    expect(entries[1].source.release).toHaveBeenCalledTimes(1);
    expect(documentSessionContextCache.getStats()).toEqual(expect.objectContaining({
      entryCount: DOCUMENT_SESSION_CONTEXT_MAX_ENTRIES,
    }));
  });

  it('rejects an individually oversized in-memory source without retaining it', async () => {
    const attachment = createAttachment('oversized', 'thread');
    const { result, source } = createResult(
      attachment,
      DOCUMENT_SESSION_CONTEXT_MAX_SOURCE_CHARS + 1,
    );

    await expect(documentSessionContextCache.put('thread', attachment, result)).resolves.toBe(false);
    expect(source.release).toHaveBeenCalledTimes(1);
    expect(documentSessionContextCache.getStats().entryCount).toBe(0);
  });

  it('releases only the deleted thread and drops a failed source safely', async () => {
    const firstAttachment = createAttachment('first', 'thread-a');
    const secondAttachment = createAttachment('second', 'thread-b');
    const first = createResult(firstAttachment);
    const second = createResult(secondAttachment);
    await documentSessionContextCache.put('thread-a', firstAttachment, first.result);
    await documentSessionContextCache.put('thread-b', secondAttachment, second.result);

    await documentSessionContextCache.clearThread('thread-a');
    expect(first.source.release).toHaveBeenCalledTimes(1);
    expect(second.source.release).not.toHaveBeenCalled();

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    second.source.selectContext.mockRejectedValueOnce(new Error('stale handle'));
    try {
      await expect(documentSessionContextCache.selectThreadDocuments('thread-b', {
        query: 'question',
        maxChars: 64_000,
        maxChunks: 64,
      })).resolves.toEqual([]);
      expect(second.source.release).toHaveBeenCalledTimes(1);
      expect(documentSessionContextCache.getStats()).toEqual(expect.objectContaining({
        activeMutationLeaseCount: 0,
        entryCount: 0,
        keyEpochStateCount: 0,
        threadEpochStateCount: 0,
      }));
      expect(warnSpy).toHaveBeenCalledWith(
        '[DocumentSessionContextCache] Dropped an unavailable session document',
        expect.objectContaining({ errorCode: 'chat_attachment_native_failed' }),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('retains ownership after a failed release and retries it on the next cleanup', async () => {
    const attachment = createAttachment('retry-release', 'thread-retry');
    const { result, source } = createResult(attachment);
    source.release.mockRejectedValueOnce(new Error('transient native release failure'));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await documentSessionContextCache.put('thread-retry', attachment, result);
      await documentSessionContextCache.clearThread('thread-retry');

      expect(source.release).toHaveBeenCalledTimes(1);
      expect(source.isReleased()).toBe(false);
      expect(documentSessionContextCache.getStats()).toEqual(expect.objectContaining({
        activeMutationLeaseCount: 0,
        entryCount: 0,
        keyEpochStateCount: 0,
        pendingReleaseCount: 1,
        sourceCharCount: result.sourceCharCount,
        threadEpochStateCount: 0,
      }));

      await documentSessionContextCache.clearAll();
      await documentSessionContextCache.retryPendingReleases();

      expect(source.release).toHaveBeenCalledTimes(2);
      expect(source.isReleased()).toBe(true);
      expect(documentSessionContextCache.getStats()).toEqual(expect.objectContaining({
        entryCount: 0,
        pendingReleaseCount: 0,
        sourceCharCount: 0,
      }));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not let a suspended release block clears or a put for an independent key', async () => {
    const blockedAttachment = createAttachment('blocked-release', 'thread-blocked-release');
    const blocked = createResult(blockedAttachment);
    await documentSessionContextCache.put(
      'thread-blocked-release',
      blockedAttachment,
      blocked.result,
    );

    const releaseGate = createDeferred();
    blocked.source.release.mockImplementationOnce(async () => {
      await releaseGate.promise;
    });
    const clearThreadPromise = documentSessionContextCache.clearThread('thread-blocked-release');
    let clearThreadSettled = false;
    void clearThreadPromise.then(() => {
      clearThreadSettled = true;
    });
    let independentPutPromise: Promise<boolean> | undefined;
    let reservePromise: Promise<void> | undefined;
    let evictPromise: Promise<boolean> | undefined;
    let finalClearPromise: Promise<void> | undefined;

    try {
      await flushPromises();
      expect(clearThreadSettled).toBe(true);
      expect(documentSessionContextCache.getStats()).toEqual(expect.objectContaining({
        activeMutationLeaseCount: 0,
        entryCount: 0,
        keyEpochStateCount: 0,
        pendingReleaseCount: 1,
        threadEpochStateCount: 0,
      }));

      const firstClearAllPromise = documentSessionContextCache.clearAll();
      let firstClearAllSettled = false;
      void firstClearAllPromise.then(() => {
        firstClearAllSettled = true;
      });
      await flushPromises();
      expect(firstClearAllSettled).toBe(true);

      reservePromise = documentSessionContextCache.reserveForIncomingDocuments(1);
      evictPromise = documentSessionContextCache.evictLeastRecentlyUsed();
      let reserveSettled = false;
      let evictResult: boolean | undefined;
      void reservePromise.then(() => {
        reserveSettled = true;
      });
      void evictPromise.then((result) => {
        evictResult = result;
      });
      await flushPromises();

      expect(reserveSettled).toBe(true);
      expect(evictResult).toBe(false);

      const independentAttachment = createAttachment('independent', 'thread-independent');
      const independent = createResult(independentAttachment);
      independentPutPromise = documentSessionContextCache.put(
        'thread-independent',
        independentAttachment,
        independent.result,
      );
      let independentPutResult: boolean | undefined;
      void independentPutPromise.then((result) => {
        independentPutResult = result;
      });
      await flushPromises();

      expect(independentPutResult).toBe(true);
      expect(documentSessionContextCache.getStats()).toEqual(expect.objectContaining({
        activeMutationLeaseCount: 0,
        entryCount: 1,
        keyEpochStateCount: 1,
        pendingReleaseCount: 1,
        threadEpochStateCount: 1,
      }));

      finalClearPromise = documentSessionContextCache.clearAll();
      let finalClearSettled = false;
      void finalClearPromise.then(() => {
        finalClearSettled = true;
      });
      await flushPromises();

      expect(finalClearSettled).toBe(true);
      expect(documentSessionContextCache.getStats()).toEqual(expect.objectContaining({
        activeMutationLeaseCount: 0,
        entryCount: 0,
        keyEpochStateCount: 0,
        pendingReleaseCount: 1,
        threadEpochStateCount: 0,
      }));
    } finally {
      releaseGate.resolve();
      await Promise.all([
        clearThreadPromise,
        reservePromise ?? Promise.resolve(),
        evictPromise ?? Promise.resolve(false),
        independentPutPromise ?? Promise.resolve(false),
        finalClearPromise ?? Promise.resolve(),
      ]);
      await documentSessionContextCache.retryPendingReleases();
    }

    expect(documentSessionContextCache.getStats()).toEqual({
      activeMutationLeaseCount: 0,
      entryCount: 0,
      keyEpochStateCount: 0,
      pendingReleaseCount: 0,
      sourceCharCount: 0,
      threadCount: 0,
      threadEpochStateCount: 0,
    });
  });

  it('invalidates a suspended put when clearThread wins the race', async () => {
    const attachment = createAttachment('clear-thread-race', 'thread-race');
    const existing = createResult(attachment);
    await documentSessionContextCache.put('thread-race', attachment, existing.result);

    const releaseGate = createDeferred();
    existing.source.release.mockImplementationOnce(async () => {
      await releaseGate.promise;
    });
    const incoming = createResult(attachment);
    const putPromise = documentSessionContextCache.put('thread-race', attachment, incoming.result);
    await flushPromises();

    const clearPromise = documentSessionContextCache.clearThread('thread-race');
    expect(documentSessionContextCache.getStats()).toEqual(expect.objectContaining({
      activeMutationLeaseCount: 1,
      entryCount: 0,
      keyEpochStateCount: 1,
      threadEpochStateCount: 1,
    }));
    releaseGate.resolve();

    await expect(putPromise).resolves.toBe(false);
    await expect(clearPromise).resolves.toBeUndefined();
    expect(incoming.source.release).toHaveBeenCalledTimes(1);
    expect(documentSessionContextCache.getStats()).toEqual({
      activeMutationLeaseCount: 0,
      entryCount: 0,
      keyEpochStateCount: 0,
      pendingReleaseCount: 0,
      sourceCharCount: 0,
      threadCount: 0,
      threadEpochStateCount: 0,
    });
  });

  it('invalidates a suspended put when clearAll wins the race', async () => {
    const attachment = createAttachment('clear-all-race', 'thread-race');
    const existing = createResult(attachment);
    await documentSessionContextCache.put('thread-race', attachment, existing.result);

    const releaseGate = createDeferred();
    existing.source.release.mockImplementationOnce(async () => {
      await releaseGate.promise;
    });
    const incoming = createResult(attachment);
    const putPromise = documentSessionContextCache.put('thread-race', attachment, incoming.result);
    await flushPromises();

    const clearPromise = documentSessionContextCache.clearAll();
    expect(documentSessionContextCache.getStats()).toEqual(expect.objectContaining({
      activeMutationLeaseCount: 1,
      entryCount: 0,
      keyEpochStateCount: 1,
      threadEpochStateCount: 1,
    }));
    releaseGate.resolve();

    await expect(putPromise).resolves.toBe(false);
    await expect(clearPromise).resolves.toBeUndefined();
    expect(incoming.source.release).toHaveBeenCalledTimes(1);
    expect(documentSessionContextCache.getStats()).toEqual({
      activeMutationLeaseCount: 0,
      entryCount: 0,
      keyEpochStateCount: 0,
      pendingReleaseCount: 0,
      sourceCharCount: 0,
      threadCount: 0,
      threadEpochStateCount: 0,
    });
  });

  it('keeps only the newest concurrent replacement for the same key', async () => {
    const attachment = createAttachment('replacement-race', 'thread-race');
    const existing = createResult(attachment);
    await documentSessionContextCache.put('thread-race', attachment, existing.result);

    const releaseGate = createDeferred();
    existing.source.release.mockImplementationOnce(async () => {
      await releaseGate.promise;
    });
    const first = createResult(attachment);
    const second = createResult(attachment);
    const firstPut = documentSessionContextCache.put('thread-race', attachment, first.result);
    await flushPromises();
    const secondPut = documentSessionContextCache.put('thread-race', attachment, second.result);
    await flushPromises();

    releaseGate.resolve();
    await expect(firstPut).resolves.toBe(false);
    await expect(secondPut).resolves.toBe(true);
    expect(first.source.release).toHaveBeenCalledTimes(1);
    expect(second.source.release).not.toHaveBeenCalled();

    const selected = await documentSessionContextCache.selectThreadDocuments('thread-race', {
      query: 'newest',
      maxChars: 64_000,
      maxChunks: 64,
    });
    expect(selected).toEqual([expect.objectContaining({
      result: expect.objectContaining({ text: 'selected:newest' }),
    })]);
    expect(first.source.selectContext).not.toHaveBeenCalled();
    expect(second.source.selectContext).toHaveBeenCalledTimes(1);
    expect(documentSessionContextCache.getStats()).toEqual(expect.objectContaining({
      activeMutationLeaseCount: 0,
      entryCount: 1,
      keyEpochStateCount: 1,
      threadEpochStateCount: 1,
    }));
  });

  it('does not return a suspended selection after its thread is cleared', async () => {
    const attachment = createAttachment('select-clear-race', 'thread-select-race');
    const entry = createResult(attachment);
    await documentSessionContextCache.put('thread-select-race', attachment, entry.result);

    const selectGate = createDeferred();
    entry.source.selectContext.mockImplementationOnce(async ({ query }) => {
      await selectGate.promise;
      return {
        ...entry.result,
        text: `selected:${query}`,
        chunks: [{ index: 0, text: `selected:${query}`, kind: 'paragraph' as const }],
        extractedCharCount: `selected:${query}`.length,
        selectedChunkCount: 1,
      };
    });
    const selectPromise = documentSessionContextCache.selectThreadDocuments(
      'thread-select-race',
      { query: 'stale question', maxChars: 64_000, maxChunks: 64 },
    );
    await flushPromises();

    await documentSessionContextCache.clearThread('thread-select-race');
    expect(documentSessionContextCache.getStats()).toEqual(expect.objectContaining({
      activeMutationLeaseCount: 1,
      entryCount: 0,
      keyEpochStateCount: 1,
      threadEpochStateCount: 1,
    }));
    selectGate.resolve();

    await expect(selectPromise).resolves.toEqual([]);
    expect(documentSessionContextCache.getStats()).toEqual({
      activeMutationLeaseCount: 0,
      entryCount: 0,
      keyEpochStateCount: 0,
      pendingReleaseCount: 0,
      sourceCharCount: 0,
      threadCount: 0,
      threadEpochStateCount: 0,
    });
  });

  it('releases a selection lease when native cancellation rejects', async () => {
    const attachment = createAttachment('select-cancel-race', 'thread-select-cancel');
    const entry = createResult(attachment);
    await documentSessionContextCache.put('thread-select-cancel', attachment, entry.result);

    const selectGate = createDeferred();
    entry.source.selectContext.mockImplementationOnce(async () => {
      await selectGate.promise;
      throw new AppError(
        'chat_attachment_processing_cancelled',
        'Document session context selection was cancelled.',
      );
    });
    const controller = new AbortController();
    const selectPromise = documentSessionContextCache.selectThreadDocuments(
      'thread-select-cancel',
      {
        query: 'cancelled question',
        maxChars: 64_000,
        maxChunks: 64,
        signal: controller.signal,
      },
    );
    await flushPromises();

    controller.abort();
    selectGate.resolve();

    await expect(selectPromise).rejects.toEqual(expect.objectContaining({
      code: 'chat_attachment_processing_cancelled',
    }));
    expect(entry.source.release).not.toHaveBeenCalled();
    expect(documentSessionContextCache.getStats()).toEqual(expect.objectContaining({
      activeMutationLeaseCount: 0,
      entryCount: 1,
      keyEpochStateCount: 1,
      threadEpochStateCount: 1,
    }));
  });

  it('retains no handle or direct plaintext after thread deletion', async () => {
    const attachment = createAttachment('delete-resources', 'thread-delete');
    const { result, source } = createResult(attachment, 512);
    await documentSessionContextCache.put('thread-delete', attachment, result);

    await documentSessionContextCache.clearThread('thread-delete');

    await expect(documentSessionContextCache.selectThreadDocuments('thread-delete', {
      query: 'must not survive',
      maxChars: 64_000,
      maxChunks: 64,
    })).resolves.toEqual([]);
    expect(source.release).toHaveBeenCalledTimes(1);
    expect(source.selectContext).not.toHaveBeenCalled();
    expect(documentSessionContextCache.getStats()).toEqual({
      activeMutationLeaseCount: 0,
      entryCount: 0,
      keyEpochStateCount: 0,
      pendingReleaseCount: 0,
      sourceCharCount: 0,
      threadCount: 0,
      threadEpochStateCount: 0,
    });
  });

  it('clears every retained source for a pruned batch of threads', async () => {
    const firstAttachment = createAttachment('first-pruned', 'thread-pruned-a');
    const secondAttachment = createAttachment('second-pruned', 'thread-pruned-b');
    const retainedAttachment = createAttachment('retained', 'thread-retained');
    const first = createResult(firstAttachment);
    const second = createResult(secondAttachment);
    const retained = createResult(retainedAttachment);
    await documentSessionContextCache.put('thread-pruned-a', firstAttachment, first.result);
    await documentSessionContextCache.put('thread-pruned-b', secondAttachment, second.result);
    await documentSessionContextCache.put('thread-retained', retainedAttachment, retained.result);

    await documentSessionContextCache.clearThreads(['thread-pruned-a', 'thread-pruned-b']);

    expect(first.source.release).toHaveBeenCalledTimes(1);
    expect(second.source.release).toHaveBeenCalledTimes(1);
    expect(retained.source.release).not.toHaveBeenCalled();
    expect(documentSessionContextCache.getStats()).toEqual(expect.objectContaining({
      entryCount: 1,
      pendingReleaseCount: 0,
      threadCount: 1,
    }));
  });
});
