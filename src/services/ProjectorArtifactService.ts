import type { ModelMetadata, ModelVariant } from '../types/models';
import type { MultimodalReadinessStatus, ProjectorArtifact, ProjectorMatchStatus } from '../types/multimodal';
import { clearProjectorScopedMemoryFit, shouldClearProjectorScopedMemoryFit } from '../utils/projectorMemoryFitInvalidation';
import { resolveDeterministicProjectorCandidate } from '../utils/modelProjectors';
import { registry } from './LocalStorageRegistry';

export type ProjectorResolutionReason =
  | 'no_projector_candidates'
  | 'single_projector_candidate'
  | 'deterministic_projector_candidate'
  | 'ambiguous_projector_candidates'
  | 'selected_projector'
  | 'model_not_found'
  | 'projector_not_found';

export type ProjectorResolution = {
  status: ProjectorMatchStatus;
  reason: ProjectorResolutionReason;
  candidates: ProjectorArtifact[];
  selectedProjector?: ProjectorArtifact;
};

export type ProjectorSelection = {
  model?: ModelMetadata;
  resolution: ProjectorResolution;
};

export function getReadinessStatusForProjectorLifecycle(
  projector: Pick<ProjectorArtifact, 'lifecycleStatus'>,
): MultimodalReadinessStatus | null {
  switch (projector.lifecycleStatus) {
    case 'downloaded':
    case 'active':
      return null;
    case 'queued':
    case 'downloading':
    case 'paused':
      return 'projector_downloading';
    case 'failed':
      return 'failed';
    case 'available':
    default:
      return 'missing_projector';
  }
}

type ProjectorModelRegistry = Pick<typeof registry, 'getModel' | 'updateModel'>;

function cloneProjector(projector: ProjectorArtifact): ProjectorArtifact {
  return { ...projector };
}

function resolveActiveVariant(model: ModelMetadata): ModelVariant | undefined {
  const activeVariantId = model.activeVariantId;
  if (!activeVariantId) {
    return undefined;
  }

  return model.variants?.find((variant) => (
    variant.variantId === activeVariantId
    || variant.fileName === activeVariantId
  ));
}

function getActiveModelFileName(model: ModelMetadata): string | undefined {
  const activeVariant = resolveActiveVariant(model);
  return activeVariant?.fileName ?? model.resolvedFileName ?? model.activeVariantId;
}

function getActiveVariantKeys(model: ModelMetadata): Set<string> {
  const activeVariant = resolveActiveVariant(model);
  return new Set(
    [
      model.activeVariantId,
      model.resolvedFileName,
      activeVariant?.variantId,
      activeVariant?.fileName,
    ].filter((value): value is string => typeof value === 'string' && value.length > 0),
  );
}

function getCompatibleProjectors(model: ModelMetadata): ProjectorArtifact[] {
  const ownedProjectors = (model.projectorCandidates ?? [])
    .filter((projector) => projector.ownerModelId === model.id);
  const activeVariantKeys = getActiveVariantKeys(model);
  const compatibleProjectors = ownedProjectors.filter((projector) => (
    !projector.ownerVariantId
    || activeVariantKeys.size === 0
    || activeVariantKeys.has(projector.ownerVariantId)
  ));

  return compatibleProjectors.map(cloneProjector);
}

function shouldPreserveReadinessForSelectedProjector(model: ModelMetadata, projector: ProjectorArtifact): boolean {
  const readiness = model.multimodalReadiness;
  if (!readiness) {
    return false;
  }

  return readiness.projectorId === projector.id;
}

function clearMemoryFitForProjectorChange(model: ModelMetadata, selectedProjectorId: string): ModelMetadata {
  return shouldClearProjectorScopedMemoryFit(model, { ...model, selectedProjectorId })
    ? clearProjectorScopedMemoryFit(model)
    : model;
}

export class ProjectorArtifactService {
  public constructor(private readonly modelRegistry: ProjectorModelRegistry = registry) {}

  public resolveProjectorForModel(model: ModelMetadata): ProjectorResolution {
    const candidates = getCompatibleProjectors(model);
    if (candidates.length === 0) {
      return {
        status: 'missing',
        reason: 'no_projector_candidates',
        candidates,
      };
    }

    const selectedProjector = candidates.find((projector) => projector.id === model.selectedProjectorId);
    if (selectedProjector) {
      return {
        status: 'user_selected',
        reason: 'selected_projector',
        candidates,
        selectedProjector: {
          ...selectedProjector,
          matchStatus: 'user_selected',
        },
      };
    }

    if (candidates.length === 1) {
      return {
        status: 'matched',
        reason: 'single_projector_candidate',
        candidates,
        selectedProjector: {
          ...candidates[0],
          matchStatus: 'matched',
        },
      };
    }

    const activeModelFileName = getActiveModelFileName(model);
    const deterministicProjector = activeModelFileName
      ? resolveDeterministicProjectorCandidate(activeModelFileName, candidates)
      : null;
    if (deterministicProjector) {
      return {
        status: 'matched',
        reason: 'deterministic_projector_candidate',
        candidates,
        selectedProjector: {
          ...deterministicProjector,
          matchStatus: 'matched',
        },
      };
    }

    return {
      status: 'ambiguous',
      reason: 'ambiguous_projector_candidates',
      candidates: candidates.map((projector) => ({
        ...projector,
        matchStatus: projector.matchStatus === 'failed' ? 'failed' : 'ambiguous',
      })),
    };
  }

  public selectProjectorForModel(model: ModelMetadata, projectorId: string): ProjectorSelection {
    const compatibleProjectors = getCompatibleProjectors(model);
    const targetProjector = compatibleProjectors.find((projector) => projector.id === projectorId);
    if (!targetProjector) {
      return {
        resolution: {
          status: 'failed',
          reason: 'projector_not_found',
          candidates: compatibleProjectors,
        },
      };
    }

    const compatibleIds = new Set(compatibleProjectors.map((projector) => projector.id));
    const modelWithProjectorScopedMemoryFit = clearMemoryFitForProjectorChange(model, targetProjector.id);
    const updatedModel: ModelMetadata = {
      ...modelWithProjectorScopedMemoryFit,
      selectedProjectorId: targetProjector.id,
      visionSource: 'user_selected_projector',
      multimodalReadiness: shouldPreserveReadinessForSelectedProjector(model, targetProjector)
        ? model.multimodalReadiness
        : undefined,
      projectorCandidates: (model.projectorCandidates ?? []).map((projector) => {
        if (projector.id === targetProjector.id) {
          return {
            ...projector,
            matchStatus: 'user_selected',
            matchReason: 'user_selected_projector',
          };
        }

        if (compatibleIds.has(projector.id) && projector.matchStatus === 'user_selected') {
          return {
            ...projector,
            matchStatus: 'ambiguous',
            matchReason: 'unselected_projector_candidate',
          };
        }

        return projector;
      }),
    };

    return {
      model: updatedModel,
      resolution: this.resolveProjectorForModel(updatedModel),
    };
  }

  public selectProjector(modelId: string, projectorId: string): ProjectorResolution {
    const model = this.modelRegistry.getModel(modelId);
    if (!model) {
      return {
        status: 'failed',
        reason: 'model_not_found',
        candidates: [],
      };
    }

    const selection = this.selectProjectorForModel(model, projectorId);
    if (selection.model) {
      this.modelRegistry.updateModel(selection.model);
    }
    return selection.resolution;
  }
}

export const projectorArtifactService = new ProjectorArtifactService();
