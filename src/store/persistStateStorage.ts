import type { StateStorage } from 'zustand/middleware';
import { performanceMonitor } from '../services/PerformanceMonitor';

function safeByteLength(value: string): number {
  try {
    return new TextEncoder().encode(value).length;
  } catch {
    return value.length;
  }
}

export function createInstrumentedStateStorage(
  storage: StateStorage,
  options: {
    scope: string;
    dedupe?: boolean;
  },
): StateStorage {
  const scope = options.scope;
  const shouldDedupe = options.dedupe === true;
  let lastValueByKey: Record<string, string | undefined> | null = shouldDedupe ? {} : null;

  return {
    setItem: (name, value) => {
      if (lastValueByKey && lastValueByKey[name] === value) {
        performanceMonitor.incrementCounter(`${scope}.persist.setItem_deduped`);
        return;
      }

      const span = performanceMonitor.startSpan(`${scope}.persist.setItem`, {
        key: name,
        bytes: safeByteLength(value),
      });
      performanceMonitor.incrementCounter(`${scope}.persist.setItem_calls`);

      try {
        const result = storage.setItem(name, value);
        if (result && typeof (result as Promise<void>).then === 'function') {
          return (result as Promise<void>)
            .then(() => {
              span.end({ ok: true });
              if (lastValueByKey) {
                lastValueByKey[name] = value;
              }
            })
            .catch((error) => {
              span.end({ ok: false });
              throw error;
            });
        }

        span.end({ ok: true });
        if (lastValueByKey) {
          lastValueByKey[name] = value;
        }
        return result;
      } catch (error) {
        span.end({ ok: false });
        throw error;
      }
    },
    getItem: (name) => storage.getItem(name),
    removeItem: (name) => {
      if (lastValueByKey) {
        delete lastValueByKey[name];
      }
      return storage.removeItem(name);
    },
  };
}
