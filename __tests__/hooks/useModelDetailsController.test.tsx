import React, { useEffect } from 'react';
import { act, render, waitFor } from '@testing-library/react-native';
import { Alert, Linking } from 'react-native';
import { useModelDetailsController } from '../../src/hooks/useModelDetailsController';
import { AppError } from '../../src/services/AppError';
import { EngineStatus, LifecycleStatus, ModelAccessState, type ModelMetadata } from '../../src/types/models';
import {
  buildLegacyProjectorArtifactId,
  buildProjectorArtifactId,
} from '../../src/utils/modelProjectors';

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
const mockRegistryUpdateModel = jest.fn();
const mockOffloadModel = jest.fn();
const mockPromptModelLoadMemoryPolicyIfNeeded = jest.fn();
const mockHandleModelLoadMemoryPolicyError = jest.fn();
const mockGetLastModelLoadError = jest.fn();
const mockClearLastModelLoadError = jest.fn();
const mockRequestActiveMultimodalReadinessRefresh = jest.fn();

let mockDownloadQueue: ModelMetadata[] = [];
const mockEngineState = {
  status: EngineStatus.IDLE,
  activeModelId: undefined as string | undefined,
  loadProgress: 0,
  lastError: null as string | null,
  diagnostics: undefined as Record<string, unknown> | undefined,
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
    updateModel: (...args: Parameters<typeof mockRegistryUpdateModel>) => mockRegistryUpdateModel(...args),
  },
}));

jest.mock('@/services/LLMEngineService', () => ({
  llmEngineService: {
    getLastModelLoadError: () => mockGetLastModelLoadError(),
    clearLastModelLoadError: () => mockClearLastModelLoadError(),
    requestActiveMultimodalReadinessRefresh: (...args: Parameters<typeof mockRequestActiveMultimodalReadinessRefresh>) => (
      mockRequestActiveMultimodalReadinessRefresh(...args)
    ),
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

function getCanonicalProjectorId(fileName: string, ownerVariantId?: string): string {
  return buildProjectorArtifactId({
    repoId: 'org/model',
    hfRevision: 'main',
    ...(ownerVariantId ? { ownerVariantId } : {}),
    fileName,
  });
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

  function renderHookHarness(initialModelId = 'org/model', initialVariantId?: string) {
    let currentValue: ReturnType<typeof useModelDetailsController> | null = null;

    const Harness = ({ modelId, variantId }: { modelId: string; variantId?: string }) => {
      const value = useModelDetailsController(modelId, variantId);

      useEffect(() => {
        currentValue = value;
      }, [value]);

      return null;
    };

    const rendered = render(<Harness modelId={initialModelId} variantId={initialVariantId} />);

    return {
      getCurrentValue: () => currentValue,
      rerenderWithModelId: (modelId: string) => rendered.rerender(<Harness modelId={modelId} variantId={initialVariantId} />),
      rerenderWithVariantId: (variantId?: string) => rendered.rerender(<Harness modelId={initialModelId} variantId={variantId} />),
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
    mockEngineState.diagnostics = undefined;
    mockLoadModel.mockResolvedValue(undefined);
    mockUnloadModel.mockResolvedValue(undefined);
    mockGetCachedModel.mockImplementation((modelId: string) => buildModel({ id: modelId }));
    mockGetModelDetails.mockImplementation((modelId: string) => Promise.resolve(buildModel({ id: modelId })));
    mockRegistryGetModel.mockReturnValue(undefined);
    mockRegistryUpdateModel.mockImplementation(jest.fn());
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

  it('preserves a user-selected variant when delayed model details resolve', async () => {
    const deferred = createDeferred<ModelMetadata>();
    const cachedModel = buildModel({
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      resolvedFileName: 'model.Q4_K_M.gguf',
      activeVariantId: 'model.Q4_K_M.gguf',
      variants: [
        {
          variantId: 'model.Q4_K_M.gguf',
          fileName: 'model.Q4_K_M.gguf',
          quantizationLabel: 'Q4_K_M',
          size: 4_000_000_000,
        },
        {
          variantId: 'model.Q8_0.gguf',
          fileName: 'model.Q8_0.gguf',
          quantizationLabel: 'Q8_0',
          size: 8_000_000_000,
          ramFit: 'likely_oom',
          ramFitConfidence: 'medium',
        },
      ],
    });
    mockGetCachedModel.mockReturnValue(cachedModel);
    mockGetModelDetails.mockReturnValue(deferred.promise);

    const { getCurrentValue } = renderHookHarness();

    act(() => {
      getCurrentValue()?.handleSelectVariant('model.Q8_0.gguf');
    });

    expect(getCurrentValue()?.displayModel).toEqual(expect.objectContaining({
      resolvedFileName: 'model.Q8_0.gguf',
      activeVariantId: 'model.Q8_0.gguf',
    }));

    await act(async () => {
      deferred.resolve(buildModel({
        name: 'Resolved Model',
        lifecycleStatus: LifecycleStatus.AVAILABLE,
        downloadProgress: 0,
        resolvedFileName: 'model.Q4_K_M.gguf',
        activeVariantId: 'model.Q4_K_M.gguf',
        variants: [cachedModel.variants![0]],
      }));
      await deferred.promise;
    });

    await waitFor(() => {
      expect(getCurrentValue()?.loading).toBe(false);
    });

    expect(getCurrentValue()?.displayModel).toEqual(expect.objectContaining({
      name: 'Resolved Model',
      resolvedFileName: 'model.Q8_0.gguf',
      activeVariantId: 'model.Q8_0.gguf',
      memoryFitDecision: 'likely_oom',
      fitsInRam: false,
    }));
  });

  it('applies an initial variant from navigation params after model details resolve', async () => {
    const cachedModel = buildModel({
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      resolvedFileName: 'model.Q4_K_M.gguf',
      activeVariantId: 'model.Q4_K_M.gguf',
      variants: [
        {
          variantId: 'model.Q4_K_M.gguf',
          fileName: 'model.Q4_K_M.gguf',
          quantizationLabel: 'Q4_K_M',
          size: 4_000_000_000,
        },
        {
          variantId: 'model.Q8_0.gguf',
          fileName: 'model.Q8_0.gguf',
          quantizationLabel: 'Q8_0',
          size: 8_000_000_000,
          ramFit: 'likely_oom',
          ramFitConfidence: 'medium',
        },
      ],
    });
    mockGetCachedModel.mockReturnValue(cachedModel);
    mockGetModelDetails.mockResolvedValue(cachedModel);

    const { getCurrentValue } = renderHookHarness('org/model', 'model.Q8_0.gguf');

    await waitFor(() => {
      expect(getCurrentValue()?.loading).toBe(false);
    });

    expect(getCurrentValue()?.displayModel).toEqual(expect.objectContaining({
      resolvedFileName: 'model.Q8_0.gguf',
      activeVariantId: 'model.Q8_0.gguf',
      memoryFitDecision: 'likely_oom',
    }));
  });

  it('ignores an initial variant param that would switch a paused model', async () => {
    const pausedModel = buildModel({
      lifecycleStatus: LifecycleStatus.PAUSED,
      downloadProgress: 0.5,
      resumeData: JSON.stringify({ resumeData: 'resume-q4' }),
      resolvedFileName: 'model.Q4_K_M.gguf',
      activeVariantId: 'model.Q4_K_M.gguf',
      variants: [
        {
          variantId: 'model.Q4_K_M.gguf',
          fileName: 'model.Q4_K_M.gguf',
          quantizationLabel: 'Q4_K_M',
          size: 4_000_000_000,
        },
        {
          variantId: 'model.Q8_0.gguf',
          fileName: 'model.Q8_0.gguf',
          quantizationLabel: 'Q8_0',
          size: 8_000_000_000,
        },
      ],
    });
    mockGetCachedModel.mockReturnValue(pausedModel);
    mockGetModelDetails.mockResolvedValue(pausedModel);

    const { getCurrentValue } = renderHookHarness('org/model', 'model.Q8_0.gguf');

    await waitFor(() => {
      expect(getCurrentValue()?.loading).toBe(false);
    });

    expect(getCurrentValue()?.displayModel).toEqual(expect.objectContaining({
      resolvedFileName: 'model.Q4_K_M.gguf',
      activeVariantId: 'model.Q4_K_M.gguf',
      lifecycleStatus: LifecycleStatus.PAUSED,
      downloadProgress: 0.5,
    }));
  });

  it('clears an initial variant when navigation params drop it for the same model', async () => {
    const cachedModel = buildModel({
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      resolvedFileName: 'model.Q4_K_M.gguf',
      activeVariantId: 'model.Q4_K_M.gguf',
      variants: [
        {
          variantId: 'model.Q4_K_M.gguf',
          fileName: 'model.Q4_K_M.gguf',
          quantizationLabel: 'Q4_K_M',
          size: 4_000_000_000,
        },
        {
          variantId: 'model.Q8_0.gguf',
          fileName: 'model.Q8_0.gguf',
          quantizationLabel: 'Q8_0',
          size: 8_000_000_000,
          ramFit: 'likely_oom',
          ramFitConfidence: 'medium',
        },
      ],
    });
    mockGetCachedModel.mockReturnValue(cachedModel);
    mockGetModelDetails.mockResolvedValue(cachedModel);

    const { getCurrentValue, rerenderWithVariantId } = renderHookHarness('org/model', 'model.Q8_0.gguf');

    await waitFor(() => {
      expect(getCurrentValue()?.loading).toBe(false);
    });

    expect(getCurrentValue()?.displayModel?.activeVariantId).toBe('model.Q8_0.gguf');

    rerenderWithVariantId(undefined);

    await waitFor(() => {
      expect(getCurrentValue()?.loading).toBe(false);
    });

    expect(getCurrentValue()?.displayModel).toEqual(expect.objectContaining({
      resolvedFileName: 'model.Q4_K_M.gguf',
      activeVariantId: 'model.Q4_K_M.gguf',
    }));
    expect(getCurrentValue()?.displayModel?.memoryFitDecision).toBeUndefined();
  });

  it('ignores explicit variant selection while the model is paused', async () => {
    const model = buildModel({
      lifecycleStatus: LifecycleStatus.PAUSED,
      downloadProgress: 0.5,
      resumeData: JSON.stringify({ resumeData: 'resume-q4' }),
      resolvedFileName: 'model.Q4_K_M.gguf',
      activeVariantId: 'model.Q4_K_M.gguf',
      variants: [
        {
          variantId: 'model.Q4_K_M.gguf',
          fileName: 'model.Q4_K_M.gguf',
          quantizationLabel: 'Q4_K_M',
          size: 4_000_000_000,
        },
        {
          variantId: 'model.Q8_0.gguf',
          fileName: 'model.Q8_0.gguf',
          quantizationLabel: 'Q8_0',
          size: 8_000_000_000,
          ramFit: 'likely_oom',
          ramFitConfidence: 'medium',
        },
      ],
    });
    mockGetCachedModel.mockReturnValue(model);
    mockGetModelDetails.mockResolvedValue(model);

    const { getCurrentValue } = renderHookHarness();

    await waitFor(() => {
      expect(getCurrentValue()?.loading).toBe(false);
    });

    act(() => {
      getCurrentValue()?.handleSelectVariant('model.Q8_0.gguf');
    });

    expect(getCurrentValue()?.displayModel).toEqual(expect.objectContaining({
      resolvedFileName: 'model.Q4_K_M.gguf',
      activeVariantId: 'model.Q4_K_M.gguf',
      lifecycleStatus: LifecycleStatus.PAUSED,
      downloadProgress: 0.5,
      resumeData: JSON.stringify({ resumeData: 'resume-q4' }),
    }));
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

  it('shows a reportable alert when a memory-insufficient load error is not consumed by policy handling', async () => {
    const error = new AppError('model_memory_insufficient', 'minimum context still exceeds budget');
    mockLoadModel.mockRejectedValueOnce(error);
    const { getCurrentValue } = renderHookHarness();

    await waitFor(() => {
      expect(getCurrentValue()?.loading).toBe(false);
    });

    await act(async () => {
      await getCurrentValue()?.handleLoad();
    });

    expect(mockHandleModelLoadMemoryPolicyError).toHaveBeenCalledWith(expect.objectContaining({
      appError: error,
    }));
    expect(alertSpy).toHaveBeenLastCalledWith(
      'models.actionFailedTitle',
      'common.errors.modelMemoryInsufficient',
      expect.any(Array),
    );

    const buttons = alertSpy.mock.calls.at(-1)?.[2] as Array<{ text: string; onPress?: () => void }>;
    expect(buttons[1]?.text).toBe('models.errorReport.reportButton');

    act(() => {
      buttons[1]?.onPress?.();
    });

    expect(mockOpenErrorReport).toHaveBeenCalledWith({
      scope: 'ModelDetailsScreen.performLoad',
      error,
      context: expect.objectContaining({
        model: expect.objectContaining({ id: 'org/model' }),
        engine: expect.objectContaining({ status: EngineStatus.IDLE }),
      }),
    });
  });

  it('continues a pending download after choosing a projector from the details choice sheet', async () => {
    const selectedProjectorId = getCanonicalProjectorId('mmproj-b.gguf');
    const ambiguousVisionModel = buildModel({
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      chatModalities: ['text', 'vision'],
      projectorCandidates: [
        {
          id: 'projector-a',
          ownerModelId: 'org/model',
          repoId: 'org/model',
          fileName: 'mmproj-a.gguf',
          downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-a.gguf',
          size: 512_000_000,
          lifecycleStatus: 'available',
          matchStatus: 'ambiguous',
        },
        {
          id: 'projector-b',
          ownerModelId: 'org/model',
          repoId: 'org/model',
          fileName: 'mmproj-b.gguf',
          downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-b.gguf',
          size: 256_000_000,
          lifecycleStatus: 'available',
          matchStatus: 'ambiguous',
        },
      ],
    });
    const { startModelDownloadFlow } = jest.requireMock('../../src/utils/modelDownloadFlow') as {
      startModelDownloadFlow: jest.Mock;
    };
    startModelDownloadFlow.mockImplementationOnce(({ onProjectorChoiceRequired }) => {
      onProjectorChoiceRequired?.(ambiguousVisionModel);
    });
    mockGetCachedModel.mockReturnValue(ambiguousVisionModel);
    mockGetModelDetails.mockResolvedValue(ambiguousVisionModel);

    const { getCurrentValue } = renderHookHarness();

    await waitFor(() => {
      expect(getCurrentValue()?.loading).toBe(false);
    });

    act(() => {
      getCurrentValue()?.handleDownload(getCurrentValue()?.displayModel as ModelMetadata);
    });

    expect(getCurrentValue()?.isProjectorChoiceVisible).toBe(true);
    expect(startModelDownloadFlow).toHaveBeenCalledTimes(1);

    act(() => {
      getCurrentValue()?.handleSelectProjector(selectedProjectorId);
    });

    expect(startModelDownloadFlow).toHaveBeenCalledTimes(2);
    expect(startModelDownloadFlow).toHaveBeenLastCalledWith(expect.objectContaining({
      model: expect.objectContaining({
        id: 'org/model',
        selectedProjectorId,
        projectorCandidates: expect.arrayContaining([
          expect.objectContaining({
            id: selectedProjectorId,
            matchStatus: 'user_selected',
            matchReason: 'user_selected_projector',
          }),
        ]),
      }),
    }));
  });

  it('starts projector download after choosing an undownloaded projector for a downloaded model', async () => {
    const { startModelDownloadFlow } = jest.requireMock('../../src/utils/modelDownloadFlow') as {
      startModelDownloadFlow: jest.Mock;
    };
    const selectedProjectorId = getCanonicalProjectorId('fresh-mmproj-b.gguf');
    const freshVisionModel = buildModel({
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      fitsInRam: true,
      memoryFitDecision: 'fits_high_confidence',
      memoryFitConfidence: 'high',
      chatModalities: ['text', 'vision'],
      visionSource: 'catalog_metadata',
      projectorCandidates: [
        {
          id: 'projector-a',
          ownerModelId: 'org/model',
          repoId: 'org/model',
          fileName: 'fresh-mmproj-a.gguf',
          downloadUrl: 'https://huggingface.co/org/model/resolve/main/fresh-mmproj-a.gguf',
          size: 512_000_000,
          lifecycleStatus: 'available',
          matchStatus: 'ambiguous',
        },
        {
          id: 'projector-b',
          ownerModelId: 'org/model',
          repoId: 'org/model',
          fileName: 'fresh-mmproj-b.gguf',
          downloadUrl: 'https://huggingface.co/org/model/resolve/main/fresh-mmproj-b.gguf',
          size: 256_000_000,
          lifecycleStatus: 'available',
          matchStatus: 'ambiguous',
        },
      ],
    });
    let persistedModel = buildModel({
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      localPath: 'models/model.gguf',
      downloadProgress: 1,
      fitsInRam: false,
      memoryFitDecision: 'likely_oom',
      memoryFitConfidence: 'high',
      chatModalities: ['text', 'vision'],
      visionSource: 'tree_probe',
      projectorCandidates: [
        {
          id: 'stale-projector-a',
          ownerModelId: 'org/model',
          repoId: 'org/model',
          fileName: 'stale-mmproj-a.gguf',
          downloadUrl: 'https://huggingface.co/org/model/resolve/main/stale-mmproj-a.gguf',
          size: 111_000_000,
          lifecycleStatus: 'available',
          matchStatus: 'ambiguous',
        },
        {
          id: 'stale-projector-b',
          ownerModelId: 'org/model',
          repoId: 'org/model',
          fileName: 'stale-mmproj-b.gguf',
          downloadUrl: 'https://huggingface.co/org/model/resolve/main/stale-mmproj-b.gguf',
          size: 222_000_000,
          lifecycleStatus: 'downloaded',
          localPath: 'models/stale-mmproj-b.gguf',
          matchStatus: 'ambiguous',
        },
      ],
    });
    mockRegistryGetModel.mockImplementation(() => persistedModel);
    mockRegistryUpdateModel.mockImplementation((nextModel: ModelMetadata) => {
      persistedModel = nextModel;
    });
    mockGetCachedModel.mockReturnValue(freshVisionModel);
    mockGetModelDetails.mockResolvedValue(freshVisionModel);

    const { getCurrentValue } = renderHookHarness();

    await waitFor(() => {
      expect(getCurrentValue()?.loading).toBe(false);
    });

    act(() => {
      getCurrentValue()?.openProjectorChoice();
    });

    act(() => {
      getCurrentValue()?.handleSelectProjector(selectedProjectorId);
    });

    const selectedProjector = getCurrentValue()?.displayModel?.projectorCandidates?.find((projector) => (
      projector.id === selectedProjectorId
    ));

    expect(getCurrentValue()?.displayModel).toEqual(expect.objectContaining({
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      localPath: 'models/model.gguf',
      selectedProjectorId,
      fitsInRam: null,
      memoryFitDecision: undefined,
      memoryFitConfidence: undefined,
      visionSource: 'user_selected_projector',
    }));
    expect(mockRegistryUpdateModel).toHaveBeenLastCalledWith(expect.objectContaining({
      selectedProjectorId,
      fitsInRam: null,
      memoryFitDecision: undefined,
      memoryFitConfidence: undefined,
    }));
    expect(selectedProjector).toEqual(expect.objectContaining({
      fileName: 'fresh-mmproj-b.gguf',
      downloadUrl: 'https://huggingface.co/org/model/resolve/main/fresh-mmproj-b.gguf',
      size: 256_000_000,
      lifecycleStatus: 'available',
      matchStatus: 'user_selected',
      matchReason: 'user_selected_projector',
    }));
    expect(selectedProjector?.localPath).toBeUndefined();
    expect(startModelDownloadFlow).toHaveBeenCalledTimes(1);
    expect(startModelDownloadFlow).toHaveBeenCalledWith(expect.objectContaining({
      model: expect.objectContaining({
        id: 'org/model',
        lifecycleStatus: LifecycleStatus.DOWNLOADED,
        localPath: 'models/model.gguf',
        selectedProjectorId,
        fitsInRam: null,
        memoryFitDecision: undefined,
        memoryFitConfidence: undefined,
        projectorCandidates: expect.arrayContaining([
          expect.objectContaining({
            id: selectedProjectorId,
            fileName: 'fresh-mmproj-b.gguf',
            downloadUrl: 'https://huggingface.co/org/model/resolve/main/fresh-mmproj-b.gguf',
            lifecycleStatus: 'available',
            matchStatus: 'user_selected',
          }),
        ]),
      }),
    }));
  });

  it('retains inactive variant projector runtime state when choosing from a scoped details model', async () => {
    const selectedProjectorId = getCanonicalProjectorId('mmproj-q4-b.gguf', 'variant-q4');
    const q4ProjectorAId = getCanonicalProjectorId('mmproj-q4-a.gguf', 'variant-q4');
    const inactiveQ8ProjectorId = getCanonicalProjectorId('mmproj-q8.gguf', 'variant-q8');
    const q4ProjectorA = {
      id: 'projector-q4-a',
      ownerModelId: 'org/model',
      ownerVariantId: 'variant-q4',
      repoId: 'org/model',
      fileName: 'mmproj-q4-a.gguf',
      downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-q4-a.gguf',
      size: 256_000_000,
      lifecycleStatus: 'available' as const,
      matchStatus: 'ambiguous' as const,
    };
    const q4ProjectorB = {
      id: 'projector-q4-b',
      ownerModelId: 'org/model',
      ownerVariantId: 'variant-q4',
      repoId: 'org/model',
      fileName: 'mmproj-q4-b.gguf',
      downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-q4-b.gguf',
      size: 300_000_000,
      lifecycleStatus: 'available' as const,
      matchStatus: 'ambiguous' as const,
    };
    const inactiveQ8Projector = {
      id: 'projector-q8-downloaded',
      ownerModelId: 'org/model',
      ownerVariantId: 'variant-q8',
      repoId: 'org/model',
      fileName: 'mmproj-q8.gguf',
      downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-q8.gguf',
      size: 512_000_000,
      lifecycleStatus: 'downloaded' as const,
      localPath: 'mmproj-q8.gguf',
      matchStatus: 'ambiguous' as const,
    };
    const variantVisionModel = buildModel({
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      localPath: 'models/model-q4.gguf',
      activeVariantId: 'variant-q4',
      resolvedFileName: 'model-q4.gguf',
      chatModalities: ['text', 'vision'],
      projectorCandidates: [q4ProjectorA, q4ProjectorB, inactiveQ8Projector],
      variants: [
        {
          variantId: 'variant-q4',
          fileName: 'model-q4.gguf',
          quantizationLabel: 'Q4_K_M',
          size: 4_000_000_000,
          chatModalities: ['text', 'vision'],
          projectorCandidates: [q4ProjectorA, q4ProjectorB],
        },
        {
          variantId: 'variant-q8',
          fileName: 'model-q8.gguf',
          quantizationLabel: 'Q8_0',
          size: 8_000_000_000,
          chatModalities: ['text', 'vision'],
          projectorCandidates: [inactiveQ8Projector],
        },
      ],
    });
    let persistedModel = variantVisionModel;
    mockRegistryGetModel.mockImplementation(() => persistedModel);
    mockRegistryUpdateModel.mockImplementation((nextModel: ModelMetadata) => {
      persistedModel = nextModel;
    });
    mockGetCachedModel.mockReturnValue(variantVisionModel);
    mockGetModelDetails.mockResolvedValue(variantVisionModel);

    const { getCurrentValue } = renderHookHarness();

    await waitFor(() => {
      expect(getCurrentValue()?.loading).toBe(false);
    });

    const scopedDetailsChoiceModel = {
      ...(getCurrentValue()?.displayModel as ModelMetadata),
      projectorCandidates: getCurrentValue()?.displayModel?.projectorCandidates?.filter((projector) => (
        projector.ownerVariantId === 'variant-q4'
      )),
      selectedProjectorId: undefined,
    };

    act(() => {
      getCurrentValue()?.openProjectorChoice(scopedDetailsChoiceModel);
    });

    act(() => {
      getCurrentValue()?.handleSelectProjector(selectedProjectorId);
    });

    const lastPersistedModel = mockRegistryUpdateModel.mock.calls.at(-1)?.[0] as ModelMetadata;
    expect(lastPersistedModel).toEqual(expect.objectContaining({
      selectedProjectorId,
      projectorCandidates: expect.arrayContaining([
        expect.objectContaining({
          id: selectedProjectorId,
          matchStatus: 'user_selected',
          matchReason: 'user_selected_projector',
        }),
        expect.objectContaining({
          id: inactiveQ8ProjectorId,
          ownerVariantId: 'variant-q8',
          lifecycleStatus: 'downloaded',
          localPath: 'mmproj-q8.gguf',
          size: 512_000_000,
        }),
      ]),
    }));
    expect(lastPersistedModel.projectorCandidates?.map((projector) => projector.id)).toEqual([
      q4ProjectorAId,
      selectedProjectorId,
      inactiveQ8ProjectorId,
    ]);
  });

  it('clears stale persisted memory fit when the registry cannot select the fresh projector id', async () => {
    const { startModelDownloadFlow } = jest.requireMock('../../src/utils/modelDownloadFlow') as {
      startModelDownloadFlow: jest.Mock;
    };
    const selectedProjectorId = getCanonicalProjectorId('fresh-mmproj-b.gguf');
    const freshVisionModel = buildModel({
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      fitsInRam: true,
      memoryFitDecision: 'fits_high_confidence',
      memoryFitConfidence: 'high',
      chatModalities: ['text', 'vision'],
      projectorCandidates: [
        {
          id: 'fresh-projector-b',
          ownerModelId: 'org/model',
          repoId: 'org/model',
          fileName: 'fresh-mmproj-b.gguf',
          downloadUrl: 'https://huggingface.co/org/model/resolve/main/fresh-mmproj-b.gguf',
          size: 256_000_000,
          lifecycleStatus: 'available',
          matchStatus: 'ambiguous',
        },
      ],
    });
    const persistedModel = buildModel({
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      localPath: 'models/model.gguf',
      downloadProgress: 1,
      fitsInRam: false,
      memoryFitDecision: 'likely_oom',
      memoryFitConfidence: 'high',
      chatModalities: ['text', 'vision'],
      projectorCandidates: [
        {
          id: 'stale-projector-a',
          ownerModelId: 'org/model',
          repoId: 'org/model',
          fileName: 'stale-mmproj-a.gguf',
          downloadUrl: 'https://huggingface.co/org/model/resolve/main/stale-mmproj-a.gguf',
          size: 512_000_000,
          lifecycleStatus: 'downloaded',
          localPath: 'models/stale-mmproj-a.gguf',
          matchStatus: 'user_selected',
        },
      ],
      selectedProjectorId: 'stale-projector-a',
    });
    mockRegistryGetModel.mockReturnValue(persistedModel);
    mockGetCachedModel.mockReturnValue(freshVisionModel);
    mockGetModelDetails.mockResolvedValue(freshVisionModel);

    const { getCurrentValue } = renderHookHarness();

    await waitFor(() => {
      expect(getCurrentValue()?.loading).toBe(false);
    });

    act(() => {
      getCurrentValue()?.openProjectorChoice();
    });

    act(() => {
      getCurrentValue()?.handleSelectProjector(selectedProjectorId);
    });

    expect(mockRegistryUpdateModel).toHaveBeenLastCalledWith(expect.objectContaining({
      selectedProjectorId,
      fitsInRam: null,
      memoryFitDecision: undefined,
      memoryFitConfidence: undefined,
    }));
    expect(startModelDownloadFlow).toHaveBeenCalledWith(expect.objectContaining({
      model: expect.objectContaining({
        selectedProjectorId,
        fitsInRam: null,
        memoryFitDecision: undefined,
        memoryFitConfidence: undefined,
      }),
    }));
  });

  it('fails closed when the same selected projector scope has conflicting stable metadata', async () => {
    const selectedProjectorId = getCanonicalProjectorId('mmproj-a.gguf');
    const freshVisionModel = buildModel({
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      localPath: 'models/model.gguf',
      downloadProgress: 1,
      selectedProjectorId: 'projector-a',
      fitsInRam: true,
      memoryFitDecision: 'fits_high_confidence',
      memoryFitConfidence: 'high',
      chatModalities: ['text', 'vision'],
      projectorCandidates: [
        {
          id: 'projector-a',
          ownerModelId: 'org/model',
          repoId: 'org/model',
          fileName: 'mmproj-a.gguf',
          downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-a.gguf',
          size: 768_000_000,
          lifecycleStatus: 'available',
          matchStatus: 'user_selected',
          matchReason: 'user_selected_projector',
        },
      ],
    });
    const persistedModel = buildModel({
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      localPath: 'models/model.gguf',
      downloadProgress: 1,
      selectedProjectorId: 'projector-a',
      fitsInRam: false,
      memoryFitDecision: 'likely_oom',
      memoryFitConfidence: 'high',
      chatModalities: ['text', 'vision'],
      projectorCandidates: [
        {
          id: 'projector-a',
          ownerModelId: 'org/model',
          repoId: 'org/model',
          fileName: 'mmproj-a.gguf',
          downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-a.gguf',
          size: 256_000_000,
          lifecycleStatus: 'downloaded',
          localPath: 'models/mmproj-a.gguf',
          matchStatus: 'user_selected',
          matchReason: 'user_selected_projector',
        },
      ],
    });
    mockRegistryGetModel.mockReturnValue(persistedModel);
    mockGetCachedModel.mockReturnValue(freshVisionModel);
    mockGetModelDetails.mockResolvedValue(freshVisionModel);

    const { getCurrentValue } = renderHookHarness();

    await waitFor(() => {
      expect(getCurrentValue()?.loading).toBe(false);
    });

    act(() => {
      getCurrentValue()?.openProjectorChoice();
    });

    act(() => {
      getCurrentValue()?.handleSelectProjector(selectedProjectorId);
    });

    expect(mockRegistryUpdateModel).not.toHaveBeenCalled();
    expect(getCurrentValue()?.displayModel).toEqual(expect.objectContaining({
      selectedProjectorId: undefined,
      projectorCandidates: undefined,
      fitsInRam: null,
      memoryFitDecision: undefined,
      memoryFitConfidence: undefined,
    }));
    expect(alertSpy).toHaveBeenCalledWith(
      'models.actionFailedTitle',
      'models.multimodal.projectorChoiceFailedMessage',
    );
  });

  it('does not start projector download after choosing an already active projector', async () => {
    const { startModelDownloadFlow } = jest.requireMock('../../src/utils/modelDownloadFlow') as {
      startModelDownloadFlow: jest.Mock;
    };
    const selectedProjectorId = getCanonicalProjectorId('mmproj-a.gguf');
    const visionModel = buildModel({
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      localPath: 'models/model.gguf',
      downloadProgress: 1,
      selectedProjectorId: 'projector-a',
      fitsInRam: false,
      memoryFitDecision: 'likely_oom',
      memoryFitConfidence: 'high',
      chatModalities: ['text', 'vision'],
      projectorCandidates: [
        {
          id: 'projector-a',
          ownerModelId: 'org/model',
          repoId: 'org/model',
          fileName: 'mmproj-a.gguf',
          downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-a.gguf',
          size: 512_000_000,
          lifecycleStatus: 'active',
          localPath: 'models/mmproj-a.gguf',
          matchStatus: 'ambiguous',
        },
        {
          id: 'projector-b',
          ownerModelId: 'org/model',
          repoId: 'org/model',
          fileName: 'mmproj-b.gguf',
          downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-b.gguf',
          size: 256_000_000,
          lifecycleStatus: 'available',
          matchStatus: 'ambiguous',
        },
      ],
    });
    mockGetCachedModel.mockReturnValue(visionModel);
    mockGetModelDetails.mockResolvedValue(visionModel);

    const { getCurrentValue } = renderHookHarness();

    await waitFor(() => {
      expect(getCurrentValue()?.loading).toBe(false);
    });

    act(() => {
      getCurrentValue()?.openProjectorChoice();
    });

    act(() => {
      getCurrentValue()?.handleSelectProjector(selectedProjectorId);
    });

    expect(getCurrentValue()?.displayModel?.selectedProjectorId).toBe(selectedProjectorId);
    expect(getCurrentValue()?.displayModel).toEqual(expect.objectContaining({
      fitsInRam: false,
      memoryFitDecision: 'likely_oom',
      memoryFitConfidence: 'high',
    }));
    expect(startModelDownloadFlow).not.toHaveBeenCalled();
  });

  it('refreshes active multimodal readiness after choosing a different downloaded projector', async () => {
    const { startModelDownloadFlow } = jest.requireMock('../../src/utils/modelDownloadFlow') as {
      startModelDownloadFlow: jest.Mock;
    };
    mockEngineState.status = EngineStatus.READY;
    mockEngineState.activeModelId = 'org/model';

    const selectedProjectorId = getCanonicalProjectorId('mmproj-b.gguf');
    const visionModel = buildModel({
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      localPath: 'models/model.gguf',
      downloadProgress: 1,
      selectedProjectorId: 'projector-a',
      multimodalReadiness: {
        modelId: 'org/model',
        status: 'ready',
        projectorId: 'projector-a',
        support: ['vision'],
        checkedAt: 1,
      },
      chatModalities: ['text', 'vision'],
      projectorCandidates: [
        {
          id: 'projector-a',
          ownerModelId: 'org/model',
          repoId: 'org/model',
          fileName: 'mmproj-a.gguf',
          downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-a.gguf',
          size: 512_000_000,
          lifecycleStatus: 'downloaded',
          localPath: 'models/mmproj-a.gguf',
          matchStatus: 'user_selected',
          matchReason: 'user_selected_projector',
        },
        {
          id: 'projector-b',
          ownerModelId: 'org/model',
          repoId: 'org/model',
          fileName: 'mmproj-b.gguf',
          downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-b.gguf',
          size: 256_000_000,
          lifecycleStatus: 'downloaded',
          localPath: 'models/mmproj-b.gguf',
          resumeData: 'stale-projector-resume-data',
          downloadProgress: 0.4,
          matchStatus: 'ambiguous',
        },
      ],
    });
    let persistedModel = visionModel;
    mockRegistryGetModel.mockImplementation(() => persistedModel);
    mockRegistryUpdateModel.mockImplementation((nextModel: ModelMetadata) => {
      persistedModel = nextModel;
    });
    mockGetCachedModel.mockReturnValue(visionModel);
    mockGetModelDetails.mockResolvedValue(visionModel);

    const { getCurrentValue } = renderHookHarness();

    await waitFor(() => {
      expect(getCurrentValue()?.loading).toBe(false);
    });

    act(() => {
      getCurrentValue()?.openProjectorChoice();
    });

    act(() => {
      getCurrentValue()?.handleSelectProjector(selectedProjectorId);
    });

    const selectedProjector = getCurrentValue()?.displayModel?.projectorCandidates?.find((projector) => (
      projector.id === selectedProjectorId
    ));
    const finalUpdateCallOrder = mockRegistryUpdateModel.mock.invocationCallOrder.at(-1);
    const refreshCallOrder = mockRequestActiveMultimodalReadinessRefresh.mock.invocationCallOrder[0];

    expect(mockRegistryUpdateModel).toHaveBeenLastCalledWith(expect.objectContaining({
      selectedProjectorId,
      multimodalReadiness: undefined,
    }));
    expect(selectedProjector).toEqual(expect.objectContaining({
      id: selectedProjectorId,
      lifecycleStatus: 'downloaded',
      localPath: 'models/mmproj-b.gguf',
      downloadProgress: 1,
      matchStatus: 'user_selected',
    }));
    expect(selectedProjector?.resumeData).toBeUndefined();
    expect(mockRequestActiveMultimodalReadinessRefresh).toHaveBeenCalledTimes(1);
    expect(mockRequestActiveMultimodalReadinessRefresh).toHaveBeenCalledWith('org/model');
    expect(refreshCallOrder).toBeGreaterThan(finalUpdateCallOrder ?? 0);
    expect(startModelDownloadFlow).not.toHaveBeenCalled();
  });

  it('refreshes readiness after selecting a downloaded variant-only projector', async () => {
    mockEngineState.status = EngineStatus.READY;
    mockEngineState.activeModelId = 'org/model';
    const projectorA = {
      id: 'variant-projector-a',
      ownerModelId: 'org/model',
      ownerVariantId: 'vision-q4',
      repoId: 'org/model',
      fileName: 'mmproj-a.gguf',
      downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-a.gguf',
      size: 100,
      lifecycleStatus: 'downloaded' as const,
      localPath: 'models/mmproj-a.gguf',
      matchStatus: 'user_selected' as const,
    };
    const projectorB = {
      ...projectorA,
      id: 'variant-projector-b',
      fileName: 'mmproj-b.gguf',
      downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-b.gguf',
      localPath: 'models/mmproj-b.gguf',
      matchStatus: 'ambiguous' as const,
    };
    const selectedProjectorId = getCanonicalProjectorId(projectorB.fileName, projectorB.ownerVariantId);
    const model = buildModel({
      activeVariantId: 'vision-q4',
      resolvedFileName: 'model.Q4.gguf',
      chatModalities: ['text', 'vision'],
      projectorCandidates: undefined,
      selectedProjectorId: undefined,
      variants: [{
        variantId: 'vision-q4',
        fileName: 'model.Q4.gguf',
        quantizationLabel: 'Q4_K_M',
        size: 1_000,
        chatModalities: ['text', 'vision'],
        projectorCandidates: [projectorA, projectorB],
        selectedProjectorId: projectorA.id,
      }],
      multimodalReadiness: {
        modelId: 'org/model',
        variantId: 'vision-q4',
        status: 'ready',
        projectorId: projectorA.id,
        support: ['vision'],
        requestedSupport: ['vision'],
        checkedAt: 1,
      },
    });
    let persistedModel = model;
    mockRegistryGetModel.mockImplementation(() => persistedModel);
    mockRegistryUpdateModel.mockImplementation((nextModel: ModelMetadata) => {
      persistedModel = nextModel;
    });
    mockGetCachedModel.mockReturnValue(model);
    mockGetModelDetails.mockResolvedValue(model);

    const { getCurrentValue } = renderHookHarness();
    await waitFor(() => {
      expect(getCurrentValue()?.loading).toBe(false);
    });

    act(() => {
      getCurrentValue()?.openProjectorChoice();
    });
    act(() => {
      getCurrentValue()?.handleSelectProjector(selectedProjectorId);
    });

    expect(mockRequestActiveMultimodalReadinessRefresh).toHaveBeenCalledWith('org/model');
    expect(persistedModel.variants?.[0]).toEqual(expect.objectContaining({
      selectedProjectorId,
      projectorCandidates: expect.arrayContaining([
        expect.objectContaining({ id: selectedProjectorId, matchStatus: 'user_selected' }),
      ]),
    }));
  });

  it('preserves projector runtime state when registry uses a legacy id for the same artifact', async () => {
    const { startModelDownloadFlow } = jest.requireMock('../../src/utils/modelDownloadFlow') as {
      startModelDownloadFlow: jest.Mock;
    };
    const projectorFileName = 'projectors/mmproj-b.gguf';
    const projectorIdentity = {
      repoId: 'org/model',
      hfRevision: 'main',
      fileName: projectorFileName,
    };
    const freshProjectorId = buildProjectorArtifactId(projectorIdentity);
    const legacyProjectorId = buildLegacyProjectorArtifactId(projectorIdentity);
    const projectorDownloadUrl = `https://huggingface.co/org/model/resolve/main/${projectorFileName}`;
    const freshVisionModel = buildModel({
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      chatModalities: ['text', 'vision'],
      visionSource: 'catalog_metadata',
      projectorCandidates: [{
        id: freshProjectorId,
        ownerModelId: 'org/model',
        repoId: 'org/model',
        fileName: projectorFileName,
        downloadUrl: projectorDownloadUrl,
        hfRevision: 'main',
        size: 256_000_000,
        lifecycleStatus: 'available',
        matchStatus: 'ambiguous',
      }],
    });
    const persistedModel = buildModel({
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      localPath: 'models/model.gguf',
      downloadProgress: 1,
      chatModalities: ['text', 'vision'],
      projectorCandidates: [{
        id: legacyProjectorId,
        ownerModelId: 'org/model',
        repoId: 'org/model',
        fileName: projectorFileName,
        downloadUrl: projectorDownloadUrl,
        hfRevision: 'main',
        size: 256_000_000,
        lifecycleStatus: 'downloaded',
        localPath: 'models/projectors-mmproj-b.gguf',
        resumeData: 'legacy-projector-resume-data',
        downloadProgress: 0.4,
        matchStatus: 'ambiguous',
      }],
    });
    mockRegistryGetModel.mockReturnValue(persistedModel);
    mockGetCachedModel.mockReturnValue(freshVisionModel);
    mockGetModelDetails.mockResolvedValue(freshVisionModel);

    const { getCurrentValue } = renderHookHarness();

    await waitFor(() => {
      expect(getCurrentValue()?.loading).toBe(false);
    });

    act(() => {
      getCurrentValue()?.openProjectorChoice();
    });

    act(() => {
      getCurrentValue()?.handleSelectProjector(freshProjectorId);
    });

    const selectedProjector = getCurrentValue()?.displayModel?.projectorCandidates?.[0];

    expect(getCurrentValue()?.displayModel?.selectedProjectorId).toBe(freshProjectorId);
    expect(selectedProjector).toEqual(expect.objectContaining({
      id: freshProjectorId,
      fileName: projectorFileName,
      downloadUrl: projectorDownloadUrl,
      lifecycleStatus: 'downloaded',
      localPath: 'models/projectors-mmproj-b.gguf',
      downloadProgress: 1,
      matchStatus: 'user_selected',
      matchReason: 'user_selected_projector',
    }));
    expect(selectedProjector?.resumeData).toBeUndefined();
    expect(startModelDownloadFlow).not.toHaveBeenCalled();
  });

  it('offloads the model with preserved settings and applies the deleted state', async () => {
    const model = buildModel({
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      localPath: 'models/model.gguf',
      downloadedAt: 123,
      downloadIntegrity: {
        kind: 'size',
        sizeBytes: 2048,
        checkedAt: 456,
      },
      resumeData: 'resume-data',
      downloadErrorAt: 789,
      downloadErrorCode: 'download_http_error',
      downloadErrorMessage: 'HTTP status 500',
      metadataTrust: 'verified_local',
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
    expect(getCurrentValue()?.displayModel?.downloadedAt).toBeUndefined();
    expect(getCurrentValue()?.displayModel?.downloadIntegrity).toBeUndefined();
    expect(getCurrentValue()?.displayModel?.resumeData).toBeUndefined();
    expect(getCurrentValue()?.displayModel?.downloadErrorAt).toBeUndefined();
    expect(getCurrentValue()?.displayModel?.downloadErrorCode).toBeUndefined();
    expect(getCurrentValue()?.displayModel?.downloadErrorMessage).toBeUndefined();
    expect(getCurrentValue()?.displayModel?.metadataTrust).toBeUndefined();
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
    mockEngineState.diagnostics = {
      multimodal: {
        visionCapability: 'vision_capable',
        projectorPresence: 'downloaded',
        projectorPathCategory: 'models',
        readinessStatus: 'failed',
        failureReason: 'runtime:initialization_failed:path_redacted',
        attachmentCount: 1,
      },
    };
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
        engine: expect.objectContaining({
          status: EngineStatus.ERROR,
          activeModelId: 'org/loaded-model',
          diagnostics: expect.objectContaining({
            multimodal: expect.objectContaining({
              readinessStatus: 'failed',
              attachmentCount: 1,
            }),
          }),
        }),
        options: {
          allowUnsafeMemoryLoad: true,
          forceReload: false,
        },
      }),
    });
  });
});
