import { freezeGenerationParameters } from '../utils/generationControls';
import { useChatStore } from '../store/chatStore';
import type { LlmChatCompletionOptions, LlmChatMessage } from '../types/chat';
import type { LocalToolRun, LocalToolSettings } from '../types/localTools';
import { sanitizeLocalToolSettings } from '../types/localTools';
import { llmEngineService } from './LLMEngineService';
import type { LlamaCompletionResult } from './LlamaRuntimeAdapter';
import { executeLocalTool, getLocalToolDefinitions } from './LocalToolExecutor';
import { LOCAL_TOOL_LIMITS, utf8Bytes } from './LocalToolLimits';
import type { LocalToolRequest } from './LocalToolRequest';
import { AppError, LOCAL_TOOL_RUN_ERROR_CODES, type LocalToolRunErrorReason } from './AppError';
import { prepareStructuredOutput, validateStructuredOutputResult } from '../utils/structuredOutput';

export type LocalToolTerminalOutcome =
  | { status: 'completed' }
  | { status: 'stopped'; reason: 'cancelled' | 'interrupted' | 'token_limit' | 'context_limit' | 'truncated' }
  | { status: 'error'; reason: 'timeout' | 'invalid_output' };
export type LocalToolCompletionResult = LlamaCompletionResult & {
  content: string; text: string; localToolOutcome: LocalToolTerminalOutcome;
};

export class LocalToolRunError extends AppError {
  constructor(readonly reason: LocalToolRunErrorReason) {
    super(LOCAL_TOOL_RUN_ERROR_CODES[reason], 'Local tool run could not complete.');
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
export async function runLocalToolCompletion({ options, threadId, runId, settings, assertCurrent, assertSelectionCurrent, assertRestorationSelectionCurrent, assertCanPublish, onProgress, onNativeStep, onNativeStage }: {
  options: LlmChatCompletionOptions;
  threadId: string;
  runId: string;
  settings: LocalToolSettings;
  assertCurrent: () => void;
  /** The same generation/chat/permissions, independent of the suspended native context. */
  assertSelectionCurrent?: () => void;
  /** Stable chat/permission ownership for restoring A after Stop, never action admission. */
  assertRestorationSelectionCurrent?: () => void;
  /** Identity/permissions ownership check that deliberately excludes user Stop. */
  assertCanPublish?: () => void;
  onProgress: (run: LocalToolRun) => void;
  /** Read-only QA boundary observer; only a finite stage name is exposed. */
  onNativeStage?: (stage: 'count_prompt' | 'completion' | 'first_token') => void;
  /** Read-only QA observer; payloads must not be logged or included in receipts. */
  onNativeStep?: (step: { phase: LocalToolRequest['phase']; promptTokens: number;
    messages: readonly LlmChatMessage[]; result: LlamaCompletionResult }) => void;
}): Promise<LocalToolCompletionResult> {
  const captured = sanitizeLocalToolSettings(settings);
  if (!captured.enabled || !captured.allowedTools.length || !options.expectedModelId) {
    throw new LocalToolRunError('invalid_proposal');
  }
  // Counting, selection and final dispatch share one template-time snapshot.
  const generation = freezeGenerationParameters(options.generation);
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
  const checkSelection = () => {
    if (timedOut || Date.now() - startedAt >= LOCAL_TOOL_LIMITS.runMilliseconds) throw new LocalToolRunError('timeout');
    if (controller.signal.aborted) throw new LocalToolRunError('cancelled');
    lease.assertSelectionCurrent();
    (assertSelectionCurrent ?? assertCurrent)();
  };
  const check = () => { checkSelection(); lease.assertCurrent(); assertCurrent(); };
  const checkRestorationSelection = () => {
    lease.assertRestorationSelectionCurrent();
    (assertRestorationSelectionCurrent ?? assertSelectionCurrent ?? assertCurrent)();
  };
  const checkPublication = () => {
    lease.assertCanPublish();
    (assertCanPublish ?? assertCurrent)();
  };
  const incompleteOutcome = (result: LlamaCompletionResult): LocalToolTerminalOutcome | undefined => {
    if (timedOut || Date.now() - startedAt >= LOCAL_TOOL_LIMITS.runMilliseconds) return { status: 'error', reason: 'timeout' };
    if (controller.signal.aborted || lease.signal.aborted) return { status: 'stopped', reason: 'cancelled' };
    if (result.interrupted) return { status: 'stopped', reason: 'interrupted' };
    if (result.truncated) return { status: 'stopped', reason: 'truncated' };
    if (result.context_full) return { status: 'stopped', reason: 'context_limit' };
    if (result.stopped_limit) return { status: 'stopped', reason: 'token_limit' };
    if (result.structuredOutput?.status === 'incomplete') return { status: 'stopped', reason: 'interrupted' };
    return undefined;
  };
  const stopForTimeout = () => {
    timedOut = true;
    controller.abort();
    void llmEngineService.interruptActiveCompletion().catch(() => undefined);
  };
  const timer = setTimeout(stopForTimeout, LOCAL_TOOL_LIMITS.runMilliseconds);
  const unsubscribe = useChatStore.subscribe(() => {
    // B/C can temporarily suspend A. Keep checking the same chat, permissions,
    // cancellation and lease; native dispatch still uses the full epoch check.
    try { checkSelection(); } catch {
      controller.abort();
      void llmEngineService.interruptActiveCompletion().catch(() => undefined);
    }
  });
  const complete = async (request: LocalToolRequest): Promise<LlamaCompletionResult> => {
    check();
    if (remainingTokens <= 0) throw new LocalToolRunError('token_limit');
    onNativeStage?.('count_prompt');
    const count = await llmEngineService.countPromptTokens({
      messages, generation, toolRequest: request, runOwner: lease.token,
      expectedModelId: options.expectedModelId, multimodalReadiness: options.multimodalReadiness,
      params: options.params,
    });
    check();
    if (!Number.isSafeInteger(count) || count < 0) throw new LocalToolRunError('context_limit');
    totalTokens += count;
    if (totalTokens >= LOCAL_TOOL_LIMITS.totalTokens) throw new LocalToolRunError('token_limit');
    const available = Math.min(llmEngineService.getContextSize() - count - 16, LOCAL_TOOL_LIMITS.totalTokens - totalTokens);
    if (available < 1) throw new LocalToolRunError('context_limit');
    onNativeStage?.('completion');
    let firstTokenObserved = false;
    const onToken: LlmChatCompletionOptions['onToken'] = onNativeStage || (request.phase === 'final' && options.onToken)
      ? token => {
          try { checkPublication(); } catch { return; }
          if (!firstTokenObserved && (typeof token === 'string' ? token.length > 0
            : Boolean(token.token || token.content !== undefined || token.reasoningContent !== undefined))) {
            firstTokenObserved = true;
            onNativeStage?.('first_token');
          }
          if (request.phase !== 'final' || typeof token === 'string'
            || (token.content === undefined && token.reasoningContent === undefined)) return;
          // Final callbacks may publish native parsed fields only. Raw tokens and
          // accumulated protocol are never a fallback for a partial tool reply.
          options.onToken?.({ token: '',
            ...(token.content !== undefined ? { content: token.content, contentMode: token.contentMode } : {}),
            ...(token.reasoningContent !== undefined ? {
              reasoningContent: token.reasoningContent, reasoningContentMode: token.reasoningContentMode,
            } : {}),
          });
        } : undefined;
    const result = await llmEngineService.chatCompletion({ ...options, messages, generation,
      toolRequest: request, runOwner: lease.token,
      // Intermediate parser output is only a proposal. Never display raw tokens
      // or a generic protocol envelope as user text while it is still partial.
      onToken,
      params: { ...options.params, n_predict: Math.min(remainingTokens, available) },
    });
    // The actual native completion has settled. Ownership is independent of
    // action admission: Stop can retain parsed user content but cannot execute.
    checkPublication();
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
  const finishReply = (result: LlamaCompletionResult): LocalToolCompletionResult => {
    checkPublication();
    const content = result.content ?? '';
    let outcome = incompleteOutcome(result);
    let final = { ...result, content, text: content };
    delete final.accumulated_text;
    if (generation.output && generation.output.mode !== 'text') {
      const output = prepareStructuredOutput(generation.output);
      final.structuredOutput = outcome
        ? { mode: output.mode, status: 'incomplete', error: 'interrupted' }
        : validateStructuredOutputResult(output, { content,
          interrupted: result.interrupted, stoppedLimit: result.stopped_limit,
          truncated: result.truncated, contextFull: result.context_full });
    }
    if (!outcome && final.structuredOutput?.status === 'invalid') outcome = { status: 'error', reason: 'invalid_output' };
    if (!outcome && !content.trim() && !final.reasoning_content?.trim()) throw new LocalToolRunError('invalid_proposal');
    const localToolOutcome: LocalToolTerminalOutcome = outcome ?? { status: 'completed' };
    run.status = localToolOutcome.status === 'completed' ? 'completed'
      : localToolOutcome.status === 'error' ? 'error'
        : localToolOutcome.reason === 'cancelled' ? 'cancelled' : 'interrupted';
    snapshot();
    return { ...final, localToolOutcome };
  };
  try {
    snapshot();
    for (;;) {
      const result = await complete(createLocalToolRequest(captured, run.rounds.length === 0));
      const proposals = result.tool_calls ?? [];
      if (!proposals.length) {
        // A no-call settlement may contain an ordinary partial reply. Preserve
        // parsed content before considering another constrained final dispatch.
        if (incompleteOutcome(result)) return finishReply(result);
        if (run.rounds.length === 0 && captured.toolChoice === 'required') throw new LocalToolRunError('invalid_proposal');
        let final = result;
        // Selection suppresses content prefill so it cannot corrupt tool parsing.
        // Restore it only in a final phase where new tools cannot execute.
        const needsFinalPhase = (generation.output && generation.output.mode !== 'text')
          || (generation.template?.prefillText?.length ?? 0) > 0;
        if (needsFinalPhase) {
          run.phase = 'final';
          snapshot();
          final = await complete({ phase: 'final', tools: getLocalToolDefinitions(captured), toolChoice: 'none', parallelToolCalls: false });
          if (final.tool_calls?.length) {
            throw new LocalToolRunError('invalid_proposal');
          }
        }
        // Only bridge-parsed content is displayable on the tool parser path.
        // Ordinary assistant JSON is never interpreted as an action.
        return finishReply(final);
      }
      // Incomplete actions have no execution authority, even if their JSON
      // arguments already parse. Cancellation also prevents any next action.
      check();
      if (incompleteOutcome(result)) throw new LocalToolRunError('invalid_proposal');
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
            signal: controller.signal, runOwner: lease.token,
            assertCurrent: check, assertSelectionCurrent: checkSelection,
            assertRestorationSelectionCurrent: checkRestorationSelection });
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
    try { checkPublication(); snapshot(); } catch { /* A stale owner cannot publish terminal tool progress. */ }
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
