import {
  buildLogcatDumpLines,
  buildPerformanceExportJson,
  buildPerformanceExportPayload,
  buildPerformanceExportPayloadFromSnapshot,
  buildTraceFilename,
  dumpTraceToLogcat,
  getUtf8ByteLength,
  safeJsonStringify,
} from '../../src/services/PerformanceExport';
import { performanceMonitor } from '../../src/services/PerformanceMonitor';
import type { PerformanceSnapshot, PerformanceTraceSession } from '../../src/services/PerformanceMonitor';

function buildSession(overrides?: Partial<PerformanceTraceSession>): PerformanceTraceSession {
  return {
    schemaVersion: 1,
    sessionId: 'session-1',
    startedWallTime: 1_710_000_000_000,
    platform: 'android',
    buildType: 'dev',
    ...overrides,
  };
}

describe('PerformanceExport', () => {
  it('builds a deterministic payload with sorted counters', () => {
    const snapshot: PerformanceSnapshot = {
      enabled: true,
      counters: { z: 1, a: 2, m: 3 },
      events: [],
    };

    const payload = buildPerformanceExportPayloadFromSnapshot(snapshot, buildSession());

    expect(payload.schemaVersion).toBe(1);
    expect(payload.session.schemaVersion).toBe(1);
    expect(Object.keys(payload.counters)).toEqual(['a', 'm', 'z']);
  });

  it('safeJsonStringify never throws on circular structures', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const json = safeJsonStringify({ circular });

    expect(typeof json).toBe('string');
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('safeJsonStringify drops functions and symbols', () => {
    const value = {
      ok: true,
      fn: () => 123,
      sym: Symbol('x'),
    };

    const json = safeJsonStringify(value);
    const parsed = JSON.parse(json) as any;

    expect(parsed.ok).toBe(true);
    expect(parsed.fn).toBeUndefined();
    expect(parsed.sym).toBeUndefined();
  });

  it('getUtf8ByteLength uses a fallback without TextEncoder', () => {
    const original = (globalThis as any).TextEncoder;
    try {
      (globalThis as any).TextEncoder = undefined;

      expect(getUtf8ByteLength('a')).toBe(1);
      expect(getUtf8ByteLength('€')).toBe(3);
      expect(getUtf8ByteLength('😀')).toBe(4);
    } finally {
      (globalThis as any).TextEncoder = original;
    }
  });

  it('buildPerformanceExportPayload falls back when snapshot throws', () => {
    const snapshotSpy = jest.spyOn(performanceMonitor, 'snapshot').mockImplementation(() => {
      throw new Error('snapshot failed');
    });
    performanceMonitor.setEnabled(false);

    const payload = buildPerformanceExportPayload();
    expect(payload.enabled).toBe(false);
    expect(payload.events).toEqual([]);
    expect(payload.counters).toEqual({});

    snapshotSpy.mockRestore();
  });

  it('buildPerformanceExportJson respects pretty option', () => {
    performanceMonitor.clear();
    performanceMonitor.setEnabled(true);

    const pretty = buildPerformanceExportJson({ pretty: true });
    const compact = buildPerformanceExportJson({ pretty: false });

    expect(pretty).toContain('\n');
    expect(compact).not.toContain('\n  ');
    expect(() => JSON.parse(pretty)).not.toThrow();
    expect(() => JSON.parse(compact)).not.toThrow();
  });

  it('builds parseable logcat dump lines with stable prefixes', () => {
    const snapshot: PerformanceSnapshot = {
      enabled: true,
      counters: { 'counter.a': 1, 'counter.b': 2 },
      events: [
        { type: 'mark', name: 'startup.jsBundleLoaded', t: 1, wallTime: 1000 },
        { type: 'span', name: 'bootstrap.app', t: 2, wallTime: 1002, durationMs: 10, meta: { ok: true } },
      ],
    };

    const payload = buildPerformanceExportPayloadFromSnapshot(snapshot, buildSession());
    const dump1 = buildLogcatDumpLines(payload);
    const dump2 = buildLogcatDumpLines(payload);

    expect(dump2.lines).toEqual(dump1.lines);

    const prefixes = {
      trace: 'POCKET_AI_PERF_TRACE ',
      event: 'POCKET_AI_PERF_EVENT ',
      counter: 'POCKET_AI_PERF_COUNTER ',
      end: 'POCKET_AI_PERF_END ',
    } as const;

    expect(dump1.lines[0]?.startsWith(prefixes.trace)).toBe(true);
    expect(dump1.lines[dump1.lines.length - 1]?.startsWith(prefixes.end)).toBe(true);

    const eventLines = dump1.lines.filter((line) => line.startsWith(prefixes.event));
    expect(eventLines).toHaveLength(snapshot.events.length);

    for (const line of dump1.lines) {
      const prefix = Object.values(prefixes).find((candidate) => line.startsWith(candidate));
      expect(prefix).toBeDefined();
      const jsonPart = prefix ? line.slice(prefix.length) : '';
      expect(() => JSON.parse(jsonPart)).not.toThrow();
    }
  });

  it('keeps logcat dump lines under typical truncation limits', () => {
    const snapshot: PerformanceSnapshot = {
      enabled: true,
      counters: {},
      events: [
        {
          type: 'span',
          name: 'very.large.meta',
          t: 1,
          wallTime: 1000,
          durationMs: 42,
          meta: { payload: 'x'.repeat(12_000) },
        },
      ],
    };

    const payload = buildPerformanceExportPayloadFromSnapshot(snapshot, buildSession());
    const dump = buildLogcatDumpLines(payload);

    const eventLine = dump.lines.find((line) => line.startsWith('POCKET_AI_PERF_EVENT '));
    expect(eventLine).toBeDefined();

    if (eventLine) {
      expect(getUtf8ByteLength(eventLine)).toBeLessThan(4000);
      const jsonPart = eventLine.slice('POCKET_AI_PERF_EVENT '.length);
      const parsed = JSON.parse(jsonPart) as { meta?: Record<string, unknown> };
      expect(parsed.meta?.__truncated).toBe(true);
      expect(parsed.meta?.payload).toBeUndefined();
    }
  });

  it('emits counters as separate logcat lines when header is too large', () => {
    const manyCounters: Record<string, number> = {};
    for (let i = 0; i < 200; i += 1) {
      manyCounters[`counter.${String(i).padStart(3, '0')}.${'x'.repeat(20)}`] = i;
    }

    const snapshot: PerformanceSnapshot = {
      enabled: true,
      counters: manyCounters,
      events: [],
    };

    const payload = buildPerformanceExportPayloadFromSnapshot(snapshot, buildSession());
    const dump = buildLogcatDumpLines(payload);

    expect(dump.lines.some((line) => line.startsWith('POCKET_AI_PERF_COUNTER '))).toBe(true);
  });

  it('dumpTraceToLogcat refuses when instrumentation is disabled', () => {
    performanceMonitor.setEnabled(false);
    const result = dumpTraceToLogcat();
    expect(result).toEqual({ ok: false, reason: 'instrumentation_disabled' });
  });

  it('dumpTraceToLogcat logs lines when enabled', () => {
    performanceMonitor.clear();
    performanceMonitor.setEnabled(true);
    performanceMonitor.mark('mark.test');

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const result = dumpTraceToLogcat();
    expect(result.ok).toBe(true);
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('builds a predictable filename prefix', () => {
    const fileName = buildTraceFilename('abc', 1_710_000_000_000);

    expect(fileName.startsWith('pocket-ai-trace-abc-')).toBe(true);
    expect(fileName.endsWith('.json')).toBe(true);
  });
});
