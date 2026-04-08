export function uniqueByKey<T, Key extends string | number | symbol>(
  items: readonly T[],
  getKey: (item: T) => Key,
): T[] {
  const seen = new Set<Key>();
  const result: T[] = [];

  for (const item of items) {
    const key = getKey(item);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(item);
  }

  return result;
}

