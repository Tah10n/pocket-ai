import * as SecureStore from 'expo-secure-store';
import { AppError } from './AppError';

export interface HuggingFaceTokenState {
  hasToken: boolean;
  updatedAt: number;
}

export type HuggingFaceTokenStateChangeSource = 'replay' | 'hydrate' | 'mutation';

type Listener = (state: HuggingFaceTokenState, source: HuggingFaceTokenStateChangeSource) => void;

const HF_TOKEN_KEY = 'huggingface-access-token';

export class HuggingFaceTokenService {
  private listeners = new Set<Listener>();
  private state: HuggingFaceTokenState = {
    hasToken: false,
    updatedAt: Date.now(),
  };
  private tokenFingerprint: string | null = null;
  private availabilityPromise: Promise<boolean> | null = null;

  public getCachedState(): HuggingFaceTokenState {
    return { ...this.state };
  }

  public subscribe(listener: Listener) {
    this.listeners.add(listener);
    listener(this.getCachedState(), 'replay');
    return () => {
      this.listeners.delete(listener);
    };
  }

  public async getToken(): Promise<string | null> {
    const stored = await this.readToken();
    const normalized = typeof stored === 'string' ? stored.trim() : '';
    return normalized.length > 0 ? normalized : null;
  }

  public async hasToken(): Promise<boolean> {
    return Boolean(await this.getToken());
  }

  public async saveToken(token: string): Promise<HuggingFaceTokenState> {
    const trimmed = token.trim();
    if (!trimmed) {
      return this.clearToken();
    }

    if (!await this.isSecureStoreAvailable()) {
      throw new AppError(
        'action_failed',
        'Secure storage is unavailable on this device. Hugging Face tokens cannot be saved.',
      );
    }

    await SecureStore.setItemAsync(HF_TOKEN_KEY, trimmed);

    this.emit(true, this.fingerprintToken(trimmed));
    return this.getCachedState();
  }

  public async clearToken(): Promise<HuggingFaceTokenState> {
    await this.requireSecureStoreAvailableForClear();

    let stored: string | null;
    try {
      stored = await SecureStore.getItemAsync(HF_TOKEN_KEY);
    } catch (error) {
      throw this.createClearFailure(
        'Unable to read Hugging Face token state from secure storage.',
        error,
      );
    }

    const hasStoredValue = stored !== null;

    if (hasStoredValue) {
      try {
        await SecureStore.deleteItemAsync(HF_TOKEN_KEY);
      } catch (error) {
        throw this.createClearFailure(
          'Unable to clear Hugging Face token from secure storage.',
          error,
        );
      }
    }

    if (hasStoredValue || this.state.hasToken) {
      this.emit(false, null);
    } else {
      this.state = {
        hasToken: false,
        updatedAt: Date.now(),
      };
    }

    return this.getCachedState();
  }

  public async refreshState(): Promise<HuggingFaceTokenState> {
    const token = await this.getToken();
    const hasToken = Boolean(token);
    const tokenFingerprint = token ? this.fingerprintToken(token) : null;
    const previousHasToken = this.state.hasToken;
    const previousTokenFingerprint = this.tokenFingerprint;
    this.state = {
      hasToken,
      updatedAt: Date.now(),
    };
    this.tokenFingerprint = tokenFingerprint;

    if (previousHasToken !== hasToken || previousTokenFingerprint !== tokenFingerprint) {
      this.listeners.forEach((listener) => listener(this.getCachedState(), 'hydrate'));
    }

    return this.getCachedState();
  }

  private async readToken(): Promise<string | null> {
    if (await this.isSecureStoreAvailable()) {
      return SecureStore.getItemAsync(HF_TOKEN_KEY);
    }

    return null;
  }

  private async isSecureStoreAvailable(): Promise<boolean> {
    try {
      return await this.checkSecureStoreAvailability();
    } catch {
      return false;
    }
  }

  private async checkSecureStoreAvailability(): Promise<boolean> {
    if (this.availabilityPromise) {
      return this.availabilityPromise;
    }

    const availabilityPromise = SecureStore.isAvailableAsync()
      .then((available) => {
        if (!available && this.availabilityPromise === availabilityPromise) {
          this.availabilityPromise = null;
        }

        return available;
      })
      .catch((error) => {
        if (this.availabilityPromise === availabilityPromise) {
          this.availabilityPromise = null;
        }

        throw error;
      });

    this.availabilityPromise = availabilityPromise;
    return availabilityPromise;
  }

  private async requireSecureStoreAvailableForClear(): Promise<void> {
    try {
      if (await this.checkSecureStoreAvailability()) {
        return;
      }

      throw new AppError(
        'action_failed',
        'Secure storage is unavailable on this device. Hugging Face tokens cannot be cleared safely.',
      );
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      throw this.createClearFailure(
        'Unable to verify secure storage availability before clearing Hugging Face token.',
        error,
      );
    }
  }

  private createClearFailure(message: string, cause: unknown): AppError {
    return new AppError('action_failed', message, { cause });
  }

  private emit(hasToken: boolean, tokenFingerprint: string | null) {
    this.state = {
      hasToken,
      updatedAt: Date.now(),
    };
    this.tokenFingerprint = tokenFingerprint;

    this.listeners.forEach((listener) => listener(this.getCachedState(), 'mutation'));
  }

  private fingerprintToken(token: string): string {
    let hash = 2166136261;
    for (let index = 0; index < token.length; index += 1) {
      hash ^= token.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }

    return `${token.length}:${(hash >>> 0).toString(16)}`;
  }
}

export const huggingFaceTokenService = new HuggingFaceTokenService();
