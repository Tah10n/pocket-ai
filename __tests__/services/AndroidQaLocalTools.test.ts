import { AppError } from '../../src/services/AppError';
import { createAndroidQaDocumentSearchPrompt, getAndroidQaLocalToolsHistoryMarker, hasAndroidQaVisibleAnswer, hasAndroidQaFinalReference, getAndroidQaLocalToolsEvidence, resetAndroidQaLocalToolsForTests, runAndroidQaLocalTools } from '../../src/services/AndroidQaLocalTools';
const mockEnabled = jest.fn(() => true);
const mockBaseline = jest.fn(() => ({ status: 'failed' }));
const mockLoad = jest.fn();
const mockRun = jest.fn();
const mockDownload = jest.fn();
jest.mock('../../src/services/AndroidQaDocumentModelBootstrap', () => ({ isAndroidQaDocumentModelBootstrapEnabled: () => mockEnabled() }));
jest.mock('../../src/services/AndroidQaStage3', () => ({ getAndroidQaStage3Evidence: () => mockBaseline() }));
jest.mock('../../src/services/LocalToolRun', () => ({ runLocalToolCompletion: (...args: unknown[]) => mockRun(...args), LocalToolRunError: class extends Error {}, getLocalToolRunStartCount: () => 0 }));
jest.mock('../../src/services/LLMEngineService', () => ({ llmEngineService: {
  load: (...args: unknown[]) => mockLoad(...args), getEffectiveLoadParameters: () => null,
  getState: () => ({ activeModelId: null }), hasActiveCompletion: () => false, hasAuxiliaryContextOperation: () => false,
} }));
jest.mock('../../src/store/chatStore', () => ({ useChatStore: { getState: () => ({ activeThreadId: null }) } }));
jest.mock('../../src/store/downloadStore', () => ({ useDownloadStore: { getState: () => ({ addToQueue: mockDownload }) } }));
jest.mock('../../src/services/LocalStorageRegistry', () => ({ registry: {} }));
jest.mock('../../src/services/ModelDownloadManager', () => ({ getModelDownloadManager: jest.fn() }));
jest.mock('../../src/services/ChatAttachmentStorageService', () => ({}));
jest.mock('../../src/services/ChatAttachmentProcessorRegistry', () => ({}));
beforeEach(() => { jest.clearAllMocks(); resetAndroidQaLocalToolsForTests(); mockEnabled.mockReturnValue(true); mockBaseline.mockReset().mockReturnValue({ status: 'failed' }); });
it('does no QA work outside the explicit isolated Android QA build', async () => {
  mockEnabled.mockReturnValue(false);
  await runAndroidQaLocalTools();
  expect(getAndroidQaLocalToolsEvidence().status).toBe('idle');
  expect(mockLoad).not.toHaveBeenCalled(); expect(mockRun).not.toHaveBeenCalled(); expect(mockDownload).not.toHaveBeenCalled();
});
it('marks every native step not_run when the accepted baseline has not passed', async () => {
  await runAndroidQaLocalTools();
  const evidence = getAndroidQaLocalToolsEvidence();
  expect(evidence.status).toBe('failed'); expect(evidence.failureCode).toBe('precondition');
  expect(evidence.steps.every(step => step.status === 'not_run')).toBe(true);
  expect(mockLoad).not.toHaveBeenCalled(); expect(mockRun).not.toHaveBeenCalled(); expect(mockDownload).not.toHaveBeenCalled();
});

it.each(['engine_busy', 'multimodal_not_ready', 'message_too_long'] as const)(
  'retains only known AppError diagnostic code %s', async code => {
    mockBaseline.mockImplementation(() => { throw new AppError(code, 'secret native prompt and path'); });
    await runAndroidQaLocalTools();
    const evidence = getAndroidQaLocalToolsEvidence();
    expect(evidence).toMatchObject({ status: 'failed', failureCode: 'operation_failed', appErrorCode: code });
    expect(JSON.stringify(evidence)).not.toContain('secret');
    expect(mockRun).not.toHaveBeenCalled();
  });
it('does not accept arbitrary exception properties or unknown AppError code strings', async () => {
  for (const error of [Object.assign(new Error('secret native text'), { code: 'engine_busy' }),
    new AppError('secret-forged-code' as never, 'secret native text')]) {
    resetAndroidQaLocalToolsForTests();
    mockBaseline.mockImplementation(() => { throw error; });
    await runAndroidQaLocalTools();
    const evidence = getAndroidQaLocalToolsEvidence();
    expect(evidence.appErrorCode).toBe(error instanceof AppError ? 'action_failed' : undefined);
    expect(JSON.stringify(evidence)).not.toContain('secret');
  }
});

it('classifies the fixed parser failure prefix without retaining its remainder', async () => {
  mockBaseline.mockImplementation(() => { throw new Error('Unable to generate parser: secret template and prompt'); });
  await runAndroidQaLocalTools();
  expect(getAndroidQaLocalToolsEvidence().nativeFailureCategory).toBe('formatter_parser_generation');
  expect(JSON.stringify(getAndroidQaLocalToolsEvidence())).not.toContain('secret');
});

it.each(['42', 'The result is 42.', 'The result of 17 + 25 is **42**.', '17+25 = 42',
  '<think>private reasoning</think>\nThe answer is 42.'])(
  'accepts the visible fixture answer %s', text => expect(hasAndroidQaFinalReference(text, 'calculate')).toBe(true));
it.each(['420', '142', '42.1', '42.0', '-42', '+42',
  '<think>42</think>', '{"answer":42}', '{"tool_calls":[{"arguments":"42"}]}'])(
  'rejects ambiguous or protocol fixture answer %s', text => expect(hasAndroidQaFinalReference(text, 'calculate')).toBe(false));
it.each(['CERULEAN-731', 'The verification code is CERULEAN-731.', 'The Meridian verification code is **CERULEAN-731**.'])(
  'accepts bounded document answer %s', text => expect(hasAndroidQaFinalReference(text, 'document_search')).toBe(true));
it.each(['CERULEAN-7310', '{"code":"CERULEAN-731"}', '<think>CERULEAN-731</think>'])(
  'rejects nonanswer document code %s', text => expect(hasAndroidQaFinalReference(text, 'document_search')).toBe(false));

it.each(['', '   ', '<think>\n\n</think>\n', '<think>reasoning only</think>', '<thinking>unfinished'])(
  'rejects empty user-visible ordinary answer %s', text => expect(hasAndroidQaVisibleAnswer(text)).toBe(false));
it('accepts visible ordinary text following reasoning framing', () => {
  expect(hasAndroidQaVisibleAnswer('<think>reasoning</think> Hello.')).toBe(true);
});

it('reports reference presence honestly without asserting prose semantics', () => {
  expect(hasAndroidQaFinalReference('The answer is not 42.', 'calculate')).toBe(true);
  expect(hasAndroidQaFinalReference('The retrieved reference is CERULEAN-731; verify its meaning.', 'document_search')).toBe(true);
});

it('preserves a settled native answer before a failed QA assertion and retains its diagnostic chat', async () => {
  const fixture = jest.requireActual('../../docs/validation/llama-rn-stage4/tool-fixture.json');
  const registry = jest.requireMock('../../src/services/LocalStorageRegistry').registry;
  registry.getModel = () => ({ id: fixture.model.repository, resolvedFileName: fixture.model.filename,
    localPath: 'test-model', downloadUrl: fixture.model.downloadUrl, size: fixture.model.sizeBytes, sha256: fixture.model.sha256,
    downloadIntegrity: { kind: 'sha256', sha256: fixture.model.sha256, sizeBytes: fixture.model.sizeBytes } });
  const engine = jest.requireMock('../../src/services/LLMEngineService').llmEngineService;
  engine.getState = () => ({ activeModelId: null, diagnostics: { backendMode: 'cpu', actualGpuAccelerated: false,
    loadedGpuLayers: 0, initNParallel: 1 } });
  engine.unload = jest.fn().mockResolvedValue(undefined);
  const finalize = jest.fn(() => ({ status: 'committed' }));
  const retainedThread = { title: 'Android local tools QA', modelId: fixture.model.repository, messages: [] };
  const rename = jest.fn((_id: string, title: string) => { retainedThread.title = title; return true; });
  const remove = jest.fn();
  const state = { threads: { 'qa-thread': retainedThread }, activeThreadId: null as string | null, inferenceRevision: 0,
    beginNewThread: () => true, createThread: () => { state.activeThreadId = 'qa-thread'; return 'qa-thread'; },
    updateThreadToolSettings: jest.fn(), appendMessage: jest.fn(), createAssistantPlaceholder: () => 'assistant',
    patchAssistantMessage: jest.fn(), finalizeAssistantTurn: finalize, renameThread: rename, deleteThread: remove,
    setActiveThread: jest.fn() };
  const store = jest.requireMock('../../src/store/chatStore').useChatStore;
  store.getState = () => state; store.persist = { hasHydrated: () => true };
  mockBaseline.mockReturnValue({ status: 'passed' });
  const actualNativeAnswer = 'An answer retained for manual inspection.';
  mockRun.mockImplementation(async ({ onProgress, onNativeStep }) => {
    const result = '{"ok":true,"result":{"value":42}}';
    onProgress({ id: 'assistant', threadId: 'qa-thread', status: 'completed', phase: 'final',
      rounds: [{ index: 0, content: '', calls: [{ id: 'call', name: 'calculate', status: 'completed', result }] }] });
    onNativeStep({ messages: [], promptTokens: 10, result: { tokens_predicted: 1, tokens_evaluated: 10, tool_calls: [{}] } });
    onNativeStep({ messages: [{ role: 'tool', tool_call_id: 'call', content: result }], promptTokens: 20,
      result: { tokens_predicted: 1, tokens_evaluated: 20 } });
    return { content: actualNativeAnswer };
  });
  await runAndroidQaLocalTools();
  expect(getAndroidQaLocalToolsEvidence()).toMatchObject({ status: 'failed', failureCode: 'assertion' });
  expect(finalize).toHaveBeenCalledTimes(1);
  expect(finalize).toHaveBeenCalledWith('qa-thread', 'assistant', expect.objectContaining({ outcome: 'success', content: actualNativeAnswer }));
  expect(rename).toHaveBeenCalledWith('qa-thread', expect.stringMatching(/^Android local tools QA failed \d+$/));
  expect(remove).not.toHaveBeenCalled();
  expect(getAndroidQaLocalToolsEvidence().steps.find(step => step.id === 'calculate_required')).toMatchObject({
    nativeSteps: 2, executedCalls: 1, resultReturned: true, referenceMatched: true, finalReferencePresent: false, status: 'failed' });
  expect(JSON.parse(getAndroidQaLocalToolsHistoryMarker()).threadCount).toBe(0);
  expect(JSON.stringify(getAndroidQaLocalToolsEvidence())).not.toContain(actualNativeAnswer);

  // A separate synthetic sequence proves unselected auto output reaches the next required check.
  resetAndroidQaLocalToolsForTests(); state.activeThreadId = null; mockRun.mockReset();
  const rawModelText = '{"name":"calculate","arguments":{"expression":"17+25"}}';
  mockRun.mockImplementation(async ({ onProgress, onNativeStep }) => {
    const index = mockRun.mock.calls.length;
    if (index === 3) throw new AppError('engine_not_ready');
    const result = '{"ok":true,"result":{"value":42}}';
    onProgress({ id: 'assistant', threadId: 'qa-thread', status: 'completed', phase: 'final',
      rounds: index === 1 ? [{ index: 0, content: '', calls: [{ id: 'call', name: 'calculate', status: 'completed', result }] }] : [] });
    onNativeStep({ messages: [], promptTokens: 10, result: { tokens_predicted: 1, tokens_evaluated: 10,
      tool_calls: index === 1 ? [{}] : [] } });
    if (index === 1) onNativeStep({ messages: [{ role: 'tool', tool_call_id: 'call', content: result }], promptTokens: 20,
      result: { tokens_predicted: 1, tokens_evaluated: 20 } });
    return { content: index === 1 ? 'The numeric result is 42.' : rawModelText };
  });
  await runAndroidQaLocalTools();
  expect(mockRun).toHaveBeenCalledTimes(3);
  expect(getAndroidQaLocalToolsEvidence()).toMatchObject({ status: 'failed', phase: 'ordinary_auto', appErrorCode: 'engine_not_ready' });
  expect(getAndroidQaLocalToolsEvidence().steps.find(step => step.id === 'calculate_auto')).toMatchObject({
    status: 'observed', automaticCallSelected: false, nativeCalls: 0, executedCalls: 0, resultReturned: false,
    referenceMatched: false, finalReferencePresent: false });
  expect(finalize).toHaveBeenCalledWith('qa-thread', 'assistant', expect.objectContaining({ outcome: 'success', content: rawModelText }));
  expect(JSON.stringify(getAndroidQaLocalToolsEvidence())).not.toContain(rawModelText);
});

it.each(['attached-fixture-a', 'attached-fixture-b'])(
  'gives native generation the actual attached ID %s without supplying the document answer', documentId => {
    const prompt = createAndroidQaDocumentSearchPrompt(documentId);
    expect(prompt).toContain(JSON.stringify(documentId));
    expect(prompt).toContain('Meridian verification code');
    expect(prompt).not.toContain('CERULEAN-731');
    expect(prompt).not.toContain('document123');
  });
