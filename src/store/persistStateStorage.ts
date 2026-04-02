import type { StateStorage } from 'zustand/middleware';
import { performanceMonitor } from '../services/PerformanceMonitor';

function safeByteLength(value: string): number {
  try {
    return new TextEncoder().encode(value).length;
  } catch {
    return value.length;
  }
}

function isPromiseLike(value: unknown): value is Promise<void> {
  return Boolean(value) && typeof (value as Promise<void>).then === 'function';
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
      const instrumentationEnabled = performanceMonitor.isEnabled();

      if (lastValueByKey && lastValueByKey[name] === value) {
        if (instrumentationEnabled) {
          performanceMonitor.incrementCounter(`${scope}.persist.setItem_deduped`);
        }
        return;
      }

      const span = instrumentationEnabled
        ? performanceMonitor.startSpan(`${scope}.persist.setItem`, {
            key: name,
            bytes: safeByteLength(value),
          })
        : null;
      if (instrumentationEnabled) {
        performanceMonitor.incrementCounter(`${scope}.persist.setItem_calls`);
      }

      try {
        const result = storage.setItem(name, value);
        if (isPromiseLike(result)) {
          return result
            .then(() => {
              span?.end({ ok: true });
              if (lastValueByKey) {
                lastValueByKey[name] = value;
              }
            })
            .catch((error) => {
              span?.end({ ok: false });
              throw error;
            });
        }

        span?.end({ ok: true });
        if (lastValueByKey) {
          lastValueByKey[name] = value;
        }
        return result;
      } catch (error) {
        span?.end({ ok: false });
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
