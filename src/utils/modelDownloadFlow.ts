import { Alert } from 'react-native';
import { hardwareListenerService } from '../services/HardwareListenerService';
import { modelCatalogService } from '../services/ModelCatalogService';
import { getSettings } from '../services/SettingsStore';
import { isPrivateStorageWritable } from '../services/storage';
import { selectModelProjectorLifecycleState, type ModelProjectorLifecycleState } from '../store/modelsStore';
import { LifecycleStatus, ModelAccessState, type ModelMetadata } from '../types/models';

type Translate = (key: string) => string;

type StartModelDownloadFlowParams = {
  model: ModelMetadata;
  t: Translate;
  startDownload: (model: ModelMetadata) => void;
  openTokenSettings: () => void;
  openModelPage: (modelId: string) => Promise<void>;
  onProjectorChoiceRequired?: (model: ModelMetadata) => void;
  onResolvedModel?: (model: ModelMetadata) => void;
  onError: (error: unknown) => void;
};

function shouldRefreshDownloadMetadata(model: ModelMetadata): boolean {
  return (
    model.size === null
    || model.requiresTreeProbe === true
    || model.isGated
    || model.isPrivate
  );
}

function hasReusableDownloadedModelFile(model: ModelMetadata): boolean {
  return (
    model.lifecycleStatus === LifecycleStatus.DOWNLOADED
    || model.lifecycleStatus === LifecycleStatus.ACTIVE
  ) && typeof model.localPath === 'string'
    && model.localPath.trim().length > 0;
}

function canDownloadSelectedProjectorWithReusableModelFile(
  model: ModelMetadata,
  projectorLifecycle: ModelProjectorLifecycleState,
): boolean {
  if (!hasReusableDownloadedModelFile(model) || !projectorLifecycle.selectedProjector) {
    return false;
  }

  return projectorLifecycle.status === 'available'
    || projectorLifecycle.status === 'failed'
    || projectorLifecycle.status === 'paused';
}

function isPrivateStorageReadyForDownload(): boolean {
  return isPrivateStorageWritable();
}

function showPrivateStorageUnavailableAlert(t: Translate): void {
  Alert.alert(t('storageRecovery.title'), t('storageRecovery.privateUnavailableMessage'));
}

function ensurePrivateStorageReadyForDownload(t: Translate): boolean {
  if (isPrivateStorageReadyForDownload()) {
    return true;
  }

  showPrivateStorageUnavailableAlert(t);
  return false;
}

function shouldWarnForModelMemory(model: ModelMetadata): boolean {
  return model.memoryFitDecision === 'borderline'
    || model.memoryFitDecision === 'likely_oom'
    || (model.memoryFitDecision === undefined && model.fitsInRam === false);
}

function showModelMemoryWarning(
  t: Translate,
  onProceed: () => void,
): void {
  Alert.alert(
    t('models.memoryWarningTitle'),
    t('models.downloadMemoryWarningMessage'),
    [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('models.downloadAnyway'), onPress: onProceed },
    ],
  );
}

export function startModelDownloadFlow({
  model,
  t,
  startDownload,
  openTokenSettings,
  openModelPage,
  onProjectorChoiceRequired,
  onResolvedModel,
  onError,
}: StartModelDownloadFlowParams): void {
  const startDownloadWhenStorageReady = (downloadModel: ModelMetadata) => {
    if (!ensurePrivateStorageReadyForDownload(t)) {
      return;
    }

    startDownload(downloadModel);
  };

  const startPreparedDownload = async (options: { memoryWarningAcknowledged?: boolean } = {}) => {
    try {
      if (model.accessState === ModelAccessState.AUTH_REQUIRED) {
        openTokenSettings();
        return;
      }

      if (model.accessState === ModelAccessState.ACCESS_DENIED) {
        await openModelPage(model.id);
        return;
      }

      if (!ensurePrivateStorageReadyForDownload(t)) {
        return;
      }

      // A catalog/details card may already have a trustworthy RAM-risk decision while its file
      // inventory still requires a strict tree refresh. Surface that known warning immediately;
      // only perform the potentially slow verification after the user explicitly proceeds.
      if (
        options.memoryWarningAcknowledged !== true
        && model.size !== null
        && shouldWarnForModelMemory(model)
      ) {
        showModelMemoryWarning(t, () => {
          void startPreparedDownload({ memoryWarningAcknowledged: true });
        });
        return;
      }

      const resolvedModel = shouldRefreshDownloadMetadata(model)
        ? await modelCatalogService.refreshModelMetadata(model, { includeDetails: false })
        : model;

      onResolvedModel?.(resolvedModel);

      if (resolvedModel.accessState === ModelAccessState.AUTH_REQUIRED) {
        openTokenSettings();
        return;
      }

      if (resolvedModel.accessState === ModelAccessState.ACCESS_DENIED) {
        await openModelPage(resolvedModel.id);
        return;
      }

      const projectorLifecycle = selectModelProjectorLifecycleState(resolvedModel);
      const canReuseDownloadedModelFileForProjector = canDownloadSelectedProjectorWithReusableModelFile(
        resolvedModel,
        projectorLifecycle,
      );

      if (!resolvedModel.resolvedFileName && !canReuseDownloadedModelFileForProjector) {
        Alert.alert(t('models.actionFailedTitle'), t('common.errors.downloadMetadataUnavailable'));
        return;
      }

      if (projectorLifecycle.shouldPromptForChoice) {
        if (onProjectorChoiceRequired) {
          onProjectorChoiceRequired(resolvedModel);
        } else {
          Alert.alert(
            t('models.multimodal.projectorChoiceRequiredTitle'),
            t('models.multimodal.projectorChoiceRequiredMessage'),
          );
        }
        return;
      }

      if (resolvedModel.size === null) {
        Alert.alert(
          t('models.unknownSizeWarningTitle'),
          t('models.unknownSizeWarningMessage'),
          [
            { text: t('common.cancel'), style: 'cancel' },
            {
              text: t('models.downloadWithLimitedVerification'),
              onPress: () => {
                startDownloadWhenStorageReady({
                  ...resolvedModel,
                  allowUnknownSizeDownload: true,
                });
              },
            },
          ],
        );
        return;
      }

      if (
        options.memoryWarningAcknowledged !== true
        && shouldWarnForModelMemory(resolvedModel)
      ) {
        showModelMemoryWarning(t, () => {
          startDownloadWhenStorageReady(resolvedModel);
        });
        return;
      }

      startDownloadWhenStorageReady(resolvedModel);
    } catch (error) {
      onError(error);
    }
  };

  const status = hardwareListenerService.getCurrentStatus();
  if (status.networkType === 'cellular') {
    if (!ensurePrivateStorageReadyForDownload(t)) {
      return;
    }

    if (getSettings().allowCellularDownloads === false) {
      Alert.alert(t('models.cellularDownloadsDisabledTitle'), t('models.cellularDownloadsDisabledMessage'));
      return;
    }

    Alert.alert(
      t('models.cellularWarningTitle'),
      t('models.cellularWarningMessage'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('models.downloadAnyway'), onPress: () => { void startPreparedDownload(); } },
      ],
    );
    return;
  }

  void startPreparedDownload();
}
