import { AppError, getErrorMessage, getReportedErrorMessage, reportError, toAppError } from '../../src/services/AppError';

describe('AppError', () => {
  it('keeps existing AppError instances', () => {
    const appError = new AppError('engine_busy', 'already being generated');
    expect(toAppError(appError)).toBe(appError);
  });

  it.each([
    ['DISK_SPACE_LOW', 'download_disk_space_low'],
    ['MODEL_SIZE_UNKNOWN', 'download_size_unknown'],
    ['MODEL_METADATA_UNAVAILABLE', 'download_metadata_unavailable'],
    ['HTTP status 404', 'download_http_error'],
    ['Size mismatch', 'download_verification_failed'],
    ['checksum mismatch', 'download_verification_failed'],
    ['File does not exist after download', 'download_file_missing'],
    ['Engine not ready', 'engine_not_ready'],
    ['already being generated', 'engine_busy'],
    ['unloading', 'engine_unloading'],
    ['not found or not downloaded', 'model_not_found'],
    ['out of memory', 'model_memory_insufficient'],
    ['Message cannot be empty', 'message_empty'],
  ])('infers %s as %s', (message, expectedCode) => {
    const appError = toAppError(new Error(message));
    expect(appError.code).toBe(expectedCode);
  });

  it('uses translation keys for known error codes', () => {
    const t = ((key: string) => `t:${key}`) as any;
    expect(getErrorMessage(new AppError('engine_not_ready'), t)).toBe('t:common.errors.engineNotReady');
    expect(getErrorMessage(new AppError('download_http_error'), t)).toBe('t:common.errors.downloadHttpError');
    expect(getErrorMessage(new AppError('multimodal_not_ready', 'Vision chat is not ready.'), t))
      .toBe('t:common.errors.multimodalNotReady');
    expect(getErrorMessage(new AppError('chat_attachment_missing', 'Missing image.'), t))
      .toBe('t:common.errors.chatAttachmentMissing');
  });

  it('prefers the raw message for unknown error codes when available', () => {
    const t = ((key: string) => `t:${key}`) as any;
    expect(getErrorMessage(new AppError('action_failed', 'Oops'), t)).toBe('Oops');
  });

  it('falls back to the generic message when there is no translation key or useful error message', () => {
    const t = ((key: string) => `t:${key}`) as any;
    expect(getErrorMessage(new AppError('action_failed'), t)).toBe('t:common.actionFailed');
  });

  it('reports sanitized errors and extra to Sentry when not in dev mode', () => {
    const originalDevFlag = (globalThis as any).__DEV__;
    const originalSentry = (globalThis as any).Sentry;
    const reporter = { captureException: jest.fn() };

    try {
      (globalThis as any).__DEV__ = false;
      (globalThis as any).Sentry = reporter;

      const result = reportError(
        'scope',
        new AppError('action_failed', 'Failed to copy content://media/external/images/media/12 with Bearer raw-token', {
          details: {
            pickerUri: 'ph://ABC/L0/001',
            modelId: 'author/model-q4',
          },
        }),
        {
          foo: 'bar',
          localUri: 'file:///sdcard/Download/private-model.gguf',
          requestUrl: 'https://example.test/model.gguf?token=secret&ok=1',
        },
      );

      expect(result).toBeInstanceOf(AppError);
      expect(result.message).toBe('Failed to copy [uri] with Bearer [redacted]');
      expect(reporter.captureException).toHaveBeenCalledTimes(1);
      expect(reporter.captureException).toHaveBeenCalledWith(
        expect.any(AppError),
        expect.objectContaining({
          tags: expect.objectContaining({ scope: 'scope' }),
          extra: expect.objectContaining({
            foo: 'bar',
            modelId: expect.stringMatching(/^hash:[a-z0-9]+$/),
            requestUrl: 'https://example.test/model.gguf?token=[redacted]&ok=1',
          }),
        }),
      );
      const [, sentryOptions] = reporter.captureException.mock.calls[0];
      const serializedSentryOptions = JSON.stringify(sentryOptions);
      expect(serializedSentryOptions).not.toContain('content://');
      expect(serializedSentryOptions).not.toContain('ph://');
      expect(serializedSentryOptions).not.toContain('/sdcard');
      expect(serializedSentryOptions).not.toContain('author/model-q4');
      expect(serializedSentryOptions).not.toContain('raw-token');
      expect(serializedSentryOptions).not.toContain('token=secret');
    } finally {
      (globalThis as any).__DEV__ = originalDevFlag;
      (globalThis as any).Sentry = originalSentry;
    }
  });

  it('uses the sanitized reported error for UI-facing fallback messages', () => {
    const originalDevFlag = (globalThis as any).__DEV__;
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const t = ((key: string) => `t:${key}`) as any;

    try {
      (globalThis as any).__DEV__ = true;

      const message = getReportedErrorMessage(
        'scope',
        new Error('Failed content://media/external/images/media/12 from /workspace/project/private.jpg?token=secret'),
        t,
      );

      expect(message).toBe('Failed [uri] from [path]');
      expect(message).not.toContain('content://');
      expect(message).not.toContain('/workspace');
      expect(message).not.toContain('token=secret');
    } finally {
      consoleSpy.mockRestore();
      (globalThis as any).__DEV__ = originalDevFlag;
    }
  });

  it('redacts prompt-like quoted payloads before reporting', () => {
    const originalDevFlag = (globalThis as any).__DEV__;
    const originalSentry = (globalThis as any).Sentry;
    const reporter = { captureException: jest.fn() };

    try {
      (globalThis as any).__DEV__ = false;
      (globalThis as any).Sentry = reporter;

      const result = reportError(
        'scope',
        new Error('Native completion failed while processing prompt "Describe my private photo" for file:///private/mobile/photo.jpg'),
        {
          activeModelId: 'author/model-q4',
          note: 'raw message "My private address" failed',
        },
      );

      expect(result.message).toBe('Native completion failed while processing prompt "[redacted]" for [file-uri]');
      expect(reporter.captureException).toHaveBeenCalledTimes(1);
      const [, sentryOptions] = reporter.captureException.mock.calls[0];
      const serializedSentryOptions = JSON.stringify(sentryOptions);
      expect(serializedSentryOptions).toContain('raw message \\"[redacted]\\" failed');
      expect(serializedSentryOptions).not.toContain('Describe my private photo');
      expect(serializedSentryOptions).not.toContain('My private address');
      expect(serializedSentryOptions).not.toContain('file:///private/mobile');
      expect(serializedSentryOptions).not.toContain('author/model-q4');
    } finally {
      (globalThis as any).__DEV__ = originalDevFlag;
      (globalThis as any).Sentry = originalSentry;
    }
  });

  it('sanitizes console extra in dev mode', () => {
    const originalDevFlag = (globalThis as any).__DEV__;
    const originalSentry = (globalThis as any).Sentry;
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      (globalThis as any).__DEV__ = true;
      (globalThis as any).Sentry = undefined;

      const result = reportError(
        'scope',
        new AppError('action_failed', 'Preview failed for ph://ABC/L0/001 in /mnt/media/photo.jpg', {
          details: {
            publicUrl: 'https://huggingface.co/author/model/resolve/main/model.gguf?ok=1',
            thumbnailUri: 'content://media/external/images/media/99',
          },
        }),
        {
          uri: 'content://media/external/images/media/12',
          previewUri: 'ph://XYZ/L0/002',
          token: 'raw-token',
          nested: {
            path: '/sdcard/DCIM/private photo.jpg',
          },
        },
      );

      expect(result.message).toBe('Preview failed for [uri] in [path]');
      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const [, loggedError, loggedExtra] = consoleSpy.mock.calls[0];
      expect(loggedError).toBe(result);
      expect(loggedExtra).toEqual({
        publicUrl: 'https://huggingface.co/author/model/resolve/main/model.gguf?ok=1',
        token: '[redacted]',
        nested: {
          path: '[path]',
        },
      });
      const serializedConsoleArgs = JSON.stringify(consoleSpy.mock.calls[0]);
      expect(serializedConsoleArgs).not.toContain('content://');
      expect(serializedConsoleArgs).not.toContain('ph://');
      expect(serializedConsoleArgs).not.toContain('/sdcard');
      expect(serializedConsoleArgs).not.toContain('/mnt');
      expect(serializedConsoleArgs).not.toContain('raw-token');
    } finally {
      consoleSpy.mockRestore();
      (globalThis as any).__DEV__ = originalDevFlag;
      (globalThis as any).Sentry = originalSentry;
    }
  });
});

