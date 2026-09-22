import { runPromptDiagnostic } from '../../src/services/PromptDiagnosticsService';
import { llmEngineService } from '../../src/services/LLMEngineService';
import { DEFAULT_GENERATION_PARAMETERS } from '../../src/services/SettingsStore';
import { useChatStore } from '../../src/store/chatStore';
import { hasActiveChatGenerationWork } from '../../src/services/ChatGenerationService';
import { getPreparedTemplateNow } from '../../src/utils/generationControls';

jest.mock('../../src/services/LLMEngineService', () => ({ llmEngineService: {
  inspectTokens: jest.fn(), countPromptTokens: jest.fn().mockResolvedValue(12),
  prefillPrompt: jest.fn().mockResolvedValue({ text: '' }), getContextSize: () => 1024,
  hasActiveCompletion: () => true, stopCompletion: jest.fn().mockResolvedValue(undefined),
} }));

const input = { kind: 'prefill' as const, modelId: 'base', text: 'Unsent text', systemPrompt: 'System',
  generation: { ...DEFAULT_GENERATION_PARAMETERS, template: { prefillText: '{', kwargs: { locale: 'en' } } } };

describe('explicit prompt diagnostics', () => {
  beforeEach(() => jest.clearAllMocks());

  it('uses one frozen template for exact count and prefill, creating no chat or assistant', async () => {
    const before = useChatStore.getState();
    const result = await runPromptDiagnostic(input);
    expect(result).toMatchObject({ kind: 'prefill', tokenCount: 12 });
    const counted = jest.mocked(llmEngineService.countPromptTokens).mock.calls[0][0];
    const prefilled = jest.mocked(llmEngineService.prefillPrompt).mock.calls[0][0];
    expect(prefilled).toEqual(counted);
    expect(getPreparedTemplateNow(prefilled.generation ?? {})).toEqual(expect.any(Number));
    expect(useChatStore.getState().threads).toBe(before.threads);
    expect(hasActiveChatGenerationWork()).toBe(false);
  });

  it('holds cancellation until actual native settlement', async () => {
    let finish!: () => void;
    jest.mocked(llmEngineService.prefillPrompt).mockImplementationOnce(() => new Promise(resolve => {
      finish = () => resolve({ text: '' } as Awaited<ReturnType<typeof llmEngineService.prefillPrompt>>);
    }));
    const controller = new AbortController();
    const pending = runPromptDiagnostic({ ...input, signal: controller.signal });
    await Promise.resolve(); await Promise.resolve();
    controller.abort();
    expect(hasActiveChatGenerationWork()).toBe(true);
    expect(llmEngineService.stopCompletion).toHaveBeenCalled();
    finish();
    await expect(pending).rejects.toMatchObject({ code: 'action_failed' });
    expect(hasActiveChatGenerationWork()).toBe(false);
  });

  it('runs bounded tokenize/detokenize inspection without completion', async () => {
    jest.mocked(llmEngineService.inspectTokens).mockResolvedValueOnce({ tokenCount: 2, tokens: [1, 2], detokenized: 'text', truncated: false });
    expect(await runPromptDiagnostic({ ...input, kind: 'tokens' })).toMatchObject({ kind: 'tokens', tokenCount: 2 });
    expect(llmEngineService.prefillPrompt).not.toHaveBeenCalled();
  });
});
