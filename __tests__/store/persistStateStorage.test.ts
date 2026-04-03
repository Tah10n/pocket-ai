import type { StateStorage } from 'zustand/middleware';
import { performanceMonitor } from '../../src/services/PerformanceMonitor';
import { createInstrumentedStateStorage } from '../../src/store/persistStateStorage';

describe('createInstrumentedStateStorage', () => {
  beforeEach(() => {
    performanceMonitor.clear();
    performanceMonitor.setEnabled(true);
  });

  it('dedupes identical setItem calls when enabled', () => {
    const baseStorage: StateStorage = {
      setItem: jest.fn(),
      getItem: jest.fn(() => null),
      removeItem: jest.fn(),
    };

    const storage = createInstrumentedStateStorage(baseStorage, { scope: 'test', dedupe: true });

    storage.setItem('key', 'value');
    storage.setItem('key', 'value');

    expect(baseStorage.setItem).toHaveBeenCalledTimes(1);

    const snapshot = performanceMonitor.snapshot();
    expect(snapshot.counters['test.persist.setItem_calls']).toBe(1);
    expect(snapshot.counters['test.persist.setItem_deduped']).toBe(1);
  });

  it('clears the dedupe cache when keys are removed', () => {
    const baseStorage: StateStorage = {
      setItem: jest.fn(),
      getItem: jest.fn(() => null),
      removeItem: jest.fn(),
    };

    const storage = createInstrumentedStateStorage(baseStorage, { scope: 'test', dedupe: true });

    storage.setItem('key', 'value');
    storage.removeItem('key');
    storage.setItem('key', 'value');

    expect(baseStorage.setItem).toHaveBeenCalledTimes(2);
    expect(baseStorage.removeItem).toHaveBeenCalledWith('key');
  });

  it('records span events for async storage writes', async () => {
    const baseStorage: StateStorage = {
      setItem: jest.fn(() => Promise.resolve()),
      getItem: jest.fn(() => null),
      removeItem: jest.fn(),
    };

    const storage = createInstrumentedStateStorage(baseStorage, { scope: 'test' });

    await storage.setItem('key', 'value');

    const span = performanceMonitor
      .snapshot()
      .events
      .find((event) => event.type === 'span' && event.name === 'test.persist.setItem');

    expect(span).toEqual(
      expect.objectContaining({
        meta: expect.objectContaining({ ok: true, key: 'key' }),
      }),
    );
  });

  it('marks spans as failed when storage throws', () => {
    const baseStorage: StateStorage = {
      setItem: jest.fn(() => {
        throw new Error('boom');
      }),
      getItem: jest.fn(() => null),
      removeItem: jest.fn(),
    };

    const storage = createInstrumentedStateStorage(baseStorage, { scope: 'test' });

    expect(() => storage.setItem('key', 'value')).toThrow('boom');

    const span = performanceMonitor
      .snapshot()
      .events
      .find((event) => event.type === 'span' && event.name === 'test.persist.setItem');

    expect(span).toEqual(
      expect.objectContaining({
        meta: expect.objectContaining({ ok: false, key: 'key' }),
      }),
    );
  });
});

