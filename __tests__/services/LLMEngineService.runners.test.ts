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
