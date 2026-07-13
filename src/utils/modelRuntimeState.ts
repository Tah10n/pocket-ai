import { LifecycleStatus, type ModelMetadata } from '../types/models';
import { resolveVerifiedLocalShaCompatibility } from '../services/ModelIntegrityMetadata';
import { applyModelVariantSelectionIfAvailable } from './modelVariants';
import { clearProjectorScopedMemoryFit, shouldClearProjectorScopedMemoryFit } from './projectorMemoryFitInvalidation';
import { mergeProjectorCandidatesWithRuntimeStateAndIdMap } from './projectorRuntimeState';
import {
  getEffectiveActiveVariantKeys,
  getEffectiveActiveVariantProjectorCandidates,
  getEffectiveActiveVariantSelectedProjectorId,
  hasExplicitEffectiveActiveVariantProjectorCandidates,
  remapProjectorIdToEffectiveCandidate,
} from './modelCapabilities';
import { applyEffectiveProjectorState } from './effectiveProjectorState';

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

function getProjectorIdentityCandidates(
  model: Pick<ModelMetadata, 'projectorCandidates' | 'variants'>,
) {
  return [
    ...(model.projectorCandidates ?? []),
    ...(model.variants ?? []).flatMap((variant) => variant.projectorCandidates ?? []),
  ];
}

function resolveMergedSelectedProjectorId(
  nextSelectedProjectorId: string | undefined,
  runtimeSelectedProjectorId: string | undefined,
  candidateIds: Set<string>,
  runtimeToNextProjectorIds: Map<string, string>,
  blockedRuntimeProjectorIds: Set<string> = new Set(),
  blockedNextProjectorIds: Set<string> = blockedRuntimeProjectorIds,
): string | undefined {
  const blockedIncomingSelectedProjectorId = nextSelectedProjectorId
    && blockedNextProjectorIds.has(nextSelectedProjectorId)
    ? nextSelectedProjectorId
    : undefined;

  if (
    nextSelectedProjectorId
    && candidateIds.has(nextSelectedProjectorId)
    && !blockedIncomingSelectedProjectorId
  ) {
    return nextSelectedProjectorId;
  }

  if (!runtimeSelectedProjectorId) {
    return undefined;
  }

  if (blockedRuntimeProjectorIds.has(runtimeSelectedProjectorId)) {
    return undefined;
  }

  const selectedProjectorId = runtimeToNextProjectorIds.get(runtimeSelectedProjectorId)
    ?? runtimeSelectedProjectorId;

  if (blockedIncomingSelectedProjectorId) {
    return selectedProjectorId === blockedIncomingSelectedProjectorId
      && runtimeSelectedProjectorId !== selectedProjectorId
      && candidateIds.has(selectedProjectorId)
      ? selectedProjectorId
      : undefined;
  }

  if (blockedNextProjectorIds.has(selectedProjectorId)) {
    return undefined;
  }

  return candidateIds.has(selectedProjectorId) ? selectedProjectorId : undefined;
}

function shouldSuppressReadinessForBlockedIncomingProjector(
  nextSelectedProjectorId: string | undefined,
  selectedProjectorId: string | undefined,
  candidateIds: Set<string>,
  blockedNextProjectorIds: Set<string>,
): boolean {
  return Boolean(
    nextSelectedProjectorId
    && blockedNextProjectorIds.has(nextSelectedProjectorId)
    && selectedProjectorId !== nextSelectedProjectorId,
  );
}

function remapMultimodalReadiness(
  modelId: string,
  readiness: ModelMetadata['multimodalReadiness'],
  candidateIds: Set<string>,
  runtimeToNextProjectorIds: Map<string, string>,
  selectedProjectorId: string | undefined,
  blockedSourceProjectorIds: Set<string> = new Set(),
  blockedResolvedProjectorIds: Set<string> = blockedSourceProjectorIds,
): ModelMetadata['multimodalReadiness'] {
  if (!readiness || readiness.modelId !== modelId) {
    return undefined;
  }

  if (!readiness.projectorId) {
    return readiness;
  }

  if (blockedSourceProjectorIds.has(readiness.projectorId)) {
    return undefined;
  }

  const projectorId = runtimeToNextProjectorIds.get(readiness.projectorId)
    ?? readiness.projectorId;

  if (blockedResolvedProjectorIds.has(projectorId)) {
    return undefined;
  }

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
  blockedNextReadinessProjectorIds: Set<string> = new Set(),
  blockedRuntimeReadinessProjectorIds: Set<string> = blockedNextReadinessProjectorIds,
  blockedRuntimeResolvedReadinessProjectorIds: Set<string> = blockedRuntimeReadinessProjectorIds,
): ModelMetadata['multimodalReadiness'] {
  return remapMultimodalReadiness(
    modelId,
    nextReadiness,
    candidateIds,
    runtimeToNextProjectorIds,
    selectedProjectorId,
    blockedNextReadinessProjectorIds,
    blockedNextReadinessProjectorIds,
  ) ?? remapMultimodalReadiness(
    modelId,
    runtimeReadiness,
    candidateIds,
    runtimeToNextProjectorIds,
    selectedProjectorId,
    blockedRuntimeReadinessProjectorIds,
    blockedRuntimeResolvedReadinessProjectorIds,
  );
}

function getEffectiveMultimodalReadiness(
  model: ModelMetadata,
  projectorCandidates: NonNullable<ModelMetadata['projectorCandidates']>,
): ModelMetadata['multimodalReadiness'] {
  const readiness = model.multimodalReadiness;
  if (!readiness?.projectorId) {
    return readiness;
  }

  const projectorId = remapProjectorIdToEffectiveCandidate(
    model,
    readiness.projectorId,
    projectorCandidates,
  );
  return projectorId && projectorId !== readiness.projectorId
    ? { ...readiness, projectorId }
    : readiness;
}

function mergeProjectorRuntimeFields(
  model: ModelMetadata,
  runtimeModel: ModelMetadata,
): ModelMetadata {
  const nextProjectorCandidates = getEffectiveActiveVariantProjectorCandidates(model);
  const runtimeProjectorCandidates = getEffectiveActiveVariantProjectorCandidates(runtimeModel);
  const incomingActiveVariantIds = getEffectiveActiveVariantKeys(model);
  const activeVariantIds = incomingActiveVariantIds.size > 0
    ? incomingActiveVariantIds
    : getEffectiveActiveVariantKeys(runtimeModel);
  const {
    projectorCandidates,
    runtimeToNextProjectorIds,
    blockedRuntimeProjectorIds,
    blockedNextProjectorIds,
    blockedRuntimeReadinessProjectorIds: mergeBlockedRuntimeReadinessProjectorIds,
    blockedNextReadinessProjectorIds: mergeBlockedNextReadinessProjectorIds,
  } = mergeProjectorCandidatesWithRuntimeStateAndIdMap(nextProjectorCandidates, runtimeProjectorCandidates, {
    activeVariantIds,
    emptyNextProjectorsAreAuthoritative: hasExplicitEffectiveActiveVariantProjectorCandidates(model),
    nextIdentityCandidates: getProjectorIdentityCandidates(model),
    runtimeIdentityCandidates: getProjectorIdentityCandidates(runtimeModel),
  });
  const candidateIds = getProjectorCandidateIds({ projectorCandidates });
  const selectedProjectorId = resolveMergedSelectedProjectorId(
    getEffectiveActiveVariantSelectedProjectorId(model, nextProjectorCandidates),
    getEffectiveActiveVariantSelectedProjectorId(runtimeModel, runtimeProjectorCandidates),
    candidateIds,
    runtimeToNextProjectorIds,
    blockedRuntimeProjectorIds,
    blockedNextProjectorIds,
  );
  const blockedNextReadinessProjectorIds = new Set<string>([
    ...mergeBlockedNextReadinessProjectorIds,
    ...blockedNextProjectorIds,
  ]);
  const blockedRuntimeReadinessProjectorIds = new Set<string>([
    ...mergeBlockedRuntimeReadinessProjectorIds,
    ...blockedRuntimeProjectorIds,
  ]);
  const blockedRuntimeResolvedReadinessProjectorIds = new Set(mergeBlockedNextReadinessProjectorIds);
  const shouldSuppressMultimodalReadiness = shouldSuppressReadinessForBlockedIncomingProjector(
    getEffectiveActiveVariantSelectedProjectorId(model, nextProjectorCandidates),
    selectedProjectorId,
    candidateIds,
    blockedNextProjectorIds,
  );

  const multimodalReadiness = shouldSuppressMultimodalReadiness
      ? undefined
      : resolveMergedMultimodalReadiness(
        model.id,
        getEffectiveMultimodalReadiness(model, nextProjectorCandidates),
        getEffectiveMultimodalReadiness(runtimeModel, runtimeProjectorCandidates),
        candidateIds,
        runtimeToNextProjectorIds,
        selectedProjectorId,
        blockedNextReadinessProjectorIds,
        blockedRuntimeReadinessProjectorIds,
        blockedRuntimeResolvedReadinessProjectorIds,
      );

  return applyEffectiveProjectorState({
    ...model,
    multimodalReadiness,
  }, {
    projectorCandidates,
    selectedProjectorId,
  });
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
    const modelWithProjectorRuntimeFields = canUseLocalRuntimeState
      ? mergeProjectorRuntimeFields(mergedModel, localModel)
      : mergedModel;
    const shouldClearLocalProjectorMemoryFit = canUseLocalMetadataFallback && (
      shouldClearProjectorScopedMemoryFit(mergedModel, modelWithProjectorRuntimeFields)
      || shouldClearProjectorScopedMemoryFit(localModel, modelWithProjectorRuntimeFields)
    );

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
      fitsInRam: canUseLocalMetadataFallback && !shouldClearLocalProjectorMemoryFit
        ? localModel.fitsInRam ?? mergedModel.fitsInRam
        : mergedModel.fitsInRam,
      memoryFitDecision: canUseLocalMetadataFallback && !shouldClearLocalProjectorMemoryFit
        ? localModel.memoryFitDecision ?? mergedModel.memoryFitDecision
        : mergedModel.memoryFitDecision,
      memoryFitConfidence: canUseLocalMetadataFallback && !shouldClearLocalProjectorMemoryFit
        ? localModel.memoryFitConfidence ?? mergedModel.memoryFitConfidence
        : mergedModel.memoryFitConfidence,
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
      variants: modelWithProjectorRuntimeFields.variants
        ?? (canUseLocalMetadataFallback ? localModel.variants : undefined),
      activeVariantId: mergedModel.activeVariantId ?? (canUseLocalMetadataFallback ? localModel.activeVariantId : undefined),
      projectorCandidates: modelWithProjectorRuntimeFields.projectorCandidates,
      selectedProjectorId: modelWithProjectorRuntimeFields.selectedProjectorId,
      multimodalReadiness: modelWithProjectorRuntimeFields.multimodalReadiness,
    };
    if (shouldClearLocalProjectorMemoryFit) {
      mergedModel = clearProjectorScopedMemoryFit(mergedModel);
    }
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
    const modelWithProjectorRuntimeFields = canUseQueuedRuntimeState
      ? mergeProjectorRuntimeFields(mergedModel, queuedItem)
      : mergedModel;
    const shouldClearQueuedProjectorMemoryFit = canUseQueuedRuntimeState && (
      shouldClearProjectorScopedMemoryFit(mergedModel, modelWithProjectorRuntimeFields)
      || shouldClearProjectorScopedMemoryFit(queuedItem, modelWithProjectorRuntimeFields)
    );

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
      fitsInRam: mergedModel.fitsInRam ?? (
        canUseQueuedRuntimeState && !shouldClearQueuedProjectorMemoryFit ? queuedItem.fitsInRam : null
      ),
      memoryFitDecision: mergedModel.memoryFitDecision ?? (
        canUseQueuedRuntimeState && !shouldClearQueuedProjectorMemoryFit ? queuedItem.memoryFitDecision : undefined
      ),
      memoryFitConfidence: mergedModel.memoryFitConfidence ?? (
        canUseQueuedRuntimeState && !shouldClearQueuedProjectorMemoryFit ? queuedItem.memoryFitConfidence : undefined
      ),
      lifecycleStatus: canUseQueuedRuntimeState ? queuedItem.lifecycleStatus : mergedModel.lifecycleStatus,
      downloadProgress: canUseQueuedRuntimeState ? queuedItem.downloadProgress : mergedModel.downloadProgress,
      resumeData: canUseQueuedRuntimeState ? queuedItem.resumeData : mergedModel.resumeData,
      downloadErrorAt: canUseQueuedRuntimeState ? queuedItem.downloadErrorAt : mergedModel.downloadErrorAt,
      downloadErrorCode: canUseQueuedRuntimeState ? queuedItem.downloadErrorCode : mergedModel.downloadErrorCode,
      downloadErrorMessage: canUseQueuedRuntimeState ? queuedItem.downloadErrorMessage : mergedModel.downloadErrorMessage,
      variants: modelWithProjectorRuntimeFields.variants
        ?? (canUseQueuedRuntimeState ? queuedItem.variants : undefined),
      activeVariantId: mergedModel.activeVariantId ?? (canUseQueuedRuntimeState ? queuedItem.activeVariantId : undefined),
      projectorCandidates: modelWithProjectorRuntimeFields.projectorCandidates,
      selectedProjectorId: modelWithProjectorRuntimeFields.selectedProjectorId,
      multimodalReadiness: modelWithProjectorRuntimeFields.multimodalReadiness,
    };
    if (shouldClearQueuedProjectorMemoryFit) {
      mergedModel = clearProjectorScopedMemoryFit(mergedModel);
    }
  }

  return mergedModel;
}
