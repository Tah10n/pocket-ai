import { performanceMonitor, type PerformanceEvent, type PerformanceSnapshot, type PerformanceTraceSession } from './PerformanceMonitor';

export const PERFORMANCE_EXPORT_SCHEMA_VERSION = 1 as const;

export type PerformanceExportPayload = {
  schemaVersion: typeof PERFORMANCE_EXPORT_SCHEMA_VERSION;
  session: PerformanceTraceSession;
  enabled: boolean;
  counters: Record<string, number>;
  events: PerformanceEvent[];
};

type SafeStringifyOptions = {
  pretty?: boolean;
};

function sortNumberRecord(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}

function createSafeJsonReplacer(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>();

  return (_key, value) => {
    if (typeof value === 'function' || typeof value === 'symbol') {
      return undefined;
    }

    if (value && typeof value === 'object') {
      const objectValue = value as object;
      if (seen.has(objectValue)) {
        return '[Circular]';
      }
      seen.add(objectValue);
    }

    return value;
  };
}

export function safeJsonStringify(value: unknown, options?: SafeStringifyOptions): string {
  try {
    return JSON.stringify(value, createSafeJsonReplacer(), options?.pretty ? 2 : undefined) ?? '{}';
  } catch {
    try {
      return JSON.stringify({ error: 'safeJsonStringify_failed' });
    } catch {
      return '{}';
    }
  }
}

export function getUtf8ByteLength(text: string): number {
  try {
    // Hermes/JSC may not always expose TextEncoder; keep a cheap fallback.
    const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : undefined;
    if (encoder) {
      return encoder.encode(text).length;
    }
  } catch {
    // ignore
  }

  return text.length;
}

export function buildPerformanceExportPayloadFromSnapshot(
  snapshot: PerformanceSnapshot,
  session: PerformanceTraceSession,
): PerformanceExportPayload {
  return {
    schemaVersion: PERFORMANCE_EXPORT_SCHEMA_VERSION,
    session: {
      ...session,
      schemaVersion: PERFORMANCE_EXPORT_SCHEMA_VERSION,
    },
    enabled: snapshot.enabled,
    counters: sortNumberRecord(snapshot.counters),
    events: [...snapshot.events],
  };
}

export function buildPerformanceExportPayload(): PerformanceExportPayload {
  try {
    return buildPerformanceExportPayloadFromSnapshot(performanceMonitor.snapshot(), performanceMonitor.getSessionInfo());
  } catch {
    return buildPerformanceExportPayloadFromSnapshot(
      { enabled: performanceMonitor.isEnabled(), counters: {}, events: [] },
      performanceMonitor.getSessionInfo(),
    );
  }
}

export function buildPerformanceExportJson(options?: SafeStringifyOptions): string {
  return safeJsonStringify(buildPerformanceExportPayload(), { pretty: options?.pretty ?? true });
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function formatLocalTimestampForFilename(wallTimeMs: number): string {
  const date = new Date(wallTimeMs);
  const year = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  const hours = pad2(date.getHours());
  const minutes = pad2(date.getMinutes());
  const seconds = pad2(date.getSeconds());

  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

export function buildTraceFilename(sessionId: string, wallTimeMs: number = Date.now()): string {
  return `pocket-ai-trace-${sessionId}-${formatLocalTimestampForFilename(wallTimeMs)}.json`;
}

const LOGCAT_PREFIX_TRACE = 'POCKET_AI_PERF_TRACE ';
const LOGCAT_PREFIX_EVENT = 'POCKET_AI_PERF_EVENT ';
const LOGCAT_PREFIX_COUNTER = 'POCKET_AI_PERF_COUNTER ';
const LOGCAT_PREFIX_END = 'POCKET_AI_PERF_END ';

export type LogcatDumpLines = {
  lines: string[];
  estimatedPayloadBytes: number;
};

export function buildLogcatDumpLines(payload: PerformanceExportPayload): LogcatDumpLines {
  const countersEntries = Object.entries(payload.counters);
  const countersCount = countersEntries.length;

  const minimalHeader = {
    session: payload.session,
    enabled: payload.enabled,
    eventsCount: payload.events.length,
    countersCount,
  };

  const headerWithCounters = {
    ...minimalHeader,
    counters: payload.counters,
  };

  const headerJsonCandidate = safeJsonStringify(headerWithCounters);
  const includeCountersInHeader = headerJsonCandidate.length <= 3000;

  const headerJson = includeCountersInHeader ? headerJsonCandidate : safeJsonStringify(minimalHeader);

  const lines: string[] = [];
  lines.push(`${LOGCAT_PREFIX_TRACE}${headerJson}`);

  for (const event of payload.events) {
    lines.push(`${LOGCAT_PREFIX_EVENT}${safeJsonStringify(event)}`);
  }

  if (!includeCountersInHeader) {
    for (const [name, value] of countersEntries.sort(([left], [right]) => left.localeCompare(right))) {
      lines.push(`${LOGCAT_PREFIX_COUNTER}${safeJsonStringify({ name, value })}`);
    }
  }

  const payloadJson = safeJsonStringify(payload, { pretty: false });
  const estimatedPayloadBytes = getUtf8ByteLength(payloadJson);

  lines.push(
    `${LOGCAT_PREFIX_END}${safeJsonStringify({
      sessionId: payload.session.sessionId,
      eventsCount: payload.events.length,
      countersCount,
      estimatedPayloadBytes,
    })}`,
  );

  return { lines, estimatedPayloadBytes };
}

export type DumpTraceToLogcatResult =
  | { ok: true; estimatedPayloadBytes: number; lines: number }
  | { ok: false; reason: 'instrumentation_disabled' | 'unknown_error' };

export function dumpTraceToLogcat(): DumpTraceToLogcatResult {
  try {
    if (!performanceMonitor.isEnabled()) {
      return { ok: false, reason: 'instrumentation_disabled' };
    }

    const payload = buildPerformanceExportPayload();
    const dump = buildLogcatDumpLines(payload);

    for (const line of dump.lines) {
      try {
        console.log(line);
      } catch {
        // ignore (best-effort logging)
      }
    }

    return { ok: true, estimatedPayloadBytes: dump.estimatedPayloadBytes, lines: dump.lines.length };
  } catch {
    return { ok: false, reason: 'unknown_error' };
  }
}
