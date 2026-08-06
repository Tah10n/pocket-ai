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
  /**
   * Whether Stop/Clear generation cancellation owns this operation. Lifecycle
   * work can opt out while remaining serialized, watchdog-bounded, and visible
   * to unload drains. Defaults to true.
   */
  readonly generationOwned?: boolean;
  readonly priority?: ContextOperationPriority;
  readonly startTimeoutMs?: number;
  readonly createStartTimeoutError?: ErrorFactory;
  readonly createPriorityPreemptionError?: ErrorFactory;
  /**
   * Hard ownership watchdog. When it fires, the raw native owner is treated
   * as hung and `onRuntimeTimeout` runs the ownership recovery path. It stays
   * armed across external cancellation on purpose: the detached raw owner is
   * exactly what the recovery path must bound.
   */
  readonly runtimeTimeoutMs?: number;
  readonly createRuntimeTimeoutError?: ErrorFactory;
  readonly onRuntimeTimeout?: (error: unknown) => void | Promise<void>;
  /**
   * Soft result watchdog. It only rejects the caller-facing promise so slow
   * but healthy operations do not keep their callers waiting; the raw native
   * owner keeps running and the hard watchdog stays armed for it.
   */
  readonly softRuntimeTimeoutMs?: number;
  readonly createSoftRuntimeTimeoutError?: ErrorFactory;
};

type ContextOperationCancelOptions = {
  readonly chatBlocking?: boolean;
  readonly generationOwned?: boolean;
  readonly lowerPriorityThan?: ContextOperationPriority;
};

type ContextOperationWaitOptions = {
  readonly timeoutMs?: number;
  readonly chatBlocking?: boolean;
  readonly generationOwned?: boolean;
};

type ContextOperationCancellationWaitOptions = {
  readonly chatBlocking?: boolean;
  readonly generationOwned?: boolean;
};

export type ContextOperationCancellationToken = {
  readonly isCancelled: () => boolean;
  readonly throwIfCancelled: () => void;
};

type ActiveContextOperation = {
  readonly promise: Promise<unknown>;
  readonly chatBlocking: boolean;
  readonly generationOwned: boolean;
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

type ContextOperationCancellationWaiter = {
  readonly chatBlocking: boolean;
  readonly generationOwned: boolean;
  readonly cancel: () => void;
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
  public generationOwnedRawActivePromises: Set<Promise<unknown>> = new Set();
  public activeRejects: Map<Promise<unknown>, (error: unknown) => void> = new Map();
  private activeOperations: Map<Promise<unknown>, ActiveContextOperation> = new Map();
  private pendingOperations: ScheduledContextOperation[] = [];
  private runningOperation: ScheduledContextOperation | null = null;
  private reservations = new Map<number, ContextOperationReservation>();
  private admissionWaiters = new Set<ContextOperationAdmissionWaiter>();
  private cancellationWaiters = new Set<ContextOperationCancellationWaiter>();
  private nextOperationSequence = 0;
  private nextReservationId = 0;
  private resolveQueueDrain: (() => void) | null = null;
  public cancelGeneration = 0;
  public generationOwnedCancelGeneration = 0;
  public chatBlockingCancelGeneration = 0;

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

  /**
   * Keeps work that must wait outside the native queue on the same cancellation
   * boundary as tracked context operations. This is used for lifecycle barriers
   * that already own the queue, where admitting a placeholder operation would
   * create a queue-start timeout or a false raw native owner.
   */
  public raceAgainstCancellation<T>(
    promise: Promise<T>,
    createCancellationError: ErrorFactory,
    options: ContextOperationCancellationWaitOptions = {},
  ): Promise<T> {
    const isChatBlocking = options.chatBlocking !== false;
    const isGenerationOwned = options.generationOwned !== false;
    if (!isChatBlocking && !isGenerationOwned) {
      return promise;
    }

    const generationOwnedCancelGeneration = this.generationOwnedCancelGeneration;
    const chatBlockingCancelGeneration = this.chatBlockingCancelGeneration;
    let didCancel = false;
    let rejectCancellation: (error: unknown) => void = () => undefined;
    const cancellationPromise = new Promise<never>((_, reject) => {
      rejectCancellation = reject;
    });
    const waiter: ContextOperationCancellationWaiter = {
      chatBlocking: isChatBlocking,
      generationOwned: isGenerationOwned,
      cancel: () => {
        if (didCancel) {
          return;
        }
        didCancel = true;
        let cancellationError: unknown;
        try {
          cancellationError = createCancellationError();
        } catch (error) {
          cancellationError = error;
        }
        rejectCancellation(cancellationError);
      },
    };
    this.cancellationWaiters.add(waiter);

    // Keep the generation check adjacent to registration so an invalidation at
    // the barrier boundary cannot leave this waiter attached to a stale epoch.
    if (
      (isGenerationOwned
        && this.generationOwnedCancelGeneration !== generationOwnedCancelGeneration)
      || (isChatBlocking
        && this.chatBlockingCancelGeneration !== chatBlockingCancelGeneration)
    ) {
      waiter.cancel();
    }

    return Promise.race([promise, cancellationPromise]).finally(() => {
      this.cancellationWaiters.delete(waiter);
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
    const isGenerationOwned = options.generationOwned !== false;
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
    let runtimeTimeoutId: ReturnType<typeof setTimeout> | null = null;
    let softRuntimeTimeoutId: ReturnType<typeof setTimeout> | null = null;
    const clearRuntimeWatchdogTimers = () => {
      if (runtimeTimeoutId !== null) {
        clearTimeout(runtimeTimeoutId);
        runtimeTimeoutId = null;
      }
      if (softRuntimeTimeoutId !== null) {
        clearTimeout(softRuntimeTimeoutId);
        softRuntimeTimeoutId = null;
      }
    };
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
    if (isGenerationOwned) {
      this.generationOwnedRawActivePromises.add(rawOperationPromise);
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
        if (
          typeof options.runtimeTimeoutMs === 'number'
          && options.runtimeTimeoutMs > 0
          && options.createRuntimeTimeoutError
        ) {
          runtimeTimeoutId = setTimeout(() => {
            runtimeTimeoutId = null;
            if (operationSettled) {
              return;
            }

            const runtimeTimeoutError = options.createRuntimeTimeoutError?.() ?? getCancellationError();
            this.activeOperations.get(operationPromise)?.cancel(runtimeTimeoutError);
            try {
              const callbackResult = options.onRuntimeTimeout?.(runtimeTimeoutError);
              void Promise.resolve(callbackResult).catch(() => undefined);
            } catch {
              // A throwing recovery callback must not escape the timer as an
              // uncaught error while the engine is mid-detach. Rejected async
              // callbacks are consumed above for the same reason.
            }
          }, options.runtimeTimeoutMs);
        }
        if (
          typeof options.softRuntimeTimeoutMs === 'number'
          && options.softRuntimeTimeoutMs > 0
          && options.createSoftRuntimeTimeoutError
        ) {
          softRuntimeTimeoutId = setTimeout(() => {
            softRuntimeTimeoutId = null;
            if (operationSettled || operationCancelled) {
              return;
            }

            const softTimeoutError = options.createSoftRuntimeTimeoutError?.() ?? getCancellationError();
            this.activeOperations.get(operationPromise)?.cancel(softTimeoutError);
          }, options.softRuntimeTimeoutMs);
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
      generationOwned: isGenerationOwned,
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
        clearRuntimeWatchdogTimers();
        this.clearRawActiveOperation(rawOperationPromise, scheduledOperation);
      },
      () => {
        operationSettled = true;
        clearRuntimeWatchdogTimers();
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
    const activeContextOperations = this.getRawActiveOperations(options);
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
    const hasGenerationOwnedFilter = typeof options.generationOwned === 'boolean';
    const hasPriorityFilter = options.lowerPriorityThan != null;
    const isSelectiveCancellation = hasChatBlockingFilter || hasGenerationOwnedFilter || hasPriorityFilter;
    if (!isSelectiveCancellation) {
      this.cancelGeneration += 1;
      this.invalidateGenerationOwned();
      this.invalidateChatBlocking();
    }

    const operationsToCancel = Array.from(this.activeOperations.values()).filter((operation) => (
      (!hasChatBlockingFilter || operation.chatBlocking === options.chatBlocking)
      && (!hasGenerationOwnedFilter || operation.generationOwned === options.generationOwned)
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

  public invalidateGenerationOwned(): void {
    this.generationOwnedCancelGeneration += 1;
    this.cancelCancellationWaiters('generationOwned');
  }

  public invalidateChatBlocking(): void {
    this.chatBlockingCancelGeneration += 1;
    this.cancelCancellationWaiters('chatBlocking');
  }

  public cancelGenerationOwned(error: unknown): void {
    this.invalidateGenerationOwned();
    this.cancelActive(error, { generationOwned: true });
  }

  public reset(error?: unknown): void {
    this.cancelGeneration += 1;
    this.invalidateGenerationOwned();
    this.invalidateChatBlocking();
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
    this.generationOwnedRawActivePromises.clear();
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

  private cancelCancellationWaiters(
    ownership: 'chatBlocking' | 'generationOwned',
  ): void {
    for (const waiter of [...this.cancellationWaiters]) {
      if (waiter[ownership]) {
        waiter.cancel();
      }
    }
  }

  private getRawActiveOperations(options: ContextOperationWaitOptions): Promise<unknown>[] {
    const hasChatBlockingFilter = typeof options.chatBlocking === 'boolean';
    const hasGenerationOwnedFilter = typeof options.generationOwned === 'boolean';

    return Array.from(this.rawActivePromises).filter((promise) => (
      (
        !hasChatBlockingFilter
        || this.chatBlockingRawActivePromises.has(promise) === options.chatBlocking
      )
      && (
        !hasGenerationOwnedFilter
        || this.generationOwnedRawActivePromises.has(promise) === options.generationOwned
      )
    ));
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
    this.generationOwnedRawActivePromises.delete(rawOperationPromise);
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
  private interruptionWaiters = new Set<{ cancel: () => void }>();

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

  /**
   * Makes pre-generation lifecycle barriers obey the same Stop boundary as the
   * completion driver. The underlying lifecycle promise keeps running; only
   * the caller-facing completion is interrupted.
   */
  public raceAgainstInterruption<TAwaited>(
    promise: Promise<TAwaited>,
    generation: number,
    createInterruptedError: ErrorFactory,
  ): Promise<TAwaited> {
    let didInterrupt = false;
    let rejectInterruption: (error: unknown) => void = () => undefined;
    const interruptionPromise = new Promise<never>((_, reject) => {
      rejectInterruption = reject;
    });
    const waiter = {
      cancel: () => {
        if (didInterrupt) {
          return;
        }
        didInterrupt = true;
        let interruptionError: unknown;
        try {
          interruptionError = createInterruptedError();
        } catch (error) {
          interruptionError = error;
        }
        rejectInterruption(interruptionError);
      },
    };
    this.interruptionWaiters.add(waiter);

    // Keep registration and the generation check adjacent so Stop cannot land
    // between them and leave a stale waiter attached to the old generation.
    if (this.interruptGeneration !== generation) {
      waiter.cancel();
    }

    return Promise.race([promise, interruptionPromise])
      .then((value) => {
        // A resolved source may already have queued its reaction when Stop or
        // reset lands. Recheck after race settlement so that ordering cannot
        // let a stale driver cross the barrier.
        if (this.interruptGeneration !== generation) {
          throw createInterruptedError();
        }
        return value;
      })
      .finally(() => {
        this.interruptionWaiters.delete(waiter);
      });
  }

  public interruptIfActive(): void {
    if (this.activePromise) {
      this.interruptGeneration += 1;
      this.cancelInterruptionWaiters();
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
    this.interruptGeneration += 1;
    this.cancelInterruptionWaiters();
    this.activePromise = null;
    this.activeDriverPromise = null;
    this.activeReject = null;
  }

  private cancelInterruptionWaiters(): void {
    for (const waiter of [...this.interruptionWaiters]) {
      waiter.cancel();
    }
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
