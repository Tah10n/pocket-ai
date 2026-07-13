import type { ModelMetadata } from '../types/models';
import type { MultimodalReadinessStatus, ProjectorArtifact, ProjectorMatchStatus } from '../types/multimodal';
import { clearProjectorScopedMemoryFit, shouldClearProjectorScopedMemoryFit } from '../utils/projectorMemoryFitInvalidation';
import { resolveDeterministicProjectorCandidate } from '../utils/modelProjectors';
import {
  getEffectiveActiveVariantProjectorCandidates,
  getEffectiveActiveVariantSelectedProjectorId,
  resolveEffectiveActiveVariantNativeSupport,
} from '../utils/modelCapabilities';
import { isMultimodalReadinessReusableForModel } from '../utils/multimodalReadiness';
import { resolveActiveModelVariant } from '../utils/activeModelVariant';
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

function getActiveModelFileName(model: ModelMetadata): string | undefined {
  const activeVariant = resolveActiveModelVariant(model);
  return activeVariant?.fileName ?? model.resolvedFileName ?? model.activeVariantId;
}

function getCompatibleProjectors(model: ModelMetadata): ProjectorArtifact[] {
  return getEffectiveActiveVariantProjectorCandidates(model).map(cloneProjector);
}

function shouldPreserveReadinessForSelectedProjector(model: ModelMetadata, projector: ProjectorArtifact): boolean {
  const support = resolveEffectiveActiveVariantNativeSupport(model);
  const requestedSupport = [
    ...(support.vision ? ['vision' as const] : []),
    ...(support.audio ? ['audio' as const] : []),
  ];

  return isMultimodalReadinessReusableForModel({
    model,
    readiness: model.multimodalReadiness,
    projectorId: projector.id,
    requestedSupport,
    projectorCandidates: getCompatibleProjectors(model),
  });
}

function markSelectedProjectorCandidates(
  candidates: readonly ProjectorArtifact[] | undefined,
  targetProjectorId: string,
  compatibleIds: ReadonlySet<string>,
): ProjectorArtifact[] | undefined {
  return candidates?.map((projector) => {
    if (projector.id === targetProjectorId) {
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
  });
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

    const selectedProjectorId = getEffectiveActiveVariantSelectedProjectorId(model, candidates);
    const selectedProjector = candidates.find((projector) => projector.id === selectedProjectorId);
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
    const nativeSupport = resolveEffectiveActiveVariantNativeSupport(model);
    const activeVariant = resolveActiveModelVariant(model);
    const modelWithUpdatedSelection: ModelMetadata = {
      ...model,
      selectedProjectorId: targetProjector.id,
      visionSource: nativeSupport.vision ? 'user_selected_projector' : undefined,
      ...(!nativeSupport.vision ? { visionConfidence: undefined } : null),
      multimodalReadiness: shouldPreserveReadinessForSelectedProjector(model, targetProjector)
        ? model.multimodalReadiness
        : undefined,
      projectorCandidates: markSelectedProjectorCandidates(
        model.projectorCandidates ?? [],
        targetProjector.id,
        compatibleIds,
      ),
      ...(activeVariant && model.variants ? {
        variants: model.variants.map((variant) => (
          variant.variantId === activeVariant.variantId || variant.fileName === activeVariant.fileName
        )
          ? {
              ...variant,
              selectedProjectorId: targetProjector.id,
              visionSource: nativeSupport.vision ? 'user_selected_projector' as const : undefined,
              ...(!nativeSupport.vision ? { visionConfidence: undefined } : null),
              projectorCandidates: markSelectedProjectorCandidates(
                variant.projectorCandidates,
                targetProjector.id,
                compatibleIds,
              ),
            }
          : variant),
      } : null),
    };
    const updatedModel = shouldClearProjectorScopedMemoryFit(model, modelWithUpdatedSelection)
      ? clearProjectorScopedMemoryFit(modelWithUpdatedSelection)
      : modelWithUpdatedSelection;

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
