import type {
  MultimodalReadinessState,
  MultimodalSupportModality,
  ProjectorArtifact,
} from '../types/multimodal';

const SUPPORT_ORDER: readonly MultimodalSupportModality[] = ['vision', 'audio'];

export function normalizeMultimodalSupport(
  support: readonly MultimodalSupportModality[] | undefined,
): MultimodalSupportModality[] {
  const values = new Set(support ?? []);
  return SUPPORT_ORDER.filter((modality) => values.has(modality));
}

function haveExactSupport(
  left: readonly MultimodalSupportModality[],
  right: readonly MultimodalSupportModality[],
): boolean {
  return left.length === right.length && left.every((modality) => right.includes(modality));
}

export function normalizeMultimodalReadinessState(
  readiness: MultimodalReadinessState,
): MultimodalReadinessState {
  const { requestedSupport: _requestedSupport, ...baseReadiness } = readiness;
  const requestedSupport = readiness.requestedSupport === undefined
    ? undefined
    : normalizeMultimodalSupport(readiness.requestedSupport);
  const normalizedSupport = normalizeMultimodalSupport(readiness.support);
  const support = requestedSupport === undefined
    ? normalizedSupport
    : normalizedSupport.filter((modality) => requestedSupport.includes(modality));

  return {
    ...baseReadiness,
    support,
    ...(requestedSupport === undefined ? {} : { requestedSupport }),
  };
}

/**
 * Validates readiness against a caller-resolved model/variant/projector scope.
 * Keeping this primitive free of model-capability imports lets both capability
 * inference and the higher-level readiness helper enforce the same boundary.
 */
export function getValidatedMultimodalReadinessForResolvedScope({
  modelId,
  readiness,
  projectorId,
  expectedRequestedSupport,
  activeVariantKeys,
  variantCount,
  projectorCandidates,
}: {
  modelId: string | undefined;
  readiness: MultimodalReadinessState | undefined;
  projectorId: string | undefined;
  expectedRequestedSupport?: readonly MultimodalSupportModality[];
  activeVariantKeys: ReadonlySet<string>;
  variantCount: number;
  projectorCandidates: readonly ProjectorArtifact[];
}): MultimodalReadinessState | undefined {
  if (
    !modelId
    || !readiness
    || readiness.modelId !== modelId
    || readiness.projectorId !== projectorId
  ) {
    return undefined;
  }

  const normalized = normalizeMultimodalReadinessState(readiness);
  const rawSupport = normalizeMultimodalSupport(readiness.support);
  const declaredRequestedSupport = readiness.requestedSupport === undefined
    ? undefined
    : normalizeMultimodalSupport(readiness.requestedSupport);
  if (
    declaredRequestedSupport !== undefined
    && !rawSupport.every((modality) => declaredRequestedSupport.includes(modality))
  ) {
    return undefined;
  }

  if (expectedRequestedSupport !== undefined) {
    const normalizedExpectedRequestedSupport = normalizeMultimodalSupport(expectedRequestedSupport);
    const checkedRequestedSupport = normalizeMultimodalSupport(
      normalized.requestedSupport ?? normalized.support,
    );
    if (
      !haveExactSupport(checkedRequestedSupport, normalizedExpectedRequestedSupport)
      || !rawSupport.every((modality) => normalizedExpectedRequestedSupport.includes(modality))
    ) {
      return undefined;
    }
  }

  if (normalized.status === 'ready' && (normalized.support.length === 0 || projectorId === undefined)) {
    return undefined;
  }
  if (readiness.requestedSupport === undefined && readiness.status !== 'ready') {
    return undefined;
  }

  if (readiness.variantId) {
    if (activeVariantKeys.size === 0 || !activeVariantKeys.has(readiness.variantId)) {
      return undefined;
    }
  } else if (variantCount > 1) {
    return undefined;
  }

  if (projectorId === undefined) {
    return normalized;
  }

  const projector = projectorCandidates.find((candidate) => candidate.id === projectorId);
  if (!projector || projector.ownerModelId !== modelId) {
    return undefined;
  }

  return projector.ownerVariantId === undefined
    || (activeVariantKeys.size > 0 && activeVariantKeys.has(projector.ownerVariantId))
    ? normalized
    : undefined;
}
