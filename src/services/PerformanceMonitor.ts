import { Platform } from 'react-native';

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

export type PerformanceBuildType = 'dev' | 'prod' | 'unknown';

export type PerformancePlatform = 'ios' | 'android' | 'web' | 'unknown';

export type PerformanceTraceSession = {
  schemaVersion: 1;
  sessionId: string;
  startedWallTime: number;
  platform: PerformancePlatform;
  appVersion?: string;
  buildType: PerformanceBuildType;
};

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

function generateSessionId(): string {
  try {
    const cryptoAny = globalThis.crypto as { randomUUID?: () => string } | undefined;
    if (cryptoAny?.randomUUID) {
      return cryptoAny.randomUUID();
    }
  } catch {
    // ignore
  }

  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

function getBuildType(): PerformanceBuildType {
  if (typeof __DEV__ === 'undefined') {
    return 'unknown';
  }

  return __DEV__ ? 'dev' : 'prod';
}

function getPlatform(): PerformancePlatform {
  try {
    const platform = Platform.OS;
    if (platform === 'ios' || platform === 'android' || platform === 'web') {
      return platform;
    }
  } catch {
    // ignore
  }

  return 'unknown';
}

const NOOP_SPAN = { end: () => undefined } as const;

class PerformanceMonitor {
  private readonly session: PerformanceTraceSession = {
    schemaVersion: 1,
    sessionId: generateSessionId(),
    startedWallTime: getWallTimeMs(),
    platform: getPlatform(),
    buildType: getBuildType(),
  };

  private events: PerformanceEvent[] = [];
  private counters = new Map<string, number>();
  private maxEvents = 400;
  private enabled = typeof __DEV__ !== 'undefined' && __DEV__;

  public isEnabled(): boolean {
    return this.enabled;
  }

  public setEnabled(nextEnabled: boolean): void {
    try {
      this.enabled = nextEnabled;
    } catch {
      // ignore
    }
  }

  public getSessionInfo(): PerformanceTraceSession {
    return this.session;
  }

  public mark(name: string, meta?: Record<string, unknown>): void {
    try {
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
    } catch {
      // ignore
    }
  }

  public startSpan(name: string, meta?: Record<string, unknown>): { end: (endMeta?: Record<string, unknown>) => void } {
    try {
      if (!this.enabled) {
        return NOOP_SPAN;
      }

      const startedAt = getMonotonicNowMs();
      const startedWallTime = getWallTimeMs();
      let ended = false;

      return {
        end: (endMeta) => {
          try {
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
          } catch {
            // ignore
          }
        },
      };
    } catch {
      return NOOP_SPAN;
    }
  }

  public incrementCounter(name: string, by: number = 1, meta?: Record<string, unknown>): void {
    try {
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
    } catch {
      // ignore
    }
  }

  public clear(): void {
    try {
      this.events = [];
      this.counters.clear();
    } catch {
      // ignore
    }
  }

  public snapshot(): PerformanceSnapshot {
    try {
      return {
        enabled: this.enabled,
        counters: toPlainObject(this.counters),
        events: [...this.events],
      };
    } catch {
      return {
        enabled: this.enabled,
        counters: {},
        events: [],
      };
    }
  }

  private pushEvent(event: PerformanceEvent): void {
    try {
      this.events.push(event);
      if (this.events.length > this.maxEvents) {
        this.events.splice(0, this.events.length - this.maxEvents);
      }
    } catch {
      // ignore
    }
  }
}

export const performanceMonitor = new PerformanceMonitor();
