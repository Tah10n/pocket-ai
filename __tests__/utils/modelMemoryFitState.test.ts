import {
  isHighConfidenceLikelyOomMemoryFit,
  shouldWarnForModelMemoryLoad,
} from '../../src/utils/modelMemoryFitState';

describe('modelMemoryFitState', () => {
  it('recognizes only high-confidence likely OOM models as hard blocks', () => {
    expect(isHighConfidenceLikelyOomMemoryFit({
      memoryFitDecision: 'likely_oom',
      memoryFitConfidence: 'high',
      fitsInRam: false,
    })).toBe(true);

    expect(isHighConfidenceLikelyOomMemoryFit({
      memoryFitDecision: 'likely_oom',
      memoryFitConfidence: 'medium',
      fitsInRam: false,
    })).toBe(false);
  });

  it('warns for borderline and softer memory risk states only', () => {
    expect(shouldWarnForModelMemoryLoad(null)).toBe(false);
    expect(shouldWarnForModelMemoryLoad({
      memoryFitDecision: 'likely_oom',
      memoryFitConfidence: 'high',
      fitsInRam: false,
    })).toBe(false);

    expect(shouldWarnForModelMemoryLoad({
      memoryFitDecision: 'borderline',
      memoryFitConfidence: 'medium',
      fitsInRam: true,
    })).toBe(true);

    expect(shouldWarnForModelMemoryLoad({
      memoryFitDecision: 'likely_oom',
      memoryFitConfidence: 'medium',
      fitsInRam: false,
    })).toBe(true);

    expect(shouldWarnForModelMemoryLoad({
      memoryFitDecision: undefined,
      memoryFitConfidence: 'low',
      fitsInRam: false,
    })).toBe(true);

    expect(shouldWarnForModelMemoryLoad({
      memoryFitDecision: 'fits_low_confidence',
      memoryFitConfidence: 'low',
      fitsInRam: true,
    })).toBe(false);
  });
});
