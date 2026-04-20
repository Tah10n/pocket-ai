import {
  ModelCatalogError,
  buildHeaders,
  fetchWithTimeout,
  getModelCatalogErrorMessage,
  parseNextCursor,
  parseRateLimitResetMs,
  parseRetryAfterMs,
  resolveRequestAuthToken,
  resolveRetryAfterMs,
} from '@/services/ModelCatalogHttpClient';
import { REQUEST_AUTH_POLICY } from '@/types/huggingFace';

describe('ModelCatalogHttpClient', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('resolves request auth token based on policy', () => {
    expect(resolveRequestAuthToken(REQUEST_AUTH_POLICY.ANONYMOUS, 'token')).toBeNull();
    expect(resolveRequestAuthToken(REQUEST_AUTH_POLICY.OPTIONAL_AUTH, null)).toBeNull();
    expect(resolveRequestAuthToken(REQUEST_AUTH_POLICY.OPTIONAL_AUTH, 't')).toBe('t');
    expect(() => resolveRequestAuthToken(REQUEST_AUTH_POLICY.REQUIRED_AUTH, null)).toThrow(ModelCatalogError);
  });

  it('builds auth headers only when needed', () => {
    expect(buildHeaders(REQUEST_AUTH_POLICY.ANONYMOUS, 'x')).toBeUndefined();
    expect(buildHeaders(REQUEST_AUTH_POLICY.OPTIONAL_AUTH, null)).toBeUndefined();
    expect(buildHeaders(REQUEST_AUTH_POLICY.OPTIONAL_AUTH, 'abc')).toEqual({ Authorization: 'Bearer abc' });
  });

  it('parses retry-after values', () => {
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs('')).toBeNull();
    expect(parseRetryAfterMs('10')).toBe(10_000);
    expect(parseRetryAfterMs('Wed, 01 Jan 2026 00:01:00 GMT')).toBe(60_000);
    expect(parseRetryAfterMs('not-a-date')).toBeNull();
  });

  it('parses ratelimit-reset values (epoch ms / epoch seconds / seconds)', () => {
    // epoch ms
    expect(parseRateLimitResetMs(String(Date.now() + 5_000))).toBe(5_000);
    // epoch seconds
    expect(parseRateLimitResetMs(String(Math.floor(Date.now() / 1000) + 5))).toBe(5_000);
    // seconds
    expect(parseRateLimitResetMs('5')).toBe(5_000);
    expect(parseRateLimitResetMs('-1')).toBeNull();
  });

  it('extracts next cursor from Link header', () => {
    const link = '<https://huggingface.co/api/models?cursor=abc>; rel="next", <https://huggingface.co/api/models?cursor=prev>; rel="prev"';
    expect(parseNextCursor(link)).toBe('https://huggingface.co/api/models?cursor=abc');
    expect(parseNextCursor(null)).toBeNull();
    expect(parseNextCursor('junk')).toBeNull();
  });

  it('resolves retry-after from headers', () => {
    const response = {
      headers: {
        get: (name: string) => (name.toLowerCase() === 'retry-after' ? '10' : null),
      },
    } as any;
    expect(resolveRetryAfterMs(response)).toBe(10_000);
  });

  it('formats error messages for user display', () => {
    expect(getModelCatalogErrorMessage(new ModelCatalogError('network', 'x'))).toContain('Network');
    expect(getModelCatalogErrorMessage(new ModelCatalogError('timeout', 'x'))).toContain('timed out');
    expect(getModelCatalogErrorMessage(new ModelCatalogError('rate_limited', 'x', { retryAfterMs: 5_000 }))).toContain('~5s');
    expect(getModelCatalogErrorMessage(new ModelCatalogError('rate_limited', 'x', { retryAfterMs: 120_000 }))).toContain('~2m');
    expect(getModelCatalogErrorMessage(new Error('other'))).toContain('Please try again');
  });

  it('fetchWithTimeout returns response when fetch completes', async () => {
    const response = { ok: true } as any;
    const fetchSpy = jest.spyOn(globalThis as any, 'fetch').mockResolvedValueOnce(response);

    await expect(fetchWithTimeout('https://example.com', {}, 1000)).resolves.toBe(response);
    expect(fetchSpy).toHaveBeenCalled();
  });

  it('fetchWithTimeout rejects with timeout error and aborts', async () => {
    const abortSpy = jest.fn();
    class MockAbortController {
      signal = { aborted: false };
      abort = abortSpy;
    }

    const originalAbortController = (globalThis as any).AbortController;
    (globalThis as any).AbortController = MockAbortController;

    try {
      jest.spyOn(globalThis as any, 'fetch').mockImplementation(() => new Promise(() => {}));

      const promise = fetchWithTimeout('https://example.com', {}, 1000);
      jest.advanceTimersByTime(1000);

      await expect(promise).rejects.toMatchObject({
        name: 'ModelCatalogError',
        code: 'timeout',
      });
      expect(abortSpy).toHaveBeenCalled();
    } finally {
      (globalThis as any).AbortController = originalAbortController;
    }
  });
});
