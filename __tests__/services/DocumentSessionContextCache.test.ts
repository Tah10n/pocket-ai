import type { ChatAttachment } from '../../src/types/attachments';
import type {
  ChatDocumentSessionContextSource,
  ChatDocumentTextProcessorResult,
} from '../../src/services/ChatAttachmentProcessorRegistry';
import {
  DOCUMENT_SESSION_CONTEXT_MAX_ENTRIES,
  DOCUMENT_SESSION_CONTEXT_MAX_SOURCE_CHARS,
  documentSessionContextCache,
} from '../../src/services/DocumentSessionContextCache';

type ChatDocumentAttachment = Extract<ChatAttachment, { kind: 'document' }>;

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
  });

  afterEach(async () => {
    await documentSessionContextCache.clearAll();
  });

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
      expect(documentSessionContextCache.getStats().entryCount).toBe(0);
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
        entryCount: 0,
        pendingReleaseCount: 1,
        sourceCharCount: result.sourceCharCount,
      }));

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
