import type { ModelMetadata } from '../types/models';
import type {
  MultimodalReadinessState,
  MultimodalSupportModality,
  ProjectorArtifact,
} from '../types/multimodal';
import {
  getEffectiveActiveVariantKeys,
  getEffectiveActiveVariantProjectorCandidates,
  remapProjectorIdToEffectiveCandidate,
} from './modelCapabilities';
import { getValidatedMultimodalReadinessForResolvedScope } from './multimodalReadinessCore';

export { normalizeMultimodalReadinessState } from './multimodalReadinessCore';

type ReadinessReuseModel = Pick<
  ModelMetadata,
  'activeVariantId' | 'id' | 'projectorCandidates' | 'resolvedFileName' | 'variants'
>;

export function isMultimodalReadinessReusableForModel({
  model,
  readiness,
  projectorId,
  requestedSupport,
  projectorCandidates = getEffectiveActiveVariantProjectorCandidates(model),
}: {
  model: ReadinessReuseModel;
  readiness: MultimodalReadinessState | undefined;
  projectorId: string | undefined;
  requestedSupport: readonly MultimodalSupportModality[];
  projectorCandidates?: readonly ProjectorArtifact[];
}): boolean {
  const activeVariantKeys = getEffectiveActiveVariantKeys(model);
  const effectiveCandidates = [...projectorCandidates];
  const effectiveProjectorId = projectorId === undefined
    ? undefined
    : remapProjectorIdToEffectiveCandidate(model, projectorId, effectiveCandidates);
  const readinessProjectorId = readiness?.projectorId === undefined
    ? undefined
    : remapProjectorIdToEffectiveCandidate(model, readiness.projectorId, effectiveCandidates);
  if (
    (projectorId !== undefined && effectiveProjectorId === undefined)
    || (readiness?.projectorId !== undefined && readinessProjectorId === undefined)
  ) {
    return false;
  }

  const effectiveReadiness = readiness?.projectorId === undefined || readinessProjectorId === readiness.projectorId
    ? readiness
    : { ...readiness, projectorId: readinessProjectorId };
  return getValidatedMultimodalReadinessForResolvedScope({
    modelId: model.id,
    readiness: effectiveReadiness,
    projectorId: effectiveProjectorId,
    expectedRequestedSupport: requestedSupport,
    activeVariantKeys,
    variantCount: model.variants?.length ?? 0,
    projectorCandidates: effectiveCandidates,
  }) !== undefined;
}
