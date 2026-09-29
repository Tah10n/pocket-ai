import { LOCAL_TOOL_LIMITS, utf8Bytes } from '../services/LocalToolLimits';
/** The sole durable representation of a local tool run. Native handles never belong here. */
export const LOCAL_TOOL_NAMES = ['calculate', 'get_current_datetime', 'search_attached_documents'] as const;
export type LocalToolName = typeof LOCAL_TOOL_NAMES[number];
export interface LocalToolSettings {
  enabled: boolean;
  allowedTools: LocalToolName[];
  toolChoice?: 'auto' | 'required';
}
export interface LocalToolCall {
  id: string;
  nativeId?: string | null;
  name: string;
  arguments: string;
  status: 'proposed' | 'running' | 'completed' | 'error' | 'cancelled';
  /** Bounded serialized tool data, never instructions. */
  result?: string;
}
export interface LocalToolRound {
  index: number;
  content: string;
  calls: LocalToolCall[];
}
export interface LocalToolRun {
  id: string;
  threadId: string;
  settings: LocalToolSettings;
  phase: 'tools' | 'final';
  status: 'running' | 'completed' | 'error' | 'cancelled' | 'interrupted';
  rounds: LocalToolRound[];
}
export interface LlmToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export function sanitizeLocalToolSettings(value: unknown): LocalToolSettings {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    enabled: record.enabled === true,
    allowedTools: LOCAL_TOOL_NAMES.filter(name => Array.isArray(record.allowedTools) && record.allowedTools.includes(name)),
    toolChoice: record.toolChoice === 'required' ? 'required' : 'auto',
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function bounded(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}

/** Fail closed on malformed history; hydration never resumes executor work. */
export function sanitizeLocalToolRun(value: unknown, interrupted = false): LocalToolRun | undefined {
  if (!record(value) || !bounded(value.id, 256) || !value.id || !bounded(value.threadId, 256)
    || !['tools', 'final'].includes(String(value.phase))
    || !['running', 'completed', 'error', 'cancelled', 'interrupted'].includes(String(value.status))
    || !Array.isArray(value.rounds) || value.rounds.length > LOCAL_TOOL_LIMITS.rounds) return undefined;
  const rounds: LocalToolRound[] = [];
  const ids = new Set<string>();
  let totalResultChars = 0;
  for (const round of value.rounds) {
    if (!record(round) || !Number.isSafeInteger(round.index) || Number(round.index) < 0
      || !bounded(round.content, 32768) || !Array.isArray(round.calls) || round.calls.length > LOCAL_TOOL_LIMITS.calls) return undefined;
    const calls: LocalToolCall[] = [];
    for (const call of round.calls) {
      if (!record(call) || !bounded(call.id, 256) || !call.id || ids.has(call.id)
        || !bounded(call.name, 128) || !bounded(call.arguments, LOCAL_TOOL_LIMITS.argumentBytes) || (typeof call.arguments === 'string' && utf8Bytes(call.arguments) > LOCAL_TOOL_LIMITS.argumentBytes)
        || !['proposed', 'running', 'completed', 'error', 'cancelled'].includes(String(call.status))
        || (call.nativeId !== undefined && call.nativeId !== null && !bounded(call.nativeId, 256))
        || (call.result !== undefined && (!bounded(call.result, LOCAL_TOOL_LIMITS.resultBytes) || utf8Bytes(String(call.result)) > LOCAL_TOOL_LIMITS.resultBytes))) return undefined;
      ids.add(call.id);
      totalResultChars += typeof call.result === 'string' ? utf8Bytes(call.result) : 0;
      if (ids.size > LOCAL_TOOL_LIMITS.calls || totalResultChars > LOCAL_TOOL_LIMITS.totalResultBytes) return undefined;
      calls.push({ id: call.id, name: call.name, arguments: call.arguments,
        status: interrupted && (call.status === 'running' || call.status === 'proposed') ? 'cancelled' : call.status as LocalToolCall['status'],
        ...(call.nativeId === null || typeof call.nativeId === 'string' ? { nativeId: call.nativeId } : {}),
        ...(typeof call.result === 'string' ? { result: call.result } : {}),
      });
    }
    rounds.push({ index: Number(round.index), content: round.content, calls });
  }
  return { id: value.id, threadId: value.threadId, settings: sanitizeLocalToolSettings(value.settings),
    phase: value.phase as LocalToolRun['phase'],
    status: interrupted && value.status === 'running' ? 'interrupted' : value.status as LocalToolRun['status'], rounds };
}
