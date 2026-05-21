import * as SecureStore from 'expo-secure-store';
import { HuggingFaceTokenService } from '../../src/services/HuggingFaceTokenService';

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
