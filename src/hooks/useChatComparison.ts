import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { llmEngineService } from '../services/LLMEngineService';
import { beginChatGenerationWork, type ChatGenerationWorkHandle } from '../services/ChatGenerationService';
import { registry } from '../services/LocalStorageRegistry';
import { getPrivateStorageHealthSnapshot, isPrivateStorageWritable } from '../services/storage';
import { useChatStore } from '../store/chatStore';
import { getThreadActiveModelId, type ChatThread, type GenerationParamsSnapshot, type LlmChatCompletionOptions } from '../types/chat';
import { EngineStatus } from '../types/models';
import { getThreadInferenceWindow } from '../utils/inferenceWindow';
import { freezeGenerationParameters, getPreparedTemplateNow } from '../utils/generationControls';
import { resolveThreadGenerationParameters } from '../utils/chatThreadParameters';
import { isThreadLoraProfileReady } from '../utils/chatLoraProfile';
import { createIncrementalAssistantPresentationParser, getAssistantPresentation } from '../utils/chatPresentation';
import { applyAdvancedReasoningConfig, resolveModelReasoningCapability, resolveReasoningRuntimeConfig } from '../utils/modelReasoningCapabilities';
import { toAppError, type AppErrorCode } from '../services/AppError';
import type { ModelLoadParameters } from '../services/SettingsStore';

export type ComparisonState = 'admitting' | 'queued' | 'running' | 'cancelling' | 'completed' | 'cancelled' | 'error';
export type ComparisonVariant = {
  state: ComparisonState;
  content: string;
  thoughtContent: string;
  generation: GenerationParamsSnapshot;
  structuredOutput?: import('../utils/structuredOutput').StructuredOutputValidation;
};
export type ChatComparison = {
  running: boolean;
  variants: readonly [ComparisonVariant, ComparisonVariant];
  errorCode?: AppErrorCode;
};

export function isComparisonVariantSelectable(variant: ComparisonVariant): boolean {
  if (variant.state !== 'completed' || !variant.content.trim()) return false;
  const mode = variant.generation.output?.mode ?? 'text';
  if (mode === 'text') return true;
  const validation = variant.structuredOutput;
  return validation?.mode === mode && (validation.status === 'valid'
    || (mode === 'gbnf' && validation.status === 'not_applicable'));
}

/** Only the latest ordinary user turn is supported. No tool/media context is replayed. */
export function comparisonUnavailableReason(thread: ChatThread | null): 'noTurn' | 'textOnly' | null {
  if (!thread || !thread.messages.some(message => message.role === 'user')) return 'noTurn';
  if (thread.toolSettings?.enabled || thread.documentRetrieval?.mode === 'hybrid' || thread.documentRetrieval?.rerank
    || thread.messages.some(message => message.toolRun || (message.attachments?.length ?? 0) > 0
      || message.contentParts?.some(part => part.type !== 'text'))) return 'textOnly';
  return null;
}

function modelFileIdentity(modelId: string): string {
  const model = registry.getModel(modelId);
  return JSON.stringify([model?.localPath, model?.sha256, model?.size, model?.downloadIntegrity, model?.artifacts]);
}

type Owner = {
  abort: AbortController;
  thread: ChatThread;
  revision: number;
  modelId: string;
  fileIdentity: string;
  storageIdentity: number;
  work: ChatGenerationWorkHandle;
  running: boolean;
  closed: boolean;
  restoredContext?: string;
  loadProfileSnapshot?: ModelLoadParameters;
  variants: [ComparisonVariant, ComparisonVariant];
};

function snapshotCurrent(owner: Owner): boolean {
  const state = useChatStore.getState();
  return isPrivateStorageWritable()
    && getPrivateStorageHealthSnapshot().lastUpdatedAt === owner.storageIdentity
    && state.activeThreadId === owner.thread.id && state.threads[owner.thread.id] === owner.thread
    && state.inferenceRevision === owner.revision
    && modelFileIdentity(owner.modelId) === owner.fileIdentity;
}

function selectionCurrent(owner: Owner): boolean {
  return !owner.closed && !owner.abort.signal.aborted && snapshotCurrent(owner);
}

/** Ephemeral ownership only: comparison operations/results are never persisted or replayed. */
export function useChatComparison() {
  const [comparison, setComparison] = useState<ChatComparison | null>(null);
  const [isBusy, setBusy] = useState(false);
  const ownerRef = useRef<Owner | null>(null);
  const mounted = useRef(true);
  const streamTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const publish = useCallback((owner: Owner, errorCode?: AppErrorCode) => {
    if (mounted.current && ownerRef.current === owner && !owner.closed) {
      setComparison({ running: owner.running, variants: [{ ...owner.variants[0] }, { ...owner.variants[1] }], errorCode });
    }
  }, []);

  const close = useCallback(() => {
    const owner = ownerRef.current;
    if (!owner) return;
    owner.closed = true;
    owner.abort.abort();
    if (streamTimer.current !== null) clearTimeout(streamTimer.current);
    streamTimer.current = null;
    // Native drain continues to own generation/file resources after the panel closes.
    if (!owner.running) ownerRef.current = null;
    if (mounted.current) setComparison(null);
  }, []);

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = useChatStore.subscribe(() => {
      const owner = ownerRef.current;
      if (owner && !owner.closed && !selectionCurrent(owner)) close();
    });
    const appState = AppState.addEventListener('change', state => { if (state !== 'active') close(); });
    return () => { mounted.current = false; close(); unsubscribe(); appState.remove(); };
  }, [close]);

  const start = useCallback(async () => {
    if (ownerRef.current?.running) return;
    const state = useChatStore.getState();
    const thread = state.activeThreadId ? state.threads[state.activeThreadId] : null;
    if (!thread || comparisonUnavailableReason(thread) || !isPrivateStorageWritable()) return;
    const modelId = getThreadActiveModelId(thread);
    const engine = llmEngineService.getState();
    const originalLoadProfile = llmEngineService.getEffectiveLoadParameters();
    if (engine.status !== EngineStatus.READY || engine.activeModelId !== modelId
      || !isThreadLoraProfileReady(thread, originalLoadProfile)) return;
    const work = beginChatGenerationWork('chat_comparison');
    const base = resolveThreadGenerationParameters(thread);
    const maxTokens = Math.min(256, Math.max(1, base.maxTokens));
    const seed = base.seed === null ? 41 : Math.abs(base.seed) % 2147483646;
    const generations = [0, 1].map(index => ({
      ...base, maxTokens, seed: seed + index, temperature: index === 0 ? 0.3 : 0.8,
      thinkingBudgetTokens: Math.min(128, base.thinkingBudgetTokens ?? 128),
    }));
    const variant = (index: number): ComparisonVariant => ({ state: 'admitting', content: '', thoughtContent: '', generation: generations[index] });
    const owner: Owner = {
      abort: new AbortController(), thread, revision: state.inferenceRevision, modelId,
      fileIdentity: modelFileIdentity(modelId), storageIdentity: getPrivateStorageHealthSnapshot().lastUpdatedAt,
      work, running: true, closed: false, variants: [variant(0), variant(1)],
    };
    ownerRef.current = owner;
    setBusy(true);
    publish(owner);
    const removeCancel = work.onCancel(() => close());
    try {
      const lastUserIndex = thread.messages.findLastIndex(message => message.role === 'user');
      // Branch replacement clears its old summary; prepare that same history now.
      const promptThread = { ...thread, summary: undefined, messages: thread.messages.slice(0, lastUserIndex + 1) };
      const messages = getThreadInferenceWindow(promptThread, Number.MAX_SAFE_INTEGER).messages;
      const capability = resolveModelReasoningCapability(registry.getModel(modelId), modelId);
      const variants = generations.map(snapshot => {
        const generation = freezeGenerationParameters(snapshot, work.templateNowSeconds);
        const reasoning = applyAdvancedReasoningConfig(resolveReasoningRuntimeConfig({
          reasoningEffort: snapshot.reasoningEffort, capability, maxTokens,
        }), generation, maxTokens);
        // Retain the exact request-local clock in the chosen message's provenance.
        snapshot.template = { ...generation.template, now: getPreparedTemplateNow(generation) };
        return { generation, params: {
          temperature: snapshot.temperature, top_p: snapshot.topP, top_k: snapshot.topK,
          min_p: snapshot.minP, penalty_repeat: snapshot.repetitionPenalty,
          n_predict: reasoning.responseReserveTokens, seed: snapshot.seed ?? undefined,
          enable_thinking: reasoning.enableThinking, reasoning_format: reasoning.reasoningFormat,
          thinking_budget_tokens: reasoning.thinkingBudgetTokens,
        } };
      });
      const parsers = [createIncrementalAssistantPresentationParser(), createIncrementalAssistantPresentationParser()];
      const outcomes = await llmEngineService.compareChatCompletions({
        messages, expectedModelId: modelId, variants: [variants[0], variants[1]],
        // Cancellation stops publishing, but the unchanged selection still permits
        // restoring A after the temporary two-slot context has really drained.
        isCurrent: () => snapshotCurrent(owner), signal: owner.abort.signal,
        onState: (index, nextState) => {
          if (!owner.running || !selectionCurrent(owner)) return;
          const current = owner.variants[index];
          if (['completed', 'cancelled', 'error'].includes(current.state)) return;
          if (current.state === 'cancelling' && !['cancelled', 'error', 'completed'].includes(nextState)) return;
          current.state = nextState;
          publish(owner);
        },
        onToken: (index, token: Parameters<NonNullable<LlmChatCompletionOptions['onToken']>>[0]) => {
          if (!owner.running || !selectionCurrent(owner) || ['cancelling', 'cancelled', 'completed', 'error'].includes(owner.variants[index].state)) return;
          const parser = parsers[index];
          if (typeof token === 'string') parser.appendDelta(token);
          else {
            if (token.content !== undefined) {
              if (token.contentMode === 'cumulative') parser.applyCumulativeSnapshot(token.content);
              else parser.applySnapshot(token.content);
            } else if (token.reasoningContent === undefined) {
              if (token.accumulatedText !== undefined) parser.applyCumulativeSnapshot(token.accumulatedText);
              else parser.appendDelta(token.token);
            }
            if (token.reasoningContent !== undefined) {
              if (token.reasoningContentMode === 'delta') parser.appendExplicitReasoningDelta(token.reasoningContent);
              else if (token.reasoningContentMode === 'cumulative') parser.applyCumulativeExplicitReasoningSnapshot(token.reasoningContent);
              else parser.applyExplicitReasoningSnapshot(token.reasoningContent);
            }
          }
          const presentation = parser.getPresentation();
          owner.variants[index].content = presentation.finalContent;
          owner.variants[index].thoughtContent = presentation.thoughtContent;
          if (streamTimer.current === null) {
            streamTimer.current = setTimeout(() => { streamTimer.current = null; publish(owner); }, 80);
          }
        },
      });
      if (!selectionCurrent(owner)) { close(); return; }
      outcomes.forEach((outcome, index) => {
        const current = owner.variants[index];
        current.state = outcome.status === 'success' ? 'completed' : outcome.status === 'cancelled' ? 'cancelled' : 'error';
        if (outcome.status === 'success') {
          const result = outcome.result;
          const raw = result.content ?? result.text ?? result.accumulated_text;
          if (raw !== undefined) {
            const presentation = getAssistantPresentation(raw);
            current.content = result.structuredOutput ? raw : presentation.finalContent;
            current.thoughtContent = result.reasoning_content ?? presentation.thoughtContent;
          }
          current.structuredOutput = result.structuredOutput;
        }
      });
      const comparisonProfile = llmEngineService.getState().diagnostics?.comparison;
      if (originalLoadProfile && comparisonProfile) {
        // contextSize in persisted load provenance is the total native n_ctx.
        // The UI budget remains the independently reported per-request context.
        owner.loadProfileSnapshot = { ...originalLoadProfile,
          contextSize: comparisonProfile.totalContextTokens, parallelSlots: comparisonProfile.slots };
      }
      owner.restoredContext = llmEngineService.getPromptContextIdentity();
    } catch (error) {
      owner.variants.forEach(item => { if (!['completed', 'cancelled'].includes(item.state)) item.state = 'error'; });
      // A failed restore/admission cannot publish a selectable success from one slot.
      owner.restoredContext = undefined;
      owner.running = false;
      publish(owner, toAppError(error, 'action_failed').code);
      return;
    } finally {
      owner.running = false;
      if (streamTimer.current !== null) clearTimeout(streamTimer.current);
      streamTimer.current = null;
      removeCancel();
      work.finish();
      if (mounted.current) setBusy(false);
      if (owner.closed && ownerRef.current === owner) ownerRef.current = null;
    }
    publish(owner);
  }, [close, publish]);

  const stop = useCallback(async (index: 0 | 1) => {
    const owner = ownerRef.current;
    if (!owner?.running || !selectionCurrent(owner)
      || ['completed', 'cancelled', 'error', 'cancelling'].includes(owner.variants[index].state)) return;
    owner.variants[index].state = 'cancelling';
    publish(owner);
    try { await llmEngineService.stopComparisonVariant(index); }
    catch { publish(owner, 'action_failed'); }
  }, [publish]);

  const choose = useCallback((index: 0 | 1) => {
    const owner = ownerRef.current;
    const selected = owner?.variants[index];
    if (!owner || owner.running || !selected || !isComparisonVariantSelectable(selected)
      || !owner.restoredContext || !selectionCurrent(owner)
      || llmEngineService.getPromptContextIdentity() !== owner.restoredContext
      || llmEngineService.getState().activeModelId !== owner.modelId
      || llmEngineService.getState().status !== EngineStatus.READY
      || !isThreadLoraProfileReady(owner.thread, llmEngineService.getEffectiveLoadParameters())) return;
    const user = owner.thread.messages.findLast(message => message.role === 'user');
    if (!user) return;
    // Only the explicit choice enters the existing replacement/finalization transaction.
    // Mark closed before synchronous store subscriptions observe the replacement revision.
    owner.closed = true;
    let messageId: string | null = null;
    try {
      const store = useChatStore.getState();
      messageId = store.replaceBranchFromUserMessage(owner.thread.id, user.id, user.content);
      if (!messageId) { close(); return; }
      const result = store.finalizeAssistantTurn(owner.thread.id, messageId, {
        outcome: 'success', content: selected.content, thoughtContent: selected.thoughtContent,
        generationSnapshot: selected.generation, structuredOutput: selected.structuredOutput,
        loadProfileSnapshot: owner.loadProfileSnapshot,
      });
      if (result.status === 'persistence_failed') throw result.error;
      close();
    } catch {
      if (messageId) useChatStore.getState().finalizeAssistantTurn(owner.thread.id, messageId, { outcome: 'stopped', content: '', thoughtContent: '' });
      owner.closed = false;
      publish(owner, 'storage_private_unavailable');
    }
  }, [close, publish]);

  return { comparison, isBusy, start, stop, choose, close };
}
