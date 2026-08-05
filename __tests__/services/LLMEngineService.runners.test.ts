import {
  ActiveCompletionRunner,
  ContextOperationRunner,
  waitForPromiseWithTimeout,
} from '../../src/services/LLMEngineService.runners';

describe('ContextOperationRunner', () => {
  it('serializes tracked operations', async () => {
    const runner = new ContextOperationRunner();
    const events: string[] = [];
    let releaseFirst: () => void = () => undefined;

    const first = runner.track(async () => {
      events.push('first:start');
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      events.push('first:end');
      return 'first';
    }, () => new Error('cancelled'));
    const second = runner.track(async () => {
      events.push('second:start');
      return 'second';
    }, () => new Error('cancelled'));

    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(['first:start']);
    releaseFirst();

    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('cancels active and queued operations', async () => {
    const runner = new ContextOperationRunner();
    const cancelError = new Error('unload timeout');
    const operation = runner.track(async () => {
      await new Promise<void>(() => undefined);
      return 'never';
    }, () => cancelError);

    runner.cancelActive(cancelError);

    await expect(operation).rejects.toThrow('unload timeout');
    expect(runner.activePromises.size).toBe(0);
    expect(runner.activeRejects.size).toBe(0);
  });

  it('waits for raw cancelled operations before reporting drained', async () => {
    const runner = new ContextOperationRunner();
    const cancelError = new Error('stopped');
    let releaseRawOperation: () => void = () => undefined;
    let markRawOperationStarted: () => void = () => undefined;
    const rawOperationStarted = new Promise<void>((resolve) => {
      markRawOperationStarted = resolve;
    });
    const operation = runner.track(async () => {
      markRawOperationStarted();
      await new Promise<void>((resolve) => {
        releaseRawOperation = resolve;
      });
      return 'late';
    }, () => cancelError);

    await rawOperationStarted;
    runner.cancelActive(cancelError);

    await expect(operation).rejects.toThrow('stopped');
    await expect(runner.waitForActive({ timeoutMs: 1 })).resolves.toBe('timed_out');
    releaseRawOperation();
    await expect(runner.waitForActive({ timeoutMs: 100 })).resolves.toBe('drained');
  });

  it('distinguishes chat-blocking operations from background context operations', async () => {
    const runner = new ContextOperationRunner();
    let releaseBackground: () => void = () => undefined;
    let markBackgroundStarted: () => void = () => undefined;
    const backgroundStarted = new Promise<void>((resolve) => {
      markBackgroundStarted = resolve;
    });

    const backgroundOperation = runner.track(async () => {
      markBackgroundStarted();
      await new Promise<void>((resolve) => {
        releaseBackground = resolve;
      });
      return 'background';
    }, () => new Error('cancelled'), {
      chatBlocking: false,
      priority: 'user_action',
    });

    await backgroundStarted;
    expect(runner.hasActive()).toBe(true);
    expect(runner.hasActiveChatBlocking()).toBe(false);

    const chatBlockingOperation = runner.track(
      async () => 'chat',
      () => new Error('cancelled'),
      { priority: 'user_action' },
    );

    expect(runner.hasActiveChatBlocking()).toBe(true);
    releaseBackground();
    await expect(backgroundOperation).resolves.toBe('background');
    await expect(chatBlockingOperation).resolves.toBe('chat');
    expect(runner.hasActive()).toBe(false);
    expect(runner.hasActiveChatBlocking()).toBe(false);
  });

  it('selectively cancels background operations without cancelling chat-blocking operations', async () => {
    const runner = new ContextOperationRunner();
    const cancelError = new Error('background stopped');
    let releaseBackground: () => void = () => undefined;
    let releaseChatBlocking: () => void = () => undefined;
    let markBackgroundStarted: () => void = () => undefined;
    let markChatBlockingStarted: () => void = () => undefined;
    const backgroundStarted = new Promise<void>((resolve) => {
      markBackgroundStarted = resolve;
    });
    const chatBlockingStarted = new Promise<void>((resolve) => {
      markChatBlockingStarted = resolve;
    });

    const backgroundOperation = runner.track(async (cancellation) => {
      markBackgroundStarted();
      await new Promise<void>((resolve) => {
        releaseBackground = resolve;
      });
      cancellation.throwIfCancelled();
      return 'background';
    }, () => new Error('cancelled'), {
      chatBlocking: false,
      priority: 'user_action',
    });
    const chatBlockingOperation = runner.track(async () => {
      markChatBlockingStarted();
      await new Promise<void>((resolve) => {
        releaseChatBlocking = resolve;
      });
      return 'chat';
    }, () => new Error('cancelled'), { priority: 'user_action' });

    await backgroundStarted;
    runner.cancelActive(cancelError, { chatBlocking: false });

    await expect(backgroundOperation).rejects.toThrow('background stopped');
    expect(runner.hasActive()).toBe(true);
    expect(runner.hasActiveChatBlocking()).toBe(true);

    releaseBackground();
    await chatBlockingStarted;
    releaseChatBlocking();

    await expect(chatBlockingOperation).resolves.toBe('chat');
    expect(runner.hasActive()).toBe(false);
    expect(runner.hasActiveChatBlocking()).toBe(false);
  });

  it('resets stale raw operations so future operations are not blocked', async () => {
    const runner = new ContextOperationRunner();
    const resetError = new Error('unload timeout');
    const operation = runner.track(async () => {
      await new Promise<void>(() => undefined);
      return 'never';
    }, () => resetError);

    runner.reset(resetError);

    await expect(operation).rejects.toThrow('unload timeout');
    expect(runner.activePromises.size).toBe(0);
    expect(runner.rawActivePromises.size).toBe(0);
    expect(runner.activeRejects.size).toBe(0);

    await expect(runner.track(async () => 'fresh', () => resetError)).resolves.toBe('fresh');
  });

  it('reserves prompt preparation atomically and cancels lower-priority work without overlapping native owners', async () => {
    const runner = new ContextOperationRunner();
    const events: string[] = [];
    const preempted = new Error('foreground reserved');
    let releaseActiveRaw: () => void = () => undefined;
    let markActiveStarted: () => void = () => undefined;
    const activeStarted = new Promise<void>((resolve) => {
      markActiveStarted = resolve;
    });

    const activeBackground = runner.track(async (cancellation) => {
      events.push('active-background:start');
      markActiveStarted();
      await new Promise<void>((resolve) => {
        releaseActiveRaw = resolve;
      });
      cancellation.throwIfCancelled();
      events.push('active-background:end');
      return 'background';
    }, () => new Error('cancelled'), {
      chatBlocking: false,
      priority: 'background_probe',
    });
    const observedActiveBackground = activeBackground.catch((error) => error);
    await activeStarted;

    const queuedBackgroundBody = jest.fn(async () => 'queued-background');
    const queuedBackground = runner.track(
      queuedBackgroundBody,
      () => new Error('cancelled'),
      { chatBlocking: false, priority: 'background_probe' },
    );
    const observedQueuedBackground = queuedBackground.catch((error) => error);

    const releaseReservation = runner.reserve('prompt_preparation', preempted);
    await expect(observedActiveBackground).resolves.toBe(preempted);
    await expect(observedQueuedBackground).resolves.toBe(preempted);
    expect(queuedBackgroundBody).not.toHaveBeenCalled();

    const lateBackgroundBody = jest.fn(async () => 'late-background');
    await expect(runner.track(
      lateBackgroundBody,
      () => new Error('cancelled'),
      { chatBlocking: false, priority: 'background_probe' },
    )).rejects.toBe(preempted);
    expect(lateBackgroundBody).not.toHaveBeenCalled();

    const foreground = runner.track(async () => {
      events.push('foreground:start');
      return 'foreground';
    }, () => new Error('cancelled'), { priority: 'prompt_preparation' });

    await Promise.resolve();
    expect(events).toEqual(['active-background:start']);
    releaseActiveRaw();
    await expect(foreground).resolves.toBe('foreground');
    releaseReservation();

    expect(events).toEqual(['active-background:start', 'foreground:start']);
    await expect(runner.waitForActive({ timeoutMs: 100 })).resolves.toBe('drained');
  });

  it('keeps passive admission asleep until every prompt reservation is released or cleared', async () => {
    const runner = new ContextOperationRunner();
    expect(runner.isAdmissionAllowed('passive_readiness')).toBe(true);
    const releaseFirstReservation = runner.reserve('prompt_preparation', new Error('first reservation'));
    const releaseSecondReservation = runner.reserve('prompt_preparation', new Error('second reservation'));
    expect(runner.isAdmissionAllowed('passive_readiness')).toBe(false);
    let admissionResolved = false;
    const admissionPromise = runner.waitUntilAllowed('passive_readiness').then(() => {
      admissionResolved = true;
    });

    await Promise.resolve();
    expect(admissionResolved).toBe(false);

    releaseFirstReservation();
    await Promise.resolve();
    expect(admissionResolved).toBe(false);

    runner.clearReservations('prompt_preparation');
    await admissionPromise;
    expect(admissionResolved).toBe(true);
    expect(runner.isAdmissionAllowed('passive_readiness')).toBe(true);

    releaseSecondReservation();
  });

  it('preempts lower-priority work when higher-priority work is tracked directly', async () => {
    const runner = new ContextOperationRunner();
    const events: string[] = [];
    const backgroundCancellationError = new Error('background cancelled');
    const foregroundCancellationError = new Error('foreground generic cancellation');
    const priorityPreemptionError = new Error('preempted by foreground priority');
    let releaseRawOwner: () => void = () => undefined;
    let markOwnerStarted: () => void = () => undefined;
    const ownerStarted = new Promise<void>((resolve) => {
      markOwnerStarted = resolve;
    });
    const background = runner.track(async (cancellation) => {
      events.push('background:start');
      markOwnerStarted();
      await new Promise<void>((resolve) => {
        releaseRawOwner = resolve;
      });
      cancellation.throwIfCancelled();
      events.push('background:side-effect');
      return 'background';
    }, () => backgroundCancellationError, {
      chatBlocking: false,
      priority: 'passive_readiness',
    });
    const observedBackground = background.catch((error) => error);
    await ownerStarted;

    const foreground = runner.track(async () => {
      events.push('foreground:start');
      return 'foreground';
    }, () => foregroundCancellationError, {
      priority: 'prompt_preparation',
      createPriorityPreemptionError: () => priorityPreemptionError,
    });

    await expect(observedBackground).resolves.toBe(priorityPreemptionError);
    expect(events).toEqual(['background:start']);
    releaseRawOwner();
    await expect(foreground).resolves.toBe('foreground');
    expect(events).toEqual(['background:start', 'foreground:start']);
  });

  it('cancels lower-priority queued work when a higher-priority operation arrives', async () => {
    const runner = new ContextOperationRunner();
    const events: string[] = [];
    let releaseOwner: () => void = () => undefined;
    let markOwnerStarted: () => void = () => undefined;
    const ownerStarted = new Promise<void>((resolve) => {
      markOwnerStarted = resolve;
    });

    const owner = runner.track(async () => {
      events.push('owner:start');
      markOwnerStarted();
      await new Promise<void>((resolve) => {
        releaseOwner = resolve;
      });
      return 'owner';
    }, () => new Error('cancelled'), { priority: 'completion' });
    await ownerStarted;

    const passive = runner.track(async () => {
      events.push('passive:start');
      return 'passive';
    }, () => new Error('cancelled'), {
      chatBlocking: false,
      priority: 'passive_readiness',
    });
    const observedPassive = passive.catch((error) => error);
    const completion = runner.track(async () => {
      events.push('completion:start');
      return 'completion';
    }, () => new Error('cancelled'), { priority: 'completion' });

    await expect(observedPassive).resolves.toEqual(expect.objectContaining({ message: 'cancelled' }));
    releaseOwner();
    await expect(owner).resolves.toBe('owner');
    await expect(completion).resolves.toBe('completion');
    expect(events).toEqual(['owner:start', 'completion:start']);
  });

  it('times out a foreground operation that cannot acquire the native owner', async () => {
    jest.useFakeTimers();
    const runner = new ContextOperationRunner();
    let releaseOwner: () => void = () => undefined;
    let markOwnerStarted: () => void = () => undefined;
    const ownerStarted = new Promise<void>((resolve) => {
      markOwnerStarted = resolve;
    });
    const owner = runner.track(async () => {
      markOwnerStarted();
      await new Promise<void>((resolve) => {
        releaseOwner = resolve;
      });
      return 'owner';
    }, () => new Error('cancelled'), { priority: 'completion' });

    try {
      await ownerStarted;
      const queuedBody = jest.fn(async () => 'never');
      const queued = runner.track(queuedBody, () => new Error('cancelled'), {
        priority: 'completion',
        startTimeoutMs: 50,
        createStartTimeoutError: () => new Error('start timed out'),
      });

      await jest.advanceTimersByTimeAsync(50);
      await expect(queued).rejects.toThrow('start timed out');
      expect(queuedBody).not.toHaveBeenCalled();
    } finally {
      releaseOwner();
      await owner;
      jest.useRealTimers();
    }
  });

  it('does not consume the runtime timeout while the operation waits in the queue', async () => {
    jest.useFakeTimers();
    const runner = new ContextOperationRunner();
    const runtimeTimeoutError = new Error('runtime timed out');
    const onRuntimeTimeout = jest.fn();
    let releaseOwner: () => void = () => undefined;
    let markOwnerStarted: () => void = () => undefined;
    const ownerStarted = new Promise<void>((resolve) => {
      markOwnerStarted = resolve;
    });
    let releaseWatched: () => void = () => undefined;
    let markWatchedStarted: () => void = () => undefined;
    const watchedStarted = new Promise<void>((resolve) => {
      markWatchedStarted = resolve;
    });

    const owner = runner.track(async () => {
      markOwnerStarted();
      await new Promise<void>((resolve) => {
        releaseOwner = resolve;
      });
      return 'owner';
    }, () => new Error('cancelled'), { priority: 'completion' });
    const watchedBody = jest.fn(async () => {
      markWatchedStarted();
      await new Promise<void>((resolve) => {
        releaseWatched = resolve;
      });
      return 'watched';
    });
    const watched = runner.track(watchedBody, () => new Error('cancelled'), {
      priority: 'completion',
      runtimeTimeoutMs: 50,
      createRuntimeTimeoutError: () => runtimeTimeoutError,
      onRuntimeTimeout,
    });
    const observedWatched = watched.catch((error) => error);

    try {
      await ownerStarted;

      await jest.advanceTimersByTimeAsync(100);
      expect(watchedBody).not.toHaveBeenCalled();
      expect(onRuntimeTimeout).not.toHaveBeenCalled();

      releaseOwner();
      await owner;
      await jest.advanceTimersByTimeAsync(0);
      await watchedStarted;
      expect(watchedBody).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(49);
      expect(onRuntimeTimeout).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1);
      await expect(observedWatched).resolves.toBe(runtimeTimeoutError);
      expect(onRuntimeTimeout).toHaveBeenCalledTimes(1);

      releaseWatched();
      const drained = runner.waitForActive({ timeoutMs: 100 });
      await jest.advanceTimersByTimeAsync(100);
      await expect(drained).resolves.toBe('drained');

      await jest.advanceTimersByTimeAsync(200);
      expect(onRuntimeTimeout).toHaveBeenCalledTimes(1);
    } finally {
      releaseOwner();
      releaseWatched();
      await owner.catch(() => undefined);
      await watched.catch(() => undefined);
      jest.useRealTimers();
    }
  });

  it('times out a started hung operation exactly once', async () => {
    jest.useFakeTimers();
    const runner = new ContextOperationRunner();
    const runtimeTimeoutError = new Error('runtime timed out');
    const onRuntimeTimeout = jest.fn();
    let releaseRawOperation: () => void = () => undefined;
    let markHungStarted: () => void = () => undefined;
    const hungStarted = new Promise<void>((resolve) => {
      markHungStarted = resolve;
    });

    const hungBody = jest.fn(async () => {
      markHungStarted();
      await new Promise<void>((resolve) => {
        releaseRawOperation = resolve;
      });
      return 'hung';
    });
    const hung = runner.track(hungBody, () => new Error('cancelled'), {
      priority: 'completion',
      runtimeTimeoutMs: 50,
      createRuntimeTimeoutError: () => runtimeTimeoutError,
      onRuntimeTimeout,
    });
    const observedHung = hung.catch((error) => error);

    try {
      await hungStarted;
      expect(hungBody).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(50);

      await expect(observedHung).resolves.toBe(runtimeTimeoutError);
      expect(onRuntimeTimeout).toHaveBeenCalledTimes(1);
      expect(onRuntimeTimeout).toHaveBeenCalledWith(runtimeTimeoutError);
      expect(runner.hasActive()).toBe(true);

      releaseRawOperation();
      const drained = runner.waitForActive({ timeoutMs: 100 });
      await jest.advanceTimersByTimeAsync(100);
      await expect(drained).resolves.toBe('drained');
      expect(runner.hasActive()).toBe(false);

      await jest.advanceTimersByTimeAsync(200);
      expect(onRuntimeTimeout).toHaveBeenCalledTimes(1);
    } finally {
      releaseRawOperation();
      await hung.catch(() => undefined);
      jest.useRealTimers();
    }
  });

  it('does not fire the runtime timeout when the operation settles before the deadline', async () => {
    jest.useFakeTimers();
    const runner = new ContextOperationRunner();
    const runtimeTimeoutError = new Error('runtime timed out');
    const onRuntimeTimeout = jest.fn();

    const watched = runner.track(async () => 'watched', () => new Error('cancelled'), {
      priority: 'completion',
      runtimeTimeoutMs: 50,
      createRuntimeTimeoutError: () => runtimeTimeoutError,
      onRuntimeTimeout,
    });

    try {
      await expect(watched).resolves.toBe('watched');

      await jest.advanceTimersByTimeAsync(100);
      expect(onRuntimeTimeout).not.toHaveBeenCalled();
      expect(runner.hasActive()).toBe(false);
    } finally {
      await watched.catch(() => undefined);
      jest.useRealTimers();
    }
  });

  it('keeps the raw-owner watchdog armed after external cancellation', async () => {
    jest.useFakeTimers();
    const runner = new ContextOperationRunner();
    const externalError = new Error('external cancellation');
    const runtimeTimeoutError = new Error('runtime timed out');
    const onRuntimeTimeout = jest.fn();
    let releaseRawOperation: () => void = () => undefined;
    let markWatchedStarted: () => void = () => undefined;
    const watchedStarted = new Promise<void>((resolve) => {
      markWatchedStarted = resolve;
    });

    const watched = runner.track(async () => {
      markWatchedStarted();
      await new Promise<void>((resolve) => {
        releaseRawOperation = resolve;
      });
      return 'watched';
    }, () => new Error('cancelled'), {
      priority: 'completion',
      runtimeTimeoutMs: 50,
      createRuntimeTimeoutError: () => runtimeTimeoutError,
      onRuntimeTimeout,
    });
    const observedWatched = watched.catch((error) => error);

    try {
      await watchedStarted;
      runner.cancelActive(externalError);

      await expect(observedWatched).resolves.toBe(externalError);
      expect(runner.hasActive()).toBe(true);

      await jest.advanceTimersByTimeAsync(49);
      expect(onRuntimeTimeout).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1);
      expect(onRuntimeTimeout).toHaveBeenCalledTimes(1);
      expect(onRuntimeTimeout).toHaveBeenCalledWith(runtimeTimeoutError);

      await jest.advanceTimersByTimeAsync(200);
      expect(onRuntimeTimeout).toHaveBeenCalledTimes(1);

      releaseRawOperation();
      const drained = runner.waitForActive({ timeoutMs: 100 });
      await jest.advanceTimersByTimeAsync(100);
      await expect(drained).resolves.toBe('drained');
      expect(runner.hasActive()).toBe(false);
    } finally {
      releaseRawOperation();
      await watched.catch(() => undefined);
      jest.useRealTimers();
    }
  });

  it('uses a soft timeout only for the caller result while a healthy raw owner settles after 15 seconds', async () => {
    jest.useFakeTimers();
    const runner = new ContextOperationRunner();
    const softTimeoutError = new Error('soft result timeout');
    const hardTimeoutError = new Error('hard ownership timeout');
    const onRuntimeTimeout = jest.fn();
    let releaseRawOperation: () => void = () => undefined;
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    const operation = runner.track(async () => {
      markStarted();
      await new Promise<void>((resolve) => {
        releaseRawOperation = resolve;
      });
      return 'late healthy result';
    }, () => new Error('cancelled'), {
      chatBlocking: false,
      priority: 'background_probe',
      softRuntimeTimeoutMs: 5000,
      createSoftRuntimeTimeoutError: () => softTimeoutError,
      runtimeTimeoutMs: 20_000,
      createRuntimeTimeoutError: () => hardTimeoutError,
      onRuntimeTimeout,
    });
    const observedOperation = operation.catch((error) => error);

    try {
      await started;
      await jest.advanceTimersByTimeAsync(5000);

      await expect(observedOperation).resolves.toBe(softTimeoutError);
      expect(runner.hasActive()).toBe(true);
      expect(onRuntimeTimeout).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(10_000);
      releaseRawOperation();
      await jest.advanceTimersByTimeAsync(0);
      await expect(runner.waitForActive()).resolves.toBe('drained');

      await jest.advanceTimersByTimeAsync(5000);
      expect(onRuntimeTimeout).not.toHaveBeenCalled();
      expect(runner.hasActive()).toBe(false);
    } finally {
      releaseRawOperation();
      await operation.catch(() => undefined);
      jest.useRealTimers();
    }
  });

  it('contains a synchronous exception from the hard-timeout recovery callback', async () => {
    jest.useFakeTimers();
    const runner = new ContextOperationRunner();
    const runtimeTimeoutError = new Error('runtime timed out');
    let releaseRawOperation: () => void = () => undefined;

    const operation = runner.track(async () => {
      await new Promise<void>((resolve) => {
        releaseRawOperation = resolve;
      });
      return 'late';
    }, () => new Error('cancelled'), {
      runtimeTimeoutMs: 50,
      createRuntimeTimeoutError: () => runtimeTimeoutError,
      onRuntimeTimeout: () => {
        throw new Error('recovery callback failed');
      },
    });
    const observedOperation = operation.catch((error) => error);

    try {
      await jest.advanceTimersByTimeAsync(50);
      await expect(observedOperation).resolves.toBe(runtimeTimeoutError);
      expect(runner.hasActive()).toBe(true);
    } finally {
      releaseRawOperation();
      await jest.advanceTimersByTimeAsync(0);
      await operation.catch(() => undefined);
      jest.useRealTimers();
    }
  });

  it('contains a rejected promise from the hard-timeout recovery callback', async () => {
    jest.useFakeTimers();
    const runner = new ContextOperationRunner();
    const runtimeTimeoutError = new Error('runtime timed out');
    let releaseRawOperation: () => void = () => undefined;

    const operation = runner.track(async () => {
      await new Promise<void>((resolve) => {
        releaseRawOperation = resolve;
      });
      return 'late';
    }, () => new Error('cancelled'), {
      runtimeTimeoutMs: 50,
      createRuntimeTimeoutError: () => runtimeTimeoutError,
      onRuntimeTimeout: async () => {
        throw new Error('async recovery callback failed');
      },
    });
    const observedOperation = operation.catch((error) => error);

    try {
      await jest.advanceTimersByTimeAsync(50);
      await expect(observedOperation).resolves.toBe(runtimeTimeoutError);
      await Promise.resolve();
      expect(runner.hasActive()).toBe(true);
    } finally {
      releaseRawOperation();
      await jest.advanceTimersByTimeAsync(0);
      await operation.catch(() => undefined);
      jest.useRealTimers();
    }
  });
});

describe('ActiveCompletionRunner', () => {
  it('tracks active completion state and interruption generation', () => {
    const runner = new ActiveCompletionRunner<string>();
    const completion = Promise.resolve('done');
    const reject = jest.fn();

    const generation = runner.start(completion, reject);
    expect(runner.hasActive()).toBe(true);

    runner.interruptIfActive();
    expect(() => runner.assertNotInterrupted(generation, () => new Error('interrupted'))).toThrow('interrupted');

    runner.clearIfActive(completion);
    expect(runner.hasActive()).toBe(false);
  });
});

describe('waitForPromiseWithTimeout', () => {
  it('returns timed_out when the promise does not settle before the timeout', async () => {
    await expect(waitForPromiseWithTimeout(
      new Promise(() => undefined),
      1,
    )).resolves.toBe('timed_out');
  });
});
