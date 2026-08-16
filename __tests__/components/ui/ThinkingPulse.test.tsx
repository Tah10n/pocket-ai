import React from 'react';
import { render, waitFor } from '@testing-library/react-native';
import { resolveTheme } from '../../../src/design-system/themes/resolver';

const mockUseMotionPreferences = jest.fn();
const mockWithTiming = jest.fn((toValue, config) => ({ toValue, config }));
const mockWithRepeat = jest.fn((animation, count, reverse) => ({ animation, count, reverse }));
let mockThemeContext = resolveTheme('default', 'light');

jest.mock('../../../src/hooks/useDeviceMetrics', () => ({
  useMotionPreferences: () => mockUseMotionPreferences(),
}));

jest.mock('../../../src/providers/ThemeProvider', () => ({
  useTheme: () => mockThemeContext,
}));

jest.mock('react-native-reanimated', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');

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

const { ThinkingPulse } = jest.requireActual<typeof import('../../../src/components/ui/ThinkingPulse')>(
  '../../../src/components/ui/ThinkingPulse',
);

describe('ThinkingPulse', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockThemeContext = resolveTheme('default', 'light');
  });

  it.each([
    ['default', 'light'],
    ['default', 'dark'],
    ['glass', 'light'],
    ['glass', 'dark'],
  ] as const)('uses the %s %s theme-owned dense halo paint', (themeId, mode) => {
    mockUseMotionPreferences.mockReturnValue({ motionPreset: 'minimal' });
    mockThemeContext = resolveTheme(themeId, mode);

    const { getByTestId } = render(<ThinkingPulse />);

    expect(getByTestId('thinking-pulse-halo').props.style).toEqual({
      backgroundColor: mockThemeContext.colors.thinkingPulseHalo,
    });
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

  it('keeps the pulse static when deterministic QA motion is required', () => {
    mockUseMotionPreferences.mockReturnValue({ motionPreset: 'full' });

    const screen = render(<ThinkingPulse reduceMotion />);

    expect(screen.toJSON()).toBeTruthy();
    expect(mockWithTiming).not.toHaveBeenCalled();
    expect(mockWithRepeat).not.toHaveBeenCalled();
  });
});
