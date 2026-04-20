describe('storage (createStorage)', () => {
  it('does not report in-memory fallback during tests', () => {
    const { createStorage, getStorageFallbackReport } = require('../../src/services/storage');

    createStorage('test-store');

    expect(getStorageFallbackReport()).toBeNull();
  });

  it('reports MMKV init failures outside the test environment', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      (process.env as any).NODE_ENV = 'production';
      jest.resetModules();

      jest.doMock('react-native', () => ({
        Platform: { OS: 'ios' },
      }));

      jest.doMock('react-native-mmkv', () => {
        throw new Error('Native MMKV unavailable');
      });

      const { createStorage, getStorageFallbackReport } = require('../../src/services/storage');

      const storageA = createStorage('store-a');
      storageA.set('key', 'value');

      const storageB = createStorage('store-b');
      storageB.set('key', 'value');

      expect(getStorageFallbackReport()).toEqual({
        storeIds: ['cache:store-a', 'cache:store-b'],
        reasons: {
          'cache:store-a': 'mmkv_init_failed',
          'cache:store-b': 'mmkv_init_failed',
        },
      });
    } finally {
      (process.env as any).NODE_ENV = originalNodeEnv;
      warnSpy.mockRestore();
      jest.resetModules();
      jest.unmock('react-native');
      jest.unmock('react-native-mmkv');
    }
  });

  it('memory fallback supports basic MMKV semantics', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      (process.env as any).NODE_ENV = 'production';
      jest.resetModules();

      jest.doMock('react-native', () => ({
        Platform: { OS: 'ios' },
      }));

      jest.doMock('react-native-mmkv', () => {
        throw new Error('Native MMKV unavailable');
      });

      const { createStorage } = require('../../src/services/storage');

      const storage = createStorage('fallback');

      storage.set('s', 'hello');
      storage.set('n', 42);
      storage.set('b', true);

      expect(storage.getString('s')).toBe('hello');
      expect(storage.getNumber('n')).toBe(42);
      expect(storage.getBoolean('b')).toBe(true);
      expect(storage.contains('s')).toBe(true);
      expect(storage.getAllKeys()).toEqual(expect.arrayContaining(['s', 'n', 'b']));

      storage.remove('s');
      expect(storage.getString('s')).toBeUndefined();

      storage.clearAll();
      expect(storage.getAllKeys()).toEqual([]);
    } finally {
      (process.env as any).NODE_ENV = originalNodeEnv;
      warnSpy.mockRestore();
      jest.resetModules();
      jest.unmock('react-native');
      jest.unmock('react-native-mmkv');
    }
  });

  it('memory fallback handles invalid number/boolean payloads and last-write-wins', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      (process.env as any).NODE_ENV = 'production';
      jest.resetModules();

      jest.doMock('react-native', () => ({
        Platform: { OS: 'ios' },
      }));

      jest.doMock('react-native-mmkv', () => {
        throw new Error('Native MMKV unavailable');
      });

      const { createStorage } = require('../../src/services/storage');
      const storage = createStorage('fallback-2');

      storage.set('n', 'not-a-number');
      storage.set('b', 'yes');
      storage.set('k', 'a');
      storage.set('k', 'b');

      expect(storage.getNumber('missing')).toBeUndefined();
      expect(storage.getNumber('n')).toBeUndefined();
      expect(storage.getBoolean('b')).toBeUndefined();
      expect(storage.getString('k')).toBe('b');
    } finally {
      (process.env as any).NODE_ENV = originalNodeEnv;
      warnSpy.mockRestore();
      jest.resetModules();
      jest.unmock('react-native');
      jest.unmock('react-native-mmkv');
    }
  });

  it('does not include ephemeral tier fallbacks in the health report', () => {
    const originalNodeEnv = process.env.NODE_ENV;

    try {
      (process.env as any).NODE_ENV = 'production';
      jest.resetModules();

      jest.doMock('react-native', () => ({
        Platform: { OS: 'ios' },
      }));

      const { createStorage, getStorageFallbackReport } = require('../../src/services/storage');
      const ephemeral = createStorage('temp', { tier: 'ephemeral' });
      ephemeral.set('k', 'v');

      expect(getStorageFallbackReport()).toBeNull();
    } finally {
      (process.env as any).NODE_ENV = originalNodeEnv;
      jest.resetModules();
      jest.unmock('react-native');
    }
  });

  it('falls back for private tier when encryption is not initialized', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      (process.env as any).NODE_ENV = 'production';
      jest.resetModules();

      jest.doMock('react-native', () => ({
        Platform: { OS: 'ios' },
      }));

      const createMMKV = jest.fn(() => ({
        isEncrypted: false,
        getAllKeys: jest.fn(() => []),
        getString: jest.fn(() => undefined),
        encrypt: jest.fn(),
      }));

      jest.doMock('react-native-mmkv', () => ({
        createMMKV,
        deleteMMKV: jest.fn(),
      }));

      const { createStorage, getStorageFallbackReport } = require('../../src/services/storage');

      const storage = createStorage('private-a', { tier: 'private' });
      storage.set('k', 'v');

      expect(createMMKV).not.toHaveBeenCalled();
      expect(getStorageFallbackReport()).toEqual({
        storeIds: ['private:private-a'],
        reasons: {
          'private:private-a': 'encryption_not_initialized',
        },
      });
    } finally {
      (process.env as any).NODE_ENV = originalNodeEnv;
      warnSpy.mockRestore();
      jest.resetModules();
      jest.unmock('react-native');
      jest.unmock('react-native-mmkv');
    }
  });

  it('marks private encryption as unavailable when SecureStore is not available', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      (process.env as any).NODE_ENV = 'production';
      jest.resetModules();

      jest.doMock('react-native', () => ({
        Platform: { OS: 'ios' },
      }));

      jest.doMock('expo-secure-store', () => ({
        isAvailableAsync: jest.fn(async () => false),
        getItemAsync: jest.fn(async () => null),
        setItemAsync: jest.fn(async () => undefined),
      }), { virtual: true });

      jest.doMock('react-native-mmkv', () => ({
        createMMKV: jest.fn(() => ({
          isEncrypted: false,
          getAllKeys: jest.fn(() => []),
          getString: jest.fn(() => undefined),
          encrypt: jest.fn(),
        })),
        deleteMMKV: jest.fn(),
      }));

      const { initializePrivateStorageEncryption, createStorage, getStorageFallbackReport } = require('../../src/services/storage');

      await initializePrivateStorageEncryption();

      createStorage('private-b', { tier: 'private' });

      expect(getStorageFallbackReport()).toEqual({
        storeIds: ['private:private-b'],
        reasons: {
          'private:private-b': 'encryption_unavailable',
        },
      });
    } finally {
      (process.env as any).NODE_ENV = originalNodeEnv;
      warnSpy.mockRestore();
      jest.resetModules();
      jest.unmock('react-native');
      jest.unmock('expo-secure-store');
      jest.unmock('react-native-mmkv');
    }
  });

  it('initializes private encryption and creates encrypted MMKV instances', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalCrypto = (globalThis as any).crypto;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      (process.env as any).NODE_ENV = 'production';
      (globalThis as any).crypto = {
        getRandomValues: (array: Uint8Array) => {
          for (let i = 0; i < array.length; i += 1) {
            array[i] = (i + 1) & 0xff;
          }
        },
      };

      jest.resetModules();

      jest.doMock('react-native', () => ({
        Platform: { OS: 'ios' },
      }));

      const secureStoreState: Record<string, string> = {};
      jest.doMock('expo-secure-store', () => ({
        isAvailableAsync: jest.fn(async () => true),
        getItemAsync: jest.fn(async (key: string) => secureStoreState[key] ?? null),
        setItemAsync: jest.fn(async (key: string, value: string) => {
          secureStoreState[key] = value;
        }),
        deleteItemAsync: jest.fn(async (key: string) => {
          delete secureStoreState[key];
        }),
      }), { virtual: true });

      const createMMKV = jest.fn((config?: any) => {
        const store = {
          isEncrypted: Boolean(config?.encryptionKey),
          getAllKeys: jest.fn(() => []),
          getString: jest.fn(() => undefined),
          encrypt: jest.fn(function encrypt() {
            store.isEncrypted = true;
          }),
        };
        return store;
      });

      jest.doMock('react-native-mmkv', () => ({
        createMMKV,
        deleteMMKV: jest.fn(),
      }));

      const {
        initializePrivateStorageEncryption,
        isPrivateStorageEncryptionReady,
        createStorage,
        getStorageFallbackReport,
      } = require('../../src/services/storage');

      await initializePrivateStorageEncryption();
      expect(isPrivateStorageEncryptionReady()).toBe(true);

      createStorage('my-private', { tier: 'private' });

      // Should not report any fallback once encrypted storage is ready.
      expect(getStorageFallbackReport()).toBeNull();

      expect(createMMKV).toHaveBeenCalledWith(expect.objectContaining({
        id: 'my-private',
        encryptionKey: expect.any(String),
        encryptionType: 'AES-256',
      }));
    } finally {
      (process.env as any).NODE_ENV = originalNodeEnv;
      (globalThis as any).crypto = originalCrypto;
      warnSpy.mockRestore();
      jest.resetModules();
      jest.unmock('react-native');
      jest.unmock('expo-secure-store');
      jest.unmock('react-native-mmkv');
    }
  });

  it('uses expo-crypto for entropy and repairs MMKV stores during migrations', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalCrypto = (globalThis as any).crypto;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      (process.env as any).NODE_ENV = 'production';
      (globalThis as any).crypto = undefined;
      jest.resetModules();

      jest.doMock('react-native', () => ({
        Platform: { OS: 'ios' },
      }));

      jest.doMock('expo-crypto', () => ({
        getRandomBytesAsync: jest.fn(async (byteCount: number) => {
          const bytes = new Uint8Array(byteCount);
          for (let i = 0; i < bytes.length; i += 1) {
            bytes[i] = (i * 7 + 3) & 0xff;
          }
          return bytes;
        }),
      }), { virtual: true });

      const secureStoreState: Record<string, string> = {
        // Invalid version should be treated as 0 and trigger migrations.
        'pocket-ai-private-mmkv-migration-version': 'not-a-number',
      };
      const getItemAsync = jest.fn(async (key: string) => secureStoreState[key] ?? null);
      const setItemAsync = jest.fn(async (key: string, value: string) => {
        secureStoreState[key] = value;
      });

      jest.doMock('expo-secure-store', () => ({
        isAvailableAsync: jest.fn(async () => true),
        getItemAsync,
        setItemAsync,
        deleteItemAsync: jest.fn(async (key: string) => {
          delete secureStoreState[key];
        }),
      }), { virtual: true });

      const deleteMMKV = jest.fn();

      const createMMKV = jest.fn((config?: any) => {
        const id = config?.id;
        const hasKey = Boolean(config?.encryptionKey);

        // Case 1: mismatch after encryption -> open with key repair.
        if (id === 'global-app-storage' && !hasKey) {
          let encrypted = false;
          return {
            isEncrypted: false,
            getAllKeys: jest.fn(() => ['k']),
            getString: jest.fn((_key: string) => (encrypted ? 'x' : 'v')),
            encrypt: jest.fn(() => {
              encrypted = true;
            }),
          };
        }
        if (id === 'global-app-storage' && hasKey) {
          return {
            isEncrypted: false,
            getAllKeys: jest.fn(() => []),
            getString: jest.fn(() => undefined),
            encrypt: jest.fn(),
          };
        }

        // Case 2: open with key fails -> delete + recreate.
        if (id === 'pocket-ai-settings' && hasKey) {
          // First open attempt fails.
          if (!(createMMKV as any).__settingsOpenFailed) {
            (createMMKV as any).__settingsOpenFailed = true;
            throw new Error('failed to open encrypted store');
          }
        }
        if (id === 'pocket-ai-settings' && !hasKey) {
          throw new Error('store already encrypted, cannot open without key');
        }

        // Case 3: already encrypted.
        if (id === 'pocket-ai-presets' && !hasKey) {
          return {
            isEncrypted: true,
            getAllKeys: jest.fn(() => []),
            getString: jest.fn(() => undefined),
            encrypt: jest.fn(),
          };
        }

        // Default: happy path encryption.
        return {
          isEncrypted: hasKey,
          getAllKeys: jest.fn(() => []),
          getString: jest.fn(() => undefined),
          encrypt: jest.fn(),
        };
      });

      jest.doMock('react-native-mmkv', () => ({
        createMMKV,
        deleteMMKV,
      }));

      const { initializePrivateStorageEncryption, isPrivateStorageEncryptionReady } = require('../../src/services/storage');

      await initializePrivateStorageEncryption();
      expect(isPrivateStorageEncryptionReady()).toBe(true);

      expect(setItemAsync).toHaveBeenCalledWith('pocket-ai-private-mmkv-migration-version', '1');
      expect(deleteMMKV).toHaveBeenCalledWith('pocket-ai-settings');
    } finally {
      (process.env as any).NODE_ENV = originalNodeEnv;
      (globalThis as any).crypto = originalCrypto;
      warnSpy.mockRestore();
      jest.resetModules();
      jest.unmock('react-native');
      jest.unmock('expo-crypto');
      jest.unmock('expo-secure-store');
      jest.unmock('react-native-mmkv');
    }
  });

  it('marks private encryption as unavailable when no secure randomness is available', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalCrypto = (globalThis as any).crypto;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      (process.env as any).NODE_ENV = 'production';
      (globalThis as any).crypto = undefined;
      jest.resetModules();

      jest.doMock('react-native', () => ({
        Platform: { OS: 'ios' },
      }));

      // expo-crypto present but missing API
      jest.doMock('expo-crypto', () => ({}), { virtual: true });

      jest.doMock('expo-secure-store', () => ({
        isAvailableAsync: jest.fn(async () => true),
        getItemAsync: jest.fn(async () => null),
        setItemAsync: jest.fn(async () => undefined),
      }), { virtual: true });

      jest.doMock('react-native-mmkv', () => ({
        createMMKV: jest.fn(),
        deleteMMKV: jest.fn(),
      }));

      const {
        initializePrivateStorageEncryption,
        isPrivateStorageEncryptionReady,
        createStorage,
        getStorageFallbackReport,
      } = require('../../src/services/storage');

      await initializePrivateStorageEncryption();
      expect(isPrivateStorageEncryptionReady()).toBe(false);

      createStorage('private-c', { tier: 'private' });

      expect(getStorageFallbackReport()).toEqual({
        storeIds: ['private:private-c'],
        reasons: {
          'private:private-c': 'encryption_unavailable',
        },
      });
    } finally {
      (process.env as any).NODE_ENV = originalNodeEnv;
      (globalThis as any).crypto = originalCrypto;
      warnSpy.mockRestore();
      jest.resetModules();
      jest.unmock('react-native');
      jest.unmock('expo-crypto');
      jest.unmock('expo-secure-store');
      jest.unmock('react-native-mmkv');
    }
  });
});
