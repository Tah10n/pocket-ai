import * as FileSystem from 'expo-file-system/legacy';

export const GGUF_HEADER_BYTES = 24;
export const MIN_GGUF_FILE_BYTES = 512;
export const SUPPORTED_GGUF_VERSIONS = [1, 2, 3] as const;

export type GgufValidationFailureReason =
  | 'missing'
  | 'directory'
  | 'too_small'
  | 'short_header'
  | 'invalid_magic'
  | 'unsupported_version'
  | 'missing_tensors'
  | 'invalid_base64'
  | 'read_failed';

export interface GgufValidationResult {
  ok: true;
  sizeBytes: number;
  version: number;
}

export class GgufValidationError extends Error {
  constructor(
    public readonly reason: GgufValidationFailureReason,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'GgufValidationError';
  }
}

type FileInfoLike = {
  exists: boolean;
  isDirectory?: boolean;
  size?: number;
};

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function decodeBase64(value: string): Uint8Array {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;

  for (const char of value.replace(/\s/g, '')) {
    if (char === '=') {
      break;
    }

    const index = BASE64_CHARS.indexOf(char);
    if (index < 0) {
      throw new GgufValidationError('invalid_base64', 'GGUF header could not be decoded from base64');
    }

    buffer = (buffer << 6) | index;
    bits += 6;

    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }

  return Uint8Array.from(bytes);
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0;
}

function hasNonZeroBytes(bytes: Uint8Array, start: number, end: number): boolean {
  for (let index = start; index < end; index += 1) {
    if (bytes[index] !== 0) {
      return true;
    }
  }

  return false;
}

function getFileInfoSizeBytes(fileInfo: FileInfoLike): number | null {
  return typeof fileInfo.size === 'number' && Number.isFinite(fileInfo.size) && fileInfo.size > 0
    ? Math.round(fileInfo.size)
    : null;
}

async function readGgufHeader(uri: string): Promise<Uint8Array> {
  try {
    const encodedHeader = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
      position: 0,
      length: GGUF_HEADER_BYTES,
    });

    return decodeBase64(encodedHeader);
  } catch (error) {
    if (error instanceof GgufValidationError) {
      throw error;
    }

    throw new GgufValidationError('read_failed', 'GGUF header could not be read', { uri });
  }
}

export async function validateGgufFileHeader(
  uri: string,
  existingFileInfo?: FileInfoLike,
): Promise<GgufValidationResult> {
  const fileInfo = existingFileInfo ?? await FileSystem.getInfoAsync(uri);
  if (!fileInfo.exists) {
    throw new GgufValidationError('missing', 'GGUF file does not exist', { uri });
  }

  if (fileInfo.isDirectory === true) {
    throw new GgufValidationError('directory', 'GGUF path is a directory, not a model file', { uri });
  }

  const sizeBytes = getFileInfoSizeBytes(fileInfo);
  if (sizeBytes == null || sizeBytes < MIN_GGUF_FILE_BYTES) {
    throw new GgufValidationError('too_small', 'GGUF file is too small to be a valid model', {
      uri,
      sizeBytes,
      minSizeBytes: MIN_GGUF_FILE_BYTES,
    });
  }

  const header = await readGgufHeader(uri);
  if (header.length < GGUF_HEADER_BYTES) {
    throw new GgufValidationError('short_header', 'GGUF header is truncated', {
      uri,
      headerBytes: header.length,
    });
  }

  if (header[0] !== 0x47 || header[1] !== 0x47 || header[2] !== 0x55 || header[3] !== 0x46) {
    throw new GgufValidationError('invalid_magic', 'GGUF header magic is invalid', { uri });
  }

  const version = readUint32LE(header, 4);
  if (!SUPPORTED_GGUF_VERSIONS.includes(version as (typeof SUPPORTED_GGUF_VERSIONS)[number])) {
    throw new GgufValidationError('unsupported_version', 'GGUF version is unsupported', { uri, version });
  }

  if (!hasNonZeroBytes(header, 8, 16)) {
    throw new GgufValidationError('missing_tensors', 'GGUF file declares no tensors', { uri, version });
  }

  return {
    ok: true,
    sizeBytes,
    version,
  };
}

export async function isValidGgufFileHeader(
  uri: string,
  existingFileInfo?: FileInfoLike,
): Promise<boolean> {
  try {
    await validateGgufFileHeader(uri, existingFileInfo);
    return true;
  } catch {
    return false;
  }
}
