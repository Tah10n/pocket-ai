import React from 'react';
import { StyleSheet } from 'react-native';
import { render } from '@testing-library/react-native';
import { Text, composeTextRole, textRoleClassNames } from '../../../src/components/ui/text';
import { resolveTheme } from '../../../src/design-system/themes/resolver';

jest.mock('nativewind', () => ({
  cssInterop: (component: unknown) => component,
}));

jest.mock('react-native-css-interop', () => {
  const mockReact = jest.requireActual<typeof import('react')>('react');
  return {
    createInteropElement: mockReact.createElement,
  };
});

const mockUseTheme = jest.fn();

jest.mock('../../../src/providers/ThemeProvider', () => ({
  useTheme: () => mockUseTheme(),
}));

beforeEach(() => {
  const resolvedTheme = resolveTheme('default', 'light');
  mockUseTheme.mockReturnValue({
    colors: resolvedTheme.colors,
    resolvedMode: 'light',
    resolvedTheme,
  });
});

describe('textRoleClassNames', () => {
  it('keeps eyebrow labels compact for badge-sized text', () => {
    expect(textRoleClassNames.eyebrow).toContain('tracking-wide');
    expect(textRoleClassNames.eyebrow).not.toContain('tracking-[0.18em]');
    expect(composeTextRole('eyebrow')).toContain('uppercase');
  });

  it('keeps typography roles free of palette-specific foreground classes', () => {
    expect(Object.values(textRoleClassNames).join(' ')).not.toMatch(/text-typography-/);
  });
});

describe('Text semantic foregrounds', () => {
  it.each(['default', 'glass'] as const)('resolves muted text roles from the %s theme', (themeId) => {
    const resolvedTheme = resolveTheme(themeId, 'dark');
    mockUseTheme.mockReturnValue({
      colors: resolvedTheme.colors,
      resolvedMode: 'dark',
      resolvedTheme,
    });

    const { getByText } = render(React.createElement(
      Text,
      { textRole: 'caption', className: 'text-center' },
      'Muted semantic copy',
    ));

    expect(StyleSheet.flatten(getByText('Muted semantic copy').props.style)).toMatchObject({
      color: resolvedTheme.colors.textTertiary,
    });
    expect(getByText('Muted semantic copy').props.className).toContain('text-xs');
    expect(getByText('Muted semantic copy').props.className).toContain('text-center');
  });

  it('resolves foreground roles from the current theme without rewriting layout classes', () => {
    const resolvedTheme = resolveTheme('glass', 'dark');
    mockUseTheme.mockReturnValue({ colors: resolvedTheme.colors, resolvedTheme });

    const { getByText } = render(React.createElement(
      Text,
      { className: 'text-center', colorRole: 'onAccent' },
      'Semantic label',
    ));

    expect(StyleSheet.flatten(getByText('Semantic label').props.style)).toMatchObject({
      color: resolvedTheme.colors.textOnPrimary,
    });
    expect(getByText('Semantic label').props.className).toBe('text-center');
  });

  it('keeps explicit runtime styles above semantic foreground defaults', () => {
    const { getByText } = render(React.createElement(
      Text,
      { colorRole: 'onAccent', style: { color: '#ff00aa' } },
      'Explicit',
    ));

    expect(StyleSheet.flatten(getByText('Explicit').props.style)).toMatchObject({
      color: '#ff00aa',
    });
  });

  it('updates the semantic color when the resolved theme changes', () => {
    const lightTheme = resolveTheme('default', 'light');
    const darkTheme = resolveTheme('glass', 'dark');
    mockUseTheme.mockReturnValue({ colors: lightTheme.colors, resolvedTheme: lightTheme });
    const renderLabel = () => React.createElement(
      Text,
      { colorRole: 'softAction' },
      'Reusable label',
    );
    const { getByText, rerender } = render(renderLabel());

    expect(StyleSheet.flatten(getByText('Reusable label').props.style)).toMatchObject({
      color: lightTheme.colors.textOnSoftAction,
    });

    mockUseTheme.mockReturnValue({ colors: darkTheme.colors, resolvedTheme: darkTheme });
    rerender(renderLabel());
    expect(StyleSheet.flatten(getByText('Reusable label').props.style)).toMatchObject({
      color: darkTheme.colors.textOnSoftAction,
    });
  });
});
