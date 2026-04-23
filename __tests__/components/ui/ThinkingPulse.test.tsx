import React from 'react';
import { render, waitFor } from '@testing-library/react-native';

const mockUseMotionPreferences = jest.fn();
const mockWithTiming = jest.fn((toValue, config) => ({ toValue, config }));
const mockWithRepeat = jest.fn((animation, count, reverse) => ({ animation, count, reverse }));

jest.mock('../../../src/hooks/useDeviceMetrics', () => ({
  useMotionPreferences: () => mockUseMotionPreferences(),
}));

jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');

  return {
    __esModule: true,
    default: {
      createAnimatedComponent: () => View,
    },
    Easing: {
      ease: 'ease',
      inOut: jest.fn((value) => value),
    },
    Extrapolation: {
      CLAMP: 'clamp',
    },
    interpolate: jest.fn((value, input, output) => output[Math.min(output.length - 1, 0)]),
    useAnimatedStyle: jest.fn((factory) => factory()),
    useSharedValue: jest.fn((initial) => ({ value: initial })),
    withRepeat: mockWithRepeat,
    withTiming: mockWithTiming,
  };
});

const { ThinkingPulse } = require('../../../src/components/ui/ThinkingPulse');

describe('ThinkingPulse', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does not start the animated loop when motion is minimal', () => {
    mockUseMotionPreferences.mockReturnValue({ motionPreset: 'minimal' });

    const screen = render(<ThinkingPulse />);

    expect(screen.toJSON()).toBeTruthy();
    expect(mockWithTiming).not.toHaveBeenCalled();
    expect(mockWithRepeat).not.toHaveBeenCalled();
  });

  it('uses the full animation timing when full motion is allowed', async () => {
    mockUseMotionPreferences.mockReturnValue({ motionPreset: 'full' });

    render(<ThinkingPulse />);

    await waitFor(() => {
      expect(mockWithTiming).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ duration: 1200 }),
      );
    });

    expect(mockWithRepeat).toHaveBeenCalledWith(mockWithTiming.mock.results[0]?.value, -1, false);
  });

  it('uses the reduced animation timing for non-full animated motion presets', async () => {
    mockUseMotionPreferences.mockReturnValue({ motionPreset: 'reduced' });

    render(<ThinkingPulse />);

    await waitFor(() => {
      expect(mockWithTiming).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ duration: 900 }),
      );
    });

    expect(mockWithRepeat).toHaveBeenCalledWith(mockWithTiming.mock.results[0]?.value, -1, false);
  });
});
