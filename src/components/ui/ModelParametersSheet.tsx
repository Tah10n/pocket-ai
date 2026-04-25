import React, { useEffect, useState } from 'react';
import { Modal } from 'react-native';
import Slider from '@react-native-community/slider';
import { useTranslation } from 'react-i18next';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { Pressable } from '@/components/ui/pressable';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { ScrollView } from '@/components/ui/scroll-view';
import {
  ScreenBadge,
  ScreenCard,
  ScreenIconButton,
  ScreenInlineInput,
  ScreenModalOverlay,
  ScreenSegmentedControl,
  ScreenSheet,
  ScreenStack,
} from '@/components/ui/ScreenShell';
import { Text } from '@/components/ui/text';
import type { EngineDiagnostics } from '@/types/models';
import { screenLayoutTokens } from '@/utils/themeTokens';
import {
  GenerationParameters,
  ModelLoadParameters,
  ModelLoadProfileField,
  UNKNOWN_MODEL_GPU_LAYERS_CEILING,
} from '../../services/SettingsStore';
import type { AutotuneResult } from '../../services/InferenceAutotuneStore';
import type { AutotuneProgressSnapshot } from '../../services/InferenceAutotuneService';
import type { AndroidGpuInfoSnapshot } from '../../services/GpuInfoService';
import { getAndroidGpuInfo } from '../../services/GpuInfoService';
import { useTheme } from '../../providers/ThemeProvider';
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  MAX_CONTEXT_WINDOW_TOKENS,
  MIN_CONTEXT_WINDOW_TOKENS,
} from '../../utils/contextWindow';

interface ModelParametersSheetProps {
  visible: boolean;
  modelId: string | null;
  modelLabel: string;
  params: GenerationParameters;
  defaultParams: GenerationParameters;
  supportsReasoning?: boolean;
  requiresReasoning?: boolean;
  contextWindowCeiling?: number;
  gpuLayersCeiling?: number;
  isSafeModeActive?: boolean;
  loadParamsDraft: ModelLoadParameters;
  defaultLoadParams: ModelLoadParameters;
  recommendedGpuLayers: number;
  isGpuBackendAvailable?: boolean | null;
  isNpuBackendAvailable?: boolean | null;
  isBackendDiscoveryUnavailable?: boolean | null;
  didSaveLoadProfile?: boolean;
  applyAction: 'reload' | 'save';
  applyButtonLabel: string;
  canApplyReload: boolean;
  isApplyingReload: boolean;
  showApplyReload: boolean;
  loadedContextSize?: number | null;
  loadedGpuLayers?: number | null;
  engineDiagnostics?: EngineDiagnostics | null;
  showAdvancedInferenceControls?: boolean;
  canRunAutotune?: boolean;
  isAutotuneRunning?: boolean;
  autotuneResult?: AutotuneResult | null;
  autotuneProgress?: AutotuneProgressSnapshot | null;
  onRunAutotune?: () => void;
  onCancelAutotune?: () => void;
  onClose: () => void;
  onChangeParams: (partial: Partial<GenerationParameters>) => void;
  onChangeLoadParams: (partial: Partial<ModelLoadParameters>) => void;
  onResetParamField: (field: keyof GenerationParameters) => void;
  onResetLoadField: (field: ModelLoadProfileField) => void;
  onReset: () => void;
  onApplyReload: () => void;
}

interface SliderRowProps {
  label: string;
  description: string;
  valueLabel: string;
  minLabel: string;
  maxLabel: string;
  minimumValue: number;
  maximumValue: number;
  step: number;
  value: number;
  onValueChange: (value: number) => void;
  onReset?: () => void;
  isResetDisabled?: boolean;
  variant?: 'standalone' | 'embedded';
  disabled?: boolean;
}

interface ParameterControlCardProps {
  label: string;
  description: string;
  badge: React.ReactNode;
  resetAction?: React.ReactNode;
  children: React.ReactNode;
  variant?: 'standalone' | 'embedded';
  disabled?: boolean;
  helperText?: string;
}

const accentEyebrowClassName = 'text-xs font-semibold uppercase tracking-wider text-primary-600 dark:text-primary-300';
const cardTitleClassName = 'text-base font-semibold text-typography-900 dark:text-typography-100';
const cardDescriptionClassName = 'text-sm leading-5 text-typography-500 dark:text-typography-400';

function ResetAction({
  onPress,
  disabled = false,
}: {
  onPress: () => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();

  return (
    <Button onPress={onPress} action="softPrimary" size="xs" disabled={disabled}>
      <ButtonText>{t('common.reset')}</ButtonText>
    </Button>
  );
}

function ParameterControlCard({
  label,
  description,
  badge,
  resetAction,
  children,
  variant = 'standalone',
  disabled = false,
  helperText,
}: ParameterControlCardProps) {
  return (
    <ScreenCard
      variant={variant === 'embedded' ? 'inset' : 'surface'}
      padding="default"
      className={disabled ? 'opacity-60' : undefined}
    >
      <ScreenStack gap="default">
        <Box className="flex-row items-start justify-between gap-3">
          <Box className="min-w-0 flex-1">
            <Text className={cardTitleClassName}>
              {label}
            </Text>
            <Text className={`mt-1 ${cardDescriptionClassName}`}>
              {description}
            </Text>
            {helperText ? (
              <Text className="mt-2 text-xs leading-5 text-typography-500 dark:text-typography-400">
                {helperText}
              </Text>
            ) : null}
          </Box>

          <ScreenBadge tone={disabled ? 'neutral' : 'accent'} className="self-start shrink-0 px-3 py-1.5">
            {badge}
          </ScreenBadge>
        </Box>

        {resetAction ? (
          <Box className="flex-row justify-end">
            {resetAction}
          </Box>
        ) : null}

        {children}
      </ScreenStack>
    </ScreenCard>
  );
}

function SliderRow({
  label,
  description,
  valueLabel,
  minLabel,
  maxLabel,
  minimumValue,
  maximumValue,
  step,
  value,
  onValueChange,
  onReset,
  isResetDisabled = false,
  variant = 'standalone',
  disabled = false,
}: SliderRowProps) {
  const { colors } = useTheme();

  return (
    <ParameterControlCard
      label={label}
      description={description}
      badge={valueLabel}
      resetAction={onReset ? (
        <ResetAction onPress={onReset} disabled={disabled || isResetDisabled} />
      ) : undefined}
      variant={variant}
      disabled={disabled}
    >
      <Box className="gap-2.5">
        <Slider
          style={{ width: '100%', height: 40 }}
          minimumValue={minimumValue}
          maximumValue={maximumValue}
          step={step}
          value={value}
          onValueChange={onValueChange}
          disabled={disabled}
          minimumTrackTintColor={colors.primaryStrong}
          maximumTrackTintColor={colors.borderStrong}
          thumbTintColor={colors.primaryStrong}
        />

        <Box className="flex-row items-center justify-between">
          <Text className="text-xs font-medium text-typography-400 dark:text-typography-500">
            {minLabel}
          </Text>
          <Text className="text-xs font-medium text-typography-400 dark:text-typography-500">
            {maxLabel}
          </Text>
        </Box>
      </Box>
    </ParameterControlCard>
  );
}

interface SegmentedControlRowOption {
  key: string;
  label: string;
  testID?: string;
  accessibilityLabel?: string;
}

interface SegmentedControlRowProps {
  label: string;
  description: string;
  options: SegmentedControlRowOption[];
  activeKey: string;
  onChange: (key: string) => void;
  onReset?: () => void;
  isResetDisabled?: boolean;
  variant?: 'standalone' | 'embedded';
  disabled?: boolean;
  helperText?: string;
}

function SegmentedControlRow({
  label,
  description,
  options,
  activeKey,
  onChange,
  onReset,
  isResetDisabled = false,
  variant = 'standalone',
  disabled = false,
  helperText,
}: SegmentedControlRowProps) {
  const activeLabel = options.find((option) => option.key === activeKey)?.label ?? activeKey;

  return (
    <ParameterControlCard
      label={label}
      description={description}
      badge={activeLabel}
      resetAction={onReset ? (
        <ResetAction onPress={onReset} disabled={disabled || isResetDisabled} />
      ) : undefined}
      variant={variant}
      disabled={disabled}
      helperText={helperText}
    >
      <ScreenSegmentedControl
        options={options.map((option) => ({
          key: option.key,
          label: option.label,
          testID: option.testID,
          accessibilityLabel: option.accessibilityLabel,
        }))}
        activeKey={activeKey}
        onChange={onChange}
        disabled={disabled}
      />
    </ParameterControlCard>
  );
}

function formatDecimal(value: number) {
  return value.toFixed(2).replace(/\.?0+$/, '');
}

export function ModelParametersSheet({
  visible,
  modelId,
  modelLabel,
  params,
  defaultParams,
  supportsReasoning = true,
  requiresReasoning = false,
  contextWindowCeiling,
  gpuLayersCeiling,
  isSafeModeActive = false,
  loadParamsDraft,
  defaultLoadParams,
  recommendedGpuLayers,
  isGpuBackendAvailable,
  isNpuBackendAvailable,
  isBackendDiscoveryUnavailable,
  didSaveLoadProfile = false,
  applyAction,
  applyButtonLabel,
  canApplyReload,
  isApplyingReload,
  showApplyReload,
  loadedContextSize,
  loadedGpuLayers,
  engineDiagnostics,
  showAdvancedInferenceControls = false,
  canRunAutotune = false,
  isAutotuneRunning = false,
  autotuneResult,
  autotuneProgress,
  onRunAutotune,
  onCancelAutotune,
  onClose,
  onChangeParams,
  onChangeLoadParams,
  onResetParamField,
  onResetLoadField,
  onReset,
  onApplyReload,
}: ModelParametersSheetProps) {
  const { t } = useTranslation();
  const { appearance } = useTheme();
  const [seedInput, setSeedInput] = useState(() => (params.seed === null ? '' : String(params.seed)));
  const [androidGpuInfo, setAndroidGpuInfo] = useState<AndroidGpuInfoSnapshot | null>(null);
  const runtimeBackendDevicesText = (
    Array.isArray(engineDiagnostics?.backendDevices) && engineDiagnostics.backendDevices.length > 0
      ? engineDiagnostics.backendDevices.join(' ')
      : Array.isArray(engineDiagnostics?.initDevices) && engineDiagnostics.initDevices.length > 0
        ? engineDiagnostics.initDevices.join(' ')
        : ''
  ).toLowerCase();
  const runtimeReportsNpuBackend = engineDiagnostics?.backendMode === 'npu'
    || runtimeBackendDevicesText.includes('htp')
    || runtimeBackendDevicesText.includes('hexagon')
    || runtimeBackendDevicesText.includes('qnn');
  const runtimeReportsGpuBackend = engineDiagnostics?.backendMode === 'gpu'
    || runtimeBackendDevicesText.includes('opencl')
    || runtimeBackendDevicesText.includes('metal');
  const runtimeReportsAnyBackend = runtimeReportsNpuBackend || runtimeReportsGpuBackend;
  const backendDiscoveryUnavailable = isBackendDiscoveryUnavailable === true && !runtimeReportsAnyBackend;
  const isReasoningEffortDisabled = !supportsReasoning;
  const reasoningHelperText = !supportsReasoning
    ? t('chat.modelControls.reasoningUnsupported')
    : requiresReasoning
      ? t('chat.modelControls.reasoningRequired')
      : undefined;

  useEffect(() => {
    if (!visible) {
      return;
    }

    setSeedInput(params.seed === null ? '' : String(params.seed));
  }, [modelId, params.seed, visible]);

  useEffect(() => {
    let cancelled = false;

    if (!visible) {
      setAndroidGpuInfo(null);
      return () => {
        cancelled = true;
      };
    }

    getAndroidGpuInfo()
      .then((snapshot) => {
        if (!cancelled) {
          setAndroidGpuInfo(snapshot);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAndroidGpuInfo(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [visible]);
  const resolvedContextWindowCeiling = contextWindowCeiling
    ? Math.max(MIN_CONTEXT_WINDOW_TOKENS, Math.min(MAX_CONTEXT_WINDOW_TOKENS, contextWindowCeiling))
    : DEFAULT_CONTEXT_WINDOW_TOKENS;
  const resolvedGpuLayersCeiling = typeof gpuLayersCeiling === 'number' && Number.isFinite(gpuLayersCeiling)
    ? Math.max(0, Math.round(gpuLayersCeiling))
    : UNKNOWN_MODEL_GPU_LAYERS_CEILING;
  const resolvedLoadedContextSize = typeof loadedContextSize === 'number'
    && Number.isFinite(loadedContextSize)
    && loadedContextSize > 0
    ? Math.min(
        resolvedContextWindowCeiling,
        Math.max(MIN_CONTEXT_WINDOW_TOKENS, Math.round(loadedContextSize)),
      )
    : null;
  const resolvedLoadedGpuLayers = typeof loadedGpuLayers === 'number'
    && Number.isFinite(loadedGpuLayers)
    && loadedGpuLayers >= 0
    ? Math.min(
        resolvedGpuLayersCeiling,
        Math.max(0, Math.round(loadedGpuLayers)),
      )
    : null;
  const resolvedDiagnosticLoadedGpuLayers = typeof engineDiagnostics?.loadedGpuLayers === 'number'
    && Number.isFinite(engineDiagnostics.loadedGpuLayers)
    && engineDiagnostics.loadedGpuLayers >= 0
    ? Math.min(
        resolvedGpuLayersCeiling,
        Math.max(0, Math.round(engineDiagnostics.loadedGpuLayers)),
      )
    : null;
  const reportedLoadedGpuLayers = resolvedDiagnosticLoadedGpuLayers ?? resolvedLoadedGpuLayers;
  const showLoadedLoadProfile = !showApplyReload && resolvedLoadedContextSize !== null;
  const displayedContextSize = showLoadedLoadProfile
    ? resolvedLoadedContextSize
    : Math.min(
        resolvedContextWindowCeiling,
        Math.max(MIN_CONTEXT_WINDOW_TOKENS, Math.round(loadParamsDraft.contextSize)),
      );
  const displayedGpuLayers = showLoadedLoadProfile && reportedLoadedGpuLayers !== null
    ? reportedLoadedGpuLayers
    : Math.min(
        resolvedGpuLayersCeiling,
        Math.max(0, Math.round(loadParamsDraft.gpuLayers ?? recommendedGpuLayers)),
      );
  const defaultContextSize = Math.min(
    resolvedContextWindowCeiling,
    Math.max(MIN_CONTEXT_WINDOW_TOKENS, Math.round(defaultLoadParams.contextSize)),
  );
  const defaultGpuLayers = Math.min(
    resolvedGpuLayersCeiling,
    Math.max(0, Math.round(defaultLoadParams.gpuLayers ?? recommendedGpuLayers)),
  );
  const displayedKvCacheType = loadParamsDraft.kvCacheType;
  const defaultKvCacheType = defaultLoadParams.kvCacheType;
  const resolvedGpuBackendAvailable = typeof isGpuBackendAvailable === 'boolean'
    ? isGpuBackendAvailable
    : null;
  const showGpuControls = !backendDiscoveryUnavailable && (resolvedGpuBackendAvailable !== false || runtimeReportsGpuBackend);
  const resolvedNpuBackendAvailable = !backendDiscoveryUnavailable && (isNpuBackendAvailable === true || runtimeReportsNpuBackend);
  const normalizedBackendPolicy = loadParamsDraft.backendPolicy && loadParamsDraft.backendPolicy !== 'auto'
    ? loadParamsDraft.backendPolicy
    : undefined;
  const normalizedDefaultBackendPolicy = defaultLoadParams.backendPolicy && defaultLoadParams.backendPolicy !== 'auto'
    ? defaultLoadParams.backendPolicy
    : undefined;
  const showOffloadLayerControls = !backendDiscoveryUnavailable && (
    showGpuControls
    || resolvedNpuBackendAvailable
    || normalizedBackendPolicy === 'npu'
    || normalizedDefaultBackendPolicy === 'npu'
  );
  const shouldShowBackendPolicyControls = showGpuControls
    || resolvedNpuBackendAvailable
    || normalizedBackendPolicy !== undefined
    || normalizedDefaultBackendPolicy !== undefined;
  const displayedBackendPolicy = normalizedBackendPolicy ?? 'auto';
  const backendPolicyOptions = [
    {
      key: 'auto',
      label: t('chat.modelControls.backendPolicyAuto'),
      testID: 'backend-policy-auto',
    },
    ...((resolvedNpuBackendAvailable || normalizedBackendPolicy === 'npu' || normalizedDefaultBackendPolicy === 'npu')
      ? [{ key: 'npu', label: t('chat.modelControls.backendPolicyNpu'), testID: 'backend-policy-npu' }]
      : []),
    {
      key: 'cpu',
      label: t('chat.modelControls.backendPolicyCpu'),
      testID: 'backend-policy-cpu',
    },
    ...((showGpuControls || normalizedBackendPolicy === 'gpu' || normalizedDefaultBackendPolicy === 'gpu')
      ? [{ key: 'gpu', label: t('chat.modelControls.backendPolicyGpu'), testID: 'backend-policy-gpu' }]
      : []),
  ];
  const isGpuLayersDisabled = normalizedBackendPolicy === 'cpu';
  const gpuLayersRowDescription = isGpuLayersDisabled
    ? t('chat.modelControls.gpuLayersDisabledDescription')
    : t('chat.modelControls.gpuLayersDescription', { count: recommendedGpuLayers });
  const maxTokensFloor = Math.min(128, displayedContextSize);
  const maxTokensCeiling = Math.max(
    maxTokensFloor,
    Math.min(displayedContextSize, resolvedContextWindowCeiling),
  );
  const backendLabel = engineDiagnostics?.backendMode === 'cpu'
    ? t('chat.modelControls.backendModeCpu')
    : engineDiagnostics?.backendMode === 'gpu'
      ? t('chat.modelControls.backendModeGpu')
      : engineDiagnostics?.backendMode === 'npu'
        ? t('chat.modelControls.backendModeNpu')
        : t('chat.modelControls.backendModeUnknown');
  const autotuneBestStable = autotuneResult?.bestStable ?? null;
  const autotuneCandidates = Array.isArray(autotuneResult?.candidates)
    ? autotuneResult!.candidates
    : [];
  const formatAutotuneCandidateSpeed = (tokensPerSec: number | undefined) => {
    if (typeof tokensPerSec !== 'number' || !Number.isFinite(tokensPerSec) || tokensPerSec <= 0) {
      return '—';
    }

    const rounded = tokensPerSec >= 10 ? tokensPerSec.toFixed(0) : tokensPerSec.toFixed(1);
    return `${rounded} tok/s`;
  };
  const formatAutotuneCandidateMs = (value: number | undefined) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return '—';
    }

    return `${Math.round(value)} ms`;
  };
  const formatAutotuneCandidateBackendLabel = (mode: string | undefined) => {
    if (mode === 'cpu') {
      return t('chat.modelControls.backendModeCpu');
    }

    if (mode === 'gpu') {
      return t('chat.modelControls.backendModeGpu');
    }

    if (mode === 'npu') {
      return t('chat.modelControls.backendModeNpu');
    }

    return t('chat.modelControls.backendModeUnknown');
  };
  const autotuneBestStableBackendLabel = autotuneBestStable?.backendMode === 'cpu'
    ? t('chat.modelControls.backendModeCpu')
    : autotuneBestStable?.backendMode === 'gpu'
      ? t('chat.modelControls.backendModeGpu')
      : autotuneBestStable?.backendMode === 'npu'
        ? t('chat.modelControls.backendModeNpu')
        : t('chat.modelControls.backendModeUnknown');
  const autotuneProgressPercent = (() => {
    if (!autotuneProgress || autotuneProgress.totalSteps <= 0) {
      return null;
    }

    const ratio = autotuneProgress.totalSteps > 0 ? autotuneProgress.step / autotuneProgress.totalSteps : 0;
    const normalized = Number.isFinite(ratio) ? ratio : 0;
    return Math.max(0, Math.min(100, Math.round(normalized * 100)));
  })();
  const autotuneProgressBackendLabel = autotuneProgress?.candidate?.backendMode === 'cpu'
    ? t('chat.modelControls.backendModeCpu')
    : autotuneProgress?.candidate?.backendMode === 'gpu'
      ? t('chat.modelControls.backendModeGpu')
      : autotuneProgress?.candidate?.backendMode === 'npu'
        ? t('chat.modelControls.backendModeNpu')
        : t('chat.modelControls.backendModeUnknown');
  const autotuneProgressStageLabel = (() => {
    if (!autotuneProgress) {
      return null;
    }

    const index = typeof autotuneProgress.candidateIndex === 'number' && Number.isFinite(autotuneProgress.candidateIndex)
      ? autotuneProgress.candidateIndex
      : 0;
    const total = typeof autotuneProgress.candidateCount === 'number' && Number.isFinite(autotuneProgress.candidateCount)
      ? autotuneProgress.candidateCount
      : 0;

    switch (autotuneProgress.stage) {
      case 'preparing':
        return t('chat.modelControls.backendBenchmarkProgressPreparing');
      case 'cancelling':
        return t('chat.modelControls.backendBenchmarkProgressCancelling');
      case 'unloadingPrevious':
        return t('chat.modelControls.backendBenchmarkProgressUnloadingPrevious');
      case 'loadingCandidate':
        return t('chat.modelControls.backendBenchmarkProgressLoading', {
          backend: autotuneProgressBackendLabel,
          index,
          total,
        });
      case 'benchmarkingCandidate':
        return t('chat.modelControls.backendBenchmarkProgressBenchmarking', {
          backend: autotuneProgressBackendLabel,
          index,
          total,
        });
      case 'unloadingCandidate':
        return t('chat.modelControls.backendBenchmarkProgressUnloadingCandidate', {
          backend: autotuneProgressBackendLabel,
          index,
          total,
        });
      case 'saving':
        return t('chat.modelControls.backendBenchmarkProgressSaving');
      case 'restoringPrevious':
        return t('chat.modelControls.backendBenchmarkProgressRestoring');
      case 'cancelled':
        return t('chat.modelControls.backendBenchmarkProgressCancelled');
      case 'done':
        return t('chat.modelControls.backendBenchmarkProgressDone');
      default:
        return t('chat.modelControls.backendBenchmarkRunning');
    }
  })();
  const requestedBackendPolicyLabel = engineDiagnostics?.requestedBackendPolicy === 'cpu'
    ? t('chat.modelControls.backendPolicyCpu')
    : engineDiagnostics?.requestedBackendPolicy === 'gpu'
      ? t('chat.modelControls.backendPolicyGpu')
      : engineDiagnostics?.requestedBackendPolicy === 'npu'
        ? t('chat.modelControls.backendPolicyNpu')
        : t('chat.modelControls.backendPolicyAuto');
  const effectiveBackendPolicyLabel = engineDiagnostics?.effectiveBackendPolicy === 'cpu'
    ? t('chat.modelControls.backendPolicyCpu')
    : engineDiagnostics?.effectiveBackendPolicy === 'gpu'
      ? t('chat.modelControls.backendPolicyGpu')
      : engineDiagnostics?.effectiveBackendPolicy === 'npu'
        ? t('chat.modelControls.backendPolicyNpu')
          : t('chat.modelControls.backendPolicyAuto');
  const backendPolicyReasons = Array.isArray(engineDiagnostics?.backendPolicyReasons)
    ? engineDiagnostics.backendPolicyReasons.filter((reason) => typeof reason === 'string' && reason.trim().length > 0)
    : [];
  const initGpuLayers = typeof engineDiagnostics?.initGpuLayers === 'number' && Number.isFinite(engineDiagnostics.initGpuLayers)
    ? Math.max(0, Math.round(engineDiagnostics.initGpuLayers))
    : null;
  const initDevicesText = Array.isArray(engineDiagnostics?.initDevices) && engineDiagnostics.initDevices.length > 0
    ? engineDiagnostics.initDevices.join(', ')
    : null;
  const initCacheTypeK = typeof engineDiagnostics?.initCacheTypeK === 'string' ? engineDiagnostics.initCacheTypeK.trim() : '';
  const initCacheTypeV = typeof engineDiagnostics?.initCacheTypeV === 'string' ? engineDiagnostics.initCacheTypeV.trim() : '';
  const initFlashAttnType = typeof engineDiagnostics?.initFlashAttnType === 'string'
    ? engineDiagnostics.initFlashAttnType.trim()
    : '';
  const initUseMmap = typeof engineDiagnostics?.initUseMmap === 'boolean' ? engineDiagnostics.initUseMmap : null;
  const initUseMlock = typeof engineDiagnostics?.initUseMlock === 'boolean' ? engineDiagnostics.initUseMlock : null;
  const initNParallel = typeof engineDiagnostics?.initNParallel === 'number' && Number.isFinite(engineDiagnostics.initNParallel)
    ? Math.max(1, Math.round(engineDiagnostics.initNParallel))
    : null;
  const initNThreads = typeof engineDiagnostics?.initNThreads === 'number' && Number.isFinite(engineDiagnostics.initNThreads)
    ? Math.max(1, Math.round(engineDiagnostics.initNThreads))
    : null;
  const initCpuMask = typeof engineDiagnostics?.initCpuMask === 'string' ? engineDiagnostics.initCpuMask.trim() : '';
  const initCpuStrict = typeof engineDiagnostics?.initCpuStrict === 'boolean' ? engineDiagnostics.initCpuStrict : null;
  const initNBatch = typeof engineDiagnostics?.initNBatch === 'number' && Number.isFinite(engineDiagnostics.initNBatch)
    ? Math.max(1, Math.round(engineDiagnostics.initNBatch))
    : null;
  const initNUbatch = typeof engineDiagnostics?.initNUbatch === 'number' && Number.isFinite(engineDiagnostics.initNUbatch)
    ? Math.max(1, Math.round(engineDiagnostics.initNUbatch))
    : null;
  const initKvUnified = typeof engineDiagnostics?.initKvUnified === 'boolean' ? engineDiagnostics.initKvUnified : null;
  const backendInitAttempts = Array.isArray(engineDiagnostics?.backendInitAttempts)
    ? engineDiagnostics.backendInitAttempts
    : [];
  const runtimeRequestedGpuLayers = typeof engineDiagnostics?.requestedGpuLayers === 'number'
    && Number.isFinite(engineDiagnostics.requestedGpuLayers)
    ? Math.max(0, Math.round(engineDiagnostics.requestedGpuLayers))
    : null;
  const runtimeLoadedGpuLayers = reportedLoadedGpuLayers;
  const shouldHighlightNoGpu = Boolean(
    runtimeRequestedGpuLayers !== null
      && runtimeRequestedGpuLayers > 0
      && (engineDiagnostics?.actualGpuAccelerated === false || engineDiagnostics?.backendMode === 'cpu'),
  );
  const applyProgressLabel = isApplyingReload
    ? applyAction === 'save'
      ? t('chat.modelControls.saving')
      : t('chat.modelControls.reloading')
    : applyButtonLabel;

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <ScreenModalOverlay>
        <Pressable className="flex-1" onPress={onClose} />
        <ScreenSheet className={screenLayoutTokens.sheetMaxHeightDefaultClassName}>
          <Box className="mb-4 flex-row items-start justify-between gap-4">
            <Box className="min-w-0 flex-1">
              <Text className="text-lg font-semibold text-typography-900 dark:text-typography-100">
                {t('chat.modelControls.title')}
              </Text>
              <Text className="mt-1 text-sm leading-5 text-typography-500 dark:text-typography-400">
                {modelId
                  ? t('chat.modelControls.descriptionForModel', { modelLabel, loadAction: applyButtonLabel })
                  : t('chat.modelControls.descriptionNoModel')}
              </Text>
            </Box>

            <ScreenIconButton
              onPress={onClose}
              accessibilityLabel={t('common.cancel')}
              iconName="close"
            />
          </Box>

          <ScreenCard className="mb-3 flex-row items-center justify-between" tone="accent" variant="inset" padding="compact">
            <Box className="min-w-0 flex-1 pr-3">
              <Text className={accentEyebrowClassName}>
                {t('chat.modelControls.activeProfile')}
              </Text>
              <Text numberOfLines={1} className="mt-1 text-sm font-semibold text-typography-900 dark:text-typography-100">
                {modelLabel}
              </Text>
            </Box>

            <Button
              onPress={onReset}
              action="softPrimary"
              size="sm"
              disabled={!modelId}
            >
              <ButtonText>{t('common.resetAll')}</ButtonText>
            </Button>
          </ScreenCard>

          <ScrollView showsVerticalScrollIndicator={false}>
            <ScreenStack gap="default" className="pb-2">
              <ScreenCard tone="accent">
                <ScreenStack gap="default">
                  <Box>
                    <Text className={accentEyebrowClassName}>
                      {t('chat.modelControls.liveSampling')}
                    </Text>
                    <Text className="mt-2 text-sm leading-5 text-typography-600 dark:text-typography-300">
                      {t('chat.modelControls.liveSamplingDescription')}
                    </Text>
                  </Box>

                  <SegmentedControlRow
                    label={t('chat.modelControls.reasoning')}
                    description={t('chat.modelControls.reasoningDescription')}
                    options={[
                      ...(requiresReasoning ? [] : [
                        {
                          key: 'off',
                          label: t('chat.modelControls.reasoningEffortOff'),
                          testID: 'reasoning-effort-off',
                        },
                      ]),
                      {
                        key: 'auto',
                        label: t('chat.modelControls.reasoningEffortAuto'),
                        testID: 'reasoning-effort-auto',
                      },
                      {
                        key: 'low',
                        label: t('chat.modelControls.reasoningEffortLow'),
                        testID: 'reasoning-effort-low',
                      },
                      {
                        key: 'medium',
                        label: t('chat.modelControls.reasoningEffortMedium'),
                        testID: 'reasoning-effort-medium',
                      },
                      {
                        key: 'high',
                        label: t('chat.modelControls.reasoningEffortHigh'),
                        testID: 'reasoning-effort-high',
                      },
                    ]}
                    activeKey={params.reasoningEffort ?? 'auto'}
                    onChange={(value) => onChangeParams({ reasoningEffort: value as GenerationParameters['reasoningEffort'] })}
                    onReset={() => onResetParamField('reasoningEffort')}
                    isResetDisabled={(params.reasoningEffort ?? 'auto') === (defaultParams.reasoningEffort ?? 'auto')}
                    variant="embedded"
                    disabled={isReasoningEffortDisabled}
                    helperText={reasoningHelperText}
                  />

                  <ParameterControlCard
                    label={t('chat.modelControls.seed')}
                    description={t('chat.modelControls.seedDescription')}
                    badge={params.seed === null
                      ? t('chat.modelControls.seedRandom')
                      : String(params.seed)}
                    resetAction={(
                      <ResetAction
                        onPress={() => onResetParamField('seed')}
                        disabled={params.seed === defaultParams.seed}
                      />
                    )}
                    variant="embedded"
                  >
                    <ScreenStack gap="default">
                      <ScreenSegmentedControl
                        options={[
                          { key: 'random', label: t('chat.modelControls.seedRandom') },
                          { key: 'fixed', label: t('chat.modelControls.seedFixed') },
                        ]}
                        activeKey={params.seed === null ? 'random' : 'fixed'}
                        onChange={(key) => {
                          if (key === 'random') {
                            onChangeParams({ seed: null });
                            return;
                          }

                          const nextSeed = params.seed ?? 42;
                          setSeedInput(String(nextSeed));
                          onChangeParams({ seed: nextSeed });
                        }}
                      />

                      {params.seed !== null ? (
                        <ScreenInlineInput
                          variant="search"
                          placeholder={t('chat.modelControls.seedValue')}
                          keyboardType="number-pad"
                          value={seedInput}
                          onChangeText={(text) => {
                            setSeedInput(text);

                            const normalized = text.trim();
                            if (normalized.length === 0) {
                              return;
                            }

                            const parsed = Number(normalized);
                            if (!Number.isFinite(parsed)) {
                              return;
                            }

                            const nextSeed = Math.min(2_147_483_647, Math.max(0, Math.round(parsed)));
                            if (nextSeed !== params.seed) {
                              onChangeParams({ seed: nextSeed });
                            }
                          }}
                          onEndEditing={(event) => {
                            const normalized = String(event.nativeEvent?.text ?? seedInput).trim();
                            if (normalized.length === 0) {
                              setSeedInput(String(params.seed ?? 42));
                              return;
                            }

                            const parsed = Number(normalized);
                            if (!Number.isFinite(parsed)) {
                              setSeedInput(String(params.seed ?? 42));
                              return;
                            }

                            const nextSeed = Math.min(2_147_483_647, Math.max(0, Math.round(parsed)));
                            setSeedInput(String(nextSeed));
                            if (nextSeed !== params.seed) {
                              onChangeParams({ seed: nextSeed });
                            }
                          }}
                        />
                      ) : null}
                    </ScreenStack>
                  </ParameterControlCard>

                  <SliderRow
                    label={t('chat.modelControls.temperature')}
                    description={t('chat.modelControls.temperatureDescription')}
                    valueLabel={formatDecimal(params.temperature)}
                    minLabel={t('chat.modelControls.temperatureMin')}
                    maxLabel={t('chat.modelControls.temperatureMax')}
                    minimumValue={0}
                    maximumValue={2}
                    step={0.05}
                    value={params.temperature}
                    onValueChange={(value) => onChangeParams({ temperature: Number(value.toFixed(2)) })}
                    onReset={() => onResetParamField('temperature')}
                    isResetDisabled={params.temperature === defaultParams.temperature}
                    variant="embedded"
                  />

                  <SliderRow
                    label={t('chat.modelControls.topP')}
                    description={t('chat.modelControls.topPDescription')}
                    valueLabel={formatDecimal(params.topP)}
                    minLabel={t('chat.modelControls.topPMin')}
                    maxLabel={t('chat.modelControls.topPMax')}
                    minimumValue={0}
                    maximumValue={1}
                    step={0.05}
                    value={params.topP}
                    onValueChange={(value) => onChangeParams({ topP: Number(value.toFixed(2)) })}
                    onReset={() => onResetParamField('topP')}
                    isResetDisabled={params.topP === defaultParams.topP}
                    variant="embedded"
                  />

                  <SliderRow
                    label={t('chat.modelControls.topK')}
                    description={t('chat.modelControls.topKDescription')}
                    valueLabel={`${Math.round(params.topK)}`}
                    minLabel={t('chat.modelControls.topKMin')}
                    maxLabel={t('chat.modelControls.topKMax')}
                    minimumValue={0}
                    maximumValue={200}
                    step={1}
                    value={params.topK}
                    onValueChange={(value) => onChangeParams({ topK: Math.round(value) })}
                    onReset={() => onResetParamField('topK')}
                    isResetDisabled={params.topK === defaultParams.topK}
                    variant="embedded"
                  />

                  <SliderRow
                    label={t('chat.modelControls.minP')}
                    description={t('chat.modelControls.minPDescription')}
                    valueLabel={formatDecimal(params.minP)}
                    minLabel={t('chat.modelControls.minPMin')}
                    maxLabel={t('chat.modelControls.minPMax')}
                    minimumValue={0}
                    maximumValue={1}
                    step={0.01}
                    value={params.minP}
                    onValueChange={(value) => onChangeParams({ minP: Number(value.toFixed(2)) })}
                    onReset={() => onResetParamField('minP')}
                    isResetDisabled={params.minP === defaultParams.minP}
                    variant="embedded"
                  />

                  <SliderRow
                    label={t('chat.modelControls.repetitionPenalty')}
                    description={t('chat.modelControls.repetitionPenaltyDescription')}
                    valueLabel={formatDecimal(params.repetitionPenalty)}
                    minLabel={t('chat.modelControls.repetitionPenaltyMin')}
                    maxLabel={t('chat.modelControls.repetitionPenaltyMax')}
                    minimumValue={0}
                    maximumValue={2}
                    step={0.05}
                    value={params.repetitionPenalty}
                    onValueChange={(value) => onChangeParams({ repetitionPenalty: Number(value.toFixed(2)) })}
                    onReset={() => onResetParamField('repetitionPenalty')}
                    isResetDisabled={params.repetitionPenalty === defaultParams.repetitionPenalty}
                    variant="embedded"
                  />

                  <SliderRow
                    label={t('chat.modelControls.maxTokens')}
                    description={t('chat.modelControls.maxTokensDescription')}
                    valueLabel={`${Math.round(params.maxTokens)} tok`}
                    minLabel={`${maxTokensFloor}`}
                    maxLabel={`${maxTokensCeiling}`}
                    minimumValue={maxTokensFloor}
                    maximumValue={maxTokensCeiling}
                    step={128}
                    value={Math.min(Math.max(params.maxTokens, maxTokensFloor), maxTokensCeiling)}
                    onValueChange={(value) => onChangeParams({ maxTokens: Math.round(value) })}
                    onReset={() => onResetParamField('maxTokens')}
                    isResetDisabled={params.maxTokens === defaultParams.maxTokens}
                    variant="embedded"
                  />
                </ScreenStack>
              </ScreenCard>

              <ScreenCard tone="accent">
                <ScreenStack gap="default">
                  <Box>
                    <Text className={accentEyebrowClassName}>
                      {t('chat.modelControls.runtimeReload')}
                    </Text>
                    <Text className="mt-2 text-sm leading-5 text-typography-600 dark:text-typography-300">
                      {t('chat.modelControls.runtimeReloadDescription')}
                    </Text>
                  </Box>

                  {typeof loadedContextSize === 'number' && Number.isFinite(loadedContextSize) ? (
                    <ScreenCard tone="default" variant="inset" padding="compact">
                      <Text className={accentEyebrowClassName}>
                        {t('chat.modelControls.runtimeLoadedTitle')}
                      </Text>
                      <Text className="mt-1 text-sm leading-5 text-typography-700 dark:text-typography-200">
                        {t('chat.modelControls.runtimeLoadedValue', {
                          contextSize: Math.round(loadedContextSize),
                          gpuLayers: Math.round(reportedLoadedGpuLayers ?? 0),
                        })}
                      </Text>
                    </ScreenCard>
                  ) : null}

                  {showAdvancedInferenceControls ? (
                    <ScreenCard tone="default" variant="inset" padding="compact">
                      <Text className={accentEyebrowClassName}>
                        {t('chat.modelControls.backendBenchmarkTitle')}
                      </Text>
                      <Text className="mt-1 text-sm leading-5 text-typography-600 dark:text-typography-300">
                        {t('chat.modelControls.backendBenchmarkDescription')}
                      </Text>

                      {autotuneBestStable ? (
                        <Text className="mt-2 text-sm leading-5 text-typography-700 dark:text-typography-200">
                          {t('chat.modelControls.backendBenchmarkBestStable', {
                            backend: autotuneBestStableBackendLabel,
                            layers: Math.max(0, Math.round(autotuneBestStable.nGpuLayers)),
                          })}
                        </Text>
                      ) : (
                        <Text className="mt-2 text-sm leading-5 text-typography-700 dark:text-typography-200">
                          {t('chat.modelControls.backendBenchmarkNoResult')}
                        </Text>
                      )}

                      {showApplyReload ? (
                        <Text className="mt-2 text-xs leading-5 text-typography-500 dark:text-typography-400">
                          {t('chat.modelControls.backendBenchmarkPendingChangesHint')}
                        </Text>
                      ) : null}

                      {!isAutotuneRunning && autotuneResult?.cancelled ? (
                        <Text className="mt-2 text-xs leading-5 text-typography-500 dark:text-typography-400">
                          {t('chat.modelControls.backendBenchmarkCancelledNote')}
                        </Text>
                      ) : null}

                      {!isAutotuneRunning && autotuneCandidates.length > 0 ? (
                        <Box className="mt-3 gap-2">
                          <Text className="text-xs font-semibold uppercase tracking-wider text-typography-500 dark:text-typography-400">
                            {t('chat.modelControls.backendBenchmarkResultsTitle')}
                          </Text>

                          {autotuneCandidates.map((candidate, index) => {
                            const candidateKey = `${candidate.profile?.backendMode ?? candidate.actualBackendMode ?? 'unknown'}-${index}`;
                            const requestedBackend = formatAutotuneCandidateBackendLabel(candidate.profile?.backendMode);
                            const requestedLayers = Math.max(0, Math.round(candidate.profile?.nGpuLayers ?? 0));
                            const actualBackend = formatAutotuneCandidateBackendLabel(candidate.actualBackendMode);
                            const loadedLayers = typeof candidate.loadedGpuLayers === 'number' && Number.isFinite(candidate.loadedGpuLayers)
                              ? Math.max(0, Math.round(candidate.loadedGpuLayers))
                              : null;
                            const initLayers = typeof candidate.initGpuLayers === 'number' && Number.isFinite(candidate.initGpuLayers)
                              ? Math.max(0, Math.round(candidate.initGpuLayers))
                              : null;
                            const devicesText = Array.isArray(candidate.initDevices) && candidate.initDevices.length > 0
                              ? candidate.initDevices.join(', ')
                              : Array.isArray(candidate.profile?.devices) && candidate.profile.devices.length > 0
                                ? candidate.profile.devices.join(', ')
                                : null;

                            const primaryLine = candidate.success
                              ? `✓ ${requestedBackend} (${requestedLayers}): ${formatAutotuneCandidateSpeed(candidate.tokensPerSec)} • TTFT ${formatAutotuneCandidateMs(candidate.ttftMs)} • ${formatAutotuneCandidateMs(candidate.durationMs)}`
                              : `✗ ${requestedBackend} (${requestedLayers}): ${candidate.error ?? 'Failed'}`;

                            const details = [
                              candidate.actualBackendMode ? `actual: ${actualBackend}` : null,
                              loadedLayers !== null ? `loaded: ${loadedLayers}` : null,
                              initLayers !== null ? `init: ${initLayers}` : null,
                              devicesText ? `devices: ${devicesText}` : null,
                            ].filter((value): value is string => typeof value === 'string' && value.length > 0);

                            return (
                              <Box key={candidateKey} className="gap-0.5">
                                <Text className="text-sm leading-5 text-typography-700 dark:text-typography-200">
                                  {primaryLine}
                                </Text>

                                {details.length > 0 ? (
                                  <Text className="text-xs leading-5 text-typography-500 dark:text-typography-400">
                                    {details.join(' • ')}
                                  </Text>
                                ) : null}

                                {candidate.reasonNoGPU ? (
                                  <Text className="text-xs leading-5 text-typography-500 dark:text-typography-400">
                                    {candidate.reasonNoGPU}
                                  </Text>
                                ) : null}
                              </Box>
                            );
                          })}
                        </Box>
                      ) : null}

                      {isAutotuneRunning ? (
                        <Box className="mt-3 gap-2">
                          {autotuneProgressStageLabel ? (
                            <Text className="text-sm leading-5 text-typography-700 dark:text-typography-200">
                              {autotuneProgressPercent !== null
                                ? `${autotuneProgressStageLabel} ${autotuneProgressPercent}%`
                                : autotuneProgressStageLabel}
                            </Text>
                          ) : (
                            <Text className="text-sm leading-5 text-typography-700 dark:text-typography-200">
                              {t('chat.modelControls.backendBenchmarkRunning')}
                            </Text>
                          )}

                          {autotuneProgressPercent !== null ? (
                            <ProgressBar valuePercent={autotuneProgressPercent} tone="primary" />
                          ) : null}
                        </Box>
                      ) : null}

                      <Box className="mt-3 flex-row justify-end gap-2">
                        {isAutotuneRunning ? (
                          <Button
                            onPress={() => onCancelAutotune?.()}
                            action="secondary"
                            size="sm"
                            disabled={!onCancelAutotune}
                          >
                            <ButtonText>{t('chat.modelControls.backendBenchmarkCancel')}</ButtonText>
                          </Button>
                        ) : (
                          <Button
                            onPress={() => onRunAutotune?.()}
                            action="softPrimary"
                            size="sm"
                            disabled={!canRunAutotune || isAutotuneRunning || !onRunAutotune}
                          >
                            <ButtonText>{t('chat.modelControls.backendBenchmarkRun')}</ButtonText>
                          </Button>
                        )}
                      </Box>
                    </ScreenCard>
                  ) : null}

                  {showAdvancedInferenceControls && engineDiagnostics ? (
                    <ScreenCard tone={shouldHighlightNoGpu ? 'warning' : 'default'} variant="inset" padding="compact">
                      <Text
                        className={`text-xs font-semibold uppercase tracking-wider ${shouldHighlightNoGpu ? 'text-warning-700 dark:text-warning-200' : 'text-primary-600 dark:text-primary-300'}`}
                      >
                        {t('chat.modelControls.runtimeBackendTitle')}
                      </Text>
                      <Box className="mt-1 gap-1">
                      <Text className="text-sm leading-5 text-typography-700 dark:text-typography-200">
                        {t('chat.modelControls.runtimeBackendBackend', { backend: backendLabel })}
                      </Text>

                      {resolvedLoadedContextSize === null ? (
                        <Text className="text-sm leading-5 text-typography-700 dark:text-typography-200">
                          {t('chat.modelControls.runtimeBackendNotLoaded')}
                        </Text>
                      ) : null}

                      {engineDiagnostics.requestedBackendPolicy ? (
                        <Text className="text-sm leading-5 text-typography-700 dark:text-typography-200">
                          {t('chat.modelControls.runtimeBackendRequestedPolicy', { policy: requestedBackendPolicyLabel })}
                        </Text>
                      ) : null}

                      {engineDiagnostics.effectiveBackendPolicy &&
                      engineDiagnostics.effectiveBackendPolicy !== engineDiagnostics.requestedBackendPolicy ? (
                        <Text className="text-sm leading-5 text-typography-700 dark:text-typography-200">
                          {t('chat.modelControls.runtimeBackendEffectivePolicy', { policy: effectiveBackendPolicyLabel })}
                        </Text>
                      ) : null}

                      {runtimeRequestedGpuLayers !== null ? (
                        <Text className="text-sm leading-5 text-typography-700 dark:text-typography-200">
                          {t('chat.modelControls.runtimeBackendRequestedLayers', { count: runtimeRequestedGpuLayers })}
                        </Text>
                      ) : null}

                      {runtimeLoadedGpuLayers !== null ? (
                        <Text className="text-sm leading-5 text-typography-700 dark:text-typography-200">
                          {t('chat.modelControls.runtimeBackendLoadedLayers', { count: runtimeLoadedGpuLayers })}
                        </Text>
                      ) : null}

                      {initGpuLayers !== null ? (
                        <Text className="text-sm leading-5 text-typography-700 dark:text-typography-200">
                          {t('chat.modelControls.runtimeBackendInitLayers', { count: initGpuLayers })}
                        </Text>
                      ) : null}

                      {initDevicesText ? (
                        <Text className="text-sm leading-5 text-typography-700 dark:text-typography-200">
                          {t('chat.modelControls.runtimeBackendInitDevices', { devices: initDevicesText })}
                        </Text>
                      ) : null}

                      {engineDiagnostics.backendDevices.length > 0 ? (
                        <Text className="text-sm leading-5 text-typography-700 dark:text-typography-200">
                          {t('chat.modelControls.runtimeBackendDevices', { devices: engineDiagnostics.backendDevices.join(', ') })}
                        </Text>
                      ) : null}

                      {initCacheTypeK && initCacheTypeV ? (
                        <Text className="text-sm leading-5 text-typography-700 dark:text-typography-200">
                          {t('chat.modelControls.runtimeBackendKvCacheTypes', { k: initCacheTypeK, v: initCacheTypeV })}
                        </Text>
                      ) : null}

                      {initFlashAttnType ? (
                        <Text className="text-sm leading-5 text-typography-700 dark:text-typography-200">
                          {t('chat.modelControls.runtimeBackendFlashAttn', { value: initFlashAttnType })}
                        </Text>
                      ) : null}

                      {initUseMmap !== null ? (
                        <Text className="text-sm leading-5 text-typography-700 dark:text-typography-200">
                          {t('chat.modelControls.runtimeBackendMmap', { value: initUseMmap ? t('chat.modelControls.runtimeBackendEnabled') : t('chat.modelControls.runtimeBackendDisabled') })}
                        </Text>
                      ) : null}

                      {initUseMlock !== null ? (
                        <Text className="text-sm leading-5 text-typography-700 dark:text-typography-200">
                          {t('chat.modelControls.runtimeBackendMlock', { value: initUseMlock ? t('chat.modelControls.runtimeBackendEnabled') : t('chat.modelControls.runtimeBackendDisabled') })}
                        </Text>
                      ) : null}

                      {initNParallel !== null ? (
                        <Text className="text-sm leading-5 text-typography-700 dark:text-typography-200">
                          {t('chat.modelControls.runtimeBackendParallelSlots', { count: initNParallel })}
                        </Text>
                      ) : null}

                      {initNThreads !== null ? (
                        <Text className="text-sm leading-5 text-typography-700 dark:text-typography-200">
                          {t('chat.modelControls.runtimeBackendThreads', { count: initNThreads })}
                        </Text>
                      ) : null}

                      {initCpuMask ? (
                        <Text className="text-sm leading-5 text-typography-700 dark:text-typography-200">
                          {t('chat.modelControls.runtimeBackendCpuMask', { mask: initCpuMask })}
                        </Text>
                      ) : null}

                      {initCpuStrict !== null ? (
                        <Text className="text-sm leading-5 text-typography-700 dark:text-typography-200">
                          {t('chat.modelControls.runtimeBackendCpuStrict', { value: initCpuStrict ? t('chat.modelControls.runtimeBackendEnabled') : t('chat.modelControls.runtimeBackendDisabled') })}
                        </Text>
                      ) : null}

                      {initNBatch !== null && initNUbatch !== null ? (
                        <Text className="text-sm leading-5 text-typography-700 dark:text-typography-200">
                          {t('chat.modelControls.runtimeBackendBatch', { batch: initNBatch, ubatch: initNUbatch })}
                        </Text>
                      ) : null}

                      {initKvUnified !== null ? (
                        <Text className="text-sm leading-5 text-typography-700 dark:text-typography-200">
                          {t('chat.modelControls.runtimeBackendKvUnified', { value: initKvUnified ? t('chat.modelControls.runtimeBackendEnabled') : t('chat.modelControls.runtimeBackendDisabled') })}
                        </Text>
                      ) : null}

                      {backendPolicyReasons.length > 0 ? backendPolicyReasons.map((reason, index) => {
                        const localizedReason = t(reason, { defaultValue: reason });
                        return (
                          <Text key={`backend-policy-reason-${index}`} className="text-sm leading-5 text-typography-700 dark:text-typography-200">
                            {t('chat.modelControls.runtimeBackendPolicyReason', { reason: localizedReason })}
                          </Text>
                        );
                      }) : null}

                      {engineDiagnostics.androidLib ? (
                        <Text className="text-sm leading-5 text-typography-700 dark:text-typography-200">
                          {t('chat.modelControls.runtimeBackendLibrary', { library: engineDiagnostics.androidLib })}
                        </Text>
                      ) : null}

                      {androidGpuInfo?.glRenderer ? (
                        <Text className="text-sm leading-5 text-typography-700 dark:text-typography-200">
                          {t('chat.modelControls.runtimeBackendGlRenderer', { value: androidGpuInfo.glRenderer })}
                        </Text>
                      ) : null}

                      {androidGpuInfo?.glVendor ? (
                        <Text className="text-sm leading-5 text-typography-700 dark:text-typography-200">
                          {t('chat.modelControls.runtimeBackendGlVendor', { value: androidGpuInfo.glVendor })}
                        </Text>
                      ) : null}

                      {androidGpuInfo?.socModel ? (
                        <Text className="text-sm leading-5 text-typography-700 dark:text-typography-200">
                          {t('chat.modelControls.runtimeBackendSocModel', { value: androidGpuInfo.socModel })}
                        </Text>
                      ) : null}

                      {engineDiagnostics.reasonNoGPU ? (
                        <Text className="text-sm leading-5 text-typography-700 dark:text-typography-200">
                          {t('chat.modelControls.runtimeBackendReason', { reason: engineDiagnostics.reasonNoGPU })}
                        </Text>
                      ) : null}

                      {backendInitAttempts.length > 0 ? (
                        <Box className="mt-2 gap-1">
                          <Text className={accentEyebrowClassName}>
                            {t('chat.modelControls.runtimeBackendAttemptsTitle')}
                          </Text>
                          {backendInitAttempts.map((attempt, index) => {
                            const attemptBackend = attempt.candidate === 'cpu'
                              ? t('chat.modelControls.backendModeCpu')
                              : attempt.candidate === 'gpu'
                                ? t('chat.modelControls.backendModeGpu')
                                : t('chat.modelControls.backendModeNpu');
                            const attemptOutcome = attempt.outcome === 'success'
                              ? t('chat.modelControls.runtimeBackendAttemptOutcomeSuccess')
                              : attempt.outcome === 'error'
                                ? t('chat.modelControls.runtimeBackendAttemptOutcomeError')
                                : t('chat.modelControls.runtimeBackendAttemptOutcomeSkipped');
                            const attemptDetails = [
                              `layers=${attempt.nGpuLayers}`,
                              Array.isArray(attempt.devices) && attempt.devices.length > 0 ? `devices=${attempt.devices.join(', ')}` : null,
                              typeof attempt.actualGpu === 'boolean' ? `gpu=${attempt.actualGpu ? 'yes' : 'no'}` : null,
                              attempt.reasonNoGPU ? `reason=${attempt.reasonNoGPU}` : null,
                              attempt.error ? `error=${attempt.error}` : null,
                            ].filter((part): part is string => typeof part === 'string' && part.length > 0).join(' | ');

                            return (
                              <Text key={`backend-init-attempt-${index}`} className="text-xs leading-5 text-typography-500 dark:text-typography-400">
                                {`${index + 1}) ${attemptBackend} - ${attemptOutcome}${attemptDetails ? ` | ${attemptDetails}` : ''}`}
                              </Text>
                            );
                          })}
                        </Box>
                      ) : null}

                      {engineDiagnostics.systemInfo ? (
                        <Text
                          numberOfLines={3}
                          className="text-sm leading-5 text-typography-700 dark:text-typography-200"
                        >
                          {t('chat.modelControls.runtimeBackendSystemInfo', { info: engineDiagnostics.systemInfo })}
                        </Text>
                      ) : null}
                      </Box>
                    </ScreenCard>
                  ) : null}

                  {typeof loadedContextSize === 'number' &&
                  Number.isFinite(loadedContextSize) &&
                  !showApplyReload &&
                  loadedContextSize < loadParamsDraft.contextSize ? (
                    <ScreenCard tone="warning" variant="inset" padding="compact">
                      <Text className="text-xs font-semibold uppercase tracking-wider text-warning-700 dark:text-warning-200">
                        {t('chat.modelControls.runtimeMismatchTitle')}
                      </Text>
                      <Text className="mt-1 text-sm leading-5 text-typography-700 dark:text-typography-200">
                        {isSafeModeActive
                          ? t('chat.modelControls.runtimeMismatchDescriptionSafe', {
                              requested: Math.round(loadParamsDraft.contextSize),
                              loaded: Math.round(loadedContextSize),
                            })
                          : t('chat.modelControls.runtimeMismatchDescription', {
                              requested: Math.round(loadParamsDraft.contextSize),
                              loaded: Math.round(loadedContextSize),
                            })}
                      </Text>
                    </ScreenCard>
                  ) : null}

                  {runtimeRequestedGpuLayers !== null &&
                  runtimeRequestedGpuLayers > 0 &&
                  runtimeLoadedGpuLayers !== null &&
                  runtimeLoadedGpuLayers < runtimeRequestedGpuLayers &&
                  !showApplyReload ? (
                    <ScreenCard tone="warning" variant="inset" padding="compact">
                      <Text className="text-xs font-semibold uppercase tracking-wider text-warning-700 dark:text-warning-200">
                        {t('chat.modelControls.runtimeGpuMismatchTitle')}
                      </Text>
                      <Text className="mt-1 text-sm leading-5 text-typography-700 dark:text-typography-200">
                        {isSafeModeActive
                          ? t('chat.modelControls.runtimeGpuMismatchDescriptionSafe', {
                              requested: Math.round(runtimeRequestedGpuLayers),
                              loaded: Math.round(runtimeLoadedGpuLayers),
                            })
                          : t('chat.modelControls.runtimeGpuMismatchDescription', {
                              requested: Math.round(runtimeRequestedGpuLayers),
                              loaded: Math.round(runtimeLoadedGpuLayers),
                            })}
                      </Text>
                    </ScreenCard>
                  ) : null}

                  <ScreenStack gap="default">
                    <SliderRow
                      label={t('chat.modelControls.contextWindow')}
                      description={t('chat.modelControls.contextWindowDescription')}
                      valueLabel={`${Math.round(displayedContextSize)} tok`}
                      minLabel="512"
                      maxLabel={`${resolvedContextWindowCeiling}`}
                      minimumValue={MIN_CONTEXT_WINDOW_TOKENS}
                      maximumValue={resolvedContextWindowCeiling}
                      step={512}
                      value={displayedContextSize}
                      onValueChange={(value) => onChangeLoadParams({ contextSize: Math.round(value) })}
                      onReset={() => onResetLoadField('contextSize')}
                      isResetDisabled={displayedContextSize === defaultContextSize}
                      variant="embedded"
                    />

                    {showOffloadLayerControls ? (
                      <SliderRow
                        label={t('chat.modelControls.gpuLayers')}
                        description={gpuLayersRowDescription}
                        valueLabel={t('chat.modelControls.gpuLayersValue', { count: Math.round(displayedGpuLayers) })}
                        minLabel="0"
                        maxLabel={`${resolvedGpuLayersCeiling}`}
                        minimumValue={0}
                        maximumValue={resolvedGpuLayersCeiling}
                        step={1}
                        value={displayedGpuLayers}
                        onValueChange={(value) => onChangeLoadParams({ gpuLayers: Math.round(value) })}
                        onReset={() => onResetLoadField('gpuLayers')}
                        isResetDisabled={displayedGpuLayers === defaultGpuLayers}
                        disabled={isGpuLayersDisabled}
                        variant="embedded"
                      />
                    ) : null}

                    {shouldShowBackendPolicyControls ? (
                      <SegmentedControlRow
                        label={t('chat.modelControls.backendPolicy')}
                        description={t('chat.modelControls.backendPolicyDescription')}
                        options={backendPolicyOptions}
                        activeKey={displayedBackendPolicy}
                        onChange={(key) => onChangeLoadParams({
                          backendPolicy: key === 'auto' ? undefined : (key as ModelLoadParameters['backendPolicy']),
                        })}
                        onReset={() => onResetLoadField('backendPolicy')}
                        isResetDisabled={normalizedBackendPolicy === normalizedDefaultBackendPolicy}
                        variant="embedded"
                      />
                    ) : null}

                    <SegmentedControlRow
                      label={t('chat.modelControls.kvCache')}
                      description={t('chat.modelControls.kvCacheDescription')}
                      options={[
                        { key: 'auto', label: t('chat.modelControls.kvCacheAuto') },
                        { key: 'f16', label: 'f16' },
                        { key: 'q8_0', label: 'q8_0' },
                        { key: 'q4_0', label: 'q4_0' },
                      ]}
                      activeKey={displayedKvCacheType}
                      onChange={(key) => onChangeLoadParams({ kvCacheType: key as ModelLoadParameters['kvCacheType'] })}
                      onReset={() => onResetLoadField('kvCacheType')}
                      isResetDisabled={displayedKvCacheType === defaultKvCacheType}
                      variant="embedded"
                    />
                  </ScreenStack>
                </ScreenStack>
              </ScreenCard>
            </ScreenStack>
          </ScrollView>

          {showApplyReload ? (
            <Box testID="model-apply-footer" className={`mt-4 border-t pt-4 ${appearance.classNames.dividerClassName}`}>
              <ScreenCard className="mb-3" tone="accent" variant="inset" padding="compact">
                <Text className={accentEyebrowClassName}>
                  {t('chat.modelControls.pendingLoadProfileTitle')}
                </Text>
                <Text className="mt-1 text-sm leading-5 text-typography-700 dark:text-typography-200">
                  {t('chat.modelControls.pendingLoadProfileDescription')}
                </Text>
              </ScreenCard>

              <Button
                testID="apply-model-settings-button"
                onPress={onApplyReload}
                action="softPrimary"
                size="sm"
                disabled={!canApplyReload || isApplyingReload || !modelId}
                className="w-full rounded-2xl"
              >
                <ButtonText>{applyProgressLabel}</ButtonText>
              </Button>
            </Box>
          ) : null}

          {!showApplyReload && didSaveLoadProfile ? (
            <Box testID="model-save-confirmation-footer" className={`mt-4 border-t pt-4 ${appearance.classNames.dividerClassName}`}>
              <ScreenCard className="mb-3" tone="accent" variant="inset" padding="compact">
                <Text className="text-xs font-semibold uppercase tracking-wider text-success-600 dark:text-success-400">
                  {t('chat.modelControls.savedLoadProfileTitle')}
                </Text>
                <Text className="mt-1 text-sm leading-5 text-typography-700 dark:text-typography-200">
                  {t('chat.modelControls.savedLoadProfileDescription')}
                </Text>
              </ScreenCard>
            </Box>
          ) : null}
        </ScreenSheet>
      </ScreenModalOverlay>
    </Modal>
  );
}
