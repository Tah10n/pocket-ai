import { Alert } from 'react-native';
import { hardwareListenerService } from '../services/HardwareListenerService';
import { modelCatalogService } from '../services/ModelCatalogService';
import type { MemoryFitResult } from '../memory/types';
import { ModelAccessState, type ModelMetadata } from '../types/models';

type Translate = (key: string) => string;

type StartModelDownloadFlowParams = {
  model: ModelMetadata;
  t: Translate;
  getMemoryFit: (size: number) => Promise<MemoryFitResult>;
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

export function startModelDownloadFlow({
  model,
  t,
  getMemoryFit,
  startDownload,
  openTokenSettings,
  openModelPage,
  onResolvedModel,
  onError,
}: StartModelDownloadFlowParams): void {
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
                startDownload({
                  ...resolvedModel,
                  allowUnknownSizeDownload: true,
                });
              },
            },
          ],
        );
        return;
      }

      const memoryFit = resolvedModel.fitsInRam === false
        ? null
        : await getMemoryFit(resolvedModel.size);
      const shouldWarnOnMemoryFit = resolvedModel.fitsInRam === false
        || memoryFit?.decision === 'borderline'
        || memoryFit?.decision === 'likely_oom';

      if (shouldWarnOnMemoryFit) {
        Alert.alert(
          t('models.memoryWarningTitle'),
          t('models.downloadMemoryWarningMessage'),
          [
            { text: t('common.cancel'), style: 'cancel' },
            { text: t('models.downloadAnyway'), onPress: () => { startDownload(resolvedModel); } },
          ],
        );
        return;
      }

      startDownload(resolvedModel);
    } catch (error) {
      onError(error);
    }
  };

  const status = hardwareListenerService.getCurrentStatus();
  if (status.networkType === 'cellular') {
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
