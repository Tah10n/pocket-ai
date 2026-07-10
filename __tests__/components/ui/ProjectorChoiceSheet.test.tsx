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

  it('marks a projector selected when selection is stored only on the active variant', () => {
    const model = buildModel();
    const variantProjectors = model.projectorCandidates!.map((projector) => ({ ...projector }));
    model.projectorCandidates = undefined;
    model.selectedProjectorId = undefined;
    model.activeVariantId = 'audio-variant';
    model.resolvedFileName = 'model-audio.gguf';
    model.chatModalities = ['text', 'vision'];
    model.variants = [{
      variantId: 'audio-variant',
      fileName: 'model-audio.gguf',
      quantizationLabel: 'Q4_K_M',
      size: model.size,
      chatModalities: ['text', 'vision'],
      projectorCandidates: variantProjectors,
      selectedProjectorId: variantProjectors[1].id,
    }];
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

    expect(mockLastListPickerProps.items[1]).toEqual(expect.objectContaining({
      key: variantProjectors[1].id,
      selected: true,
      accessibilityState: { selected: true },
    }));

    mockLastListPickerProps.items[1].onPress();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSelectProjector).not.toHaveBeenCalled();
  });

  it('prefers the active variant selection over a stale user-selected marker', () => {
    const model = buildModel();
    const variantProjectors = model.projectorCandidates!.map((projector, index) => ({
      ...projector,
      matchStatus: index === 0 ? 'user_selected' as const : 'matched' as const,
    }));
    model.projectorCandidates = undefined;
    model.selectedProjectorId = undefined;
    model.activeVariantId = 'audio-variant';
    model.resolvedFileName = 'model-audio.gguf';
    model.variants = [{
      variantId: 'audio-variant',
      fileName: 'model-audio.gguf',
      quantizationLabel: 'Q4_K_M',
      size: model.size,
      chatModalities: ['text', 'vision'],
      projectorCandidates: variantProjectors,
      selectedProjectorId: variantProjectors[1].id,
    }];

    render(
      <ProjectorChoiceSheet
        visible
        model={model}
        onSelectProjector={jest.fn()}
        onClose={jest.fn()}
      />,
    );

    expect(mockLastListPickerProps.items[0].selected).toBe(false);
    expect(mockLastListPickerProps.items[1].selected).toBe(true);
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
