import React from 'react';
import { render } from '@testing-library/react-native';
import { View } from 'react-native';
import { resolveTheme } from '../../../src/design-system/themes/resolver';
import { ProgressBar } from '../../../src/components/ui/ProgressBar';

let mockThemeContext: any;

jest.mock('../../../src/components/ui/box', () => {
  const mockReact = jest.requireActual<typeof import('react')>('react');
  const { View: MockView } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    Box: ({ children, ...props }: any) => mockReact.createElement(MockView, props, children),
  };
});

jest.mock('../../../src/providers/ThemeProvider', () => ({
  useTheme: () => mockThemeContext,
}));

jest.mock('expo-blur', () => {
  const mockReact = jest.requireActual<typeof import('react')>('react');
  const { View: MockView } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    BlurTargetView: ({ children, ...props }: any) => mockReact.createElement(MockView, props, children),
    BlurView: ({ children, ...props }: any) => mockReact.createElement(MockView, props, children),
  };
});

jest.mock('expo-linear-gradient', () => {
  const mockReact = jest.requireActual<typeof import('react')>('react');
  const { View: MockView } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    LinearGradient: ({ children, ...props }: any) => mockReact.createElement(MockView, props, children),
  };
});

describe('ProgressBar', () => {
  beforeEach(() => {
    const resolvedTheme = resolveTheme('default', 'light');
    mockThemeContext = {
      colors: resolvedTheme.colors,
      resolvedMode: 'light',
      resolvedTheme,
      themeId: 'default',
    };
  });

  it('uses theme-owned progress paints and clamps dynamic width', () => {
    const { getByTestId } = render(
      <ProgressBar testID="track" fillTestID="fill" valuePercent={140} size="sm" tone="primary" />,
    );

    expect(getByTestId('track').props.className).toContain('h-1.5');
    expect(getByTestId('track').props.style).toEqual({
      backgroundColor: mockThemeContext.colors.progressTrackByTone.primary,
    });
    expect(getByTestId('fill').props.style).toEqual({
      width: '100%',
      backgroundColor: mockThemeContext.colors.progressFillByTone.primary,
    });
  });

  it('renders the framed app-style variant with tone-specific fill', () => {
    const { getByTestId } = render(
      <ProgressBar testID="track" fillTestID="fill" valuePercent={42} size="lg" tone="warning" variant="framed" />,
    );

    expect(getByTestId('track').props.className).toContain('h-4');
    expect(getByTestId('track').props.className).not.toContain('border-warning');
    expect(getByTestId('fill').props.style).toEqual({
      width: '42%',
      backgroundColor: mockThemeContext.colors.progressFillByTone.warning,
    });
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
    expect(getByTestId('fill').props.style).toEqual({ width: '42%' });
  });

  it('keeps framed fills a single flat color without a tinted tip overlay', () => {
    const { getByTestId } = render(
      <ProgressBar testID="track" fillTestID="fill" valuePercent={42} tone="primary" variant="framed" />,
    );

    expect(getByTestId('fill').props.style).toEqual({
      width: '42%',
      backgroundColor: mockThemeContext.colors.progressFillByTone.primary,
    });
    expect(getByTestId('fill').props.children).toBeUndefined();
  });

  it('keeps framed glass progress dense without mounting live blur', () => {
    const resolvedTheme = resolveTheme('glass', 'light');
    mockThemeContext = {
      colors: resolvedTheme.colors,
      resolvedMode: 'light',
      resolvedTheme,
      themeId: 'glass',
    };

    const { UNSAFE_getAllByType, getByTestId } = render(
      <ProgressBar testID="track" fillTestID="fill" valuePercent={42} size="lg" tone="primary" variant="framed" />,
    );

    expect(getByTestId('track').props.className).toContain('justify-center');
    expect(getByTestId('fill').props.className).toContain('h-3');
    expect(getByTestId('fill').props.style).toEqual({
      width: '42%',
      backgroundColor: mockThemeContext.colors.progressFillByTone.primary,
    });
    expect(UNSAFE_getAllByType(View).some((node: any) => node.props.blurMethod)).toBe(false);
  });

  it('clamps lower and non-finite values to zero', () => {
    const negative = render(
      <ProgressBar testID="negative-track" fillTestID="negative-fill" valuePercent={-24} />,
    );
    expect(negative.getByTestId('negative-fill').props.style).toMatchObject({ width: '0%' });
    expect(negative.getByTestId('negative-track').props.accessibilityValue.now).toBe(0);

    const nonFinite = render(
      <ProgressBar testID="non-finite-track" fillTestID="non-finite-fill" valuePercent={Number.POSITIVE_INFINITY} />,
    );
    expect(nonFinite.getByTestId('non-finite-fill').props.style).toMatchObject({ width: '0%' });
    expect(nonFinite.getByTestId('non-finite-track').props.accessibilityValue.now).toBe(0);
  });
});
