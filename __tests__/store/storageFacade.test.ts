function createMockStorage() {
  const values = new Map<string, unknown>();

  return {
    set: jest.fn((key: string, value: unknown) => {
      values.set(key, value);
    }),
    getString: jest.fn((key: string) => {
      const value = values.get(key);
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
    remove: jest.fn((key: string) => {
      values.delete(key);
    }),
    clearAll: jest.fn(() => {
      values.clear();
    }),
    contains: jest.fn((key: string) => values.has(key)),
    getAllKeys: jest.fn(() => Array.from(values.keys())),
  };
}

describe('store/storage facade', () => {
  afterEach(() => {
    jest.resetModules();
    jest.unmock('../../src/services/storage');
  });

  it('memoizes the shared app storage instance', () => {
    const mockStorage = createMockStorage();
    const createStorage = jest.fn(() => mockStorage);

    jest.isolateModules(() => {
      jest.doMock('../../src/services/storage', () => ({ createStorage }));

      const { getAppStorage } = require('../../src/store/storage');

      expect(getAppStorage()).toBe(mockStorage);
      expect(getAppStorage()).toBe(mockStorage);
      expect(createStorage).toHaveBeenCalledTimes(1);
      expect(createStorage).toHaveBeenCalledWith('global-app-storage', { tier: 'private' });
    });
  });

  it('delegates facade and zustand persistence calls to the cached storage instance', () => {
    const mockStorage = createMockStorage();
    const createStorage = jest.fn(() => mockStorage);

    jest.isolateModules(() => {
      jest.doMock('../../src/services/storage', () => ({ createStorage }));

      const { mmkvStorage, storage } = require('../../src/store/storage');

      storage.set('name', 'Pocket AI');
      storage.set('count', 7);
      storage.set('enabled', true);

      expect(storage.getString('name')).toBe('Pocket AI');
      expect(storage.getNumber('count')).toBe(7);
      expect(storage.getBoolean('enabled')).toBe(true);
      expect(storage.contains('enabled')).toBe(true);
      expect(storage.getAllKeys()).toEqual(expect.arrayContaining(['name', 'count', 'enabled']));

      storage.remove('enabled');
      expect(storage.contains('enabled')).toBe(false);

      mmkvStorage.setItem('persisted', '{"theme":"dark"}');
      expect(mmkvStorage.getItem('persisted')).toBe('{"theme":"dark"}');

      mmkvStorage.removeItem('persisted');
      expect(mmkvStorage.getItem('persisted')).toBeNull();

      storage.clearAll();
      expect(storage.getAllKeys()).toEqual([]);
      expect(createStorage).toHaveBeenCalledTimes(1);
    });
  });
});
