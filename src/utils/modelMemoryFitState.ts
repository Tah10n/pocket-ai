import type { ModelMetadata } from '../types/models';

type ModelMemoryFitBlockState = Pick<ModelMetadata, 'memoryFitDecision' | 'memoryFitConfidence' | 'fitsInRam'>;
type ModelMemoryFitWarningState = Pick<ModelMetadata, 'memoryFitDecision' | 'memoryFitConfidence' | 'fitsInRam'>;

export function isHighConfidenceLikelyOomMemoryFit(
  model: ModelMemoryFitBlockState | null | undefined,
): boolean {
  return model?.memoryFitDecision === 'likely_oom' && model.memoryFitConfidence === 'high' && model.fitsInRam === false;
}

export function shouldWarnForModelMemoryLoad(
  model: ModelMemoryFitWarningState | null | undefined,
): boolean {
  if (!model || isHighConfidenceLikelyOomMemoryFit(model)) {
    return false;
  }

  return (
    model.memoryFitDecision === 'borderline'
    || model.memoryFitDecision === 'likely_oom'
    || (model.memoryFitDecision === undefined && model.fitsInRam === false)
  );
}
