import React from 'react';
import { render } from '@testing-library/react-native';

jest.mock('../../../src/components/ui/box', () => {
  const mockReact = require('react');
  const { View } = require('react-native');
  return {
    Box: ({ children, ...props }: any) => mockReact.createElement(View, props, children),
  };
});

const { ProgressBar } = require('../../../src/components/ui/ProgressBar');

describe('ProgressBar', () => {
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
