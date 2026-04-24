import React from 'react';
import { render } from '@testing-library/react-native';
import { ModelDownloadProgress } from '../../../src/components/ui/ModelLifecycleControls';
import { useDownloadStore } from '../../../src/store/downloadStore';
import { LifecycleStatus, ModelAccessState, type ModelMetadata } from '../../../src/types/models';

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
    expect(getByTestId('model-download-progress-fill-org/model').props.style).toEqual({ width: '42%' });
  });

  it('uses warning styling for paused progress', () => {
    const { getByTestId, getByText } = render(
      <ModelDownloadProgress model={buildModel({ lifecycleStatus: LifecycleStatus.PAUSED, downloadProgress: 0.24 })} />,
    );

    expect(getByText('models.paused')).toBeTruthy();
    expect(getByText('24%')).toBeTruthy();
    expect(getByTestId('model-download-progress-org/model').props.className).toContain('bg-background-warning');
    expect(getByTestId('model-download-progress-fill-org/model').props.className).toContain('bg-warning-500');
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
