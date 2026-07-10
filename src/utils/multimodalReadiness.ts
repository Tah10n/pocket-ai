import type { ModelMetadata } from '../types/models';
import type {
  MultimodalReadinessState,
  MultimodalSupportModality,
  ProjectorArtifact,
} from '../types/multimodal';
import {
  getEffectiveActiveVariantKeys,
  getEffectiveActiveVariantProjectorCandidates,
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
  return getValidatedMultimodalReadinessForResolvedScope({
    modelId: model.id,
    readiness,
    projectorId,
    expectedRequestedSupport: requestedSupport,
    activeVariantKeys,
    variantCount: model.variants?.length ?? 0,
    projectorCandidates,
  }) !== undefined;
}
