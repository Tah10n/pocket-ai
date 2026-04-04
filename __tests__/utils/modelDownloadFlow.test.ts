import { Alert } from 'react-native';
import { startModelDownloadFlow } from '../../src/utils/modelDownloadFlow';
import type { MemoryFitResult } from '../../src/memory/types';
import { LifecycleStatus, ModelAccessState, type ModelMetadata } from '../../src/types/models';

const mockGetCurrentStatus = jest.fn();
const mockRefreshModelMetadata = jest.fn();

jest.mock('../../src/services/HardwareListenerService', () => ({
  hardwareListenerService: {
    getCurrentStatus: (...args: any[]) => mockGetCurrentStatus(...args),
  },
}));

jest.mock('../../src/services/ModelCatalogService', () => ({
  modelCatalogService: {
    refreshModelMetadata: (...args: any[]) => mockRefreshModelMetadata(...args),
  },
}));

function createModel(overrides: Partial<ModelMetadata> = {}): ModelMetadata {
  return {
    id: 'org/model',
    name: 'model',
    author: 'org',
    size: 1024,
    downloadUrl: 'https://huggingface.co/org/model/resolve/main/model.gguf',
    resolvedFileName: 'model.gguf',
    fitsInRam: true,
    accessState: ModelAccessState.PUBLIC,
    isGated: false,
    isPrivate: false,
    lifecycleStatus: LifecycleStatus.AVAILABLE,
    downloadProgress: 0,
    ...overrides,
  };
}

function createMemoryFitResult(overrides: Partial<MemoryFitResult> = {}): MemoryFitResult {
  const baseBudget: MemoryFitResult['budget'] = {
    totalMemoryBytes: 10,
    effectiveBudgetBytes: 2,
  };

  const base: MemoryFitResult = {
    decision: 'fits_high_confidence',
    confidence: 'medium',
    requiredBytes: 1,
    effectiveBudgetBytes: 2,
    breakdown: {
      weightsBytes: 1,
      kvCacheBytes: 0,
      computeBytes: 0,
      multimodalBytes: 0,
      overheadBytes: 0,
      safetyMarginBytes: 0,
    },
    budget: baseBudget,
    recommendations: [],
  };

  return {
    ...base,
    ...overrides,
    budget: { ...baseBudget, ...(overrides.budget ?? {}) },
  };
}

describe('modelDownloadFlow', () => {
  let alertSpy: jest.SpiedFunction<typeof Alert.alert>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCurrentStatus.mockReturnValue({ networkType: 'wifi' });
    mockRefreshModelMetadata.mockImplementation(async (model: ModelMetadata) => model);
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
  });

  afterEach(() => {
    alertSpy.mockRestore();
  });

  it('shows a RAM warning before downloading a model that does not fit', async () => {
    const startDownload = jest.fn();

    startModelDownloadFlow({
      model: createModel({ fitsInRam: false }),
      t: (key) => key,
      getMemoryFit: jest.fn().mockResolvedValue(createMemoryFitResult()),
      startDownload,
      openTokenSettings: jest.fn(),
      openModelPage: jest.fn().mockResolvedValue(undefined),
      onError: jest.fn(),
    });

    await Promise.resolve();

    expect(alertSpy).toHaveBeenCalledWith(
      'models.memoryWarningTitle',
      'models.downloadMemoryWarningMessage',
      expect.arrayContaining([
        expect.objectContaining({ text: 'common.cancel', style: 'cancel' }),
        expect.objectContaining({ text: 'models.downloadAnyway', onPress: expect.any(Function) }),
      ]),
    );
    expect(startDownload).not.toHaveBeenCalled();

    const buttons = alertSpy.mock.calls[0]?.[2] as Array<{ onPress?: () => void }>;
    buttons[1]?.onPress?.();

    expect(startDownload).toHaveBeenCalledWith(expect.objectContaining({
      id: 'org/model',
    }));
  });

  it('refreshes unresolved metadata and propagates the resolved model to the caller', async () => {
    const resolvedModel = createModel({
      size: 2048,
      resolvedFileName: 'resolved.gguf',
    });
    const onResolvedModel = jest.fn();
    const startDownload = jest.fn();

    mockRefreshModelMetadata.mockResolvedValue(resolvedModel);

    startModelDownloadFlow({
      model: createModel({
        size: null,
        resolvedFileName: undefined,
        requiresTreeProbe: true,
      }),
      t: (key) => key,
      getMemoryFit: jest.fn().mockResolvedValue(createMemoryFitResult()),
      startDownload,
      openTokenSettings: jest.fn(),
      openModelPage: jest.fn().mockResolvedValue(undefined),
      onResolvedModel,
      onError: jest.fn(),
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(mockRefreshModelMetadata).toHaveBeenCalledWith(expect.objectContaining({
      id: 'org/model',
    }), { includeDetails: false });
    expect(onResolvedModel).toHaveBeenCalledWith(resolvedModel);
    expect(startDownload).toHaveBeenCalledWith(resolvedModel);
  });
});
