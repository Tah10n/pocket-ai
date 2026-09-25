import { useChatStore } from '../store/chatStore';
import type { LlmChatCompletionOptions, LlmChatMessage } from '../types/chat';
import type { LocalToolRun, LocalToolSettings } from '../types/localTools';
import { sanitizeLocalToolSettings } from '../types/localTools';
import { llmEngineService } from './LLMEngineService';
import type { LlamaCompletionResult } from './LlamaRuntimeAdapter';
import { executeLocalTool, getLocalToolDefinitions } from './LocalToolExecutor';
import { LOCAL_TOOL_LIMITS, utf8Bytes } from './LocalToolLimits';
import type { LocalToolRequest } from './LocalToolRequest';
import { AppError } from './AppError';

export class LocalToolRunError extends AppError {
  constructor(readonly reason: 'cancelled' | 'timeout' | 'round_limit' | 'call_limit' | 'token_limit'
    | 'result_limit' | 'invalid_proposal' | 'duplicate_id' | 'conflicting_id' | 'context_limit') {
    super('action_failed', `Local tool run ended (${reason}).`);
    this.name = 'LocalToolRunError';
  }
}

export function createLocalToolRequest(settings: LocalToolSettings, first = true): LocalToolRequest {
  return {
    phase: 'tools', tools: getLocalToolDefinitions(settings),
    toolChoice: first && settings.toolChoice === 'required' ? 'required' : 'auto',
    parallelToolCalls: false,
  };
}

let processLocalToolRunStarts = 0;
/** Aggregate process-local QA receipt; no arguments or results are retained. */
export const getLocalToolRunStartCount = () => processLocalToolRunStarts;

/** One bounded extension of the existing engine, with no alternative native context. */
export async function runLocalToolCompletion({ options, threadId, runId, settings, assertCurrent, onProgress, onNativeStep }: {
  options: LlmChatCompletionOptions;
  threadId: string;
  runId: string;
  settings: LocalToolSettings;
  assertCurrent: () => void;
  onProgress: (run: LocalToolRun) => void;
  /** Read-only QA observer; payloads must not be logged or included in receipts. */
  onNativeStep?: (step: { phase: LocalToolRequest['phase']; promptTokens: number;
    messages: readonly LlmChatMessage[]; result: LlamaCompletionResult }) => void;
}): Promise<LlamaCompletionResult> {
  const captured = sanitizeLocalToolSettings(settings);
  if (!captured.enabled || !captured.allowedTools.length || !options.expectedModelId) {
    throw new LocalToolRunError('invalid_proposal');
  }
  processLocalToolRunStarts += 1;
  assertCurrent();
  const lease = llmEngineService.beginLocalToolRun(options.expectedModelId);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  lease.signal.addEventListener('abort', cancel, { once: true });
  const run: LocalToolRun = { id: runId, threadId, settings: captured, phase: 'tools', status: 'running', rounds: [] };
  const startedAt = Date.now();
  let timedOut = false;
  let resultBytes = 0;
  let remainingTokens = Math.min(LOCAL_TOOL_LIMITS.predictedTokens, options.params?.n_predict ?? 512);
  let calls = 0;
  let totalTokens = 0;
  const seen = new Map<string, string>();
  const messages: LlmChatMessage[] = [...options.messages];
  const snapshot = () => onProgress({ ...run, settings: { ...captured, allowedTools: [...captured.allowedTools] },
    rounds: run.rounds.map(round => ({ ...round, calls: round.calls.map(call => ({ ...call })) })) });
  const check = () => {
    if (timedOut || Date.now() - startedAt >= LOCAL_TOOL_LIMITS.runMilliseconds) throw new LocalToolRunError('timeout');
    if (controller.signal.aborted) throw new LocalToolRunError('cancelled');
    lease.assertCurrent();
    assertCurrent();
  };
  const stopForTimeout = () => {
    timedOut = true;
    controller.abort();
    void llmEngineService.interruptActiveCompletion().catch(() => undefined);
  };
  const timer = setTimeout(stopForTimeout, LOCAL_TOOL_LIMITS.runMilliseconds);
  const unsubscribe = useChatStore.subscribe(() => {
    try { check(); } catch {
      controller.abort();
      void llmEngineService.interruptActiveCompletion().catch(() => undefined);
    }
  });
  const complete = async (request: LocalToolRequest): Promise<LlamaCompletionResult> => {
    check();
    if (remainingTokens <= 0) throw new LocalToolRunError('token_limit');
    const count = await llmEngineService.countPromptTokens({
      messages, generation: options.generation, toolRequest: request, runOwner: lease.token,
      expectedModelId: options.expectedModelId, multimodalReadiness: options.multimodalReadiness,
      params: options.params,
    });
    check();
    if (!Number.isSafeInteger(count) || count < 0) throw new LocalToolRunError('context_limit');
    totalTokens += count;
    if (totalTokens >= LOCAL_TOOL_LIMITS.totalTokens) throw new LocalToolRunError('token_limit');
    const available = Math.min(llmEngineService.getContextSize() - count - 16, LOCAL_TOOL_LIMITS.totalTokens - totalTokens);
    if (available < 1) throw new LocalToolRunError('context_limit');
    const result = await llmEngineService.chatCompletion({ ...options, messages,
      toolRequest: request, runOwner: lease.token,
      // Intermediate parser output is only a proposal. Never display raw tokens
      // or a generic protocol envelope as user text while it is still partial.
      onToken: request.phase === 'final' ? options.onToken : undefined,
      params: { ...options.params, n_predict: Math.min(remainingTokens, available) },
    });
    check();
    // rc.3 excludes the first output token in its predicted counter.
    const predicted = result.tokens_predicted;
    if (typeof predicted !== 'number' || !Number.isFinite(predicted) || predicted < 0) {
      throw new LocalToolRunError('invalid_proposal');
    }
    const consumed = Math.max(1, Math.ceil(predicted) + 1);
    remainingTokens -= consumed;
    totalTokens += consumed;
    onNativeStep?.({ phase: request.phase, promptTokens: count, messages: [...messages], result });
    return result;
  };
  try {
    snapshot();
    for (;;) {
      const result = await complete(createLocalToolRequest(captured, run.rounds.length === 0));
      const proposals = result.tool_calls ?? [];
      if (result.interrupted || result.truncated || result.context_full || result.stopped_limit) {
        throw new LocalToolRunError('invalid_proposal');
      }
      if (!proposals.length) {
        if (run.rounds.length === 0 && captured.toolChoice === 'required') throw new LocalToolRunError('invalid_proposal');
        let final = result;
        // Selection suppresses content prefill so it cannot corrupt tool parsing.
        // Restore it only in a final phase where new tools cannot execute.
        const needsFinalPhase = (options.generation?.output && options.generation.output.mode !== 'text')
          || (options.generation?.template?.prefillText?.length ?? 0) > 0;
        if (needsFinalPhase) {
          run.phase = 'final';
          snapshot();
          final = await complete({ phase: 'final', tools: getLocalToolDefinitions(captured), toolChoice: 'none', parallelToolCalls: false });
          if (final.tool_calls?.length || final.interrupted || final.truncated || final.context_full || final.stopped_limit) {
            throw new LocalToolRunError('invalid_proposal');
          }
        }
        // Only bridge-parsed content is displayable on the tool parser path.
        // Ordinary assistant JSON is never interpreted as an action.
        if (!options.generation?.output || options.generation.output.mode === 'text') {
          if (!final.content?.trim() && !final.reasoning_content?.trim()) throw new LocalToolRunError('invalid_proposal');
          final = { ...final, content: final.content ?? '', text: final.content ?? '' };
        }
        run.status = final.structuredOutput?.status === 'invalid' ? 'error'
          : final.structuredOutput?.status === 'incomplete' ? 'interrupted' : 'completed';
        check();
        snapshot();
        return final;
      }
      if (run.rounds.length >= LOCAL_TOOL_LIMITS.rounds) throw new LocalToolRunError('round_limit');
      if (calls + proposals.length > LOCAL_TOOL_LIMITS.calls) throw new LocalToolRunError('call_limit');
      const round = { index: run.rounds.length, content: result.content ?? '', calls: proposals.map((proposal, index) => {
        const id = proposal.id || `${runId}:r${run.rounds.length}:c${index}`;
        const name = proposal.function.name;
        const args = proposal.function.arguments;
        if (id.length > 256 || name.length > 128 || utf8Bytes(args) > LOCAL_TOOL_LIMITS.argumentBytes) {
          throw new LocalToolRunError('invalid_proposal');
        }
        const identity = JSON.stringify([name, args]);
        if (seen.has(id)) throw new LocalToolRunError(seen.get(id) === identity ? 'duplicate_id' : 'conflicting_id');
        seen.set(id, identity);
        return { id, nativeId: proposal.id, name, arguments: args, status: 'proposed' as const };
      }) };
      run.rounds.push(round);
      snapshot();
      for (const call of run.rounds[run.rounds.length - 1].calls) {
        check();
        calls += 1;
        call.status = 'running';
        snapshot();
        let toolTimedOut = false;
        const toolTimer = setTimeout(() => { toolTimedOut = true; controller.abort(); }, LOCAL_TOOL_LIMITS.toolMilliseconds);
        let output: string;
        try {
          // Await the actual operation even on timeout. Cancellation cannot free
          // ownership while an AnyDoc read/release is still in flight.
          output = await executeLocalTool(call, { runId, threadId, settings: captured,
            signal: controller.signal, assertCurrent: check });
        } finally { clearTimeout(toolTimer); }
        if (toolTimedOut) throw new LocalToolRunError('timeout');
        check();
        const bytes = utf8Bytes(output);
        if (bytes > LOCAL_TOOL_LIMITS.resultBytes || resultBytes + bytes > LOCAL_TOOL_LIMITS.totalResultBytes) {
          throw new LocalToolRunError('result_limit');
        }
        resultBytes += bytes;
        call.result = output;
        call.status = output.startsWith('{"ok":false,') ? 'error' : 'completed';
        snapshot();
      }
      const answered = run.rounds[run.rounds.length - 1];
      messages.push({ role: 'assistant', content: answered.content,
        tool_calls: answered.calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) });
      answered.calls.forEach(call => messages.push({ role: 'tool', tool_call_id: call.id, content: call.result ?? '' }));
    }
  } catch (error) {
    run.status = controller.signal.aborted || lease.signal.aborted ? 'cancelled' : 'error';
    run.rounds.forEach(round => round.calls.forEach(call => {
      if (call.status === 'running' || call.status === 'proposed') call.status = 'cancelled';
    }));
    // This callback may only update the still-owned assistant; the caller rejects
    // late publication after chat, settings, storage or document invalidation.
    snapshot();
    throw error;
  } finally {
    clearTimeout(timer);
    unsubscribe();
    lease.signal.removeEventListener('abort', cancel);
    try {
      if (controller.signal.aborted || lease.signal.aborted) await llmEngineService.interruptActiveCompletion();
    } finally { lease.finish(); }
  }
}
