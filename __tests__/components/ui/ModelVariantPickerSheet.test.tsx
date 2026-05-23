import React from 'react';
import { render } from '@testing-library/react-native';
import { ModelVariantPickerSheet } from '../../../src/components/ui/ModelVariantPickerSheet';
import { LifecycleStatus, ModelAccessState, type ModelMetadata } from '../../../src/types/models';

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

function buildModel(): ModelMetadata {
  return {
    id: 'org/model',
    name: 'Model',
    author: 'org',
    size: 4_000_000_000,
    downloadUrl: 'https://huggingface.co/org/model/resolve/main/model.Q4_K_M.gguf',
    resolvedFileName: 'model.Q4_K_M.gguf',
    activeVariantId: 'model.Q4_K_M.gguf',
    fitsInRam: true,
    accessState: ModelAccessState.PUBLIC,
    isGated: false,
    isPrivate: false,
    lifecycleStatus: LifecycleStatus.AVAILABLE,
    downloadProgress: 0,
    variants: [
      {
        variantId: 'model.Q4_K_M.gguf',
        fileName: 'model.Q4_K_M.gguf',
        quantizationLabel: 'Q4_K_M',
        size: 4_000_000_000,
        ramFit: 'fits_low_confidence',
        ramFitConfidence: 'medium',
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
  };
}

describe('ModelVariantPickerSheet', () => {
  beforeEach(() => {
    mockLastListPickerProps = null;
    mockT.mockClear();
  });

  it('keeps the selected variant focusable and closes on reselection', () => {
    const onSelectVariant = jest.fn();
    const onClose = jest.fn();

    render(
      <ModelVariantPickerSheet
        visible
        model={buildModel()}
        onSelectVariant={onSelectVariant}
        onClose={onClose}
      />,
    );

    const [selectedItem, nextItem] = mockLastListPickerProps.items;

    expect(selectedItem.title).toBe('Q4_K_M - 4.00 GB');
    expect(nextItem.title).toBe('Q8_0 - 8.00 GB');
    expect(selectedItem.supportingText).toBeUndefined();
    expect(nextItem.supportingText).toBeUndefined();
    expect(selectedItem.badges).toEqual([
      {
        key: 'memory-fit',
        label: 'models.ramFitYes',
        tone: 'success',
        iconName: 'memory',
        testID: 'model-variant-org/model-model.Q4_K_M.gguf-memory-fit',
      },
    ]);
    expect(nextItem.badges).toEqual([
      {
        key: 'memory-fit',
        label: 'models.ramLikelyOom',
        tone: 'error',
        iconName: 'warning',
        testID: 'model-variant-org/model-model.Q8_0.gguf-memory-fit',
      },
    ]);
    expect(selectedItem.selected).toBe(true);
    expect(selectedItem.disabled).toBeUndefined();
    expect(selectedItem.accessibilityLabel).toBe('models.variantPickerItemAccessibilityLabel');
    expect(mockT).toHaveBeenCalledWith('models.variantPickerItemAccessibilityLabel', {
      modelName: 'Model',
      title: 'Q4_K_M - 4.00 GB',
      fileName: 'model.Q4_K_M.gguf',
    });
    expect(mockT).toHaveBeenCalledWith('models.variantPickerItemAccessibilityLabel', {
      modelName: 'Model',
      title: 'Q8_0 - 8.00 GB',
      fileName: 'model.Q8_0.gguf',
    });
    expect(selectedItem.accessibilityHint).toBe('models.variantPickerItemSelectedAccessibilityHint');
    expect(selectedItem.accessibilityState).toEqual({ selected: true });
    expect(nextItem.accessibilityHint).toBe('models.variantPickerItemAccessibilityHint');

    selectedItem.onPress();
    expect(onSelectVariant).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);

    nextItem.onPress();
    expect(onSelectVariant).toHaveBeenCalledWith('model.Q8_0.gguf');
  });

  it('does not build picker rows while hidden', () => {
    render(
      <ModelVariantPickerSheet
        visible={false}
        model={buildModel()}
        onSelectVariant={jest.fn()}
        onClose={jest.fn()}
      />,
    );

    expect(mockLastListPickerProps.items).toEqual([]);
  });

  it('filters unsupported GGUF companion files out of the picker rows', () => {
    const model = buildModel();
    model.variants = [
      ...model.variants!,
      {
        variantId: 'model.mmproj.gguf',
        fileName: 'model.mmproj.gguf',
        quantizationLabel: 'Projector',
        size: 256_000_000,
      },
      {
        variantId: 'model.NextN.gguf',
        fileName: 'model.NextN.gguf',
        quantizationLabel: 'NextN',
        size: 512_000_000,
      },
    ];

    render(
      <ModelVariantPickerSheet
        visible
        model={model}
        onSelectVariant={jest.fn()}
        onClose={jest.fn()}
      />,
    );

    expect(mockLastListPickerProps.items.map((item: { key: string }) => item.key)).toEqual([
      'model.Q4_K_M.gguf',
      'model.Q8_0.gguf',
    ]);
  });
});
