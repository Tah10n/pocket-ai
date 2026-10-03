export interface AudioSessionLease { release(): void }

/** One capture/playback owner. Transfer only after the preceding native owner confirms drain. */
export class AudioSessionCoordinator {
  private owner: { token: symbol; drain: () => Promise<void>; lease: AudioSessionLease } | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  acquire(token: symbol, drain: () => Promise<void>): Promise<AudioSessionLease> {
    const work = this.queue.then(async () => {
      if (this.owner?.token === token) return this.owner.lease;
      const previous = this.owner;
      if (previous) {
        await previous.drain(); // A rejection keeps this exact owner; a timeout is not release.
        if (this.owner === previous) throw new Error('audio_session_not_released');
      }
      const lease: AudioSessionLease = { release: () => {
        if (this.owner?.lease === lease) this.owner = null;
      } };
      this.owner = { token, drain, lease };
      return lease;
    });
    this.queue = work.catch(() => undefined);
    return work;
  }
}

const coordinator = new AudioSessionCoordinator();
export const acquireAudioSession = (owner: symbol, drain: () => Promise<void>): Promise<AudioSessionLease> =>
  coordinator.acquire(owner, drain);
