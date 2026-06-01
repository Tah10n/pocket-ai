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
    }, () => new Error('cancelled'), { chatBlocking: false });

    await backgroundStarted;
    expect(runner.hasActive()).toBe(true);
    expect(runner.hasActiveChatBlocking()).toBe(false);

    const chatBlockingOperation = runner.track(async () => 'chat', () => new Error('cancelled'));

    expect(runner.hasActiveChatBlocking()).toBe(true);
    releaseBackground();
    await expect(backgroundOperation).resolves.toBe('background');
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
