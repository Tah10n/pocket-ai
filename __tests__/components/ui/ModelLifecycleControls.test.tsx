import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { ModelDownloadProgress, ModelLifecycleActionRow, ModelProjectorStatus } from '../../../src/components/ui/ModelLifecycleControls';
import { useDownloadStore } from '../../../src/store/downloadStore';
import { LifecycleStatus, ModelAccessState, type ModelMetadata } from '../../../src/types/models';
import type { ProjectorArtifact } from '../../../src/types/multimodal';

jest.mock('../../../src/components/ui/box', () => {
  const mockReact = jest.requireActual('react');
  const { View } = jest.requireActual('react-native');
  return {
    Box: ({ children, ...props }: any) => mockReact.createElement(View, props, children),
  };
});

jest.mock('../../../src/components/ui/text', () => {
  const mockReact = jest.requireActual('react');
  const { Text } = jest.requireActual('react-native');
  return {
    Text: ({ children, ...props }: any) => mockReact.createElement(Text, props, children),
  };
});

jest.mock('../../../src/components/ui/MaterialSymbols', () => {
  const mockReact = jest.requireActual('react');
  const { Text } = jest.requireActual('react-native');
  return {
    MaterialSymbols: ({ name, ...props }: any) => mockReact.createElement(Text, props, name),
  };
});

function buildModel(overrides: Partial<ModelMetadata> = {}): ModelMetadata {
  return {
    id: 'org/model',
    name: 'Model',
    author: 'org',
    size: 1024,
    downloadUrl: 'https://huggingface.co/org/model/resolve/main/model.gguf',
    fitsInRam: true,
    accessState: ModelAccessState.PUBLIC,
    isGated: false,
    isPrivate: false,
    lifecycleStatus: LifecycleStatus.DOWNLOADING,
    downloadProgress: 0,
    ...overrides,
  };
}

function buildProjector(overrides: Partial<ProjectorArtifact> = {}): ProjectorArtifact {
  return {
    id: 'projector-org-model-main-mmproj-a.gguf',
    ownerModelId: 'org/model',
    repoId: 'org/model',
    fileName: 'mmproj-a.gguf',
    downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-a.gguf',
    size: 1024,
    lifecycleStatus: 'available',
    matchStatus: 'ambiguous',
    ...overrides,
  };
}

describe('ModelDownloadProgress', () => {
  beforeEach(() => {
    useDownloadStore.setState({ queue: [], activeDownloadId: null });
  });

  it('renders a branded model download progress panel from live queue progress', () => {
    const model = buildModel({ downloadProgress: 0.1 });
    useDownloadStore.setState({ queue: [buildModel({ downloadProgress: 0.42 })], activeDownloadId: model.id });

    const { getByTestId, getByText } = render(<ModelDownloadProgress model={model} />);

    expect(getByTestId('model-download-progress-org/model').props.className).toContain('rounded-2xl');
    expect(getByTestId('model-download-progress-org/model').props.className).toContain('bg-primary-500/10');
    expect(getByText('models.downloading')).toBeTruthy();
    expect(getByText('42%')).toBeTruthy();
    expect(getByTestId('model-download-progress-track-org/model').props.className).toContain('h-4');
    expect(getByTestId('model-download-progress-fill-org/model').props.className).toContain('bg-primary-500');
    expect(getByTestId('model-download-progress-fill-org/model').props.style).toEqual({ width: '42%' });
  });

  it('uses warning styling for paused progress', () => {
    const { getByTestId, getByText } = render(
      <ModelDownloadProgress model={buildModel({ lifecycleStatus: LifecycleStatus.PAUSED, downloadProgress: 0.24 })} />,
    );

    expect(getByText('models.paused')).toBeTruthy();
    expect(getByText('24%')).toBeTruthy();
    expect(getByTestId('model-download-progress-org/model').props.className).toContain('bg-background-warning');
    expect(getByTestId('model-download-progress-fill-org/model').props.className).toContain('bg-primary-500');
    expect(getByTestId('model-download-progress-fill-org/model').props.className).not.toContain('bg-warning-500');
  });

  it('renders failed downloads as visible retry state', () => {
    const { getByTestId, getByText } = render(
      <ModelDownloadProgress model={buildModel({ lifecycleStatus: LifecycleStatus.FAILED, downloadProgress: 0.24 })} />,
    );

    expect(getByText('models.downloadFailed')).toBeTruthy();
    expect(getByText('24%')).toBeTruthy();
    expect(getByTestId('model-download-progress-org/model').props.className).toContain('bg-error-500/10');
  });

  it.each([
    ['queued', 'models.multimodal.projectorQueued', undefined, '0%'],
    ['downloading', 'models.multimodal.projectorDownloading', 0.37, '37%'],
    ['paused', 'models.multimodal.projectorPaused', 0.58, '58%'],
  ] as const)('labels %s projector work instead of generic model verification', (projectorLifecycleStatus, expectedLabel, projectorProgress, expectedPercent) => {
    const queuedModel = buildModel({
      lifecycleStatus: LifecycleStatus.VERIFYING,
      downloadProgress: 1,
      chatModalities: ['text', 'vision'],
      artifactRole: 'primary_chat_model',
      projectorCandidates: [buildProjector({
        lifecycleStatus: projectorLifecycleStatus,
        matchStatus: 'matched',
        downloadProgress: projectorProgress,
      })],
    });
    useDownloadStore.setState({ queue: [queuedModel], activeDownloadId: queuedModel.id });

    const { queryByText, getByText } = render(
      <ModelDownloadProgress model={queuedModel} />,
    );

    expect(getByText(expectedLabel)).toBeTruthy();
    expect(getByText(expectedPercent)).toBeTruthy();
    expect(queryByText('models.verifying')).toBeNull();
  });

  it('keeps showing base model progress while the selected projector is only queued before base completion', () => {
    const queuedModel = buildModel({
      lifecycleStatus: LifecycleStatus.DOWNLOADING,
      downloadProgress: 0.42,
      chatModalities: ['text', 'vision'],
      artifactRole: 'primary_chat_model',
      projectorCandidates: [buildProjector({ lifecycleStatus: 'queued', matchStatus: 'matched' })],
    });
    useDownloadStore.setState({ queue: [queuedModel], activeDownloadId: queuedModel.id });

    const { getByText, queryByText } = render(
      <ModelDownloadProgress model={queuedModel} />,
    );

    expect(getByText('models.downloading')).toBeTruthy();
    expect(getByText('42%')).toBeTruthy();
    expect(queryByText('models.multimodal.projectorQueued')).toBeNull();
  });

  it('can render a compact layout for catalog cards', () => {
    const { getByTestId } = render(
      <ModelDownloadProgress density="compact" model={buildModel({ downloadProgress: 0.33 })} />,
    );

    expect(getByTestId('model-download-progress-org/model').props.className).toContain('px-2.5');
    expect(getByTestId('model-download-progress-track-org/model').props.className).toContain('h-3.5');
    expect(getByTestId('model-download-progress-fill-org/model').props.style).toEqual({ width: '33%' });
  });
});

describe('ModelProjectorStatus', () => {
  it('surfaces ambiguous projector status and keeps text fallback action separate', () => {
    const model = buildModel({
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      chatModalities: ['text', 'vision'],
      projectorCandidates: [
        buildProjector({
          id: 'projector-org-model-main-mmproj-a.gguf',
          fileName: 'mmproj-a.gguf',
          downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-a.gguf',
        }),
        buildProjector({
          id: 'projector-org-model-main-mmproj-b.gguf',
          fileName: 'mmproj-b.gguf',
          downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-b.gguf',
        }),
      ],
    });
    const onChooseProjector = jest.fn();

    const { getByTestId, getByText } = render(
      <ModelProjectorStatus model={model} onChooseProjector={onChooseProjector} />,
    );

    expect(getByTestId('model-projector-status-org/model')).toBeTruthy();
    expect(getByText('models.multimodal.projectorStatusAmbiguousTitle')).toBeTruthy();
    expect(getByText('models.multimodal.projectorStatusAmbiguousDescription')).toBeTruthy();

    fireEvent.press(getByText('models.multimodal.chooseProjectorAction'));

    expect(onChooseProjector).toHaveBeenCalledWith(model);
  });

  it('does not render projector status for text-only models', () => {
    const { queryByTestId } = render(<ModelProjectorStatus model={buildModel()} />);

    expect(queryByTestId('model-projector-status-org/model')).toBeNull();
  });
});

describe('ModelLifecycleActionRow projector actions', () => {
  function renderActionRow(model: ModelMetadata) {
    const props = {
      model,
      onDownload: jest.fn(),
      onConfigureToken: jest.fn(),
      onOpenModelPage: jest.fn(),
      onLoad: jest.fn(),
      onOpenSettings: jest.fn(),
      onUnload: jest.fn(),
      onDelete: jest.fn(),
      onCancel: jest.fn(),
      onChat: jest.fn(),
    };

    return {
      props,
      ...render(<ModelLifecycleActionRow {...props} />),
    };
  }

  it.each([
    ['available', 'models.multimodal.downloadProjector', 'model-projector-download-org/model'],
    ['failed', 'models.multimodal.retryProjectorDownload', 'model-projector-retry-org/model'],
    ['paused', 'models.multimodal.resumeProjectorDownload', 'model-projector-resume-org/model'],
  ] as const)('shows %s selected projector recovery action for downloaded vision models', (projectorLifecycleStatus, expectedLabel, testID) => {
    const model = buildModel({
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
      chatModalities: ['text', 'vision'],
      artifactRole: 'primary_chat_model',
      projectorCandidates: [buildProjector({ lifecycleStatus: projectorLifecycleStatus, matchStatus: 'matched' })],
    });

    const { getByTestId, getByText, props } = renderActionRow(model);

    expect(getByText(expectedLabel)).toBeTruthy();

    fireEvent.press(getByTestId(testID));

    expect(props.onDownload).toHaveBeenCalledWith(model);
  });

  it('shows selected projector recovery action for downloaded audio-only models', () => {
    const model = buildModel({
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
      chatModalities: ['text', 'audio'],
      artifactRole: 'primary_chat_model',
      projectorCandidates: [buildProjector({ lifecycleStatus: 'available', matchStatus: 'matched' })],
    });

    const { getByTestId, getByText, props } = renderActionRow(model);

    expect(getByText('models.multimodal.downloadProjector')).toBeTruthy();

    fireEvent.press(getByTestId('model-projector-download-org/model'));

    expect(props.onDownload).toHaveBeenCalledWith(model);
  });

  it('keeps the base model load action visible when the selected projector failed', () => {
    const model = buildModel({
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
      chatModalities: ['text', 'vision'],
      artifactRole: 'primary_chat_model',
      projectorCandidates: [buildProjector({
        lifecycleStatus: 'failed',
        matchStatus: 'matched',
        matchReason: 'download_http_error',
      })],
    });

    const { getByTestId, getByText, props } = renderActionRow(model);

    expect(getByText('models.load')).toBeTruthy();
    expect(getByTestId('model-projector-retry-org/model')).toBeTruthy();

    fireEvent.press(getByText('models.load'));

    expect(props.onLoad).toHaveBeenCalledWith(model.id);
  });

  it.each([
    ['downloaded', 'model-projector-download-org/model'],
    ['active', 'model-projector-download-org/model'],
  ] as const)('does not show a projector download action when the selected projector is already %s', (projectorLifecycleStatus, testID) => {
    const model = buildModel({
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
      chatModalities: ['text', 'vision'],
      artifactRole: 'primary_chat_model',
      projectorCandidates: [buildProjector({ lifecycleStatus: projectorLifecycleStatus, matchStatus: 'matched' })],
    });

    const { queryByTestId } = renderActionRow(model);

    expect(queryByTestId(testID)).toBeNull();
  });
});
