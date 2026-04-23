import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
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

jest.mock('../../src/services/GpuInfoService', () => ({
  getAndroidGpuInfo: jest.fn(() => new Promise(() => {})),
}));

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
    reactI18nextMock.__setTranslationOverride('chat.modelControls.reasoningUnsupported', 'Reasoning unavailable');
    reactI18nextMock.__setTranslationOverride('chat.modelControls.reasoningRequired', 'Reasoning required');
    reactI18nextMock.__setTranslationOverride('chat.modelControls.gpuLayersValue', 'GPU {{count}}');
    reactI18nextMock.__setTranslationOverride('chat.modelControls.gpuLayersDisabledDescription', 'GPU layers disabled on CPU');
    reactI18nextMock.__setTranslationOverride('chat.modelControls.runtimeLoadedValue', 'Loaded context {{contextSize}} gpu {{gpuLayers}}');
    reactI18nextMock.__setTranslationOverride('chat.modelControls.backendBenchmarkProgressLoading', 'Loading {{backend}} {{index}}/{{total}}');
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

  it('disables reasoning controls when the model does not support reasoning', () => {
    const onChangeParams = jest.fn();
    const screen = renderSheet({
      supportsReasoning: false,
      onChangeParams,
    });

    expect(screen.getByText('Reasoning unavailable')).toBeTruthy();

    fireEvent.press(screen.getByTestId('reasoning-effort-low'));

    expect(onChangeParams).not.toHaveBeenCalled();
  });

  it('removes the off reasoning option when reasoning is required', () => {
    const screen = renderSheet({ requiresReasoning: true });

    expect(screen.queryByTestId('reasoning-effort-off')).toBeNull();
    expect(screen.getByText('Reasoning required')).toBeTruthy();
  });

  it('switches from random to a fixed default seed', () => {
    const onChangeParams = jest.fn();
    const screen = renderSheet({ onChangeParams });

    fireEvent.press(screen.getByLabelText('chat.modelControls.seedFixed'));

    expect(onChangeParams).toHaveBeenCalledWith({ seed: 42 });
  });

  it('restores the previous seed when editing ends with blank or invalid text', () => {
    const screen = renderSheet({
      params: { ...baseGenerationParams, seed: 7 },
    });
    const input = screen.getByPlaceholderText('chat.modelControls.seedValue');

    fireEvent.changeText(input, '');
    fireEvent(input, 'endEditing', { nativeEvent: { text: '' } });
    expect(screen.getByDisplayValue('7')).toBeTruthy();

    fireEvent.changeText(input, 'abc');
    fireEvent(input, 'endEditing', { nativeEvent: { text: 'abc' } });
    expect(screen.getByDisplayValue('7')).toBeTruthy();
  });

  it('clamps fixed seed input to the supported integer range', () => {
    const onChangeParams = jest.fn();
    const screen = renderSheet({
      params: { ...baseGenerationParams, seed: 5 },
      onChangeParams,
    });
    const input = screen.getByPlaceholderText('chat.modelControls.seedValue');

    fireEvent.changeText(input, '999999999999');
    fireEvent(input, 'endEditing', { nativeEvent: { text: '999999999999' } });

    expect(onChangeParams).toHaveBeenCalledWith({ seed: 2147483647 });
    expect(screen.getByDisplayValue('2147483647')).toBeTruthy();
  });

  it('hides backend controls when backend discovery is unavailable', () => {
    const screen = renderSheet({
      isGpuBackendAvailable: false,
      isNpuBackendAvailable: false,
      isBackendDiscoveryUnavailable: true,
    });

    expect(screen.queryByTestId('backend-policy-auto')).toBeNull();
    expect(screen.queryByText('chat.modelControls.gpuLayers')).toBeNull();
  });

  it('keeps GPU backend controls visible when runtime diagnostics report GPU support', () => {
    const screen = renderSheet({
      isGpuBackendAvailable: false,
      isNpuBackendAvailable: false,
      isBackendDiscoveryUnavailable: true,
      engineDiagnostics: {
        backendMode: 'gpu',
        backendDevices: ['opencl'],
        loadedGpuLayers: 4,
      } as any,
    });

    expect(screen.getByTestId('backend-policy-gpu')).toBeTruthy();
    expect(screen.getByText('chat.modelControls.gpuLayers')).toBeTruthy();
  });

  it('uses the loaded load profile when there are no pending reload changes', () => {
    const screen = renderSheet({
      loadParamsDraft: {
        ...baseLoadParams,
        contextSize: 8192,
        gpuLayers: 20,
      },
      loadedContextSize: 2048,
      loadedGpuLayers: 3,
      showApplyReload: false,
    });

    expect(screen.getByText('Loaded context 2048 gpu 3')).toBeTruthy();
    expect(screen.getByText('2048 tok')).toBeTruthy();
    expect(screen.getByText('GPU 3')).toBeTruthy();
    expect(screen.queryByText('8192 tok')).toBeNull();
    expect(screen.queryByText('GPU 20')).toBeNull();
  });

  it('shows a CPU-specific GPU layers description when CPU backend is selected', () => {
    const screen = renderSheet({
      isGpuBackendAvailable: true,
      loadParamsDraft: {
        ...baseLoadParams,
        backendPolicy: 'cpu',
      },
    });

    expect(screen.getByText('GPU layers disabled on CPU')).toBeTruthy();
  });

  it('shows cancelled autotune results and runs autotune when requested', () => {
    const onRunAutotune = jest.fn();
    const screen = renderSheet({
      canRunAutotune: true,
      onRunAutotune,
      autotuneResult: {
        cancelled: true,
        bestStable: {
          backendMode: 'gpu',
          nGpuLayers: 8,
        },
        candidates: [
          {
            success: true,
            profile: { backendMode: 'gpu', nGpuLayers: 8 },
            tokensPerSec: 25,
            ttftMs: 123,
            durationMs: 456,
          },
        ],
      } as any,
    });

    expect(screen.getByText('chat.modelControls.backendBenchmarkCancelledNote')).toBeTruthy();
    expect(screen.getByText('chat.modelControls.backendBenchmarkResultsTitle')).toBeTruthy();

    fireEvent.press(screen.getByText('chat.modelControls.backendBenchmarkRun'));

    expect(onRunAutotune).toHaveBeenCalledTimes(1);
  });

  it('shows running autotune progress and allows cancelling', () => {
    const onCancelAutotune = jest.fn();
    const screen = renderSheet({
      isAutotuneRunning: true,
      onCancelAutotune,
      autotuneProgress: {
        stage: 'loadingCandidate',
        step: 2,
        totalSteps: 4,
        candidate: { backendMode: 'npu' },
        candidateIndex: 1,
        candidateCount: 3,
      } as any,
    });

    expect(screen.getByText('Loading chat.modelControls.backendModeNpu 1/3 50%')).toBeTruthy();

    fireEvent.press(screen.getByText('chat.modelControls.backendBenchmarkCancel'));

    expect(onCancelAutotune).toHaveBeenCalledTimes(1);
  });
});
