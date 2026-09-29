import { DEFAULT_PRESET_SNAPSHOT, type ChatThread } from '../../src/types/chat';
import { ANDROID_QA_TOOL_FIXTURE } from '../../src/services/AndroidQaLocalTools';
import { androidQaHistoryDigest, checkAndroidQaLocalToolsRecoveryAfterColdReopen, getAndroidQaLocalToolsRecoveryEvidence,
  recordAndroidQaLocalToolNativeFirstToken, recordAndroidQaLocalToolNativeSettlement,
  resetAndroidQaLocalToolsRecoveryForTests, runAndroidQaLocalToolsRecovery } from '../../src/services/AndroidQaLocalToolsRecovery';
const mockEnabled = jest.fn(() => true);
const mockLoad = jest.fn().mockResolvedValue(undefined);
const mockUnload = jest.fn().mockResolvedValue(undefined);
const mockBusy = jest.fn(() => false);
const mockStarts = jest.fn(() => 3);
const mockFile = jest.fn().mockResolvedValue({ exists: true });
const mockValues = new Map<string, string>();
const mockStorage = { set: jest.fn((key: string, value: string) => mockValues.set(key, value)), getString: (key: string) => mockValues.get(key), remove: jest.fn((key: string) => mockValues.delete(key)) };
let mockState: any;
let mockPresented: ChatThread | undefined;
jest.mock('../../src/services/AndroidQaDocumentModelBootstrap', () => ({ isAndroidQaDocumentModelBootstrapEnabled: () => mockEnabled() }));
jest.mock('expo-file-system/legacy', () => ({ getInfoAsync: (...args: unknown[]) => mockFile(...args) }));
jest.mock('../../src/services/AndroidQaLocalTools', () => ({ ANDROID_QA_TOOL_FIXTURE: { repository: 'fixture-qwen', sha256: 'fixture-sha', size: 100 }, hasAndroidQaVisibleAnswer: (text: string) => !!text.trim() }));
jest.mock('../../src/services/LocalToolRun', () => ({ getLocalToolRunStartCount: () => mockStarts() }));
jest.mock('../../src/services/LLMEngineService', () => ({ llmEngineService: { getState: () => ({ activeModelId: null, diagnostics: { backendMode: 'cpu' } }),
  getEffectiveLoadParameters: () => null, hasActiveCompletion: () => mockBusy(), hasAuxiliaryContextOperation: () => false,
  load: (...args: unknown[]) => mockLoad(...args), unload: () => mockUnload() } }));
jest.mock('../../src/services/LocalStorageRegistry', () => ({ registry: { getModel: () => ({ localPath: 'fixture-model',
  downloadIntegrity: { kind: 'sha256', sha256: 'fixture-sha', sizeBytes: 100 } }) } }));
jest.mock('../../src/store/chatStore', () => ({ useChatStore: { getState: () => mockState,
  subscribe: () => () => undefined, persist: { hasHydrated: () => true } }, flushPendingChatPersistenceWrites: jest.fn() }));
jest.mock('../../src/store/storage', () => ({ getAppStorage: () => mockStorage }));
jest.mock('../../src/store/chatPersistence', () => ({ ...jest.requireActual('../../src/store/chatPersistence'),
  readChatThreadRecord: () => ({ ok: true, value: { thread: mockState.threads.qa, persistedAt: 100 } }),
  writeChatStreamingProgressRecord: jest.fn(() => ({ status: 'rejected', reason: 'empty_progress' })),
  readChatStreamingProgressRecord: jest.fn(() => ({ ok: false, reason: 'invalid_shape' })) }));

function thread(): ChatThread {
  const now = Date.now();
  return { id: 'qa', modelId: ANDROID_QA_TOOL_FIXTURE.repository, title: 'Android local tools QA', presetId: null,
    presetSnapshot: DEFAULT_PRESET_SNAPSHOT, paramsSnapshot: { temperature: 0, topP: 1, maxTokens: 768, seed: 42 },
    createdAt: now - 1000, updatedAt: now, status: 'idle', messages: Array.from({ length: 8 }, (_, index) => ({
      id: `message-${index}`, role: index % 2 ? 'assistant' as const : 'user' as const, content: `Original ${index}`,
      createdAt: now - 1000 + index, state: 'complete' as const,
      ...(index === 1 ? { toolRun: { id: 'message-1', threadId: 'qa', settings: { enabled: true, allowedTools: ['calculate'] as const, toolChoice: 'required' as const },
        phase: 'tools' as const, status: 'completed' as const, rounds: [{ index: 0, content: '', calls: [{ id: 'old-call', name: 'calculate', arguments: '{}', result: '{"ok":true}', status: 'completed' as const }] }] } } : {}),
      ...(index === 4 ? { attachments: [{ id: 'doc', kind: 'document' as const, threadId: 'qa', messageId: 'message-4', localUri: 'file:///synthetic-doc.txt',
        pathCategory: 'chat_attachment' as const, fileName: 'synthetic.txt', mediaType: 'text/plain', size: 10, source: 'document_picker' as const,
        createdAt: now, state: 'ready' as const }] } : {}),
    })) } as ChatThread;
}
beforeEach(() => {
  jest.clearAllMocks(); mockValues.clear(); mockEnabled.mockReturnValue(true); mockBusy.mockReturnValue(false); mockStarts.mockReturnValue(3);
  mockFile.mockResolvedValue({ exists: true }); resetAndroidQaLocalToolsRecoveryForTests(); mockPresented = undefined;
  const qa = thread();
  mockState = { activeThreadId: null, threads: { qa, sentinel: { ...qa, id: 'sentinel', title: 'Other chat', messages: [] } },
    getThread: (id: string) => id === 'qa' && mockPresented ? mockPresented : mockState.threads[id],
    setActiveThread: (id: string) => { mockState.activeThreadId = id; return true; },
    updateThreadToolSettings: (id: string, settings: unknown) => { mockState.threads[id].toolSettings = settings; },
    updateThreadParamsSnapshot: (id: string, params: unknown) => { mockState.threads[id].paramsSnapshot = params; } };
});
function actions({ losePartial = false, corruptRollback = false, parsedContent = 'A peaceful forest has', storedContent = parsedContent }:
  { losePartial?: boolean; corruptRollback?: boolean; parsedContent?: string; storedContent?: string } = {}) {
  let replacement = 0;
  const stopGeneration = jest.fn(async () => {
    mockPresented = undefined;
    if (corruptRollback) mockState.threads.qa.messages = mockState.threads.qa.messages.slice(0, 2);
  });
  const replace = jest.fn(async () => {
    replacement += 1;
    const runId = `replacement-${replacement}`;
    mockPresented = { ...mockState.threads.qa, messages: [{ id: runId, role: 'assistant', content: '', state: 'streaming', createdAt: Date.now(),
      toolRun: { id: runId, threadId: 'qa', settings: mockState.threads.qa.toolSettings, phase: 'tools', status: 'running', rounds: [] } }] };
    recordAndroidQaLocalToolNativeFirstToken({ threadId: 'qa', runId, phase: 'tools' });
    recordAndroidQaLocalToolNativeSettlement({ threadId: 'qa', runId, phase: 'tools', result: { content: '', text: 'raw framing', tool_calls: [], tokens_predicted: 0, interrupted: true } as any });
  });
  return { appendUserMessage: jest.fn(async () => {
    const content = parsedContent;
    recordAndroidQaLocalToolNativeSettlement({ threadId: 'qa', runId: 'partial', phase: 'tools', result: {
      content, text: 'raw protocol must not be stored', stopped_limit: true, tool_calls: [], tokens_predicted: 31 } as any });
    mockState.threads.qa.messages.push({ id: 'new-user', role: 'user', content: 'Long prose prompt', state: 'complete', createdAt: Date.now() },
      { id: 'partial', role: 'assistant', content: losePartial ? '' : storedContent, state: 'stopped', createdAt: Date.now(),
        toolRun: { id: 'partial', threadId: 'qa', settings: mockState.threads.qa.toolSettings, phase: 'tools', status: 'interrupted', rounds: [] } });
    mockState.threads.qa.status = 'stopped';
  }), regenerateLastResponse: replace, regenerateFromUserMessage: replace, stopGeneration };
}
it('does no work outside the explicit Android QA build', async () => {
  mockEnabled.mockReturnValue(false);
  const hook = actions(); await runAndroidQaLocalToolsRecovery(() => hook);
  expect(getAndroidQaLocalToolsRecoveryEvidence().status).toBe('idle');
  expect(mockLoad).not.toHaveBeenCalled(); expect(hook.appendUserMessage).not.toHaveBeenCalled();
});
it('fails preconditions before touching a busy engine or downloading fixtures', async () => {
  mockBusy.mockReturnValue(true); const hook = actions(); await runAndroidQaLocalToolsRecovery(() => hook);
  expect(getAndroidQaLocalToolsRecoveryEvidence()).toMatchObject({ status: 'failed', failureCode: 'precondition' });
  expect(mockLoad).not.toHaveBeenCalled(); expect(hook.appendUserMessage).not.toHaveBeenCalled();
});
it('checks hook partial status, both Stop rollbacks and an actual rejected write before seeding the legacy journal', async () => {
  const hook = actions(); await runAndroidQaLocalToolsRecovery(() => hook);
  const value = getAndroidQaLocalToolsRecoveryEvidence();
  expect(value).toMatchObject({ status: 'ready_for_cold_reopen', phase: 'empty_checkpoint_cold_recovery' });
  expect(value.steps).toHaveLength(3); expect(hook.appendUserMessage).toHaveBeenCalledTimes(1);
  expect(hook.stopGeneration).toHaveBeenCalledTimes(2);
  expect(value.steps[0]).toMatchObject({ stoppedLimit: true, parsedContentRetained: true, storedStopped: true, nativeCalls: 0, executedCalls: 0 });
  const journal = [...mockValues.entries()].find(([key]) => key.startsWith('chat-store:progress:'))!;
  expect(JSON.parse(journal[1])).toMatchObject({ content: '', toolRun: { rounds: [] } });
  expect(JSON.stringify(value)).not.toContain('forest'); expect(JSON.stringify(value)).not.toContain('file:///');
  resetAndroidQaLocalToolsRecoveryForTests(); mockStarts.mockReturnValue(0);
  await checkAndroidQaLocalToolsRecoveryAfterColdReopen();
  expect(getAndroidQaLocalToolsRecoveryEvidence()).toMatchObject({ status: 'passed', phase: 'complete' });
  expect(getAndroidQaLocalToolsRecoveryEvidence().steps[3]).toMatchObject({ emptyWriteRejected: true, legacyCheckpointSeeded: true,
    legacyCheckpointRejected: true, historyUnchanged: true, attachmentsRetained: true, noReexecution: true });
});
it.each([{ losePartial: true }, { corruptRollback: true }])('rejects false native recovery success %j', async options => {
  await runAndroidQaLocalToolsRecovery(() => actions(options));
  expect(getAndroidQaLocalToolsRecoveryEvidence()).toMatchObject({ status: 'failed', failureCode: 'assertion' });
});
it('accepts exact settled parsed content with boundary newlines retained in the store', async () => {
  const parsedContent = '\n\nA peaceful forest has\n  a quiet clearing.\n\n';
  await runAndroidQaLocalToolsRecovery(() => actions({ parsedContent }));
  expect(mockState.threads.qa.messages.find((message: { id: string }) => message.id === 'partial')?.content).toBe(parsedContent);
  const value = getAndroidQaLocalToolsRecoveryEvidence();
  expect(value).toMatchObject({ status: 'ready_for_cold_reopen', phase: 'empty_checkpoint_cold_recovery' });
  expect(value.steps[0]).toMatchObject({ status: 'passed', nativeSteps: 1, nativeCalls: 0, executedCalls: 0,
    stoppedLimit: true, parsedContentRetained: true, storedStopped: true, completionDrained: true });
  expect(value.steps[0].outputCharacters).toBe('A peaceful forest has\n  a quiet clearing.'.length);
  expect(JSON.stringify(value)).not.toContain(parsedContent);
});
it('rejects changed raw parsed content even when the stored visible presentation is identical', async () => {
  const parsedContent = '\nA peaceful forest has\n';
  await runAndroidQaLocalToolsRecovery(() => actions({ parsedContent, storedContent: 'A peaceful forest has' }));
  const value = getAndroidQaLocalToolsRecoveryEvidence();
  expect(value).toMatchObject({ status: 'failed', failureCode: 'assertion' });
  expect(value.steps[0]).toMatchObject({ id: 'ordinary_auto_limit', status: 'failed', parsedContentRetained: false });
  expect(value.steps.slice(1)).toEqual([
    { id: 'empty_regenerate_stop', status: 'not_run' },
    { id: 'empty_branch_stop', status: 'not_run' },
    { id: 'empty_checkpoint_cold_recovery', status: 'not_run' },
  ]);
});
it('does not count a reopened process that starts tool work as no-reexecution', async () => {
  const hook = actions(); await runAndroidQaLocalToolsRecovery(() => hook);
  resetAndroidQaLocalToolsRecoveryForTests(); mockStarts.mockReturnValue(1);
  await checkAndroidQaLocalToolsRecoveryAfterColdReopen();
  expect(getAndroidQaLocalToolsRecoveryEvidence()).toMatchObject({ status: 'failed', failureCode: 'assertion' });
});
it('canonical history identity detects content changes without retaining payloads', () => {
  expect(androidQaHistoryDigest({ b: 2, a: ['answer'] })).toBe(androidQaHistoryDigest({ a: ['answer'], b: 2 }));
  expect(androidQaHistoryDigest({ a: ['answer'] })).not.toBe(androidQaHistoryDigest({ a: ['different'] }));
  expect(androidQaHistoryDigest('secret')).not.toContain('secret');
});
