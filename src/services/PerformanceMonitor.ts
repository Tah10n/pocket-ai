export type PerformanceEventType = 'mark' | 'span' | 'counter';

export type PerformanceEvent = {
  type: PerformanceEventType;
  name: string;
  t: number;
  wallTime: number;
  durationMs?: number;
  value?: number;
  meta?: Record<string, unknown>;
};

export interface PerformanceSnapshot {
  enabled: boolean;
  counters: Record<string, number>;
  events: PerformanceEvent[];
}

function getMonotonicNowMs(): number {
  const perf = globalThis.performance;
  if (perf && typeof perf.now === 'function') {
    return perf.now();
  }

  return Date.now();
}

function getWallTimeMs(): number {
  return Date.now();
}

function toPlainObject(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...map.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

class PerformanceMonitor {
  private events: PerformanceEvent[] = [];
  private counters = new Map<string, number>();
  private maxEvents = 400;
  private enabled = typeof __DEV__ !== 'undefined' && __DEV__;

  public isEnabled(): boolean {
    return this.enabled;
  }

  public setEnabled(nextEnabled: boolean): void {
    this.enabled = nextEnabled;
  }

  public mark(name: string, meta?: Record<string, unknown>): void {
    if (!this.enabled) {
      return;
    }

    this.pushEvent({
      type: 'mark',
      name,
      t: getMonotonicNowMs(),
      wallTime: getWallTimeMs(),
      meta,
    });
  }

  public startSpan(name: string, meta?: Record<string, unknown>): { end: (endMeta?: Record<string, unknown>) => void } {
    if (!this.enabled) {
      return { end: () => undefined };
    }

    const startedAt = getMonotonicNowMs();
    const startedWallTime = getWallTimeMs();
    let ended = false;

    return {
      end: (endMeta) => {
        if (ended || !this.enabled) {
          return;
        }
        ended = true;

        const endedAt = getMonotonicNowMs();
        this.pushEvent({
          type: 'span',
          name,
          t: startedAt,
          wallTime: startedWallTime,
          durationMs: Math.max(0, endedAt - startedAt),
          meta: endMeta ? { ...meta, ...endMeta } : meta,
        });
      },
    };
  }

  public incrementCounter(name: string, by: number = 1, meta?: Record<string, unknown>): void {
    if (!this.enabled) {
      return;
    }

    const nextValue = (this.counters.get(name) ?? 0) + by;
    this.counters.set(name, nextValue);

    if (meta) {
      this.pushEvent({
        type: 'counter',
        name,
        t: getMonotonicNowMs(),
        wallTime: getWallTimeMs(),
        value: nextValue,
        meta,
      });
    }
  }

  public clear(): void {
    this.events = [];
    this.counters.clear();
  }

  public snapshot(): PerformanceSnapshot {
    return {
      enabled: this.enabled,
      counters: toPlainObject(this.counters),
      events: [...this.events],
    };
  }

  private pushEvent(event: PerformanceEvent): void {
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
  }
}

export const performanceMonitor = new PerformanceMonitor();

