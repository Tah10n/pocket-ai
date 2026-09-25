import { getAndroidQaLocalToolsEvidence, resetAndroidQaLocalToolsForTests, runAndroidQaLocalTools } from '../../src/services/AndroidQaLocalTools';
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
beforeEach(() => { jest.clearAllMocks(); resetAndroidQaLocalToolsForTests(); mockEnabled.mockReturnValue(true); });
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
