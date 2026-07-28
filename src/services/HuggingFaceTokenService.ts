import * as SecureStore from 'expo-secure-store';
import { AppError } from './AppError';

export interface HuggingFaceTokenState {
  hasToken: boolean;
  updatedAt: number;
}

export interface HuggingFaceTokenSnapshot {
  token: string | null;
  revision: number;
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
  private committedToken: string | null = null;
  private availabilityPromise: Promise<boolean> | null = null;
  private revision = 0;
  private operationTail: Promise<void> = Promise.resolve();

  public getCachedState(): HuggingFaceTokenState {
    return { ...this.state };
  }

  public getCachedRevision(): number {
    return this.revision;
  }

  public subscribe(listener: Listener) {
    this.listeners.add(listener);
    listener(this.getCachedState(), 'replay');
    return () => {
      this.listeners.delete(listener);
    };
  }

  public async getToken(): Promise<string | null> {
    return this.runExclusive(() => this.readNormalizedToken());
  }

  public async getSnapshot(): Promise<HuggingFaceTokenSnapshot> {
    return this.runExclusive(async () => {
      const token = await this.readNormalizedToken();
      if (this.state.hasToken !== Boolean(token) || this.committedToken !== token) {
        this.commitTokenState(token, 'hydrate');
      }

      return {
        token,
        revision: this.revision,
      };
    });
  }

  public async hasToken(): Promise<boolean> {
    return Boolean(await this.getToken());
  }

  public async saveToken(token: string): Promise<HuggingFaceTokenState> {
    const trimmed = token.trim();
    if (!trimmed) {
      return this.clearToken();
    }

    return this.runExclusive(async () => {
      if (!await this.isSecureStoreAvailable()) {
        throw new AppError(
          'action_failed',
          'Secure storage is unavailable on this device. Hugging Face tokens cannot be saved.',
        );
      }

      await SecureStore.setItemAsync(HF_TOKEN_KEY, trimmed);

      this.commitTokenState(trimmed, 'mutation', true);
      return this.getCachedState();
    });
  }

  public async clearToken(): Promise<HuggingFaceTokenState> {
    return this.runExclusive(async () => {
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
        this.commitTokenState(null, 'mutation', true);
      } else {
        this.state = {
          hasToken: false,
          updatedAt: Date.now(),
        };
      }

      return this.getCachedState();
    });
  }

  public async refreshState(): Promise<HuggingFaceTokenState> {
    return this.runExclusive(async () => {
      const token = await this.readNormalizedToken();
      if (this.state.hasToken !== Boolean(token) || this.committedToken !== token) {
        this.commitTokenState(token, 'hydrate');
      } else {
        this.state = {
          hasToken: Boolean(token),
          updatedAt: Date.now(),
        };
      }

      return this.getCachedState();
    });
  }

  private async readNormalizedToken(): Promise<string | null> {
    const stored = await this.readToken();
    const normalized = typeof stored === 'string' ? stored.trim() : '';
    return normalized.length > 0 ? normalized : null;
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

  private commitTokenState(
    token: string | null,
    source: Exclude<HuggingFaceTokenStateChangeSource, 'replay'>,
    forceEpoch = false,
  ): void {
    const hasToken = Boolean(token);
    const didChange = this.state.hasToken !== hasToken || this.committedToken !== token;
    this.state = {
      hasToken,
      updatedAt: Date.now(),
    };
    this.committedToken = token;

    if (!didChange && !forceEpoch) {
      return;
    }

    this.revision += 1;
    this.listeners.forEach((listener) => {
      try {
        listener(this.getCachedState(), source);
      } catch {
        console.warn('[HuggingFaceTokenService] Token state listener failed');
      }
    });
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previousOperation = this.operationTail;
    let releaseOperation!: () => void;
    this.operationTail = new Promise<void>((resolve) => {
      releaseOperation = resolve;
    });

    await previousOperation;
    try {
      return await operation();
    } finally {
      releaseOperation();
    }
  }
}

export const huggingFaceTokenService = new HuggingFaceTokenService();
