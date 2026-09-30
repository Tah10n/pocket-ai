import { loadOwnedRetrievalDocuments } from '../../src/services/DocumentRetrievalDocuments';
import { MAX_CHAT_ANYDOC_DOCUMENT_ATTACHMENT_BYTES } from '../../src/utils/chatAttachments';
import type { ChatAttachment } from '../../src/types/attachments';

const mockStat = jest.fn();
const mockProcess = jest.fn();
const mockSelect = jest.fn();
const mockReserve = jest.fn();
const mockRelease = jest.fn();
let mockDocument: Extract<ChatAttachment, { kind: 'document' }>;

jest.mock('expo-file-system/legacy', () => ({ documentDirectory: 'file:///documents/',
  getInfoAsync: (...args: unknown[]) => mockStat(...args) }));
jest.mock('../../src/store/chatStore', () => ({ useChatStore: { getState: () => ({
  getThread: () => ({ messages: [{ id: 'message', attachments: [mockDocument] }] }),
}) } }));
jest.mock('../../src/services/ChatAttachmentProcessorRegistry', () => ({ chatAttachmentProcessorRegistry: {
  processDocumentTextAttachment: (...args: unknown[]) => mockProcess(...args),
} }));
jest.mock('../../src/services/DocumentSessionContextCache', () => ({ documentSessionContextCache: {
  selectThreadDocuments: (...args: unknown[]) => mockSelect(...args),
  reserveForIncomingDocuments: (...args: unknown[]) => mockReserve(...args),
  releaseResources: (...args: unknown[]) => mockRelease(...args),
} }));

const MiB = 1024 * 1024;
const options = { query: '', assertCurrent: jest.fn(), maxFileBytes: MAX_CHAT_ANYDOC_DOCUMENT_ATTACHMENT_BYTES,
  maxChars: 16000, maxChunks: 64 };

describe('retrieval document format limits', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDocument = { id: 'doc', kind: 'document', state: 'ready', threadId: 'thread', messageId: 'message',
      localUri: 'file:///documents/chat-attachments/doc.docx', pathCategory: 'chat_attachment',
      fileName: 'doc.docx', mimeType: 'application/octet-stream', sizeBytes: 12 * MiB,
      source: 'document_picker', createdAt: 1, document: { processorId: 'pocket-anydoc', processorVersion: 1,
        contentSha256: 'a'.repeat(64) } };
    mockStat.mockResolvedValue({ exists: true, isDirectory: false, size: mockDocument.sizeBytes });
    mockSelect.mockResolvedValue([]);
    mockReserve.mockResolvedValue(undefined);
    mockRelease.mockResolvedValue(undefined);
    mockProcess.mockResolvedValue({ attachmentId: 'doc', contentSha256: 'a'.repeat(64) });
  });

  it('accepts the existing 12 MiB Office boundary under the 16 MiB outer ceiling and keeps the parser cap', async () => {
    const loaded = await loadOwnedRetrievalDocuments('thread', ['doc'], options);
    expect(mockProcess).toHaveBeenCalledWith(mockDocument, expect.objectContaining({ maxFileBytes: 12 * MiB }));
    expect(loaded.entries).toHaveLength(1);
    await loaded.release();
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it.each([
    { fileName: 'doc.docx', mimeType: 'application/octet-stream', maxBytes: 12 * MiB },
    { fileName: 'doc.docx', mimeType: 'text/plain', maxBytes: 12 * MiB },
    { fileName: 'doc.pdf', mimeType: 'application/pdf', maxBytes: 8 * MiB },
    { fileName: 'doc.txt', mimeType: 'text/plain', maxBytes: 2 * MiB },
  ])('rejects bytes above the current $fileName route cap before parsing or cache access', async ({ fileName, mimeType, maxBytes }) => {
    mockDocument = { ...mockDocument, fileName, mimeType, sizeBytes: maxBytes + 1 };
    mockStat.mockResolvedValue({ exists: true, isDirectory: false, size: maxBytes + 1 });
    await expect(loadOwnedRetrievalDocuments('thread', ['doc'], options)).rejects.toMatchObject({ code: 'ownership_changed' });
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockProcess).not.toHaveBeenCalled();
  });

  it('preserves a narrower caller budget and does not widen it to the format ceiling', async () => {
    await expect(loadOwnedRetrievalDocuments('thread', ['doc'], { ...options, maxFileBytes: MiB }))
      .rejects.toMatchObject({ code: 'ownership_changed' });
    expect(mockProcess).not.toHaveBeenCalled();
  });
});
