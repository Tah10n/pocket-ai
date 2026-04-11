import type { TFunction } from 'i18next';
import { Alert } from 'react-native';
import type { AppError } from '../services/AppError';
import type { LoadModelOptions } from '../services/LLMEngineService';
import type { ModelMetadata } from '../types/models';
import { isHighConfidenceLikelyOomMemoryFit, shouldWarnForModelMemoryLoad } from './modelMemoryFitState';

type ModelMemoryFitPreflightState = Pick<ModelMetadata, 'memoryFitDecision' | 'memoryFitConfidence' | 'fitsInRam'>;

type HandleModelLoadMemoryPolicyErrorParams = {
  t: TFunction;
  appError: AppError;
  options?: LoadModelOptions;
  onRetry: (nextOptions: LoadModelOptions) => void;
  onBlocked?: () => void;
};

type PromptModelLoadMemoryPolicyParams = {
  t: TFunction;
  model: ModelMemoryFitPreflightState | null | undefined;
  options?: LoadModelOptions;
  onProceed: (nextOptions: LoadModelOptions) => void;
};

function withUnsafeMemoryLoadOption(options?: LoadModelOptions): LoadModelOptions {
  return { ...(options ?? {}), allowUnsafeMemoryLoad: true };
}

export function promptModelLoadMemoryPolicyIfNeeded({
  t,
  model,
  options,
  onProceed,
}: PromptModelLoadMemoryPolicyParams): boolean {
  if (options?.allowUnsafeMemoryLoad === true) {
    return false;
  }

  if (isHighConfidenceLikelyOomMemoryFit(model)) {
    Alert.alert(
      t('models.ramLikelyOom'),
      t('models.loadMemoryBlockedMessage'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('models.loadAnyway'),
          onPress: () => {
            onProceed(withUnsafeMemoryLoadOption(options));
          },
        },
      ],
    );
    return true;
  }

  if (shouldWarnForModelMemoryLoad(model)) {
    Alert.alert(
      t('models.memoryWarningTitle'),
      t('models.loadMemoryWarningMessage'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('models.loadAnyway'),
          onPress: () => {
            onProceed(withUnsafeMemoryLoadOption(options));
          },
        },
      ],
    );
    return true;
  }

  return false;
}

export function handleModelLoadMemoryPolicyError({
  t,
  appError,
  options,
  onRetry,
  onBlocked,
}: HandleModelLoadMemoryPolicyErrorParams): boolean {
  const alreadyUnsafe = options?.allowUnsafeMemoryLoad === true;

  if (appError.code === 'model_load_blocked') {
    onBlocked?.();

    Alert.alert(
      t('models.ramLikelyOom'),
      t('models.loadMemoryBlockedMessage'),
      alreadyUnsafe
        ? [{ text: t('common.close') }]
        : [
            { text: t('common.cancel'), style: 'cancel' },
            {
              text: t('models.loadAnyway'),
              onPress: () => {
                setTimeout(() => {
                  onRetry(withUnsafeMemoryLoadOption(options));
                }, 0);
              },
            },
          ],
    );
    return true;
  }

  if (appError.code === 'model_memory_warning') {
    Alert.alert(
      t('models.memoryWarningTitle'),
      t('models.loadMemoryWarningMessage'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('models.loadAnyway'),
          onPress: () => {
            setTimeout(() => {
              onRetry(withUnsafeMemoryLoadOption(options));
            }, 0);
          },
        },
      ],
    );
    return true;
  }

  return false;
}
