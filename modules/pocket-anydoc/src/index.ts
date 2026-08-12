export const POCKET_ANYDOC_NATIVE_MODULE_NAME = 'PocketAnydoc';

export const POCKET_ANYDOC_MAX_REQUEST_ID_CHARS = 96;
export const POCKET_ANYDOC_MAX_HANDLE_CHARS = 256;
export const POCKET_ANYDOC_MAX_QUERY_CHARS = 16_384;
export const POCKET_ANYDOC_MAX_SELECTION_CHARS = 64_000;
export const POCKET_ANYDOC_MAX_SELECTION_CHUNKS = 64;
export const POCKET_ANYDOC_MAX_SOURCE_BYTES = 16 * 1024 * 1024;
export const POCKET_ANYDOC_MAX_SOURCE_CHARS = 1_000_000;
export const POCKET_ANYDOC_MAX_DOCUMENT_CHUNKS = 2_048;
export const POCKET_ANYDOC_MAX_STRUCTURAL_COUNT = 2_048;
export const POCKET_ANYDOC_MAX_ASSET_DESCRIPTORS = 128;
export const POCKET_ANYDOC_MAX_MATERIALIZED_ASSET_BYTES = 8 * 1024 * 1024;

export type PocketAnydocCanonicalFormat =
  | 'csv'
  | 'doc'
  | 'docm'
  | 'docx'
  | 'epub'
  | 'odp'
  | 'ods'
  | 'odt'
  | 'pdf'
  | 'pot'
  | 'pps'
  | 'ppsm'
  | 'ppsx'
  | 'ppt'
  | 'pptm'
  | 'pptx'
  | 'rtf'
  | 'xls'
  | 'xlsb'
  | 'xlsm'
  | 'xlsx';

export type PocketAnydocChunkKind =
  | 'code'
  | 'heading'
  | 'list'
  | 'paragraph'
  | 'sheet'
  | 'slide'
  | 'table'
  | 'unknown';

export type PocketAnydocErrorCode =
  | 'cancelled'
  | 'corrupt_document'
  | 'document_too_large'
  | 'encrypted_document'
  | 'invalid_native_response'
  | 'invalid_request'
  | 'native_failed'
  | 'native_unavailable'
  | 'no_extractable_text'
  | 'resource_limit'
  | 'semantic_spreadsheet'
  | 'unsupported_format';

export type PocketAnydocWarningCode =
  | 'assets_skipped'
  | 'context_truncated'
  | 'format_hint_mismatch'
  | 'hidden_content_unverified'
  | 'hidden_rows_skipped'
  | 'partial_content'
  | 'unsupported_assets';

export interface PocketAnydocCapabilities {
  available: boolean;
  formats: PocketAnydocCanonicalFormat[];
  maxSourceBytes?: number;
  maxSelectionChars: number;
  maxSelectionChunks: number;
  supportsAssets: boolean;
  supportsCancellation: boolean;
}

export interface PocketAnydocVersion {
  moduleVersion: string;
  parserId: string;
  parserVersion: string;
  exactAnyDocCommit: string;
}

export interface PocketAnydocPrepareRequest {
  requestId: string;
  localUri: string;
  displayName?: string;
  declaredMimeType?: string;
  sourceSizeBytes: number;
}

export interface PocketAnydocPreparedDocument {
  handle: string;
  canonicalFormat: PocketAnydocCanonicalFormat;
  parserId: string;
  parserVersion: string;
  exactAnyDocCommit: string;
  sourceByteCount: number;
  sourceCharCount?: number;
  contentSha256: string;
  chunkCount: number;
  pageCount?: number;
  slideCount?: number;
  sheetCount?: number;
  assetCount?: number;
  assets?: PocketAnydocAssetDescriptor[];
  warnings: PocketAnydocWarningCode[];
}

export interface PocketAnydocAssetDescriptor {
  id: number;
  mediaType: string;
  byteLength: number;
  sha256: string;
  width: number;
  height: number;
}

export interface PocketAnydocSelectContextRequest {
  requestId: string;
  handle: string;
  query: string;
  maxChunks: number;
  maxChars: number;
  cursor?: string;
}

export interface PocketAnydocMaterializeAssetRequest {
  requestId: string;
  handle: string;
  assetId: number;
}

export interface PocketAnydocMaterializedAsset extends PocketAnydocAssetDescriptor {
  assetId: number;
  width: number;
  height: number;
  localUri: string;
}

export interface PocketAnydocContextChunk {
  index: number;
  text: string;
  kind: PocketAnydocChunkKind;
  heading?: string;
  pageNumber?: number;
  slideNumber?: number;
  sheetName?: string;
  assetIds?: number[];
}

export interface PocketAnydocContextSelection {
  chunks: PocketAnydocContextChunk[];
  selectedCharCount: number;
  truncated: boolean;
  nextCursor?: string;
  warnings: PocketAnydocWarningCode[];
}

export interface PocketAnydocNativeModule {
  getCapabilities(): Promise<unknown>;
  getVersion(): Promise<unknown>;
  prepareDocument(request: PocketAnydocPrepareRequest): Promise<unknown>;
  selectContext(request: PocketAnydocSelectContextRequest): Promise<unknown>;
  materializeAsset(request: PocketAnydocMaterializeAssetRequest): Promise<unknown>;
  cancel(requestId: string): Promise<unknown> | unknown;
  release(handle: string): Promise<unknown> | unknown;
}

const CANONICAL_FORMATS = new Set<PocketAnydocCanonicalFormat>([
  'csv', 'doc', 'docm', 'docx', 'epub', 'odp', 'ods', 'odt', 'pdf', 'pot', 'pps',
  'ppsm', 'ppsx', 'ppt', 'pptm', 'pptx', 'rtf', 'xls', 'xlsb', 'xlsm', 'xlsx',
]);
const CHUNK_KINDS = new Set<PocketAnydocChunkKind>([
  'code', 'heading', 'list', 'paragraph', 'sheet', 'slide', 'table', 'unknown',
]);
const WARNING_CODES = new Set<PocketAnydocWarningCode>([
  'assets_skipped', 'context_truncated', 'format_hint_mismatch', 'hidden_content_unverified',
  'hidden_rows_skipped', 'partial_content',
  'unsupported_assets',
]);
const ERROR_CODES = new Set<PocketAnydocErrorCode>([
  'cancelled', 'corrupt_document', 'document_too_large', 'encrypted_document',
  'invalid_native_response', 'invalid_request', 'native_failed', 'native_unavailable',
  'no_extractable_text', 'resource_limit', 'semantic_spreadsheet', 'unsupported_format',
]);
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]+$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MEDIA_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u;
const LIMIT_KIND_PATTERN = /^[a-z0-9_]{1,64}$/u;
const SAFE_RASTER_MEDIA_TYPES = new Set([
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);
const PRIVATE_ASSET_URI_SUFFIX_PATTERN = /\/pocket-anydoc-assets\/[a-f0-9]{32}\.(?:gif|jpg|png|webp)$/u;
const URI_CONTROL_PATTERN = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const FORBIDDEN_ASSET_PAYLOAD_KEYS = new Set([
  'base64', 'bytes', 'data', 'externalUrl', 'localUri', 'path', 'uri', 'url',
]);

let nativeModuleOverride: PocketAnydocNativeModule | null | undefined;
let resolvedNativeModule: PocketAnydocNativeModule | null | undefined;
let serializedTail: Promise<void> = Promise.resolve();
const cancelledRequestIds = new Set<string>();
const pendingRequestIds = new Set<string>();

export class PocketAnydocError extends Error {
  public readonly code: PocketAnydocErrorCode;
  public readonly limit?: string;

  constructor(
    code: PocketAnydocErrorCode,
    message: string,
    options: { cause?: unknown; limit?: string } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'PocketAnydocError';
    this.code = code;
    this.limit = options.limit;
    Object.setPrototypeOf(this, PocketAnydocError.prototype);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown, maxChars: number, pattern?: RegExp): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxChars || (pattern && !pattern.test(normalized))) {
    return null;
  }
  return normalized;
}

function readChunkText(value: unknown, maxChars: number): string | null {
  return typeof value === 'string' && value.length <= maxChars && value.trim().length > 0
    ? value
    : null;
}

function readNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function readPositiveInteger(value: unknown): number | null {
  const normalized = readNonNegativeInteger(value);
  return normalized !== null && normalized > 0 ? normalized : null;
}

function readOptionalPositiveInteger(value: unknown): number | undefined | null {
  if (value === undefined || value === null) {
    return undefined;
  }
  return readPositiveInteger(value);
}

function readWarningCodes(value: unknown): PocketAnydocWarningCode[] | null {
  if (!Array.isArray(value) || value.length > 32) {
    return null;
  }
  if (value.some((entry) => (
    typeof entry !== 'string' || !WARNING_CODES.has(entry as PocketAnydocWarningCode)
  ))) {
    return null;
  }
  const warnings = value as PocketAnydocWarningCode[];
  return [...new Set(warnings)];
}

function readAssetDescriptors(value: unknown): PocketAnydocAssetDescriptor[] | undefined | null {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length > POCKET_ANYDOC_MAX_ASSET_DESCRIPTORS) {
    return null;
  }
  const seenIds = new Set<number>();
  const assets: PocketAnydocAssetDescriptor[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry)
      || Object.keys(entry).some((key) => FORBIDDEN_ASSET_PAYLOAD_KEYS.has(key))
    ) {
      return null;
    }
    const id = readNonNegativeInteger(entry.id);
    const mediaType = readString(entry.mediaType, 128, MEDIA_TYPE_PATTERN);
    const byteLength = readPositiveInteger(entry.byteLength);
    const sha256 = readString(entry.sha256, 64, SHA256_PATTERN);
    const width = readPositiveInteger(entry.width);
    const height = readPositiveInteger(entry.height);
    if (
      id === null || seenIds.has(id) || !mediaType
      || !SAFE_RASTER_MEDIA_TYPES.has(mediaType)
      || !byteLength || byteLength > POCKET_ANYDOC_MAX_MATERIALIZED_ASSET_BYTES || !sha256
      || !width || !height
      || width > 16_384 || height > 16_384 || width * height > 40_000_000
    ) {
      return null;
    }
    seenIds.add(id);
    assets.push({
      id,
      mediaType,
      byteLength,
      sha256,
      width,
      height,
    });
  }
  return assets;
}

function readAssetIds(value: unknown): number[] | undefined | null {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length > POCKET_ANYDOC_MAX_ASSET_DESCRIPTORS) {
    return null;
  }
  const assetIds = value.map(readNonNegativeInteger);
  if (
    assetIds.some((id): id is null => id === null)
    || assetIds.some((id, index) => index > 0 && id! <= assetIds[index - 1]!)
  ) {
    return null;
  }
  return assetIds as number[];
}

function readPrivateCacheLocalUri(value: unknown): string | null {
  const localUri = readCanonicalPrivateFileUri(value);
  return localUri && PRIVATE_ASSET_URI_SUFFIX_PATTERN.test(localUri) ? localUri : null;
}

function readCanonicalPrivateFileUri(value: unknown): string | null {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 4_096
    || !/^file:\/\/\/(?!\/)/u.test(value)
    || URI_CONTROL_PATTERN.test(value)
    || /[\\?#]/u.test(value)
  ) {
    return null;
  }
  let decoded = value;
  for (let depth = 0; depth < 3; depth += 1) {
    let nextDecoded: string;
    try {
      nextDecoded = decodeURIComponent(decoded);
    } catch {
      return null;
    }
    if (
      !/^file:\/\/\/(?!\/)/u.test(nextDecoded)
      || URI_CONTROL_PATTERN.test(nextDecoded)
      || /[\\?#]/u.test(nextDecoded)
      || nextDecoded.replace(/\\/gu, '/').split('/').some(
        (segment) => segment === '.' || segment === '..',
      )
    ) {
      return null;
    }
    if (nextDecoded === decoded) {
      break;
    }
    decoded = nextDecoded;
  }
  return value;
}

function requireValidRequestId(value: string): string {
  const requestId = readString(value, POCKET_ANYDOC_MAX_REQUEST_ID_CHARS, SAFE_IDENTIFIER_PATTERN);
  if (!requestId) {
    throw new PocketAnydocError('invalid_request', 'Pocket AnyDoc request id is invalid.');
  }
  return requestId;
}

function requireValidHandle(value: string): string {
  const handle = readString(value, POCKET_ANYDOC_MAX_HANDLE_CHARS, SAFE_IDENTIFIER_PATTERN);
  if (!handle) {
    throw new PocketAnydocError('invalid_request', 'Pocket AnyDoc handle is invalid.');
  }
  return handle;
}

function resolveNativeModule(): PocketAnydocNativeModule | null {
  if (nativeModuleOverride !== undefined) {
    return nativeModuleOverride;
  }
  if (resolvedNativeModule !== undefined) {
    return resolvedNativeModule;
  }
  try {
    const expoModulesCore = require('expo-modules-core') as {
      requireOptionalNativeModule: <T>(moduleName: string) => T | null;
    };
    resolvedNativeModule = expoModulesCore.requireOptionalNativeModule<PocketAnydocNativeModule>(
      POCKET_ANYDOC_NATIVE_MODULE_NAME,
    ) ?? null;
  } catch {
    resolvedNativeModule = null;
  }
  return resolvedNativeModule;
}

function requireNativeModule(): PocketAnydocNativeModule {
  const module = resolveNativeModule();
  if (!module) {
    throw new PocketAnydocError(
      'native_unavailable',
      'Pocket AnyDoc native document processing is unavailable in this build.',
    );
  }
  return module;
}

function mapNativeErrorCode(rawCode: string): PocketAnydocErrorCode {
  const normalized = rawCode.trim().toLowerCase();
  if (ERROR_CODES.has(normalized as PocketAnydocErrorCode)) {
    return normalized as PocketAnydocErrorCode;
  }
  switch (normalized) {
    case 'conversion_cancelled':
      return 'cancelled';
    case 'duplicate_request':
      return 'invalid_request';
    case 'malformed_document':
      return 'corrupt_document';
    case 'spreadsheet_semantics':
      return 'semantic_spreadsheet';
    default:
      return normalized.startsWith('invalid_') && normalized !== 'invalid_native_response'
        ? 'invalid_request'
        : 'native_failed';
  }
}

function normalizeNativeError(error: unknown): PocketAnydocError {
  if (error instanceof PocketAnydocError) {
    return error;
  }
  const rawCode = isRecord(error) && typeof error.code === 'string'
    ? error.code.trim().toLowerCase()
    : '';
  const code = mapNativeErrorCode(rawCode);
  const limit = isRecord(error)
    ? readString(error.limit, 64, LIMIT_KIND_PATTERN) ?? undefined
    : undefined;
  return new PocketAnydocError(code, `Pocket AnyDoc failed (${code}).`, { cause: error, limit });
}

function unwrapNativeEnvelope(value: unknown): unknown {
  if (!isRecord(value) || typeof value.ok !== 'boolean') {
    throw new PocketAnydocError('invalid_native_response', 'Pocket AnyDoc response envelope is invalid.');
  }
  if (value.ok) {
    if (!Object.prototype.hasOwnProperty.call(value, 'data')) {
      throw new PocketAnydocError('invalid_native_response', 'Pocket AnyDoc response data is missing.');
    }
    return value.data;
  }
  if (!isRecord(value.error) || typeof value.error.code !== 'string') {
    throw new PocketAnydocError('invalid_native_response', 'Pocket AnyDoc error envelope is invalid.');
  }
  const code = mapNativeErrorCode(value.error.code);
  const limit = value.error.limit === undefined || value.error.limit === null
    ? undefined
    : readString(value.error.limit, 64, LIMIT_KIND_PATTERN);
  if (limit === null) {
    throw new PocketAnydocError('invalid_native_response', 'Pocket AnyDoc error limit is invalid.');
  }
  throw new PocketAnydocError(code, `Pocket AnyDoc failed (${code}).`, {
    cause: { code: value.error.code },
    ...(limit === undefined ? null : { limit }),
  });
}

async function runSerialized<T>(requestId: string, operation: () => Promise<T>): Promise<T> {
  if (pendingRequestIds.has(requestId)) {
    throw new PocketAnydocError('invalid_request', 'Pocket AnyDoc request id is already active.');
  }
  pendingRequestIds.add(requestId);
  const previous = serializedTail;
  let releaseTurn!: () => void;
  serializedTail = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });
  await previous.catch(() => undefined);
  try {
    if (cancelledRequestIds.has(requestId)) {
      throw new PocketAnydocError('cancelled', 'Pocket AnyDoc request was cancelled.');
    }
    return await operation();
  } catch (error) {
    throw normalizeNativeError(error);
  } finally {
    cancelledRequestIds.delete(requestId);
    pendingRequestIds.delete(requestId);
    releaseTurn();
  }
}

function parseCapabilities(value: unknown): PocketAnydocCapabilities {
  if (!isRecord(value)) {
    throw new PocketAnydocError('invalid_native_response', 'Pocket AnyDoc capabilities are invalid.');
  }
  const formats = Array.isArray(value.formats)
    && value.formats.length > 0
    && value.formats.every((entry): entry is PocketAnydocCanonicalFormat => (
      typeof entry === 'string' && CANONICAL_FORMATS.has(entry as PocketAnydocCanonicalFormat)
    ))
    ? value.formats
    : null;
  const maxSourceBytes = readOptionalPositiveInteger(value.maxSourceBytes);
  const maxSelectionChars = readPositiveInteger(value.maxSelectionChars);
  const maxSelectionChunks = readPositiveInteger(value.maxSelectionChunks);
  if (
    value.available !== true
    || !formats
    || new Set(formats).size !== formats.length
    || maxSourceBytes === null
    || (maxSourceBytes !== undefined && maxSourceBytes > POCKET_ANYDOC_MAX_SOURCE_BYTES)
    || maxSelectionChars === null
    || maxSelectionChars > POCKET_ANYDOC_MAX_SELECTION_CHARS
    || maxSelectionChunks === null
    || maxSelectionChunks > POCKET_ANYDOC_MAX_SELECTION_CHUNKS
    || typeof value.supportsAssets !== 'boolean'
    || typeof value.supportsCancellation !== 'boolean'
  ) {
    throw new PocketAnydocError('invalid_native_response', 'Pocket AnyDoc capabilities are invalid.');
  }
  return {
    available: true,
    formats,
    ...(maxSourceBytes === undefined ? null : { maxSourceBytes }),
    maxSelectionChars,
    maxSelectionChunks,
    supportsAssets: value.supportsAssets,
    supportsCancellation: value.supportsCancellation,
  };
}

function parseVersion(value: unknown): PocketAnydocVersion {
  if (!isRecord(value)) {
    throw new PocketAnydocError('invalid_native_response', 'Pocket AnyDoc version is invalid.');
  }
  const moduleVersion = readString(value.moduleVersion, 64);
  const parserId = readString(value.parserId, 64, SAFE_IDENTIFIER_PATTERN);
  const parserVersion = readString(value.parserVersion, 64);
  const exactAnyDocCommit = readString(
    value.exactAnyDocCommit ?? value.anydocCommit,
    40,
    /^[a-f0-9]{40}$/u,
  );
  if (!moduleVersion || !parserId || !parserVersion || !exactAnyDocCommit) {
    throw new PocketAnydocError('invalid_native_response', 'Pocket AnyDoc version is invalid.');
  }
  return { moduleVersion, parserId, parserVersion, exactAnyDocCommit };
}

function parsePreparedDocument(value: unknown): PocketAnydocPreparedDocument {
  if (!isRecord(value)) {
    throw new PocketAnydocError('invalid_native_response', 'Pocket AnyDoc prepare result is invalid.');
  }
  const handle = readString(value.handle, POCKET_ANYDOC_MAX_HANDLE_CHARS, SAFE_IDENTIFIER_PATTERN);
  const canonicalFormat = typeof value.canonicalFormat === 'string'
    && CANONICAL_FORMATS.has(value.canonicalFormat as PocketAnydocCanonicalFormat)
    ? value.canonicalFormat as PocketAnydocCanonicalFormat
    : null;
  const parserId = readString(value.parserId, 64, SAFE_IDENTIFIER_PATTERN);
  const parserVersion = readString(value.parserVersion, 64);
  const exactAnyDocCommit = readString(
    value.exactAnyDocCommit ?? value.anydocCommit,
    40,
    /^[a-f0-9]{40}$/u,
  );
  const sourceByteCount = readPositiveInteger(value.sourceByteCount);
  const sourceCharCount = readOptionalPositiveInteger(value.sourceCharCount);
  const contentSha256 = readString(value.contentSha256, 64, SHA256_PATTERN);
  const chunkCount = readPositiveInteger(value.chunkCount);
  const pageCount = readOptionalPositiveInteger(value.pageCount);
  const slideCount = readOptionalPositiveInteger(value.slideCount);
  const sheetCount = readOptionalPositiveInteger(value.sheetCount);
  const assetCount = value.assetCount === undefined || value.assetCount === null
    ? undefined
    : readNonNegativeInteger(value.assetCount);
  const assets = readAssetDescriptors(value.assets);
  const warnings = readWarningCodes(value.warnings ?? []);
  if (
    !handle || !canonicalFormat || !parserId || !parserVersion || !exactAnyDocCommit
    || !sourceByteCount || sourceByteCount > POCKET_ANYDOC_MAX_SOURCE_BYTES
    || sourceCharCount === null
    || (sourceCharCount !== undefined && sourceCharCount > POCKET_ANYDOC_MAX_SOURCE_CHARS)
    || !contentSha256 || !chunkCount || chunkCount > POCKET_ANYDOC_MAX_DOCUMENT_CHUNKS
    || pageCount === null || slideCount === null || sheetCount === null
    || (pageCount !== undefined && pageCount > POCKET_ANYDOC_MAX_STRUCTURAL_COUNT)
    || (slideCount !== undefined && slideCount > POCKET_ANYDOC_MAX_STRUCTURAL_COUNT)
    || (sheetCount !== undefined && sheetCount > POCKET_ANYDOC_MAX_STRUCTURAL_COUNT)
    || assetCount === null || (assetCount !== undefined && assetCount > POCKET_ANYDOC_MAX_ASSET_DESCRIPTORS)
    || assets === null || !warnings
    || (assets !== undefined && assetCount !== assets.length)
  ) {
    throw new PocketAnydocError('invalid_native_response', 'Pocket AnyDoc prepare result is invalid.');
  }
  return {
    handle,
    canonicalFormat,
    parserId,
    parserVersion,
    exactAnyDocCommit,
    sourceByteCount,
    ...(sourceCharCount === undefined ? null : { sourceCharCount }),
    contentSha256,
    chunkCount,
    ...(pageCount === undefined ? null : { pageCount }),
    ...(slideCount === undefined ? null : { slideCount }),
    ...(sheetCount === undefined ? null : { sheetCount }),
    ...(assetCount === undefined ? null : { assetCount }),
    ...(assets === undefined ? null : { assets }),
    warnings,
  };
}

function parseContextSelection(
  value: unknown,
  bounds: Pick<PocketAnydocSelectContextRequest, 'maxChars' | 'maxChunks'>,
): PocketAnydocContextSelection {
  if (!isRecord(value) || !Array.isArray(value.chunks) || value.chunks.length > bounds.maxChunks) {
    throw new PocketAnydocError('invalid_native_response', 'Pocket AnyDoc context selection is invalid.');
  }
  let measuredChars = 0;
  const seenIndexes = new Set<number>();
  const chunks = value.chunks.map((entry): PocketAnydocContextChunk => {
    if (!isRecord(entry)) {
      throw new PocketAnydocError('invalid_native_response', 'Pocket AnyDoc context chunk is invalid.');
    }
    const index = readNonNegativeInteger(entry.index);
    const text = readChunkText(entry.text, bounds.maxChars);
    const kind = typeof entry.kind === 'string' && CHUNK_KINDS.has(entry.kind as PocketAnydocChunkKind)
      ? entry.kind as PocketAnydocChunkKind
      : null;
    const heading = entry.heading === undefined || entry.heading === null
      ? undefined
      : readString(entry.heading, 512);
    const pageNumber = readOptionalPositiveInteger(entry.pageNumber);
    const slideNumber = readOptionalPositiveInteger(entry.slideNumber);
    const sheetName = entry.sheetName === undefined || entry.sheetName === null
      ? undefined
      : readString(entry.sheetName, 256);
    const assetIds = readAssetIds(entry.assetIds);
    if (
      index === null || index >= POCKET_ANYDOC_MAX_DOCUMENT_CHUNKS
      || !text || !kind || heading === null || pageNumber === null
      || (pageNumber !== undefined && pageNumber > POCKET_ANYDOC_MAX_STRUCTURAL_COUNT)
      || slideNumber === null || sheetName === null || assetIds === null || seenIndexes.has(index)
      || (slideNumber !== undefined && slideNumber > POCKET_ANYDOC_MAX_STRUCTURAL_COUNT)
    ) {
      throw new PocketAnydocError('invalid_native_response', 'Pocket AnyDoc context chunk is invalid.');
    }
    seenIndexes.add(index);
    measuredChars += text.length;
    return {
      index,
      text,
      kind,
      ...(heading === undefined ? null : { heading }),
      ...(pageNumber === undefined ? null : { pageNumber }),
      ...(slideNumber === undefined ? null : { slideNumber }),
      ...(sheetName === undefined ? null : { sheetName }),
      ...(assetIds === undefined ? null : { assetIds }),
    };
  });
  const selectedCharCount = readNonNegativeInteger(value.selectedCharCount);
  const warnings = readWarningCodes(value.warnings ?? []);
  const nextCursor = value.nextCursor === undefined || value.nextCursor === null
    ? undefined
    : readString(value.nextCursor, POCKET_ANYDOC_MAX_HANDLE_CHARS, SAFE_IDENTIFIER_PATTERN);
  if (
    selectedCharCount === null || selectedCharCount !== measuredChars || measuredChars > bounds.maxChars
    || typeof value.truncated !== 'boolean' || !warnings || nextCursor === null
  ) {
    throw new PocketAnydocError('invalid_native_response', 'Pocket AnyDoc context selection is invalid.');
  }
  return {
    chunks,
    selectedCharCount,
    truncated: value.truncated,
    ...(nextCursor === undefined ? null : { nextCursor }),
    warnings,
  };
}

function parseMaterializedAsset(
  value: unknown,
  request: PocketAnydocMaterializeAssetRequest,
): PocketAnydocMaterializedAsset {
  if (
    !isRecord(value)
    || Object.keys(value).some((key) => key !== 'localUri' && FORBIDDEN_ASSET_PAYLOAD_KEYS.has(key))
  ) {
    throw new PocketAnydocError('invalid_native_response', 'Pocket AnyDoc asset result is invalid.');
  }
  const assetId = readNonNegativeInteger(value.assetId);
  const mediaType = readString(value.mediaType, 128, MEDIA_TYPE_PATTERN);
  const byteLength = readPositiveInteger(value.byteLength);
  const sha256 = readString(value.sha256, 64, SHA256_PATTERN);
  const width = readPositiveInteger(value.width);
  const height = readPositiveInteger(value.height);
  const localUri = readPrivateCacheLocalUri(value.localUri);
  if (
    assetId !== request.assetId || !mediaType || !SAFE_RASTER_MEDIA_TYPES.has(mediaType) || !byteLength
    || byteLength > POCKET_ANYDOC_MAX_MATERIALIZED_ASSET_BYTES || !sha256
    || !width || !height || width > 16_384 || height > 16_384
    || width * height > 40_000_000 || !localUri
  ) {
    throw new PocketAnydocError('invalid_native_response', 'Pocket AnyDoc asset result is invalid.');
  }
  return { assetId, id: assetId, mediaType, byteLength, sha256, width, height, localUri };
}

export async function getCapabilities(): Promise<PocketAnydocCapabilities> {
  const module = resolveNativeModule();
  if (!module) {
    return {
      available: false,
      formats: [],
      maxSelectionChars: POCKET_ANYDOC_MAX_SELECTION_CHARS,
      maxSelectionChunks: POCKET_ANYDOC_MAX_SELECTION_CHUNKS,
      supportsAssets: false,
      supportsCancellation: false,
    };
  }
  try {
    return parseCapabilities(unwrapNativeEnvelope(await module.getCapabilities()));
  } catch (error) {
    throw normalizeNativeError(error);
  }
}

export async function getVersion(): Promise<PocketAnydocVersion | null> {
  const module = resolveNativeModule();
  if (!module) {
    return null;
  }
  try {
    return parseVersion(unwrapNativeEnvelope(await module.getVersion()));
  } catch (error) {
    throw normalizeNativeError(error);
  }
}

export function prepareDocument(
  input: PocketAnydocPrepareRequest,
): Promise<PocketAnydocPreparedDocument> {
  const requestId = requireValidRequestId(input.requestId);
  const localUri = readCanonicalPrivateFileUri(input.localUri);
  if (!localUri || !Number.isSafeInteger(input.sourceSizeBytes)
    || input.sourceSizeBytes <= 0 || input.sourceSizeBytes > POCKET_ANYDOC_MAX_SOURCE_BYTES) {
    return Promise.reject(new PocketAnydocError('invalid_request', 'Pocket AnyDoc prepare request is invalid.'));
  }
  const request: PocketAnydocPrepareRequest = {
    requestId,
    localUri,
    sourceSizeBytes: input.sourceSizeBytes,
    ...(readString(input.displayName, 512) ? { displayName: readString(input.displayName, 512)! } : null),
    ...(readString(input.declaredMimeType, 256) ? { declaredMimeType: readString(input.declaredMimeType, 256)! } : null),
  };
  return runSerialized(requestId, async () => parsePreparedDocument(
    unwrapNativeEnvelope(await requireNativeModule().prepareDocument(request)),
  ));
}

export function selectContext(
  input: PocketAnydocSelectContextRequest,
): Promise<PocketAnydocContextSelection> {
  const requestId = requireValidRequestId(input.requestId);
  const handle = requireValidHandle(input.handle);
  const query = typeof input.query === 'string' && input.query.length <= POCKET_ANYDOC_MAX_QUERY_CHARS
    ? input.query
    : null;
  if (
    query === null || !Number.isSafeInteger(input.maxChunks) || input.maxChunks <= 0
    || input.maxChunks > POCKET_ANYDOC_MAX_SELECTION_CHUNKS
    || !Number.isSafeInteger(input.maxChars) || input.maxChars <= 0
    || input.maxChars > POCKET_ANYDOC_MAX_SELECTION_CHARS
  ) {
    return Promise.reject(new PocketAnydocError('invalid_request', 'Pocket AnyDoc selection request is invalid.'));
  }
  let cursor: string | undefined;
  if (input.cursor !== undefined) {
    const parsedCursor = readString(
      input.cursor,
      POCKET_ANYDOC_MAX_HANDLE_CHARS,
      SAFE_IDENTIFIER_PATTERN,
    );
    if (parsedCursor === null) {
      return Promise.reject(new PocketAnydocError('invalid_request', 'Pocket AnyDoc cursor is invalid.'));
    }
    cursor = parsedCursor;
  }
  const request: PocketAnydocSelectContextRequest = {
    requestId,
    handle,
    query,
    maxChunks: input.maxChunks,
    maxChars: input.maxChars,
    ...(cursor === undefined ? null : { cursor }),
  };
  return runSerialized(requestId, async () => parseContextSelection(
    unwrapNativeEnvelope(await requireNativeModule().selectContext(request)),
    request,
  ));
}

export function materializeAsset(
  input: PocketAnydocMaterializeAssetRequest,
): Promise<PocketAnydocMaterializedAsset> {
  const requestId = requireValidRequestId(input.requestId);
  const handle = requireValidHandle(input.handle);
  const assetId = readNonNegativeInteger(input.assetId);
  if (assetId === null) {
    throw new PocketAnydocError('invalid_request', 'Pocket AnyDoc asset id is invalid.');
  }
  const request: PocketAnydocMaterializeAssetRequest = { requestId, handle, assetId };
  return runSerialized(requestId, async () => {
    const module = requireNativeModule();
    if (typeof module.materializeAsset !== 'function') {
      throw new PocketAnydocError(
        'native_unavailable',
        'Pocket AnyDoc asset materialization is unavailable in this build.',
      );
    }
    return parseMaterializedAsset(
      unwrapNativeEnvelope(await module.materializeAsset(request)),
      request,
    );
  });
}

export async function cancel(requestIdInput: string): Promise<void> {
  const requestId = requireValidRequestId(requestIdInput);
  if (pendingRequestIds.has(requestId)) {
    cancelledRequestIds.add(requestId);
  }
  const module = resolveNativeModule();
  if (!module) {
    return;
  }
  try {
    unwrapNativeEnvelope(await module.cancel(requestId));
  } catch (error) {
    throw normalizeNativeError(error);
  }
}

export async function release(handleInput: string): Promise<void> {
  const handle = requireValidHandle(handleInput);
  const module = resolveNativeModule();
  if (!module) {
    return;
  }
  try {
    unwrapNativeEnvelope(await module.release(handle));
  } catch (error) {
    throw normalizeNativeError(error);
  }
}

export function __setPocketAnydocNativeModuleForTests(
  module: PocketAnydocNativeModule | null | undefined,
): void {
  nativeModuleOverride = module;
  resolvedNativeModule = undefined;
  cancelledRequestIds.clear();
  pendingRequestIds.clear();
  serializedTail = Promise.resolve();
}
