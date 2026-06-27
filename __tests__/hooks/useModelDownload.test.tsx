import React, { useEffect } from 'react';
import { act, render, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import { useModelDownload } from '../../src/hooks/useModelDownload';
import { notificationService } from '../../src/services/NotificationService';
import { isPrivateStorageWritable } from '../../src/services/storage';
import { useDownloadStore } from '../../src/store/downloadStore';
import { LifecycleStatus, ModelAccessState, type ModelMetadata } from '../../src/types/models';
import type { ProjectorArtifact } from '../../src/types/multimodal';

jest.mock('../../src/services/NotificationService', () => ({
  notificationService: {
    canStartForegroundServiceNotifications: jest.fn(),
    requestPermissions: jest.fn(),
    openSystemSettings: jest.fn(),
  },
}));

jest.mock('../../src/i18n', () => ({
  __esModule: true,
  default: {
    t: (key: string) => key,
  },
}));

jest.mock('../../src/services/ModelDownloadManager', () => ({
  getModelDownloadManager: jest.fn(() => ({
    pauseDownload: jest.fn().mockResolvedValue(undefined),
    cancelDownload: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('../../src/services/storage', () => {
  const actual = jest.requireActual('../../src/services/storage');

  return {
    ...actual,
    isPrivateStorageWritable: jest.fn(),
  };
});

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
  return {
    id: 'projector-org-model-main-mmproj-model.gguf',
    ownerModelId: 'org/model',
    repoId: 'org/model',
    fileName: 'mmproj-model.gguf',
    downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-model.gguf',
    size: 1024,
    lifecycleStatus: 'downloaded',
    matchStatus: 'user_selected',
    localPath: 'mmproj-model.gguf',
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

describe('useModelDownload', () => {
  const mockNotificationService = notificationService as jest.Mocked<typeof notificationService>;
  const mockIsPrivateStorageWritable = isPrivateStorageWritable as jest.MockedFunction<typeof isPrivateStorageWritable>;
  let alertSpy: jest.SpiedFunction<typeof Alert.alert>;

  function renderHookHarness() {
    let currentValue: ReturnType<typeof useModelDownload> | null = null;

    const Harness = () => {
      const value = useModelDownload();
      useEffect(() => {
        currentValue = value;
      }, [value]);
      return null;
    };

    const rendered = render(<Harness />);

    return {
      getCurrentValue: () => currentValue,
      ...rendered,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    useDownloadStore.setState({ queue: [], activeDownloadId: null });
    mockIsPrivateStorageWritable.mockReturnValue(true);
    mockNotificationService.canStartForegroundServiceNotifications.mockResolvedValue(true);
    mockNotificationService.requestPermissions.mockResolvedValue(true);
    mockNotificationService.openSystemSettings.mockResolvedValue(undefined);
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
  });

  afterEach(() => {
    alertSpy.mockRestore();
  });

  it('does not queue a download when private storage is initially blocked', async () => {
    mockIsPrivateStorageWritable.mockReturnValue(false);
    const { getCurrentValue } = renderHookHarness();

    await waitFor(() => {
      expect(getCurrentValue()).not.toBeNull();
    });

    await act(async () => {
      getCurrentValue()?.startDownload(createModel());
      await Promise.resolve();
    });

    expect(alertSpy).toHaveBeenCalledWith(
      'storageRecovery.title',
      'storageRecovery.privateUnavailableMessage',
    );
    expect(mockNotificationService.canStartForegroundServiceNotifications).not.toHaveBeenCalled();
    expect(useDownloadStore.getState().queue).toEqual([]);
  });

  it('does not queue when storage becomes blocked before the async notification check queues', async () => {
    let storageWritable = true;
    const notificationReadiness = createDeferred<boolean>();
    mockIsPrivateStorageWritable.mockImplementation(() => storageWritable);
    mockNotificationService.canStartForegroundServiceNotifications.mockReturnValue(notificationReadiness.promise);
    const { getCurrentValue } = renderHookHarness();

    await waitFor(() => {
      expect(getCurrentValue()).not.toBeNull();
    });

    await act(async () => {
      getCurrentValue()?.startDownload(createModel());
      await Promise.resolve();
    });

    storageWritable = false;

    await act(async () => {
      notificationReadiness.resolve(true);
      await notificationReadiness.promise;
      await Promise.resolve();
    });

    expect(alertSpy).toHaveBeenCalledWith(
      'storageRecovery.title',
      'storageRecovery.privateUnavailableMessage',
    );
    expect(useDownloadStore.getState().queue).toEqual([]);
  });

  it('queues selected projector metadata with the model download request', async () => {
    const projector = createProjector();
    const { getCurrentValue } = renderHookHarness();

    await waitFor(() => {
      expect(getCurrentValue()).not.toBeNull();
    });

    await act(async () => {
      getCurrentValue()?.startDownload(createModel({
        chatModalities: ['text', 'vision'],
        selectedProjectorId: projector.id,
        projectorCandidates: [projector],
      }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(useDownloadStore.getState().queue[0]).toEqual(expect.objectContaining({
      id: 'org/model',
      selectedProjectorId: projector.id,
      projectorCandidates: [expect.objectContaining({ id: projector.id, localPath: 'mmproj-model.gguf' })],
    }));
    expect(getCurrentValue()?.getProjectorLifecycleState(useDownloadStore.getState().queue[0]).isReady).toBe(true);
  });
});
