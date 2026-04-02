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

function getUtf8ByteLengthFallback(text: string): number {
  let bytes = 0;

  for (let index = 0; index < text.length; index += 1) {
    const codeUnit = text.charCodeAt(index);

    if (codeUnit < 0x80) {
      bytes += 1;
      continue;
    }

    if (codeUnit < 0x800) {
      bytes += 2;
      continue;
    }

    // Surrogate pairs encode code points above U+FFFF as 4 bytes.
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = text.charCodeAt(index + 1);
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        bytes += 4;
        index += 1;
        continue;
      }

      // Malformed surrogate — treat as replacement character.
      bytes += 3;
      continue;
    }

    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      // Unpaired low surrogate.
      bytes += 3;
      continue;
    }

    bytes += 3;
  }

  return bytes;
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

  return getUtf8ByteLengthFallback(text);
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

// Android's logcat truncates very long messages (≈4KB), which can corrupt JSON dumps.
// Keep a conservative safety margin so each emitted log line stays parseable.
const LOGCAT_MAX_LINE_BYTES = 3000;

export type LogcatDumpLines = {
  lines: string[];
  estimatedPayloadBytes: number;
};

function isLogcatLineWithinLimit(prefix: string, json: string): boolean {
  return getUtf8ByteLength(`${prefix}${json}`) <= LOGCAT_MAX_LINE_BYTES;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  if (maxLength <= 1) {
    return '…';
  }

  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function buildEventJsonForLogcat(event: PerformanceEvent): string {
  const rawJson = safeJsonStringify(event);
  if (isLogcatLineWithinLimit(LOGCAT_PREFIX_EVENT, rawJson)) {
    return rawJson;
  }

  const minimalEvent: PerformanceEvent = {
    type: event.type,
    name: event.name,
    t: event.t,
    wallTime: event.wallTime,
    durationMs: event.durationMs,
    value: event.value,
    meta: event.meta ? { __truncated: true } : undefined,
  };

  let candidateJson = safeJsonStringify(minimalEvent);
  if (isLogcatLineWithinLimit(LOGCAT_PREFIX_EVENT, candidateJson)) {
    return candidateJson;
  }

  const baseName = minimalEvent.name ?? '';
  const targetLengths = [160, 120, 80, 40];

  for (const maxLength of targetLengths) {
    candidateJson = safeJsonStringify({ ...minimalEvent, name: truncateText(baseName, maxLength) });
    if (isLogcatLineWithinLimit(LOGCAT_PREFIX_EVENT, candidateJson)) {
      return candidateJson;
    }
  }

  return safeJsonStringify({
    type: event.type,
    name: 'truncated',
    t: event.t,
    wallTime: event.wallTime,
    meta: { __truncated: true },
  });
}

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
  const includeCountersInHeader = isLogcatLineWithinLimit(LOGCAT_PREFIX_TRACE, headerJsonCandidate);

  const headerJson = includeCountersInHeader ? headerJsonCandidate : safeJsonStringify(minimalHeader);

  const lines: string[] = [];
  lines.push(`${LOGCAT_PREFIX_TRACE}${headerJson}`);

  for (const event of payload.events) {
    lines.push(`${LOGCAT_PREFIX_EVENT}${buildEventJsonForLogcat(event)}`);
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
