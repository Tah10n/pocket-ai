import {
  sanitizeErrorForReport,
  sanitizeErrorReportContext,
  sanitizeErrorReportString,
} from '../../src/services/ErrorReportSanitizer';

const UNC_PATH = String.raw`\\server\share\Users\alice\model.gguf`;
const UNC_PATH_WITH_SPACES = String.raw`\\server\shared models\Users\Alice Smith\model file.gguf`;
const UNC_PATH_WITH_SPACES_NO_EXTENSION = String.raw`\\server\shared models\Users\Alice Smith\cache folder`;
const EXTENDED_DRIVE_PATH = String.raw`\\?\C:\Users\alice\model.gguf`;
const EXTENDED_DRIVE_PATH_WITH_SPACES = String.raw`\\?\C:\Users\Alice Smith\model file.gguf`;
const EXTENDED_UNC_PATH = String.raw`\\?\UNC\server\share\folder\file.gguf`;
const EXTENDED_UNC_PATH_WITH_SPACES_NO_EXTENSION = String.raw`\\?\UNC\server\shared models\Users\Alice Smith\cache folder`;

describe('ErrorReportSanitizer', () => {
  it('redacts Windows UNC and extended paths in strings without redacting safe URLs or model ids', () => {
    const value = [
      `standard ${UNC_PATH}`,
      `standard with spaces ${UNC_PATH_WITH_SPACES}`,
      `no extension ${UNC_PATH_WITH_SPACES_NO_EXTENSION}`,
      `extended drive ${EXTENDED_DRIVE_PATH}`,
      `extended drive with spaces ${EXTENDED_DRIVE_PATH_WITH_SPACES}`,
      `extended UNC ${EXTENDED_UNC_PATH}`,
      `extended UNC no extension ${EXTENDED_UNC_PATH_WITH_SPACES_NO_EXTENSION}`,
      'safe URL https://huggingface.co/org/model/resolve/main/model.gguf?ok=1',
      'safe model author/model-q4',
    ].join(' | ');

    const sanitized = sanitizeErrorReportString(value);

    expect(sanitized).toContain('standard [path]');
    expect(sanitized).toContain('standard with spaces [path]');
    expect(sanitized).toContain('no extension [path]');
    expect(sanitized).toContain('extended drive [path]');
    expect(sanitized).toContain('extended drive with spaces [path]');
    expect(sanitized).toContain('extended UNC [path]');
    expect(sanitized).toContain('extended UNC no extension [path]');
    expect(sanitized).toContain('https://huggingface.co/org/model/resolve/main/model.gguf?ok=1');
    expect(sanitized).toContain('author/model-q4');
    expect(sanitized).not.toContain('server\\share');
    expect(sanitized).not.toContain('Alice Smith');
    expect(sanitized).not.toContain('model file');
    expect(sanitized).not.toContain('C:\\Users\\alice');
    expect(sanitized).not.toContain('UNC\\server');
  });

  it('redacts picker URIs and broader Android or Unix local paths in strings', () => {
    const value = [
      'content content://media/external/images/media/12',
      'photo ph://ABC/L0/001',
      'sdcard /sdcard/DCIM/private photo.jpg',
      'workspace /workspace/pocket_ai/private/model.gguf',
      'mnt /mnt/media_rw/secret-card/photo.jpg',
      'safe URL https://huggingface.co/org/model/resolve/main/model.gguf?ok=1',
      'safe model org/model-q4',
    ].join(' | ');

    const sanitized = sanitizeErrorReportString(value);

    expect(sanitized).toContain('content [uri]');
    expect(sanitized).toContain('photo [uri]');
    expect(sanitized).toContain('sdcard [path]');
    expect(sanitized).toContain('workspace [path]');
    expect(sanitized).toContain('mnt [path]');
    expect(sanitized).toContain('https://huggingface.co/org/model/resolve/main/model.gguf?ok=1');
    expect(sanitized).toContain('org/model-q4');
    expect(sanitized).not.toContain('content://');
    expect(sanitized).not.toContain('ph://');
    expect(sanitized).not.toContain('/sdcard');
    expect(sanitized).not.toContain('/workspace');
    expect(sanitized).not.toContain('/mnt');
  });

  it('redacts UNC paths in error messages, stacks, details, and arrays', () => {
    const error = new Error(`Load failed for ${UNC_PATH} with Bearer raw-token`);
    error.stack = `Error: boom\n    at load (${EXTENDED_DRIVE_PATH}:10:2)\n    at native (${EXTENDED_UNC_PATH})`;
    (error as Error & { details?: Record<string, unknown> }).details = {
      retryPath: UNC_PATH,
      nested: {
        paths: [EXTENDED_DRIVE_PATH, { source: EXTENDED_UNC_PATH }],
      },
      requestUrl: 'https://example.test/model.gguf?access_token=secret&ok=1',
      localPath: UNC_PATH,
      downloadUrl: 'https://example.test/model.gguf?token=secret',
    };

    const report = sanitizeErrorForReport(error, { includeStack: true }) as any;
    const serialized = JSON.stringify(report);

    expect(report.message).toContain('Load failed for [path]');
    expect(report.stack).toContain('[path]');
    expect(report.details.retryPath).toBe('[path]');
    expect(report.details.nested.paths).toEqual(['[path]', { source: '[path]' }]);
    expect(report.details.requestUrl).toBe('https://example.test/model.gguf?access_token=[redacted]&ok=1');
    expect(report.details.localPath).toBeUndefined();
    expect(report.details.downloadUrl).toBeUndefined();
    expect(serialized).not.toContain('alice');
    expect(serialized).not.toContain('raw-token');
    expect(serialized).not.toContain('token=secret');
  });

  it('redacts UNC paths in cyclic-safe contexts while preserving existing context rules', () => {
    const context: Record<string, unknown> = {
      localPath: UNC_PATH,
      downloadUrl: 'https://example.test/model.gguf?token=secret',
      modelId: 'author/model-q4',
      unsafeModelId: EXTENDED_UNC_PATH,
      nested: {
        path: UNC_PATH,
        values: [EXTENDED_DRIVE_PATH, EXTENDED_UNC_PATH],
      },
      publicUrl: 'https://huggingface.co/org/model/resolve/main/model.gguf?ok=1',
      tokenUrl: 'https://example.test/model.gguf?token=secret&ok=1',
    };
    context.self = context;

    const sanitized = sanitizeErrorReportContext(context) as any;
    const serialized = JSON.stringify(sanitized);

    expect(sanitized.localPath).toBeUndefined();
    expect(sanitized.downloadUrl).toBeUndefined();
    expect(sanitized.modelId).toBe('author/model-q4');
    expect(sanitized.unsafeModelId).toBe('[path]');
    expect(sanitized.nested.path).toBe('[path]');
    expect(sanitized.nested.values).toEqual(['[path]', '[path]']);
    expect(sanitized.publicUrl).toBe('https://huggingface.co/org/model/resolve/main/model.gguf?ok=1');
    expect(sanitized.tokenUrl).toBe('https://example.test/model.gguf?token=[redacted]&ok=1');
    expect(sanitized.self).toBe('[Circular]');
    expect(serialized).not.toContain('alice');
    expect(serialized).not.toContain('token=secret');
  });

  it('drops URI-like object keys unless they contain safe public HTTPS URLs', () => {
    const context = {
      uri: 'content://media/external/images/media/12',
      localUri: 'file:///sdcard/Download/private-model.gguf',
      pickerUri: 'ph://ABC/L0/001',
      previewUri: 'content://media/external/images/media/13',
      thumbnailUri: 'content://media/external/images/media/14',
      publicUri: 'https://huggingface.co/org/model/resolve/main/model.gguf?ok=1',
      requestUri: 'https://example.test/model.gguf?token=secret&ok=1',
      path: '/workspace/private/file.gguf',
      modelId: 'org/model-q4',
    };

    const sanitized = sanitizeErrorReportContext(context) as any;
    const serialized = JSON.stringify(sanitized);

    expect(sanitized.uri).toBeUndefined();
    expect(sanitized.localUri).toBeUndefined();
    expect(sanitized.pickerUri).toBeUndefined();
    expect(sanitized.previewUri).toBeUndefined();
    expect(sanitized.thumbnailUri).toBeUndefined();
    expect(sanitized.publicUri).toBe('https://huggingface.co/org/model/resolve/main/model.gguf?ok=1');
    expect(sanitized.requestUri).toBe('https://example.test/model.gguf?token=[redacted]&ok=1');
    expect(sanitized.path).toBe('[path]');
    expect(sanitized.modelId).toBe('org/model-q4');
    expect(serialized).not.toContain('content://');
    expect(serialized).not.toContain('ph://');
    expect(serialized).not.toContain('/sdcard');
    expect(serialized).not.toContain('/workspace/private');
    expect(serialized).not.toContain('token=secret');
  });
});
