import { AppError } from '../../src/services/AppError';
import { hasAndroidQaVisibleAnswer, matchesAndroidQaLocalToolAnswer, getAndroidQaLocalToolsEvidence, resetAndroidQaLocalToolsForTests, runAndroidQaLocalTools } from '../../src/services/AndroidQaLocalTools';
const mockEnabled = jest.fn(() => true);
const mockBaseline = jest.fn(() => ({ status: 'failed' }));
const mockLoad = jest.fn();
const mockRun = jest.fn();
const mockDownload = jest.fn();
jest.mock('../../src/services/AndroidQaDocumentModelBootstrap', () => ({ isAndroidQaDocumentModelBootstrapEnabled: () => mockEnabled() }));
jest.mock('../../src/services/AndroidQaStage3', () => ({ getAndroidQaStage3Evidence: () => mockBaseline() }));
jest.mock('../../src/services/LocalToolRun', () => ({ runLocalToolCompletion: (...args: unknown[]) => mockRun(...args), LocalToolRunError: class extends Error {} }));
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

it.each(['42', '42.0', 'The result is 42.', 'The result of 17 + 25 is **42**.', '17+25 = 42',
  '<think>private reasoning</think>\nThe answer is 42.'])(
  'accepts the visible fixture answer %s', text => expect(matchesAndroidQaLocalToolAnswer(text, 'calculate')).toBe(true));
it.each(['420', '142', 'The answer is not 42.', 'The result is 42 or 43.', '42 cats',
  '<think>42</think>', '{"answer":42}', '{"tool_calls":[{"arguments":"42"}]}', '18+25=42'])(
  'rejects ambiguous or protocol fixture answer %s', text => expect(matchesAndroidQaLocalToolAnswer(text, 'calculate')).toBe(false));
it.each(['CERULEAN-731', 'The verification code is CERULEAN-731.', 'The Meridian verification code is **CERULEAN-731**.'])(
  'accepts bounded document answer %s', text => expect(matchesAndroidQaLocalToolAnswer(text, 'document_search')).toBe(true));
it.each(['CERULEAN-7310', 'Not CERULEAN-731', '{"code":"CERULEAN-731"}', '<think>CERULEAN-731</think>'])(
  'rejects nonanswer document code %s', text => expect(matchesAndroidQaLocalToolAnswer(text, 'document_search')).toBe(false));

it.each(['', '   ', '<think>\n\n</think>\n', '<think>reasoning only</think>', '<thinking>unfinished'])(
  'rejects empty user-visible ordinary answer %s', text => expect(hasAndroidQaVisibleAnswer(text)).toBe(false));
it('accepts visible ordinary text following reasoning framing', () => {
  expect(hasAndroidQaVisibleAnswer('<think>reasoning</think> Hello.')).toBe(true);
});
