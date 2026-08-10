jest.mock('expo-file-system/legacy', () => ({
  EncodingType: { Base64: 'base64', UTF8: 'utf8' },
  documentDirectory: 'file:///test-dir/',
  getInfoAsync: jest.fn(),
  readAsStringAsync: jest.fn(),
}));

import { fromByteArray } from 'base64-js';
import { deflate } from 'pako';
import * as FileSystem from 'expo-file-system/legacy';
import * as RNFS from 'react-native-fs';
import {
  buildDocumentAttachmentTextPart,
  chatAttachmentProcessorRegistry,
  DOCUMENT_TEXT_PROCESSOR_ID,
  DOCUMENT_TEXT_PROCESSOR_VERSION,
  MAX_DIRECT_DOCUMENT_STRUCTURAL_LINES,
  withProcessedDocumentAttachmentMetadata,
  type PocketAnydocAssetLease,
} from '../../src/services/ChatAttachmentProcessorRegistry';
import { AppError } from '../../src/services/AppError';
import { documentSessionContextCache } from '../../src/services/DocumentSessionContextCache';
import type { ChatAttachment } from '../../src/types/attachments';
import {
  MAX_CHAT_OFFICE_DOCUMENT_ATTACHMENT_BYTES,
  MAX_CHAT_PDF_DOCUMENT_ATTACHMENT_BYTES,
  MAX_CHAT_RTF_EPUB_DOCUMENT_ATTACHMENT_BYTES,
  MAX_CHAT_TEXT_DOCUMENT_ATTACHMENT_BYTES,
} from '../../src/utils/chatAttachments';
import {
  __setPocketAnydocNativeModuleForTests,
  type PocketAnydocNativeModule,
} from '../../modules/pocket-anydoc';

type ChatDocumentAttachment = Extract<ChatAttachment, { kind: 'document' }>;

function bytesToBinaryString(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
}

function encodeAscii85(bytes: Uint8Array): string {
  const encoded: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 4) {
    const available = Math.min(4, bytes.length - offset);
    let value = 0;
    for (let index = 0; index < 4; index += 1) {
      value = value * 256 + (index < available ? bytes[offset + index] : 0);
    }
    if (available === 4 && value === 0) {
      encoded.push('z');
      continue;
    }
    const tuple = new Array<number>(5);
    for (let index = tuple.length - 1; index >= 0; index -= 1) {
      tuple[index] = value % 85;
      value = Math.floor(value / 85);
    }
    encoded.push(...tuple.slice(0, available + 1).map((digit) => String.fromCharCode(digit + 33)));
  }
  return `${encoded.join('')}~>`;
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
    localUri: 'file:///test-dir/chat-attachments/document-1.txt',
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

function createPocketAnydocNativeModule(
  overrides: Partial<PocketAnydocNativeModule> = {},
): jest.Mocked<PocketAnydocNativeModule> {
  return {
    getCapabilities: jest.fn(async () => ({ ok: true, data: {} })),
    getVersion: jest.fn(async () => ({ ok: true, data: {} })),
    prepareDocument: jest.fn(async () => ({
      ok: true,
      data: {
        handle: 'handle-1',
        canonicalFormat: 'docx',
        parserId: 'anydoc',
        parserVersion: '0.1.7',
        exactAnyDocCommit: '4a45addbd607e8b59f0c263bca26aab228e10370',
        sourceByteCount: 128,
        sourceCharCount: 1_000,
        contentSha256: 'b'.repeat(64),
        chunkCount: 3,
        pageCount: 2,
        assetCount: 1,
        warnings: ['assets_skipped'],
      },
    })),
    selectContext: jest.fn(async () => ({
      ok: true,
      data: {
        chunks: [{ index: 1, text: 'Quarterly total is 42.', kind: 'paragraph', pageNumber: 2 }],
        selectedCharCount: 22,
        truncated: true,
        warnings: ['context_truncated'],
      },
    })),
    materializeAsset: jest.fn(async ({ assetId }) => ({
      ok: true,
      data: {
        assetId,
        mediaType: 'image/png',
        byteLength: 512,
        sha256: 'c'.repeat(64),
        width: 32,
        height: 24,
        localUri: `file:///data/user/0/com.pocket/cache/pocket-anydoc-assets/${assetId.toString(16).padStart(32, '0')}.png`,
      },
    })),
    cancel: jest.fn(async () => ({ ok: true, data: { cancelledCount: 1 } })),
    release: jest.fn(async () => ({ ok: true, data: { releasedCount: 1 } })),
    ...overrides,
  } as jest.Mocked<PocketAnydocNativeModule>;
}

describe('ChatAttachmentProcessorRegistry', () => {
  beforeEach(async () => {
    await documentSessionContextCache.clearAll();
    jest.clearAllMocks();
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({
      exists: true,
      isDirectory: false,
      size: 128,
    });
    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue('Document text');
    __setPocketAnydocNativeModuleForTests(undefined);
  });

  afterEach(async () => {
    __setPocketAnydocNativeModuleForTests(undefined);
    await documentSessionContextCache.clearAll();
  });

  it('processes app-owned text documents into bounded text content parts', async () => {
    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue('\uFEFFLine one\r\nLine two');

    const result = await chatAttachmentProcessorRegistry.processAttachment(createDocumentAttachment());

    expect(FileSystem.readAsStringAsync).toHaveBeenCalledWith('file:///test-dir/chat-attachments/document-1.txt', {
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
      contentHash: `sha256:${'a'.repeat(64)}`,
      contentSha256: 'a'.repeat(64),
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
        localUri: 'file:///test-dir/chat-attachments/payload.json',
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

  it('selects only whole structural chunks that fit the configured prompt budget', async () => {
    const firstParagraph = 'alpha '.repeat(70).trim();
    const secondParagraph = 'beta '.repeat(70).trim();
    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue(
      `${firstParagraph}\n\n${secondParagraph}`,
    );

    const result = await chatAttachmentProcessorRegistry.processDocumentTextAttachment(
      createDocumentAttachment(),
      { maxChars: 500 },
    );

    expect(result).toEqual(expect.objectContaining({
      text: firstParagraph,
      truncated: true,
      extractedCharCount: firstParagraph.length,
      sourceCharCount: `${firstParagraph}\n\n${secondParagraph}`.length,
    }));
    expect(buildDocumentAttachmentTextPart(result).text)
      .toContain(`Selected context: ${firstParagraph.length} of ${`${firstParagraph}\n\n${secondParagraph}`.length} characters (truncated)`);
  });

  it('does not count direct-text prose overlap as additional extracted source characters', async () => {
    const source = 'alpha '.repeat(1_500).trim();
    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue(source);

    const result = await chatAttachmentProcessorRegistry.processDocumentTextAttachment(
      createDocumentAttachment(),
      { maxChars: 12_000 },
    );

    expect(result.chunks.length).toBeGreaterThan(1);
    expect(result.text.length).toBeGreaterThan(source.length);
    expect(result.extractedCharCount).toBe(source.length);
    expect(result.sourceCharCount).toBe(source.length);
    expect(withProcessedDocumentAttachmentMetadata(createDocumentAttachment(), result).document)
      .toEqual(expect.objectContaining({
        selectedCharCount: source.length,
        extractedCharCount: source.length,
        sourceCharCount: source.length,
      }));
  });

  it('retains a late relevant whole chunk instead of truncating selected chunks in source order', async () => {
    const earlyParagraph = 'background '.repeat(40).trim();
    const lateRelevantParagraph = 'needle evidence '.repeat(28).trim();
    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue(
      `${earlyParagraph}\n\n${lateRelevantParagraph}`,
    );

    const result = await chatAttachmentProcessorRegistry.processDocumentTextAttachment(
      createDocumentAttachment(),
      { maxChars: 500, query: 'needle evidence' },
    );

    expect(result.text).toBe(lateRelevantParagraph);
    expect(result.text).not.toContain(earlyParagraph);
    expect(result.truncated).toBe(true);
  });

  it('routes direct Markdown through heading-aware chunking and retains section metadata', async () => {
    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue([
      '# Overview',
      'General background.',
      '',
      'Revenue details',
      '---------------',
      'The needle revenue value is 42 credits.',
    ].join('\n'));

    const result = await chatAttachmentProcessorRegistry.processDocumentTextAttachment(
      createDocumentAttachment({
        fileName: 'report.md',
        localUri: 'file:///test-dir/chat-attachments/report.md',
        mimeType: 'text/markdown',
      }),
      { maxChunks: 1, query: 'needle revenue' },
    );

    expect(result.canonicalFormat).toBe('markdown');
    expect(result.chunks).toEqual([
      expect.objectContaining({
        kind: 'paragraph',
        heading: 'Revenue details',
        text: 'The needle revenue value is 42 credits.',
      }),
    ]);
  });

  it('routes direct TSV through row-atomic table chunking and safely omits an oversized row', async () => {
    const oversizedRow = `oversized\t${'x'.repeat(5_000)}`;
    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue([
      'name\tvalue',
      oversizedRow,
      'target\t42',
    ].join('\n'));

    const result = await chatAttachmentProcessorRegistry.processDocumentTextAttachment(
      createDocumentAttachment({
        fileName: 'table.tsv',
        localUri: 'file:///test-dir/chat-attachments/table.tsv',
        mimeType: 'text/tab-separated-values',
      }),
      { maxChars: 800, maxChunks: 3, query: 'target' },
    );

    expect(result.canonicalFormat).toBe('tsv');
    expect(result.chunkCount).toBe(3);
    expect(result.chunks).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'table', text: 'target\t42' }),
    ]));
    expect(result.chunks.every((chunk) => chunk.kind === 'table')).toBe(true);
    expect(result.text).not.toContain(oversizedRow);
    expect(result.warnings).toContain('context_truncated');
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
        localUri: 'file:///test-dir/chat-attachments/report.pdf',
        fileName: 'report.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 2048,
      }),
    );

    expect(FileSystem.readAsStringAsync).toHaveBeenCalledWith('file:///test-dir/chat-attachments/report.pdf', {
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

  it('processes PDFs with ReportLab-style inline images through the local fallback', async () => {
    const compressedPixels = deflate(Uint8Array.from([255, 0, 0, 0, 255, 0]));
    const inlineImage = encodeAscii85(compressedPixels);
    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue(createTextPdfBase64(
      `BT (Visible before image) Tj ET BI /W 2 /H 1 /BPC 8 /CS /RGB /F [/A85 /Fl] ID\n${inlineImage}\nEI BT (Visible after image) Tj ET`,
    ));

    const result = await chatAttachmentProcessorRegistry.processDocumentTextAttachment(
      createDocumentAttachment({
        localUri: 'file:///test-dir/chat-attachments/inline-image.pdf',
        fileName: 'inline-image.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 2048,
      }),
    );

    expect(result).toEqual(expect.objectContaining({
      runtimeInput: 'document_text',
      processorVersion: DOCUMENT_TEXT_PROCESSOR_VERSION,
      text: 'Visible before image\nVisible after image',
      contentHash: `sha256:${'a'.repeat(64)}`,
      contentSha256: 'a'.repeat(64),
      pageCount: 1,
      isScanned: false,
    }));
  });

  it('maps bounded PDF decompression failures to a safe attachment error', async () => {
    const expandedText = `BT (${String('A').repeat(2 * 1024 * 1024)}) Tj ET`;
    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue(createTextPdfBase64(expandedText));

    const error = await expectProcessorError(
      chatAttachmentProcessorRegistry.processDocumentTextAttachment(
        createDocumentAttachment({
          localUri: 'file:///test-dir/chat-attachments/compressed.pdf',
          fileName: 'compressed.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 4096,
        }),
      ),
    );

    expect(error.code).toBe('chat_attachment_document_resource_limit');
    expect(error.details).toEqual(expect.objectContaining({ reason: 'resource_limit' }));
  });

  it('classifies scanned PDFs as deterministic no-text failures', async () => {
    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue(fromByteArray(Buffer.from([
      '%PDF-1.4',
      '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
      '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
      '3 0 obj << /Type /Page /Contents 4 0 R >> endobj',
      '4 0 obj << /Length 11 >> stream',
      'q /Im1 Do Q',
      'endstream endobj',
      '%%EOF',
    ].join('\n'), 'binary')));

    const error = await expectProcessorError(
      chatAttachmentProcessorRegistry.processDocumentTextAttachment(
        createDocumentAttachment({
          localUri: 'file:///test-dir/chat-attachments/scanned.pdf',
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

  it('maps PDFs referencing missing page content objects to a safe parse failure', async () => {
    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue(fromByteArray(Buffer.from([
      '%PDF-1.4',
      '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
      '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
      '3 0 obj << /Type /Page /Contents 99 0 R >> endobj',
      '%%EOF',
    ].join('\n'), 'binary')));

    const error = await expectProcessorError(
      chatAttachmentProcessorRegistry.processDocumentTextAttachment(
        createDocumentAttachment({
          localUri: 'file:///test-dir/chat-attachments/missing-content.pdf',
          fileName: 'missing-content.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 2048,
        }),
      ),
    );

    expect(error.code).toBe('chat_attachment_parse_failed');
    expect(error.details).toEqual(expect.objectContaining({ reason: 'unsupported_structure' }));
    expect(error.message).toBe('PDF uses unsupported compression or document structure.');
    expect(error.message).not.toContain('missing-content.pdf');
    expect(JSON.stringify(error.details)).not.toContain('missing-content.pdf');
  });

  it('reports a stable unavailable-native error for supported Office documents without leaking filenames', async () => {
    const error = await expectProcessorError(
      chatAttachmentProcessorRegistry.processDocumentTextAttachment(
        createDocumentAttachment({
          localUri: 'file:///test-dir/chat-attachments/secret-contract.docx',
          fileName: 'secret-contract.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        }),
      ),
    );

    expect(error.code).toBe('chat_attachment_native_unavailable');
    expect(error.message).not.toContain('secret-contract.docx');
    expect(JSON.stringify(error.details)).not.toContain('secret-contract.docx');
    expect(FileSystem.readAsStringAsync).not.toHaveBeenCalled();
  });

  it('routes Office documents through bounded native prepare/select and releases the handle', async () => {
    const nativeModule = createPocketAnydocNativeModule();
    __setPocketAnydocNativeModuleForTests(nativeModule);
    const result = await chatAttachmentProcessorRegistry.processDocumentTextAttachment(
      createDocumentAttachment({
        localUri: 'file:///test-dir/chat-attachments/report.docx',
        fileName: 'stored.docx',
        displayName: 'Original report.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
      { query: 'What is the quarterly total?' },
    );

    expect(nativeModule.prepareDocument).toHaveBeenCalledWith(expect.objectContaining({
      localUri: 'file:///test-dir/chat-attachments/report.docx',
      displayName: 'Original report.docx',
      sourceSizeBytes: 128,
    }));
    expect(nativeModule.selectContext).toHaveBeenCalledWith(expect.objectContaining({
      handle: 'handle-1',
      query: 'What is the quarterly total?',
    }));
    expect(nativeModule.release).toHaveBeenCalledWith('handle-1');
    expect(FileSystem.readAsStringAsync).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      processorId: 'pocket-anydoc',
      canonicalFormat: 'docx',
      text: 'Quarterly total is 42.',
      contentHash: `sha256:${'b'.repeat(64)}`,
      parserVersion: '0.1.7',
      pageCount: 2,
      assetCount: 1,
      warnings: ['assets_skipped', 'context_truncated'],
    }));
  });

  it.each([
    [
      'a structured extension reported as text/plain',
      'report.docx',
      'text/plain',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
    ['a known PDF MIME renamed to .bin', 'renamed.bin', 'application/pdf', 'application/pdf'],
    [
      'a known DOCX MIME with a misleading .pdf suffix',
      'misleading.pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
    [
      'a generic provider MIME with a controlled DOCX suffix',
      'generic.docx',
      'application/octet-stream',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
  ] as const)('routes %s through native content detection', async (
    _label,
    fileName,
    mimeType,
    declaredMimeType,
  ) => {
    const nativeModule = createPocketAnydocNativeModule();
    __setPocketAnydocNativeModuleForTests(nativeModule);

    await chatAttachmentProcessorRegistry.processDocumentTextAttachment(
      createDocumentAttachment({
        localUri: `file:///test-dir/chat-attachments/${fileName}`,
        fileName,
        mimeType,
      }),
    );

    expect(nativeModule.prepareDocument).toHaveBeenCalledWith(expect.objectContaining({
      declaredMimeType,
    }));
    expect(FileSystem.readAsStringAsync).not.toHaveBeenCalled();
  });

  it.each([
    ['document_too_large', 'max_format_source_bytes', 'chat_attachment_document_too_large'],
    ['resource_limit', 'max_work_units', 'chat_attachment_document_resource_limit'],
  ] as const)('keeps native %s distinct with only its safe limit kind', async (
    nativeCode,
    limit,
    expectedCode,
  ) => {
    const nativeModule = createPocketAnydocNativeModule({
      prepareDocument: jest.fn(async () => ({
        ok: false,
        error: {
          code: nativeCode,
          limit,
          message: 'C:\\private\\secret.docx exceeded an internal parser limit',
          retryable: false,
        },
      })),
    });
    __setPocketAnydocNativeModuleForTests(nativeModule);

    const error = await expectProcessorError(
      chatAttachmentProcessorRegistry.processDocumentTextAttachment(
        createDocumentAttachment({
          localUri: 'file:///test-dir/chat-attachments/secret.docx',
          fileName: 'secret.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        }),
      ),
    );

    expect(error.code).toBe(expectedCode);
    expect(error.details).toEqual(expect.objectContaining({ reason: nativeCode, limit }));
    expect(error.message).not.toContain('secret.docx');
    expect(JSON.stringify(error.details)).not.toContain('private');
  });

  it('requests bounded native overview coverage for explicit summaries', async () => {
    const nativeModule = createPocketAnydocNativeModule();
    __setPocketAnydocNativeModuleForTests(nativeModule);

    await chatAttachmentProcessorRegistry.processDocumentTextAttachment(
      createDocumentAttachment({
        localUri: 'file:///test-dir/chat-attachments/report.docx',
        fileName: 'report.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
      {
        query: 'Перескажи весь документ',
        maxChars: Number.MAX_SAFE_INTEGER,
        maxChunks: Number.MAX_SAFE_INTEGER,
      },
    );

    expect(nativeModule.selectContext).toHaveBeenCalledWith(expect.objectContaining({
      query: '',
      maxChars: 64_000,
      maxChunks: 64,
    }));
  });

  it('defers final skipped-assets warnings until the chat session knows which assets were delivered', async () => {
    const nativeModule = createPocketAnydocNativeModule({
      prepareDocument: jest.fn(async () => ({
        ok: true,
        data: {
          handle: 'asset-handle',
          canonicalFormat: 'docx',
          parserId: 'anydoc',
          parserVersion: '0.1.7',
          exactAnyDocCommit: '4a45addbd607e8b59f0c263bca26aab228e10370',
          sourceByteCount: 128,
          sourceCharCount: 1_000,
          contentSha256: 'e'.repeat(64),
          chunkCount: 3,
          assetCount: 2,
          warnings: [],
        },
      })),
    });
    __setPocketAnydocNativeModuleForTests(nativeModule);

    const result = await chatAttachmentProcessorRegistry.processDocumentTextAttachment(
      createDocumentAttachment({
        localUri: 'file:///test-dir/chat-attachments/assets.docx',
        fileName: 'assets.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
    );

    expect(result.assetCount).toBe(2);
    expect(result.warnings).not.toContain('assets_skipped');
  });

  it('retains an opt-in asset lease through selected-chunk materialization and retries release', async () => {
    const nativeModule = createPocketAnydocNativeModule({
      prepareDocument: jest.fn(async () => ({
        ok: true,
        data: {
          handle: 'leased-handle',
          canonicalFormat: 'docx',
          parserId: 'anydoc',
          parserVersion: '0.1.7',
          exactAnyDocCommit: '4a45addbd607e8b59f0c263bca26aab228e10370',
          sourceByteCount: 128,
          sourceCharCount: 21,
          contentSha256: 'b'.repeat(64),
          chunkCount: 1,
          assetCount: 1,
          assets: [{
            id: 7,
            mediaType: 'image/png',
            byteLength: 512,
            sha256: 'c'.repeat(64),
            width: 32,
            height: 24,
          }],
          warnings: ['assets_skipped'],
        },
      })),
      selectContext: jest.fn(async () => ({
        ok: true,
        data: {
          chunks: [{
            index: 0,
            text: '[asset:7 alt="chart"]',
            kind: 'paragraph',
            assetIds: [7],
          }],
          selectedCharCount: 21,
          truncated: false,
          warnings: ['assets_skipped'],
        },
      })),
      release: jest.fn()
        .mockRejectedValueOnce(new Error('first release failed'))
        .mockResolvedValueOnce({ ok: true, data: { releasedCount: 1 } }),
    });
    __setPocketAnydocNativeModuleForTests(nativeModule);
    let lease: PocketAnydocAssetLease | undefined;

    const result = await chatAttachmentProcessorRegistry.processDocumentTextAttachment(
      createDocumentAttachment({
        localUri: 'file:///test-dir/chat-attachments/assets.docx',
        fileName: 'assets.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
      {
        retainNativeAssetLease: true,
        onNativeAssetLeaseCreated: (createdLease) => {
          lease = createdLease;
        },
      },
    );

    expect(result.nativeAssetLease).toBe(lease);
    expect(nativeModule.release).not.toHaveBeenCalled();
    await expect(lease?.materializeAsset(7)).resolves.toEqual(expect.objectContaining({
      assetId: 7,
      localUri: `file:///data/user/0/com.pocket/cache/pocket-anydoc-assets/${'7'.padStart(32, '0')}.png`,
    }));
    await expect(lease?.release()).rejects.toMatchObject({ code: 'native_failed' });
    await expect(lease?.release()).resolves.toBeUndefined();
    expect(nativeModule.release).toHaveBeenCalledTimes(2);
  });

  it('retains one native parse for query-specific context selection during the app session', async () => {
    const nativeModule = createPocketAnydocNativeModule({
      selectContext: jest.fn(async ({ query }) => {
        const text = query.includes('follow-up')
          ? 'Context selected for the follow-up question.'
          : 'Context selected for the initial question.';
        return {
          ok: true,
          data: {
            chunks: [{ index: query.includes('follow-up') ? 2 : 0, text, kind: 'paragraph' }],
            selectedCharCount: text.length,
            truncated: true,
            warnings: ['context_truncated'],
          },
        };
      }),
    });
    __setPocketAnydocNativeModuleForTests(nativeModule);

    const result = await chatAttachmentProcessorRegistry.processDocumentTextAttachment(
      createDocumentAttachment({
        localUri: 'file:///test-dir/chat-attachments/session.docx',
        fileName: 'session.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
      {
        query: 'initial question',
        retainSessionContextSource: true,
      },
    );
    const source = result.sessionContextSource;

    expect(source?.kind).toBe('native');
    expect(nativeModule.prepareDocument).toHaveBeenCalledTimes(1);
    expect(nativeModule.release).not.toHaveBeenCalled();
    await expect(source?.selectContext({
      query: 'follow-up question',
      maxChars: 64_000,
      maxChunks: 64,
    })).resolves.toEqual(expect.objectContaining({
      text: 'Context selected for the follow-up question.',
      chunks: [expect.objectContaining({ index: 2 })],
    }));
    expect(nativeModule.prepareDocument).toHaveBeenCalledTimes(1);
    expect(nativeModule.selectContext).toHaveBeenCalledTimes(2);

    await source?.release();
    await source?.release();
    expect(nativeModule.release).toHaveBeenCalledTimes(1);
  });

  it('reranks direct-text chunks from bounded session memory without reading the file again', async () => {
    const alpha = `alpha ${'background '.repeat(220)}`.trim();
    const beta = `beta ${'evidence '.repeat(240)}`.trim();
    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue(`${alpha}\n\n${beta}`);

    const result = await chatAttachmentProcessorRegistry.processDocumentTextAttachment(
      createDocumentAttachment(),
      {
        query: 'alpha',
        maxChars: 2_500,
        retainSessionContextSource: true,
      },
    );
    expect(result.text).toContain('alpha');
    expect(result.text).not.toContain('beta');

    const followUp = await result.sessionContextSource?.selectContext({
      query: 'beta evidence',
      maxChars: 2_500,
      maxChunks: 64,
    });
    expect(followUp?.text).toContain('beta');
    expect(followUp?.text).not.toContain('alpha');
    expect(FileSystem.readAsStringAsync).toHaveBeenCalledTimes(1);

    await result.sessionContextSource?.release();
    await expect(result.sessionContextSource?.selectContext({
      query: 'beta',
      maxChars: 2_500,
      maxChunks: 64,
    })).rejects.toMatchObject({ code: 'chat_attachment_parse_failed' });
  });

  it('lets an abort macrotask interrupt a large direct-text session rerank', async () => {
    const paragraphs = Array.from(
      { length: 160 },
      (_, index) => `Section ${index}\n${`searchable-${index} background `.repeat(110)}`,
    );
    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue(paragraphs.join('\n\n'));
    const result = await chatAttachmentProcessorRegistry.processDocumentTextAttachment(
      createDocumentAttachment(),
      {
        query: 'searchable-0',
        maxChars: 4_000,
        retainSessionContextSource: true,
      },
    );
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 0);

    try {
      await expect(result.sessionContextSource?.selectContext({
        query: 'searchable-159',
        maxChars: 4_000,
        maxChunks: 64,
        signal: controller.signal,
      })).rejects.toMatchObject({ code: 'chat_attachment_processing_cancelled' });
    } finally {
      clearTimeout(abortTimer);
      await result.sessionContextSource?.release();
    }
  });

  it('does not run the Base64 PDF fallback after a successful native parse', async () => {
    const nativeModule = createPocketAnydocNativeModule({
      prepareDocument: jest.fn(async () => ({
        ok: true,
        data: {
          handle: 'pdf-handle',
          canonicalFormat: 'pdf',
          parserId: 'anydoc',
          parserVersion: '0.1.7',
          exactAnyDocCommit: '4a45addbd607e8b59f0c263bca26aab228e10370',
          sourceByteCount: 128,
          sourceCharCount: 22,
          contentSha256: 'c'.repeat(64),
          chunkCount: 1,
          pageCount: 1,
          assetCount: 0,
          warnings: [],
        },
      })),
    });
    __setPocketAnydocNativeModuleForTests(nativeModule);

    const result = await chatAttachmentProcessorRegistry.processDocumentTextAttachment(
      createDocumentAttachment({
        localUri: 'file:///test-dir/chat-attachments/report.pdf',
        fileName: 'report.pdf',
        mimeType: 'application/pdf',
      }),
    );

    expect(result.processorId).toBe('pocket-anydoc');
    expect(FileSystem.readAsStringAsync).not.toHaveBeenCalled();
    expect(nativeModule.release).toHaveBeenCalledWith('pdf-handle');
  });

  it('keeps ownership of an unretained native handle until a failed release can be retried', async () => {
    const nativeModule = createPocketAnydocNativeModule();
    (nativeModule.release as jest.Mock).mockRejectedValueOnce(new Error('transient release failure'));
    __setPocketAnydocNativeModuleForTests(nativeModule);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(chatAttachmentProcessorRegistry.processDocumentTextAttachment(
        createDocumentAttachment({
          localUri: 'file:///test-dir/chat-attachments/retry-release.docx',
          fileName: 'retry-release.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        }),
      )).resolves.toEqual(expect.objectContaining({ processorId: 'pocket-anydoc' }));

      expect(nativeModule.release).toHaveBeenCalledTimes(1);
      expect(documentSessionContextCache.getStats().pendingReleaseCount).toBe(1);

      await documentSessionContextCache.retryPendingReleases();

      expect(nativeModule.release).toHaveBeenCalledTimes(2);
      expect(documentSessionContextCache.getStats().pendingReleaseCount).toBe(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('maps native content detection rejection instead of trusting a supported extension', async () => {
    const nativeModule = createPocketAnydocNativeModule({
      prepareDocument: jest.fn(async () => ({
        ok: false,
        error: { code: 'unsupported_format', message: 'unsupported', retryable: false },
      })),
    });
    __setPocketAnydocNativeModuleForTests(nativeModule);

    const error = await expectProcessorError(
      chatAttachmentProcessorRegistry.processDocumentTextAttachment(createDocumentAttachment({
        localUri: 'file:///test-dir/chat-attachments/not-really-office.docx',
        fileName: 'not-really-office.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      })),
    );

    expect(error.code).toBe('chat_attachment_unsupported_type');
    expect(FileSystem.readAsStringAsync).not.toHaveBeenCalled();
  });

  it('cancels native work on abort and releases a stale successful handle', async () => {
    let resolvePrepare!: (value: unknown) => void;
    let markPrepareStarted!: () => void;
    const prepareStarted = new Promise<void>((resolve) => {
      markPrepareStarted = resolve;
    });
    const nativeModule = createPocketAnydocNativeModule({
      prepareDocument: jest.fn(() => {
        markPrepareStarted();
        return new Promise((resolve) => {
          resolvePrepare = resolve;
        });
      }),
    });
    __setPocketAnydocNativeModuleForTests(nativeModule);
    const controller = new AbortController();
    const processing = chatAttachmentProcessorRegistry.processDocumentTextAttachment(
      createDocumentAttachment({
        localUri: 'file:///test-dir/chat-attachments/report.docx',
        fileName: 'report.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
      { signal: controller.signal, requestId: 'abort-request' },
    );
    await prepareStarted;

    controller.abort();
    expect(nativeModule.cancel).toHaveBeenCalledWith('abort-request');
    resolvePrepare({
      ok: true,
      data: {
        handle: 'stale-handle',
        canonicalFormat: 'docx',
        parserId: 'anydoc',
        parserVersion: '0.1.7',
        exactAnyDocCommit: '4a45addbd607e8b59f0c263bca26aab228e10370',
        sourceByteCount: 128,
        sourceCharCount: 100,
        contentSha256: 'd'.repeat(64),
        chunkCount: 1,
        assetCount: 0,
        warnings: [],
      },
    });
    const error = await expectProcessorError(processing);

    expect(error.code).toBe('chat_attachment_processing_cancelled');
    expect(nativeModule.selectContext).not.toHaveBeenCalled();
    expect(nativeModule.release).toHaveBeenCalledWith('stale-handle');
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
          localUri: 'file:///test-dir/chat-attachments/broken.json',
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

  it.each([
    ['text', 'empty.txt', 'text/plain'],
    ['TSV', 'empty.tsv', 'text/tab-separated-values'],
  ] as const)('maps an empty direct %s document to no-extractable-text', async (
    _label,
    fileName,
    mimeType,
  ) => {
    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue(' \r\n\t ');

    const error = await expectProcessorError(
      chatAttachmentProcessorRegistry.processDocumentTextAttachment(
        createDocumentAttachment({
          localUri: `file:///test-dir/chat-attachments/${fileName}`,
          fileName,
          mimeType,
        }),
      ),
    );

    expect(error.code).toBe('chat_attachment_document_no_extractable_text');
    expect(error.details).toEqual(expect.objectContaining({ reason: 'no_extractable_text' }));
  });

  it('keeps whitespace-only JSON on the stable parse-failed contract', async () => {
    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue(' \r\n ');

    const error = await expectProcessorError(
      chatAttachmentProcessorRegistry.processDocumentTextAttachment(
        createDocumentAttachment({
          localUri: 'file:///test-dir/chat-attachments/empty.json',
          fileName: 'empty.json',
          mimeType: 'application/json',
        }),
      ),
    );

    expect(error.code).toBe('chat_attachment_parse_failed');
    expect(error.details).toEqual(expect.objectContaining({ reason: 'invalid_json' }));
  });

  it('rejects malicious direct documents with excessive structural lines before chunk allocation', async () => {
    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue(
      'a\n'.repeat(MAX_DIRECT_DOCUMENT_STRUCTURAL_LINES + 1),
    );

    const error = await expectProcessorError(
      chatAttachmentProcessorRegistry.processDocumentTextAttachment(
        createDocumentAttachment({
          localUri: 'file:///test-dir/chat-attachments/many-lines.tsv',
          fileName: 'many-lines.tsv',
          mimeType: 'text/tab-separated-values',
        }),
      ),
    );

    expect(error.code).toBe('chat_attachment_document_resource_limit');
    expect(error.details).toEqual(expect.objectContaining({
      reason: 'max_direct_lines',
      maxLines: MAX_DIRECT_DOCUMENT_STRUCTURAL_LINES,
    }));
  });

  it('rejects a direct source replaced between read and identity publication', async () => {
    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue('stable-looking text');
    (RNFS.hash as jest.Mock)
      .mockResolvedValueOnce('a'.repeat(64))
      .mockResolvedValueOnce('b'.repeat(64));

    const error = await expectProcessorError(
      chatAttachmentProcessorRegistry.processDocumentTextAttachment(createDocumentAttachment()),
    );

    expect(error.code).toBe('chat_attachment_corrupt');
    expect(error.details).toEqual(expect.objectContaining({ reason: 'source_changed' }));
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

    expect(error.code).toBe('chat_attachment_document_too_large');
    expect(error.details).toEqual(expect.objectContaining({
      maxFileBytes: 1024,
      sizeBytes: 4096,
    }));
    expect(FileSystem.readAsStringAsync).not.toHaveBeenCalled();
  });

  it.each([
    ['direct text', 'oversized.txt', 'text/plain', MAX_CHAT_TEXT_DOCUMENT_ATTACHMENT_BYTES],
    ['CSV', 'oversized.csv', 'text/csv', MAX_CHAT_TEXT_DOCUMENT_ATTACHMENT_BYTES],
    ['PDF', 'oversized.pdf', 'application/pdf', MAX_CHAT_PDF_DOCUMENT_ATTACHMENT_BYTES],
    ['RTF', 'oversized.rtf', 'application/rtf', MAX_CHAT_RTF_EPUB_DOCUMENT_ATTACHMENT_BYTES],
    ['EPUB', 'oversized.epub', 'application/epub+zip', MAX_CHAT_RTF_EPUB_DOCUMENT_ATTACHMENT_BYTES],
    [
      'Office',
      'oversized.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      MAX_CHAT_OFFICE_DOCUMENT_ATTACHMENT_BYTES,
    ],
  ] as const)('maps the %s source-byte cap to document-too-large before parsing', async (
    _label,
    fileName,
    mimeType,
    maxBytes,
  ) => {
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({
      exists: true,
      isDirectory: false,
      size: maxBytes + 1,
    });
    const nativeModule = createPocketAnydocNativeModule();
    __setPocketAnydocNativeModuleForTests(nativeModule);

    const error = await expectProcessorError(
      chatAttachmentProcessorRegistry.processDocumentTextAttachment(
        createDocumentAttachment({ fileName, mimeType, sizeBytes: maxBytes + 1 }),
      ),
    );

    expect(error.code).toBe('chat_attachment_document_too_large');
    expect(error.details).toEqual(expect.objectContaining({ maxFileBytes: maxBytes }));
    expect(nativeModule.prepareDocument).not.toHaveBeenCalled();
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
