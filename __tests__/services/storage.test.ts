describe('storage (createStorage)', () => {
  it('does not report in-memory fallback during tests', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalProcess = (globalThis as any).process;

    try {
      Object.defineProperty(process.env, 'NODE_ENV', {
        value: 'test',
        configurable: true,
        writable: true,
      });
      (globalThis as any).process = {
        ...originalProcess,
        env: {
          ...originalProcess.env,
          NODE_ENV: 'test',
        },
      };
      jest.resetModules();

      const { createStorage, getStorageFallbackReport } = require('../../src/services/storage');

      createStorage('test-store');

      expect(getStorageFallbackReport()).toBeNull();
    } finally {
      (globalThis as any).process = originalProcess;
      Object.defineProperty(process.env, 'NODE_ENV', {
        value: originalNodeEnv,
        configurable: true,
        writable: true,
      });
      jest.resetModules();
    }
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

  it('fails closed for native private tier when encryption is not initialized', async () => {
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

      const {
        createStorage,
        getPrivateStorageHealthSnapshot,
        getStorageFallbackReport,
        isPrivateStorageWritable,
        PrivateStorageUnavailableError,
      } = require('../../src/services/storage');

      expect(() => createStorage('private-a', { tier: 'private' })).toThrow(PrivateStorageUnavailableError);

      expect(createMMKV).not.toHaveBeenCalled();
      expect(getStorageFallbackReport()).toBeNull();
      expect(isPrivateStorageWritable()).toBe(false);
      expect(getPrivateStorageHealthSnapshot()).toEqual(expect.objectContaining({
        status: 'blocked',
        reason: 'encryption_not_initialized',
        retryable: true,
        requiresExplicitReset: false,
        messageKey: expect.any(String),
        lastUpdatedAt: expect.any(Number),
      }));
    } finally {
      (process.env as any).NODE_ENV = originalNodeEnv;
      warnSpy.mockRestore();
      jest.resetModules();
      jest.unmock('react-native');
      jest.unmock('react-native-mmkv');
    }
  });

  it('recovers from a blocked pre-encryption access through retry initialization', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalCrypto = (globalThis as any).crypto;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      (process.env as any).NODE_ENV = 'production';
      (globalThis as any).crypto = {
        getRandomValues: (array: Uint8Array) => {
          for (let i = 0; i < array.length; i += 1) {
            array[i] = (i + 5) & 0xff;
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

      const createMMKV = jest.fn((config?: any) => ({
        isEncrypted: Boolean(config?.encryptionKey),
        getAllKeys: jest.fn(() => []),
        getString: jest.fn(() => undefined),
        encrypt: jest.fn(),
      }));

      jest.doMock('react-native-mmkv', () => ({
        createMMKV,
        deleteMMKV: jest.fn(),
      }));

      const {
        createStorage,
        getPrivateStorageHealthSnapshot,
        isPrivateStorageWritable,
        retryPrivateStorageInitialization,
        PrivateStorageUnavailableError,
      } = require('../../src/services/storage');

      expect(getPrivateStorageHealthSnapshot()).toEqual(expect.objectContaining({
        status: 'unknown',
        retryable: true,
        requiresExplicitReset: false,
      }));
      expect(() => createStorage('private-retry', { tier: 'private' })).toThrow(PrivateStorageUnavailableError);
      expect(getPrivateStorageHealthSnapshot()).toEqual(expect.objectContaining({
        status: 'blocked',
        reason: 'encryption_not_initialized',
      }));

      await expect(retryPrivateStorageInitialization()).resolves.toEqual(expect.objectContaining({
        status: 'ready',
        retryable: false,
        requiresExplicitReset: false,
      }));

      expect(isPrivateStorageWritable()).toBe(true);
      expect(createStorage('private-retry', { tier: 'private' })).toBeTruthy();
      expect(createMMKV).toHaveBeenCalledWith(expect.objectContaining({
        id: 'private-retry',
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

      const {
        initializePrivateStorageEncryption,
        createStorage,
        getPrivateStorageHealthSnapshot,
        getStorageFallbackReport,
        isPrivateStorageWritable,
        PrivateStorageUnavailableError,
      } = require('../../src/services/storage');

      await expect(initializePrivateStorageEncryption()).resolves.toEqual(expect.objectContaining({
        status: 'blocked',
        reason: 'secure_key_unavailable',
      }));

      expect(() => createStorage('private-b', { tier: 'private' })).toThrow(PrivateStorageUnavailableError);

      expect(getStorageFallbackReport()).toBeNull();
      expect(isPrivateStorageWritable()).toBe(false);
      expect(getPrivateStorageHealthSnapshot()).toEqual(expect.objectContaining({
        status: 'blocked',
        reason: 'secure_key_unavailable',
        retryable: true,
        requiresExplicitReset: false,
      }));
    } finally {
      (process.env as any).NODE_ENV = originalNodeEnv;
      warnSpy.mockRestore();
      jest.resetModules();
      jest.unmock('react-native');
      jest.unmock('expo-secure-store');
      jest.unmock('react-native-mmkv');
    }
  });

  it('blocks private encryption when reading the secure key fails', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      (process.env as any).NODE_ENV = 'production';
      jest.resetModules();

      jest.doMock('react-native', () => ({
        Platform: { OS: 'ios' },
      }));

      const getItemAsync = jest.fn(async () => {
        throw new Error('secure key read failed');
      });
      const setItemAsync = jest.fn(async () => undefined);

      jest.doMock('expo-secure-store', () => ({
        isAvailableAsync: jest.fn(async () => true),
        getItemAsync,
        setItemAsync,
        deleteItemAsync: jest.fn(async () => undefined),
      }), { virtual: true });

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

      const {
        initializePrivateStorageEncryption,
        createStorage,
        getPrivateStorageHealthSnapshot,
        isPrivateStorageWritable,
        PrivateStorageUnavailableError,
      } = require('../../src/services/storage');

      await expect(initializePrivateStorageEncryption()).resolves.toEqual(expect.objectContaining({
        status: 'blocked',
        reason: 'secure_key_unavailable',
        retryable: true,
        requiresExplicitReset: false,
      }));

      expect(getItemAsync).toHaveBeenCalledWith('pocket-ai-private-mmkv-key-v1');
      expect(setItemAsync).not.toHaveBeenCalled();
      expect(createMMKV).not.toHaveBeenCalled();
      expect(isPrivateStorageWritable()).toBe(false);
      expect(() => createStorage('private-secure-key-read-fails', { tier: 'private' })).toThrow(PrivateStorageUnavailableError);
      expect(getPrivateStorageHealthSnapshot()).toEqual(expect.objectContaining({
        status: 'blocked',
        reason: 'secure_key_unavailable',
        retryable: true,
        requiresExplicitReset: false,
      }));
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

  it('blocks encrypted open failures during migrations without deleting MMKV', async () => {
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

      const {
        getPrivateStorageHealthSnapshot,
        initializePrivateStorageEncryption,
        isPrivateStorageEncryptionReady,
      } = require('../../src/services/storage');

      await expect(initializePrivateStorageEncryption()).resolves.toEqual(expect.objectContaining({
        status: 'blocked',
        reason: 'encrypted_open_failed',
        retryable: true,
        requiresExplicitReset: true,
      }));
      expect(isPrivateStorageEncryptionReady()).toBe(false);

      expect(setItemAsync).not.toHaveBeenCalledWith('pocket-ai-private-mmkv-migration-version', '1');
      expect(deleteMMKV).not.toHaveBeenCalled();
      expect(getPrivateStorageHealthSnapshot()).toEqual(expect.objectContaining({
        status: 'blocked',
        reason: 'encrypted_open_failed',
        retryable: true,
        requiresExplicitReset: true,
      }));
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

  it('deletes private MMKV stores only through explicit reset after an encrypted open failure', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalCrypto = (globalThis as any).crypto;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      (process.env as any).NODE_ENV = 'production';
      (globalThis as any).crypto = {
        getRandomValues: (array: Uint8Array) => {
          for (let i = 0; i < array.length; i += 1) {
            array[i] = (i + 11) & 0xff;
          }
        },
      };
      jest.resetModules();

      jest.doMock('react-native', () => ({
        Platform: { OS: 'ios' },
      }));

      const secureStoreState: Record<string, string> = {
        'pocket-ai-private-mmkv-key-v1': 'a'.repeat(32),
        'pocket-ai-private-mmkv-migration-version': '1',
      };
      const deleteItemAsync = jest.fn(async (key: string) => {
        delete secureStoreState[key];
      });

      jest.doMock('expo-secure-store', () => ({
        isAvailableAsync: jest.fn(async () => true),
        getItemAsync: jest.fn(async (key: string) => secureStoreState[key] ?? null),
        setItemAsync: jest.fn(async (key: string, value: string) => {
          secureStoreState[key] = value;
        }),
        deleteItemAsync,
      }), { virtual: true });

      let resetStarted = false;
      const deleteMMKV = jest.fn((_id: string) => {
        resetStarted = true;
      });
      const createMMKV = jest.fn((config?: any) => {
        if (config?.id === 'pocket-ai-settings' && config?.encryptionKey && !resetStarted) {
          throw new Error('raw native open failure with sensitive details');
        }

        return {
          isEncrypted: Boolean(config?.encryptionKey),
          getAllKeys: jest.fn(() => []),
          getString: jest.fn(() => undefined),
          encrypt: jest.fn(),
        };
      });

      jest.doMock('react-native-mmkv', () => ({
        createMMKV,
        deleteMMKV,
      }));

      const {
        createStorage,
        getPrivateStorageHealthSnapshot,
        initializePrivateStorageEncryption,
        isPrivateStorageWritable,
        resetPrivateAppStorageAfterConfirmation,
        PrivateStorageUnavailableError,
      } = require('../../src/services/storage');

      await expect(initializePrivateStorageEncryption()).resolves.toEqual(expect.objectContaining({
        status: 'ready',
      }));
      expect(isPrivateStorageWritable()).toBe(true);

      let thrown: any;
      try {
        createStorage('pocket-ai-settings', { tier: 'private' });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(PrivateStorageUnavailableError);
      expect(thrown.message).toBe('Private storage is unavailable (encrypted_open_failed)');
      expect(thrown.message).not.toContain('raw native open failure');
      expect(deleteMMKV).not.toHaveBeenCalled();
      expect(getPrivateStorageHealthSnapshot()).toEqual(expect.objectContaining({
        status: 'blocked',
        reason: 'encrypted_open_failed',
        retryable: true,
        requiresExplicitReset: true,
      }));

      await expect(resetPrivateAppStorageAfterConfirmation()).resolves.toEqual(expect.objectContaining({
        status: 'ready',
      }));

      expect(deleteMMKV).toHaveBeenCalledWith('global-app-storage');
      expect(deleteMMKV).toHaveBeenCalledWith('pocket-ai-settings');
      expect(deleteMMKV).toHaveBeenCalledWith('pocket-ai-presets');
      expect(deleteMMKV).toHaveBeenCalledWith('models-registry');
      expect(deleteMMKV).toHaveBeenCalledWith('pocket-ai-last-good-profiles');
      expect(deleteMMKV).toHaveBeenCalledWith('pocket-ai-autotune');
      expect(deleteMMKV).not.toHaveBeenCalledWith(expect.stringContaining('gguf'));
      expect(deleteItemAsync).toHaveBeenCalledWith('pocket-ai-private-mmkv-key-v1');
      expect(deleteItemAsync).toHaveBeenCalledWith('pocket-ai-private-mmkv-migration-version');
      expect(isPrivateStorageWritable()).toBe(true);
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
        getPrivateStorageHealthSnapshot,
        getStorageFallbackReport,
        PrivateStorageUnavailableError,
      } = require('../../src/services/storage');

      await expect(initializePrivateStorageEncryption()).resolves.toEqual(expect.objectContaining({
        status: 'blocked',
        reason: 'secure_key_unavailable',
      }));
      expect(isPrivateStorageEncryptionReady()).toBe(false);

      expect(() => createStorage('private-c', { tier: 'private' })).toThrow(PrivateStorageUnavailableError);

      expect(getStorageFallbackReport()).toBeNull();
      expect(getPrivateStorageHealthSnapshot()).toEqual(expect.objectContaining({
        status: 'blocked',
        reason: 'secure_key_unavailable',
        retryable: true,
        requiresExplicitReset: false,
      }));
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
