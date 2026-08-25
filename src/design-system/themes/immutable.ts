export function deepFreeze<T>(value: T): T {
  return deepFreezeValue(value, new WeakSet<object>());
}

function deepFreezeValue<T>(value: T, seen: WeakSet<object>): T {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return value;
  }

  const objectValue = value as object;
  if (seen.has(objectValue)) {
    return value;
  }

  seen.add(objectValue);
  for (const key of Reflect.ownKeys(objectValue)) {
    const descriptor = Object.getOwnPropertyDescriptor(objectValue, key);
    if (descriptor && 'value' in descriptor) {
      deepFreezeValue(descriptor.value, seen);
    }
  }

  return Object.isFrozen(objectValue) ? value : Object.freeze(value);
}
