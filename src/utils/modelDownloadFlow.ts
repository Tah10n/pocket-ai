import { Alert } from 'react-native';
import { hardwareListenerService } from '../services/HardwareListenerService';
import { modelCatalogService } from '../services/ModelCatalogService';
import { getSettings } from '../services/SettingsStore';
import { isPrivateStorageWritable } from '../services/storage';
import { ModelAccessState, type ModelMetadata } from '../types/models';

type Translate = (key: string) => string;

type StartModelDownloadFlowParams = {
  model: ModelMetadata;
  t: Translate;
  startDownload: (model: ModelMetadata) => void;
  openTokenSettings: () => void;
  openModelPage: (modelId: string) => Promise<void>;
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

export function startModelDownloadFlow({
  model,
  t,
  startDownload,
  openTokenSettings,
  openModelPage,
  onResolvedModel,
  onError,
}: StartModelDownloadFlowParams): void {
  const startDownloadWhenStorageReady = (downloadModel: ModelMetadata) => {
    if (!ensurePrivateStorageReadyForDownload(t)) {
      return;
    }

    startDownload(downloadModel);
  };

  const startPreparedDownload = async () => {
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

      if (!resolvedModel.resolvedFileName) {
        Alert.alert(t('models.actionFailedTitle'), t('common.errors.downloadMetadataUnavailable'));
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

      const shouldWarnForMemory = resolvedModel.memoryFitDecision === 'borderline'
        || resolvedModel.memoryFitDecision === 'likely_oom'
        || (resolvedModel.memoryFitDecision === undefined && resolvedModel.fitsInRam === false);
      if (shouldWarnForMemory) {
        Alert.alert(
          t('models.memoryWarningTitle'),
          t('models.downloadMemoryWarningMessage'),
          [
            { text: t('common.cancel'), style: 'cancel' },
            { text: t('models.downloadAnyway'), onPress: () => { startDownloadWhenStorageReady(resolvedModel); } },
          ],
        );
        return;
      }

      startDownloadWhenStorageReady(resolvedModel);
    } catch (error) {
      onError(error);
    }
  };

  const status = hardwareListenerService.getCurrentStatus();
  if (status.networkType === 'cellular') {
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
