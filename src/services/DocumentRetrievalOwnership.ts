import type { ChatAttachment } from '../types/attachments';
import { useChatStore } from '../store/chatStore';
import { normalizeChatAttachmentLocalUri } from '../utils/chatImageAttachments';
import { DocumentRetrievalError } from '../types/documentRetrieval';

export type OwnedRetrievalDocument = Extract<ChatAttachment, { kind: 'document' }>;

/** Byte equality does not grant access: every attachment remains scoped to its message and chat. */
export function getOwnedRetrievalDocuments(threadId: string): OwnedRetrievalDocument[] {
  const thread = useChatStore.getState().getThread(threadId);
  return thread?.messages.flatMap(message => (message.attachments ?? []).filter(
    (attachment): attachment is OwnedRetrievalDocument => 'kind' in attachment && attachment.kind === 'document'
      && attachment.threadId === threadId && attachment.messageId === message.id
      && attachment.state === 'ready' && attachment.pathCategory === 'chat_attachment'
      && normalizeChatAttachmentLocalUri(attachment.localUri) !== null,
  )) ?? [];
}

export function retrievalDocumentOwnershipIdentity(document: OwnedRetrievalDocument): string {
  return JSON.stringify([document.id, document.threadId, document.localUri, document.messageId,
    document.document.contentSha256, document.document.contentHash, document.sizeBytes, document.createdAt]);
}

export function assertOwnedRetrievalDocument(threadId: string, document: OwnedRetrievalDocument): void {
  const identity = retrievalDocumentOwnershipIdentity(document);
  if (!getOwnedRetrievalDocuments(threadId).some(item => retrievalDocumentOwnershipIdentity(item) === identity)) {
    throw new DocumentRetrievalError('ownership_changed');
  }
}
