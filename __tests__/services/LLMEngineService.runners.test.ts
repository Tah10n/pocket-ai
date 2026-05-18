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
