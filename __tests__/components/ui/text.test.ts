jest.mock('nativewind', () => ({
  cssInterop: (component: unknown) => component,
}));

jest.mock('react-native-css-interop', () => {
  const mockReact = require('react');
  return {
    createInteropElement: mockReact.createElement,
  };
});

const mockUseTheme = jest.fn();

jest.mock('../../../src/providers/ThemeProvider', () => ({
  useTheme: () => mockUseTheme(),
}));

import React from 'react';
import { StyleSheet } from 'react-native';
import { render } from '@testing-library/react-native';
import { Text, composeTextRole, textRoleClassNames } from '../../../src/components/ui/text';

beforeEach(() => {
  mockUseTheme.mockReturnValue({
    resolvedMode: 'light',
    appearance: { surfaceKind: 'solid' },
  });
});

describe('textRoleClassNames', () => {
  it('keeps eyebrow labels compact for badge-sized text', () => {
    expect(textRoleClassNames.eyebrow).toContain('tracking-wide');
    expect(textRoleClassNames.eyebrow).not.toContain('tracking-[0.18em]');
    expect(composeTextRole('eyebrow')).toContain('uppercase');
  });

  it('keeps dark caption and eyebrow labels visually secondary to body text', () => {
    expect(textRoleClassNames.bodyMuted).toContain('dark:text-typography-300');
    expect(textRoleClassNames.caption).toContain('dark:text-typography-400');
    expect(textRoleClassNames.eyebrow).toContain('dark:text-typography-400');
  });
});

describe('Text dark glass readability', () => {
  it('lifts muted typography colors only for the dark glass theme', () => {
    mockUseTheme.mockReturnValue({
      resolvedMode: 'dark',
      appearance: { surfaceKind: 'glass' },
    });

    const { getByText } = render(
      React.createElement(
        Text,
        { className: 'text-typography-500 dark:text-typography-400' },
        'Muted copy',
      ),
    );

    expect(StyleSheet.flatten(getByText('Muted copy').props.style)).toMatchObject({
      color: '#c9d5e7',
    });
    expect(getByText('Muted copy').props.className).not.toContain('text-typography-500');
    expect(getByText('Muted copy').props.className).not.toContain('dark:text-typography-200');
  });

  it('keeps explicit runtime text colors above the dark glass readability lift', () => {
    mockUseTheme.mockReturnValue({
      resolvedMode: 'dark',
      appearance: { surfaceKind: 'glass' },
    });

    const { getByText } = render(
      React.createElement(
        Text,
        { className: 'dark:text-typography-400', style: { color: '#ff00aa' } },
        'Explicit',
      ),
    );

    expect(StyleSheet.flatten(getByText('Explicit').props.style)).toMatchObject({
      color: '#ff00aa',
    });
  });

  it('resolves glass action text colors from the current theme mode', () => {
    mockUseTheme.mockReturnValue({
      resolvedMode: 'dark',
      appearance: { surfaceKind: 'glass' },
    });

    const renderAction = () => React.createElement(
      Text,
      { className: 'text-primary-700 dark:text-primary-100' },
      'Mode action',
    );
    const { getByText, rerender } = render(renderAction());

    expect(StyleSheet.flatten(getByText('Mode action').props.style)).toMatchObject({
      color: '#d9ebff',
    });

    mockUseTheme.mockReturnValue({
      resolvedMode: 'light',
      appearance: { surfaceKind: 'glass' },
    });
    rerender(renderAction());

    expect(StyleSheet.flatten(getByText('Mode action').props.style)).toMatchObject({
      color: '#164fb0',
    });
  });

  it('updates glass text color when a reused label switches from active to inactive', () => {
    mockUseTheme.mockReturnValue({
      resolvedMode: 'light',
      appearance: { surfaceKind: 'glass' },
    });

    const { getByText, rerender } = render(
      React.createElement(
        Text,
        { className: 'text-center text-primary-700 dark:text-primary-100' },
        'Reusable label',
      ),
    );

    expect(StyleSheet.flatten(getByText('Reusable label').props.style)).toMatchObject({
      color: '#164fb0',
    });
    expect(getByText('Reusable label').props.className).toBe('text-center');

    rerender(
      React.createElement(
        Text,
        { className: 'text-center text-typography-600 dark:text-typography-300' },
        'Reusable label',
      ),
    );

    expect(StyleSheet.flatten(getByText('Reusable label').props.style)).toMatchObject({
      color: '#46546a',
    });
    expect(getByText('Reusable label').props.className).toBe('text-center');
  });
});
