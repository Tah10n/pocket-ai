import React from 'react';
import { render } from '@testing-library/react-native';

let mockThemeContext: any;

jest.mock('../../../src/components/ui/box', () => {
  const mockReact = require('react');
  const { View } = require('react-native');
  return {
    Box: ({ children, ...props }: any) => mockReact.createElement(View, props, children),
  };
});

jest.mock('../../../src/providers/ThemeProvider', () => ({
  useTheme: () => mockThemeContext,
}));

jest.mock('expo-blur', () => {
  const mockReact = require('react');
  const { View } = require('react-native');
  return {
    BlurTargetView: ({ children, ...props }: any) => mockReact.createElement(View, props, children),
    BlurView: ({ children, ...props }: any) => mockReact.createElement(View, props, children),
  };
});

jest.mock('expo-linear-gradient', () => {
  const mockReact = require('react');
  const { View } = require('react-native');
  return {
    LinearGradient: ({ children, ...props }: any) => mockReact.createElement(View, props, children),
  };
});

const { ProgressBar } = require('../../../src/components/ui/ProgressBar');

describe('ProgressBar', () => {
  beforeEach(() => {
    const { DEFAULT_THEME_ID, getThemeAppearance, getThemeColors } = require('../../../src/utils/themeTokens');
    mockThemeContext = {
      appearance: getThemeAppearance(DEFAULT_THEME_ID, 'light'),
      colors: getThemeColors('light'),
      resolvedMode: 'light',
      themeId: DEFAULT_THEME_ID,
    };
  });

  it('uses tokenized track classes and clamps dynamic width', () => {
    const { getByTestId } = render(
      <ProgressBar testID="track" fillTestID="fill" valuePercent={140} size="sm" tone="primary" />,
    );

    expect(getByTestId('track').props.className).toContain('h-1.5');
    expect(getByTestId('track').props.className).toContain('bg-primary-200');
    expect(getByTestId('fill').props.style).toEqual({ width: '100%' });
  });

  it('renders the framed app-style variant with tone-specific fill', () => {
    const { getByTestId } = render(
      <ProgressBar testID="track" fillTestID="fill" valuePercent={42} size="lg" tone="warning" variant="framed" />,
    );

    expect(getByTestId('track').props.className).toContain('border');
    expect(getByTestId('track').props.className).toContain('h-4');
    expect(getByTestId('track').props.className).toContain('border-warning-500/30');
    expect(getByTestId('fill').props.className).toContain('bg-warning-500');
    expect(getByTestId('fill').props.style).toEqual({ width: '42%' });
  });

  it('uses an explicit fill class instead of stacking tone fill colors', () => {
    const { getByTestId } = render(
      <ProgressBar
        testID="track"
        fillTestID="fill"
        valuePercent={42}
        tone="warning"
        variant="framed"
        fillClassName="bg-primary-500"
      />,
    );

    expect(getByTestId('fill').props.className).toContain('bg-primary-500');
    expect(getByTestId('fill').props.className).not.toContain('bg-warning-500');
  });

  it('keeps framed fills a single flat color without a tinted tip overlay', () => {
    const { getByTestId } = render(
      <ProgressBar testID="track" fillTestID="fill" valuePercent={42} tone="primary" variant="framed" />,
    );

    expect(getByTestId('fill').props.className).toContain('bg-primary-500');
    expect(getByTestId('fill').props.children).toBeUndefined();
  });

  it('centers framed glass fills and blurs the full framed track', () => {
    const { View } = require('react-native');
    const { getThemeAppearance, getThemeColors } = require('../../../src/utils/themeTokens');
    const appearance = getThemeAppearance('glass', 'light');
    mockThemeContext = {
      appearance,
      colors: getThemeColors('light', 'glass'),
      resolvedMode: 'light',
      themeId: 'glass',
    };

    const { UNSAFE_getAllByType, getByTestId } = render(
      <ProgressBar testID="track" fillTestID="fill" valuePercent={42} size="lg" tone="primary" variant="framed" />,
    );

    expect(getByTestId('track').props.className).toContain('justify-center');
    expect(getByTestId('fill').props.className).toContain('h-3');
    expect(getByTestId('fill').props.className).toContain('bg-primary-500');
    expect(UNSAFE_getAllByType(View).some((node: any) => (
      node.props.intensity === appearance.effects.surfaceBlurIntensity
    ))).toBe(true);
  });

  it('clamps lower and non-finite values to zero', () => {
    const negative = render(
      <ProgressBar testID="negative-track" fillTestID="negative-fill" valuePercent={-24} />,
    );
    expect(negative.getByTestId('negative-fill').props.style).toEqual({ width: '0%' });
    expect(negative.getByTestId('negative-track').props.accessibilityValue.now).toBe(0);

    const nonFinite = render(
      <ProgressBar testID="non-finite-track" fillTestID="non-finite-fill" valuePercent={Number.POSITIVE_INFINITY} />,
    );
    expect(nonFinite.getByTestId('non-finite-fill').props.style).toEqual({ width: '0%' });
    expect(nonFinite.getByTestId('non-finite-track').props.accessibilityValue.now).toBe(0);
  });
});
