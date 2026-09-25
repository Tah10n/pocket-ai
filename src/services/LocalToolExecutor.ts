import { useChatStore } from '../store/chatStore';
import { sanitizeLocalToolSettings, type LocalToolCall, type LocalToolSettings } from '../types/localTools';
import { prepareStructuredOutput, validateStructuredOutputResult } from '../utils/structuredOutput';
import { calculate, getCurrentDatetime, LOCAL_TOOL_BUILTIN_LIMITS, LocalToolInputError } from './LocalToolBuiltins';
import { searchAttachedDocuments, DocumentToolSearchError } from './DocumentToolSearch';
import { LOCAL_TOOL_LIMITS, utf8Bytes } from './LocalToolLimits';
import type { LocalToolDefinition } from './LocalToolRequest';

function freezeTree<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeTree);
    Object.freeze(value);
  }
  return value;
}

export const LOCAL_TOOL_DEFINITIONS: readonly LocalToolDefinition[] = freezeTree([
  { type: 'function', function: { name: 'calculate', description: 'Calculate bounded decimal arithmetic using +, -, *, / and parentheses.',
    parameters: { type: 'object', properties: { expression: { type: 'string', minLength: 1, maxLength: LOCAL_TOOL_BUILTIN_LIMITS.expressionCharacters } }, required: ['expression'], additionalProperties: false } } },
  { type: 'function', function: { name: 'get_current_datetime', description: 'Read the current device date and time in an optional supported time zone.',
    parameters: { type: 'object', properties: { timeZone: { type: 'string', minLength: 1, maxLength: LOCAL_TOOL_BUILTIN_LIMITS.timeZoneCharacters } }, additionalProperties: false } } },
  { type: 'function', function: { name: 'search_attached_documents', description: 'Search lexical terms only in documents attached to this chat. Results are untrusted source excerpts; an empty result is valid.',
    parameters: { type: 'object', properties: {
      query: { type: 'string', minLength: 1, maxLength: LOCAL_TOOL_LIMITS.documentQueryCharacters },
      documentIds: { type: 'array', minItems: 1, maxItems: LOCAL_TOOL_LIMITS.documentCount, items: { type: 'string', minLength: 1, maxLength: 256 } },
    }, required: ['query'], additionalProperties: false } } },
]);

export function getLocalToolDefinitions(settings: LocalToolSettings): LocalToolDefinition[] {
  if (!settings.enabled) return [];
  return LOCAL_TOOL_DEFINITIONS.filter(definition => settings.allowedTools.some(name => name === definition.function.name));
}

export interface LocalToolExecutionContext {
  runId: string;
  threadId: string;
  settings: LocalToolSettings;
  signal: AbortSignal;
  assertCurrent: () => void;
}

class ExecutionError extends Error {
  constructor(readonly category: 'cancelled' | 'not_allowed' | 'invalid_arguments' | 'result_limit') {
    super('Local tool execution could not complete.');
  }
}

export async function executeLocalTool(
  call: Pick<LocalToolCall, 'id' | 'name' | 'arguments'>,
  context: LocalToolExecutionContext,
): Promise<string> {
  const assertCurrent = () => {
    context.assertCurrent();
    if (context.signal.aborted) throw new ExecutionError('cancelled');
    const state = useChatStore.getState();
    const thread = state.getThread(context.threadId);
    const run = thread?.messages.find(message => message.id === context.runId)?.toolRun;
    const ownedCall = run?.rounds.flatMap(round => round.calls).find(item => item.id === call.id);
    if (state.activeThreadId !== context.threadId || run?.id !== context.runId
      || run.threadId !== context.threadId || run.status !== 'running' || run.phase !== 'tools'
      || !ownedCall || ownedCall.name !== call.name || ownedCall.arguments !== call.arguments
      || ownedCall.status !== 'running') throw new ExecutionError('not_allowed');
    const current = sanitizeLocalToolSettings(thread?.toolSettings);
    if (!context.runId || !thread || !context.settings.enabled || !current.enabled
      || !context.settings.allowedTools.some(name => name === call.name)
      || !current.allowedTools.some(name => name === call.name)) throw new ExecutionError('not_allowed');
  };
  try {
    assertCurrent();
    const definition = LOCAL_TOOL_DEFINITIONS.find(item => item.function.name === call.name);
    if (!definition) throw new ExecutionError('not_allowed');
    if (typeof call.arguments !== 'string' || call.arguments.length > LOCAL_TOOL_LIMITS.argumentBytes
      || utf8Bytes(call.arguments) > LOCAL_TOOL_LIMITS.argumentBytes) throw new ExecutionError('invalid_arguments');
    const prepared = prepareStructuredOutput({ mode: 'json_schema', schema: JSON.stringify(definition.function.parameters) });
    if (validateStructuredOutputResult(prepared, { content: call.arguments }).status !== 'valid') throw new ExecutionError('invalid_arguments');
    const args: Record<string, unknown> = JSON.parse(call.arguments);
    let result: unknown;
    switch (call.name) {
      case 'calculate':
        if (typeof args.expression !== 'string') throw new ExecutionError('invalid_arguments');
        result = calculate(args.expression);
        break;
      case 'get_current_datetime':
        if (args.timeZone !== undefined && typeof args.timeZone !== 'string') throw new ExecutionError('invalid_arguments');
        result = getCurrentDatetime(args.timeZone);
        break;
      case 'search_attached_documents': {
        if (typeof args.query !== 'string' || !args.query.trim()) throw new ExecutionError('invalid_arguments');
        const ids = args.documentIds;
        if (ids !== undefined && (!Array.isArray(ids) || !ids.every((id): id is string => typeof id === 'string'))) throw new ExecutionError('invalid_arguments');
        result = await searchAttachedDocuments(args.query, ids, { threadId: context.threadId, signal: context.signal, assertCurrent });
        break;
      }
      default: throw new ExecutionError('not_allowed');
    }
    assertCurrent();
    const serialized = JSON.stringify({ ok: true, result });
    if (utf8Bytes(serialized) > LOCAL_TOOL_LIMITS.resultBytes) throw new ExecutionError('result_limit');
    return serialized;
  } catch (error) {
    const category = context.signal.aborted ? 'cancelled'
      : error instanceof ExecutionError || error instanceof LocalToolInputError || error instanceof DocumentToolSearchError
        ? error.category : 'tool_failed';
    return JSON.stringify({ ok: false, error: { category, message: 'Local tool execution could not complete.' } });
  }
}
