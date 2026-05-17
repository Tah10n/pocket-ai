import * as FileSystem from 'expo-file-system/legacy';
import {
  GGUF_HEADER_BYTES,
  MIN_GGUF_FILE_BYTES,
  GgufValidationError,
  isValidGgufFileHeader,
  validateGgufFileHeader,
} from '../../src/utils/ggufValidation';

jest.mock('expo-file-system/legacy', () => ({
  EncodingType: {
    Base64: 'base64',
  },
  getInfoAsync: jest.fn(),
  readAsStringAsync: jest.fn(),
}));

function buildGgufHeaderBase64(options?: { version?: number; tensorCount?: number; metadataCount?: number }) {
  const bytes = Buffer.alloc(GGUF_HEADER_BYTES);
  bytes.write('GGUF', 0, 'ascii');
  bytes.writeUInt32LE(options?.version ?? 3, 4);
  bytes.writeBigUInt64LE(BigInt(options?.tensorCount ?? 1), 8);
  bytes.writeBigUInt64LE(BigInt(options?.metadataCount ?? 0), 16);
  return bytes.toString('base64');
}

describe('ggufValidation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, size: MIN_GGUF_FILE_BYTES });
    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue(buildGgufHeaderBase64());
  });

  it('accepts a valid GGUF header', async () => {
    await expect(validateGgufFileHeader('file:///models/model.gguf')).resolves.toEqual({
      ok: true,
      sizeBytes: MIN_GGUF_FILE_BYTES,
      version: 3,
    });

    expect(FileSystem.readAsStringAsync).toHaveBeenCalledWith('file:///models/model.gguf', {
      encoding: FileSystem.EncodingType.Base64,
      position: 0,
      length: GGUF_HEADER_BYTES,
    });
  });

  it('rejects missing files and directories', async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({ exists: false });
    await expect(validateGgufFileHeader('file:///models/missing.gguf')).rejects.toMatchObject({
      reason: 'missing',
    });

    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({ exists: true, isDirectory: true });
    await expect(validateGgufFileHeader('file:///models/directory.gguf')).rejects.toMatchObject({
      reason: 'directory',
    });
  });

  it('rejects tiny files before reading the header', async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({ exists: true, size: MIN_GGUF_FILE_BYTES - 1 });

    await expect(validateGgufFileHeader('file:///models/tiny.gguf')).rejects.toMatchObject({
      reason: 'too_small',
    });
    expect(FileSystem.readAsStringAsync).not.toHaveBeenCalled();
  });

  it('rejects invalid magic, unsupported versions, and empty tensor counts', async () => {
    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValueOnce(Buffer.alloc(GGUF_HEADER_BYTES, 0x48).toString('base64'));
    await expect(validateGgufFileHeader('file:///models/html.gguf')).rejects.toMatchObject({
      reason: 'invalid_magic',
    });

    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValueOnce(buildGgufHeaderBase64({ version: 99 }));
    await expect(validateGgufFileHeader('file:///models/future.gguf')).rejects.toMatchObject({
      reason: 'unsupported_version',
    });

    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValueOnce(buildGgufHeaderBase64({ tensorCount: 0 }));
    await expect(validateGgufFileHeader('file:///models/empty.gguf')).rejects.toMatchObject({
      reason: 'missing_tensors',
    });
  });

  it('returns false from the boolean helper when validation fails', async () => {
    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValueOnce('***');

    await expect(isValidGgufFileHeader('file:///models/bad.gguf')).resolves.toBe(false);
  });

  it('uses provided file info without statting again', async () => {
    await validateGgufFileHeader('file:///models/model.gguf', {
      exists: true,
      size: MIN_GGUF_FILE_BYTES + 1,
    });

    expect(FileSystem.getInfoAsync).not.toHaveBeenCalled();
  });

  it('preserves typed validation errors for invalid base64', async () => {
    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValueOnce('!not-base64');
    const validation = validateGgufFileHeader('file:///models/bad.gguf');

    await expect(validation).rejects.toBeInstanceOf(GgufValidationError);
    await expect(validation).rejects.toMatchObject({
      reason: 'invalid_base64',
    });
  });
});
