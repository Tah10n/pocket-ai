import React from 'react';
import { StyleSheet, useWindowDimensions } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import { ModelParametersSheet } from '../../src/components/ui/ModelParametersSheet';
import { getNativeBottomSafeAreaInset, getNativeSafeAreaInset } from '../../src/utils/safeArea';
import { motionTokens, screenLayoutMetrics } from '../../src/utils/themeTokens';

let mockSafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };

jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');

  Object.defineProperty(actual, 'useWindowDimensions', {
    configurable: true,
    value: jest.fn(() => ({
      width: 390,
      height: 800,
      scale: 1,
      fontScale: 1,
    })),
  });

  return actual;
});

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => mockSafeAreaInsets,
}));

jest.mock('../../src/providers/ThemeProvider', () => {
  const themeTokens = jest.requireActual('../../src/utils/themeTokens');

  return {
    useTheme: () => ({
      appearance: themeTokens.getThemeAppearance(themeTokens.DEFAULT_THEME_ID, 'light'),
      colors: {
        primaryStrong: '#3211d4',
        borderStrong: '#cbd5e1',
      },
    }),
  };
});

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
const useWindowDimensionsMock = useWindowDimensions as jest.MockedFunction<typeof useWindowDimensions>;

interface TestInstanceWithParent {
  props: { testID?: string };
  parent: TestInstanceWithParent | null;
}

function hasAncestorWithTestId(instance: TestInstanceWithParent, testID: string) {
  let parent = instance.parent;

  while (parent) {
    if (parent.props.testID === testID) {
      return true;
    }

    parent = parent.parent;
  }

  return false;
}

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
    mockSafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };
    useWindowDimensionsMock.mockReturnValue({
      width: 390,
      height: 800,
      scale: 1,
      fontScale: 1,
    });
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
    reactI18nextMock.__setTranslationOverride('chat.modelControls.mtpStatusNextLoad', 'Enabled for next load');
    reactI18nextMock.__setTranslationOverride('chat.modelControls.mtpStatusActive', 'Active');
    reactI18nextMock.__setTranslationOverride('chat.modelControls.mtpStatusMemoryFallback', 'Memory fallback');
    reactI18nextMock.__setTranslationOverride('chat.modelControls.mtpStatusValue', 'Status: {{status}}');
    reactI18nextMock.__setTranslationOverride('chat.modelControls.mtpDraftAcceptance', 'Accepted {{accepted}}/{{drafted}} ({{percent}}%)');
    reactI18nextMock.__setTranslationOverride('chat.modelControls.mtpNativeSpeed', 'Native {{speed}} tok/s');
    reactI18nextMock.__setTranslationOverride('chat.modelControls.mtpTtft', 'TTFT {{milliseconds}} ms');
    reactI18nextMock.__setTranslationOverride('chat.modelControls.mtpMemoryDelta', 'Memory {{memory}}');
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

  it('shows the MTP control only for supported models and forwards On/Off changes', () => {
    const onChangeMtpEnabled = jest.fn();
    const screen = renderSheet({
      mtpSupported: true,
      mtpArtifactReady: true,
      mtpEnabled: true,
      onChangeMtpEnabled,
    });

    expect(screen.getByTestId('mtp-toggle-on')).toBeTruthy();
    expect(screen.getByText('Enabled for next load')).toBeTruthy();

    fireEvent.press(screen.getByTestId('mtp-toggle-off'));
    expect(onChangeMtpEnabled).toHaveBeenCalledWith(false);

    const unsupported = renderSheet({ mtpSupported: false });
    expect(unsupported.queryByTestId('mtp-toggle-on')).toBeNull();
  });

  it('renders native MTP counters, throughput, TTFT, and measured memory delta', () => {
    const screen = renderSheet({
      mtpSupported: true,
      mtpArtifactReady: true,
      mtpEnabled: true,
      onChangeMtpEnabled: jest.fn(),
      engineDiagnostics: {
        backendMode: 'cpu',
        backendDevices: [],
        speculativeDecoding: {
          configured: true,
          enabled: true,
          active: true,
          mode: 'draft_model',
          maxDraftTokens: 3,
          memory: {
            modelInitPssDeltaBytes: 64 * 1024 * 1024,
          },
          lastCompletion: {
            tokensPredicted: 100,
            tokensEvaluated: 20,
            predictedPerSecond: 6.5,
            timeToFirstTokenMs: 910,
            mtp: {
              requested: true,
              attempted: true,
              fallbackUsed: false,
              draftTokens: 40,
              draftTokensAccepted: 18,
              acceptanceRate: 0.45,
            },
          },
        },
      },
    });

    expect(screen.getByTestId('mtp-runtime-status')).toHaveTextContent('Status: Active');
    expect(screen.getByTestId('mtp-runtime-draft-counters')).toHaveTextContent('Accepted 18/40 (45%)');
    expect(screen.getByTestId('mtp-runtime-native-speed')).toHaveTextContent('Native 6.50 tok/s');
    expect(screen.getByTestId('mtp-runtime-ttft')).toHaveTextContent('TTFT 910 ms');
    expect(screen.getByTestId('mtp-runtime-memory-delta')).toHaveTextContent('Memory 64.0 MiB');
  });

  it('reports a memory fallback instead of claiming MTP is active', () => {
    const screen = renderSheet({
      mtpSupported: true,
      mtpArtifactReady: true,
      mtpEnabled: true,
      onChangeMtpEnabled: jest.fn(),
      engineDiagnostics: {
        backendMode: 'cpu',
        backendDevices: [],
        speculativeDecoding: {
          configured: true,
          enabled: true,
          active: false,
          fallbackReason: 'memory_budget',
        },
      },
    });

    expect(screen.getByTestId('mtp-runtime-status')).toHaveTextContent('Status: Memory fallback');
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

  it('bounds the scroll area so load controls and the apply footer remain reachable', () => {
    const screen = renderSheet({
      showApplyReload: true,
      showAdvancedInferenceControls: true,
    });

    const sheet = screen.getByTestId('model-parameters-sheet');
    const fixedHeader = screen.getByTestId('model-parameters-sheet-fixed-header');
    const scroll = screen.getByTestId('model-parameters-sheet-scroll');
    const fixedFooter = screen.getByTestId('model-apply-footer');
    const resetButton = screen.getByTestId('reset-model-settings-button');
    const applyButton = screen.getByTestId('apply-model-settings-button');

    fireEvent(fixedHeader, 'layout', { nativeEvent: { layout: { height: 76 } } });

    const sheetStyle = StyleSheet.flatten(sheet.props.style);
    const scrollStyle = StyleSheet.flatten(scroll.props.style);

    expect(sheetStyle).toMatchObject({
      minHeight: 0,
      flexShrink: 1,
    });
    expect(sheetStyle.maxHeight).toBeGreaterThan(0);
    expect(fixedHeader).toBeTruthy();
    expect(scrollStyle).toMatchObject({
      alignSelf: 'stretch',
      backgroundColor: 'transparent',
      flexGrow: 0,
      minHeight: screenLayoutMetrics.sheetMinimumScrollableContentHeight,
      flexShrink: 1,
    });
    expect(scrollStyle.maxHeight).toBeGreaterThan(0);
    expect(StyleSheet.flatten(scroll.props.contentContainerStyle)).toMatchObject({
      backgroundColor: 'transparent',
      paddingBottom: screenLayoutMetrics.sheetBottomInset,
    });
    expect(screen.getByText('chat.modelControls.kvCache')).toBeTruthy();
    expect(screen.getByTestId('model-parameters-sheet-close-button')).toBeTruthy();
    expect(typeof fixedFooter.props.onLayout).toBe('function');
    expect(applyButton.props.hitSlop).toMatchObject({ top: 4, right: 4, bottom: 4, left: 4 });
    expect(resetButton.props.hitSlop).toMatchObject({ top: 4, right: 4, bottom: 4, left: 4 });
  });

  it('does not force the scroll area beyond the remaining sheet height on compact screens', () => {
    useWindowDimensionsMock.mockReturnValue({
      width: 360,
      height: 480,
      scale: 1,
      fontScale: 1,
    });
    const screen = renderSheet({
      showApplyReload: true,
      showAdvancedInferenceControls: true,
    });

    fireEvent(screen.getByTestId('model-parameters-sheet-fixed-header'), 'layout', { nativeEvent: { layout: { height: 76 } } });
    const fixedFooter = screen.getByTestId('model-apply-footer');

    fireEvent(fixedFooter, 'layout', { nativeEvent: { layout: { height: 110 } } });

    const sheetStyle = StyleSheet.flatten(screen.getByTestId('model-parameters-sheet').props.style);
    const scrollStyle = StyleSheet.flatten(screen.getByTestId('model-parameters-sheet-scroll').props.style);
    const fixedChromeHeight = screenLayoutMetrics.sheetContentTopInset
      + screenLayoutMetrics.sheetBottomInset
      + 76
      + 110
      + screenLayoutMetrics.sheetFooterTopGap;

    expect(scrollStyle.maxHeight).toBe(sheetStyle.maxHeight - fixedChromeHeight);
    expect(fixedChromeHeight + scrollStyle.maxHeight).toBeLessThanOrEqual(sheetStyle.maxHeight);
  });

  it('reserves top safe area and a backdrop touch target on very compact screens', () => {
    useWindowDimensionsMock.mockReturnValue({
      width: 360,
      height: 220,
      scale: 1,
      fontScale: 1,
    });
    mockSafeAreaInsets = { top: 44, right: 0, bottom: 0, left: 0 };
    const screen = renderSheet({
      showApplyReload: false,
      showAdvancedInferenceControls: true,
    });

    fireEvent(screen.getByTestId('model-parameters-sheet-fixed-header'), 'layout', { nativeEvent: { layout: { height: 72 } } });

    const sheetStyle = StyleSheet.flatten(screen.getByTestId('model-parameters-sheet').props.style);
    const scrollStyle = StyleSheet.flatten(screen.getByTestId('model-parameters-sheet-scroll').props.style);
    const expectedSheetMaxHeight = 220
      - getNativeSafeAreaInset(mockSafeAreaInsets.top)
      - motionTokens.minimumTouchTargetPx;
    const fixedChromeWithoutFooterHeight = screenLayoutMetrics.sheetContentTopInset
      + 72
      + screenLayoutMetrics.sheetBottomInset;

    expect(sheetStyle.maxHeight).toBe(expectedSheetMaxHeight);
    expect(sheetStyle.maxHeight).toBeLessThanOrEqual(220 - motionTokens.minimumTouchTargetPx);
    expect(scrollStyle.maxHeight).toBe(expectedSheetMaxHeight - fixedChromeWithoutFooterHeight);
    expect(scrollStyle.minHeight).toBe(Math.min(
      screenLayoutMetrics.sheetMinimumScrollableContentHeight,
      scrollStyle.maxHeight,
    ));
  });

  it('keeps the saved-profile confirmation fixed and reserves scroll space for it', () => {
    const screen = renderSheet({
      didSaveLoadProfile: true,
      showApplyReload: false,
      showAdvancedInferenceControls: true,
    });

    fireEvent(screen.getByTestId('model-parameters-sheet-fixed-header'), 'layout', { nativeEvent: { layout: { height: 76 } } });
    const fixedFooter = screen.getByTestId('model-save-confirmation-footer');

    expect(screen.queryByTestId('model-apply-footer')).toBeNull();
    expect(typeof fixedFooter.props.onLayout).toBe('function');
    expect(screen.getByText('chat.modelControls.kvCache')).toBeTruthy();

    fireEvent(fixedFooter, 'layout', { nativeEvent: { layout: { height: 82 } } });

    const sheetStyle = StyleSheet.flatten(screen.getByTestId('model-parameters-sheet').props.style);
    const scrollStyle = StyleSheet.flatten(screen.getByTestId('model-parameters-sheet-scroll').props.style);
    const fixedChromeHeight = screenLayoutMetrics.sheetContentTopInset
      + screenLayoutMetrics.sheetBottomInset
      + 76
      + 82
      + screenLayoutMetrics.sheetFooterTopGap;

    expect(scrollStyle.maxHeight).toBe(sheetStyle.maxHeight - fixedChromeHeight);
    expect(fixedChromeHeight + scrollStyle.maxHeight).toBeLessThanOrEqual(sheetStyle.maxHeight);
  });

  it('keeps a usable scroll area when footer chrome is taller than the compact sheet budget', () => {
    useWindowDimensionsMock.mockReturnValue({
      width: 360,
      height: 260,
      scale: 1,
      fontScale: 2,
    });
    mockSafeAreaInsets = { top: 0, right: 0, bottom: 24, left: 0 };
    const screen = renderSheet({
      showApplyReload: true,
      showAdvancedInferenceControls: true,
    });

    fireEvent(screen.getByTestId('model-parameters-sheet-fixed-header'), 'layout', { nativeEvent: { layout: { height: 76 } } });
    fireEvent(screen.getByTestId('model-apply-footer'), 'layout', { nativeEvent: { layout: { height: 280 } } });

    const sheetStyle = StyleSheet.flatten(screen.getByTestId('model-parameters-sheet').props.style);
    const scrollStyle = StyleSheet.flatten(screen.getByTestId('model-parameters-sheet-scroll').props.style);
    const fixedChromeWithoutFooterHeight = screenLayoutMetrics.sheetContentTopInset
      + screenLayoutMetrics.sheetBottomInset
      + 76
      + getNativeBottomSafeAreaInset(mockSafeAreaInsets.bottom);
    const expectedMinimumScrollHeight = Math.min(
      screenLayoutMetrics.sheetMinimumScrollableContentHeight,
      sheetStyle.maxHeight - fixedChromeWithoutFooterHeight,
    );

    expect(scrollStyle.minHeight).toBe(expectedMinimumScrollHeight);
    expect(scrollStyle.maxHeight).toBe(sheetStyle.maxHeight - fixedChromeWithoutFooterHeight);
    expect(scrollStyle.maxHeight).toBeGreaterThanOrEqual(scrollStyle.minHeight);
    expect(fixedChromeWithoutFooterHeight + scrollStyle.maxHeight).toBeLessThanOrEqual(sheetStyle.maxHeight);
  });

  it('moves the apply footer into the scroll area when measured height exceeds the fixed footer budget', () => {
    useWindowDimensionsMock.mockReturnValue({
      width: 360,
      height: 430,
      scale: 1,
      fontScale: 1,
    });
    const screen = renderSheet({
      showApplyReload: true,
      showAdvancedInferenceControls: true,
    });

    fireEvent(screen.getByTestId('model-parameters-sheet-fixed-header'), 'layout', { nativeEvent: { layout: { height: 76 } } });
    const fixedFooter = screen.getByTestId('model-apply-footer');

    expect(hasAncestorWithTestId(fixedFooter, 'model-parameters-sheet-scroll')).toBe(false);

    fireEvent(fixedFooter, 'layout', { nativeEvent: { layout: { height: 180 } } });

    const inlineFooter = screen.getByTestId('model-apply-footer');
    const sheetStyle = StyleSheet.flatten(screen.getByTestId('model-parameters-sheet').props.style);
    const scrollStyle = StyleSheet.flatten(screen.getByTestId('model-parameters-sheet-scroll').props.style);
    const fixedChromeWithoutFooterHeight = screenLayoutMetrics.sheetContentTopInset
      + 76
      + screenLayoutMetrics.sheetBottomInset;

    expect(hasAncestorWithTestId(inlineFooter, 'model-parameters-sheet-scroll')).toBe(true);
    expect(scrollStyle.maxHeight).toBe(sheetStyle.maxHeight - fixedChromeWithoutFooterHeight);
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
    expect(screen.getByTestId('backend-benchmark-run-button').props.hitSlop)
      .toMatchObject({ top: 4, right: 4, bottom: 4, left: 4 });

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
    expect(screen.getByTestId('backend-benchmark-cancel-button').props.hitSlop)
      .toMatchObject({ top: 4, right: 4, bottom: 4, left: 4 });

    fireEvent.press(screen.getByText('chat.modelControls.backendBenchmarkCancel'));

    expect(onCancelAutotune).toHaveBeenCalledTimes(1);
  });
});
