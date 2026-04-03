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
        storeIds: ['store-a', 'store-b'],
        reasons: {
          'store-a': 'mmkv_init_failed',
          'store-b': 'mmkv_init_failed',
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
});
