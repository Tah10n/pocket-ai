/**
 * Flushes the microtask queue (Promises). Useful after state updates.
 */
export async function flushPromises(): Promise<void> {
  await Promise.resolve();
}

/**
 * Flushes microtasks multiple times to settle chained Promises.
 */
export async function flushMicrotasks(iterations = 3): Promise<void> {
  for (let i = 0; i < iterations; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
}
