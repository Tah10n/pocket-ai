import { TTS_LATENCY_STAGES, boundedTtsLatencyMs, sanitizeTtsLatency,
  type TtsLatency, type TtsLatencyStage } from '../types/tts';

export const ttsNow = (): number => performance.now();

/** One bounded accumulator per request; timestamps never leave this owner. */
export class TtsLatencyMeasurement {
  private readonly starts = new Map<TtsLatencyStage, number>();
  private readonly stagesMs: Partial<Record<TtsLatencyStage, number>> = {};
  private readonly numeric: Partial<Omit<TtsLatency, 'runKind' | 'stagesMs'>> = {};
  constructor(readonly runKind: TtsLatency['runKind'], private readonly actionStartedAt = ttsNow()) {}
  observe(stage: string, phase: 'started' | 'settled' | 'failed'): void {
    if (!TTS_LATENCY_STAGES.includes(stage as TtsLatencyStage)) return;
    const key = stage as TtsLatencyStage;
    if (phase === 'started') {
      if (!this.starts.has(key)) this.starts.set(key, ttsNow());
    } else {
      const start = this.starts.get(key);
      if (start === undefined) return;
      this.starts.delete(key);
      const duration = boundedTtsLatencyMs((this.stagesMs[key] ?? 0) + ttsNow() - start);
      if (duration !== undefined) this.stagesMs[key] = duration;
    }
  }
  set(key: keyof Omit<TtsLatency, 'runKind' | 'stagesMs'>, value: unknown): void {
    const duration = boundedTtsLatencyMs(value);
    if (duration !== undefined) Object.assign(this.numeric, { [key]: duration });
  }
  confirmPlayback(playToPlayingMs: number, automatic: boolean): void {
    this.set('playToPlayingMs', playToPlayingMs);
    if (automatic && this.numeric.actionToFirstPlaybackMs === undefined) this.set('actionToFirstPlaybackMs', ttsNow() - this.actionStartedAt);
  }
  snapshot(): TtsLatency { return sanitizeTtsLatency({ runKind: this.runKind, stagesMs: this.stagesMs, ...this.numeric })!; }
}
