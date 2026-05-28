import { LifecycleStatus, type ModelMetadata } from '../types/models';
import { resolveVerifiedLocalShaCompatibility } from '../services/ModelIntegrityMetadata';
import { applyModelVariantSelectionIfAvailable } from './modelVariants';
import { mergeProjectorCandidatesWithRuntimeStateAndIdMap } from './projectorRuntimeState';

interface MergeModelWithRuntimeStateOptions {
  activeModelId?: string;
  localModel?: ModelMetadata;
  queuedItem?: ModelMetadata;
}

function hasResolvedFileNameConflict(
  localFileName: ModelMetadata['resolvedFileName'],
  remoteFileName: ModelMetadata['resolvedFileName'],
): boolean {
  return typeof localFileName === 'string'
    && localFileName.trim().length > 0
    && typeof remoteFileName === 'string'
    && remoteFileName.trim().length > 0
    && localFileName.trim() !== remoteFileName.trim();
}

function normalizePositiveSize(value: ModelMetadata['size']): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined;
}

function hasSizeConflict(
  localSize: ModelMetadata['size'],
  remoteSize: ModelMetadata['size'],
): boolean {
  const normalizedLocalSize = normalizePositiveSize(localSize);
  const normalizedRemoteSize = normalizePositiveSize(remoteSize);

  return normalizedLocalSize !== undefined
    && normalizedRemoteSize !== undefined
    && normalizedLocalSize !== normalizedRemoteSize;
}

function getProjectorCandidateIds(model: Pick<ModelMetadata, 'projectorCandidates'>): Set<string> {
  return new Set((model.projectorCandidates ?? []).map((projector) => projector.id));
}

function resolveMergedSelectedProjectorId(
  nextSelectedProjectorId: string | undefined,
  runtimeSelectedProjectorId: string | undefined,
  candidateIds: Set<string>,
  runtimeToNextProjectorIds: Map<string, string>,
): string | undefined {
  if (nextSelectedProjectorId && candidateIds.has(nextSelectedProjectorId)) {
    return nextSelectedProjectorId;
  }

  if (!runtimeSelectedProjectorId) {
    return undefined;
  }

  const selectedProjectorId = runtimeToNextProjectorIds.get(runtimeSelectedProjectorId)
    ?? runtimeSelectedProjectorId;
  return candidateIds.has(selectedProjectorId) ? selectedProjectorId : undefined;
}

function remapMultimodalReadiness(
  modelId: string,
  readiness: ModelMetadata['multimodalReadiness'],
  candidateIds: Set<string>,
  runtimeToNextProjectorIds: Map<string, string>,
  selectedProjectorId: string | undefined,
): ModelMetadata['multimodalReadiness'] {
  if (!readiness || readiness.modelId !== modelId) {
    return undefined;
  }

  if (!readiness.projectorId) {
    return readiness;
  }

  const projectorId = runtimeToNextProjectorIds.get(readiness.projectorId)
    ?? readiness.projectorId;

  if (!candidateIds.has(projectorId)) {
    return undefined;
  }

  if (selectedProjectorId && projectorId !== selectedProjectorId) {
    return undefined;
  }

  return projectorId === readiness.projectorId
    ? readiness
    : { ...readiness, projectorId };
}

function resolveMergedMultimodalReadiness(
  modelId: string,
  nextReadiness: ModelMetadata['multimodalReadiness'],
  runtimeReadiness: ModelMetadata['multimodalReadiness'],
  candidateIds: Set<string>,
  runtimeToNextProjectorIds: Map<string, string>,
  selectedProjectorId: string | undefined,
): ModelMetadata['multimodalReadiness'] {
  return remapMultimodalReadiness(
    modelId,
    nextReadiness,
    candidateIds,
    runtimeToNextProjectorIds,
    selectedProjectorId,
  ) ?? remapMultimodalReadiness(
    modelId,
    runtimeReadiness,
    candidateIds,
    runtimeToNextProjectorIds,
    selectedProjectorId,
  );
}

function mergeProjectorRuntimeFields(
  model: ModelMetadata,
  runtimeModel: ModelMetadata,
): Pick<ModelMetadata, 'projectorCandidates' | 'selectedProjectorId' | 'multimodalReadiness'> {
  const { projectorCandidates, runtimeToNextProjectorIds } = mergeProjectorCandidatesWithRuntimeStateAndIdMap(
    model.projectorCandidates,
    runtimeModel.projectorCandidates,
  );
  const candidateIds = getProjectorCandidateIds({ projectorCandidates });
  const selectedProjectorId = resolveMergedSelectedProjectorId(
    model.selectedProjectorId,
    runtimeModel.selectedProjectorId,
    candidateIds,
    runtimeToNextProjectorIds,
  );

  return {
    projectorCandidates,
    selectedProjectorId,
    multimodalReadiness: resolveMergedMultimodalReadiness(
      model.id,
      model.multimodalReadiness,
      runtimeModel.multimodalReadiness,
      candidateIds,
      runtimeToNextProjectorIds,
      selectedProjectorId,
    ),
  };
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

  const isActiveModel = activeModelId === mergedModel.id;

  if (localModel) {
    mergedModel = applyModelVariantSelectionIfAvailable(mergedModel, localModel);
    const localCompatibility = resolveVerifiedLocalShaCompatibility(localModel, {
      sha256: mergedModel.sha256,
      resolvedFileName: mergedModel.resolvedFileName,
      size: mergedModel.size,
    });
    const canUseLocalRuntimeState = !localCompatibility.shouldResetLocalDownloadState;
    const canUseLocalMetadataFallback = canUseLocalRuntimeState;
    const projectorRuntimeFields = canUseLocalRuntimeState
      ? mergeProjectorRuntimeFields(mergedModel, localModel)
      : {
        projectorCandidates: mergedModel.projectorCandidates,
        selectedProjectorId: mergedModel.selectedProjectorId,
        multimodalReadiness: mergedModel.multimodalReadiness,
      };

    mergedModel = {
      ...mergedModel,
      size: mergedModel.size ?? (canUseLocalMetadataFallback ? localModel.size : null),
      allowUnknownSizeDownload: mergedModel.allowUnknownSizeDownload ?? (canUseLocalMetadataFallback ? localModel.allowUnknownSizeDownload : undefined),
      requiresTreeProbe: mergedModel.requiresTreeProbe ?? (canUseLocalMetadataFallback ? localModel.requiresTreeProbe : undefined),
      hfRevision: mergedModel.hfRevision ?? (canUseLocalMetadataFallback ? localModel.hfRevision : undefined),
      resolvedFileName: mergedModel.resolvedFileName ?? (canUseLocalMetadataFallback ? localModel.resolvedFileName : undefined),
      localPath: canUseLocalRuntimeState ? localModel.localPath : undefined,
      downloadedAt: canUseLocalRuntimeState ? localModel.downloadedAt : undefined,
      sha256: mergedModel.sha256 ?? (
        localCompatibility.canUseLocalVerifiedMetadata
          ? localCompatibility.localVerifiedSha256
          : canUseLocalMetadataFallback && localModel.metadataTrust !== 'verified_local'
            ? localModel.sha256
            : undefined
      ),
      downloadIntegrity: localCompatibility.canPreserveDownloadIntegrity
        ? localModel.downloadIntegrity
        : undefined,
      fitsInRam: canUseLocalMetadataFallback ? localModel.fitsInRam ?? mergedModel.fitsInRam : mergedModel.fitsInRam,
      memoryFitDecision: canUseLocalMetadataFallback ? localModel.memoryFitDecision ?? mergedModel.memoryFitDecision : mergedModel.memoryFitDecision,
      memoryFitConfidence: canUseLocalMetadataFallback ? localModel.memoryFitConfidence ?? mergedModel.memoryFitConfidence : mergedModel.memoryFitConfidence,
      lifecycleStatus: canUseLocalRuntimeState ? localModel.lifecycleStatus : mergedModel.lifecycleStatus,
      downloadProgress: canUseLocalRuntimeState ? localModel.downloadProgress : mergedModel.downloadProgress,
      resumeData: canUseLocalRuntimeState ? localModel.resumeData : undefined,
      downloadErrorAt: canUseLocalRuntimeState ? localModel.downloadErrorAt : undefined,
      downloadErrorCode: canUseLocalRuntimeState ? localModel.downloadErrorCode : undefined,
      downloadErrorMessage: canUseLocalRuntimeState ? localModel.downloadErrorMessage : undefined,
      maxContextTokens: mergedModel.maxContextTokens ?? (canUseLocalMetadataFallback ? localModel.maxContextTokens : undefined),
      hasVerifiedContextWindow: mergedModel.hasVerifiedContextWindow ?? (canUseLocalMetadataFallback ? localModel.hasVerifiedContextWindow : undefined),
      parameterSizeLabel: mergedModel.parameterSizeLabel ?? (canUseLocalMetadataFallback ? localModel.parameterSizeLabel : undefined),
      modelType: mergedModel.modelType ?? (canUseLocalMetadataFallback ? localModel.modelType : undefined),
      architectures: mergedModel.architectures ?? (canUseLocalMetadataFallback ? localModel.architectures : undefined),
      baseModels: mergedModel.baseModels ?? (canUseLocalMetadataFallback ? localModel.baseModels : undefined),
      license: mergedModel.license ?? (canUseLocalMetadataFallback ? localModel.license : undefined),
      languages: mergedModel.languages ?? (canUseLocalMetadataFallback ? localModel.languages : undefined),
      datasets: mergedModel.datasets ?? (canUseLocalMetadataFallback ? localModel.datasets : undefined),
      quantizedBy: mergedModel.quantizedBy ?? (canUseLocalMetadataFallback ? localModel.quantizedBy : undefined),
      modelCreator: mergedModel.modelCreator ?? (canUseLocalMetadataFallback ? localModel.modelCreator : undefined),
      downloads: mergedModel.downloads ?? (canUseLocalMetadataFallback ? localModel.downloads : undefined),
      likes: mergedModel.likes ?? (canUseLocalMetadataFallback ? localModel.likes : undefined),
      tags: mergedModel.tags ?? (canUseLocalMetadataFallback ? localModel.tags : undefined),
      description: mergedModel.description ?? (canUseLocalMetadataFallback ? localModel.description : undefined),
      variants: mergedModel.variants ?? (canUseLocalMetadataFallback ? localModel.variants : undefined),
      activeVariantId: mergedModel.activeVariantId ?? (canUseLocalMetadataFallback ? localModel.activeVariantId : undefined),
      ...projectorRuntimeFields,
    };
  }

  if (isActiveModel) {
    mergedModel.lifecycleStatus = LifecycleStatus.ACTIVE;
  } else if (mergedModel.lifecycleStatus === LifecycleStatus.ACTIVE) {
    mergedModel.lifecycleStatus = LifecycleStatus.DOWNLOADED;
  }

  if (queuedItem) {
    mergedModel = applyModelVariantSelectionIfAvailable(mergedModel, queuedItem, {
      allowResolvedFileNameFallback: false,
      allowResolvedFileNameVariantMatch: false,
    });
    const queuedCompatibility = resolveVerifiedLocalShaCompatibility(queuedItem, {
      sha256: mergedModel.sha256,
      resolvedFileName: mergedModel.resolvedFileName,
      size: mergedModel.size,
    });
    const canUseQueuedRuntimeState = !queuedCompatibility.shouldResetLocalDownloadState
      && !hasResolvedFileNameConflict(queuedItem.resolvedFileName, mergedModel.resolvedFileName)
      && !hasSizeConflict(queuedItem.size, mergedModel.size);
    const projectorRuntimeFields = canUseQueuedRuntimeState
      ? mergeProjectorRuntimeFields(mergedModel, queuedItem)
      : {
        projectorCandidates: mergedModel.projectorCandidates,
        selectedProjectorId: mergedModel.selectedProjectorId,
        multimodalReadiness: mergedModel.multimodalReadiness,
      };

    mergedModel = {
      ...mergedModel,
      size: mergedModel.size ?? (canUseQueuedRuntimeState ? queuedItem.size : null),
      hfRevision: mergedModel.hfRevision ?? (canUseQueuedRuntimeState ? queuedItem.hfRevision : undefined),
      resolvedFileName: mergedModel.resolvedFileName ?? (canUseQueuedRuntimeState ? queuedItem.resolvedFileName : undefined),
      localPath: canUseQueuedRuntimeState ? queuedItem.localPath ?? mergedModel.localPath : mergedModel.localPath,
      downloadedAt: canUseQueuedRuntimeState ? queuedItem.downloadedAt ?? mergedModel.downloadedAt : mergedModel.downloadedAt,
      sha256: mergedModel.sha256 ?? (
        queuedCompatibility.canUseLocalVerifiedMetadata
          ? queuedCompatibility.localVerifiedSha256
          : canUseQueuedRuntimeState && queuedItem.metadataTrust !== 'verified_local'
            ? queuedItem.sha256
            : undefined
      ),
      downloadIntegrity: queuedCompatibility.canPreserveDownloadIntegrity && canUseQueuedRuntimeState
        ? queuedItem.downloadIntegrity ?? mergedModel.downloadIntegrity
        : mergedModel.downloadIntegrity,
      fitsInRam: mergedModel.fitsInRam ?? (canUseQueuedRuntimeState ? queuedItem.fitsInRam : null),
      memoryFitDecision: mergedModel.memoryFitDecision ?? (canUseQueuedRuntimeState ? queuedItem.memoryFitDecision : undefined),
      memoryFitConfidence: mergedModel.memoryFitConfidence ?? (canUseQueuedRuntimeState ? queuedItem.memoryFitConfidence : undefined),
      lifecycleStatus: canUseQueuedRuntimeState ? queuedItem.lifecycleStatus : mergedModel.lifecycleStatus,
      downloadProgress: canUseQueuedRuntimeState ? queuedItem.downloadProgress : mergedModel.downloadProgress,
      resumeData: canUseQueuedRuntimeState ? queuedItem.resumeData : mergedModel.resumeData,
      downloadErrorAt: canUseQueuedRuntimeState ? queuedItem.downloadErrorAt : mergedModel.downloadErrorAt,
      downloadErrorCode: canUseQueuedRuntimeState ? queuedItem.downloadErrorCode : mergedModel.downloadErrorCode,
      downloadErrorMessage: canUseQueuedRuntimeState ? queuedItem.downloadErrorMessage : mergedModel.downloadErrorMessage,
      variants: mergedModel.variants ?? (canUseQueuedRuntimeState ? queuedItem.variants : undefined),
      activeVariantId: mergedModel.activeVariantId ?? (canUseQueuedRuntimeState ? queuedItem.activeVariantId : undefined),
      ...projectorRuntimeFields,
    };
  }

  return mergedModel;
}
