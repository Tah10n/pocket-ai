import fixture from '../../docs/validation/llama-rn-stage3/lora-fixture.json';
import { getAndroidQaStage3Evidence, resetAndroidQaStage3ForTests, runAndroidQaStage3 } from '../../src/services/AndroidQaStage3';

const mockEnabled = jest.fn(() => true);
const mockStage1 = jest.fn(() => ({ status: 'passed' }));
const mockStage2 = jest.fn(() => ({ status: 'passed' }));
const mockLoad = jest.fn<Promise<void>, unknown[]>(async () => undefined);
const mockUnload = jest.fn(async () => undefined);
const mockGetState = jest.fn(() => ({ activeModelId: 'qa-chat', status: 'error', diagnostics: {} }));
const mockRestoreThread = jest.fn();
const mockUpdateSettings = jest.fn();
const mockGetModel = jest.fn(() => ({ id: 'qa-chat', downloadIntegrity: { sha256: fixture.base.sha256 } }));
jest.mock('../../src/services/AndroidQaDocumentModelBootstrap', () => ({
  ANDROID_QA_DOCUMENT_MODEL_ID: 'qa-chat', isAndroidQaDocumentModelBootstrapEnabled: () => mockEnabled(),
}));
jest.mock('../../src/services/AndroidQaInferenceSmoke', () => ({ getAndroidQaInferenceSmokeEvidence: () => mockStage1() }));
jest.mock('../../src/services/AndroidQaModelResources', () => ({ getAndroidQaModelResourcesEvidence: () => mockStage2() }));
jest.mock('../../src/services/AuxiliaryModelService', () => ({}));
jest.mock('../../src/services/ModelDownloadManager', () => ({}));
jest.mock('../../src/store/downloadStore', () => ({}));
jest.mock('../../src/services/LocalStorageRegistry', () => ({ registry: { getModel: () => mockGetModel() } }));
jest.mock('../../src/services/SettingsStore', () => ({ getSettings: () => ({ auxiliaryModels: {} }), updateSettings: (value: unknown) => mockUpdateSettings(value) }));
jest.mock('../../src/store/chatStore', () => ({ useChatStore: { getState: () => ({ activeThreadId: 'original', setActiveThread: mockRestoreThread }) } }));
jest.mock('../../src/services/LLMEngineService', () => ({ llmEngineService: {
  load: (...args: unknown[]) => mockLoad(...args), unload: () => mockUnload(),
  getEffectiveLoadParameters: () => ({ contextSize: 512 }), getState: () => mockGetState(),
  hasActiveCompletion: () => false, hasAuxiliaryContextOperation: () => false,
} }));

describe('Stage 3 QA lifecycle contract (unit tests are not native acceptance)', () => {
  beforeEach(() => {
    jest.clearAllMocks(); jest.useRealTimers(); resetAndroidQaStage3ForTests();
    mockEnabled.mockReturnValue(true); mockStage1.mockReturnValue({ status: 'passed' }); mockStage2.mockReturnValue({ status: 'passed' });
    mockLoad.mockImplementation(async () => undefined);
    mockGetModel.mockReturnValue({ id: 'qa-chat', downloadIntegrity: { sha256: fixture.base.sha256 } });
  });
  afterEach(() => jest.useRealTimers());
  it('is inert outside the isolated QA gate', async () => {
    mockEnabled.mockReturnValue(false);
    await runAndroidQaStage3();
    expect(getAndroidQaStage3Evidence().status).toBe('idle'); expect(mockLoad).not.toHaveBeenCalled();
  });
  it.each(['stage1', 'stage2', 'identity'])('does not touch the context before the %s precondition is confirmed', async failure => {
    if (failure === 'stage1') mockStage1.mockReturnValue({ status: 'failed' });
    if (failure === 'stage2') mockStage2.mockReturnValue({ status: 'running' });
    if (failure === 'identity') mockGetModel.mockReturnValue({ id: 'qa-chat', downloadIntegrity: { sha256: 'unverified' } });
    await runAndroidQaStage3();
    expect(getAndroidQaStage3Evidence()).toMatchObject({ status: 'failed', failureCode: 'precondition' });
    expect(getAndroidQaStage3Evidence().steps.every(step => step.status === 'not_run')).toBe(true);
    expect(mockLoad).not.toHaveBeenCalled(); expect(mockUnload).not.toHaveBeenCalled(); expect(mockRestoreThread).not.toHaveBeenCalled();
  });
  it('holds uncertain native work after timeout and ignores a late successful settlement', async () => {
    jest.useFakeTimers();
    let resolveLoad: () => void = () => undefined;
    mockLoad.mockImplementationOnce(() => new Promise<void>(resolve => { resolveLoad = resolve; }));
    const pending = runAndroidQaStage3({ operationTimeoutMs: 20 });
    expect(runAndroidQaStage3()).toBe(pending);
    await jest.advanceTimersByTimeAsync(21); await pending;
    expect(getAndroidQaStage3Evidence()).toMatchObject({ status: 'failed', phase: 'cpu_load', requiresForceStop: true, failureCode: 'timeout' });
    expect(mockLoad).toHaveBeenCalledTimes(1); expect(mockUnload).not.toHaveBeenCalled(); expect(mockRestoreThread).not.toHaveBeenCalled();
    resolveLoad(); await Promise.resolve(); await Promise.resolve();
    expect(getAndroidQaStage3Evidence().status).toBe('failed');
    expect(mockLoad).toHaveBeenCalledTimes(1); expect(mockUpdateSettings).not.toHaveBeenCalled();
  });
  it('restores the original confirmed load profile after a settled assertion failure', async () => {
    await runAndroidQaStage3();
    expect(getAndroidQaStage3Evidence()).toMatchObject({ status: 'failed', failureCode: 'assertion', requiresForceStop: false });
    expect(mockLoad).toHaveBeenLastCalledWith('qa-chat', { forceReload: true, loadParamsOverride: { contextSize: 512 } });
    expect(mockRestoreThread).toHaveBeenCalledWith('original');
    expect(mockUpdateSettings).toHaveBeenCalledWith({ auxiliaryModels: {} });
  });
});
