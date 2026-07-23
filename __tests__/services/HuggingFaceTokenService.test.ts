import * as SecureStore from 'expo-secure-store';
import { HuggingFaceTokenService } from '../../src/services/HuggingFaceTokenService';

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, reject, resolve };
}

describe('HuggingFaceTokenService', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    (SecureStore as typeof SecureStore & { __resetMock?: () => void }).__resetMock?.();
  });

  it('saves and reads a token from secure storage', async () => {
    const service = new HuggingFaceTokenService();

    await service.saveToken('hf_secret_token');

    await expect(service.getToken()).resolves.toBe('hf_secret_token');
    await expect(service.hasToken()).resolves.toBe(true);
  });

  it('clears the stored token', async () => {
    const service = new HuggingFaceTokenService();
    await service.saveToken('hf_secret_token');

    await service.clearToken();

    await expect(service.getToken()).resolves.toBeNull();
    await expect(service.hasToken()).resolves.toBe(false);
  });

  it('notifies subscribers when token state changes', async () => {
    const service = new HuggingFaceTokenService();
    const listener = jest.fn();
    const unsubscribe = service.subscribe(listener);

    await service.saveToken('hf_secret_token');
    await service.clearToken();
    unsubscribe();

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ hasToken: false }), 'replay');
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ hasToken: true }), 'mutation');
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ hasToken: false }), 'mutation');
  });

  it('hydrates token state only when refreshState is called explicitly', async () => {
    await SecureStore.setItemAsync('huggingface-access-token', 'hf_bootstrap_token');
    const service = new HuggingFaceTokenService();
    const listener = jest.fn();

    service.subscribe(listener);
    await Promise.resolve();

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ hasToken: false }), 'replay');
    expect(listener).not.toHaveBeenCalledWith(expect.objectContaining({ hasToken: true }), 'hydrate');

    await service.refreshState();

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ hasToken: true }), 'hydrate');
    await expect(service.getToken()).resolves.toBe('hf_bootstrap_token');
  });

  it('notifies hydrate subscribers when the stored token changes but remains present', async () => {
    await SecureStore.setItemAsync('huggingface-access-token', 'hf_token_a');
    const service = new HuggingFaceTokenService();
    const listener = jest.fn();
    service.subscribe(listener);

    await service.refreshState();
    listener.mockClear();

    await SecureStore.setItemAsync('huggingface-access-token', 'hf_token_b');
    await service.refreshState();

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ hasToken: true }), 'hydrate');
    await expect(service.getToken()).resolves.toBe('hf_token_b');
  });

  it('returns atomic token snapshots across anonymous, replacement, and removal epochs', async () => {
    const service = new HuggingFaceTokenService();

    await expect(service.getSnapshot()).resolves.toEqual({ token: null, revision: 0 });

    await service.saveToken('hf_token_a');
    await expect(service.getSnapshot()).resolves.toEqual({ token: 'hf_token_a', revision: 1 });

    await service.saveToken('hf_token_b');
    await expect(service.getSnapshot()).resolves.toEqual({ token: 'hf_token_b', revision: 2 });

    await service.clearToken();
    await expect(service.getSnapshot()).resolves.toEqual({ token: null, revision: 3 });
  });

  it('serializes rapid mutations so the final snapshot has the matching revision', async () => {
    const service = new HuggingFaceTokenService();

    await Promise.all([
      service.saveToken('hf_token_a'),
      service.saveToken('hf_token_b'),
      service.clearToken(),
      service.saveToken('hf_token_c'),
    ]);

    await expect(service.getSnapshot()).resolves.toEqual({ token: 'hf_token_c', revision: 4 });
    expect(service.getCachedRevision()).toBe(4);
  });

  it('linearizes a mutation that arrives while a snapshot is reading secure storage', async () => {
    const service = new HuggingFaceTokenService();
    const pendingRead = createDeferred<string | null>();
    (SecureStore.getItemAsync as jest.Mock).mockImplementationOnce(() => pendingRead.promise);

    const snapshotBeforeMutation = service.getSnapshot();
    await Promise.resolve();
    const pendingMutation = service.saveToken('hf_token_after_read');

    pendingRead.resolve(null);
    await expect(snapshotBeforeMutation).resolves.toEqual({ token: null, revision: 0 });
    await pendingMutation;
    await expect(service.getSnapshot()).resolves.toEqual({
      token: 'hf_token_after_read',
      revision: 1,
    });
  });

  it('hydrates an externally stored token into the same snapshot epoch', async () => {
    await SecureStore.setItemAsync('huggingface-access-token', 'hf_external_token');
    const service = new HuggingFaceTokenService();
    const listener = jest.fn();
    service.subscribe(listener);
    listener.mockClear();

    await expect(service.getSnapshot()).resolves.toEqual({
      token: 'hf_external_token',
      revision: 1,
    });
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ hasToken: true }),
      'hydrate',
    );
  });

  it('commits the epoch for every subscriber even when an earlier listener throws', async () => {
    const service = new HuggingFaceTokenService();
    const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const laterListener = jest.fn();
    service.subscribe((_state, source) => {
      if (source === 'mutation') {
        throw new Error('listener failed');
      }
    });
    service.subscribe(laterListener);
    laterListener.mockClear();

    await service.saveToken('hf_listener_token');

    await expect(service.getSnapshot()).resolves.toEqual({
      token: 'hf_listener_token',
      revision: 1,
    });
    expect(laterListener).toHaveBeenCalledWith(
      expect.objectContaining({ hasToken: true }),
      'mutation',
    );
    expect(consoleWarn).toHaveBeenCalledWith(
      '[HuggingFaceTokenService] Token state listener failed',
    );
    consoleWarn.mockRestore();
  });

  it('rejects token saves when secure storage is unavailable', async () => {
    (SecureStore.isAvailableAsync as jest.Mock).mockResolvedValueOnce(false);
    const service = new HuggingFaceTokenService();

    await expect(service.saveToken('hf_secret_token')).rejects.toThrow(
      'Secure storage is unavailable on this device.',
    );
    await expect(service.getToken()).resolves.toBeNull();
  });

  it('fails closed when clearing while secure storage is unavailable', async () => {
    const service = new HuggingFaceTokenService();
    const serviceWithState = service as unknown as {
      state: { hasToken: boolean; updatedAt: number };
    };
    serviceWithState.state = {
      hasToken: true,
      updatedAt: 1234,
    };
    const listener = jest.fn();
    service.subscribe(listener);
    listener.mockClear();

    (SecureStore.isAvailableAsync as jest.Mock).mockResolvedValueOnce(false);

    await expect(service.clearToken()).rejects.toMatchObject({
      code: 'action_failed',
    });
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
    expect(service.getCachedState()).toEqual({
      hasToken: true,
      updatedAt: 1234,
    });
    expect(listener).not.toHaveBeenCalled();
  });

  it('fails closed when secure storage deletion fails', async () => {
    const service = new HuggingFaceTokenService();
    await service.saveToken('hf_secret_token');
    const cachedState = service.getCachedState();
    const listener = jest.fn();
    service.subscribe(listener);
    listener.mockClear();

    (SecureStore.deleteItemAsync as jest.Mock).mockRejectedValueOnce(
      new Error('delete failed'),
    );

    await expect(service.clearToken()).rejects.toMatchObject({
      code: 'action_failed',
    });
    expect(service.getCachedState()).toEqual(cachedState);
    await expect(service.getToken()).resolves.toBe('hf_secret_token');
    expect(listener).not.toHaveBeenCalled();
  });
});
