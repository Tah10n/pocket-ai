import * as FileSystem from 'expo-file-system/legacy';
import { useChatStore } from '../store/chatStore';
import type { ChatAttachment } from '../types/attachments';
import { normalizeChatAttachmentLocalUri } from '../utils/chatImageAttachments';
import { chatAttachmentProcessorRegistry, type ChatDocumentSessionContextSource } from './ChatAttachmentProcessorRegistry';
import { documentSessionContextCache } from './DocumentSessionContextCache';
import { LOCAL_TOOL_LIMITS, utf8Bytes } from './LocalToolLimits';

type DocumentAttachment = Extract<ChatAttachment, { kind: 'document' }>;
export interface DocumentToolSearchContext {
  threadId: string;
  signal: AbortSignal;
  assertCurrent: () => void;
}

export class DocumentToolSearchError extends Error {
  constructor(readonly category: 'document_unavailable' | 'cancelled') {
    super(category === 'cancelled' ? 'Tool operation was cancelled.' : 'Attached document is unavailable.');
    this.name = 'DocumentToolSearchError';
  }
}

function documents(threadId: string): DocumentAttachment[] {
  const thread = useChatStore.getState().getThread(threadId);
  return thread?.messages.flatMap(message => (message.attachments ?? []).filter(
    (attachment): attachment is DocumentAttachment => 'kind' in attachment && attachment.kind === 'document'
      && attachment.threadId === threadId && attachment.messageId === message.id
      && attachment.state === 'ready' && attachment.pathCategory === 'chat_attachment'
      && normalizeChatAttachmentLocalUri(attachment.localUri) !== null,
  )) ?? [];
}

function identity(document: DocumentAttachment): string {
  return JSON.stringify([document.id, document.localUri, document.messageId, document.document.contentSha256,
    document.document.contentHash, document.sizeBytes, document.createdAt]);
}

export async function searchAttachedDocuments(
  query: string, documentIds: readonly string[] | undefined, context: DocumentToolSearchContext,
): Promise<{ untrusted: true; matches: object[]; truncated: boolean }> {
  const initial = documents(context.threadId);
  const requested = documentIds ? new Set(documentIds) : undefined;
  if (requested && [...requested].some(id => !initial.some(document => document.id === id))) {
    throw new DocumentToolSearchError('document_unavailable');
  }
  const available = initial.filter(document => !requested || requested.has(document.id));
  const selected = available.slice(0, LOCAL_TOOL_LIMITS.documentCount);
  const controller = new AbortController();
  const abort = () => controller.abort();
  context.signal.addEventListener('abort', abort);
  const assertCurrent = () => {
    context.assertCurrent();
    if (context.signal.aborted || controller.signal.aborted) throw new DocumentToolSearchError('cancelled');
    const live = documents(context.threadId);
    if (selected.some(document => !live.some(item => identity(item) === identity(document)))) {
      throw new DocumentToolSearchError('document_unavailable');
    }
  };
  const unsubscribe = useChatStore.subscribe(() => {
    try { assertCurrent(); } catch { controller.abort(); }
  });
  const queryTerms = new Set(query.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  const matches: object[] = [];
  let truncated = available.length > selected.length;
  try {
    assertCurrent();
    for (const attachment of selected) {
      assertCurrent();
      const info = await FileSystem.getInfoAsync(attachment.localUri);
      assertCurrent();
      if (!info.exists || info.isDirectory || info.size > LOCAL_TOOL_LIMITS.documentFileBytes) {
        throw new DocumentToolSearchError('document_unavailable');
      }
      const options = { query, maxChars: LOCAL_TOOL_LIMITS.documentExcerptCharacters * LOCAL_TOOL_LIMITS.documentChunks,
        maxChunks: LOCAL_TOOL_LIMITS.documentChunks, signal: controller.signal };
      const cached = await documentSessionContextCache.selectThreadDocuments(context.threadId, options, new Set([attachment.id]));
      assertCurrent();
      let source: ChatDocumentSessionContextSource | undefined;
      try {
        const hit = cached.find(item => identity(item.attachment) === identity(attachment));
        const result = hit?.result ?? await chatAttachmentProcessorRegistry.processDocumentTextAttachment(attachment, {
          ...options, maxFileBytes: LOCAL_TOOL_LIMITS.documentFileBytes, retainSessionContextSource: true,
          onSessionContextSourceCreated: created => { source = created; },
        });
        source ??= hit ? undefined : result.sessionContextSource;
        assertCurrent();
        if (result.attachmentId !== attachment.id
          || (attachment.document.contentSha256 && result.contentSha256 !== attachment.document.contentSha256)
          || (attachment.document.contentHash && result.contentHash !== attachment.document.contentHash)) {
          throw new DocumentToolSearchError('document_unavailable');
        }
        for (const chunk of result.chunks) {
          const terms = chunk.text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
          if (!terms.some(term => queryTerms.has(term))) continue;
          if (matches.length >= LOCAL_TOOL_LIMITS.documentChunks) { truncated = true; break; }
          const text = Array.from(chunk.text).slice(0, LOCAL_TOOL_LIMITS.documentExcerptCharacters).join('');
          const match = { documentId: attachment.id, chunkIndex: chunk.index, text,
            ...(chunk.pageNumber === undefined ? {} : { pageNumber: chunk.pageNumber }),
            ...(chunk.slideNumber === undefined ? {} : { slideNumber: chunk.slideNumber }),
            ...(chunk.sheetName === undefined ? {} : { sheetName: chunk.sheetName }),
            ...(chunk.sourceStart === undefined ? {} : { sourceStart: chunk.sourceStart }),
            ...(chunk.sourceEnd === undefined ? {} : { sourceEnd: chunk.sourceEnd }),
          };
          if (utf8Bytes(JSON.stringify({ untrusted: true, matches: [...matches, match], truncated: true }))
            > LOCAL_TOOL_LIMITS.resultBytes - 64) { truncated = true; break; }
          matches.push(match);
          truncated ||= text.length < chunk.text.length || result.truncated;
        }
      } finally {
        if (source) await documentSessionContextCache.releaseResources([{ resource: source }]);
      }
    }
    assertCurrent();
    return { untrusted: true, matches, truncated };
  } finally {
    unsubscribe();
    context.signal.removeEventListener('abort', abort);
  }
}
