import { AudioSessionCoordinator } from '../../src/services/AudioSessionCoordinator';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('exclusive capture and playback session', () => {
  it('waits for actual disposal before a different owner can acquire', async () => {
    const session = new AudioSessionCoordinator();
    const disposal = deferred();
    let released = false;
    const first = await session.acquire(Symbol('player'), async () => {
      await disposal.promise;
      released = true;
      first.release();
    });
    const next = session.acquire(Symbol('recorder'), async () => undefined);
    let acquired = false;
    void next.then(() => { acquired = true; });
    await Promise.resolve(); await Promise.resolve();
    expect(acquired).toBe(false);
    disposal.resolve();
    const lease = await next;
    expect(released).toBe(true);
    lease.release();
  });

  it('keeps uncertain native ownership and retries its drain without overlap', async () => {
    const session = new AudioSessionCoordinator();
    let fail = true;
    const drain = jest.fn(async () => {
      if (fail) throw new Error('dispose_failed');
      lease.release();
    });
    const lease = await session.acquire(Symbol('player'), drain);
    await expect(session.acquire(Symbol('recorder'), async () => undefined)).rejects.toThrow('dispose_failed');
    fail = false;
    const next = await session.acquire(Symbol('preview'), async () => undefined);
    expect(drain).toHaveBeenCalledTimes(2);
    lease.release(); // A stale release cannot relinquish the current preview owner.
    await expect(session.acquire(Symbol('another'), async () => undefined)).rejects.toThrow('audio_session_not_released');
    next.release();
  });

  it('repeated acquisition by the same owner returns one lease', async () => {
    const session = new AudioSessionCoordinator();
    const token = Symbol('recorder');
    const drain = jest.fn(async () => undefined);
    const lease = await session.acquire(token, drain);
    expect(await session.acquire(token, drain)).toBe(lease);
    expect(drain).not.toHaveBeenCalled();
    lease.release();
  });
});
