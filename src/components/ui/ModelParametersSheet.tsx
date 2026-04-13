import React, { useEffect, useState } from 'react';
import { Modal } from 'react-native';
import Slider from '@react-native-community/slider';
import { useTranslation } from 'react-i18next';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { Pressable } from '@/components/ui/pressable';
import { ScrollView } from '@/components/ui/scroll-view';
import {
  ScreenBadge,
  ScreenCard,
  ScreenIconButton,
  ScreenInlineInput,
  ScreenSegmentedControl,
  ScreenSheet,
} from '@/components/ui/ScreenShell';
import { Text } from '@/components/ui/text';
import type { EngineDiagnostics } from '@/types/models';
import { GenerationParameters, ModelLoadParameters, UNKNOWN_MODEL_GPU_LAYERS_CEILING } from '../../services/SettingsStore';
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
  contextWindowCeiling?: number;
  gpuLayersCeiling?: number;
  isSafeModeActive?: boolean;
  loadParamsDraft: ModelLoadParameters;
  defaultLoadParams: ModelLoadParameters;
  recommendedGpuLayers: number;
  applyButtonLabel: string;
  canApplyReload: boolean;
  isApplyingReload: boolean;
  showApplyReload: boolean;
  loadedContextSize?: number | null;
  loadedGpuLayers?: number | null;
  engineDiagnostics?: EngineDiagnostics | null;
  onClose: () => void;
  onChangeParams: (partial: Partial<GenerationParameters>) => void;
  onChangeLoadParams: (partial: Partial<ModelLoadParameters>) => void;
  onResetParamField: (field: keyof GenerationParameters) => void;
  onResetLoadField: (field: keyof ModelLoadParameters) => void;
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
  showDivider?: boolean;
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
  showDivider = false,
}: SliderRowProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  return (
    <ScreenCard
      variant={variant === 'embedded' ? 'inset' : 'surface'}
      padding="default"
      className={variant === 'embedded'
        ? `${showDivider ? 'mt-4 border-t border-primary-500/12 pt-4 dark:border-primary-500/20' : ''} border-primary-500/10 bg-background-0/60 dark:border-primary-500/10 dark:bg-background-950/30`
        : undefined}
    >
      <Box className="flex-row items-start justify-between gap-3">
        <Box className="min-w-0 flex-1">
          <Text className="text-base font-semibold text-typography-900 dark:text-typography-100">
            {label}
          </Text>
          <Text className="mt-1 text-sm leading-5 text-typography-500 dark:text-typography-400">
            {description}
          </Text>
        </Box>

        <ScreenBadge tone="accent" className="px-3 py-1.5">
          {valueLabel}
        </ScreenBadge>
      </Box>

      {onReset ? (
        <Box className="mt-3 flex-row justify-end">
          <Button
            onPress={onReset}
            action="softPrimary"
            size="xs"
            disabled={isResetDisabled}
          >
            <ButtonText>{t('common.reset')}</ButtonText>
          </Button>
        </Box>
      ) : null}

      <Slider
        style={{ width: '100%', height: 40, marginTop: onReset ? 10 : 16 }}
        minimumValue={minimumValue}
        maximumValue={maximumValue}
        step={step}
        value={value}
        onValueChange={onValueChange}
        minimumTrackTintColor={colors.primary}
        maximumTrackTintColor={colors.borderStrong}
        thumbTintColor={colors.primary}
      />

      <Box className="flex-row items-center justify-between">
        <Text className="text-xs font-medium text-typography-400 dark:text-typography-500">
          {minLabel}
        </Text>
        <Text className="text-xs font-medium text-typography-400 dark:text-typography-500">
          {maxLabel}
        </Text>
      </Box>
    </ScreenCard>
  );
}

interface ToggleRowProps {
  label: string;
  description: string;
  value: boolean;
  enabledLabel: string;
  disabledLabel: string;
  onValueChange: (value: boolean) => void;
  onReset?: () => void;
  isResetDisabled?: boolean;
}

function ToggleRow({
  label,
  description,
  value,
  enabledLabel,
  disabledLabel,
  onValueChange,
  onReset,
  isResetDisabled = false,
}: ToggleRowProps) {
  const { t } = useTranslation();

  return (
    <ScreenCard>
      <Box className="flex-row items-start justify-between gap-3">
        <Box className="min-w-0 flex-1">
          <Text className="text-base font-semibold text-typography-900 dark:text-typography-100">
            {label}
          </Text>
          <Text className="mt-1 text-sm leading-5 text-typography-500 dark:text-typography-400">
            {description}
          </Text>
        </Box>

        <ScreenBadge tone="accent" className="px-3 py-1.5">
          {value ? enabledLabel : disabledLabel}
        </ScreenBadge>
      </Box>

      {onReset ? (
        <Box className="mt-3 flex-row justify-end">
          <Button
            onPress={onReset}
            action="softPrimary"
            size="xs"
            disabled={isResetDisabled}
          >
            <ButtonText>{t('common.reset')}</ButtonText>
          </Button>
        </Box>
      ) : null}

      <Box className="mt-4 flex-row gap-2">
        <Button
          testID="reasoning-option-off"
          onPress={() => onValueChange(false)}
          action={!value ? 'softPrimary' : 'secondary'}
          size="sm"
          className="flex-1 rounded-2xl"
        >
          <ButtonText>{disabledLabel}</ButtonText>
        </Button>

        <Button
          testID="reasoning-option-on"
          onPress={() => onValueChange(true)}
          action={value ? 'softPrimary' : 'secondary'}
          size="sm"
          className="flex-1 rounded-2xl"
        >
          <ButtonText>{enabledLabel}</ButtonText>
        </Button>
      </Box>
    </ScreenCard>
  );
}

interface SegmentedControlRowOption {
  key: string;
  label: string;
  testID?: string;
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
  showDivider?: boolean;
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
  showDivider = false,
}: SegmentedControlRowProps) {
  const { t } = useTranslation();
  const activeLabel = options.find((option) => option.key === activeKey)?.label ?? activeKey;

  return (
    <ScreenCard
      variant={variant === 'embedded' ? 'inset' : 'surface'}
      padding="default"
      className={variant === 'embedded'
        ? `${showDivider ? 'mt-4 border-t border-primary-500/12 pt-4 dark:border-primary-500/20' : ''} border-primary-500/10 bg-background-0/60 dark:border-primary-500/10 dark:bg-background-950/30`
        : undefined}
    >
      <Box className="flex-row items-start justify-between gap-3">
        <Box className="min-w-0 flex-1">
          <Text className="text-base font-semibold text-typography-900 dark:text-typography-100">
            {label}
          </Text>
          <Text className="mt-1 text-sm leading-5 text-typography-500 dark:text-typography-400">
            {description}
          </Text>
        </Box>

        <ScreenBadge tone="accent" className="px-3 py-1.5">
          {activeLabel}
        </ScreenBadge>
      </Box>

      {onReset ? (
        <Box className="mt-3 flex-row justify-end">
          <Button
            onPress={onReset}
            action="softPrimary"
            size="xs"
            disabled={isResetDisabled}
          >
            <ButtonText>{t('common.reset')}</ButtonText>
          </Button>
        </Box>
      ) : null}

      <Box className="mt-4">
        <ScreenSegmentedControl
          options={options.map((option) => ({ key: option.key, label: option.label, testID: option.testID }))}
          activeKey={activeKey}
          onChange={onChange}
        />
      </Box>
    </ScreenCard>
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
  contextWindowCeiling,
  gpuLayersCeiling,
  isSafeModeActive = false,
  loadParamsDraft,
  defaultLoadParams,
  recommendedGpuLayers,
  applyButtonLabel,
  canApplyReload,
  isApplyingReload,
  showApplyReload,
  loadedContextSize,
  loadedGpuLayers,
  engineDiagnostics,
  onClose,
  onChangeParams,
  onChangeLoadParams,
  onResetParamField,
  onResetLoadField,
  onReset,
  onApplyReload,
}: ModelParametersSheetProps) {
  const { t } = useTranslation();
  const [seedInput, setSeedInput] = useState(() => (params.seed === null ? '' : String(params.seed)));

  useEffect(() => {
    if (!visible) {
      return;
    }

    setSeedInput(params.seed === null ? '' : String(params.seed));
  }, [modelId, params.seed, visible]);
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

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <Box className="flex-1 justify-end bg-black/45">
        <Pressable className="flex-1" onPress={onClose} />
        <ScreenSheet className="max-h-[82%] pb-8">
          <Box className="mb-5 flex-row items-start justify-between gap-4">
            <Box className="min-w-0 flex-1">
              <Text className="text-lg font-semibold text-typography-900 dark:text-typography-100">
                {t('chat.modelControls.title')}
              </Text>
              <Text className="mt-1 text-sm leading-5 text-typography-500 dark:text-typography-400">
                {modelId
                  ? t('chat.modelControls.descriptionForModel', { modelLabel })
                  : t('chat.modelControls.descriptionNoModel')}
              </Text>
            </Box>

            <ScreenIconButton
              onPress={onClose}
              accessibilityLabel={t('common.cancel')}
              iconName="close"
            />
          </Box>

          <ScreenCard className="mb-4 flex-row items-center justify-between" tone="accent" variant="inset" padding="compact">
            <Box className="min-w-0 flex-1 pr-3">
              <Text className="text-xs font-semibold uppercase tracking-wider text-primary-500">
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
            <Box className="gap-4 pb-2">
              <ScreenCard>
                <Text className="text-xs font-semibold uppercase tracking-wider text-primary-500">
                  {t('chat.modelControls.liveSampling')}
                </Text>
                <Text className="mt-2 text-sm leading-5 text-typography-600 dark:text-typography-300">
                  {t('chat.modelControls.liveSamplingDescription')}
                </Text>
              </ScreenCard>

              <ToggleRow
                label={t('chat.modelControls.reasoning')}
                description={t('chat.modelControls.reasoningDescription')}
                value={params.reasoningEnabled === true}
                enabledLabel={t('chat.modelControls.reasoningOn')}
                disabledLabel={t('chat.modelControls.reasoningOff')}
                onValueChange={(value) => onChangeParams({ reasoningEnabled: value })}
                onReset={() => onResetParamField('reasoningEnabled')}
                isResetDisabled={(params.reasoningEnabled === true) === (defaultParams.reasoningEnabled === true)}
              />

              <ScreenCard>
                <Box className="flex-row items-start justify-between gap-3">
                  <Box className="min-w-0 flex-1">
                    <Text className="text-base font-semibold text-typography-900 dark:text-typography-100">
                      {t('chat.modelControls.seed')}
                    </Text>
                    <Text className="mt-1 text-sm leading-5 text-typography-500 dark:text-typography-400">
                      {t('chat.modelControls.seedDescription')}
                    </Text>
                  </Box>

                  <ScreenBadge tone="accent" className="px-3 py-1.5">
                    {params.seed === null
                      ? t('chat.modelControls.seedRandom')
                      : String(params.seed)}
                  </ScreenBadge>
                </Box>

                <Box className="mt-3 flex-row justify-end">
                  <Button
                    onPress={() => onResetParamField('seed')}
                    action="softPrimary"
                    size="xs"
                    disabled={params.seed === defaultParams.seed}
                  >
                    <ButtonText>{t('common.reset')}</ButtonText>
                  </Button>
                </Box>

                <Box className="mt-4">
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
                </Box>

                {params.seed !== null ? (
                  <Box className="mt-4">
                    <ScreenInlineInput
                      variant="search"
                      placeholder={t('chat.modelControls.seedValue')}
                      keyboardType="number-pad"
                      value={seedInput}
                      className="mt-3"
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
                  </Box>
                ) : null}
              </ScreenCard>

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
              />

              <ScreenCard tone="accent">
                <Text className="text-xs font-semibold uppercase tracking-wider text-primary-500">
                  {t('chat.modelControls.runtimeReload')}
                </Text>
                <Text className="mt-2 text-sm leading-5 text-typography-600 dark:text-typography-300">
                  {t('chat.modelControls.runtimeReloadDescription')}
                </Text>

                {typeof loadedContextSize === 'number' && Number.isFinite(loadedContextSize) ? (
                  <ScreenCard className="mt-3" tone="default" variant="inset" padding="compact">
                    <Text className="text-xs font-semibold uppercase tracking-wider text-primary-500">
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

                {engineDiagnostics && typeof loadedContextSize === 'number' && Number.isFinite(loadedContextSize) ? (
                  <ScreenCard className="mt-3" tone={shouldHighlightNoGpu ? 'warning' : 'default'} variant="inset" padding="compact">
                    <Text
                      className={`text-xs font-semibold uppercase tracking-wider ${shouldHighlightNoGpu ? 'text-warning-700 dark:text-warning-200' : 'text-primary-500'}`}
                    >
                      {t('chat.modelControls.runtimeBackendTitle')}
                    </Text>
                    <Box className="mt-1 gap-1">
                      <Text className="text-sm leading-5 text-typography-700 dark:text-typography-200">
                        {t('chat.modelControls.runtimeBackendBackend', { backend: backendLabel })}
                      </Text>

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

                      {engineDiagnostics.backendDevices.length > 0 ? (
                        <Text className="text-sm leading-5 text-typography-700 dark:text-typography-200">
                          {t('chat.modelControls.runtimeBackendDevices', { devices: engineDiagnostics.backendDevices.join(', ') })}
                        </Text>
                      ) : null}

                      {engineDiagnostics.androidLib ? (
                        <Text className="text-sm leading-5 text-typography-700 dark:text-typography-200">
                          {t('chat.modelControls.runtimeBackendLibrary', { library: engineDiagnostics.androidLib })}
                        </Text>
                      ) : null}

                      {engineDiagnostics.reasonNoGPU ? (
                        <Text className="text-sm leading-5 text-typography-700 dark:text-typography-200">
                          {t('chat.modelControls.runtimeBackendReason', { reason: engineDiagnostics.reasonNoGPU })}
                        </Text>
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
                    <ScreenCard className="mt-3" tone="warning" variant="inset" padding="compact">
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

                <SliderRow
                  label={t('chat.modelControls.gpuLayers')}
                  description={t('chat.modelControls.gpuLayersDescription', { count: recommendedGpuLayers })}
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
                  variant="embedded"
                  showDivider
                />

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
                  showDivider
                />
              </ScreenCard>
            </Box>
          </ScrollView>

          {showApplyReload ? (
            <Box testID="model-apply-footer" className="mt-4 border-t border-outline-200 pt-4 dark:border-outline-800">
              <ScreenCard className="mb-3" tone="accent" variant="inset" padding="compact">
                <Text className="text-xs font-semibold uppercase tracking-wider text-primary-500">
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
                <ButtonText>{isApplyingReload ? t('chat.modelControls.reloading') : applyButtonLabel}</ButtonText>
              </Button>
            </Box>
          ) : null}
        </ScreenSheet>
      </Box>
    </Modal>
  );
}
