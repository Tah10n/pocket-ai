import React from 'react';
import { render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { Button, ButtonText } from '../../../src/components/ui/button';
import { resolveTheme } from '../../../src/design-system/themes/resolver';
import { semanticColorTokens } from '../../../src/design-system/themes/legacyTheme';
import { resolveThemeForeground } from '../../../src/design-system/themes/foreground';

let mockResolvedTheme = resolveTheme('default', 'light');

jest.mock('nativewind', () => ({
  cssInterop: (component: unknown) => component,
}));

jest.mock('@/components/ui/box', () => {
  const mockReact = jest.requireActual<typeof import('react')>('react');
  const { View: MockView } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    Box: ({ children, ...props }: any) => mockReact.createElement(MockView, props, children),
  };
});

jest.mock('@/components/ui/pressable', () => {
  const mockReact = jest.requireActual<typeof import('react')>('react');
  const { Pressable: MockPressable } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    Pressable: ({ children, ...props }: any) => mockReact.createElement(MockPressable, props, children),
  };
});

jest.mock('../../../src/providers/ThemeProvider', () => ({
  useTheme: () => ({
    colors: mockResolvedTheme.colors,
    resolvedMode: mockResolvedTheme.mode,
    resolvedTheme: mockResolvedTheme,
  }),
}));

function relativeLuminance(hex: string) {
  const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
  const [red, green, blue] = channels.map((channel) => (
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(first: string, second: string) {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  return (Math.max(firstLuminance, secondLuminance) + 0.05)
    / (Math.min(firstLuminance, secondLuminance) + 0.05);
}

function compositePaint(paint: string, background: string) {
  if (paint.startsWith('#')) return paint;
  const match = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(paint);
  if (!match) throw new Error(`Unsupported paint: ${paint}`);
  const backgroundChannels = [1, 3, 5].map((index) => Number.parseInt(background.slice(index, index + 2), 16));
  const alpha = Number(match[4]);
  const channels = match.slice(1, 4).map((channel, index) => (
    Math.round(Number(channel) * alpha + backgroundChannels[index] * (1 - alpha))
  ));
  return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

const actionCases = [
  ['primary', semanticColorTokens.primary[600]],
  ['positive', semanticColorTokens.success[700]],
  ['negative', semanticColorTokens.error[600]],
] as const;

describe('Button semantic action contrast', () => {
  it.each(['light', 'dark'] as const)('keeps selected actions AA-readable in %s mode', (mode) => {
    mockResolvedTheme = resolveTheme('default', mode);

    for (const [action, expectedFill] of actionCases) {
      const screen = render(
        <Button testID={`${action}-button`} action={action}>
          <ButtonText>{action}</ButtonText>
        </Button>,
      );
      const fill = StyleSheet.flatten(screen.getByTestId(`${action}-button`).props.style).backgroundColor;
      const foreground = StyleSheet.flatten(screen.getByText(action).props.style).color;

      expect(fill).toBe(expectedFill);
      expect(foreground).toBe(semanticColorTokens.typography[0]);
      expect(contrastRatio(fill, foreground)).toBeGreaterThanOrEqual(4.5);
      screen.unmount();
    }
  });

  it.each(['light', 'dark'] as const)('keeps default user-message foreground AA-readable in %s mode', (mode) => {
    const theme = resolveTheme('default', mode);
    const messageRecipe = theme.materials.content.message.primary?.preferredByPlatform.web;

    expect(messageRecipe).toBeDefined();
    expect(contrastRatio(messageRecipe!.fill.color, theme.colors.textOnPrimary)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(['light', 'dark'] as const)('keeps inline danger copy AA-readable in %s mode', (mode) => {
    const theme = resolveTheme('default', mode);
    const errorFrame = theme.materials.content.messageError.neutral.accessibilityFallback.fill.color;

    expect(errorFrame).toBeDefined();
    expect(contrastRatio(
      theme.colors.textDanger,
      compositePaint(errorFrame!, theme.colors.background),
    )).toBeGreaterThanOrEqual(4.5);
  });

  it.each(['light', 'dark'] as const)('keeps semantic tone copy AA-readable in %s mode', (mode) => {
    const theme = resolveTheme('default', mode);
    const cases = [
      ['neutral', 'toneNeutral'],
      ['accent', 'toneAccent'],
      ['info', 'info'],
      ['success', 'success'],
      ['warning', 'warning'],
      ['error', 'danger'],
    ] as const;

    for (const [tone, colorRole] of cases) {
      const fill = theme.materials.control.inline[tone]?.accessibilityFallback.fill.color;
      expect(fill).toBeDefined();
      expect(contrastRatio(
        resolveThemeForeground(theme.colors, colorRole),
        compositePaint(fill!, theme.colors.background),
      )).toBeGreaterThanOrEqual(4.5);
    }
  });
});
