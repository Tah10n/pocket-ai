export type ContextOperationDrainResult = 'drained' | 'timed_out';

type ErrorFactory = () => unknown;

export class ContextOperationRunner {
  public queue: Promise<void> = Promise.resolve();
  public activePromises: Set<Promise<unknown>> = new Set();
  public activeRejects: Map<Promise<unknown>, (error: unknown) => void> = new Map();
  public cancelGeneration = 0;

  public track<T>(operation: () => Promise<T>, createCancellationError: ErrorFactory): Promise<T> {
    const previousOperation = this.queue;
    const operationGeneration = this.cancelGeneration;
    let releaseQueue: () => void = () => undefined;
    let didReleaseQueue = false;
    const queueSlot = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    const releaseOperationQueue = () => {
      if (!didReleaseQueue) {
        didReleaseQueue = true;
        releaseQueue();
      }
    };

    this.queue = previousOperation.catch(() => undefined).then(() => queueSlot);

    let rejectCancellation: (error: unknown) => void = () => undefined;
    const cancellationPromise = new Promise<never>((_, reject) => {
      rejectCancellation = reject;
    });

    const rawOperationPromise = (async () => {
      await previousOperation.catch(() => undefined);
      this.assertNotCancelled(operationGeneration, createCancellationError);

      try {
        const result = await operation();
        this.assertNotCancelled(operationGeneration, createCancellationError);
        return result;
      } finally {
        releaseOperationQueue();
      }
    })();
    void rawOperationPromise.catch(() => undefined);

    const operationPromise = Promise.race([rawOperationPromise, cancellationPromise])
      .finally(releaseOperationQueue);
    this.activePromises.add(operationPromise);
    this.activeRejects.set(operationPromise, rejectCancellation);

    void operationPromise.then(
      () => this.clearActiveOperation(operationPromise),
      () => this.clearActiveOperation(operationPromise),
    );

    return operationPromise;
  }

  public waitForActive(options: { timeoutMs?: number } = {}): Promise<ContextOperationDrainResult> {
    const activeContextOperations = Array.from(this.activePromises);
    if (activeContextOperations.length === 0) {
      return Promise.resolve('drained');
    }

    const drainPromise = Promise.allSettled(activeContextOperations).then((): ContextOperationDrainResult => 'drained');
    if (typeof options.timeoutMs !== 'number' || options.timeoutMs <= 0) {
      return drainPromise;
    }

    return waitForPromiseWithTimeout(drainPromise, options.timeoutMs);
  }

  public cancelActive(error: unknown): void {
    this.cancelGeneration += 1;
    const rejectActiveOperations = Array.from(this.activeRejects.values());
    this.activeRejects.clear();
    rejectActiveOperations.forEach((reject) => reject(error));
    this.queue = Promise.resolve();
    this.activePromises.clear();
  }

  private assertNotCancelled(generation: number, createCancellationError: ErrorFactory): void {
    if (this.cancelGeneration !== generation) {
      throw createCancellationError();
    }
  }

  private clearActiveOperation(operationPromise: Promise<unknown>): void {
    this.activePromises.delete(operationPromise);
    this.activeRejects.delete(operationPromise);
  }
}

export class ActiveCompletionRunner<T> {
  public activePromise: Promise<T> | null = null;
  public activeReject: ((error: unknown) => void) | null = null;
  public interruptGeneration = 0;

  public hasActive(): boolean {
    return this.activePromise !== null;
  }

  public start(promise: Promise<T>, reject: (error: unknown) => void): number {
    this.activePromise = promise;
    this.activeReject = reject;
    return this.interruptGeneration;
  }

  public clearIfActive(promise: Promise<T>): void {
    if (this.activePromise === promise) {
      this.activePromise = null;
      this.activeReject = null;
    }
  }

  public interruptIfActive(): void {
    if (this.activePromise) {
      this.interruptGeneration += 1;
    }
  }

  public assertNotInterrupted(generation: number, createInterruptedError: ErrorFactory): void {
    if (this.interruptGeneration !== generation) {
      throw createInterruptedError();
    }
  }

  public rejectActive(error: unknown): void {
    this.activeReject?.(error);
  }

  public reset(): void {
    this.activePromise = null;
    this.activeReject = null;
  }
}

export async function waitForPromiseWithTimeout(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<ContextOperationDrainResult> {
  if (timeoutMs <= 0) {
    await promise;
    return 'drained';
  }

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<ContextOperationDrainResult>((resolve) => {
    timeoutId = setTimeout(() => resolve('timed_out'), timeoutMs);
  });
  const settledPromise = promise.then(
    (): ContextOperationDrainResult => 'drained',
    (): ContextOperationDrainResult => 'drained',
  );

  const result = await Promise.race([settledPromise, timeoutPromise]);
  if (timeoutId !== null) {
    clearTimeout(timeoutId);
  }

  return result;
}
