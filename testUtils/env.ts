export async function withNodeEnv<T>(
  nodeEnv: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  const original = process.env.NODE_ENV;
  try {
    (process.env as any).NODE_ENV = nodeEnv;
    return await fn();
  } finally {
    (process.env as any).NODE_ENV = original;
  }
}
