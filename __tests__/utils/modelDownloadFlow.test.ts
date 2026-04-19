import { Alert } from 'react-native';
import { startModelDownloadFlow } from '../../src/utils/modelDownloadFlow';
import { LifecycleStatus, ModelAccessState, type ModelMetadata } from '../../src/types/models';

const mockGetCurrentStatus = jest.fn();
const mockRefreshModelMetadata = jest.fn();
const mockGetSettings = jest.fn();

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

jest.mock('../../src/services/SettingsStore', () => ({
  getSettings: () => mockGetSettings(),
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

describe('modelDownloadFlow', () => {
  let alertSpy: jest.SpiedFunction<typeof Alert.alert>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCurrentStatus.mockReturnValue({ networkType: 'wifi' });
    mockRefreshModelMetadata.mockImplementation(async (model: ModelMetadata) => model);
    mockGetSettings.mockReturnValue({ allowCellularDownloads: true });
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

  it('blocks cellular downloads when disabled in settings', async () => {
    mockGetCurrentStatus.mockReturnValue({ networkType: 'cellular' });
    mockGetSettings.mockReturnValue({ allowCellularDownloads: false });
    const startDownload = jest.fn();

    startModelDownloadFlow({
      model: createModel(),
      t: (key) => key,
      startDownload,
      openTokenSettings: jest.fn(),
      openModelPage: jest.fn().mockResolvedValue(undefined),
      onError: jest.fn(),
    });

    expect(alertSpy).toHaveBeenCalledWith('models.cellularDownloadsDisabledTitle', 'models.cellularDownloadsDisabledMessage');
    expect(startDownload).not.toHaveBeenCalled();
  });

  it('warns before starting a download on cellular when enabled', async () => {
    mockGetCurrentStatus.mockReturnValue({ networkType: 'cellular' });
    mockGetSettings.mockReturnValue({ allowCellularDownloads: true });
    const startDownload = jest.fn();

    startModelDownloadFlow({
      model: createModel(),
      t: (key) => key,
      startDownload,
      openTokenSettings: jest.fn(),
      openModelPage: jest.fn().mockResolvedValue(undefined),
      onError: jest.fn(),
    });

    const buttons = alertSpy.mock.calls[0]?.[2] as Array<{ onPress?: () => void }>;
    expect(buttons?.[1]?.onPress).toEqual(expect.any(Function));
    buttons[1]?.onPress?.();
    await Promise.resolve();

    expect(startDownload).toHaveBeenCalled();
  });

  it('opens token settings when auth is required', async () => {
    const openTokenSettings = jest.fn();

    startModelDownloadFlow({
      model: createModel({ accessState: ModelAccessState.AUTH_REQUIRED }),
      t: (key) => key,
      startDownload: jest.fn(),
      openTokenSettings,
      openModelPage: jest.fn().mockResolvedValue(undefined),
      onError: jest.fn(),
    });

    await Promise.resolve();
    expect(openTokenSettings).toHaveBeenCalledTimes(1);
  });

  it('opens model page when access is denied', async () => {
    const openModelPage = jest.fn().mockResolvedValue(undefined);

    startModelDownloadFlow({
      model: createModel({ accessState: ModelAccessState.ACCESS_DENIED }),
      t: (key) => key,
      startDownload: jest.fn(),
      openTokenSettings: jest.fn(),
      openModelPage,
      onError: jest.fn(),
    });

    await Promise.resolve();
    expect(openModelPage).toHaveBeenCalledWith('org/model');
  });

  it('prompts when size is unknown and allows limited verification downloads', async () => {
    const startDownload = jest.fn();
    const model = createModel({ size: null });

    startModelDownloadFlow({
      model,
      t: (key) => key,
      startDownload,
      openTokenSettings: jest.fn(),
      openModelPage: jest.fn().mockResolvedValue(undefined),
      onError: jest.fn(),
    });

    await Promise.resolve();

    const buttons = alertSpy.mock.calls[0]?.[2] as Array<{ onPress?: () => void }>;
    buttons[1]?.onPress?.();
    expect(startDownload).toHaveBeenCalledWith(expect.objectContaining({ allowUnknownSizeDownload: true }));
  });

  it('surfaces an error when metadata cannot be resolved', async () => {
    const onError = jest.fn();
    mockRefreshModelMetadata.mockRejectedValueOnce(new Error('refresh failed'));

    startModelDownloadFlow({
      model: createModel({ size: null, requiresTreeProbe: true }),
      t: (key) => key,
      startDownload: jest.fn(),
      openTokenSettings: jest.fn(),
      openModelPage: jest.fn().mockResolvedValue(undefined),
      onError,
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });
});
