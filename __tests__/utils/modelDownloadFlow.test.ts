import { Alert } from 'react-native';
import { startModelDownloadFlow } from '../../src/utils/modelDownloadFlow';
import { LifecycleStatus, ModelAccessState, type ModelMetadata } from '../../src/types/models';
import type { ProjectorArtifact } from '../../src/types/multimodal';

const mockGetCurrentStatus = jest.fn();
const mockRefreshModelMetadata = jest.fn();
const mockGetSettings = jest.fn();
const mockGetModelLoadParametersForModel = jest.fn();
const mockGetPrivateStorageHealthSnapshot = jest.fn();
const mockIsPrivateStorageWritable = jest.fn();

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
  getModelLoadParametersForModel: (...args: unknown[]) => mockGetModelLoadParametersForModel(...args),
}));

jest.mock('../../src/services/storage', () => ({
  getPrivateStorageHealthSnapshot: () => mockGetPrivateStorageHealthSnapshot(),
  isPrivateStorageWritable: () => mockIsPrivateStorageWritable(),
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

function createProjector(overrides: Partial<ProjectorArtifact> = {}): ProjectorArtifact {
  const repoId = overrides.repoId ?? 'org/model';
  const fileName = overrides.fileName ?? 'mmproj-a.gguf';
  const hfRevision = overrides.hfRevision ?? 'main';
  return {
    id: 'projector-org-model-main-mmproj-a.gguf',
    ownerModelId: 'org/model',
    repoId,
    fileName,
    downloadUrl: `https://huggingface.co/${repoId}/resolve/${hfRevision}/${fileName}`,
    size: 1024,
    lifecycleStatus: 'available',
    matchStatus: 'ambiguous',
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
    mockGetModelLoadParametersForModel.mockReturnValue({});
    mockGetPrivateStorageHealthSnapshot.mockReturnValue({
      status: 'ready',
      retryable: false,
      requiresExplicitReset: false,
      lastUpdatedAt: 1,
    });
    mockIsPrivateStorageWritable.mockReturnValue(true);
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

  it('shows a known RAM warning before a required tree refresh', async () => {
    const startDownload = jest.fn();
    const model = createModel({
      fitsInRam: false,
      requiresTreeProbe: true,
    });
    mockRefreshModelMetadata.mockResolvedValue(model);

    startModelDownloadFlow({
      model,
      t: (key) => key,
      startDownload,
      openTokenSettings: jest.fn(),
      openModelPage: jest.fn().mockResolvedValue(undefined),
      onError: jest.fn(),
    });

    expect(alertSpy).toHaveBeenCalledWith(
      'models.memoryWarningTitle',
      'models.downloadMemoryWarningMessage',
      expect.any(Array),
    );
    expect(mockRefreshModelMetadata).not.toHaveBeenCalled();
    expect(startDownload).not.toHaveBeenCalled();

    const buttons = alertSpy.mock.calls[0]?.[2] as Array<{ onPress?: () => void }>;
    buttons[1]?.onPress?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockRefreshModelMetadata).toHaveBeenCalledWith(model, { includeDetails: false });
    expect(startDownload).toHaveBeenCalledWith(model);
    expect(alertSpy).toHaveBeenCalledTimes(1);
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

  it('prompts for projector choice instead of silently downloading an ambiguous vision model', async () => {
    const startDownload = jest.fn();
    const onProjectorChoiceRequired = jest.fn();
    const ambiguousModel = createModel({
      chatModalities: ['text', 'vision'],
      projectorCandidates: [
        createProjector({ id: 'projector-a', fileName: 'mmproj-a.gguf' }),
        createProjector({ id: 'projector-b', fileName: 'mmproj-b.gguf' }),
      ],
    });

    startModelDownloadFlow({
      model: ambiguousModel,
      t: (key) => key,
      startDownload,
      openTokenSettings: jest.fn(),
      openModelPage: jest.fn().mockResolvedValue(undefined),
      onProjectorChoiceRequired,
      onError: jest.fn(),
    });

    await Promise.resolve();

    expect(onProjectorChoiceRequired).toHaveBeenCalledWith(ambiguousModel);
    expect(alertSpy).not.toHaveBeenCalledWith(
      'models.multimodal.projectorChoiceRequiredTitle',
      'models.multimodal.projectorChoiceRequiredMessage',
    );
    expect(startDownload).not.toHaveBeenCalled();
  });

  it('starts projector download for a downloaded model with reusable local file but no resolved file name', async () => {
    const startDownload = jest.fn();
    const projector = createProjector({
      id: 'projector-a',
      lifecycleStatus: 'available',
      matchStatus: 'user_selected',
    });
    const downloadedModel = createModel({
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 100,
      localPath: '/documents/models/model.gguf',
      resolvedFileName: undefined,
      chatModalities: ['text', 'vision'],
      selectedProjectorId: projector.id,
      projectorCandidates: [projector],
    });

    startModelDownloadFlow({
      model: downloadedModel,
      t: (key) => key,
      startDownload,
      openTokenSettings: jest.fn(),
      openModelPage: jest.fn().mockResolvedValue(undefined),
      onError: jest.fn(),
    });

    await Promise.resolve();

    expect(alertSpy).not.toHaveBeenCalledWith(
      'models.actionFailedTitle',
      'common.errors.downloadMetadataUnavailable',
    );
    expect(startDownload).toHaveBeenCalledWith(downloadedModel);
  });

  it('shows a fallback projector-choice alert when no choice handler is available', async () => {
    const startDownload = jest.fn();

    startModelDownloadFlow({
      model: createModel({
        chatModalities: ['text', 'vision'],
        projectorCandidates: [
          createProjector({ id: 'projector-a', fileName: 'mmproj-a.gguf' }),
          createProjector({ id: 'projector-b', fileName: 'mmproj-b.gguf' }),
        ],
      }),
      t: (key) => key,
      startDownload,
      openTokenSettings: jest.fn(),
      openModelPage: jest.fn().mockResolvedValue(undefined),
      onError: jest.fn(),
    });

    await Promise.resolve();

    expect(alertSpy).toHaveBeenCalledWith(
      'models.multimodal.projectorChoiceRequiredTitle',
      'models.multimodal.projectorChoiceRequiredMessage',
    );
    expect(startDownload).not.toHaveBeenCalled();
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

  it('blocks cellular downloads before reading settings when private storage is unavailable', async () => {
    mockGetCurrentStatus.mockReturnValue({ networkType: 'cellular' });
    mockIsPrivateStorageWritable.mockReturnValue(false);
    const startDownload = jest.fn();

    startModelDownloadFlow({
      model: createModel(),
      t: (key) => key,
      startDownload,
      openTokenSettings: jest.fn(),
      openModelPage: jest.fn().mockResolvedValue(undefined),
      onError: jest.fn(),
    });

    expect(alertSpy).toHaveBeenCalledWith(
      'storageRecovery.title',
      'storageRecovery.privateUnavailableMessage',
    );
    expect(mockGetSettings).not.toHaveBeenCalled();
    expect(startDownload).not.toHaveBeenCalled();
  });

  it('blocks before metadata refresh and download start when private storage is unavailable', async () => {
    mockGetPrivateStorageHealthSnapshot.mockReturnValue({
      status: 'blocked',
      reason: 'encrypted_open_failed',
      retryable: true,
      requiresExplicitReset: true,
      lastUpdatedAt: 2,
    });
    mockIsPrivateStorageWritable.mockReturnValue(false);
    mockRefreshModelMetadata.mockResolvedValue(createModel({ size: 2048 }));
    const startDownload = jest.fn();
    const onResolvedModel = jest.fn();

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

    expect(alertSpy).toHaveBeenCalledWith(
      'storageRecovery.title',
      'storageRecovery.privateUnavailableMessage',
    );
    expect(mockRefreshModelMetadata).not.toHaveBeenCalled();
    expect(onResolvedModel).not.toHaveBeenCalled();
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

  it('requires the same explicit consent when an optional MTP draft size is unknown', async () => {
    const startDownload = jest.fn();
    const draftArtifactId = 'mtp-draft-unknown-size';
    const model = createModel({
      artifacts: [{
        id: draftArtifactId,
        kind: 'speculative_draft',
        requiredFor: ['text'],
        remoteFileName: 'draft/gemma-drafter.gguf',
        downloadUrl: 'https://huggingface.co/org/model/resolve/main/draft/gemma-drafter.gguf',
        sizeBytes: null,
        installState: 'remote',
      }],
      speculativeDecoding: {
        type: 'mtp',
        mode: 'draft_model',
        enabled: true,
        maxDraftTokens: 3,
        draftArtifactId,
      },
    });

    startModelDownloadFlow({
      model,
      t: (key) => key,
      startDownload,
      openTokenSettings: jest.fn(),
      openModelPage: jest.fn().mockResolvedValue(undefined),
      onError: jest.fn(),
    });
    await Promise.resolve();

    expect(alertSpy).toHaveBeenCalledWith(
      'models.unknownSizeWarningTitle',
      'models.unknownSizeWarningMessage',
      expect.any(Array),
    );
    expect(startDownload).not.toHaveBeenCalled();

    const buttons = alertSpy.mock.calls[0]?.[2] as Array<{ onPress?: () => void }>;
    buttons[1]?.onPress?.();
    expect(startDownload).toHaveBeenCalledWith(expect.objectContaining({
      id: model.id,
      allowUnknownSizeDownload: true,
    }));
  });

  it('does not require unknown-size MTP consent when the per-model preference is off', async () => {
    const startDownload = jest.fn();
    const draftArtifactId = 'mtp-draft-disabled';
    const model = createModel({
      artifacts: [{
        id: draftArtifactId,
        kind: 'speculative_draft',
        requiredFor: ['text'],
        remoteFileName: 'draft/gemma-drafter.gguf',
        downloadUrl: 'https://huggingface.co/org/model/resolve/main/draft/gemma-drafter.gguf',
        sizeBytes: null,
        installState: 'remote',
      }],
      speculativeDecoding: {
        type: 'mtp',
        mode: 'draft_model',
        enabled: true,
        maxDraftTokens: 3,
        draftArtifactId,
      },
    });
    mockGetModelLoadParametersForModel.mockReturnValue({ mtpEnabled: false });

    startModelDownloadFlow({
      model,
      t: (key) => key,
      startDownload,
      openTokenSettings: jest.fn(),
      openModelPage: jest.fn().mockResolvedValue(undefined),
      onError: jest.fn(),
    });
    await Promise.resolve();

    expect(mockGetModelLoadParametersForModel).toHaveBeenCalledWith(model.id);
    expect(alertSpy).not.toHaveBeenCalled();
    expect(startDownload).toHaveBeenCalledWith(model);
  });

  it('uses explicit optional-draft intent when the runtime MTP preference is off', async () => {
    const startDownload = jest.fn();
    const downloadOptions = { includeOptionalMtpDraft: true } as const;
    const draftArtifactId = 'mtp-draft-explicit-prefetch';
    const model = createModel({
      artifacts: [{
        id: draftArtifactId,
        kind: 'speculative_draft',
        requiredFor: ['text'],
        remoteFileName: 'draft/gemma-drafter.gguf',
        downloadUrl: 'https://huggingface.co/org/model/resolve/main/draft/gemma-drafter.gguf',
        sizeBytes: 512,
        installState: 'remote',
      }],
      speculativeDecoding: {
        type: 'mtp',
        mode: 'draft_model',
        enabled: true,
        maxDraftTokens: 3,
        draftArtifactId,
      },
    });
    mockGetModelLoadParametersForModel.mockReturnValue({ mtpEnabled: false });

    startModelDownloadFlow({
      model,
      t: (key) => key,
      startDownload,
      downloadOptions,
      openTokenSettings: jest.fn(),
      openModelPage: jest.fn().mockResolvedValue(undefined),
      onError: jest.fn(),
    });
    await Promise.resolve();

    expect(startDownload).toHaveBeenCalledWith(model, downloadOptions);
    expect(alertSpy).not.toHaveBeenCalled();
    expect(mockGetModelLoadParametersForModel).not.toHaveBeenCalled();
  });

  it('applies unknown-size consent to an explicit draft even when runtime MTP is off', async () => {
    const startDownload = jest.fn();
    const downloadOptions = { includeOptionalMtpDraft: true } as const;
    const draftArtifactId = 'mtp-draft-explicit-unknown-size';
    const model = createModel({
      artifacts: [{
        id: draftArtifactId,
        kind: 'speculative_draft',
        requiredFor: ['text'],
        remoteFileName: 'draft/gemma-drafter.gguf',
        downloadUrl: 'https://huggingface.co/org/model/resolve/main/draft/gemma-drafter.gguf',
        sizeBytes: null,
        installState: 'remote',
      }],
      speculativeDecoding: {
        type: 'mtp',
        mode: 'draft_model',
        enabled: true,
        maxDraftTokens: 3,
        draftArtifactId,
      },
    });
    mockGetModelLoadParametersForModel.mockReturnValue({ mtpEnabled: false });

    startModelDownloadFlow({
      model,
      t: (key) => key,
      startDownload,
      downloadOptions,
      openTokenSettings: jest.fn(),
      openModelPage: jest.fn().mockResolvedValue(undefined),
      onError: jest.fn(),
    });
    await Promise.resolve();

    expect(alertSpy).toHaveBeenCalledWith(
      'models.unknownSizeWarningTitle',
      'models.unknownSizeWarningMessage',
      expect.any(Array),
    );
    expect(startDownload).not.toHaveBeenCalled();

    const buttons = alertSpy.mock.calls[0]?.[2] as Array<{ onPress?: () => void }>;
    buttons[1]?.onPress?.();
    expect(startDownload).toHaveBeenCalledWith(
      expect.objectContaining({ allowUnknownSizeDownload: true }),
      downloadOptions,
    );
  });

  it('does not degrade explicit draft intent to a base-only download after metadata refresh', async () => {
    const startDownload = jest.fn();
    const unresolvedModel = createModel({ requiresTreeProbe: true });
    mockRefreshModelMetadata.mockResolvedValue(createModel());

    startModelDownloadFlow({
      model: unresolvedModel,
      t: (key) => key,
      startDownload,
      downloadOptions: { includeOptionalMtpDraft: true },
      openTokenSettings: jest.fn(),
      openModelPage: jest.fn().mockResolvedValue(undefined),
      onError: jest.fn(),
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(alertSpy).toHaveBeenCalledWith(
      'models.actionFailedTitle',
      'common.errors.downloadMetadataUnavailable',
    );
    expect(startDownload).not.toHaveBeenCalled();
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
