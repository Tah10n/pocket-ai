import type { ModelMetadata, ModelVariant } from '../types/models';
import type { ProjectorArtifact } from '../types/multimodal';
import { resolveActiveModelVariant } from './activeModelVariant';
import {
  getEffectiveActiveVariantProjectorCandidates,
  remapProjectorIdToEffectiveCandidate,
} from './modelCapabilities';
import { hasCompatibleProjectorRuntimeIdentity } from './projectorRuntimeState';

export type ProjectorStateModelUpdates = Partial<Pick<
  ModelMetadata,
  'projectorCandidates' | 'selectedProjectorId' | 'variants'
>>;

function isSameVariant(first: ModelVariant, second: ModelVariant): boolean {
  return first.variantId === second.variantId || first.fileName === second.fileName;
}

function mapProjectorCollection(
  projectors: ProjectorArtifact[] | undefined,
  mapper: (projector: ProjectorArtifact) => ProjectorArtifact,
): ProjectorArtifact[] | undefined {
  if (!projectors?.length) {
    return projectors;
  }

  let didChange = false;
  const nextProjectors = projectors.map((projector) => {
    const nextProjector = mapper(projector);
    didChange ||= nextProjector !== projector;
    return nextProjector;
  });

  return didChange ? nextProjectors : projectors;
}

export function mapModelProjectorCandidates(
  model: ModelMetadata,
  mapper: (projector: ProjectorArtifact) => ProjectorArtifact,
): ModelMetadata {
  const projectorCandidates = mapProjectorCollection(model.projectorCandidates, mapper);
  let variantsChanged = false;
  const variants = model.variants?.map((variant) => {
    const nextProjectorCandidates = mapProjectorCollection(variant.projectorCandidates, mapper);
    if (nextProjectorCandidates === variant.projectorCandidates) {
      return variant;
    }

    variantsChanged = true;
    return {
      ...variant,
      projectorCandidates: nextProjectorCandidates,
    };
  });

  if (projectorCandidates === model.projectorCandidates && !variantsChanged) {
    return model;
  }

  return {
    ...model,
    projectorCandidates,
    ...(variantsChanged ? { variants } : null),
  };
}

export function getAllModelProjectorCandidates(
  model: Pick<ModelMetadata, 'projectorCandidates' | 'variants'>,
): ProjectorArtifact[] {
  return [
    ...(model.projectorCandidates ?? []),
    ...(model.variants ?? []).flatMap((variant) => variant.projectorCandidates ?? []),
  ];
}

export function updateEffectiveProjectorCandidate(
  model: ModelMetadata,
  projectorId: string,
  updates: Partial<ProjectorArtifact>,
  expectedProjector?: ProjectorArtifact,
): ModelMetadata {
  const activeVariant = resolveActiveModelVariant(model);
  const activeVariantIds = activeVariant
    ? new Set([activeVariant.variantId, activeVariant.fileName])
    : undefined;
  const effectiveCandidates = getEffectiveActiveVariantProjectorCandidates(model);
  const effectiveProjectorId = remapProjectorIdToEffectiveCandidate(
    model,
    projectorId,
    effectiveCandidates,
  ) ?? projectorId;
  const targetProjector = effectiveCandidates
    .find((projector) => (
      projector.id === effectiveProjectorId
      && (
        expectedProjector === undefined
        || hasCompatibleProjectorRuntimeIdentity(projector, expectedProjector, { activeVariantIds })
      )
    ));
  if (!targetProjector) {
    return model;
  }

  const updateCandidate = (projector: ProjectorArtifact): ProjectorArtifact => {
    if (!hasCompatibleProjectorRuntimeIdentity(projector, targetProjector, { activeVariantIds })) {
      return projector;
    }

    return {
      ...projector,
      ...updates,
      // A full download result is also accepted as `updates`. Keep each
      // current/legacy representation addressable by its own id and retain its
      // model-level versus variant-level ownership while synchronizing state.
      id: projector.id,
      ownerVariantId: projector.ownerVariantId,
    };
  };
  const projectorCandidates = mapProjectorCollection(model.projectorCandidates, updateCandidate);
  let variantsChanged = false;
  const variants = activeVariant
    ? model.variants?.map((variant) => {
        if (!isSameVariant(variant, activeVariant)) {
          return variant;
        }

        const nextProjectorCandidates = mapProjectorCollection(variant.projectorCandidates, updateCandidate);
        if (nextProjectorCandidates === variant.projectorCandidates) {
          return variant;
        }

        variantsChanged = true;
        return {
          ...variant,
          projectorCandidates: nextProjectorCandidates,
        };
      })
    : model.variants;

  if (projectorCandidates === model.projectorCandidates && !variantsChanged) {
    return model;
  }

  return {
    ...model,
    projectorCandidates,
    ...(variantsChanged ? { variants } : null),
  };
}

function findCompatibleProjector(
  projector: ProjectorArtifact,
  nextProjectors: readonly ProjectorArtifact[],
  activeVariantIds: ReadonlySet<string> | undefined,
): ProjectorArtifact | undefined {
  return nextProjectors.find((nextProjector) => (
    hasCompatibleProjectorRuntimeIdentity(projector, nextProjector, { activeVariantIds })
  ));
}

function collectionContainsProjector(
  projectors: readonly ProjectorArtifact[] | undefined,
  target: ProjectorArtifact,
  activeVariantIds: ReadonlySet<string> | undefined,
): boolean {
  return projectors?.some((projector) => (
    hasCompatibleProjectorRuntimeIdentity(projector, target, { activeVariantIds })
  )) === true;
}

function reconcileKnownProjectors(
  projectors: ProjectorArtifact[] | undefined,
  nextProjectors: readonly ProjectorArtifact[],
  activeVariantIds: ReadonlySet<string> | undefined,
  isInEffectiveScope: (projector: ProjectorArtifact) => boolean,
): ProjectorArtifact[] | undefined {
  if (!projectors?.length) {
    return projectors;
  }

  let didChange = false;
  const reconciled = projectors.flatMap((projector) => {
    const replacement = findCompatibleProjector(projector, nextProjectors, activeVariantIds);
    if (replacement) {
      didChange ||= replacement !== projector;
      return [replacement];
    }

    if (isInEffectiveScope(projector)) {
      didChange = true;
      return [];
    }

    return [projector];
  });

  if (!didChange) {
    return projectors;
  }

  return reconciled.length > 0 ? reconciled : undefined;
}

function normalizeSelectedProjectorId(
  selectedProjectorId: string | undefined,
  candidateIds: ReadonlySet<string>,
): string | undefined {
  return selectedProjectorId && candidateIds.has(selectedProjectorId)
    ? selectedProjectorId
    : undefined;
}

/**
 * Writes effective projector runtime state back to the layer that owns it.
 * Active-variant-only candidates and selections stay variant scoped, while
 * legacy model-level candidates continue to receive matching runtime updates.
 */
export function applyEffectiveProjectorState(
  model: ModelMetadata,
  state: {
    projectorCandidates: ProjectorArtifact[] | undefined;
    selectedProjectorId: string | undefined;
  },
): ModelMetadata {
  const nextProjectors = state.projectorCandidates ?? [];
  const nextProjectorIds = new Set(nextProjectors.map((projector) => projector.id));
  const selectedProjectorId = normalizeSelectedProjectorId(state.selectedProjectorId, nextProjectorIds);
  const selectedProjector = nextProjectors.find((projector) => projector.id === selectedProjectorId);
  const activeVariant = resolveActiveModelVariant(model);
  const activeVariantKeys = new Set(
    activeVariant ? [activeVariant.variantId, activeVariant.fileName] : [],
  );
  const currentEffectiveProjectors = getEffectiveActiveVariantProjectorCandidates(model);
  const isCurrentEffectiveProjector = (projector: ProjectorArtifact): boolean => (
    currentEffectiveProjectors.some((effectiveProjector) => (
      effectiveProjector === projector
      || hasCompatibleProjectorRuntimeIdentity(projector, effectiveProjector, {
        activeVariantIds: activeVariantKeys,
      })
    ))
  );

  let projectorCandidates = reconcileKnownProjectors(
    model.projectorCandidates,
    nextProjectors,
    activeVariantKeys,
    isCurrentEffectiveProjector,
  );
  let variants = model.variants;
  let activeVariantProjectorIds = new Set<string>();
  let shouldStoreMissingOnActiveVariant = false;

  if (activeVariant && variants) {
    shouldStoreMissingOnActiveVariant = Boolean(
      activeVariant.projectorCandidates?.length
      || activeVariant.selectedProjectorId
      || nextProjectors.some((projector) => (
        projector.ownerVariantId !== undefined
        && activeVariantKeys.has(projector.ownerVariantId)
      )),
    );

    let variantsChanged = false;
    variants = variants.map((variant) => {
      if (!isSameVariant(variant, activeVariant)) {
        return variant;
      }

      let nextVariantProjectors = reconcileKnownProjectors(
        variant.projectorCandidates,
        nextProjectors,
        activeVariantKeys,
        () => true,
      );
      activeVariantProjectorIds = new Set((nextVariantProjectors ?? []).map((projector) => projector.id));
      const missingVariantProjectors = shouldStoreMissingOnActiveVariant
        ? nextProjectors.filter((projector) => (
            !collectionContainsProjector(nextVariantProjectors, projector, activeVariantKeys)
            && !collectionContainsProjector(projectorCandidates, projector, activeVariantKeys)
            && (
              projector.ownerVariantId === undefined
              || activeVariantKeys.has(projector.ownerVariantId)
            )
          ))
        : [];
      if (missingVariantProjectors.length > 0) {
        nextVariantProjectors = [...(nextVariantProjectors ?? []), ...missingVariantProjectors];
        missingVariantProjectors.forEach((projector) => activeVariantProjectorIds.add(projector.id));
      }

      const shouldOwnSelection = shouldStoreMissingOnActiveVariant
        || activeVariantProjectorIds.has(selectedProjectorId ?? '');
      const nextSelectedProjectorId = shouldOwnSelection ? selectedProjectorId : variant.selectedProjectorId;
      if (
        nextVariantProjectors === variant.projectorCandidates
        && nextSelectedProjectorId === variant.selectedProjectorId
      ) {
        return variant;
      }

      variantsChanged = true;
      return {
        ...variant,
        projectorCandidates: nextVariantProjectors,
        selectedProjectorId: nextSelectedProjectorId,
      };
    });

    if (!variantsChanged) {
      variants = model.variants;
    }
  }

  const activeVariantProjectors = activeVariant
    ? variants?.find((variant) => isSameVariant(variant, activeVariant))?.projectorCandidates
    : undefined;
  const missingModelProjectors = nextProjectors.filter((projector) => (
    !collectionContainsProjector(projectorCandidates, projector, activeVariantKeys)
    && !collectionContainsProjector(activeVariantProjectors, projector, activeVariantKeys)
  ));
  if (missingModelProjectors.length > 0) {
    projectorCandidates = [...(projectorCandidates ?? []), ...missingModelProjectors];
  }

  const activeVariantOwnsSelection = shouldStoreMissingOnActiveVariant
    || activeVariantProjectorIds.has(selectedProjectorId ?? '');
  const selectedProjectorIsRepresentedAtModelLevel = selectedProjector !== undefined
    && collectionContainsProjector(projectorCandidates, selectedProjector, activeVariantKeys);
  const nextModelSelectedProjectorId = activeVariantOwnsSelection
    ? selectedProjectorIsRepresentedAtModelLevel ? selectedProjectorId : undefined
    : selectedProjectorId;

  if (
    projectorCandidates === model.projectorCandidates
    && variants === model.variants
    && nextModelSelectedProjectorId === model.selectedProjectorId
  ) {
    return model;
  }

  return {
    ...model,
    projectorCandidates,
    selectedProjectorId: nextModelSelectedProjectorId,
    ...(variants !== model.variants ? { variants } : null),
  };
}

export function getProjectorStateUpdates(
  previousModel: ModelMetadata,
  nextModel: ModelMetadata,
): ProjectorStateModelUpdates {
  return {
    ...(nextModel.projectorCandidates !== previousModel.projectorCandidates
      ? { projectorCandidates: nextModel.projectorCandidates }
      : null),
    ...(nextModel.selectedProjectorId !== previousModel.selectedProjectorId
      ? { selectedProjectorId: nextModel.selectedProjectorId }
      : null),
    ...(nextModel.variants !== previousModel.variants
      ? { variants: nextModel.variants }
      : null),
  };
}
