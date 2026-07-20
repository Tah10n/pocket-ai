import type { AppStorageFacade } from '../src/store/storage';

export type StorageWriteKind = 'index' | 'pending' | 'thread' | 'progress' | 'other';

export type StorageCounterSnapshot = {
  setCalls: number;
  removeCalls: number;
  clearCalls: number;
  serializedBytes: number;
  writesByKind: Record<StorageWriteKind, number>;
};

export type CountingAppStorage = {
  storage: AppStorageFacade;
  snapshot: () => StorageCounterSnapshot;
  resetCounters: () => void;
};

function getUtf8ByteLength(value: string): number {
  try {
    return new TextEncoder().encode(value).length;
  } catch {
    let bytes = 0;
    for (let index = 0; index < value.length; index += 1) {
      const codeUnit = value.charCodeAt(index);
      if (codeUnit < 0x80) {
        bytes += 1;
      } else if (codeUnit < 0x800) {
        bytes += 2;
      } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
        const nextCodeUnit = value.charCodeAt(index + 1);
        if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
          bytes += 4;
          index += 1;
        } else {
          bytes += 3;
        }
      } else {
        bytes += 3;
      }
    }
    return bytes;
  }
}

function getStoredValueByteLength(value: boolean | string | number | ArrayBuffer): number {
  if (typeof value === 'string') {
    return getUtf8ByteLength(value);
  }
  if (value instanceof ArrayBuffer) {
    return value.byteLength;
  }
  return typeof value === 'number' ? 8 : 1;
}

function defaultClassifyStorageKey(key: string): StorageWriteKind {
  if (key === 'chat-store:v2:index') {
    return 'index';
  }
  if (key === 'chat-store:v2:index:pending') {
    return 'pending';
  }
  if (key.startsWith('chat-store:v2:thread:')) {
    return 'thread';
  }
  if (key.startsWith('chat-store:progress:')) {
    return 'progress';
  }
  return 'other';
}

function emptyWritesByKind(): Record<StorageWriteKind, number> {
  return { index: 0, pending: 0, thread: 0, progress: 0, other: 0 };
}

export function createCountingAppStorage(options?: {
  initialValues?: Readonly<Record<string, boolean | string | number | ArrayBuffer>>;
  classifyKey?: (key: string) => StorageWriteKind;
}): CountingAppStorage {
  const values = new Map<string, boolean | string | number | ArrayBuffer>(
    Object.entries(options?.initialValues ?? {}),
  );
  const classifyKey = options?.classifyKey ?? defaultClassifyStorageKey;
  let setCalls = 0;
  let removeCalls = 0;
  let clearCalls = 0;
  let serializedBytes = 0;
  let writesByKind = emptyWritesByKind();

  const storage: AppStorageFacade = {
    set: (key, value) => {
      setCalls += 1;
      serializedBytes += getStoredValueByteLength(value);
      const kind = classifyKey(key);
      writesByKind[kind] += 1;
      values.set(key, value);
    },
    getString: (key) => {
      const value = values.get(key);
      return typeof value === 'string' ? value : undefined;
    },
    getNumber: (key) => {
      const value = values.get(key);
      return typeof value === 'number' ? value : undefined;
    },
    getBoolean: (key) => {
      const value = values.get(key);
      return typeof value === 'boolean' ? value : undefined;
    },
    remove: (key) => {
      removeCalls += 1;
      return values.delete(key);
    },
    clearAll: () => {
      clearCalls += 1;
      values.clear();
    },
    contains: (key) => values.has(key),
    getAllKeys: () => [...values.keys()],
  };

  return {
    storage,
    snapshot: () => ({
      setCalls,
      removeCalls,
      clearCalls,
      serializedBytes,
      writesByKind: { ...writesByKind },
    }),
    resetCounters: () => {
      setCalls = 0;
      removeCalls = 0;
      clearCalls = 0;
      serializedBytes = 0;
      writesByKind = emptyWritesByKind();
    },
  };
}

export function getCounterDelta(
  before: Readonly<Record<string, number>>,
  after: Readonly<Record<string, number>>,
  name: string,
): number {
  return (after[name] ?? 0) - (before[name] ?? 0);
}

export function captureReferenceSequence<T>(values: readonly T[]): {
  array: readonly T[];
  items: readonly T[];
} {
  return { array: values, items: [...values] };
}

export function countUnretainedItemReferences<T>(
  before: readonly T[],
  after: readonly T[],
): number {
  const retainedCounts = new Map<T, number>();
  for (const item of after) {
    retainedCounts.set(item, (retainedCounts.get(item) ?? 0) + 1);
  }

  let unretained = 0;
  for (const item of before) {
    const retainedCount = retainedCounts.get(item) ?? 0;
    if (retainedCount === 0) {
      unretained += 1;
    } else if (retainedCount === 1) {
      retainedCounts.delete(item);
    } else {
      retainedCounts.set(item, retainedCount - 1);
    }
  }
  return unretained;
}

export function createMutationCounter<T>(
  subscribe: (listener: (state: T, previousState: T) => void) => () => void,
): {
  getCount: () => number;
  reset: () => void;
  unsubscribe: () => void;
} {
  let count = 0;
  const unsubscribe = subscribe(() => {
    count += 1;
  });

  return {
    getCount: () => count,
    reset: () => {
      count = 0;
    },
    unsubscribe,
  };
}
