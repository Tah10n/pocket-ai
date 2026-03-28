import * as SecureStore from 'expo-secure-store';

export interface HuggingFaceTokenState {
  hasToken: boolean;
  updatedAt: number;
}

type Listener = (state: HuggingFaceTokenState) => void;

const HF_TOKEN_KEY = 'huggingface-access-token';

export class HuggingFaceTokenService {
  private listeners = new Set<Listener>();
  private state: HuggingFaceTokenState = {
    hasToken: false,
    updatedAt: Date.now(),
  };
  private availabilityPromise: Promise<boolean> | null = null;
  private memoryFallbackToken: string | null = null;

  constructor() {
    void this.refreshState();
  }

  public getCachedState(): HuggingFaceTokenState {
    return { ...this.state };
  }

  public subscribe(listener: Listener) {
    this.listeners.add(listener);
    listener(this.getCachedState());
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

    if (await this.isSecureStoreAvailable()) {
      await SecureStore.setItemAsync(HF_TOKEN_KEY, trimmed);
    } else {
      this.memoryFallbackToken = trimmed;
    }

    this.emit(true);
    return this.getCachedState();
  }

  public async clearToken(): Promise<HuggingFaceTokenState> {
    const hadToken = await this.hasToken();

    if (await this.isSecureStoreAvailable()) {
      await SecureStore.deleteItemAsync(HF_TOKEN_KEY);
    }

    this.memoryFallbackToken = null;

    if (hadToken || this.state.hasToken) {
      this.emit(false);
    } else {
      this.state = {
        hasToken: false,
        updatedAt: Date.now(),
      };
    }

    return this.getCachedState();
  }

  public async refreshState(): Promise<HuggingFaceTokenState> {
    const hasToken = await this.hasToken();
    const previousHasToken = this.state.hasToken;
    this.state = {
      hasToken,
      updatedAt: Date.now(),
    };

    if (previousHasToken !== hasToken) {
      this.listeners.forEach((listener) => listener(this.getCachedState()));
    }

    return this.getCachedState();
  }

  private async readToken(): Promise<string | null> {
    if (await this.isSecureStoreAvailable()) {
      return SecureStore.getItemAsync(HF_TOKEN_KEY);
    }

    return this.memoryFallbackToken;
  }

  private async isSecureStoreAvailable(): Promise<boolean> {
    if (!this.availabilityPromise) {
      this.availabilityPromise = SecureStore.isAvailableAsync().catch(() => false);
    }

    return this.availabilityPromise;
  }

  private emit(hasToken: boolean) {
    this.state = {
      hasToken,
      updatedAt: Date.now(),
    };

    this.listeners.forEach((listener) => listener(this.getCachedState()));
  }
}

export const huggingFaceTokenService = new HuggingFaceTokenService();
