import React from 'react';
import { Modal } from 'react-native';
import Slider from '@react-native-community/slider';
import { useTranslation } from 'react-i18next';
import { Box } from '@/components/ui/box';
import { Pressable } from '@/components/ui/pressable';
import { ScrollView } from '@/components/ui/scroll-view';
import { Text } from '@/components/ui/text';
import { MaterialSymbols } from './MaterialSymbols';
import { GenerationParameters, ModelLoadParameters } from '../../services/SettingsStore';

interface ModelParametersSheetProps {
  visible: boolean;
  modelId: string | null;
  modelLabel: string;
  params: GenerationParameters;
  defaultParams: GenerationParameters;
  modelMaxContextTokens?: number;
  loadParamsDraft: ModelLoadParameters;
  defaultLoadParams: ModelLoadParameters;
  recommendedGpuLayers: number;
  applyButtonLabel: string;
  canApplyReload: boolean;
  isApplyingReload: boolean;
  showApplyReload: boolean;
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
  return (
    <Box className={variant === 'embedded'
      ? `${showDivider ? 'mt-4 border-t border-primary-500/12 pt-4 dark:border-primary-500/20' : ''}`
      : 'rounded-3xl border border-outline-200 bg-background-50 p-4 dark:border-outline-800 dark:bg-background-900/70'}
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

        <Box className="rounded-full border border-primary-500/15 bg-primary-500/10 px-3 py-1.5">
          <Text className="text-sm font-semibold text-primary-500">
            {valueLabel}
          </Text>
        </Box>
      </Box>

      {onReset ? (
        <Box className="mt-3 flex-row justify-end">
          <Pressable
            onPress={onReset}
            disabled={isResetDisabled}
            className={`rounded-full px-3 py-1.5 ${isResetDisabled
              ? 'bg-background-100 dark:bg-background-900/60'
              : 'border border-primary-500/20 bg-primary-500/10 active:opacity-80'}`}
          >
            <Text className={`text-xs font-semibold ${isResetDisabled
              ? 'text-typography-400 dark:text-typography-500'
              : 'text-primary-500'}`}>
              {t('common.reset')}
            </Text>
          </Pressable>
        </Box>
      ) : null}

      <Slider
        style={{ width: '100%', height: 40, marginTop: onReset ? 10 : 16 }}
        minimumValue={minimumValue}
        maximumValue={maximumValue}
        step={step}
        value={value}
        onValueChange={onValueChange}
        minimumTrackTintColor="#4f46e5"
        maximumTrackTintColor="#cbd5e1"
        thumbTintColor="#4f46e5"
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
    <Box className="rounded-3xl border border-outline-200 bg-background-50 p-4 dark:border-outline-800 dark:bg-background-900/70">
      <Box className="flex-row items-start justify-between gap-3">
        <Box className="min-w-0 flex-1">
          <Text className="text-base font-semibold text-typography-900 dark:text-typography-100">
            {label}
          </Text>
          <Text className="mt-1 text-sm leading-5 text-typography-500 dark:text-typography-400">
            {description}
          </Text>
        </Box>

        <Box className="rounded-full border border-primary-500/15 bg-primary-500/10 px-3 py-1.5">
          <Text className="text-sm font-semibold text-primary-500">
            {value ? enabledLabel : disabledLabel}
          </Text>
        </Box>
      </Box>

      {onReset ? (
        <Box className="mt-3 flex-row justify-end">
          <Pressable
            onPress={onReset}
            disabled={isResetDisabled}
            className={`rounded-full px-3 py-1.5 ${isResetDisabled
              ? 'bg-background-100 dark:bg-background-900/60'
              : 'border border-primary-500/20 bg-primary-500/10 active:opacity-80'}`}
          >
            <Text className={`text-xs font-semibold ${isResetDisabled
              ? 'text-typography-400 dark:text-typography-500'
              : 'text-primary-500'}`}>
              {t('common.reset')}
            </Text>
          </Pressable>
        </Box>
      ) : null}

      <Box className="mt-4 flex-row gap-2">
        <Pressable
          testID="reasoning-option-off"
          onPress={() => onValueChange(false)}
          className={`flex-1 rounded-2xl border px-3 py-3 active:opacity-80 ${!value
            ? 'border-primary-500 bg-primary-500/10'
            : 'border-outline-200 bg-background-0 dark:border-outline-800 dark:bg-background-950/70'}`}
        >
          <Text className={`text-center text-sm font-semibold ${!value
            ? 'text-primary-500'
            : 'text-typography-700 dark:text-typography-200'}`}>
            {disabledLabel}
          </Text>
        </Pressable>

        <Pressable
          testID="reasoning-option-on"
          onPress={() => onValueChange(true)}
          className={`flex-1 rounded-2xl border px-3 py-3 active:opacity-80 ${value
            ? 'border-primary-500 bg-primary-500/10'
            : 'border-outline-200 bg-background-0 dark:border-outline-800 dark:bg-background-950/70'}`}
        >
          <Text className={`text-center text-sm font-semibold ${value
            ? 'text-primary-500'
            : 'text-typography-700 dark:text-typography-200'}`}>
            {enabledLabel}
          </Text>
        </Pressable>
      </Box>
    </Box>
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
  modelMaxContextTokens,
  loadParamsDraft,
  defaultLoadParams,
  recommendedGpuLayers,
  applyButtonLabel,
  canApplyReload,
  isApplyingReload,
  showApplyReload,
  onClose,
  onChangeParams,
  onChangeLoadParams,
  onResetParamField,
  onResetLoadField,
  onReset,
  onApplyReload,
}: ModelParametersSheetProps) {
  const { t } = useTranslation();
  const contextWindowCeiling = modelMaxContextTokens
    ? Math.max(512, Math.min(8192, modelMaxContextTokens))
    : 8192;
  const maxTokensFloor = Math.min(128, loadParamsDraft.contextSize);
  const maxTokensCeiling = Math.max(
    maxTokensFloor,
    Math.min(loadParamsDraft.contextSize, contextWindowCeiling),
  );

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <Box className="flex-1 justify-end bg-black/45">
        <Pressable className="flex-1" onPress={onClose} />
        <Box className="max-h-[82%] rounded-t-[32px] bg-background-0 px-5 pb-8 pt-5 dark:bg-background-950">
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

            <Pressable
              onPress={onClose}
              className="h-10 w-10 items-center justify-center rounded-full bg-background-100 active:opacity-70 dark:bg-background-900/60"
            >
              <MaterialSymbols name="close" size={20} className="text-typography-600 dark:text-typography-300" />
            </Pressable>
          </Box>

          <Box className="mb-4 flex-row items-center justify-between rounded-2xl border border-primary-500/15 bg-primary-500/10 px-4 py-3">
            <Box className="min-w-0 flex-1 pr-3">
              <Text className="text-xs font-semibold uppercase tracking-wider text-primary-500">
                {t('chat.modelControls.activeProfile')}
              </Text>
              <Text numberOfLines={1} className="mt-1 text-sm font-semibold text-typography-900 dark:text-typography-100">
                {modelLabel}
              </Text>
            </Box>

            <Pressable
              onPress={onReset}
              disabled={!modelId}
              className={`rounded-full px-4 py-2 ${modelId
                ? 'border border-primary-500/20 bg-primary-500/10 active:opacity-80'
                : 'bg-background-100 dark:bg-background-900/60'}`}
            >
              <Text className={`text-sm font-semibold ${modelId
                ? 'text-primary-500'
                : 'text-typography-400 dark:text-typography-500'}`}>
                {t('common.resetAll')}
              </Text>
            </Pressable>
          </Box>

          <ScrollView showsVerticalScrollIndicator={false}>
            <Box className="gap-4 pb-2">
              <Box className="rounded-3xl border border-outline-200 bg-background-50 p-4 dark:border-outline-800 dark:bg-background-900/70">
                <Text className="text-xs font-semibold uppercase tracking-wider text-primary-500">
                  {t('chat.modelControls.liveSampling')}
                </Text>
                <Text className="mt-2 text-sm leading-5 text-typography-600 dark:text-typography-300">
                  {t('chat.modelControls.liveSamplingDescription')}
                </Text>
              </Box>

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

              <Box className="rounded-3xl border border-primary-500/15 bg-primary-500/5 p-4">
                <Text className="text-xs font-semibold uppercase tracking-wider text-primary-500">
                  {t('chat.modelControls.runtimeReload')}
                </Text>
                <Text className="mt-2 text-sm leading-5 text-typography-600 dark:text-typography-300">
                  {t('chat.modelControls.runtimeReloadDescription')}
                </Text>

                <SliderRow
                  label={t('chat.modelControls.contextWindow')}
                  description={t('chat.modelControls.contextWindowDescription')}
                  valueLabel={`${Math.round(loadParamsDraft.contextSize)} tok`}
                  minLabel="512"
                  maxLabel={`${contextWindowCeiling}`}
                  minimumValue={512}
                  maximumValue={contextWindowCeiling}
                  step={512}
                  value={Math.min(loadParamsDraft.contextSize, contextWindowCeiling)}
                  onValueChange={(value) => onChangeLoadParams({ contextSize: Math.round(value) })}
                  onReset={() => onResetLoadField('contextSize')}
                  isResetDisabled={loadParamsDraft.contextSize === Math.min(defaultLoadParams.contextSize, contextWindowCeiling)}
                  variant="embedded"
                />

                <SliderRow
                  label={t('chat.modelControls.gpuLayers')}
                  description={t('chat.modelControls.gpuLayersDescription', { count: recommendedGpuLayers })}
                  valueLabel={t('chat.modelControls.gpuLayersValue', { count: Math.round(loadParamsDraft.gpuLayers ?? 0) })}
                  minLabel="0"
                  maxLabel="80"
                  minimumValue={0}
                  maximumValue={80}
                  step={1}
                  value={loadParamsDraft.gpuLayers ?? 0}
                  onValueChange={(value) => onChangeLoadParams({ gpuLayers: Math.round(value) })}
                  onReset={() => onResetLoadField('gpuLayers')}
                  isResetDisabled={(loadParamsDraft.gpuLayers ?? recommendedGpuLayers) === (defaultLoadParams.gpuLayers ?? recommendedGpuLayers)}
                  variant="embedded"
                  showDivider
                />

                {showApplyReload ? (
                  <Pressable
                    onPress={onApplyReload}
                    disabled={!canApplyReload || isApplyingReload || !modelId}
                    className={`mt-4 rounded-2xl px-4 py-3 ${canApplyReload && !isApplyingReload && modelId
                      ? 'border border-primary-500/20 bg-primary-500/10 active:opacity-80'
                      : 'bg-background-100 dark:bg-background-900/60'}`}
                  >
                    <Text className={`text-center text-sm font-semibold ${canApplyReload && !isApplyingReload && modelId
                      ? 'text-primary-500'
                      : 'text-typography-400 dark:text-typography-500'}`}>
                      {isApplyingReload ? t('chat.modelControls.reloading') : applyButtonLabel}
                    </Text>
                  </Pressable>
                ) : null}
              </Box>
            </Box>
          </ScrollView>
        </Box>
      </Box>
    </Modal>
  );
}
