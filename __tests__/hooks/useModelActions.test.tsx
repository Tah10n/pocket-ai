import React, { useEffect } from 'react';
import { act, render } from '@testing-library/react-native';
import { router } from 'expo-router';
import { useModelActions } from '../../src/hooks/useModelActions';
import { EngineStatus, type EngineState, type ModelMetadata } from '../../src/types/models';

function renderHookHarness(models: ModelMetadata[] = []) {
  let currentValue: ReturnType<typeof useModelActions> | null = null;

  const engineState: EngineState = {
    activeModelId: undefined,
    lastError: undefined,
    loadProgress: 0,
    status: EngineStatus.IDLE,
  };

  const Harness = () => {
    const value = useModelActions({
      activeTab: 'all',
      models,
      engineState,
      loadModel: jest.fn(),
      unloadModel: jest.fn(),
      startDownload: jest.fn(),
      cancelDownload: jest.fn(),
      refreshDownloadedModels: jest.fn(),
      requestCatalogRefresh: jest.fn(),
      showError: jest.fn(),
      t: ((key: string) => key) as any,
    });

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

describe('useModelActions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('passes the active variant id to the model details route', () => {
    const { getCurrentValue } = renderHookHarness();

    act(() => {
      getCurrentValue()?.openModelDetails('org/model', {
        activeVariantId: ' model.Q8_0.gguf ',
      } as ModelMetadata);
    });

    expect(router.push).toHaveBeenCalledWith({
      pathname: '/model-details',
      params: {
        modelId: 'org/model',
        variantId: 'model.Q8_0.gguf',
      },
    });
  });

  it('omits the variant route param when no active variant is available', () => {
    const { getCurrentValue } = renderHookHarness();

    act(() => {
      getCurrentValue()?.openModelDetails('org/model', {} as ModelMetadata);
    });

    expect(router.push).toHaveBeenCalledWith({
      pathname: '/model-details',
      params: { modelId: 'org/model' },
    });
  });

  it('omits blank active variant ids from the model details route', () => {
    const { getCurrentValue } = renderHookHarness();

    act(() => {
      getCurrentValue()?.openModelDetails('org/model', {
        activeVariantId: '   ',
      } as ModelMetadata);
    });

    expect(router.push).toHaveBeenCalledWith({
      pathname: '/model-details',
      params: { modelId: 'org/model' },
    });
  });
});
