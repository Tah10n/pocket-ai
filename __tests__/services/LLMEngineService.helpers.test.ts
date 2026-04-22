import type { MemoryFitResult } from '../../src/memory/types';
import {
  areThinkingCapabilitySnapshotsEqual,
  canAutoUseSafeLoadProfile,
  getErrorMessageText,
  getModelInfoString,
  isConversationAlternationError,
  isProbableMemoryFailure,
  readNumericMetadata,
  shouldHardBlockSafeLoad,
} from '../../src/services/LLMEngineService.helpers';
import type { ModelThinkingCapabilitySnapshot } from '../../src/types/models';

function createMemoryFit(overrides: Partial<MemoryFitResult> = {}): MemoryFitResult {
  return {
    decision: 'likely_oom',
    confidence: 'medium',
    requiredBytes: 120,
    effectiveBudgetBytes: 100,
    breakdown: {
      weightsBytes: 10,
      kvCacheBytes: 10,
      computeBytes: 10,
      multimodalBytes: 10,
      overheadBytes: 10,
      safetyMarginBytes: 10,
      ...overrides.breakdown,
    },
    budget: {
      totalMemoryBytes: 1_024,
      effectiveBudgetBytes: 100,
      ...overrides.budget,
    },
    recommendations: [],
    ...overrides,
  };
}

function createThinkingSnapshot(
  overrides: Partial<ModelThinkingCapabilitySnapshot> = {},
): ModelThinkingCapabilitySnapshot {
  return {
    detectedAt: 100,
    supportsThinking: true,
    canDisableThinking: true,
    thinkingStartTag: '<think>',
    thinkingEndTag: '</think>',
    ...overrides,
  };
}

describe('LLMEngineService.helpers', () => {
  describe('getErrorMessageText', () => {
    it.each([
      [new Error('engine failed'), 'engine failed'],
      ['plain error', 'plain error'],
      [{ message: 'object error' }, 'object error'],
      [null, ''],
      [{}, ''],
      [{ message: 42 }, ''],
    ])('normalizes %p into %p', (error, expected) => {
      expect(getErrorMessageText(error)).toBe(expected);
    });
  });

  it('detects conversation alternation errors case-insensitively', () => {
    expect(isConversationAlternationError(new Error('Conversation roles must alternate user/assistant'))).toBe(true);
    expect(isConversationAlternationError('conversation roles MUST alternate user/assistant')).toBe(true);
    expect(isConversationAlternationError(new Error('something else'))).toBe(false);
  });

  it.each([
    'Out of memory while loading model',
    'OOM in native allocator',
    'std::bad_alloc',
    'Cannot allocate memory for tensor',
    'failed to allocate kv cache',
  ])('detects probable memory failures for %p', (message) => {
    expect(isProbableMemoryFailure(message)).toBe(true);
  });

  it('does not flag empty or unrelated errors as memory failures', () => {
    expect(isProbableMemoryFailure(null)).toBe(false);
    expect(isProbableMemoryFailure('download cancelled by user')).toBe(false);
  });

  describe('shouldHardBlockSafeLoad', () => {
    it('returns false when there is no usable memory fit result', () => {
      expect(shouldHardBlockSafeLoad({ memoryFit: null, availableBudgetBytes: 100, lowMemorySignal: false })).toBe(false);
      expect(
        shouldHardBlockSafeLoad({
          memoryFit: createMemoryFit({ requiredBytes: 0 }),
          availableBudgetBytes: 100,
          lowMemorySignal: false,
        }),
      ).toBe(false);
      expect(
        shouldHardBlockSafeLoad({
          memoryFit: createMemoryFit({ budget: { totalMemoryBytes: 0, effectiveBudgetBytes: 100 } }),
          availableBudgetBytes: 100,
          lowMemorySignal: false,
        }),
      ).toBe(false);
    });

    it('hard-blocks high-confidence likely OOM decisions', () => {
      expect(
        shouldHardBlockSafeLoad({
          memoryFit: createMemoryFit({ confidence: 'high' }),
          availableBudgetBytes: 500,
          lowMemorySignal: false,
        }),
      ).toBe(true);
    });

    it('hard-blocks likely OOM decisions when low-memory pressure is already active', () => {
      expect(
        shouldHardBlockSafeLoad({
          memoryFit: createMemoryFit(),
          availableBudgetBytes: 500,
          lowMemorySignal: true,
        }),
      ).toBe(true);
    });

    it('falls back to comparing required bytes against the available budget', () => {
      expect(
        shouldHardBlockSafeLoad({
          memoryFit: createMemoryFit({ requiredBytes: 150 }),
          availableBudgetBytes: 100,
          lowMemorySignal: false,
        }),
      ).toBe(true);

      expect(
        shouldHardBlockSafeLoad({
          memoryFit: createMemoryFit({ decision: 'fits_low_confidence' }),
          availableBudgetBytes: 100,
          lowMemorySignal: false,
        }),
      ).toBe(false);

      expect(
        shouldHardBlockSafeLoad({
          memoryFit: createMemoryFit(),
          availableBudgetBytes: null,
          lowMemorySignal: false,
        }),
      ).toBe(false);
    });
  });

  describe('canAutoUseSafeLoadProfile', () => {
    it('requires a valid memory fit and budget', () => {
      expect(canAutoUseSafeLoadProfile({ memoryFit: null, availableBudgetBytes: 100, lowMemorySignal: false })).toBe(false);
      expect(
        canAutoUseSafeLoadProfile({
          memoryFit: createMemoryFit({ requiredBytes: 0 }),
          availableBudgetBytes: 100,
          lowMemorySignal: false,
        }),
      ).toBe(false);
      expect(
        canAutoUseSafeLoadProfile({
          memoryFit: createMemoryFit(),
          availableBudgetBytes: null,
          lowMemorySignal: false,
        }),
      ).toBe(false);
    });

    it('disables auto safe-load when the device is already under memory pressure', () => {
      expect(
        canAutoUseSafeLoadProfile({
          memoryFit: createMemoryFit({ requiredBytes: 80 }),
          availableBudgetBytes: 100,
          lowMemorySignal: true,
        }),
      ).toBe(false);
    });

    it('allows auto safe-load only when the required bytes fit inside the available budget', () => {
      expect(
        canAutoUseSafeLoadProfile({
          memoryFit: createMemoryFit({ requiredBytes: 80 }),
          availableBudgetBytes: 100,
          lowMemorySignal: false,
        }),
      ).toBe(true);

      expect(
        canAutoUseSafeLoadProfile({
          memoryFit: createMemoryFit({ requiredBytes: 101 }),
          availableBudgetBytes: 100,
          lowMemorySignal: false,
        }),
      ).toBe(false);
    });
  });

  it('reads trimmed model info strings and ignores unsupported values', () => {
    expect(getModelInfoString({ architecture: '  llama.cpp  ' }, 'architecture')).toBe('llama.cpp');
    expect(getModelInfoString({ architecture: 7 }, 'architecture')).toBeNull();
    expect(getModelInfoString(null, 'architecture')).toBeNull();
  });

  it('reads the first valid positive numeric metadata value across multiple keys', () => {
    expect(
      readNumericMetadata(
        {
          missing: '',
          first: ' 512 ',
          second: 1024,
        },
        ['missing', 'first', 'second'],
      ),
    ).toBe(512);
  });

  it('ignores invalid numeric metadata candidates', () => {
    expect(readNumericMetadata(undefined, ['context'])).toBeNull();
    expect(
      readNumericMetadata(
        {
          zero: 0,
          negative: '-2',
          nan: 'not-a-number',
        },
        ['zero', 'negative', 'nan'],
      ),
    ).toBeNull();
  });

  it('compares thinking capability snapshots by capability fields only', () => {
    const base = createThinkingSnapshot();

    expect(areThinkingCapabilitySnapshotsEqual(undefined, base)).toBe(false);
    expect(
      areThinkingCapabilitySnapshotsEqual(
        createThinkingSnapshot({ detectedAt: 1 }),
        createThinkingSnapshot({ detectedAt: 2 }),
      ),
    ).toBe(true);
    expect(
      areThinkingCapabilitySnapshotsEqual(
        createThinkingSnapshot({ thinkingEndTag: '</reasoning>' }),
        base,
      ),
    ).toBe(false);
  });
});
