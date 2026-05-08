const PRIVATE_STORAGE_INSTANCE_IDS = [
  'global-app-storage',
  'pocket-ai-settings',
  'pocket-ai-presets',
  'models-registry',
  'pocket-ai-last-good-profiles',
  'pocket-ai-autotune',
] as const;

type TypedMmkvValue = string | number | boolean | ArrayBuffer | { unsupported: true };

function copyBuffer(value: ArrayBuffer): ArrayBuffer {
  const source = new Uint8Array(value);
  const copy = new Uint8Array(source.length);
  copy.set(source);
  return copy.buffer;
}

function cloneTypedValue(value: TypedMmkvValue): TypedMmkvValue {
  return value instanceof ArrayBuffer ? copyBuffer(value) : value;
}

function createTypedMmkvStore(
  initialValues: Record<string, TypedMmkvValue> = {},
  options: {
    encrypted?: boolean;
    omitBufferReader?: boolean;
    ambiguousKeys?: string[];
    throwOnEncrypt?: boolean;
    throwOnSetKeys?: string[];
    mutateOnEncrypt?: (values: Map<string, TypedMmkvValue>) => void;
  } = {},
) {
  const values = new Map<string, TypedMmkvValue>(
    Object.entries(initialValues).map(([key, value]) => [key, cloneTypedValue(value)]),
  );
  const ambiguousKeys = new Set(options.ambiguousKeys ?? []);
  const throwOnSetKeys = new Set(options.throwOnSetKeys ?? []);
  let encrypted = Boolean(options.encrypted);

  const store: any = {
    get isEncrypted() {
      return encrypted;
    },
    set: jest.fn((key: string, value: TypedMmkvValue) => {
      if (throwOnSetKeys.has(key)) {
        throw new Error('set failed');
      }
      values.set(key, cloneTypedValue(value));
    }),
    getAllKeys: jest.fn(() => Array.from(values.keys())),
    getString: jest.fn((key: string) => {
      const value = values.get(key);
      if (ambiguousKeys.has(key) && value !== undefined) {
        return 'ambiguous';
      }
      return typeof value === 'string' ? value : undefined;
    }),
    getNumber: jest.fn((key: string) => {
      const value = values.get(key);
      return typeof value === 'number' ? value : undefined;
    }),
    getBoolean: jest.fn((key: string) => {
      const value = values.get(key);
      return typeof value === 'boolean' ? value : undefined;
    }),
    contains: jest.fn((key: string) => values.has(key)),
    remove: jest.fn((key: string) => values.delete(key)),
    clearAll: jest.fn(() => values.clear()),
    encrypt: jest.fn(() => {
      encrypted = true;
      options.mutateOnEncrypt?.(values);
      if (options.throwOnEncrypt) {
        throw new Error('encrypt failed');
      }
    }),
    __values: values,
  };

  if (!options.omitBufferReader) {
    store.getBuffer = jest.fn((key: string) => {
      const value = values.get(key);
      return value instanceof ArrayBuffer ? copyBuffer(value) : undefined;
    });
  }

  return store;
}

function createEmptyPrivateStores() {
  return new Map<string, any>(
    PRIVATE_STORAGE_INSTANCE_IDS.map((storeId) => [storeId, createTypedMmkvStore()]),
  );
}

function mockReactNativeIos() {
  jest.doMock('react-native', () => ({
    Platform: { OS: 'ios' },
  }));
}

function mockCryptoBytes(offset = 1) {
  (globalThis as any).crypto = {
    getRandomValues: (array: Uint8Array) => {
      for (let i = 0; i < array.length; i += 1) {
        array[i] = (i + offset) & 0xff;
      }
    },
  };
}

function mockSecureStoreState(
  secureStoreState: Record<string, string>,
  options: { failDeleteForKeys?: string[]; failDeleteOnceForKeys?: string[] } = {},
) {
  const failedDeleteKeys = new Set<string>();
  const getItemAsync = jest.fn(async (key: string) => secureStoreState[key] ?? null);
  const setItemAsync = jest.fn(async (key: string, value: string) => {
    secureStoreState[key] = value;
  });
  const deleteItemAsync = jest.fn(async (key: string) => {
    if ((options.failDeleteForKeys ?? []).includes(key)) {
      throw new Error('delete failed');
    }
    if ((options.failDeleteOnceForKeys ?? []).includes(key) && !failedDeleteKeys.has(key)) {
      failedDeleteKeys.add(key);
      throw new Error('delete failed');
    }
    delete secureStoreState[key];
  });

  jest.doMock('expo-secure-store', () => ({
    isAvailableAsync: jest.fn(async () => true),
    getItemAsync,
    setItemAsync,
    deleteItemAsync,
  }), { virtual: true });

  return { getItemAsync, setItemAsync, deleteItemAsync };
}

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

  it('preserves typed values during private MMKV encryption migration', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalCrypto = (globalThis as any).crypto;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      (process.env as any).NODE_ENV = 'production';
      mockCryptoBytes(17);
      jest.resetModules();
      mockReactNativeIos();

      const secureStoreState: Record<string, string> = {};
      const { setItemAsync } = mockSecureStoreState(secureStoreState);

      const stores = createEmptyPrivateStores();
      const binaryValue = new Uint8Array([1, 2, 3, 255]).buffer;
      const globalStore = createTypedMmkvStore({
        json: '{"theme":"dark"}',
        empty: '',
        numericString: '42',
        zero: 0,
        negative: -7.5,
        yes: true,
        no: false,
        binary: binaryValue,
      });
      stores.set('global-app-storage', globalStore);

      const createMMKV = jest.fn((config?: any) => {
        const id = config?.id;
        return stores.get(id) ?? createTypedMmkvStore({}, { encrypted: Boolean(config?.encryptionKey) });
      });
      const deleteMMKV = jest.fn();

      jest.doMock('react-native-mmkv', () => ({ createMMKV, deleteMMKV }));

      const {
        initializePrivateStorageEncryption,
        isPrivateStorageEncryptionReady,
        getStorageFallbackReport,
      } = require('../../src/services/storage');

      await expect(initializePrivateStorageEncryption()).resolves.toEqual(expect.objectContaining({
        status: 'ready',
      }));

      expect(isPrivateStorageEncryptionReady()).toBe(true);
      expect(globalStore.getString('json')).toBe('{"theme":"dark"}');
      expect(globalStore.getString('empty')).toBe('');
      expect(globalStore.getString('numericString')).toBe('42');
      expect(globalStore.getNumber('zero')).toBe(0);
      expect(globalStore.getNumber('negative')).toBe(-7.5);
      expect(globalStore.getBoolean('yes')).toBe(true);
      expect(globalStore.getBoolean('no')).toBe(false);
      expect(Array.from(new Uint8Array((globalStore.getBuffer as jest.Mock)('binary')))).toEqual([1, 2, 3, 255]);
      expect(setItemAsync).toHaveBeenCalledWith('pocket-ai-private-mmkv-migration-version', '1');
      expect(deleteMMKV).not.toHaveBeenCalled();
      expect(getStorageFallbackReport()).toBeNull();
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

  it('runs migrations for missing, invalid, and stale markers while skipping current markers', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalCrypto = (globalThis as any).crypto;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const cases: Array<{ marker?: string; expectedMigrationCalls: number }> = [
      { marker: undefined, expectedMigrationCalls: PRIVATE_STORAGE_INSTANCE_IDS.length },
      { marker: 'not-a-number', expectedMigrationCalls: PRIVATE_STORAGE_INSTANCE_IDS.length },
      { marker: '0', expectedMigrationCalls: PRIVATE_STORAGE_INSTANCE_IDS.length },
      { marker: '1', expectedMigrationCalls: 0 },
    ];

    try {
      for (const [index, testCase] of cases.entries()) {
        (process.env as any).NODE_ENV = 'production';
        mockCryptoBytes(30 + index);
        jest.resetModules();
        mockReactNativeIos();

        const secureStoreState: Record<string, string> = {};
        if (testCase.marker !== undefined) {
          secureStoreState['pocket-ai-private-mmkv-migration-version'] = testCase.marker;
        }
        mockSecureStoreState(secureStoreState);

        const stores = createEmptyPrivateStores();
        const createMMKV = jest.fn((config?: any) => stores.get(config?.id) ?? createTypedMmkvStore());
        jest.doMock('react-native-mmkv', () => ({
          createMMKV,
          deleteMMKV: jest.fn(),
        }));

        const { initializePrivateStorageEncryption } = require('../../src/services/storage');

        await expect(initializePrivateStorageEncryption()).resolves.toEqual(expect.objectContaining({
          status: 'ready',
        }));

        const migrationCalls = createMMKV.mock.calls.filter(([config]) => config?.id && !config?.encryptionKey);
        expect(migrationCalls).toHaveLength(testCase.expectedMigrationCalls);
        expect(secureStoreState['pocket-ai-private-mmkv-migration-version']).toBe('1');

        jest.unmock('react-native');
        jest.unmock('expo-secure-store');
        jest.unmock('react-native-mmkv');
      }
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

  it('retries transient in-progress marker cleanup after successful migration', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalCrypto = (globalThis as any).crypto;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      (process.env as any).NODE_ENV = 'production';
      mockCryptoBytes(45);
      jest.resetModules();
      mockReactNativeIos();

      const secureStoreState: Record<string, string> = {};
      const { deleteItemAsync } = mockSecureStoreState(secureStoreState, {
        failDeleteOnceForKeys: ['pocket-ai-private-mmkv-migration-in-progress'],
      });

      const stores = createEmptyPrivateStores();
      stores.set('global-app-storage', createTypedMmkvStore({ value: 'safe' }));
      const createMMKV = jest.fn((config?: any) => stores.get(config?.id) ?? createTypedMmkvStore());
      jest.doMock('react-native-mmkv', () => ({
        createMMKV,
        deleteMMKV: jest.fn(),
      }));

      const { initializePrivateStorageEncryption } = require('../../src/services/storage');

      await expect(initializePrivateStorageEncryption()).resolves.toEqual(expect.objectContaining({
        status: 'ready',
      }));

      expect(deleteItemAsync).toHaveBeenCalledWith('pocket-ai-private-mmkv-migration-in-progress');
      expect(secureStoreState['pocket-ai-private-mmkv-migration-in-progress']).toBeUndefined();
      expect(secureStoreState['pocket-ai-private-mmkv-migration-version']).toBe('1');
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

  it('blocks with explicit reset when in-progress marker cleanup cannot be cleared', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalCrypto = (globalThis as any).crypto;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      (process.env as any).NODE_ENV = 'production';
      mockCryptoBytes(46);
      jest.resetModules();
      mockReactNativeIos();

      const secureStoreState: Record<string, string> = {};
      const { deleteItemAsync, setItemAsync } = mockSecureStoreState(secureStoreState, {
        failDeleteForKeys: ['pocket-ai-private-mmkv-migration-in-progress'],
      });

      const stores = createEmptyPrivateStores();
      stores.set('global-app-storage', createTypedMmkvStore({ value: 'safe' }));
      const createMMKV = jest.fn((config?: any) => stores.get(config?.id) ?? createTypedMmkvStore());
      const deleteMMKV = jest.fn();
      jest.doMock('react-native-mmkv', () => ({ createMMKV, deleteMMKV }));

      const {
        getPrivateStorageHealthSnapshot,
        initializePrivateStorageEncryption,
      } = require('../../src/services/storage');

      await expect(initializePrivateStorageEncryption()).resolves.toEqual(expect.objectContaining({
        status: 'blocked',
        reason: 'migration_failed',
        requiresExplicitReset: true,
      }));

      expect(getPrivateStorageHealthSnapshot()).toEqual(expect.objectContaining({
        status: 'blocked',
        reason: 'migration_failed',
        requiresExplicitReset: true,
      }));
      expect(secureStoreState['pocket-ai-private-mmkv-migration-in-progress']).toBe('global-app-storage');
      expect(secureStoreState['pocket-ai-private-mmkv-migration-version']).toBeUndefined();
      expect(setItemAsync).not.toHaveBeenCalledWith('pocket-ai-private-mmkv-migration-version', '1');
      expect(deleteItemAsync.mock.calls.filter(([key]) => key === 'pocket-ai-private-mmkv-migration-in-progress')).toHaveLength(2);
      expect(deleteMMKV).not.toHaveBeenCalled();
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

  it('blocks unsupported unreadable and ambiguous typed migration values without fallback or deletion', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalCrypto = (globalThis as any).crypto;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const cases = [
      {
        name: 'unsupported',
        store: createTypedMmkvStore({ unsupported: { unsupported: true } }),
      },
      {
        name: 'unreadable-binary',
        store: createTypedMmkvStore({ binary: new Uint8Array([9, 8, 7]).buffer }, { omitBufferReader: true }),
      },
      {
        name: 'ambiguous',
        store: createTypedMmkvStore({ ambiguous: 3 }, { ambiguousKeys: ['ambiguous'] }),
      },
    ];

    try {
      for (const [index, testCase] of cases.entries()) {
        (process.env as any).NODE_ENV = 'production';
        mockCryptoBytes(50 + index);
        jest.resetModules();
        mockReactNativeIos();

        const secureStoreState: Record<string, string> = {};
        const { setItemAsync } = mockSecureStoreState(secureStoreState);
        const deleteMMKV = jest.fn();
        const stores = createEmptyPrivateStores();
        stores.set('global-app-storage', testCase.store);
        const createMMKV = jest.fn((config?: any) => stores.get(config?.id) ?? createTypedMmkvStore());
        jest.doMock('react-native-mmkv', () => ({ createMMKV, deleteMMKV }));

        const {
          createStorage,
          getPrivateStorageHealthSnapshot,
          getStorageFallbackReport,
          initializePrivateStorageEncryption,
          isPrivateStorageEncryptionReady,
          PrivateStorageUnavailableError,
        } = require('../../src/services/storage');

        await expect(initializePrivateStorageEncryption()).resolves.toEqual(expect.objectContaining({
          status: 'blocked',
          reason: 'migration_failed',
          requiresExplicitReset: false,
        }));

        expect(isPrivateStorageEncryptionReady()).toBe(false);
        expect(() => createStorage(`blocked-${testCase.name}`, { tier: 'private' })).toThrow(PrivateStorageUnavailableError);
        expect(getPrivateStorageHealthSnapshot()).toEqual(expect.objectContaining({
          status: 'blocked',
          reason: 'migration_failed',
          retryable: true,
          requiresExplicitReset: false,
        }));
        expect(secureStoreState['pocket-ai-private-mmkv-migration-in-progress']).toBeUndefined();
        expect(secureStoreState['pocket-ai-private-mmkv-migration-version']).toBeUndefined();
        expect(setItemAsync).not.toHaveBeenCalledWith('pocket-ai-private-mmkv-migration-version', '1');
        expect(deleteMMKV).not.toHaveBeenCalled();
        expect(getStorageFallbackReport()).toBeNull();

        jest.unmock('react-native');
        jest.unmock('expo-secure-store');
        jest.unmock('react-native-mmkv');
      }
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

  it('blocks mixed-key verification mismatches without fallback or deletion', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalCrypto = (globalThis as any).crypto;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      (process.env as any).NODE_ENV = 'production';
      mockCryptoBytes(70);
      jest.resetModules();
      mockReactNativeIos();

      const secureStoreState: Record<string, string> = {};
      const { setItemAsync } = mockSecureStoreState(secureStoreState);
      const deleteMMKV = jest.fn();
      const stores = createEmptyPrivateStores();
      stores.set('global-app-storage', createTypedMmkvStore({ first: 'ok', later: 2 }, {
        mutateOnEncrypt: (values) => {
          values.set('later', 3);
        },
      }));
      const createMMKV = jest.fn((config?: any) => stores.get(config?.id) ?? createTypedMmkvStore());
      jest.doMock('react-native-mmkv', () => ({ createMMKV, deleteMMKV }));

      const {
        createStorage,
        getStorageFallbackReport,
        initializePrivateStorageEncryption,
        isPrivateStorageEncryptionReady,
        retryPrivateStorageInitialization,
        PrivateStorageUnavailableError,
      } = require('../../src/services/storage');

      await expect(initializePrivateStorageEncryption()).resolves.toEqual(expect.objectContaining({
        status: 'blocked',
        reason: 'migration_failed',
      }));

      expect(isPrivateStorageEncryptionReady()).toBe(false);
      expect(() => createStorage('blocked-mismatch', { tier: 'private' })).toThrow(PrivateStorageUnavailableError);
      expect(secureStoreState['pocket-ai-private-mmkv-migration-version']).toBeUndefined();
      expect(secureStoreState['pocket-ai-private-mmkv-migration-in-progress']).toBeUndefined();
      expect(setItemAsync).not.toHaveBeenCalledWith('pocket-ai-private-mmkv-migration-version', '1');
      expect(deleteMMKV).not.toHaveBeenCalled();
      expect(getStorageFallbackReport()).toBeNull();
      expect(stores.get('global-app-storage')?.getNumber('later')).toBe(2);

      await expect(retryPrivateStorageInitialization()).resolves.toEqual(expect.objectContaining({
        status: 'ready',
      }));
      expect(secureStoreState['pocket-ai-private-mmkv-migration-version']).toBe('1');
      expect(secureStoreState['pocket-ai-private-mmkv-migration-in-progress']).toBeUndefined();
      expect(stores.get('global-app-storage')?.getNumber('later')).toBe(2);
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

  it('blocks encryption failures after typed snapshot capture without fallback or deletion', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalCrypto = (globalThis as any).crypto;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      (process.env as any).NODE_ENV = 'production';
      mockCryptoBytes(80);
      jest.resetModules();
      mockReactNativeIos();

      const secureStoreState: Record<string, string> = {};
      const { setItemAsync } = mockSecureStoreState(secureStoreState);
      const deleteMMKV = jest.fn();
      const stores = createEmptyPrivateStores();
      stores.set('global-app-storage', createTypedMmkvStore({ value: 'safe' }, { throwOnEncrypt: true }));
      const createMMKV = jest.fn((config?: any) => stores.get(config?.id) ?? createTypedMmkvStore());
      jest.doMock('react-native-mmkv', () => ({ createMMKV, deleteMMKV }));

      const {
        getStorageFallbackReport,
        initializePrivateStorageEncryption,
        isPrivateStorageEncryptionReady,
      } = require('../../src/services/storage');

      await expect(initializePrivateStorageEncryption()).resolves.toEqual(expect.objectContaining({
        status: 'blocked',
        reason: 'migration_failed',
      }));

      expect(isPrivateStorageEncryptionReady()).toBe(false);
      expect(secureStoreState['pocket-ai-private-mmkv-migration-version']).toBeUndefined();
      expect(secureStoreState['pocket-ai-private-mmkv-migration-in-progress']).toBeUndefined();
      expect(setItemAsync).not.toHaveBeenCalledWith('pocket-ai-private-mmkv-migration-version', '1');
      expect(deleteMMKV).not.toHaveBeenCalled();
      expect(getStorageFallbackReport()).toBeNull();
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

  it('does not advance migration marker on retry after a failed encrypted restore', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalCrypto = (globalThis as any).crypto;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      (process.env as any).NODE_ENV = 'production';
      mockCryptoBytes(90);
      jest.resetModules();
      mockReactNativeIos();

      const secureStoreState: Record<string, string> = {};
      const { setItemAsync } = mockSecureStoreState(secureStoreState);
      const deleteMMKV = jest.fn();
      const stores = createEmptyPrivateStores();
      stores.set('global-app-storage', createTypedMmkvStore({ value: 'safe' }, {
        mutateOnEncrypt: (values) => {
          values.set('value', 'corrupt');
        },
        throwOnEncrypt: true,
        throwOnSetKeys: ['value'],
      }));
      const createMMKV = jest.fn((config?: any) => stores.get(config?.id) ?? createTypedMmkvStore());
      jest.doMock('react-native-mmkv', () => ({ createMMKV, deleteMMKV }));

      const {
        getPrivateStorageHealthSnapshot,
        initializePrivateStorageEncryption,
        retryPrivateStorageInitialization,
      } = require('../../src/services/storage');

      await expect(initializePrivateStorageEncryption()).resolves.toEqual(expect.objectContaining({
        status: 'blocked',
        reason: 'migration_failed',
        requiresExplicitReset: true,
      }));
      expect(secureStoreState['pocket-ai-private-mmkv-migration-in-progress']).toBe('global-app-storage');
      expect(secureStoreState['pocket-ai-private-mmkv-migration-version']).toBeUndefined();

      createMMKV.mockClear();
      await expect(retryPrivateStorageInitialization()).resolves.toEqual(expect.objectContaining({
        status: 'blocked',
        reason: 'migration_failed',
      }));

      expect(createMMKV).not.toHaveBeenCalled();
      expect(getPrivateStorageHealthSnapshot()).toEqual(expect.objectContaining({
        status: 'blocked',
        reason: 'migration_failed',
        requiresExplicitReset: true,
      }));
      expect(secureStoreState['pocket-ai-private-mmkv-migration-version']).toBeUndefined();
      expect(setItemAsync).not.toHaveBeenCalledWith('pocket-ai-private-mmkv-migration-version', '1');
      expect(deleteMMKV).not.toHaveBeenCalled();
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

        // Case 1: typed migration succeeds before the next store fails to open.
        if (id === 'global-app-storage' && !hasKey) {
          return {
            isEncrypted: false,
            getAllKeys: jest.fn(() => ['k']),
            getString: jest.fn((_key: string) => 'v'),
            getNumber: jest.fn(() => undefined),
            getBoolean: jest.fn(() => undefined),
            getBuffer: jest.fn(() => undefined),
            encrypt: jest.fn(),
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

      secureStoreState['pocket-ai-private-mmkv-migration-in-progress'] = 'pocket-ai-settings';

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
      expect(deleteItemAsync).toHaveBeenCalledWith('pocket-ai-private-mmkv-migration-in-progress');
      expect(secureStoreState['pocket-ai-private-mmkv-migration-in-progress']).toBeUndefined();
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
