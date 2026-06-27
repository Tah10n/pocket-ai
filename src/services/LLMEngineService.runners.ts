export type ContextOperationDrainResult = 'drained' | 'timed_out';

type ErrorFactory = () => unknown;

type ContextOperationOptions = {
  readonly chatBlocking?: boolean;
};

type ContextOperationCancelOptions = {
  readonly chatBlocking?: boolean;
};

type ContextOperationWaitOptions = {
  readonly timeoutMs?: number;
  readonly chatBlocking?: boolean;
};

export type ContextOperationCancellationToken = {
  readonly isCancelled: () => boolean;
  readonly throwIfCancelled: () => void;
};

type ActiveContextOperation = {
  readonly promise: Promise<unknown>;
  readonly chatBlocking: boolean;
  readonly cancel: (error: unknown) => void;
};

export class ContextOperationRunner {
  public queue: Promise<void> = Promise.resolve();
  public activePromises: Set<Promise<unknown>> = new Set();
  public rawActivePromises: Set<Promise<unknown>> = new Set();
  public chatBlockingRawActivePromises: Set<Promise<unknown>> = new Set();
  public activeRejects: Map<Promise<unknown>, (error: unknown) => void> = new Map();
  private activeOperations: Map<Promise<unknown>, ActiveContextOperation> = new Map();
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
    let operationCancelled = false;
    let operationCancellationError: unknown | undefined;
    const cancellationPromise = new Promise<never>((_, reject) => {
      rejectCancellation = reject;
    });
    const isOperationCancelled = () => this.cancelGeneration !== operationGeneration || operationCancelled;
    const getCancellationError = () => operationCancellationError ?? createCancellationError();
    const cancellationToken: ContextOperationCancellationToken = {
      isCancelled: isOperationCancelled,
      throwIfCancelled: () => this.assertNotCancelled(isOperationCancelled, getCancellationError),
    };

    const rawOperationPromise = (async () => {
      await previousOperation.catch(() => undefined);

      try {
        this.assertNotCancelled(isOperationCancelled, getCancellationError);
        const result = await operation(cancellationToken);
        this.assertNotCancelled(isOperationCancelled, getCancellationError);
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
    this.activeOperations.set(operationPromise, {
      promise: operationPromise,
      chatBlocking: isChatBlocking,
      cancel: (error) => {
        operationCancelled = true;
        operationCancellationError = error;
        rejectCancellation(error);
      },
    });

    void operationPromise.then(
      () => this.clearActiveOperation(operationPromise),
      () => this.clearActiveOperation(operationPromise),
    );

    return operationPromise;
  }

  public waitForActive(options: ContextOperationWaitOptions = {}): Promise<ContextOperationDrainResult> {
    const activeContextOperations = this.getRawActiveOperations(options.chatBlocking);
    if (activeContextOperations.length === 0) {
      return Promise.resolve('drained');
    }

    const drainPromise = Promise.allSettled(activeContextOperations).then((): ContextOperationDrainResult => 'drained');
    if (typeof options.timeoutMs !== 'number' || options.timeoutMs <= 0) {
      return drainPromise;
    }

    return waitForPromiseWithTimeout(drainPromise, options.timeoutMs);
  }

  public cancelActive(error: unknown, options: ContextOperationCancelOptions = {}): void {
    const hasChatBlockingFilter = typeof options.chatBlocking === 'boolean';
    if (!hasChatBlockingFilter) {
      this.cancelGeneration += 1;
    }

    const operationsToCancel = Array.from(this.activeOperations.values()).filter((operation) => (
      !hasChatBlockingFilter || operation.chatBlocking === options.chatBlocking
    ));

    for (const operation of operationsToCancel) {
      this.activeRejects.delete(operation.promise);
      operation.cancel(error);
    }

    if (!hasChatBlockingFilter) {
      this.activeOperations.clear();
      this.activeRejects.clear();
    }
  }

  public reset(error?: unknown): void {
    this.cancelGeneration += 1;
    const rejectActiveOperations = Array.from(this.activeRejects.values());
    this.activeRejects.clear();
    if (error !== undefined) {
      rejectActiveOperations.forEach((reject) => reject(error));
    }
    this.activePromises.clear();
    this.activeOperations.clear();
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

  private getRawActiveOperations(chatBlocking?: boolean): Promise<unknown>[] {
    if (chatBlocking === true) {
      return Array.from(this.chatBlockingRawActivePromises);
    }

    if (chatBlocking === false) {
      return Array.from(this.rawActivePromises)
        .filter((promise) => !this.chatBlockingRawActivePromises.has(promise));
    }

    return Array.from(this.rawActivePromises);
  }

  private assertNotCancelled(isCancelled: () => boolean, getCancellationError: ErrorFactory): void {
    if (isCancelled()) {
      throw getCancellationError();
    }
  }

  private clearActiveOperation(operationPromise: Promise<unknown>): void {
    this.activePromises.delete(operationPromise);
    this.activeRejects.delete(operationPromise);
    this.activeOperations.delete(operationPromise);
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
