jest.mock('expo-file-system/legacy', () => ({
  EncodingType: { Base64: 'base64', UTF8: 'utf8' },
  documentDirectory: 'test-dir/',
  getInfoAsync: jest.fn(),
  readAsStringAsync: jest.fn(),
}));

import { fromByteArray } from 'base64-js';
import { deflate } from 'pako';
import * as FileSystem from 'expo-file-system/legacy';
import {
  buildDocumentAttachmentTextPart,
  chatAttachmentProcessorRegistry,
  DOCUMENT_TEXT_PROCESSOR_ID,
  DOCUMENT_TEXT_PROCESSOR_VERSION,
  withProcessedDocumentAttachmentMetadata,
} from '../../src/services/ChatAttachmentProcessorRegistry';
import { AppError } from '../../src/services/AppError';
import type { ChatAttachment } from '../../src/types/attachments';

type ChatDocumentAttachment = Extract<ChatAttachment, { kind: 'document' }>;

function bytesToBinaryString(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
}

function createTextPdfBase64(textStream: string): string {
  const compressed = deflate(Buffer.from(textStream, 'binary'));
  const pdf = [
    '%PDF-1.4',
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Contents 4 0 R >> endobj',
    `4 0 obj << /Length ${compressed.length} /Filter /FlateDecode >> stream`,
    bytesToBinaryString(compressed),
    'endstream endobj',
    '%%EOF',
  ].join('\n');

  return fromByteArray(Buffer.from(pdf, 'binary'));
}

function createDocumentAttachment(
  overrides: Partial<ChatDocumentAttachment> = {},
): ChatDocumentAttachment {
  const { document: documentOverrides, ...baseOverrides } = overrides;

  return {
    id: 'document-1',
    kind: 'document',
    state: 'staged',
    threadId: 'thread-1',
    messageId: 'message-1',
    localUri: 'test-dir/chat-attachments/document-1.txt',
    pathCategory: 'chat_attachment',
    fileName: 'document-1.txt',
    mimeType: 'text/plain',
    sizeBytes: 128,
    source: 'document_picker',
    createdAt: 1,
    ...baseOverrides,
    document: {
      processorId: 'pending',
      processorVersion: 1,
      ...documentOverrides,
    },
  };
}

async function expectProcessorError(
  action: Promise<unknown>,
): Promise<AppError> {
  try {
    await action;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }

  throw new Error('Expected processor to reject.');
}

describe('ChatAttachmentProcessorRegistry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({
      exists: true,
      isDirectory: false,
      size: 128,
    });
    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue('Document text');
  });

  it('processes app-owned text documents into bounded text content parts', async () => {
    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue('\uFEFFLine one\r\nLine two');

    const result = await chatAttachmentProcessorRegistry.processAttachment(createDocumentAttachment());

    expect(FileSystem.readAsStringAsync).toHaveBeenCalledWith('test-dir/chat-attachments/document-1.txt', {
      encoding: FileSystem.EncodingType.UTF8,
    });
    expect(result).toEqual(expect.objectContaining({
      attachmentId: 'document-1',
      runtimeInput: 'document_text',
      processorId: DOCUMENT_TEXT_PROCESSOR_ID,
      processorVersion: DOCUMENT_TEXT_PROCESSOR_VERSION,
      mimeType: 'text/plain',
      text: 'Line one\nLine two',
      truncated: false,
      extractedCharCount: 17,
      sourceCharCount: 17,
      contentHash: expect.stringMatching(/^fnv1a32:[0-9a-f]{8}$/u),
    }));

    const textPart = buildDocumentAttachmentTextPart(result);
    expect(textPart.type).toBe('text');
    expect(textPart.text).toContain('MIME type: text/plain');
    expect(textPart.text).toContain('Line one\nLine two');
    expect(textPart.text).not.toContain('document-1.txt');
  });

  it('validates and formats JSON documents before truncation', async () => {
    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue('{"b":2,"a":1}');

    const result = await chatAttachmentProcessorRegistry.processDocumentTextAttachment(
      createDocumentAttachment({
        localUri: 'test-dir/chat-attachments/payload.json',
        fileName: 'payload.json',
        mimeType: 'application/json',
      }),
    );

    expect(result).toEqual(expect.objectContaining({
      mimeType: 'application/json',
      text: '{\n  "b": 2,\n  "a": 1\n}',
      extractedCharCount: 22,
      sourceCharCount: 22,
    }));
  });

  it('truncates document text deterministically to the configured prompt budget', async () => {
    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue('abcdefghijklmno');

    const result = await chatAttachmentProcessorRegistry.processDocumentTextAttachment(
      createDocumentAttachment(),
      { maxChars: 10 },
    );

    expect(result).toEqual(expect.objectContaining({
      text: 'abcdefghij',
      truncated: true,
      extractedCharCount: 10,
      sourceCharCount: 15,
    }));
    expect(buildDocumentAttachmentTextPart(result).text)
      .toContain('Excerpt: first 10 of 15 characters');
  });

  it('rejects attachments outside app-owned chat attachment storage without leaking paths', async () => {
    const error = await expectProcessorError(
      chatAttachmentProcessorRegistry.processDocumentTextAttachment(
        createDocumentAttachment({
          localUri: 'file:///private/document.txt',
        }),
      ),
    );

    expect(error.code).toBe('chat_attachment_not_ready');
    expect(error.message).not.toContain('file:///private/document.txt');
    expect(JSON.stringify(error.details)).not.toContain('file:///private/document.txt');
    expect(FileSystem.readAsStringAsync).not.toHaveBeenCalled();
  });

  it('processes text-based PDFs into bounded text content parts', async () => {
    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue(createTextPdfBase64(
      'BT /F1 12 Tf 72 720 Td (Quarterly notes) Tj ET',
    ));

    const result = await chatAttachmentProcessorRegistry.processDocumentTextAttachment(
      createDocumentAttachment({
        localUri: 'test-dir/chat-attachments/report.pdf',
        fileName: 'report.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 2048,
      }),
    );

    expect(FileSystem.readAsStringAsync).toHaveBeenCalledWith('test-dir/chat-attachments/report.pdf', {
      encoding: FileSystem.EncodingType.Base64,
    });
    expect(result).toEqual(expect.objectContaining({
      mimeType: 'application/pdf',
      text: 'Quarterly notes',
      pageCount: 1,
      isScanned: false,
    }));
    expect(buildDocumentAttachmentTextPart(result).text).toContain('Pages: 1');
  });

  it('classifies scanned PDFs as deterministic no-text failures', async () => {
    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue(fromByteArray(Buffer.from([
      '%PDF-1.4',
      '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
      '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
      '3 0 obj << /Type /Page /Contents 4 0 R >> endobj',
      '4 0 obj << /Length 8 >> stream',
      'q /Im1 Do Q',
      'endstream endobj',
      '%%EOF',
    ].join('\n'), 'binary')));

    const error = await expectProcessorError(
      chatAttachmentProcessorRegistry.processDocumentTextAttachment(
        createDocumentAttachment({
          localUri: 'test-dir/chat-attachments/scanned.pdf',
          fileName: 'scanned.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 2048,
        }),
      ),
    );

    expect(error.code).toBe('chat_attachment_document_no_extractable_text');
    expect(error.details).toEqual(expect.objectContaining({
      reason: 'no_extractable_text',
      isScanned: true,
    }));
    expect(JSON.stringify(error.details)).not.toContain('scanned.pdf');
  });

  it('rejects unsupported document types without leaking filenames', async () => {
    const error = await expectProcessorError(
      chatAttachmentProcessorRegistry.processDocumentTextAttachment(
        createDocumentAttachment({
          localUri: 'test-dir/chat-attachments/secret-contract.docx',
          fileName: 'secret-contract.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        }),
      ),
    );

    expect(error.code).toBe('chat_attachment_unsupported_type');
    expect(error.message).not.toContain('secret-contract.docx');
    expect(JSON.stringify(error.details)).not.toContain('secret-contract.docx');
    expect(FileSystem.readAsStringAsync).not.toHaveBeenCalled();
  });

  it('rejects corrupt binary-looking text payloads', async () => {
    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue('hello\u0000world');

    const error = await expectProcessorError(
      chatAttachmentProcessorRegistry.processDocumentTextAttachment(createDocumentAttachment()),
    );

    expect(error.code).toBe('chat_attachment_corrupt');
    expect(error.details).toEqual(expect.objectContaining({
      reason: 'nul_byte',
    }));
  });

  it('rejects invalid JSON as a parse failure', async () => {
    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue('{"broken":');

    const error = await expectProcessorError(
      chatAttachmentProcessorRegistry.processDocumentTextAttachment(
        createDocumentAttachment({
          localUri: 'test-dir/chat-attachments/broken.json',
          fileName: 'broken.json',
          mimeType: 'application/json',
        }),
      ),
    );

    expect(error.code).toBe('chat_attachment_parse_failed');
    expect(error.details).toEqual(expect.objectContaining({
      reason: 'invalid_json',
    }));
  });

  it('rejects documents that exceed the configured local processing file limit', async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({
      exists: true,
      isDirectory: false,
      size: 4096,
    });

    const error = await expectProcessorError(
      chatAttachmentProcessorRegistry.processDocumentTextAttachment(
        createDocumentAttachment({ sizeBytes: 4096 }),
        { maxFileBytes: 1024 },
      ),
    );

    expect(error.code).toBe('chat_attachment_too_large_for_context');
    expect(error.details).toEqual(expect.objectContaining({
      maxFileBytes: 1024,
      sizeBytes: 4096,
    }));
    expect(FileSystem.readAsStringAsync).not.toHaveBeenCalled();
  });

  it('returns updated persisted document metadata after processing', async () => {
    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue('memo');
    const attachment = createDocumentAttachment({
      state: 'processing',
      document: {
        processorId: 'pending',
        processorVersion: 1,
        pageCount: 3,
      },
    });

    const result = await chatAttachmentProcessorRegistry.processDocumentTextAttachment(attachment);
    const updated = withProcessedDocumentAttachmentMetadata(attachment, result);

    expect(updated).toEqual(expect.objectContaining({
      state: 'ready',
      document: expect.objectContaining({
        processorId: DOCUMENT_TEXT_PROCESSOR_ID,
        processorVersion: DOCUMENT_TEXT_PROCESSOR_VERSION,
        contentHash: result.contentHash,
        extractedCharCount: 4,
        isScanned: false,
        pageCount: 3,
      }),
    }));
  });
});
