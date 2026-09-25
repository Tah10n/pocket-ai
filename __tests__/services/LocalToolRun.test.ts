import { runLocalToolCompletion } from '../../src/services/LocalToolRun';
import { llmEngineService } from '../../src/services/LLMEngineService';
import { executeLocalTool } from '../../src/services/LocalToolExecutor';
import type { LocalToolRun, LocalToolSettings } from '../../src/types/localTools';
import type { LlamaCompletionResult } from '../../src/services/LlamaRuntimeAdapter';
import type { LlmChatCompletionOptions } from '../../src/types/chat';

jest.mock('../../src/services/LLMEngineService', () => ({ llmEngineService: {
  beginLocalToolRun: jest.fn(), countPromptTokens: jest.fn(), getContextSize: jest.fn(),
  chatCompletion: jest.fn(), interruptActiveCompletion: jest.fn(),
} }));
jest.mock('../../src/services/LocalToolExecutor', () => ({
  executeLocalTool: jest.fn(), getLocalToolDefinitions: () => [{ type: 'function', function: {
    name: 'calculate', description: 'Calculate', parameters: { type: 'object' },
  } }],
}));
const mockListeners = new Set<() => void>();
jest.mock('../../src/store/chatStore', () => ({ useChatStore: { subscribe: (listener: () => void) => {
  mockListeners.add(listener); return () => mockListeners.delete(listener);
} } }));
const settings: LocalToolSettings = { enabled: true, allowedTools: ['calculate'], toolChoice: 'auto' };
const options: LlmChatCompletionOptions = { expectedModelId: 'model', messages: [{ role: 'user', content: 'Calculate' }], params: { n_predict: 512 } };
const completion = jest.mocked(llmEngineService.chatCompletion);
const executor = jest.mocked(executeLocalTool);
let controller: AbortController;
let finish: jest.Mock;
let progress: LocalToolRun[];
let current: jest.Mock;
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const answer = (content = '42'): LlamaCompletionResult => ({ content, text: content, tokens_predicted: 3, stopped_eos: true });
const proposal = (id: string | null = 'call', args = '{"expression":"6*7"}'): LlamaCompletionResult => ({
  content: '', tokens_predicted: 12, stopped_eos: true,
  tool_calls: [{ id, type: 'function', function: { name: 'calculate', arguments: args } }],
});
const run = (extra: Partial<Parameters<typeof runLocalToolCompletion>[0]> = {}) => runLocalToolCompletion({
  options, settings, threadId: 'thread', runId: 'assistant', assertCurrent: current,
  onProgress: value => progress.push(value), ...extra,
});
beforeEach(() => {
  jest.clearAllMocks(); mockListeners.clear(); controller = new AbortController(); finish = jest.fn(); progress = []; current = jest.fn();
  jest.mocked(llmEngineService.beginLocalToolRun).mockReturnValue({ token: Symbol('owner'), signal: controller.signal, finish,
    assertCurrent: () => { if (controller.signal.aborted) throw new Error('cancelled'); } });
  jest.mocked(llmEngineService.countPromptTokens).mockResolvedValue(100);
  jest.mocked(llmEngineService.getContextSize).mockReturnValue(8192);
  jest.mocked(llmEngineService.interruptActiveCompletion).mockResolvedValue();
  executor.mockResolvedValue('{"ok":true,"result":{"value":42}}');
});
afterEach(() => { jest.useRealTimers(); });

test('real boundary sequence passes assistant call and exact result to next completion', async () => {
  completion.mockResolvedValueOnce(proposal()).mockResolvedValueOnce(answer());
  expect((await run()).content).toBe('42');
  expect(executor).toHaveBeenCalledTimes(1);
  const next = completion.mock.calls[1][0];
  expect(next.messages.slice(-2)).toEqual([
    { role: 'assistant', content: '', tool_calls: [{ id: 'call', type: 'function', function: { name: 'calculate', arguments: '{"expression":"6*7"}' } }] },
    { role: 'tool', tool_call_id: 'call', content: '{"ok":true,"result":{"value":42}}' },
  ]);
  expect(next.runOwner).toBeDefined();
  expect(progress.at(-1)?.status).toBe('completed'); expect(finish).toHaveBeenCalledTimes(1);
});

test('proposals are never executed before native settlement and no raw streaming callback is exposed', async () => {
  const native = deferred<LlamaCompletionResult>(); completion.mockReturnValueOnce(native.promise).mockResolvedValueOnce(answer());
  const pending = run(); await Promise.resolve(); await Promise.resolve();
  expect(executor).not.toHaveBeenCalled(); expect(completion.mock.calls[0][0].onToken).toBeUndefined();
  native.resolve(proposal()); await pending; expect(executor).toHaveBeenCalledTimes(1);
});

test.each(['interrupted', 'truncated', 'context_full', 'stopped_limit'] as const)('rejects %s proposals without execution', async flag => {
  completion.mockResolvedValue({ ...proposal(), [flag]: true });
  await expect(run()).rejects.toMatchObject({ reason: 'invalid_proposal' }); expect(executor).not.toHaveBeenCalled();
});

test('two different calls with equal JSON execute sequentially', async () => {
  const first = deferred<string>(); executor.mockReturnValueOnce(first.promise);
  const multi = proposal(); multi.tool_calls!.push({ ...proposal('second').tool_calls![0] });
  completion.mockResolvedValueOnce(multi).mockResolvedValueOnce(answer());
  const pending = run(); for (let i = 0; i < 8; i++) await Promise.resolve();
  expect(executor).toHaveBeenCalledTimes(1); first.resolve('{"ok":true,"result":42}'); await pending;
  expect(executor).toHaveBeenCalledTimes(2); expect(progress.at(-1)?.rounds[0].calls).toHaveLength(2);
});

test('normalizes null native IDs deterministically and links results', async () => {
  completion.mockResolvedValueOnce(proposal(null)).mockResolvedValueOnce(answer()); await run();
  expect(progress.at(-1)?.rounds[0].calls[0]).toMatchObject({ id: 'assistant:r0:c0', nativeId: null });
  expect(completion.mock.calls[1][0].messages.at(-1)?.tool_call_id).toBe('assistant:r0:c0');
});

test.each([['{"expression":"6*7"}', 'duplicate_id'], ['{"expression":"1+1"}', 'conflicting_id']])('rejects repeated ID %s', async (args, reason) => {
  completion.mockResolvedValueOnce(proposal()).mockResolvedValueOnce(proposal('call', args));
  await expect(run()).rejects.toMatchObject({ reason }); expect(executor).toHaveBeenCalledTimes(1);
});

test('round cap cannot create an unbounded repair loop', async () => {
  for (let i = 0; i < 5; i++) completion.mockResolvedValueOnce(proposal(`call${i}`));
  await expect(run()).rejects.toMatchObject({ reason: 'round_limit' }); expect(executor).toHaveBeenCalledTimes(4);
});

test('rejects over-limit batch before executing any member', async () => {
  const multi = proposal(); multi.tool_calls = Array.from({ length: 9 }, (_, i) => proposal(`id${i}`).tool_calls![0]);
  completion.mockResolvedValueOnce(multi); await expect(run()).rejects.toMatchObject({ reason: 'call_limit' });
  expect(executor).not.toHaveBeenCalled();
});

test('shared prediction budget prevents another native dispatch', async () => {
  completion.mockResolvedValueOnce({ ...proposal(), tokens_predicted: 511 });
  await expect(run()).rejects.toMatchObject({ reason: 'token_limit' }); expect(completion).toHaveBeenCalledTimes(1);
});

test('current protocol group must fit intact, never truncate arguments or discard results', async () => {
  completion.mockResolvedValueOnce(proposal()); jest.mocked(llmEngineService.countPromptTokens).mockResolvedValueOnce(100).mockResolvedValueOnce(9000);
  await expect(run()).rejects.toMatchObject({ reason: 'context_limit' }); expect(completion).toHaveBeenCalledTimes(1);
});

test('required applies only on initial step and structured final retains its schema', async () => {
  completion.mockResolvedValueOnce(proposal()).mockResolvedValueOnce(answer('The result is 42'))
    .mockResolvedValueOnce({ ...answer('{"value":42}'), structuredOutput: { mode: 'json_schema', status: 'valid' } });
  const generation = { output: { mode: 'json_schema' as const, schema: '{"type":"object"}' } };
  await run({ settings: { ...settings, toolChoice: 'required' }, options: { ...options, generation } });
  expect(completion.mock.calls.map(([request]) => request.toolRequest?.toolChoice)).toEqual(['required', 'auto', 'none']);
  expect(completion.mock.calls[2][0].generation).toMatchObject(generation);
  expect(completion.mock.calls.every(([request]) => request.generation === completion.mock.calls[0][0].generation)).toBe(true);
  expect(completion.mock.calls[2][0].toolRequest?.tools).not.toHaveLength(0);
});

test('final phase proposals cannot execute', async () => {
  completion.mockResolvedValueOnce(answer()).mockResolvedValueOnce(proposal());
  await expect(run({ options: { ...options, generation: { output: { mode: 'json_object' } } } })).rejects.toMatchObject({ reason: 'invalid_proposal' });
  expect(executor).not.toHaveBeenCalled();
});

test('ordinary parsed JSON content never becomes a call', async () => {
  completion.mockResolvedValueOnce(answer('{"tool_calls":[{"name":"calculate"}]}'));
  await run(); expect(executor).not.toHaveBeenCalled(); expect(completion).toHaveBeenCalledTimes(1);
});

test('Stop during pending native result rejects late proposal', async () => {
  const native = deferred<LlamaCompletionResult>(); completion.mockReturnValueOnce(native.promise);
  const pending = run(); const rejected = expect(pending).rejects.toMatchObject({ reason: 'cancelled' });
  await Promise.resolve(); await Promise.resolve(); controller.abort(); native.resolve(proposal());
  await rejected; expect(executor).not.toHaveBeenCalled(); expect(finish).toHaveBeenCalledTimes(1);
});

test('tool timeout retains ownership until actual operation settles', async () => {
  jest.useFakeTimers(); const operation = deferred<string>(); executor.mockReturnValueOnce(operation.promise); completion.mockResolvedValueOnce(proposal());
  const pending = run(); const rejected = expect(pending).rejects.toMatchObject({ reason: 'timeout' });
  await jest.advanceTimersByTimeAsync(10001); expect(finish).not.toHaveBeenCalled(); expect(completion).toHaveBeenCalledTimes(1);
  operation.resolve('{"ok":true,"result":42}'); await rejected; expect(finish).toHaveBeenCalledTimes(1);
  expect(progress.at(-1)?.rounds[0].calls[0].result).toBeUndefined();
});

test('changed input snapshot discards delayed tool result and never resumes', async () => {
  const operation = deferred<string>(); executor.mockReturnValueOnce(operation.promise); completion.mockResolvedValueOnce(proposal());
  const pending = run(); const rejected = expect(pending).rejects.toThrow();
  for (let i = 0; i < 8; i++) await Promise.resolve(); current.mockImplementation(() => { throw new Error('changed'); });
  mockListeners.forEach(listener => listener()); operation.resolve('{"ok":true,"result":42}'); await rejected;
  expect(completion).toHaveBeenCalledTimes(1); expect(progress.at(-1)?.rounds[0].calls[0].result).toBeUndefined();
});


test.each(['interrupted', 'truncated', 'context_full', 'stopped_limit'] as const)('GBNF final %s cannot receive success', async flag => {
  completion.mockResolvedValueOnce(answer()).mockResolvedValueOnce({ ...answer('42'), [flag]: true,
    structuredOutput: { mode: 'gbnf', status: 'not_applicable' } });
  await expect(run({ options: { ...options, generation: { output: { mode: 'gbnf', grammar: 'root ::= "42"' } } } }))
    .rejects.toMatchObject({ reason: 'invalid_proposal' });
  expect(progress.at(-1)?.status).not.toBe('completed');
});

test.each([false, true])('preserves text prefill in final phase after tools=%s', async usesTool => {
  const generation = { template: { prefillText: 'Answer: ' }, ...(usesTool ? { output: { mode: 'text' as const } } : {}) };
  let selectionSteps = 0;
  completion.mockImplementation(async request => {
    if (request.toolRequest?.phase === 'final') return answer('Answer: 42');
    selectionSteps += 1;
    return usesTool && selectionSteps === 1 ? proposal() : answer('Unprefilled draft');
  });
  const onToken = jest.fn();
  const result = await run({ options: { ...options, generation, onToken } });
  expect(result.content).toBe('Answer: 42');
  expect(result.text).toBe('Answer: 42');
  expect(executor).toHaveBeenCalledTimes(usesTool ? 1 : 0);
  const final = completion.mock.calls.at(-1)![0];
  expect(final.toolRequest).toMatchObject({ phase: 'final', toolChoice: 'none' });
  expect(final.generation).toMatchObject(generation);
  expect(final.onToken).toBe(onToken);
  expect(completion.mock.calls.slice(0, -1).every(([request]) => request.onToken === undefined)).toBe(true);
  expect(llmEngineService.countPromptTokens).toHaveBeenLastCalledWith(expect.objectContaining({
    generation: final.generation, toolRequest: final.toolRequest, runOwner: final.runOwner,
  }));
  if (usesTool) expect(final.messages.at(-1)).toMatchObject({ role: 'tool', content: '{"ok":true,"result":{"value":42}}' });
  expect(progress.at(-1)).toMatchObject({ phase: 'final', status: 'completed' });
});

test('reports finite native boundaries before counting and completing', async () => {
  const stages: string[] = [];
  jest.mocked(llmEngineService.countPromptTokens).mockImplementationOnce(async () => {
    expect(stages).toEqual(['count_prompt']); return 100;
  });
  completion.mockImplementationOnce(async () => {
    expect(stages).toEqual(['count_prompt', 'completion']); return answer();
  });
  await run({ onNativeStage: stage => stages.push(stage) });
  expect(stages).toEqual(['count_prompt', 'completion']);
});
