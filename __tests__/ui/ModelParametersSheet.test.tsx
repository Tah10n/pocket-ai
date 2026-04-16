import React from 'react';
import { render } from '@testing-library/react-native';
import { ModelParametersSheet } from '../../src/components/ui/ModelParametersSheet';

jest.mock('../../src/providers/ThemeProvider', () => ({
  useTheme: () => ({
    colors: {
      primaryStrong: '#3211d4',
      borderStrong: '#cbd5e1',
    },
  }),
}));

jest.mock('../../src/components/ui/MaterialSymbols', () => {
  return {
    MaterialSymbols: () => null,
  };
});

const reactI18nextMock = jest.requireMock('react-i18next') as {
  __setTranslationOverride: (key: string, value: string, nextLanguage?: string) => void;
  __resetTranslations: () => void;
};

const baseGenerationParams = {
  temperature: 0.7,
  topP: 0.9,
  topK: 40,
  minP: 0.05,
  repetitionPenalty: 1,
  maxTokens: 512,
  reasoningEffort: 'auto' as const,
  seed: null,
};

const baseLoadParams = {
  contextSize: 4096,
  gpuLayers: 12,
  kvCacheType: 'f16' as const,
  backendPolicy: undefined,
};

function renderSheet(overrides: Partial<React.ComponentProps<typeof ModelParametersSheet>> = {}) {
  return render(
    <ModelParametersSheet
      visible
      modelId="author/model-q4"
      modelLabel="Test Model"
      params={baseGenerationParams}
      defaultParams={baseGenerationParams}
      loadParamsDraft={baseLoadParams}
      defaultLoadParams={baseLoadParams}
      recommendedGpuLayers={12}
      applyAction="reload"
      applyButtonLabel="Apply & reload"
      canApplyReload
      isApplyingReload={false}
      showApplyReload={false}
      showAdvancedInferenceControls
      onClose={jest.fn()}
      onChangeParams={jest.fn()}
      onChangeLoadParams={jest.fn()}
      onResetParamField={jest.fn()}
      onResetLoadField={jest.fn()}
      onReset={jest.fn()}
      onApplyReload={jest.fn()}
      {...overrides}
    />,
  );
}

describe('ModelParametersSheet', () => {
  beforeEach(() => {
    reactI18nextMock.__resetTranslations();
    reactI18nextMock.__setTranslationOverride(
      'chat.modelControls.descriptionForModel',
      'Saved separately for {{modelLabel}}. Sampling changes apply immediately, while load settings use {{loadAction}}.',
    );
  });

  it('shows backend policy controls on GPU-only devices', () => {
    const screen = renderSheet({
      isGpuBackendAvailable: true,
      isNpuBackendAvailable: false,
      isBackendDiscoveryUnavailable: false,
    });

    expect(screen.getByTestId('backend-policy-auto')).toBeTruthy();
    expect(screen.getByTestId('backend-policy-cpu')).toBeTruthy();
    expect(screen.getByTestId('backend-policy-gpu')).toBeTruthy();
    expect(screen.queryByTestId('backend-policy-npu')).toBeNull();
  });

  it('uses the current load action in the model description', () => {
    const screen = renderSheet({
      applyAction: 'save',
      applyButtonLabel: 'Save load profile',
    });

    expect(
      screen.getByText(
        'Saved separately for Test Model. Sampling changes apply immediately, while load settings use Save load profile.',
      ),
    ).toBeTruthy();
  });
});
