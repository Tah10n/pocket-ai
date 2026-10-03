import { TtsPlaybackController } from './TtsPlayback';

/** Uses the existing patched Expo player and focus admission. Never deletes a borrowed source. */
export class AudioSamplePreviewService {
  private readonly player = new TtsPlaybackController();
  private generation = 0;
  private ownerKey: string | undefined;
  getState = () => this.player.getState();
  subscribe = (listener: () => void) => this.player.subscribe(listener);
  async play(options: { uri: string; sampleRate: number; sampleCount: number; isCurrent?: () => boolean; ownerKey?: string },
    isCurrent?: () => boolean): Promise<void> {
    const generation = ++this.generation;
    this.ownerKey = options.ownerKey;
    const current = () => generation === this.generation && (isCurrent ?? options.isCurrent)?.() !== false;
    await this.player.setBorrowedClip(options.uri, options, current);
    if (current()) await this.player.play();
  }
  stop(expectedOwnerKey?: string): Promise<void> {
    if (expectedOwnerKey !== undefined && this.ownerKey !== expectedOwnerKey) return Promise.resolve();
    const generation = ++this.generation;
    this.player.cancelStart();
    return this.player.clear().then(() => {
      if (generation === this.generation) this.ownerKey = undefined;
    });
  }
}
export const audioSamplePreviewService = new AudioSamplePreviewService();
