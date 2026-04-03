import { AppError, getErrorMessage, reportError, toAppError } from '../../src/services/AppError';

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
  });

  it('prefers the raw message for unknown error codes when available', () => {
    const t = ((key: string) => `t:${key}`) as any;
    expect(getErrorMessage(new AppError('action_failed', 'Oops'), t)).toBe('Oops');
  });

  it('falls back to the generic message when there is no translation key or useful error message', () => {
    const t = ((key: string) => `t:${key}`) as any;
    expect(getErrorMessage(new AppError('action_failed'), t)).toBe('t:common.actionFailed');
  });

  it('reports to Sentry when not in dev mode', () => {
    const originalDevFlag = (globalThis as any).__DEV__;
    const originalSentry = (globalThis as any).Sentry;
    const reporter = { captureException: jest.fn() };

    try {
      (globalThis as any).__DEV__ = false;
      (globalThis as any).Sentry = reporter;

      const result = reportError('scope', new Error('Engine not ready'), { foo: 'bar' });

      expect(result).toBeInstanceOf(AppError);
      expect(reporter.captureException).toHaveBeenCalledTimes(1);
      expect(reporter.captureException).toHaveBeenCalledWith(
        expect.any(AppError),
        expect.objectContaining({
          tags: expect.objectContaining({ scope: 'scope' }),
          extra: expect.objectContaining({ foo: 'bar' }),
        }),
      );
    } finally {
      (globalThis as any).__DEV__ = originalDevFlag;
      (globalThis as any).Sentry = originalSentry;
    }
  });
});

