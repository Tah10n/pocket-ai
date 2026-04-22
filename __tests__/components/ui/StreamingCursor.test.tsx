import React from 'react';
import { render } from '@testing-library/react-native';

const mockWithTiming = jest.fn((value, _config) => value);
const mockWithRepeat = jest.fn((animation, count, reverse) => ({ animation, count, reverse }));

jest.mock('../../../src/components/ui/text', () => {
  const mockReact = require('react');
  const { Text } = require('react-native');
  return {
    Text: ({ children, ...props }: any) => mockReact.createElement(Text, props, children),
  };
});

jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: {
    createAnimatedComponent: (Component: any) => Component,
  },
  useSharedValue: (value: unknown) => ({ value }),
  useAnimatedStyle: (updater: () => unknown) => updater(),
  withRepeat: (animation: unknown, count: number, reverse: boolean) => mockWithRepeat(animation, count, reverse),
  withTiming: (value: unknown, config: unknown) => mockWithTiming(value, config),
  Easing: {
    inOut: (value: unknown) => value,
    ease: 'ease',
  },
}));

import { StreamingCursor } from '../../../src/components/ui/StreamingCursor';

describe('StreamingCursor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders the default cursor style and starts the blink animation', () => {
    const screen = render(<StreamingCursor />);

    expect(screen.getByText('▏').props.className).toBe('text-sm leading-6 text-typography-500 opacity-70 dark:text-typography-400');
    expect(mockWithTiming).toHaveBeenCalledWith(0, expect.objectContaining({ duration: 500 }));
    expect(mockWithRepeat).toHaveBeenCalledWith(mockWithTiming.mock.results[0]?.value, -1, true);
  });

  it('renders the compact cursor style when requested', () => {
    const screen = render(<StreamingCursor compact />);

    expect(screen.getByText('▏').props.className).toBe('text-xs leading-4 text-typography-400 opacity-60 dark:text-typography-500');
  });
});
