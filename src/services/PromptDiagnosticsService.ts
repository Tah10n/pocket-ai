import type { GenerationParameters } from './SettingsStore';
import { freezeGenerationParameters } from '../utils/generationControls';
import { useChatStore } from '../store/chatStore';
import { AppError } from './AppError';
import { beginChatGenerationWork, registerActiveChatGenerationStop } from './ChatGenerationService';
import { llmEngineService } from './LLMEngineService';

/** Explicit, local diagnostics. Neither operation creates or mutates a chat message. */
export async function runPromptDiagnostic(input: {
  kind: 'prefill' | 'tokens'; modelId: string; text: string; systemPrompt: string;
  generation: GenerationParameters; signal?: AbortSignal;
}) {
  const inputLimit = input.kind === 'tokens' ? 16384 : 32768;
  if (!input.text || input.text.length > inputLimit) throw new AppError('action_failed', 'The diagnostic text is empty or exceeds its input limit.');
  const work = beginChatGenerationWork('prompt_diagnostic');
  const state = useChatStore.getState();
  const revision = state.inferenceRevision;
  const threadId = state.activeThreadId;
  let cancelled = input.signal?.aborted === true;
  const cancel = () => {
    cancelled = true;
    void llmEngineService.stopCompletion().catch(() => undefined);
  };
  input.signal?.addEventListener('abort', cancel, { once: true });
  const unregister = registerActiveChatGenerationStop({
    hasNativeCompletion: () => llmEngineService.hasActiveCompletion(),
    stop: async () => { cancelled = true; await llmEngineService.stopCompletion(); },
  });
  const assertCurrent = () => {
    work.assertCurrent();
    const current = useChatStore.getState();
    if (cancelled || current.activeThreadId !== threadId || current.inferenceRevision !== revision) {
      throw new AppError('action_failed', 'The diagnostic was cancelled.');
    }
  };
  try {
    assertCurrent();
    if (input.kind === 'tokens') {
      const result = await llmEngineService.inspectTokens(input.text, input.modelId);
      assertCurrent();
      return { kind: 'tokens' as const, ...result };
    }
    const generation = freezeGenerationParameters(input.generation, work.templateNowSeconds);
    const messages = [{ role: 'system' as const, content: input.systemPrompt }, { role: 'user' as const, content: input.text }];
    const params = { enable_thinking: false, reasoning_format: 'none' as const };
    const tokenCount = await llmEngineService.countPromptTokens({ messages, generation, params, expectedModelId: input.modelId });
    assertCurrent();
    if (tokenCount >= llmEngineService.getContextSize()) throw new AppError('message_too_long', 'The diagnostic prompt exceeds the loaded context.');
    const start = Date.now();
    // Await actual native settlement even after cancellation: a stop request is not completion.
    await llmEngineService.prefillPrompt({ messages, generation, params, expectedModelId: input.modelId });
    assertCurrent();
    return { kind: 'prefill' as const, tokenCount, durationMs: Date.now() - start };
  } catch (error) {
    if (error instanceof AppError) throw error;
    // Formatter/native errors can contain private text. Do not propagate their cause.
    throw new AppError('action_failed', 'The prompt diagnostic could not complete. Check its template and output settings.');
  } finally {
    input.signal?.removeEventListener('abort', cancel);
    unregister();
    work.finish();
  }
}
