import React from 'react';
import { render } from '@testing-library/react-native';
import { ProjectorChoiceSheet } from '../../../src/components/ui/ProjectorChoiceSheet';
import { LifecycleStatus, ModelAccessState, type ModelMetadata } from '../../../src/types/models';
import type { ProjectorArtifact } from '../../../src/types/multimodal';

let mockLastListPickerProps: any = null;
const mockT = jest.fn((key: string) => key);

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: mockT,
  }),
}));

jest.mock('../../../src/components/ui/ListPickerSheet', () => ({
  ListPickerSheet: (props: any) => {
    mockLastListPickerProps = props;
    return null;
  },
}));

function buildProjector(overrides: Partial<ProjectorArtifact> = {}): ProjectorArtifact {
  return {
    id: 'projector-org-model-main-mmproj-a.gguf',
    ownerModelId: 'org/model',
    repoId: 'org/model',
    fileName: 'mmproj-a.gguf',
    downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-a.gguf',
    size: 512_000_000,
    lifecycleStatus: 'available',
    matchStatus: 'ambiguous',
    ...overrides,
  };
}

function buildModel(): ModelMetadata {
  return {
    id: 'org/model',
    name: 'Model',
    author: 'org',
    size: 4_000_000_000,
    downloadUrl: 'https://huggingface.co/org/model/resolve/main/model.gguf',
    resolvedFileName: 'model.gguf',
    fitsInRam: true,
    accessState: ModelAccessState.PUBLIC,
    isGated: false,
    isPrivate: false,
    lifecycleStatus: LifecycleStatus.AVAILABLE,
    downloadProgress: 0,
    activeVariantId: 'model.gguf',
    chatModalities: ['text', 'vision'],
    projectorCandidates: [
      buildProjector(),
      buildProjector({
        id: 'projector-org-model-main-mmproj-b.gguf',
        fileName: 'mmproj-b.gguf',
        size: 256_000_000,
      }),
    ],
  };
}

describe('ProjectorChoiceSheet', () => {
  beforeEach(() => {
    mockLastListPickerProps = null;
    mockT.mockClear();
  });

  it('renders compatible projector choices and persists a selection through the callback', () => {
    const onSelectProjector = jest.fn();
    const onClose = jest.fn();

    render(
      <ProjectorChoiceSheet
        visible
        model={buildModel()}
        onSelectProjector={onSelectProjector}
        onClose={onClose}
      />,
    );

    const [firstItem, secondItem] = mockLastListPickerProps.items;

    expect(mockLastListPickerProps.title).toBe('models.multimodal.projectorChoiceTitle');
    expect(mockLastListPickerProps.testID).toBe('projector-choice-sheet');
    expect(firstItem.title).toBe('mmproj-a.gguf - 0.51 GB');
    expect(secondItem.title).toBe('mmproj-b.gguf - 0.26 GB');
    expect(firstItem.badges).toEqual([
      expect.objectContaining({
        key: 'lifecycle',
        label: 'models.multimodal.projectorAvailable',
        tone: 'neutral',
      }),
    ]);
    expect(firstItem.accessibilityLabel).toBe('models.multimodal.projectorChoiceItemAccessibilityLabel');
    expect(mockT).toHaveBeenCalledWith('models.multimodal.projectorChoiceItemAccessibilityLabel', {
      modelName: 'Model',
      title: 'mmproj-a.gguf - 0.51 GB',
      fileName: 'mmproj-a.gguf',
    });

    firstItem.onPress();
    expect(onSelectProjector).toHaveBeenCalledWith('projector-org-model-main-mmproj-a.gguf');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes without selecting when the current projector is reselected', () => {
    const model = buildModel();
    model.selectedProjectorId = 'projector-org-model-main-mmproj-b.gguf';
    model.projectorCandidates = model.projectorCandidates?.map((projector) => (
      projector.id === model.selectedProjectorId
        ? { ...projector, matchStatus: 'user_selected' }
        : projector
    ));
    const onSelectProjector = jest.fn();
    const onClose = jest.fn();

    render(
      <ProjectorChoiceSheet
        visible
        model={model}
        onSelectProjector={onSelectProjector}
        onClose={onClose}
      />,
    );

    const selectedItem = mockLastListPickerProps.items[1];
    expect(selectedItem.selected).toBe(true);

    selectedItem.onPress();

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSelectProjector).not.toHaveBeenCalled();
  });

  it('does not build picker rows while hidden', () => {
    render(
      <ProjectorChoiceSheet
        visible={false}
        model={buildModel()}
        onSelectProjector={jest.fn()}
        onClose={jest.fn()}
      />,
    );

    expect(mockLastListPickerProps.items).toEqual([]);
  });
});
