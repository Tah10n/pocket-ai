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

  it('emits an updated state after startup when secure storage already contains a token', async () => {
    await SecureStore.setItemAsync('huggingface-access-token', 'hf_bootstrap_token');
    const service = new HuggingFaceTokenService();
    const listener = jest.fn();

    service.subscribe(listener);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ hasToken: false }), 'replay');
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ hasToken: true }), 'hydrate');
    await expect(service.getToken()).resolves.toBe('hf_bootstrap_token');
  });

  it('rejects token saves when secure storage is unavailable', async () => {
    (SecureStore.isAvailableAsync as jest.Mock).mockResolvedValue(false);
    const service = new HuggingFaceTokenService();

    await expect(service.saveToken('hf_secret_token')).rejects.toThrow(
      'Secure storage is unavailable on this device.',
    );
    await expect(service.getToken()).resolves.toBeNull();
  });
});
