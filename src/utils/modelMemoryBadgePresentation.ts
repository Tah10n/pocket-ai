import type { ModelMetadata, ModelVariant } from '../types/models';

export interface ModelMemoryBadgePresentation {
  labelKey: string;
  tone: 'neutral' | 'warning' | 'error' | 'success';
  iconName: 'help' | 'memory' | 'warning';
}

interface ModelMemoryBadgePresentationOptions {
  useModelFallback?: boolean;
}

export function getVariantMemoryBadgePresentation(
  model: Pick<ModelMetadata, 'fitsInRam' | 'memoryFitDecision'>,
  variant: Pick<ModelVariant, 'ramFit'> | undefined,
  options: ModelMemoryBadgePresentationOptions = {},
): ModelMemoryBadgePresentation {
  const useModelFallback = options.useModelFallback === true;
  const decision = variant?.ramFit ?? (useModelFallback ? model.memoryFitDecision : undefined);

  if (decision === 'fits_high_confidence' || decision === 'fits_low_confidence') {
    return {
      labelKey: 'models.ramFitYes',
      tone: 'success',
      iconName: 'memory',
    };
  }

  if (decision === 'likely_oom') {
    return {
      labelKey: 'models.ramLikelyOom',
      tone: 'error',
      iconName: 'warning',
    };
  }

  if (decision === 'borderline') {
    return {
      labelKey: 'models.ramBorderline',
      tone: 'warning',
      iconName: 'warning',
    };
  }

  if (!decision && useModelFallback && model.fitsInRam === true) {
    return {
      labelKey: 'models.ramFitYes',
      tone: 'success',
      iconName: 'memory',
    };
  }

  if (!decision && useModelFallback && model.fitsInRam === false) {
    return {
      labelKey: 'models.ramWarning',
      tone: 'warning',
      iconName: 'warning',
    };
  }

  return {
    labelKey: 'models.ramFitUnknown',
    tone: 'neutral',
    iconName: 'help',
  };
}
