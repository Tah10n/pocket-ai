import React, { useEffect } from 'react';
import { act, render, waitFor } from '@testing-library/react-native';
import { Alert, Linking } from 'react-native';
import { useModelDetailsController } from '../../src/hooks/useModelDetailsController';
import { AppError } from '../../src/services/AppError';
import { EngineStatus, LifecycleStatus, ModelAccessState, type ModelMetadata } from '../../src/types/models';

const mockRouter = {
  push: jest.fn(),
  replace: jest.fn(),
  back: jest.fn(),
  canGoBack: jest.fn(() => true),
};

const mockStartDownload = jest.fn();
const mockCancelDownload = jest.fn();
const mockLoadModel = jest.fn();
const mockUnloadModel = jest.fn();
const mockOpenErrorReport = jest.fn();
const mockOpenModelParameters = jest.fn();
const mockCloseModelParameters = jest.fn();
const mockGetCachedModel = jest.fn();
const mockGetModelDetails = jest.fn();
const mockGetModelCatalogErrorMessage = jest.fn((_: unknown) => 'catalog-error');
const mockRegistryGetModel = jest.fn();
const mockOffloadModel = jest.fn();
const mockPromptModelLoadMemoryPolicyIfNeeded = jest.fn();
const mockHandleModelLoadMemoryPolicyError = jest.fn();
const mockGetLastModelLoadError = jest.fn();
const mockClearLastModelLoadError = jest.fn();

let mockDownloadQueue: Array<{ id: string }> = [];
const mockEngineState = {
  status: EngineStatus.IDLE,
  activeModelId: undefined as string | undefined,
  loadProgress: 0,
  lastError: null as string | null,
};

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
}));

jest.mock('@/hooks/useLLMEngine', () => ({
  useLLMEngine: () => ({
    loadModel: mockLoadModel,
    unloadModel: mockUnloadModel,
    state: mockEngineState,
  }),
}));

jest.mock('@/hooks/useModelParametersSheetController', () => ({
  useModelParametersSheetController: () => ({
    openModelParameters: mockOpenModelParameters,
    closeModelParameters: mockCloseModelParameters,
    sheetProps: { visible: false },
  }),
}));

jest.mock('@/hooks/useModelDownload', () => ({
  useModelDownload: () => ({
    startDownload: mockStartDownload,
    cancelDownload: mockCancelDownload,
  }),
}));

jest.mock('@/hooks/useModelRegistryRevision', () => ({
  useModelRegistryRevision: () => 0,
}));

jest.mock('@/hooks/useErrorReportSheetController', () => ({
  useErrorReportSheetController: () => ({
    openErrorReport: mockOpenErrorReport,
    sheetProps: { visible: false },
  }),
}));

jest.mock('@/store/downloadStore', () => ({
  useDownloadStore: (selector: (state: { queue: Array<{ id: string }> }) => unknown) => selector({ queue: mockDownloadQueue }),
}));

jest.mock('@/services/ModelCatalogService', () => ({
  getHuggingFaceModelUrl: (modelId: string) => `https://huggingface.co/${modelId}`,
  getModelCatalogErrorMessage: (error: unknown) => mockGetModelCatalogErrorMessage(error),
  modelCatalogService: {
    getCachedModel: (modelId: string) => mockGetCachedModel(modelId),
    getModelDetails: (modelId: string) => mockGetModelDetails(modelId),
  },
}));

jest.mock('@/services/StorageManagerService', () => ({
  offloadModel: (...args: Parameters<typeof mockOffloadModel>) => mockOffloadModel(...args),
}));

jest.mock('@/services/LocalStorageRegistry', () => ({
  registry: {
    getModel: (...args: Parameters<typeof mockRegistryGetModel>) => mockRegistryGetModel(...args),
  },
}));

jest.mock('@/services/LLMEngineService', () => ({
  llmEngineService: {
    getLastModelLoadError: () => mockGetLastModelLoadError(),
    clearLastModelLoadError: () => mockClearLastModelLoadError(),
  },
}));

jest.mock('../../src/utils/modelLoadMemoryPolicyPrompt', () => ({
  promptModelLoadMemoryPolicyIfNeeded: (...args: Parameters<typeof mockPromptModelLoadMemoryPolicyIfNeeded>) => (
    mockPromptModelLoadMemoryPolicyIfNeeded(...args)
  ),
  handleModelLoadMemoryPolicyError: (...args: Parameters<typeof mockHandleModelLoadMemoryPolicyError>) => (
    mockHandleModelLoadMemoryPolicyError(...args)
  ),
}));

jest.mock('../../src/utils/modelDownloadFlow', () => ({
  startModelDownloadFlow: jest.fn(),
}));

function buildModel(overrides: Partial<ModelMetadata> = {}): ModelMetadata {
  return {
    id: 'org/model',
    name: 'Test Model',
    author: 'org',
    size: 1024,
    downloadUrl: 'https://huggingface.co/org/model/resolve/main/model.gguf',
    resolvedFileName: 'model.gguf',
    fitsInRam: true,
    accessState: ModelAccessState.PUBLIC,
    isGated: false,
    isPrivate: false,
    lifecycleStatus: LifecycleStatus.DOWNLOADED,
    downloadProgress: 1,
    ...overrides,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useModelDetailsController', () => {
  let alertSpy: jest.SpiedFunction<typeof Alert.alert>;
  let openUrlSpy: jest.SpiedFunction<typeof Linking.openURL>;
  let consoleErrorSpy: jest.SpiedFunction<typeof console.error>;

  function renderHookHarness(initialModelId = 'org/model') {
    let currentValue: ReturnType<typeof useModelDetailsController> | null = null;

    const Harness = ({ modelId }: { modelId: string }) => {
      const value = useModelDetailsController(modelId);

      useEffect(() => {
        currentValue = value;
      }, [value]);

      return null;
    };

    const rendered = render(<Harness modelId={initialModelId} />);

    return {
      getCurrentValue: () => currentValue,
      rerenderWithModelId: (modelId: string) => rendered.rerender(<Harness modelId={modelId} />),
      ...rendered,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockDownloadQueue = [];
    mockEngineState.status = EngineStatus.IDLE;
    mockEngineState.activeModelId = undefined;
    mockEngineState.loadProgress = 0;
    mockEngineState.lastError = null;
    mockLoadModel.mockResolvedValue(undefined);
    mockUnloadModel.mockResolvedValue(undefined);
    mockGetCachedModel.mockImplementation((modelId: string) => buildModel({ id: modelId }));
    mockGetModelDetails.mockImplementation((modelId: string) => Promise.resolve(buildModel({ id: modelId })));
    mockRegistryGetModel.mockReturnValue(undefined);
    mockOffloadModel.mockResolvedValue(undefined);
    mockPromptModelLoadMemoryPolicyIfNeeded.mockReturnValue(false);
    mockHandleModelLoadMemoryPolicyError.mockReturnValue(false);
    mockGetLastModelLoadError.mockReturnValue(null);

    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
    openUrlSpy = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined as never);
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    alertSpy.mockRestore();
    openUrlSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('marks an empty model id as missing without fetching details', async () => {
    const { getCurrentValue } = renderHookHarness('');

    await waitFor(() => {
      expect(getCurrentValue()?.loading).toBe(false);
    });

    expect(getCurrentValue()?.errorMessage).toBe('models.detailMissingModel');
    expect(getCurrentValue()?.displayModel).toBeNull();
    expect(mockGetModelDetails).not.toHaveBeenCalled();
  });

  it('shows a placeholder while uncached model details are still loading', async () => {
    const deferred = createDeferred<ModelMetadata>();
    mockGetCachedModel.mockReturnValue(undefined);
    mockGetModelDetails.mockReturnValue(deferred.promise);

    const { getCurrentValue } = renderHookHarness('author/new-model');

    expect(getCurrentValue()?.loading).toBe(true);
    expect(getCurrentValue()?.displayModel?.id).toBe('author/new-model');

    await act(async () => {
      deferred.resolve(buildModel({ id: 'author/new-model', name: 'Resolved Model' }));
      await deferred.promise;
    });

    await waitFor(() => {
      expect(getCurrentValue()?.loading).toBe(false);
    });

    expect(getCurrentValue()?.displayModel?.name).toBe('Resolved Model');
  });

  it('falls back to the cached model and an error message when catalog loading fails', async () => {
    const cachedModel = buildModel({ name: 'Cached Model' });
    mockGetCachedModel.mockReturnValue(cachedModel);
    mockGetModelDetails.mockRejectedValueOnce(new Error('network failed'));

    const { getCurrentValue } = renderHookHarness();

    await waitFor(() => {
      expect(getCurrentValue()?.loading).toBe(false);
    });

    expect(getCurrentValue()?.errorMessage).toBe('catalog-error');
    expect(getCurrentValue()?.displayModel?.name).toBe('Cached Model');
  });

  it('shows a plain alert when opening the Hugging Face page fails', async () => {
    openUrlSpy.mockRejectedValueOnce(new Error('open failed') as never);
    const { getCurrentValue } = renderHookHarness();

    await waitFor(() => {
      expect(getCurrentValue()?.loading).toBe(false);
    });

    await act(async () => {
      await getCurrentValue()?.handleOpenModelPage();
    });

    expect(alertSpy).toHaveBeenLastCalledWith('models.actionFailedTitle', 'open failed');
  });

  it('offers error reporting for reportable unload failures', async () => {
    mockUnloadModel.mockRejectedValueOnce(new AppError('model_load_failed', 'load failed'));
    const { getCurrentValue } = renderHookHarness();

    await waitFor(() => {
      expect(getCurrentValue()?.loading).toBe(false);
    });

    await act(async () => {
      await getCurrentValue()?.handleUnload();
    });

    const buttons = alertSpy.mock.calls.at(-1)?.[2] as Array<{ text: string; onPress?: () => void }>;
    expect(buttons[1]?.text).toBe('models.errorReport.reportButton');

    act(() => {
      buttons[1]?.onPress?.();
    });

    expect(mockOpenErrorReport).toHaveBeenCalledWith({
      scope: 'ModelDetailsScreen.handleUnload',
      error: expect.any(AppError),
      context: undefined,
    });
  });

  it('does not call loadModel when the memory policy prompt blocks loading', async () => {
    mockPromptModelLoadMemoryPolicyIfNeeded.mockReturnValueOnce(true);
    const { getCurrentValue } = renderHookHarness();

    await waitFor(() => {
      expect(getCurrentValue()?.loading).toBe(false);
    });

    await act(async () => {
      await getCurrentValue()?.handleLoad();
    });

    expect(mockPromptModelLoadMemoryPolicyIfNeeded).toHaveBeenCalled();
    expect(mockLoadModel).not.toHaveBeenCalled();
  });

  it('shows a plain alert for generic model load failures', async () => {
    mockLoadModel.mockRejectedValueOnce(new Error('load exploded'));
    const { getCurrentValue } = renderHookHarness();

    await waitFor(() => {
      expect(getCurrentValue()?.loading).toBe(false);
    });

    await act(async () => {
      await getCurrentValue()?.handleLoad();
    });

    expect(mockLoadModel).toHaveBeenCalledWith('org/model', undefined);
    expect(alertSpy).toHaveBeenLastCalledWith('models.actionFailedTitle', 'load exploded');
  });

  it('offloads the model with preserved settings and applies the deleted state', async () => {
    const model = buildModel({
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      localPath: 'models/model.gguf',
      downloadedAt: 123,
      resumeData: 'resume-data',
    });
    mockGetCachedModel.mockReturnValue(model);
    mockGetModelDetails.mockResolvedValue(model);

    const { getCurrentValue } = renderHookHarness();

    await waitFor(() => {
      expect(getCurrentValue()?.displayModel?.lifecycleStatus).toBe(LifecycleStatus.DOWNLOADED);
    });

    await act(async () => {
      getCurrentValue()?.handleDelete();
    });

    const confirmButtons = alertSpy.mock.calls.at(-1)?.[2] as Array<{ onPress?: () => Promise<void> | void }>;

    await act(async () => {
      await confirmButtons[1]?.onPress?.();
    });

    expect(mockOffloadModel).toHaveBeenCalledWith('org/model', { preserveSettings: true });
    expect(mockCloseModelParameters).toHaveBeenCalled();
    expect(getCurrentValue()?.displayModel?.lifecycleStatus).toBe(LifecycleStatus.AVAILABLE);
    expect(getCurrentValue()?.displayModel?.downloadProgress).toBe(0);
    expect(getCurrentValue()?.displayModel?.localPath).toBeUndefined();
  });

  it('surfaces reset-settings deletion failures', async () => {
    mockOffloadModel.mockRejectedValueOnce(new Error('delete failed'));
    const { getCurrentValue } = renderHookHarness();

    await waitFor(() => {
      expect(getCurrentValue()?.loading).toBe(false);
    });

    await act(async () => {
      getCurrentValue()?.handleDelete();
    });

    const confirmButtons = alertSpy.mock.calls.at(-1)?.[2] as Array<{ onPress?: () => Promise<void> | void }>;
    alertSpy.mockClear();

    await act(async () => {
      await confirmButtons[2]?.onPress?.();
    });

    expect(mockOffloadModel).toHaveBeenCalledWith('org/model', { preserveSettings: false });
    expect(alertSpy).toHaveBeenLastCalledWith('models.actionFailedTitle', 'delete failed');
  });

  it('opens an error report using the last engine error details', async () => {
    const model = buildModel({ id: 'org/loaded-model', name: 'Loaded Model' });
    mockEngineState.activeModelId = 'org/loaded-model';
    mockEngineState.status = EngineStatus.ERROR;
    mockEngineState.lastError = 'Model load failed';
    mockRegistryGetModel.mockReturnValue(model);
    mockGetLastModelLoadError.mockReturnValue({
      scope: 'LLMEngineService.load',
      error: new AppError('model_load_failed', 'load failed', {
        details: {
          modelId: 'org/loaded-model',
          allowUnsafeMemoryLoad: true,
          forceReload: false,
        },
      }),
    });

    const { getCurrentValue } = renderHookHarness('org/loaded-model');

    await waitFor(() => {
      expect(getCurrentValue()?.loading).toBe(false);
    });

    act(() => {
      getCurrentValue()?.reportEngineError();
    });

    expect(mockOpenErrorReport).toHaveBeenCalledWith({
      scope: 'LLMEngineService.load',
      error: expect.any(AppError),
      context: expect.objectContaining({
        model: expect.objectContaining({ id: 'org/loaded-model', name: 'Loaded Model' }),
        engine: expect.objectContaining({ status: EngineStatus.ERROR, activeModelId: 'org/loaded-model' }),
        options: {
          allowUnsafeMemoryLoad: true,
          forceReload: false,
        },
      }),
    });
  });
});
