import { Alert } from 'react-native';

import { handleModelLoadMemoryPolicyError, promptModelLoadMemoryPolicyIfNeeded } from '@/utils/modelLoadMemoryPolicyPrompt';

const mockIsHighConfidenceLikelyOom = jest.fn();
const mockShouldWarnForModelMemoryLoad = jest.fn();

jest.mock('@/utils/modelMemoryFitState', () => ({
  isHighConfidenceLikelyOomMemoryFit: (model: any) => mockIsHighConfidenceLikelyOom(model),
  shouldWarnForModelMemoryLoad: (model: any) => mockShouldWarnForModelMemoryLoad(model),
}));

describe('modelLoadMemoryPolicyPrompt', () => {
  const t = (key: string) => key;
  let alertSpy: jest.SpiedFunction<typeof Alert.alert>;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  });

  afterEach(() => {
    alertSpy.mockRestore();
    jest.useRealTimers();
  });

  it('does nothing when unsafe option is already enabled', () => {
    const onProceed = jest.fn();
    mockIsHighConfidenceLikelyOom.mockReturnValue(true);

    expect(promptModelLoadMemoryPolicyIfNeeded({
      t: t as any,
      model: { memoryFitDecision: 'likely_oom', memoryFitConfidence: 'high', fitsInRam: false },
      options: { allowUnsafeMemoryLoad: true } as any,
      onProceed,
    })).toBe(false);

    expect(Alert.alert).not.toHaveBeenCalled();
    expect(onProceed).not.toHaveBeenCalled();
  });

  it('prompts and proceeds for high-confidence OOM models', () => {
    const onProceed = jest.fn();
    mockIsHighConfidenceLikelyOom.mockReturnValue(true);
    mockShouldWarnForModelMemoryLoad.mockReturnValue(false);

    expect(promptModelLoadMemoryPolicyIfNeeded({
      t: t as any,
      model: { memoryFitDecision: 'likely_oom', memoryFitConfidence: 'high', fitsInRam: false },
      options: { threads: 4 } as any,
      onProceed,
    })).toBe(true);

    const buttons = alertSpy.mock.calls[0]?.[2] as Array<{ onPress?: () => void }>;
    buttons[1]?.onPress?.();
    expect(onProceed).toHaveBeenCalledWith(expect.objectContaining({ allowUnsafeMemoryLoad: true }));
  });

  it('prompts and proceeds for warning models', () => {
    const onProceed = jest.fn();
    mockIsHighConfidenceLikelyOom.mockReturnValue(false);
    mockShouldWarnForModelMemoryLoad.mockReturnValue(true);

    expect(promptModelLoadMemoryPolicyIfNeeded({
      t: t as any,
      model: { memoryFitDecision: 'borderline', memoryFitConfidence: 'medium', fitsInRam: true },
      options: undefined,
      onProceed,
    })).toBe(true);

    const buttons = alertSpy.mock.calls[0]?.[2] as Array<{ onPress?: () => void }>;
    buttons[1]?.onPress?.();
    expect(onProceed).toHaveBeenCalledWith({ allowUnsafeMemoryLoad: true });
  });

  it('handles model_load_blocked with onBlocked and retry when not already unsafe', () => {
    const onRetry = jest.fn();
    const onBlocked = jest.fn();

    expect(handleModelLoadMemoryPolicyError({
      t: t as any,
      appError: { code: 'model_load_blocked' } as any,
      options: { threads: 2 } as any,
      onRetry,
      onBlocked,
    })).toBe(true);

    expect(onBlocked).toHaveBeenCalled();

    const buttons = alertSpy.mock.calls[0]?.[2] as Array<{ onPress?: () => void }>;
    buttons[1]?.onPress?.();
    jest.runOnlyPendingTimers();

    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ allowUnsafeMemoryLoad: true }));
  });

  it('handles model_load_blocked without retry options when already unsafe', () => {
    const onRetry = jest.fn();
    const onBlocked = jest.fn();

    expect(handleModelLoadMemoryPolicyError({
      t: t as any,
      appError: { code: 'model_load_blocked' } as any,
      options: { allowUnsafeMemoryLoad: true } as any,
      onRetry,
      onBlocked,
    })).toBe(true);

    const buttons = alertSpy.mock.calls[0]?.[2] as Array<{ onPress?: () => void }>;
    expect(buttons).toHaveLength(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('handles model_memory_warning by retrying with unsafe option', () => {
    const onRetry = jest.fn();

    expect(handleModelLoadMemoryPolicyError({
      t: t as any,
      appError: { code: 'model_memory_warning' } as any,
      options: undefined,
      onRetry,
    })).toBe(true);

    const buttons = alertSpy.mock.calls[0]?.[2] as Array<{ onPress?: () => void }>;
    buttons[1]?.onPress?.();
    jest.runOnlyPendingTimers();

    expect(onRetry).toHaveBeenCalledWith({ allowUnsafeMemoryLoad: true });
  });

  it('returns false for unrelated errors', () => {
    expect(handleModelLoadMemoryPolicyError({
      t: t as any,
      appError: { code: 'other' } as any,
      onRetry: jest.fn(),
    })).toBe(false);
  });
});
