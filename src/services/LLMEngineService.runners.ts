export type ContextOperationDrainResult = 'drained' | 'timed_out';

type ErrorFactory = () => unknown;

export type ContextOperationPriority =
  | 'completion'
  | 'prompt_preparation'
  | 'user_action'
  | 'background_probe'
  | 'passive_readiness';

const CONTEXT_OPERATION_PRIORITY_RANK: Record<ContextOperationPriority, number> = {
  completion: 0,
  prompt_preparation: 1,
  user_action: 2,
  background_probe: 3,
  passive_readiness: 4,
};

type ContextOperationOptions = {
  readonly chatBlocking?: boolean;
  readonly priority?: ContextOperationPriority;
  readonly startTimeoutMs?: number;
  readonly createStartTimeoutError?: ErrorFactory;
  readonly createPriorityPreemptionError?: ErrorFactory;
};

type ContextOperationCancelOptions = {
  readonly chatBlocking?: boolean;
  readonly lowerPriorityThan?: ContextOperationPriority;
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
  readonly priority: ContextOperationPriority;
  readonly cancel: (error: unknown) => void;
};

type ContextOperationReservation = {
  readonly priority: ContextOperationPriority;
  readonly error: unknown;
};

type ContextOperationAdmissionWaiter = {
  readonly priority: ContextOperationPriority;
  readonly resolve: () => void;
};

type ScheduledContextOperation = {
  readonly sequence: number;
  readonly priority: ContextOperationPriority;
  readonly start: () => void;
  readonly cancelBeforeStart: (error: unknown) => void;
};

export class ContextOperationRunner {
  public queue: Promise<void> = Promise.resolve();
  public activePromises: Set<Promise<unknown>> = new Set();
  public rawActivePromises: Set<Promise<unknown>> = new Set();
  public chatBlockingRawActivePromises: Set<Promise<unknown>> = new Set();
  public activeRejects: Map<Promise<unknown>, (error: unknown) => void> = new Map();
  private activeOperations: Map<Promise<unknown>, ActiveContextOperation> = new Map();
  private pendingOperations: ScheduledContextOperation[] = [];
  private runningOperation: ScheduledContextOperation | null = null;
  private reservations = new Map<number, ContextOperationReservation>();
  private admissionWaiters = new Set<ContextOperationAdmissionWaiter>();
  private nextOperationSequence = 0;
  private nextReservationId = 0;
  private resolveQueueDrain: (() => void) | null = null;
  public cancelGeneration = 0;

  public reserve(priority: ContextOperationPriority, error: unknown): () => void {
    const reservationId = this.nextReservationId;
    this.nextReservationId += 1;
    this.reservations.set(reservationId, { priority, error });
    this.cancelLowerPriorityOperations(priority, error);

    let released = false;
    return () => {
      if (released) {
        return;
      }

      released = true;
      this.reservations.delete(reservationId);
      this.resolveAllowedAdmissionWaiters();
      this.pumpQueue();
    };
  }

  public waitUntilAllowed(priority: ContextOperationPriority): Promise<void> {
    if (this.isAdmissionAllowed(priority)) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      const waiter: ContextOperationAdmissionWaiter = { priority, resolve };
      this.admissionWaiters.add(waiter);

      // Keep the check adjacent to registration so a synchronously released
      // reservation cannot leave this waiter orphaned.
      if (this.isAdmissionAllowed(priority)) {
        this.admissionWaiters.delete(waiter);
        resolve();
      }
    });
  }

  public isAdmissionAllowed(priority: ContextOperationPriority): boolean {
    return !this.getBlockingReservation(priority);
  }

  public clearReservations(priority?: ContextOperationPriority): void {
    if (priority === undefined) {
      this.reservations.clear();
    } else {
      Array.from(this.reservations.entries()).forEach(([reservationId, reservation]) => {
        if (reservation.priority === priority) {
          this.reservations.delete(reservationId);
        }
      });
    }

    this.resolveAllowedAdmissionWaiters();
    this.pumpQueue();
  }

  public track<T>(
    operation: (cancellation: ContextOperationCancellationToken) => Promise<T>,
    createCancellationError: ErrorFactory,
    options: ContextOperationOptions = {},
  ): Promise<T> {
    const operationGeneration = this.cancelGeneration;
    const isChatBlocking = options.chatBlocking !== false;
    const priority = options.priority
      ?? (isChatBlocking ? 'prompt_preparation' : 'background_probe');
    const blockingReservation = this.getBlockingReservation(priority);
    if (blockingReservation) {
      return Promise.reject(blockingReservation.error);
    }

    // Priority is an admission rule, not only a queue ordering hint. Once
    // higher-priority work is accepted, lower-priority work must observe
    // cancellation at its next safe boundary while the raw native owner is
    // still allowed to settle without overlap.
    this.cancelLowerPriorityOperations(
      priority,
      options.createPriorityPreemptionError?.() ?? createCancellationError(),
    );

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
    let resolveRawOperation!: (value: T | PromiseLike<T>) => void;
    let rejectRawOperation!: (error: unknown) => void;
    let operationStarted = false;
    let operationSettled = false;
    let startTimeoutId: ReturnType<typeof setTimeout> | null = null;
    const rawOperationPromise = new Promise<T>((resolve, reject) => {
      resolveRawOperation = resolve;
      rejectRawOperation = reject;
    });
    void rawOperationPromise.catch(() => undefined);
    this.ensureQueueDrainPromise();
    this.rawActivePromises.add(rawOperationPromise);
    if (isChatBlocking) {
      this.chatBlockingRawActivePromises.add(rawOperationPromise);
    }

    const operationPromise = Promise.race([rawOperationPromise, cancellationPromise]);
    const scheduledOperation: ScheduledContextOperation = {
      sequence: this.nextOperationSequence,
      priority,
      start: () => {
        if (operationStarted || operationSettled) {
          return;
        }

        operationStarted = true;
        if (startTimeoutId !== null) {
          clearTimeout(startTimeoutId);
          startTimeoutId = null;
        }
        this.runningOperation = scheduledOperation;
        void Promise.resolve()
          .then(async () => {
            this.assertNotCancelled(isOperationCancelled, getCancellationError);
            const result = await operation(cancellationToken);
            this.assertNotCancelled(isOperationCancelled, getCancellationError);
            return result;
          })
          .then(resolveRawOperation, rejectRawOperation);
      },
      cancelBeforeStart: (error) => {
        if (operationStarted || operationSettled) {
          return;
        }

        operationSettled = true;
        if (startTimeoutId !== null) {
          clearTimeout(startTimeoutId);
          startTimeoutId = null;
        }
        this.removePendingOperation(scheduledOperation);
        rejectRawOperation(error);
      },
    };
    this.nextOperationSequence += 1;
    this.activePromises.add(operationPromise);
    this.activeRejects.set(operationPromise, rejectCancellation);
    this.activeOperations.set(operationPromise, {
      promise: operationPromise,
      chatBlocking: isChatBlocking,
      priority,
      cancel: (error) => {
        operationCancelled = true;
        operationCancellationError = error;
        rejectCancellation(error);
        scheduledOperation.cancelBeforeStart(error);
      },
    });

    void operationPromise.then(
      () => this.clearActiveOperation(operationPromise),
      () => this.clearActiveOperation(operationPromise),
    );

    void rawOperationPromise.then(
      () => {
        operationSettled = true;
        this.clearRawActiveOperation(rawOperationPromise, scheduledOperation);
      },
      () => {
        operationSettled = true;
        this.clearRawActiveOperation(rawOperationPromise, scheduledOperation);
      },
    );

    if (
      typeof options.startTimeoutMs === 'number'
      && options.startTimeoutMs > 0
      && options.createStartTimeoutError
    ) {
      startTimeoutId = setTimeout(() => {
        if (operationStarted || operationSettled) {
          return;
        }

        const timeoutError = options.createStartTimeoutError?.() ?? getCancellationError();
        const activeOperation = this.activeOperations.get(operationPromise);
        activeOperation?.cancel(timeoutError);
      }, options.startTimeoutMs);
    }

    this.pendingOperations.push(scheduledOperation);
    this.sortPendingOperations();
    this.pumpQueue();

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
    const hasPriorityFilter = options.lowerPriorityThan != null;
    const isSelectiveCancellation = hasChatBlockingFilter || hasPriorityFilter;
    if (!isSelectiveCancellation) {
      this.cancelGeneration += 1;
    }

    const operationsToCancel = Array.from(this.activeOperations.values()).filter((operation) => (
      (!hasChatBlockingFilter || operation.chatBlocking === options.chatBlocking)
      && (
        options.lowerPriorityThan == null
        || this.isLowerPriority(operation.priority, options.lowerPriorityThan)
      )
    ));

    for (const operation of operationsToCancel) {
      this.activeRejects.delete(operation.promise);
      operation.cancel(error);
    }

    if (!isSelectiveCancellation) {
      this.activeOperations.clear();
      this.activeRejects.clear();
    }
  }

  public reset(error?: unknown): void {
    this.cancelGeneration += 1;
    const activeOperations = Array.from(this.activeOperations.values());
    activeOperations.forEach((operation) => operation.cancel(error ?? new Error('Context operation reset')));
    this.pendingOperations = [];
    this.runningOperation = null;
    this.reservations.clear();
    this.resolveAllowedAdmissionWaiters();
    this.activePromises.clear();
    this.activeOperations.clear();
    this.activeRejects.clear();
    this.rawActivePromises.clear();
    this.chatBlockingRawActivePromises.clear();
    this.resolveQueueDrain?.();
    this.resolveQueueDrain = null;
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

  private clearRawActiveOperation(
    rawOperationPromise: Promise<unknown>,
    scheduledOperation: ScheduledContextOperation,
  ): void {
    this.rawActivePromises.delete(rawOperationPromise);
    this.chatBlockingRawActivePromises.delete(rawOperationPromise);
    if (this.runningOperation === scheduledOperation) {
      this.runningOperation = null;
    } else {
      this.removePendingOperation(scheduledOperation);
    }

    if (this.rawActivePromises.size === 0) {
      this.resolveQueueDrain?.();
      this.resolveQueueDrain = null;
      this.queue = Promise.resolve();
    }
    this.pumpQueue();
  }

  private ensureQueueDrainPromise(): void {
    if (this.rawActivePromises.size > 0) {
      return;
    }

    this.queue = new Promise<void>((resolve) => {
      this.resolveQueueDrain = resolve;
    });
  }

  private sortPendingOperations(): void {
    this.pendingOperations.sort((left, right) => (
      CONTEXT_OPERATION_PRIORITY_RANK[left.priority] - CONTEXT_OPERATION_PRIORITY_RANK[right.priority]
      || left.sequence - right.sequence
    ));
  }

  private removePendingOperation(operation: ScheduledContextOperation): void {
    const index = this.pendingOperations.indexOf(operation);
    if (index >= 0) {
      this.pendingOperations.splice(index, 1);
    }
  }

  private pumpQueue(): void {
    if (this.runningOperation) {
      return;
    }

    const nextOperationIndex = this.pendingOperations.findIndex((operation) => (
      this.getBlockingReservation(operation.priority) == null
    ));
    if (nextOperationIndex < 0) {
      return;
    }

    const [nextOperation] = this.pendingOperations.splice(nextOperationIndex, 1);
    nextOperation?.start();
  }

  private getBlockingReservation(priority: ContextOperationPriority): ContextOperationReservation | null {
    let blockingReservation: ContextOperationReservation | null = null;
    this.reservations.forEach((reservation) => {
      if (!this.isLowerPriority(priority, reservation.priority)) {
        return;
      }

      if (
        !blockingReservation
        || CONTEXT_OPERATION_PRIORITY_RANK[reservation.priority]
          < CONTEXT_OPERATION_PRIORITY_RANK[blockingReservation.priority]
      ) {
        blockingReservation = reservation;
      }
    });
    return blockingReservation;
  }

  private resolveAllowedAdmissionWaiters(): void {
    Array.from(this.admissionWaiters).forEach((waiter) => {
      if (this.getBlockingReservation(waiter.priority)) {
        return;
      }

      this.admissionWaiters.delete(waiter);
      waiter.resolve();
    });
  }

  private cancelLowerPriorityOperations(priority: ContextOperationPriority, error: unknown): void {
    const operationsToCancel = Array.from(this.activeOperations.values())
      .filter((operation) => this.isLowerPriority(operation.priority, priority));
    operationsToCancel.forEach((operation) => operation.cancel(error));
  }

  private isLowerPriority(
    candidate: ContextOperationPriority,
    reference: ContextOperationPriority,
  ): boolean {
    return CONTEXT_OPERATION_PRIORITY_RANK[candidate] > CONTEXT_OPERATION_PRIORITY_RANK[reference];
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
