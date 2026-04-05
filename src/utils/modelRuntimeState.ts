import { LifecycleStatus, type ModelMetadata } from '../types/models';

interface MergeModelWithRuntimeStateOptions {
  activeModelId?: string;
  localModel?: ModelMetadata;
  queuedItem?: ModelMetadata;
}

export function mergeModelWithRuntimeState(
  model: ModelMetadata,
  {
    activeModelId,
    localModel,
    queuedItem,
  }: MergeModelWithRuntimeStateOptions,
): ModelMetadata {
  let mergedModel = { ...model };

  if (localModel) {
    mergedModel = {
      ...mergedModel,
      size: mergedModel.size ?? localModel.size,
      allowUnknownSizeDownload: mergedModel.allowUnknownSizeDownload ?? localModel.allowUnknownSizeDownload,
      requiresTreeProbe: mergedModel.requiresTreeProbe ?? localModel.requiresTreeProbe,
      hfRevision: mergedModel.hfRevision ?? localModel.hfRevision,
      resolvedFileName: mergedModel.resolvedFileName ?? localModel.resolvedFileName,
      localPath: localModel.localPath,
      downloadedAt: localModel.downloadedAt,
      sha256: mergedModel.sha256 ?? localModel.sha256,
      fitsInRam: mergedModel.fitsInRam ?? localModel.fitsInRam,
      memoryFitDecision: mergedModel.memoryFitDecision ?? localModel.memoryFitDecision,
      memoryFitConfidence: mergedModel.memoryFitConfidence ?? localModel.memoryFitConfidence,
      lifecycleStatus: localModel.lifecycleStatus,
      downloadProgress: localModel.downloadProgress,
      resumeData: localModel.resumeData,
      maxContextTokens: mergedModel.maxContextTokens ?? localModel.maxContextTokens,
      hasVerifiedContextWindow: mergedModel.hasVerifiedContextWindow ?? localModel.hasVerifiedContextWindow,
      parameterSizeLabel: mergedModel.parameterSizeLabel ?? localModel.parameterSizeLabel,
      modelType: mergedModel.modelType ?? localModel.modelType,
      architectures: mergedModel.architectures ?? localModel.architectures,
      baseModels: mergedModel.baseModels ?? localModel.baseModels,
      license: mergedModel.license ?? localModel.license,
      languages: mergedModel.languages ?? localModel.languages,
      datasets: mergedModel.datasets ?? localModel.datasets,
      quantizedBy: mergedModel.quantizedBy ?? localModel.quantizedBy,
      modelCreator: mergedModel.modelCreator ?? localModel.modelCreator,
      downloads: mergedModel.downloads ?? localModel.downloads,
      likes: mergedModel.likes ?? localModel.likes,
      tags: mergedModel.tags ?? localModel.tags,
      description: mergedModel.description ?? localModel.description,
    };
  }

  if (activeModelId === mergedModel.id) {
    mergedModel.lifecycleStatus = LifecycleStatus.ACTIVE;
  } else if (mergedModel.lifecycleStatus === LifecycleStatus.ACTIVE) {
    mergedModel.lifecycleStatus = LifecycleStatus.DOWNLOADED;
  }

  if (queuedItem) {
    mergedModel = {
      ...mergedModel,
      size: mergedModel.size ?? queuedItem.size,
      hfRevision: mergedModel.hfRevision ?? queuedItem.hfRevision,
      resolvedFileName: mergedModel.resolvedFileName ?? queuedItem.resolvedFileName,
      localPath: queuedItem.localPath ?? mergedModel.localPath,
      downloadedAt: queuedItem.downloadedAt ?? mergedModel.downloadedAt,
      sha256: mergedModel.sha256 ?? queuedItem.sha256,
      fitsInRam: mergedModel.fitsInRam ?? queuedItem.fitsInRam,
      memoryFitDecision: mergedModel.memoryFitDecision ?? queuedItem.memoryFitDecision,
      memoryFitConfidence: mergedModel.memoryFitConfidence ?? queuedItem.memoryFitConfidence,
      lifecycleStatus: queuedItem.lifecycleStatus,
      downloadProgress: queuedItem.downloadProgress,
      resumeData: queuedItem.resumeData,
    };
  }

  return mergedModel;
}
