import { type LocalToolRun, sanitizeLocalToolRun, sanitizeLocalToolSettings } from '../../src/types/localTools';
import { type ChatThread, sanitizeHydratedThread } from '../../src/types/chat';
import { buildInferenceWindowWithAccurateTokenCounts, getThreadInferenceWindow } from '../../src/utils/inferenceWindow';
import { buildLlmInferenceMessagesSignature } from '../../src/utils/llmInferenceMessageSignature';
import { recoverChatThreadFromStreamingProgress, recoverStaleStreamingThread, sanitizeChatThreadForPersistence,
  writeChatStreamingProgressRecord, readChatStreamingProgressRecord } from '../../src/store/chatPersistence';
import { storage } from '../../src/store/storage';

function run(): LocalToolRun {
  return { id: 'run', threadId: 'thread-tools', settings: { enabled: true, allowedTools: ['calculate'] },
    phase: 'tools', status: 'running', rounds: [{ index: 0, content: '', calls: [
      { id: 'run:0:0', name: 'calculate', arguments: '{"expression":"2+2"}', status: 'completed', result: '{"value":4}' },
    ] }] };
}
function thread(): ChatThread {
  return { id: 'thread-tools', modelId: 'model', title: 'Tools', presetId: null,
    presetSnapshot: { id: null, name: 'Default', systemPrompt: 'Be helpful' },
    paramsSnapshot: { temperature: 0, topP: 1, maxTokens: 64, seed: null },
    createdAt: 1, updatedAt: 1, status: 'generating', messages: [
      { id: 'u', role: 'user', content: 'Compute', createdAt: 1, state: 'complete' },
      { id: 'a', role: 'assistant', content: '', createdAt: 2, state: 'streaming', toolRun: run() },
    ] };
}
beforeEach(() => storage.clearAll());

it('defaults old chats to tools disabled and sanitizes the static allowlist', () => {
  expect(sanitizeLocalToolSettings(undefined)).toMatchObject({ enabled: false, allowedTools: [] });
  expect(sanitizeLocalToolSettings({ enabled: true, allowedTools: ['shell', 'calculate', 'calculate'] }).allowedTools).toEqual(['calculate']);
});
it('preserves empty assistant proposals and recovers pending work as interrupted', () => {
  const value = thread();
  value.messages[1].toolRun!.rounds[0].calls[0].status = 'running';
  expect(sanitizeChatThreadForPersistence(value).messages).toHaveLength(2);
  for (const recovered of [recoverStaleStreamingThread(value), sanitizeHydratedThread(value)]) {
    expect(recovered.messages[1]).toMatchObject({ state: 'stopped', toolRun: { status: 'interrupted', rounds: [
      { calls: [{ status: 'cancelled' }] },
    ] } });
  }
});
it('journals changes to tool progress without text and restores completed evidence without execution', () => {
  const value = thread();
  const progress = { schemaVersion: 1 as const, threadId: value.id, messageId: 'a', modelId: 'model', createdAt: 2,
    content: '', state: 'streaming' as const, persistedAt: 20, revision: 1, toolRun: run() };
  expect(writeChatStreamingProgressRecord(storage, progress).status).toBe('written');
  const next = { ...progress, revision: 2, persistedAt: 21, toolRun: { ...run(), phase: 'final' as const } };
  expect(writeChatStreamingProgressRecord(storage, next).status).toBe('written');
  const read = readChatStreamingProgressRecord(storage, value.id);
  expect(read.ok).toBe(true);
  if (!read.ok) throw new Error('Missing progress');
  expect(read.value.toolRun?.phase).toBe('final');
  expect(recoverChatThreadFromStreamingProgress(value, 1, read.value)).toMatchObject({ outcome: 'recovered', thread: {
    messages: [{}, { toolRun: { status: 'interrupted', rounds: [{ calls: [{ status: 'completed', result: '{"value":4}' }] }] } }],
  } });
});
it('never drops a call or result independently, even under a one-message cap', async () => {
  const value = thread();
  const heuristic = getThreadInferenceWindow(value, { maxContextMessages: 1 });
  expect(heuristic.messages.map(message => message.role)).toEqual(['system', 'user', 'assistant', 'tool']);
  const count = jest.fn(async (messages) => messages.length * 10);
  const exact = await buildInferenceWindowWithAccurateTokenCounts(value, {
    maxContextMessages: 1, maxContextTokens: 50, promptSafetyMarginTokens: 0, responseReserveTokens: 0,
  }, count);
  expect(exact.messages).toEqual(heuristic.messages);
  expect(count.mock.calls.every(([messages]) => messages.some((message: { role: string }) => message.role === 'assistant')
    && messages.some((message: { role: string }) => message.role === 'tool'))).toBe(true);
  await expect(buildInferenceWindowWithAccurateTokenCounts(value, {
    maxContextMessages: 1, maxContextTokens: 30, promptSafetyMarginTokens: 0,
  }, count)).rejects.toMatchObject({ code: 'message_too_long' });
});
it('does not interpret assistant JSON or unfinished proposals as executable protocol', () => {
  const value = thread();
  value.messages[1].toolRun!.rounds[0].calls[0].status = 'proposed';
  value.messages[1].content = '{"tool_calls":[{"name":"calculate"}]}';
  expect(getThreadInferenceWindow(value, 20).messages.every(message => !message.tool_calls)).toBe(true);
});
it('rejects duplicate IDs and includes protocol arguments and result linkage in prompt identity', () => {
  const value = run();
  value.rounds[0].calls.push({ ...value.rounds[0].calls[0] });
  expect(sanitizeLocalToolRun(value)).toBeUndefined();
  const messages = getThreadInferenceWindow(thread(), 20).messages;
  const original = buildLlmInferenceMessagesSignature(messages);
  messages[2].tool_calls![0].function.arguments = '{"expression":"3+3"}';
  expect(buildLlmInferenceMessagesSignature(messages)).not.toBe(original);
});
