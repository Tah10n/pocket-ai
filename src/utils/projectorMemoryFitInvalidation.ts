import type { ModelMetadata, ModelVariant } from '../types/models';
import type { ProjectorArtifact } from '../types/multimodal';
import { isStoredProjectorArtifact } from './modelSize';
import {
  getEffectiveActiveVariantProjectorCandidates,
  getEffectiveActiveVariantSelectedProjectorId,
} from './modelCapabilities';

type ProjectorIdentityModel = Pick<
  ModelMetadata,
  | 'activeVariantId'
  | 'artifactRole'
  | 'artifacts'
  | 'chatModalities'
  | 'id'
  | 'inputCapabilities'
  | 'multimodalReadiness'
  | 'projectorCandidates'
  | 'resolvedFileName'
  | 'selectedProjectorId'
  | 'variants'
>;

function clearVariantRamFit(variant: ModelVariant): ModelVariant {
  return variant.ramFit || variant.ramFitConfidence
    ? {
        ...variant,
        ramFit: undefined,
        ramFitConfidence: undefined,
      }
    : variant;
}

function getEffectiveMemoryFitProjectors(model: ProjectorIdentityModel): ProjectorArtifact[] {
  const candidates = getEffectiveActiveVariantProjectorCandidates(model);
  const selectedProjectorId = getEffectiveActiveVariantSelectedProjectorId(model, candidates);
  if (!selectedProjectorId) {
    const userSelectedProjectors = candidates.filter((projector) => projector.matchStatus === 'user_selected');
    if (userSelectedProjectors.length > 0) {
      return userSelectedProjectors;
    }

    const storedProjectors = candidates.filter(isStoredProjectorArtifact);
    if (storedProjectors.length > 0) {
      return storedProjectors;
    }

    const matchedProjectors = candidates.filter((projector) => projector.matchStatus === 'matched');
    return matchedProjectors.length === 1 ? matchedProjectors : [];
  }

  const selectedProjector = candidates.find((projector) => projector.id === selectedProjectorId);
  return selectedProjector ? [selectedProjector] : [];
}

function getProjectorMemoryFitSignature(projector: ProjectorArtifact): string {
  const size = projector.size ?? '';
  if (typeof projector.sha256 === 'string' && projector.sha256.trim().length > 0) {
    return ['size', size, 'sha256', projector.sha256.trim()].join('\u0001');
  }

  return [
    'size',
    size,
    'repo',
    projector.repoId,
    'file',
    projector.fileName,
    'revision',
    projector.hfRevision ?? '',
    'url',
    projector.downloadUrl,
  ].join('\u0001');
}

export function clearProjectorScopedMemoryFit(model: ModelMetadata): ModelMetadata {
  const variants = model.variants?.map(clearVariantRamFit);

  return {
    ...model,
    fitsInRam: null,
    memoryFitDecision: undefined,
    memoryFitConfidence: undefined,
    ...(variants ? { variants } : null),
  };
}

export function getSelectedProjectorMemoryFitSignature(model: ProjectorIdentityModel): string | null {
  const projectors = getEffectiveMemoryFitProjectors(model);
  if (projectors.length === 0) {
    return null;
  }

  return projectors
    .map(getProjectorMemoryFitSignature)
    .sort()
    .join('\u0002');
}

export function shouldClearProjectorScopedMemoryFit(
  previousModel: ProjectorIdentityModel,
  nextModel: ProjectorIdentityModel,
): boolean {
  const previousSignature = getSelectedProjectorMemoryFitSignature(previousModel);
  const nextSignature = getSelectedProjectorMemoryFitSignature(nextModel);

  return previousSignature !== nextSignature;
}
