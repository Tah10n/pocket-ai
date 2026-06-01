export type ContextOperationDrainResult = 'drained' | 'timed_out';

type ErrorFactory = () => unknown;

type ContextOperationOptions = {
  readonly chatBlocking?: boolean;
};

export type ContextOperationCancellationToken = {
  readonly isCancelled: () => boolean;
  readonly throwIfCancelled: () => void;
};

export class ContextOperationRunner {
  public queue: Promise<void> = Promise.resolve();
  public activePromises: Set<Promise<unknown>> = new Set();
  public rawActivePromises: Set<Promise<unknown>> = new Set();
  public chatBlockingRawActivePromises: Set<Promise<unknown>> = new Set();
  public activeRejects: Map<Promise<unknown>, (error: unknown) => void> = new Map();
  public cancelGeneration = 0;

  public track<T>(
    operation: (cancellation: ContextOperationCancellationToken) => Promise<T>,
    createCancellationError: ErrorFactory,
    options: ContextOperationOptions = {},
  ): Promise<T> {
    const previousOperation = this.queue;
    const operationGeneration = this.cancelGeneration;
    const isChatBlocking = options.chatBlocking !== false;
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
    const cancellationToken: ContextOperationCancellationToken = {
      isCancelled: () => this.cancelGeneration !== operationGeneration,
      throwIfCancelled: () => this.assertNotCancelled(operationGeneration, createCancellationError),
    };

    const rawOperationPromise = (async () => {
      await previousOperation.catch(() => undefined);

      try {
        this.assertNotCancelled(operationGeneration, createCancellationError);
        const result = await operation(cancellationToken);
        this.assertNotCancelled(operationGeneration, createCancellationError);
        return result;
      } finally {
        releaseOperationQueue();
      }
    })();
    void rawOperationPromise.catch(() => undefined);
    this.rawActivePromises.add(rawOperationPromise);
    if (isChatBlocking) {
      this.chatBlockingRawActivePromises.add(rawOperationPromise);
    }
    void rawOperationPromise.then(
      () => this.clearRawActiveOperation(rawOperationPromise),
      () => this.clearRawActiveOperation(rawOperationPromise),
    );

    const operationPromise = Promise.race([rawOperationPromise, cancellationPromise]);
    this.activePromises.add(operationPromise);
    this.activeRejects.set(operationPromise, rejectCancellation);

    void operationPromise.then(
      () => this.clearActiveOperation(operationPromise),
      () => this.clearActiveOperation(operationPromise),
    );

    return operationPromise;
  }

  public waitForActive(options: { timeoutMs?: number } = {}): Promise<ContextOperationDrainResult> {
    const activeContextOperations = Array.from(this.rawActivePromises);
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
  }

  public reset(error?: unknown): void {
    this.cancelGeneration += 1;
    const rejectActiveOperations = Array.from(this.activeRejects.values());
    this.activeRejects.clear();
    if (error !== undefined) {
      rejectActiveOperations.forEach((reject) => reject(error));
    }
    this.activePromises.clear();
    this.rawActivePromises.clear();
    this.chatBlockingRawActivePromises.clear();
    this.queue = Promise.resolve();
  }

  public hasActive(): boolean {
    return this.rawActivePromises.size > 0;
  }

  public hasActiveChatBlocking(): boolean {
    return this.chatBlockingRawActivePromises.size > 0;
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

  private clearRawActiveOperation(rawOperationPromise: Promise<unknown>): void {
    this.rawActivePromises.delete(rawOperationPromise);
    this.chatBlockingRawActivePromises.delete(rawOperationPromise);
  }
}

export class ActiveCompletionRunner<T> {
  public activePromise: Promise<T> | null = null;
  public activeDriverPromise: Promise<unknown> | null = null;
  public activeReject: ((error: unknown) => void) | null = null;
  public interruptGeneration = 0;

  public hasActive(): boolean {
    return this.activePromise !== null || this.activeDriverPromise !== null;
  }

  public start(promise: Promise<T>, reject: (error: unknown) => void): number {
    this.activePromise = promise;
    this.activeReject = reject;
    return this.interruptGeneration;
  }

  public attachDriver(activePromise: Promise<T>, driverPromise: Promise<unknown>): void {
    if (this.activePromise === activePromise) {
      this.activeDriverPromise = driverPromise;
    }
  }

  public clearIfActive(promise: Promise<T>): void {
    if (this.activePromise === promise) {
      this.activePromise = null;
      this.activeDriverPromise = null;
      this.activeReject = null;
    }
  }

  public getActiveDriverPromise(): Promise<unknown> | null {
    return this.activeDriverPromise ?? this.activePromise;
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
    this.activeDriverPromise = null;
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
