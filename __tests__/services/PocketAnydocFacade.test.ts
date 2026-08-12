import {
  __setPocketAnydocNativeModuleForTests,
  cancel,
  getCapabilities,
  getVersion,
  materializeAsset,
  PocketAnydocError,
  prepareDocument,
  release,
  selectContext,
  type PocketAnydocNativeModule,
} from '../../modules/pocket-anydoc';

const ANYDOC_COMMIT = '4a45addbd607e8b59f0c263bca26aab228e10370';
const SHA256 = 'a'.repeat(64);
const ANDROID_ASSET_URI = `file:///data/user/0/com.pocket/cache/pocket-anydoc-assets/${'a'.repeat(32)}.png`;

function privateDocumentUri(fileName: string): string {
  return `file:///data/user/0/com.pocket/files/chat-attachments/${fileName}`;
}

function success(data: unknown): { ok: true; data: unknown } {
  return { ok: true, data };
}

function preparedDocument(handle = 'handle-1') {
  return success({
    handle,
    canonicalFormat: 'docx',
    parserId: 'anydoc',
    parserVersion: '0.1.7',
    exactAnyDocCommit: ANYDOC_COMMIT,
    sourceByteCount: 1_024,
    sourceCharCount: 4_096,
    contentSha256: SHA256,
    chunkCount: 4,
    pageCount: 2,
    assetCount: 0,
    warnings: [],
  });
}

function createNativeModule(
  overrides: Partial<PocketAnydocNativeModule> = {},
): jest.Mocked<PocketAnydocNativeModule> {
  return {
    getCapabilities: jest.fn(async () => success({
      available: true,
      formats: ['docx', 'pdf'],
      maxSourceBytes: 16 * 1024 * 1024,
      maxSelectionChars: 64_000,
      maxSelectionChunks: 64,
      supportsAssets: true,
      supportsCancellation: true,
    })),
    getVersion: jest.fn(async () => success({
      moduleVersion: '1.0.0',
      parserId: 'anydoc',
      parserVersion: '0.1.7',
      exactAnyDocCommit: ANYDOC_COMMIT,
    })),
    prepareDocument: jest.fn(async () => preparedDocument()),
    selectContext: jest.fn(async () => success({
      chunks: [{ index: 0, text: '  preserved text  ', kind: 'paragraph', pageNumber: 1 }],
      selectedCharCount: 18,
      truncated: true,
      warnings: ['context_truncated'],
    })),
    materializeAsset: jest.fn(async ({ assetId }) => success({
      assetId,
      mediaType: 'image/png',
      byteLength: 512,
      sha256: 'c'.repeat(64),
      width: 32,
      height: 24,
      localUri: ANDROID_ASSET_URI,
    })),
    cancel: jest.fn(async () => success({ cancelledCount: 1 })),
    release: jest.fn(async () => success({ releasedCount: 1 })),
    ...overrides,
  } as jest.Mocked<PocketAnydocNativeModule>;
}

function expectPocketAnydocError(error: unknown, code: PocketAnydocError['code']): void {
  expect(error).toBeInstanceOf(PocketAnydocError);
  expect((error as PocketAnydocError).code).toBe(code);
}

describe('PocketAnydoc TypeScript facade', () => {
  afterEach(() => {
    __setPocketAnydocNativeModuleForTests(undefined);
  });

  it('reports a safe unavailable capability without evaluating a missing native module', async () => {
    __setPocketAnydocNativeModuleForTests(null);

    await expect(getCapabilities()).resolves.toEqual(expect.objectContaining({
      available: false,
      formats: [],
      supportsAssets: false,
      supportsCancellation: false,
    }));
    await expect(getVersion()).resolves.toBeNull();
    await expect(prepareDocument({
      requestId: 'request-1',
      localUri: privateDocumentUri('report.docx'),
      sourceSizeBytes: 1_024,
    })).rejects.toMatchObject({ code: 'native_unavailable' });
  });

  it.each([
    ['raw path', 'test-dir/chat-attachments/report.docx'],
    ['content URI', 'content://documents/report.docx'],
    ['HTTPS URI', 'https://example.com/report.docx'],
    ['data URI', 'data:application/octet-stream;base64,AA=='],
    ['query', `${privateDocumentUri('report.docx')}?token=private`],
    ['fragment', `${privateDocumentUri('report.docx')}#private`],
    ['encoded traversal', 'file:///data/user/0/com.pocket/files/%2e%2e/report.docx'],
  ] as const)('rejects a non-canonical prepare %s before invoking native code', async (_label, localUri) => {
    const nativeModule = createNativeModule();
    __setPocketAnydocNativeModuleForTests(nativeModule);

    await expect(prepareDocument({
      requestId: 'invalid-uri-request',
      localUri,
      sourceSizeBytes: 1_024,
    })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(nativeModule.prepareDocument).not.toHaveBeenCalled();
  });

  it('unwraps bounded native envelopes and never returns the full prepared document text', async () => {
    const nativeModule = createNativeModule();
    __setPocketAnydocNativeModuleForTests(nativeModule);

    await expect(getCapabilities()).resolves.toEqual(expect.objectContaining({
      available: true,
      formats: ['docx', 'pdf'],
      supportsAssets: true,
    }));
    await expect(getVersion()).resolves.toEqual(expect.objectContaining({
      parserId: 'anydoc',
      exactAnyDocCommit: ANYDOC_COMMIT,
    }));
    const prepared = await prepareDocument({
      requestId: 'request-1',
      localUri: privateDocumentUri('report.docx'),
      displayName: 'Original report.docx',
      declaredMimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      sourceSizeBytes: 1_024,
    });
    expect(prepared).toEqual(expect.objectContaining({
      handle: 'handle-1',
      canonicalFormat: 'docx',
      exactAnyDocCommit: ANYDOC_COMMIT,
      contentSha256: SHA256,
      chunkCount: 4,
    }));
    expect(prepared).not.toHaveProperty('text');

    await expect(selectContext({
      requestId: 'request-1',
      handle: prepared.handle,
      query: 'What is the total?',
      maxChunks: 4,
      maxChars: 1_000,
    })).resolves.toEqual(expect.objectContaining({
      chunks: [{ index: 0, text: '  preserved text  ', kind: 'paragraph', pageNumber: 1 }],
      selectedCharCount: 18,
      truncated: true,
    }));
    await release(prepared.handle);
    expect(nativeModule.release).toHaveBeenCalledWith('handle-1');
  });

  it.each([
    ['unknown format', { formats: ['docx', 'future-format'] }],
    ['duplicate format', { formats: ['docx', 'docx'] }],
    ['oversized source capability', { maxSourceBytes: (16 * 1024 * 1024) + 1 }],
    ['oversized selection capability', { maxSelectionChunks: 65 }],
  ] as const)('rejects capabilities with %s instead of partially normalizing ABI drift', async (
    _label,
    capabilityOverride,
  ) => {
    const nativeModule = createNativeModule({
      getCapabilities: jest.fn(async () => success({
        available: true,
        formats: ['docx', 'pdf'],
        maxSourceBytes: 16 * 1024 * 1024,
        maxSelectionChars: 64_000,
        maxSelectionChunks: 64,
        supportsAssets: true,
        supportsCancellation: true,
        ...capabilityOverride,
      })),
    });
    __setPocketAnydocNativeModuleForTests(nativeModule);

    await expect(getCapabilities()).rejects.toMatchObject({ code: 'invalid_native_response' });
  });

  it.each([
    ['source bytes', { sourceByteCount: (16 * 1024 * 1024) + 1 }],
    ['source chars', { sourceCharCount: 1_000_001 }],
    ['chunks', { chunkCount: 2_049 }],
    ['pages', { pageCount: 2_049 }],
    ['assets', { assetCount: 129 }],
  ] as const)('rejects an oversized prepared native %s response', async (_label, preparedOverride) => {
    const nativeModule = createNativeModule({
      prepareDocument: jest.fn(async () => success({
        ...(preparedDocument().data as Record<string, unknown>),
        ...preparedOverride,
      })),
    });
    __setPocketAnydocNativeModuleForTests(nativeModule);

    await expect(prepareDocument({
      requestId: 'oversized-native-response',
      localUri: privateDocumentUri('oversized.docx'),
      sourceSizeBytes: 1_024,
    })).rejects.toMatchObject({ code: 'invalid_native_response' });
  });

  it('accepts every canonical bounded native warning without weakening unknown-warning rejection', async () => {
    const warnings = [
      'assets_skipped',
      'context_truncated',
      'format_hint_mismatch',
      'hidden_content_unverified',
      'hidden_rows_skipped',
      'partial_content',
      'unsupported_assets',
    ];
    const nativeModule = createNativeModule({
      prepareDocument: jest.fn(async () => success({
        ...(preparedDocument().data as Record<string, unknown>),
        warnings,
      })),
      selectContext: jest.fn(async () => success({
        chunks: [{ index: 0, text: 'bounded', kind: 'paragraph' }],
        selectedCharCount: 7,
        truncated: true,
        warnings,
      })),
    });
    __setPocketAnydocNativeModuleForTests(nativeModule);

    await expect(prepareDocument({
      requestId: 'warning-request',
      localUri: privateDocumentUri('renamed.xls'),
      sourceSizeBytes: 1_024,
    })).resolves.toEqual(expect.objectContaining({ warnings }));
    await expect(selectContext({
      requestId: 'warning-select',
      handle: 'handle-1',
      query: '',
      maxChunks: 1,
      maxChars: 32,
    })).resolves.toEqual(expect.objectContaining({ warnings }));
  });

  it('rejects malformed, oversized, or unknown-warning selection envelopes', async () => {
    const nativeModule = createNativeModule({
      selectContext: jest.fn(async () => success({
        chunks: [{ index: 0, text: 'bounded', kind: 'paragraph' }],
        selectedCharCount: 999,
        truncated: false,
        warnings: ['unexpected_warning'],
      })),
    });
    __setPocketAnydocNativeModuleForTests(nativeModule);

    await expect(selectContext({
      requestId: 'request-1',
      handle: 'handle-1',
      query: '',
      maxChunks: 1,
      maxChars: 8,
    })).rejects.toMatchObject({ code: 'invalid_native_response' });
    await expect(selectContext({
      requestId: 'request-2',
      handle: 'handle-1',
      query: '',
      maxChunks: 65,
      maxChars: 8,
    })).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('preserves bounded asset linkage metadata without accepting asset payloads or paths', async () => {
    const descriptor = {
      id: 7,
      mediaType: 'image/png',
      byteLength: 512,
      sha256: 'c'.repeat(64),
      width: 32,
      height: 24,
    };
    const nativeModule = createNativeModule({
      prepareDocument: jest.fn(async () => success({
        handle: 'asset-handle',
        canonicalFormat: 'docx',
        parserId: 'anydoc',
        parserVersion: '0.1.7',
        exactAnyDocCommit: ANYDOC_COMMIT,
        sourceByteCount: 1_024,
        sourceCharCount: 4_096,
        contentSha256: SHA256,
        chunkCount: 1,
        assetCount: 1,
        assets: [descriptor],
        warnings: ['assets_skipped'],
      })),
      selectContext: jest.fn(async () => success({
        chunks: [{
          index: 0,
          text: '[asset:7 alt="chart"]',
          kind: 'paragraph',
          assetIds: [7],
        }],
        selectedCharCount: 21,
        truncated: false,
        warnings: ['assets_skipped'],
      })),
    });
    __setPocketAnydocNativeModuleForTests(nativeModule);

    const prepared = await prepareDocument({
      requestId: 'asset-request',
      localUri: privateDocumentUri('assets.docx'),
      sourceSizeBytes: 1_024,
    });
    expect(prepared.assets).toEqual([descriptor]);
    await expect(selectContext({
      requestId: 'asset-request',
      handle: prepared.handle,
      query: '',
      maxChunks: 1,
      maxChars: 100,
    })).resolves.toEqual(expect.objectContaining({
      chunks: [expect.objectContaining({ assetIds: [7] })],
    }));

    __setPocketAnydocNativeModuleForTests(createNativeModule({
      prepareDocument: jest.fn(async () => success({
        handle: 'unsafe-handle',
        canonicalFormat: 'docx',
        parserId: 'anydoc',
        parserVersion: '0.1.7',
        exactAnyDocCommit: ANYDOC_COMMIT,
        sourceByteCount: 1_024,
        contentSha256: SHA256,
        chunkCount: 1,
        assetCount: 1,
        assets: [{ ...descriptor, localUri: 'file:///private/chart.png' }],
        warnings: [],
      })),
    }));
    await expect(prepareDocument({
      requestId: 'unsafe-asset-request',
      localUri: privateDocumentUri('unsafe.docx'),
      sourceSizeBytes: 1_024,
    })).rejects.toMatchObject({ code: 'invalid_native_response' });
  });

  it('rejects retained asset descriptors without validated dimensions', async () => {
    const nativeModule = createNativeModule({
      prepareDocument: jest.fn(async () => success({
        ...(preparedDocument('missing-dimensions').data as Record<string, unknown>),
        assetCount: 1,
        assets: [{
          id: 1,
          mediaType: 'image/png',
          byteLength: 512,
          sha256: 'c'.repeat(64),
        }],
      })),
    });
    __setPocketAnydocNativeModuleForTests(nativeModule);

    await expect(prepareDocument({
      requestId: 'missing-dimensions-request',
      localUri: privateDocumentUri('missing-dimensions.docx'),
      sourceSizeBytes: 1_024,
    })).rejects.toMatchObject({ code: 'invalid_native_response' });
  });

  it('materializes only bounded private raster assets without bridging bytes', async () => {
    const nativeModule = createNativeModule();
    __setPocketAnydocNativeModuleForTests(nativeModule);

    await expect(materializeAsset({
      requestId: 'asset-request',
      handle: 'asset-handle',
      assetId: 7,
    })).resolves.toEqual({
      assetId: 7,
      id: 7,
      mediaType: 'image/png',
      byteLength: 512,
      sha256: 'c'.repeat(64),
      width: 32,
      height: 24,
      localUri: ANDROID_ASSET_URI,
    });
    expect(nativeModule.materializeAsset).toHaveBeenCalledWith({
      requestId: 'asset-request',
      handle: 'asset-handle',
      assetId: 7,
    });

    __setPocketAnydocNativeModuleForTests(createNativeModule({
      materializeAsset: jest.fn(async () => success({
        assetId: 7,
        mediaType: 'image/png',
        byteLength: 512,
        sha256: 'c'.repeat(64),
        width: 32,
        height: 24,
        localUri: 'https://example.com/private.png',
      })),
    }));
    await expect(materializeAsset({
      requestId: 'unsafe-asset-request',
      handle: 'unsafe-handle',
      assetId: 7,
    })).rejects.toMatchObject({ code: 'invalid_native_response' });
  });

  it.each([
    [
      'Android',
      `file:///data/user/0/com.pocket/cache/pocket-anydoc-assets/${'1'.repeat(32)}.png`,
      'image/png',
    ],
    [
      'iOS',
      `file:///var/mobile/Containers/Data/Application/12345678-ABCD/Library/Caches/pocket-anydoc-assets/${'b'.repeat(32)}.jpg`,
      'image/jpeg',
    ],
  ] as const)('accepts a canonical %s private asset URI', async (_platform, localUri, mediaType) => {
    __setPocketAnydocNativeModuleForTests(createNativeModule({
      materializeAsset: jest.fn(async () => success({
        assetId: 7,
        mediaType,
        byteLength: 512,
        sha256: 'c'.repeat(64),
        width: 32,
        height: 24,
        localUri,
      })),
    }));

    await expect(materializeAsset({
      requestId: `${_platform.toLowerCase()}-asset-request`,
      handle: `${_platform.toLowerCase()}-asset-handle`,
      assetId: 7,
    })).resolves.toEqual(expect.objectContaining({ localUri, mediaType }));
  });

  it.each([
    [
      'an arbitrary private file',
      'file:///data/user/0/com.pocket/files/private-config.png',
    ],
    [
      'a sibling directory',
      `file:///data/user/0/com.pocket/cache/pocket-anydoc-assets-backup/${'a'.repeat(32)}.png`,
    ],
    [
      'a malformed basename',
      `file:///data/user/0/com.pocket/cache/pocket-anydoc-assets/${'A'.repeat(32)}.png`,
    ],
    [
      'encoded traversal',
      `file:///data/user/0/com.pocket/cache/%2e%2e/pocket-anydoc-assets/${'a'.repeat(32)}.png`,
    ],
    [
      'double-encoded traversal',
      `file:///data/user/0/com.pocket/cache/%252e%252e/pocket-anydoc-assets/${'a'.repeat(32)}.png`,
    ],
    [
      'an encoded basename',
      `file:///data/user/0/com.pocket/cache/pocket-anydoc-assets/%61${'a'.repeat(31)}.png`,
    ],
    [
      'a query suffix',
      `file:///data/user/0/com.pocket/cache/pocket-anydoc-assets/${'a'.repeat(32)}.png?token=private`,
    ],
    [
      'a fragment suffix',
      `file:///data/user/0/com.pocket/cache/pocket-anydoc-assets/${'a'.repeat(32)}.png#private`,
    ],
    [
      'a control character',
      `file:///data/user/0/com.pocket/cache/pocket-anydoc-assets/${'a'.repeat(32)}.png\nforged`,
    ],
  ] as const)('rejects %s in a materialized asset URI', async (_label, localUri) => {
    __setPocketAnydocNativeModuleForTests(createNativeModule({
      materializeAsset: jest.fn(async () => success({
        assetId: 7,
        mediaType: 'image/png',
        byteLength: 512,
        sha256: 'c'.repeat(64),
        width: 32,
        height: 24,
        localUri,
      })),
    }));

    await expect(materializeAsset({
      requestId: 'invalid-private-asset-request',
      handle: 'invalid-private-asset-handle',
      assetId: 7,
    })).rejects.toMatchObject({ code: 'invalid_native_response' });
  });

  it('accepts safe GIF/WebP descriptors without treating them as bridge payloads', async () => {
    const descriptors = ['image/gif', 'image/webp'].map((mediaType, id) => ({
      id,
      mediaType,
      byteLength: 512,
      sha256: String(id).repeat(64),
      width: 32,
      height: 24,
    }));
    __setPocketAnydocNativeModuleForTests(createNativeModule({
      prepareDocument: jest.fn(async () => success({
        ...(preparedDocument('safe-raster-handle').data as Record<string, unknown>),
        assetCount: descriptors.length,
        assets: descriptors,
        warnings: ['unsupported_assets'],
      })),
    }));

    await expect(prepareDocument({
      requestId: 'safe-raster-request',
      localUri: privateDocumentUri('safe-raster.docx'),
      sourceSizeBytes: 1_024,
    })).resolves.toEqual(expect.objectContaining({ assets: descriptors }));
  });

  it('maps native error envelopes to stable privacy-safe codes', async () => {
    const nativeModule = createNativeModule({
      prepareDocument: jest.fn(async () => ({
        ok: false,
        error: {
          code: 'conversion_cancelled',
          message: 'untrusted native detail',
          retryable: true,
        },
      })),
    });
    __setPocketAnydocNativeModuleForTests(nativeModule);

    try {
      await prepareDocument({
        requestId: 'request-1',
        localUri: privateDocumentUri('report.docx'),
        sourceSizeBytes: 1_024,
      });
      throw new Error('Expected prepareDocument to reject.');
    } catch (error) {
      expectPocketAnydocError(error, 'cancelled');
      expect((error as Error).message).not.toContain('untrusted native detail');
    }
  });

  it.each([
    ['document_too_large', 'max_format_source_bytes'],
    ['resource_limit', 'max_work_units'],
  ] as const)('preserves the safe %s limit kind without exposing native details', async (code, limit) => {
    __setPocketAnydocNativeModuleForTests(createNativeModule({
      prepareDocument: jest.fn(async () => ({
        ok: false,
        error: {
          code,
          limit,
          message: 'C:\\private\\secret.docx exceeded a native limit',
          retryable: false,
        },
      })),
    }));

    await expect(prepareDocument({
      requestId: `${code}-request`,
      localUri: privateDocumentUri('secret.docx'),
      sourceSizeBytes: 1_024,
    })).rejects.toEqual(expect.objectContaining({
      code,
      limit,
      message: `Pocket AnyDoc failed (${code}).`,
    }));
  });

  it('maps native duplicate request errors to the same invalid-request contract as JS guards', async () => {
    __setPocketAnydocNativeModuleForTests(createNativeModule({
      prepareDocument: jest.fn(async () => ({
        ok: false,
        error: {
          code: 'duplicate_request',
          message: 'private native scheduling detail',
          retryable: true,
        },
      })),
    }));

    await expect(prepareDocument({
      requestId: 'duplicate-request',
      localUri: privateDocumentUri('duplicate.docx'),
      sourceSizeBytes: 1_024,
    })).rejects.toEqual(expect.objectContaining({
      code: 'invalid_request',
      message: 'Pocket AnyDoc failed (invalid_request).',
    }));
  });

  it('accepts canonical count envelopes for cancel and release without depending on their shape', async () => {
    const nativeModule = createNativeModule({
      cancel: jest.fn(async () => success({ cancelledCount: 3 })),
      release: jest.fn(async () => success({ releasedCount: 2 })),
    });
    __setPocketAnydocNativeModuleForTests(nativeModule);

    await expect(cancel('count-request')).resolves.toBeUndefined();
    await expect(release('count-handle')).resolves.toBeUndefined();
    expect(nativeModule.cancel).toHaveBeenCalledWith('count-request');
    expect(nativeModule.release).toHaveBeenCalledWith('count-handle');
  });

  it('serializes heavy operations globally at concurrency one', async () => {
    let resolveFirst!: (value: unknown) => void;
    let markFirstStarted!: () => void;
    const firstResult = new Promise<unknown>((resolve) => {
      resolveFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const nativeModule = createNativeModule({
      prepareDocument: jest.fn()
        .mockImplementationOnce(() => {
          markFirstStarted();
          return firstResult;
        })
        .mockResolvedValueOnce(preparedDocument('handle-2')),
    });
    __setPocketAnydocNativeModuleForTests(nativeModule);

    const first = prepareDocument({
      requestId: 'request-1',
      localUri: privateDocumentUri('first.docx'),
      sourceSizeBytes: 1_024,
    });
    const second = prepareDocument({
      requestId: 'request-2',
      localUri: privateDocumentUri('second.docx'),
      sourceSizeBytes: 1_024,
    });
    await firstStarted;
    expect(nativeModule.prepareDocument).toHaveBeenCalledTimes(1);

    resolveFirst(preparedDocument('handle-1'));
    await expect(first).resolves.toMatchObject({ handle: 'handle-1' });
    await expect(second).resolves.toMatchObject({ handle: 'handle-2' });
    expect(nativeModule.prepareDocument).toHaveBeenCalledTimes(2);
  });

  it('calls native cancel immediately and prevents cancelled queued work from starting', async () => {
    let resolveFirst!: (value: unknown) => void;
    const firstResult = new Promise<unknown>((resolve) => {
      resolveFirst = resolve;
    });
    const nativeModule = createNativeModule({
      prepareDocument: jest.fn().mockImplementationOnce(() => firstResult),
    });
    __setPocketAnydocNativeModuleForTests(nativeModule);

    const first = prepareDocument({
      requestId: 'request-1',
      localUri: privateDocumentUri('first.docx'),
      sourceSizeBytes: 1_024,
    });
    const queued = prepareDocument({
      requestId: 'request-2',
      localUri: privateDocumentUri('second.docx'),
      sourceSizeBytes: 1_024,
    });
    await Promise.resolve();

    const cancellation = cancel('request-2');
    expect(nativeModule.cancel).toHaveBeenCalledWith('request-2');
    await cancellation;
    resolveFirst(preparedDocument('handle-1'));
    await first;
    await expect(queued).rejects.toMatchObject({ code: 'cancelled' });
    expect(nativeModule.prepareDocument).toHaveBeenCalledTimes(1);
  });
});
